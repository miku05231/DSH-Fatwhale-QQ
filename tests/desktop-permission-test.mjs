// Exercise the real desktop host with a temporary DSH fixture, never a real profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-desktop-permissions-'));
const dshRoot = path.join(tmp, 'dsh');
const profileDir = path.join(tmp, 'desktop');
const bootDir = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
fs.mkdirSync(path.join(dshRoot, 'lib'), { recursive: true });
fs.mkdirSync(bootDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(dshRoot, 'package.json'), '{"name":"fake-dsh","type":"module"}');
fs.writeFileSync(path.join(bootDir, 'package.json'), '{"name":"@deepseek-ai/dsh-app-boot","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(bootDir, 'index.js'), [
  'export const loadProfileDirectory = () => ({});',
  'export const loadLayeredEnv = () => ({});',
].join('\n'));
fs.writeFileSync(path.join(dshRoot, 'lib', 'profile-boot.js'), `
import fs from 'node:fs';
const events = [];
let mode = 'danger-full-access';
let permissionCount = 0;
let promptCount = 0;
const scenario = process.env.QQ_PERMISSION_FIXTURE_SCENARIO;
const record = (value) => {
  fs.appendFileSync(process.env.QQ_PERMISSION_FIXTURE_LOG, JSON.stringify(value) + '\\n');
  process.stderr.write('FIXTURE ' + JSON.stringify(value) + '\\n');
};
const session = { seq: 0, eventAt: (seq) => events[seq] };
const append = (event) => { events.push(event); session.seq = events.length; };
const permissions = {
  names: ['read-only', 'workspace-write', 'danger-full-access', 'safe-alias'],
  resolve: (name) => {
    if (['bad-bundle', 'alias'].includes(scenario) && name === 'workspace-write') {
      return { sandbox: 'danger-full-access', approval: 'never' };
    }
    if (name === 'safe-alias') {
      if (scenario !== 'alias') throw new Error('not supported');
      return { sandbox: 'workspace-write', approval: 'ask' };
    }
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error('unknown preset');
    return { sandbox: name, approval: name === 'danger-full-access' ? 'never' : 'ask' };
  },
  current: () => mode,
  set: (_session, name) => {
    record({ type: 'set', name });
    permissionCount += 1;
    if (scenario === 'permission-hang' && permissionCount === 1) {
      record({ type: 'permission-waiting' });
      return new Promise(() => {});
    }
    if (scenario === 'throws') throw new Error('fixture set failed');
    if (scenario !== 'ignored') mode = name;
  },
};
const services = {
  loader: { await: async () => {} },
  sessionController: {
    create: async (request) => {
      record({ type: 'create', sessionId: request.sessionId });
      return { sessionId: request.sessionId || 'new-fixture-session' };
    },
    prompt: async (request) => {
      record({ type: 'prompt', mode, text: request.content[0].text });
      promptCount += 1;
      if (scenario === 'prompt-hang' && promptCount === 1) return new Promise(() => {});
      append({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fixture reply' }] } } });
      append({ type: 'turn/end', data: { reason: { kind: 'complete' } } });
    },
    cancel: () => {
      record({ type: 'cancel' });
      if (scenario === 'prompt-hang') return Promise.reject(new Error('fixture cancel rejection'));
      return { accepted: true };
    },
  },
  agents: { get: () => ({ session, whenIdle: async () => {} }), selectForNextRequest: () => record({ type: 'selected' }) },
  llm: {
    resolveCallConfig: async (model, signal) => {
      record({ type: 'model-waiting' });
      signal.addEventListener('abort', () => record({ type: 'model-aborted' }), { once: true });
      return new Promise(() => {});
    },
  },
  sessions: { flush: async () => {} },
  sessionQuery: { observeSession: async () => ({ header: { cwd: process.cwd() } }) },
  permissionPresets: scenario === 'missing' ? undefined : permissions,
};
export function runProfile() {
  return Promise.resolve({ ctx: { get: (name) => services[name], fiber: { dispose: async () => {} } } });
}
`);

