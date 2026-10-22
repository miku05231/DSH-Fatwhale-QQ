import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createFakeNapCat } from './ws-harness.mjs';
import { createLocalDshFixture, isolatedEnv } from './helpers/isolated-fixtures.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 10000;
const OWNER = 1000000002;
const BLOCKED = 1000000003;
const STRANGER = 1000000004;
const GROUP_A = 200000001;
const GROUP_B = 200000002;
const GROUP_BLOCKED = 200000003;
const GROUP_UNKNOWN = 200000004;
const TOKEN = 'synthetic-secret-jev-admission';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, child, output, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    if (child?.exitCode !== null) throw new Error(`bridge exited while waiting for ${label}: ${output.join('').slice(-1500)}`);
    await delay(25);
  }
  throw new Error(`timeout waiting for ${label}: ${output.join('').slice(-1500)}`);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function classificationPayload(body) {
  for (const message of body.messages ?? []) {
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.includes('只输出 JSON：{"should_reply":true}')) continue;
    const offset = content.indexOf('{"history":');
    if (offset >= 0) return JSON.parse(content.slice(offset));
  }
  return null;
}

async function fixture(t, { security = {}, jev = {}, timeoutMs = 1000, defaultModel = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-jev-admission-'));
  let child;
  let classifier;
  let napcat;
  let localModel;
  const behavior = { mode: 'classify' };
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await napcat?.close();
    if (classifier) {
      classifier.closeAllConnections?.();
      await new Promise(resolve => classifier.close(resolve));
    }
    await localModel?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  // Module-root writes, including the boot logger, remain inside the disposable installation.
  await fsp.cp(path.join(PROJECT, 'src'), path.join(root, 'src'), { recursive: true });
  const indexPath = path.join(root, 'src', 'index.js');
  const indexSource = await fsp.readFile(indexPath, 'utf8');
  // IPC invokes the real shutdown handler on Windows, where child.kill is immediate.
  await fsp.writeFile(indexPath, indexSource.replace("  process.on('SIGINT'", "  process.on('message', message => { if (message === 'fixture-shutdown') void shutdown('fixture'); });\n  process.on('SIGINT'"));
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const callsFile = path.join(root, 'dsh-calls.jsonl');
  const fakeDsh = path.join(root, 'fake-dsh.mjs');
  await fsp.writeFile(fakeDsh, `import fs from 'node:fs';
const prompt = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ prompt }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'fixture-jev-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: 'fixture bot follow-up: answer alpha' }) + '\\n');
`);
  const patchPath = path.join(root, 'base.yml');
  if (defaultModel) {
    localModel = await createLocalDshFixture({
      prefix: 'qq-jev-admission-model-',
      async reply(body) {
        const payload = classificationPayload(body);
        if (!payload) return 'fixture bot follow-up: answer alpha';
        if (behavior.hold) await behavior.hold;
        return JSON.stringify({ should_reply: behavior.mode === 'allow' || (
          payload.current_message.startsWith('continue') && payload.history.some(entry => entry.role === 'assistant')
        ) });
      },
    });
  }
  await fsp.writeFile(patchPath, localModel?.layer ?? '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture\n');
  napcat = createFakeNapCat();
  const wsPort = await napcat.listen();
  const requests = [];
  classifier = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const payload = JSON.parse(body.messages.at(-1).content);
    const request = { headers: req.headers, body, payload, closed: false };
    res.once('close', () => { request.closed = true; });
    requests.push(request);
    if (payload.current_message === 'ordered first' && behavior.hold) await behavior.hold;
    if (behavior.mode === 'timeout') return;
    if (behavior.mode === 'disconnect') { req.socket.destroy(); return; }
    if (behavior.mode === 'http') {
      res.writeHead(503); res.end(`provider secret ${TOKEN}`); return;
    }
    if (behavior.mode === 'invalid') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(`invalid provider secret ${TOKEN}`); return;
    }
    const eligible = behavior.mode === 'allow' || (
      payload.current_message.startsWith('continue') && payload.history.some(entry => entry.role === 'assistant')
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ should_reply: eligible }) } }] }));
  });
  await new Promise(resolve => classifier.listen(0, '127.0.0.1', resolve));
  const configPath = path.join(root, 'config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    onebot: { url: `ws://127.0.0.1:${wsPort}`, accessToken: '' },
    dsh: { command: localModel?.command ?? fakeDsh, mode: 'headless', companion: false, profile: 'headless', cwd: root, patchPath, timeoutMs: 15000 },
    security: {
      allowFrom: [OWNER, BLOCKED], adminUserIds: [OWNER], denyFrom: [BLOCKED],
      allowGroups: true, allowGroupIds: [GROUP_A, GROUP_B, GROUP_BLOCKED], denyGroupIds: [GROUP_BLOCKED],
      allowGroupMembers: false, privatePolicy: 'allowlist', rateLimitPerMinute: 0, maxChars: 4000, ...security,
    },
    behavior: { wakeWord: 'fixture-wake', queuedNotice: '', maxReplyChunk: 1200, showErrors: true, groupContextCount: 5 },
    jev: { baseUrl: `http://127.0.0.1:${classifier.address().port}/v1`, token: TOKEN, model: 'fixture-jev', timeoutMs, contextMessages: 12, ...jev },
    plugins: { enabled: false }, persona: { enabled: false }, memory: { enabled: false, capture: false, reflectDaily: false },
    stickers: { enabled: false }, automation: { bilibili: { enabled: false } }, stateDir, logDir,
  }));
  const output = [];
  child = spawn(process.execPath, [path.join(root, 'src', 'index.js'), '--config', configPath], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: isolatedEnv(root, { QQ_CONFIG: configPath, QQ_ONEBOT_URL: `ws://127.0.0.1:${wsPort}`, QQ_ONEBOT_TOKEN: '', QQ_FIXTURE_API_KEY: 'synthetic-local-key' }),
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  await waitFor(() => napcat.state.connections > 0, 'OneBot connection', child, output);
  const status = () => readJson(path.join(stateDir, 'status.json'));
  const dshCalls = () => {
    if (localModel) return localModel.requests.filter(body => !classificationPayload(body))
      .map(body => ({ prompt: JSON.stringify(body.messages) }));
    try { return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const replies = () => napcat.state.calls.filter(call => call.action === 'send_group_msg');
  let messageId = 1000;
  function send(text, options = {}) {
    napcat.sendGroupMessage({
      groupId: GROUP_A, userId: OWNER, text, selfId: SELF, nickname: 'fixture-user',
      messageId: ++messageId, atSelf: false, ...options,
    });
  }
  async function rejected(text, reason, options) {
    const before = status()?.lastDropAt;
    const calls = dshCalls().length;
    send(text, options);
    await waitFor(() => {
      const latest = status();
      return latest?.lastDropAt !== before && reason.test(latest?.lastDrop ?? '');
    }, `drop ${text}`, child, output);
    assert.equal(dshCalls().length, calls, 'rejected message must not enter DSH');
  }
  async function expectReply(text, options) {
    const count = replies().length;
    send(text, options);
    await waitFor(() => replies().length > count, `reply ${text}`, child, output);
    const message = replies().at(-1).params.message;
    const content = Array.isArray(message) ? message.map(segment => segment.data?.text ?? '').join('') : String(message);
    assert.match(content, /fixture bot follow-up/);
  }
  function shutdown() {
    child.send('fixture-shutdown');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge graceful shutdown timed out')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  return { root, stateDir, logDir, requests, defaultRequests: localModel?.requests, behavior, output, child, send, rejected, expectReply, shutdown, status, dshCalls, replies };
}

test('same-group follow-up uses bot answer while another allowed group stays isolated', async t => {
  const f = await fixture(t);
  await f.expectReply('seed alpha private to group A', { atSelf: true });
  assert.equal(f.requests.length, 0, 'explicit mention bypasses JEV');
  await f.expectReply('continue alpha');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(f.requests[0].payload.history.some(entry => entry.role === 'assistant' && entry.text.includes('answer alpha')));
  assert.ok(f.requests[0].payload.history.some(entry => entry.role === 'user' && entry.text.includes('seed alpha')));
  await f.rejected('continue beta', /model_not_eligible/, { groupId: GROUP_B });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].payload.history.some(entry => entry.role === 'assistant'), false);
  assert.equal(JSON.stringify(f.requests[1].payload.history).includes('alpha'), false);
  assert.equal(f.dshCalls().length, 2);
});

test('ordinary group conversation is classified once and stays outside DSH', async t => {
  const f = await fixture(t);
  await f.rejected('ordinary chat between members', /model_not_eligible/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].payload.history, [], 'current message must not duplicate into history');
  assert.equal(f.replies().length, 0);
});

