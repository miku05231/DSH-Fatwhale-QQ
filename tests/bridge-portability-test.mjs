// Opt-in integration probe: real NapCat APIs, then synthetic QQ messages with real DSH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OneBot } from '../src/onebot.js';
import { killProcessTree } from '../src/dsh.js';
import { redactSecrets } from '../src/redact.js';
import { createFakeNapCat } from './ws-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REQUIRED = [
  'DSH_VERIFY_COMMAND', 'DSH_VERIFY_CREDENTIALS_FILE',
  'QQ_VERIFY_ONEBOT_URL', 'QQ_VERIFY_ONEBOT_TOKEN',
  'QQ_VERIFY_SHARED_ROOT', 'QQ_VERIFY_NAPCAT_ROOT',
];
const REAL_ACTIONS = new Set(['get_version_info', 'get_status', 'can_send_image', 'download_file']);
const ADMIN = 10001;
const MEMBER = 10002;
const STRANGER = 10003;
const ADMIN_KEY = `p:${ADMIN}:u:${ADMIN}:admin:danger-full-access:v1`;
const MEMBER_KEY = `p:${MEMBER}:u:${MEMBER}:chat:v1`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function napcatFileUrl(filename) {
  assert.ok(path.posix.isAbsolute(filename), 'NapCat root must be an absolute POSIX path');
  return `file://${filename.split('/').map(encodeURIComponent).join('/')}`;
}