let passed = 0;
const children = new Set();
process.on('exit', () => {
  for (const child of children) child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runHost(scenario, permissionMode, sessionId = 'existing-admin-session', hooks = {}) {
  const logPath = path.join(tmp, `${scenario}-${permissionMode}.jsonl`);
  const child = spawn(process.execPath, [
    path.join(ROOT, 'src', 'dsh-desktop-host.mjs'),
    '--dsh-root', dshRoot, '--profile-dir', profileDir, '--cwd', tmp, '--permission', permissionMode,
  ], {
    cwd: tmp,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QQ_PERMISSION_FIXTURE_SCENARIO: scenario,
      QQ_PERMISSION_FIXTURE_LOG: logPath,
    },
  });
  children.add(child);
  const messages = [];
  let stderr = '';
  let finish;
  let fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const timer = setTimeout(() => {
    child.kill();
    fail(new Error(`fixture timed out: ${stderr}`));
  }, 5_000);
  child.on('error', fail);
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const send = (message) => child.stdin.write(`${JSON.stringify({ v: 1, ...message })}\n`);
  const errors = readline.createInterface({ input: child.stderr });
  errors.on('line', (line) => {
    if (!line.startsWith('FIXTURE ')) return;
    try {
      hooks.onRecord?.(JSON.parse(line.slice('FIXTURE '.length)), send);
    } catch (error) {
      fail(error);
    }
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === 'ready') {
        send({
          op: 'prompt', id: 'test-request', text: 'fixture prompt', cwd: tmp, sessionId,
          ...hooks.initialRequest,
        });
      }
      hooks.onMessage?.(message, send);
      const shouldFinish = hooks.finishOn ? hooks.finishOn(message) : ['final', 'error', 'fatal'].includes(message.type);
      if (shouldFinish || message.type === 'fatal') finish(message);
    } catch (error) {
      fail(error);
    }
  });
  try {
    const message = await result;
    child.stdin.end(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
    await closed;
    const records = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { message, messages, records };
  } finally {
    clearTimeout(timer);
    lines.close();
    errors.close();
    child.kill();
    children.delete(child);
  }
}