test('group/member/blacklist gates precede the classifier and blocked data stays out of context', async t => {
  const f = await fixture(t);
  await f.rejected('unknown group sensitive', /allowGroupIds/, { groupId: GROUP_UNKNOWN });
  await f.rejected('blocked group sensitive', /denyGroupIds/, { groupId: GROUP_BLOCKED });
  await f.rejected('blocked user sensitive', /denyFrom/, { userId: BLOCKED });
  await f.rejected('unauthorized member', /allowGroupMembers=false/, { userId: STRANGER });
  assert.equal(f.requests.length, 0);
  await f.rejected('ordinary admitted message', /model_not_eligible/);
  const serialized = JSON.stringify(f.requests[0].payload.history);
  assert.doesNotMatch(serialized, /unknown group sensitive|blocked group sensitive|blocked user sensitive/);
  assert.equal(f.dshCalls().length, 0);
  await assert.rejects(fsp.access(path.join(f.stateDir, 'groupmem', `${GROUP_UNKNOWN}.jsonl`)), { code: 'ENOENT' });
  await assert.rejects(fsp.access(path.join(f.stateDir, 'groupmem', `${GROUP_BLOCKED}.jsonl`)), { code: 'ENOENT' });
});

test('rate limit is consumed before classification and stops a second model call', async t => {
  const f = await fixture(t, { security: { rateLimitPerMinute: 1 } });
  await f.rejected('ordinary first attempt', /model_not_eligible/);
  assert.equal(f.requests.length, 1);
  await f.rejected('ordinary second attempt', /触发限流/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.dshCalls().length, 0);
  assert.equal(f.replies().length, 0, 'unaddressed group chatter must stay silent when rate limited');
});

