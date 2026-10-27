import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFakeNapCat } from './ws-harness.mjs';
import { isolatedEnv, prepareIsolatedHome } from './helpers/isolated-fixtures.mjs';
import { killProcessTree } from '../src/dsh.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 1000000002;
const PUSH_USER = 1000000003;
const GROUP = 200000001;
const textOf = (call) => Array.isArray(call.params.message)
  ? call.params.message.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('')
  : String(call.params.message ?? '');
const isVoice = (call) => Array.isArray(call.params.message) && call.params.message.some((segment) => segment.type === 'record');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('actual bridge integrates text, voice and platform scheduler with isolated adapters', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-e2e-platform-voice-'));
  const configPath = path.join(root, 'config.json');
  const stateDir = path.join(root, 'state');
  const tracePath = path.join(root, 'trace.jsonl');
  const trace = () => {
    try { return fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  const napcat = createFakeNapCat({ token: 'synthetic-e2e-onebot-token' });
  let child;
  let childDone;
  const output = [];
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Bridge exited: ${output.join('').slice(-3000)}`);
      await delay(30);
    }
    throw new Error(`Timeout: ${label}; ${output.join('').slice(-3000)}`);
  };
  try {
    // Snapshot the source so even the logger before config loading stays inside the fixture.
    await fsp.cp(path.join(PROJECT_ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    await prepareIsolatedHome(root);
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    await fsp.writeFile(path.join(root, 'base.yml'), '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture\n');
    await fsp.writeFile(path.join(stateDir, 'plugins.json'), '{"reply-tts":{"enabled":true}}\n');
    await fsp.writeFile(path.join(stateDir, 'bilibili-cookie.json'), JSON.stringify({ cookies: { SESSDATA: 'synthetic-platform-cookie', bili_jct: 'synthetic-csrf' } }));
    const port = await napcat.listen();
    const config = {
      onebot: { url: `ws://127.0.0.1:${port}`, accessToken: 'synthetic-e2e-onebot-token' },
      dsh: { command: process.execPath, mode: 'headless', companion: false, cwd: root, patchPath: path.join(root, 'base.yml'), timeoutMs: 5000 },
      security: { adminUserIds: [], allowFrom: [USER], privatePolicy: 'allowlist', rateLimitPerMinute: 0, maxChars: 4000 },
      behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, groupContextCount: 0 },
      plugins: { enabled: true, dir: path.join(root, 'src', 'plugins'), 'reply-tts': { maxChars: 200, timeoutMs: 1000, translationEnabled: true, targetLanguage: '日语' } },
      persona: { enabled: false }, memory: { enabled: false, capture: false, reflectDaily: false, reflectEvery: 0 },
      stickers: { enabled: false }, stateDir, logDir: path.join(root, 'logs'),
      automation: { bilibili: { enabled: false, cron: '* * * * *', keywords: ['fixture'], upUsers: ['770001'], targets: [String(PUSH_USER), `g:${GROUP}`], mentionUid: '880001', commentEnabled: false, commentApproved: false } },
    };
    const save = () => fsp.writeFile(configPath, `${JSON.stringify(config)}\n`);
    await save();
    const loader = new URL('./fixtures/platform-voice-loader.mjs', import.meta.url);
    child = spawn(process.execPath, ['--experimental-loader', loader.href, path.join(root, 'src', 'index.js'), '--config', configPath], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: isolatedEnv(root, { QQ_CONFIG: configPath, QQ_PLATFORM_VOICE_ROOT: root }),
    });
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    childDone = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    childDone.catch(() => {});
    await waitFor(() => napcat.state.connections === 1 && trace().some((row) => row.event === 'scheduler:start'), 'first bridge ready');
    const records = () => napcat.state.calls.filter(isVoice);
    const pushes = () => napcat.state.calls.filter((call) => textOf(call) === 'fixture platform summary');
    const reconnect = async () => {
      const before = napcat.state.connections;
      const stopped = trace().filter((row) => row.event === 'scheduler:stop').length;
      napcat.destroy();
      await waitFor(() => trace().filter((row) => row.event === 'scheduler:stop').length > stopped, 'scheduler stops on disconnect');
      await waitFor(() => napcat.state.connections > before && trace().filter((row) => row.event === 'scheduler:start').length === napcat.state.connections, 'scheduler restarts on ready');
    };
    await t.test('a full private reply sends text before a base64 OneBot record', async () => {
      napcat.sendPrivateMessage({ userId: USER, text: 'VOICE_GOOD', messageId: 7001 });
      await waitFor(() => records().length === 1, 'voice reply');
      const textIndex = napcat.state.calls.findIndex((call) => textOf(call) === 'fixture reply speech');
      const voiceIndex = napcat.state.calls.findIndex(isVoice);
      assert.ok(textIndex >= 0 && voiceIndex > textIndex);
      assert.equal(napcat.state.calls[voiceIndex].params.user_id, USER);
      assert.match(records()[0].params.message[0].data.file, /^base64:\/\//);
      assert.ok(trace().some((row) => row.event === 'model' && row.kind === 'translation' && row.sessionId === null && row.prompt.includes('fixture reply speech')));
      assert.equal(trace().find((row) => row.event === 'tts:synthesized')?.text, 'こんにちは。翻訳した音声です。');
    });
    await t.test('disabled automation does not fetch, summarize or push during conversation', async () => {
      assert.equal(trace().some((row) => ['adapter', 'search', 'dynamics', 'publish'].includes(row.event)), false);
      assert.equal(trace().some((row) => row.event === 'model' && ['summary', 'comment'].includes(row.kind)), false);
      assert.equal(pushes().length, 0);
    });
    await t.test('TTS failure preserves the text and cleans temporary audio', async () => {
      await fsp.writeFile(path.join(root, 'tts-fail'), 'fixture');
      napcat.sendPrivateMessage({ userId: USER, text: 'VOICE_FAIL', messageId: 7002 });
      await waitFor(() => trace().some((row) => row.event === 'tts:failed'), 'failed synthesis');
      assert.ok(napcat.state.calls.some((call) => textOf(call) === 'fixture reply failure'));
      assert.equal(records().length, 1);
      assert.deepEqual((await fsp.readdir(root)).filter((name) => name.startsWith('qq-tts-')), []);
    });
    await t.test('enabling a scheduled task pushes one summary to each configured QQ target', async () => {
      config.automation.bilibili.enabled = true;
      await save();
      await reconnect();
      await waitFor(() => pushes().length === 2, 'scheduled summary delivery');
      assert.ok(pushes().some((call) => call.action === 'send_private_msg' && call.params.user_id === PUSH_USER));
      assert.ok(pushes().some((call) => call.action === 'send_group_msg' && call.params.group_id === GROUP));
      assert.ok(trace().some((row) => row.event === 'search') && trace().some((row) => row.event === 'dynamics'));
      assert.equal(trace().filter((row) => row.event === 'publish').length, 0);
      assert.ok(trace().filter((row) => row.event === 'model' && row.kind === 'summary').every((row) => row.sessionId === null));
    });
    await t.test('reconnection reuses one scheduler and does not duplicate delivered feeds', async () => {
      await waitFor(() => !fs.existsSync(path.join(stateDir, 'bilibili-scheduler.lock')), 'first tick completion');
      await reconnect();
      await delay(120);
      assert.equal(trace().filter((row) => row.event === 'scheduler:create').length, 1);
      assert.equal(trace().filter((row) => row.event === 'scheduler:start').length, napcat.state.connections);
      assert.equal(pushes().length, 2);
    });
    await t.test('only explicit comment enablement and acceptance reach the mocked publisher and audit', async () => {
      config.automation.bilibili.commentEnabled = true;
      config.automation.bilibili.commentApproved = true;
      await save();
      await fsp.writeFile(path.join(stateDir, 'bilibili-run-now.json'), '{"queuedAt":"fixture"}');
      await reconnect();
      await waitFor(() => trace().filter((row) => row.event === 'publish').length === 1 && !fs.existsSync(path.join(stateDir, 'bilibili-scheduler.lock')), 'accepted mocked comment');
      const state = JSON.parse(await fsp.readFile(path.join(stateDir, 'bilibili-state.json'), 'utf8'));
      assert.equal(state.audit[0].dynamicId, '900001');
      assert.equal(state.audit[0].targetUid, '880001');
      assert.equal(state.audit[0].status, 'published');
      assert.equal(state.audit[0].text, '@fixture fixture polite comment');
      assert.equal(pushes().length, 2);
    });
    await t.test('the same dynamic cannot publish twice after another queued run', async () => {
      await fsp.writeFile(path.join(stateDir, 'bilibili-run-now.json'), '{"queuedAt":"fixture"}');
      await reconnect();
      await waitFor(() => !fs.existsSync(path.join(stateDir, 'bilibili-run-now.json')) && !fs.existsSync(path.join(stateDir, 'bilibili-scheduler.lock')), 'deduplicated queued tick');
      assert.equal(trace().filter((row) => row.event === 'publish').length, 1);
      assert.equal(pushes().length, 2);
    });
    await t.test('platform credentials are absent from model prompts and runtime output', async () => {
      const messages = `${trace().filter((row) => row.event === 'model').map((row) => row.prompt).join('\n')}\n${output.join('')}`;
      assert.equal(messages.includes('synthetic-platform-cookie'), false);
      assert.equal(messages.includes('synthetic-csrf'), false);
      assert.equal(messages.includes('synthetic-e2e-onebot-token'), false);
    });
  } finally {
    if (child && child.exitCode === null) killProcessTree(child);
    await childDone?.catch(() => {});
    await napcat.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