async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  OK ${label}`);
}

for (const permissionMode of ['workspace-write', 'read-only', 'danger-full-access']) {
  await check(`restored session applies ${permissionMode} before prompt`, async () => {
    const result = await runHost('normal', permissionMode);
    assert.equal(result.message.type, 'final');
    assert.equal(result.message.text, 'fixture reply');
    assert.deepEqual(result.records, [
      { type: 'create', sessionId: 'existing-admin-session' },
      { type: 'set', name: permissionMode },
      { type: 'prompt', mode: permissionMode, text: 'fixture prompt' },
    ]);
  });
}

for (const scenario of ['missing', 'ignored', 'throws', 'bad-bundle']) {
  await check(`permission ${scenario} fails before prompt acceptance`, async () => {
    const result = await runHost(scenario, 'workspace-write');
    assert.equal(result.message.type, 'error');
    assert.equal(result.message.code, 'permission-unsupported');
    assert.equal(result.messages.some((message) => message.type === 'session'), false);
    assert.equal(result.records.some((record) => record.type === 'prompt'), false);
  });
}

await check('custom preset alias is selected by sandbox and approval bundle', async () => {
  const result = await runHost('alias', 'workspace-write');
  assert.equal(result.message.type, 'final');
  assert.equal(result.records.find((record) => record.type === 'set').name, 'safe-alias');
  assert.equal(result.records.find((record) => record.type === 'prompt').mode, 'safe-alias');
});

const sendNext = (send) => send({
  op: 'prompt', id: 'next-request', sessionId: 'next-fixture-session', text: 'next message', cwd: tmp,
});
const finishNext = (message) => message.type === 'final' && message.id === 'next-request';

await check('cancel during model lookup prevents prompt and releases the queue', async () => {
  const result = await runHost('model-hang', 'workspace-write', 'existing-admin-session', {
    initialRequest: { model: { provider: 'fixture', model: 'pending' } },
    onRecord: (record, send) => {
      if (record.type === 'model-waiting') send({ op: 'cancel', id: 'test-request' });
    },
    onMessage: (message, send) => {
      if (message.type === 'error' && message.id === 'test-request') sendNext(send);
    },
    finishOn: finishNext,
  });
  assert.equal(result.message.type, 'final');
  assert.equal(result.messages.find((message) => message.id === 'test-request' && message.type === 'error').code, 'aborted');
  assert.equal(result.messages.some((message) => message.id === 'test-request' && message.type === 'session'), false);
  assert.equal(result.records.some((record) => record.type === 'model-aborted'), true);
  assert.equal(result.records.some((record) => record.type === 'selected'), false);
  assert.deepEqual(result.records.filter((record) => record.type === 'prompt').map((record) => record.text), ['next message']);
  assert.equal(result.records.some((record) => record.type === 'cancel'), false);
});

await check('cancel during permission preparation prevents prompt and does not cancel another agent', async () => {
  const result = await runHost('permission-hang', 'workspace-write', 'existing-admin-session', {
    onRecord: (record, send) => {
      if (record.type === 'permission-waiting') send({ op: 'cancel', id: 'test-request' });
    },
    onMessage: (message, send) => {
      if (message.type === 'error' && message.id === 'test-request') sendNext(send);
    },
    finishOn: finishNext,
  });
  assert.equal(result.message.type, 'final');
  assert.equal(result.messages.find((message) => message.id === 'test-request' && message.type === 'error').code, 'aborted');
  assert.equal(result.messages.some((message) => message.id === 'test-request' && message.type === 'session'), false);
  assert.deepEqual(result.records.filter((record) => record.type === 'prompt').map((record) => record.text), ['next message']);
  assert.equal(result.records.some((record) => record.type === 'cancel'), false);
});

await check('cancel removes a queued request before it can create or execute a session', async () => {
  const result = await runHost('queued-model-hang', 'workspace-write', 'existing-admin-session', {
    initialRequest: { model: { provider: 'fixture', model: 'pending' } },
    onRecord: (record, send) => {
      if (record.type !== 'model-waiting') return;
      send({ op: 'prompt', id: 'queued-request', sessionId: 'queued-fixture-session', text: 'must not run', cwd: tmp });
      send({ op: 'cancel', id: 'queued-request' });
    },
    onMessage: (message, send) => {
      if (message.type !== 'error') return;
      if (message.id === 'queued-request') send({ op: 'cancel', id: 'test-request' });
      if (message.id === 'test-request') sendNext(send);
    },
    finishOn: finishNext,
  });
  assert.equal(result.message.type, 'final');
  assert.equal(result.messages.find((message) => message.id === 'queued-request' && message.type === 'error').code, 'aborted');
  assert.equal(result.records.some((record) => record.type === 'create' && record.sessionId === 'queued-fixture-session'), false);
  assert.deepEqual(result.records.filter((record) => record.type === 'prompt').map((record) => record.text), ['next message']);
});

await check('a rejecting asynchronous cancel cannot crash the host or block the next request', async () => {
  const result = await runHost('prompt-hang', 'workspace-write', 'existing-admin-session', {
    onRecord: (record, send) => {
      if (record.type === 'prompt' && record.text === 'fixture prompt') send({ op: 'cancel', id: 'test-request' });
    },
    onMessage: (message, send) => {
      if (message.type === 'error' && message.id === 'test-request') sendNext(send);
    },
    finishOn: finishNext,
  });
  assert.equal(result.message.type, 'final');
  assert.equal(result.messages.some((message) => message.type === 'fatal'), false);
  assert.equal(result.records.filter((record) => record.type === 'cancel').length, 1);
  assert.deepEqual(result.records.filter((record) => record.type === 'prompt').map((record) => record.text), [
    'fixture prompt', 'next message',
  ]);
});

console.log(`\nPassed ${passed} desktop permission checks`);