function replyText(message) {
  if (typeof message === 'string') return message;
  return Array.isArray(message)
    ? message.filter((item) => item?.type === 'text').map((item) => item.data?.text ?? '').join('')
    : '';
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    assert.equal(napcatFileUrl('/probe space/a#b?c.txt'), 'file:///probe%20space/a%23b%3Fc.txt');
    assert.equal(replyText('plain'), 'plain');
    assert.equal(replyText([{ type: 'text', data: { text: 'a' } }, { type: 'image' },
      { type: 'text', data: { text: 'b' } }]), 'ab');
    console.log('PASS bridge portability helper checks (3)');
    return;
  }
  // Missing configuration must fail before creating files or opening sockets.
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
  const env = Object.fromEntries(REQUIRED.map((name) => [name, process.env[name].trim()]));
  for (const name of ['DSH_VERIFY_COMMAND', 'DSH_VERIFY_CREDENTIALS_FILE', 'QQ_VERIFY_SHARED_ROOT']) {
    assert.ok(path.isAbsolute(env[name]), `${name} must be an absolute path`);
  }
  assert.match(env.DSH_VERIFY_COMMAND, /\.(?:m?js|cjs)$/i, 'DSH_VERIFY_COMMAND must be a real JS entry');
  const endpoint = new URL(env.QQ_VERIFY_ONEBOT_URL);
  assert.ok(['ws:', 'wss:'].includes(endpoint.protocol), 'OneBot endpoint must use WebSocket');
  napcatFileUrl(env.QQ_VERIFY_NAPCAT_ROOT);
  for (const name of ['DSH_VERIFY_COMMAND', 'DSH_VERIFY_CREDENTIALS_FILE']) {
    try { await fs.access(env[name]); } catch {
      throw new Error(`${name} is not accessible`);
    }
  }

  const id = randomUUID();
  const probeName = `bridge-portability-${id}`;
  const sharedRoot = path.resolve(env.QQ_VERIFY_SHARED_ROOT);
  const probeDir = path.join(sharedRoot, probeName);
  const inputName = 'input marker #.txt';
  const inputFile = path.join(probeDir, inputName);
  const outputFile = path.join(probeDir, 'output.txt');
  const resultFile = path.resolve(process.env.QQ_VERIFY_RESULT
    || path.join(ROOT, 'state', `bridge-portability-${id}.json`));
  const inputMarker = `READ_MARKER_${randomBytes(20).toString('hex')}`;
  const inputBytes = Buffer.from(`${inputMarker}\n`);
  const evidence = {
    ok: false, platform: process.platform, node: process.version,
    permissionMode: 'danger-full-access', checks: [], realApiActions: [],
  };
  const children = new Set();
  let tempRoot;
  let probeCreated = false;
  let liveBot;
  let fake;
  let interrupted = false;
  let phase = 'setup';
  const onSignal = () => { interrupted = true; liveBot?.close(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const safeError = (error) => {
    let text = error?.message || String(error);
    for (const value of [...Object.values(env), tempRoot, probeDir, inputMarker].filter(Boolean)) {
      text = text.split(value).join('[redacted]');
    }
    return redactSecrets(text, 500).replace(/\b\d{5,12}\b/g, '[id]');
  };
  const check = (name) => { evidence.checks.push(name); console.log(`PASS ${name}`); };
  async function waitFor(label, predicate, timeoutMs = 20_000, child = null) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (interrupted) throw new Error('Probe interrupted');
      if (child?.spawnError) throw new Error('Bridge failed to spawn');
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Bridge exited while waiting for ${label} (code ${child.exitCode})`);
      }
      const value = await predicate();
      if (value) return value;
      await delay(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function stopBridge(child) {
    if (!child || !children.has(child)) return;
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') killProcessTree(child);
      else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      const until = Date.now() + 6000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(100);
    }
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Bridge process did not stop');
    children.delete(child);
  }

  try {
    await fs.mkdir(probeDir);
    probeCreated = true;
    await fs.writeFile(inputFile, inputBytes);
    await fs.writeFile(path.join(probeDir, 'AGENTS.md'),
      'This is an isolated verification workspace. Only read and write files inside this directory. '
      + 'Do not use network services, messaging tools, or inspect credentials or home directories.\n');
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-portability-'));
    const dshHome = path.join(tempRoot, 'dsh-home');
    await fs.mkdir(dshHome);
    const credentialFile = path.join(dshHome, '.credentials.yaml');
    await fs.copyFile(env.DSH_VERIFY_CREDENTIALS_FILE, credentialFile);
    await fs.chmod(credentialFile, 0o600);
    const isolatedEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/^(?:QQ_VERIFY_|DSH_VERIFY_)/i.test(name)));
    Object.assign(isolatedEnv, {
      DSH_HOME: dshHome, HOME: dshHome, USERPROFILE: dshHome,
      APPDATA: path.join(dshHome, 'appdata'), LOCALAPPDATA: path.join(dshHome, 'localappdata'),
    });

    async function launch(name, url, accessToken, allowFrom, adminUserIds) {
      const directory = path.join(tempRoot, name);
      const stateDir = path.join(directory, 'state');
      const configFile = path.join(directory, 'config.json');
      await fs.mkdir(directory, { recursive: true });
      const config = {
        onebot: { url, accessToken },
        dsh: {
          command: env.DSH_VERIFY_COMMAND, mode: 'headless', companion: false, profile: 'headless',
          patchPath: '', cwd: probeDir, timeoutMs: 180_000, permissionMode: 'danger-full-access',
        },
        security: { allowFrom, adminUserIds, allowGroups: false, allowGroupMembers: false,
          rateLimitPerMinute: 60, maxChars: 6000 },
        behavior: { queuedNotice: 'TEST_QUEUED', showErrors: true, maxReplyChunk: 1200 },
        memory: { enabled: false, reflectDaily: false, capture: false },
        persona: { enabled: false }, stickers: { enabled: false }, plugins: { enabled: false },
        stateDir, logDir: path.join(directory, 'logs'),
      };
      await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--config', configFile], {
        cwd: ROOT, env: { ...isolatedEnv, QQ_ONEBOT_URL: url, QQ_ONEBOT_TOKEN: accessToken },
        stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
      });
      child.on('error', (error) => { child.spawnError = error; });
      children.add(child);
      const statusFile = path.join(stateDir, 'status.json');
      await waitFor(`${name} connected status`, async () => {
        const status = await readJson(statusFile);
        return status?.connected === true && status.pid === child.pid;
      }, 25_000, child);
      return { child, statusFile, sessionsFile: path.join(stateDir, 'sessions.json') };
    }

    phase = 'real-napcat';
    const real = await launch('real', env.QQ_VERIFY_ONEBOT_URL, env.QQ_VERIFY_ONEBOT_TOKEN, [], []);
    check('real bridge connected with matching PID and empty allowlist');
    liveBot = new OneBot({ url: env.QQ_VERIFY_ONEBOT_URL,
      accessToken: env.QQ_VERIFY_ONEBOT_TOKEN, reconnect: false });
    liveBot.on('error', () => {});
    liveBot.connect();
    await waitFor('read-only OneBot connection', () => liveBot.connected);
    async function realCall(action, params = {}) {
      assert.ok(REAL_ACTIONS.has(action), 'Real NapCat action is outside the probe allowlist');
      evidence.realApiActions.push(action);
      return liveBot.call(action, params, { timeoutMs: 20_000 });
    }
    const version = await realCall('get_version_info');
    const status = await realCall('get_status');
    const image = await realCall('can_send_image');
    assert.ok(version && typeof version === 'object', 'Missing NapCat version response');
    assert.equal(status?.online, true, 'NapCat is not online');
    assert.equal(image?.yes, true, 'NapCat cannot send images');
    check('real NapCat version, online status and image capability');
    const mappedUrl = napcatFileUrl(path.posix.join(env.QQ_VERIFY_NAPCAT_ROOT, probeName, inputName));
    const downloadName = `${probeName}-download.txt`;
    const downloaded = await realCall('download_file', { url: mappedUrl, name: downloadName });
    const downloadedFile = typeof downloaded === 'string' ? downloaded : downloaded?.file;
    assert.ok(typeof downloadedFile === 'string' && downloadedFile.length, 'Missing downloaded file path');
    evidence.napcatDownloadBasename = path.posix.basename(downloadedFile.replaceAll('\\', '/'));
    check('mapped shared file URL accepted with explicit download name');
    const rawUrl = pathToFileURL(inputFile).href;
    if (rawUrl !== mappedUrl) {
      let rejected = false;
      try {
        await realCall('download_file', { url: rawUrl, name: `${probeName}-negative.txt` });
      } catch (error) {
        if (error.retcode === undefined) throw error;
        rejected = true;
      }
      assert.ok(rejected, 'Process-local file URL unexpectedly succeeded in NapCat');
      check('unmapped process-local file URL rejected');
    } else {
      evidence.sameFileNamespace = true;
    }
    liveBot.close();
    liveBot = null;
    await stopBridge(real.child);

    phase = 'real-dsh';
    fake = createFakeNapCat({ onCall(call) { call.reply({ message_id: fake.state.calls.length }); } });
    const port = await fake.listen(0);
    const fakeUrl = `ws://127.0.0.1:${port}`;
    let bridge = await launch('synthetic', fakeUrl, '', [ADMIN, MEMBER], [ADMIN]);
    const replies = (userId, since) => fake.state.calls.slice(since)
      .filter((call) => call.action === 'send_private_msg' && Number(call.params.user_id) === userId)
      .map((call) => replyText(call.params.message));
    const doneTag = `PROBE_DONE_${id}`;
    let since = fake.state.calls.length;
    fake.sendPrivateMessage({ userId: ADMIN, messageId: 101, text:
      `Use filesystem tools to read ${JSON.stringify(inputFile)} and write exactly the same bytes to `
      + `${JSON.stringify(outputFile)}. Do not use messaging, upload or network tools. `
      + `Remember the input marker for our next turn. Only after writing, reply with ${doneTag} `
      + 'followed by one space and the input marker without its trailing newline.' });
    await waitFor('admin tool final reply', () => replies(ADMIN, since)
      .some((text) => text.includes(doneTag) && text.includes(inputMarker)), 210_000, bridge.child);
    assert.deepEqual(await fs.readFile(outputFile), inputBytes, 'Admin output bytes differ');
    const firstSessions = await readJson(bridge.sessionsFile);
    const adminSession = firstSessions?.[ADMIN_KEY]?.sessionId;
    assert.ok(typeof adminSession === 'string' && adminSession, 'Missing persisted admin session');
    check('real DSH tools read an undisclosed marker and write exact output bytes');
    await stopBridge(bridge.child);
    await fs.rm(inputFile);
    await fs.rm(outputFile);

    phase = 'restart';
    bridge = await launch('synthetic', fakeUrl, '', [ADMIN, MEMBER], [ADMIN]);
    assert.equal((await readJson(bridge.sessionsFile))?.[ADMIN_KEY]?.sessionId, adminSession);
    const recallTag = `PROBE_RECALL_${id}`;
    since = fake.state.calls.length;
    fake.sendPrivateMessage({ userId: ADMIN, messageId: 102, text:
      'Recall the exact input marker you read in our previous turn using conversation memory only. '
      + `Do not use tools. Reply with ${recallTag} followed by one space and that marker.` });
    await waitFor('admin recall after bridge restart', () => replies(ADMIN, since)
      .some((text) => text.includes(recallTag) && text.includes(inputMarker)), 210_000, bridge.child);
    assert.equal((await readJson(bridge.sessionsFile))?.[ADMIN_KEY]?.sessionId, adminSession);
    check('restart retains admin session binding and conversation recall without input files');

    phase = 'chat-only';
    const chatTag = `PROBE_CHAT_${id}`;
    since = fake.state.calls.length;
    fake.sendPrivateMessage({ userId: MEMBER, messageId: 103, text: `Reply exactly ${chatTag}` });
    await waitFor('chat-only member final reply', () => replies(MEMBER, since)
      .some((text) => text.includes(chatTag)), 210_000, bridge.child);
    assert.match((await readJson(bridge.sessionsFile))?.[MEMBER_KEY]?.sessionId ?? '', /^qq-chat-/);
    check('ordinary allowlisted member uses a separate chat-only session');

    phase = 'stranger';
    const before = await readJson(bridge.statusFile);
    const beforeSessions = await readJson(bridge.sessionsFile);
    since = fake.state.calls.length;
    fake.sendPrivateMessage({ userId: STRANGER, messageId: 104, text: 'Reply STRANGER_SHOULD_NOT_REPLY' });
    await waitFor('stranger admission decision', async () => {
      const current = await readJson(bridge.statusFile);
      return current?.lastDropAt && current.lastDropAt !== before?.lastDropAt;
    }, 10_000, bridge.child);
    assert.equal(replies(STRANGER, since).length, 0, 'Stranger received a reply');
    assert.deepEqual(await readJson(bridge.sessionsFile), beforeSessions, 'Stranger changed sessions');
    check('stranger is processed and rejected without reply or session');
    await stopBridge(bridge.child);
    evidence.ok = true;
  } catch (error) {
    evidence.failure = { phase, message: safeError(error) };
  } finally {
    liveBot?.close();
    for (const child of [...children]) {
      try { await stopBridge(child); } catch (error) {
        evidence.ok = false;
        evidence.cleanupError = safeError(error);
      }
    }
    await fake?.close();
    // Both directories are generated by this process; never remove the shared root.
    for (const directory of [probeCreated && probeDir, tempRoot].filter(Boolean)) {
      try {
        if (directory === probeDir) assert.equal(path.dirname(path.resolve(directory)), sharedRoot);
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        evidence.ok = false;
        evidence.cleanupError = safeError(error);
      }
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await fs.mkdir(path.dirname(resultFile), { recursive: true });
    await fs.writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  if (!evidence.ok) throw new Error(`${evidence.failure?.phase || 'cleanup'}: `
    + `${evidence.failure?.message || evidence.cleanupError || 'Probe failed'}`);
  console.log(`PASS bridge portability (${evidence.checks.length} checks)`);
}

main().catch((error) => {
  console.error(`FAIL ${redactSecrets(error?.message || error, 800)}`);
  process.exitCode = 1;
});
