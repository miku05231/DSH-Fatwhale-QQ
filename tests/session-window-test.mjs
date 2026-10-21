// Fixed session windows: persisted clock, live settings, and the real bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  SessionStore, DEFAULT_SESSION_WINDOW_MINUTES, isValidSessionWindowMinutes, readSessionWindowMinutes,
} from '../src/sessions.js';
import { computerSessionKey } from '../src/computer-access.js';
import { killProcessTree } from '../src/dsh.js';
import { createFakeNapCat } from './ws-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MINUTE = 60_000;
const START = 1_800_000_000_000;
const ADMIN = 10001;
const MEMBER = 10002;
const GROUP = 20001;
let passed = 0;
const check = (name, run) => {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
};
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storeChecks(root) {
  const store = new SessionStore(root);
  check('default window is three hours', () => assert.equal(DEFAULT_SESSION_WINDOW_MINUTES, 180));
  for (const value of [null, true, '', '180', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    check(`invalid window is refused (${String(value)})`, () => {
      assert.equal(isValidSessionWindowMinutes(value), false);
      assert.throws(() => store.get('group', { windowMinutes: value }));
    });
  }
  store.set('group', 'first', { startedAt: START });
  check('window begins at first execution, before a model finishes', () =>
    assert.equal(readJson(store.file).group.startedAt, START));
  for (const elapsed of [0, 90 * MINUTE, 180 * MINUTE - 1]) {
    check(`same session before fixed expiry (${elapsed} ms)`, () =>
      assert.equal(store.get('group', { windowMinutes: 180, now: START + elapsed }), 'first'));
    store.set('group', 'first', { startedAt: START + elapsed });
  }
  check('continuing a conversation never moves its starting time', () =>
    assert.equal(readJson(store.file).group.startedAt, START));
  check('expiry is exact even after continued conversation and a restart', () => {
    const restarted = new SessionStore(root);
    assert.equal(restarted.get('group', { windowMinutes: 180, now: START + 180 * MINUTE }), null);
    assert.equal(restarted.get('group', { windowMinutes: 0, now: START + 999 * MINUTE }), 'first');
  });
  check('shortening or extending the window uses the original start', () => {
    assert.equal(store.get('group', { windowMinutes: 60, now: START + 90 * MINUTE }), null);
    assert.equal(store.get('group', { windowMinutes: 240, now: START + 180 * MINUTE }), 'first');
  });
  check('a backwards clock does not extend a finite window indefinitely', () =>
    assert.equal(store.get('group', { windowMinutes: 180, now: START - 1 }), null));
  check('other groups keep their own session and clock', () => {
    store.set('other-group', 'other', { startedAt: START + 100 * MINUTE });
    assert.equal(store.get('other-group', { windowMinutes: 180, now: START + 180 * MINUTE }), 'other');
  });
  check('another instance can clear a mapping without resurrecting it', () => {
    new SessionStore(root).remove('group');
    assert.equal(store.get('group', { windowMinutes: 180, now: START }), null);
    store.set('third', 'third', { startedAt: START });
    assert.equal(Object.hasOwn(readJson(store.file), 'group'), false);
    assert.equal(readJson(store.file)['other-group'].sessionId, 'other');
  });
  check('a transient disk read failure cannot replace saved sessions with an empty map', () => {
    const originalRead = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (file === store.file) throw Object.assign(new Error('fixture read failure'), { code: 'EBUSY' });
      return originalRead(file, ...args);
    };
    try {
      assert.throws(() => store.set('must-not-write', 'new'), /读取会话文件失败/);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(Object.hasOwn(readJson(store.file), 'must-not-write'), false);
    assert.equal(readJson(store.file)['other-group'].sessionId, 'other');
  });
  check('a failed atomic write is reported and leaves the previous file intact', () => {
    const quiet = new SessionStore(root, { log: { warn() {} } });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === store.file) throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
      return originalRename(from, to);
    };
    try {
      assert.throws(() => quiet.set('must-not-write', 'new'), /会话绑定保存失败/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(Object.hasOwn(readJson(store.file), 'must-not-write'), false);
    assert.equal(readJson(store.file)['other-group'].sessionId, 'other');
  });
  check('a legacy string adopts one persisted start and remains resumable', () => {
    writeJson(store.file, { legacy: 'old-session' });
    assert.equal(store.get('legacy', { windowMinutes: 180, now: START }), 'old-session');
    assert.equal(new SessionStore(root).get('legacy', { windowMinutes: 180, now: START + MINUTE }), 'old-session');
    assert.equal(readJson(store.file).legacy.startedAt, START);
    assert.deepEqual(store.all(), { legacy: 'old-session' });
  });
  check('invalid timestamps are discarded while valid legacy data remains', () => {
    writeJson(store.file, { bad: { sessionId: 'invalid', startedAt: -1 }, legacy: 'old-session' });
    const warnings = [];
    const sanitized = new SessionStore(root, { log: { warn: (value) => warnings.push(value) } });
    assert.equal(sanitized.get('bad'), null);
    assert.equal(sanitized.get('legacy'), 'old-session');
    assert.equal(warnings.length, 1);
  });
  const configPath = path.join(root, 'window-config.json');
  check('live settings accept zero and retain the last valid setting on bad data', () => {
    writeJson(configPath, { behavior: { sessionWindowMinutes: 0 } });
    assert.equal(readSessionWindowMinutes(configPath, 90), 0);
    writeJson(configPath, { behavior: { sessionWindowMinutes: -1 } });
    assert.equal(readSessionWindowMinutes(configPath, 90), 90);
    writeJson(configPath, { behavior: { sessionWindowMinutes: null } });
    assert.equal(readSessionWindowMinutes(configPath, 90), 90);
    fs.writeFileSync(configPath, '{broken');
    assert.equal(readSessionWindowMinutes(configPath, 90), 90);
    writeJson(configPath, {});
    assert.equal(readSessionWindowMinutes(configPath, 90), 180);
  });
}

async function bridgeChecks(root) {
  const app = path.join(root, 'app');
  await fsp.cp(path.join(ROOT, 'src'), path.join(app, 'src'), { recursive: true });
  writeJson(path.join(app, 'package.json'), { type: 'module' });
  const clock = path.join(app, 'clock.json');
  writeJson(clock, START);
  const callsFile = path.join(app, 'calls.jsonl');
  const fakeAgent = path.join(app, 'fake-agent.mjs');
  fs.writeFileSync(fakeAgent, `
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
export const resolveAgentMode = () => ({ mode: 'headless', reason: 'isolated fixture' });
export const shutdownAgentRuntime = () => {};
export async function runAgent(text, options) {
  const marker = /CASE:([A-Z_]+)/.exec(text)?.[1];
  const id = options.sessionId || 'session-' + randomUUID();
  fs.appendFileSync(process.env.SESSION_TEST_CALLS, JSON.stringify({
    marker, inputSession: options.sessionId, outputSession: id, at: Date.now(),
  }) + '\\n');
  if (marker === 'MODEL_FAILURE' && !options.sessionId) {
    throw Object.assign(new Error('accepted fixture model failure'), { sessionId: id, sessionAccepted: true });
  }
  return { sessionId: id, finalText: 'DONE:' + marker, events: [] };
}
`);
  const loader = path.join(app, 'loader.mjs');
  fs.writeFileSync(loader, `
const original = ${JSON.stringify(pathToFileURL(path.join(app, 'src', 'agent-runner.js')).href)};
const fixture = ${JSON.stringify(pathToFileURL(fakeAgent).href)};
export function resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).href === original) {
    return { url: fixture, shortCircuit: true };
  }
  return next(specifier, context);
}
`);
  const clockImport = path.join(app, 'clock.mjs');
  fs.writeFileSync(clockImport, `
import fs from 'node:fs';
Date.now = () => JSON.parse(fs.readFileSync(process.env.SESSION_TEST_CLOCK, 'utf8'));
`);
  const napcat = createFakeNapCat({ onCall: (call) => call.reply({ message_id: 1 }) });
  const port = await napcat.listen(0);
  const configPath = path.join(app, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}` },
    dsh: {
      command: fakeAgent, mode: 'headless', patchPath: '', cwd: app, permissionMode: 'danger-full-access',
    },
    security: {
      allowFrom: [ADMIN, MEMBER], adminUserIds: [ADMIN], allowGroups: true,
      allowGroupMembers: true, allowGroupIds: [GROUP, GROUP + 1, GROUP + 2], rateLimitPerMinute: 0,
    },
    behavior: { sessionWindowMinutes: 180, groupContextCount: 0, queuedNotice: 'WAIT' },
    memory: { enabled: false, reflectDaily: false },
    persona: { enabled: false }, stickers: { enabled: false }, plugins: { enabled: false },
    stateDir: path.join(app, 'state'), logDir: path.join(app, 'logs'),
  };
  writeJson(configPath, config);
  const sessionsFile = path.join(config.stateDir, 'sessions.json');
  const calls = () => fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const key = (userId = ADMIN, groupId = GROUP, messageType = 'group') =>
    computerSessionKey({ userId, groupId, messageType }, config);
  let child;
  let output = '';
  let bridgeSocket;
  let messageId = 0;
  async function until(predicate, label) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        throw new Error(`Bridge exited: ${output.slice(-3000)}`);
      }
      await delay(25);
    }
    throw new Error(`Timeout: ${label}\n${output.slice(-3000)}`);
  }
  async function start() {
    const connections = napcat.state.connections;
    child = spawn(process.execPath, [
      '--import', pathToFileURL(clockImport).href, '--experimental-loader', pathToFileURL(loader).href,
      path.join(app, 'src', 'index.js'), '--config', configPath,
    ], {
      cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, QQ_CONFIG: configPath, DSH_HOME: path.join(app, 'home'),
        HOME: path.join(app, 'home'), USERPROFILE: path.join(app, 'home'),
        SESSION_TEST_CLOCK: clock, SESSION_TEST_CALLS: callsFile,
      },
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await until(() => napcat.state.connections > connections, 'fixture OneBot connection');
    bridgeSocket = napcat.state.lastSocket;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    killProcessTree(child);
    await closed;
  }
  async function send(marker, { userId = ADMIN, groupId = GROUP, messageType = 'group' } = {}) {
    const start = napcat.state.calls.length;
    const selfId = 10000;
    napcat.state.lastSocket = bridgeSocket;
    napcat.sendJson({
      post_type: 'message', message_type: messageType, self_id: selfId, user_id: userId,
      group_id: groupId, message_id: ++messageId,
      sender: { nickname: 'fixture', user_id: userId },
      message: [{ type: 'at', data: { qq: String(selfId) } }, { type: 'text', data: { text: `CASE:${marker}` } }],
      raw_message: `CASE:${marker}`,
    });
    await until(() => napcat.state.calls.slice(start).some((call) =>
      /send_(group|private)_msg/.test(call.action) &&
      JSON.stringify(call.params.message).includes(marker === 'MODEL_FAILURE' ? 'accepted fixture model failure' : `DONE:${marker}`)),
    `reply for ${marker}`);
    return calls().at(-1);
  }
  try {
    await start();
    const first = await send('FIRST');
    writeJson(clock, START + 90 * MINUTE);
    const second = await send('SECOND');
    writeJson(clock, START + 180 * MINUTE - 1);
    const near = await send('NEAR_BOUNDARY');
    check('the real bridge resumes every turn before the fixed three-hour boundary', () => {
      assert.equal(first.inputSession, null);
      assert.equal(second.inputSession, first.outputSession);
      assert.equal(near.inputSession, first.outputSession);
      assert.equal(readJson(sessionsFile)[key()].startedAt, START);
    });
    writeJson(clock, START + 180 * MINUTE);
    const expired = await send('EXPIRED');
    check('the next turn at the boundary opens exactly one new session', () => {
      assert.equal(expired.inputSession, null);
      assert.notEqual(expired.outputSession, first.outputSession);
    });
    await send('OTHER_GROUP', { groupId: GROUP + 1 });
    await send('MEMBER', { userId: MEMBER });
    await send('PRIVATE', { messageType: 'private' });
    check('group, private, sender and access scopes keep separate mappings', () => {
      const map = readJson(sessionsFile);
      const ids = [key(), key(ADMIN, GROUP + 1), key(MEMBER), key(ADMIN, GROUP, 'private')]
        .map((scope) => map[scope].sessionId);
      assert.equal(new Set(ids).size, ids.length);
    });
    config.behavior.sessionWindowMinutes = 0;
    writeJson(configPath, config);
    writeJson(clock, START + 1000 * MINUTE);
    const unlimited = await send('UNLIMITED');
    check('saving zero takes effect on the next message without restarting', () =>
      assert.equal(unlimited.inputSession, expired.outputSession));
    config.behavior.sessionWindowMinutes = 60;
    writeJson(configPath, config);
    const shortened = await send('SHORTENED');
    check('a shorter saved window immediately expires the old session', () =>
      assert.equal(shortened.inputSession, null));
    const savedStart = readJson(sessionsFile)[key()].startedAt;
    await stop();
    writeJson(clock, START + 1001 * MINUTE);
    await start();
    const restarted = await send('RESTARTED');
    check('bridge restart resumes the same session with its original starting time', () => {
      assert.equal(restarted.inputSession, shortened.outputSession);
      assert.equal(readJson(sessionsFile)[key()].startedAt, savedStart);
    });
    const map = readJson(sessionsFile);
    delete map[key()];
    writeJson(sessionsFile, map);
    const cleared = await send('CLEARED');
    check('an external manual clear takes effect on the very next message', () =>
      assert.equal(cleared.inputSession, null));
    map[key()] = 'session-legacy-fixture';
    writeJson(sessionsFile, map);
    const legacy = await send('LEGACY');
    check('the bridge migrates and resumes a legacy mapping rather than losing it', () => {
      assert.equal(legacy.inputSession, 'session-legacy-fixture');
      assert.equal(readJson(sessionsFile)[key()].startedAt, START + 1001 * MINUTE);
    });
    const failed = await send('MODEL_FAILURE', { groupId: GROUP + 2 });
    const retried = await send('RETRIED', { groupId: GROUP + 2 });
    check('a model error after session creation retains the session for retry', () =>
      assert.equal(retried.inputSession, failed.outputSession));
  } finally {
    await stop();
    await napcat.close();
  }
}

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-session-window-'));
try {
  const units = path.join(temporary, 'units');
  await fsp.mkdir(units);
  storeChecks(units);
  await bridgeChecks(temporary);
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-session-window-'));
  await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`\n通过 ${passed} 项，失败 0 项`);