test('slow classification preserves group arrival order without blocking another group', async t => {
  const f = await fixture(t, { timeoutMs: 5000 });
  let release;
  f.behavior.mode = 'allow';
  f.behavior.hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.send('ordered first');
  await waitFor(() => f.requests.length === 1, 'first classifier request', f.child, f.output);
  f.send('ordered second');
  f.send('ordered explicit third', { atSelf: true });
  f.send('parallel other group', { groupId: GROUP_B });
  await waitFor(() => f.dshCalls().length === 1, 'independent group response', f.child, f.output);
  assert.equal(f.requests.some(request => request.payload.current_message === 'ordered second'), false);
  assert.match(f.dshCalls()[0].prompt, /内容：parallel other group/);
  release();
  await waitFor(() => f.dshCalls().length === 4, 'ordered DSH calls', f.child, f.output);
  assert.deepEqual(f.dshCalls().slice(1).map(call => call.prompt.match(/\[当前消息\][\s\S]*?内容：([^\n]+)/)?.[1]), [
    'ordered first', 'ordered second', `@${SELF} ordered explicit third`,
  ]);
});

test('classifier timeout fails closed while an explicit mention still recovers', async t => {
  const f = await fixture(t, { timeoutMs: 80 });
  f.behavior.mode = 'timeout';
  await f.rejected('waiting for classifier', /timeout/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.replies().length, 0);
  await f.expectReply('explicit after timeout', { atSelf: true });
  assert.equal(f.requests.length, 1);
  assert.equal(f.dshCalls().length, 1);
});

test('HTTP, malformed JSON and disconnected provider failures all stay outside DSH', async t => {
  const f = await fixture(t);
  for (const [mode, reason] of [['http', /provider_http_error/], ['invalid', /provider_error/], ['disconnect', /provider_error/]]) {
    f.behavior.mode = mode;
    await f.rejected(`provider ${mode}`, reason);
  }
  assert.equal(f.requests.length, 3);
  assert.equal(f.dshCalls().length, 0);
  assert.equal(f.replies().length, 0);
});

test('provider token and response bodies never appear in runtime output, status or log files', async t => {
  const f = await fixture(t);
  f.behavior.mode = 'http';
  await f.rejected('error response redaction', /provider_http_error/);
  f.behavior.mode = 'invalid';
  await f.rejected('invalid response redaction', /provider_error/);
  const logs = [];
  for (const name of await fsp.readdir(f.logDir)) {
    const file = path.join(f.logDir, name);
    if ((await fsp.stat(file)).isFile()) logs.push(await fsp.readFile(file, 'utf8'));
  }
  const visible = JSON.stringify({ stdout: f.output, status: f.status(), logs });
  assert.equal(visible.includes(TOKEN), false);
  assert.equal(visible.includes('provider secret'), false);
  assert.equal(f.requests[0].headers.authorization, `Bearer ${TOKEN}`, 'token must still reach the configured endpoint');
});

test('no JEV configuration continues same-group context through the real default model and isolates other groups', { timeout: 60000 }, async t => {
  const f = await fixture(t, {
    defaultModel: true, timeoutMs: 15000, jev: { baseUrl: '', token: '', model: '' }, security: { adminUserIds: [] },
  });
  await f.expectReply('seed alpha group A', { atSelf: true });
  await f.expectReply('continue alpha');
  await f.rejected('continue group B', /model_not_eligible/, { groupId: GROUP_B });
  assert.equal(f.requests.length, 0, 'the independent endpoint must never be contacted');
  assert.equal(f.dshCalls().length, 2);
  const decisions = f.defaultRequests.filter(classificationPayload);
  assert.equal(decisions.length, 2);
  const [first, second] = decisions.map(classificationPayload);
  assert.ok(first.history.some(entry => entry.role === 'assistant' && entry.text.includes('answer alpha')));
  assert.ok(first.history.some(entry => entry.role === 'user' && entry.text.includes('seed alpha')));
  assert.equal(JSON.stringify(second.history).includes('alpha'), false);
  assert.equal(second.history.some(entry => entry.role === 'assistant'), false);
  for (const request of decisions) assert.equal(request.tools?.length ?? 0, 0, 'default classification exposes no tools');
});

test('missing or whitespace URL and token route admission to the real default model', { timeout: 60000 }, async t => {
  for (const jev of [{ token: '' }, { baseUrl: '' }, { baseUrl: '   ' }, { token: ' \t ' }]) {
    const f = await fixture(t, { defaultModel: true, timeoutMs: 15000, jev, security: { adminUserIds: [] } });
    await f.rejected('ordinary group conversation', /model_not_eligible/);
    f.behavior.mode = 'allow';
    await f.expectReply('continue accepted by default');
    assert.equal(f.requests.length, 0);
    assert.equal(f.defaultRequests.filter(classificationPayload).length, 2);
    assert.equal(f.dshCalls().length, 1);
  }
});

test('complete JEV credentials without a model reject without falling back to DSH', async t => {
  const f = await fixture(t, { jev: { model: '' } });
  await f.rejected('continue without JEV model', /invalid_request/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.dshCalls().length, 0);
});

test('shutdown cancels in-flight JEV classification before a delayed eligible result can enqueue DSH', async t => {
  const f = await fixture(t, { timeoutMs: 15000 });
  let release;
  f.behavior.mode = 'allow';
  f.behavior.hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.send('ordered first');
  await waitFor(() => f.requests.length === 1, 'pending classifier', f.child, f.output);
  const stopping = f.shutdown();
  await waitFor(() => f.output.join('').includes('正在退出'), 'shutdown start', f.child, f.output);
  release();
  await stopping;
  assert.equal(f.dshCalls().length, 0);
  assert.equal(f.replies().length, 0);
  assert.equal(f.requests[0].closed, true);
  assert.equal(f.status().pid, 0);
});

test('shutdown cancels the default classifier and never starts a reply session', { timeout: 60000 }, async t => {
  const f = await fixture(t, {
    defaultModel: true, timeoutMs: 15000, jev: { baseUrl: '', token: '', model: '' }, security: { adminUserIds: [] },
  });
  let release;
  f.behavior.mode = 'allow';
  f.behavior.hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.send('continue during shutdown');
  await waitFor(() => f.defaultRequests.length === 1, 'pending default model', f.child, f.output);
  const stopping = f.shutdown();
  await waitFor(() => f.output.join('').includes('正在退出'), 'shutdown start', f.child, f.output);
  release();
  await stopping;
  assert.equal(f.dshCalls().length, 0);
  assert.equal(f.replies().length, 0);
  assert.equal(f.defaultRequests.length, 1);
  assert.equal(f.status().pid, 0);
});
