// Embedded bridge: the companion starts the message core in-process, contains
// faults, and defaults to the standalone child process.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { OneBot } from '../src/onebot.js';
import { resolveBridgeRunMode } from '../src/bridge-run-mode.js';
import { createInProcessAgentRuntime } from '../src/companion/lib/in-process-agent.js';
import { createEmbeddedBridge } from '../src/companion/lib/embedded-bridge.js';
import { apply as applyCompanion } from '../src/companion/lib/index.js';
import { prepareIsolatedHome, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';
import { createFakeNapCat } from './ws-harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-embedded-bridge-'));
await prepareIsolatedHome(tmp);
const restoreEnv = useIsolatedEnv(tmp);
const adminId = 10001;
let failed = 0;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function check(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    return;
  }
  console.log(`  PASS ${label}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await wait(30);
  }
  throw new Error(`${label} 超时：${String(last)}`);
}

function writeConfig(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function baseConfig(url) {
  return {
    onebot: { url, accessToken: '' },
    bridge: { runMode: 'embedded' },
    dsh: {
      command: path.join(tmp, 'dsh-missing'),
      mode: 'headless',
      companion: false,
      patchPath: '',
      permissionMode: 'danger-full-access',
    },
    security: { allowFrom: [adminId], adminUserIds: [adminId] },
    memory: { enabled: false, reflectDaily: false },
    stickers: { enabled: false },
    plugins: { enabled: false },
    persona: { enabled: false },
    behavior: { showErrors: true },
  };
}

function host({ calls, failTimes = 0 } = {}) {
  const disposers = [];
  const routes = [];
  const events = [];
  const session = { seq: 0, eventAt: (seq) => events[seq] };
  const agent = { status: 'idle', session, whenIdle: async () => {} };
  let remainingFailures = failTimes;
  const services = {
    sessionController: {
      async create() {
        calls.created += 1;
        return { sessionId: 'embedded-session' };
      },
      async prompt() {
        calls.prompted += 1;
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('handler-boom');
        }
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'stub-reply' }] } },
        });
        session.seq = events.length;
      },
      cancel() { calls.cancelled += 1; },
    },
    workspaceRegistry: { list: () => [] },
    sessionQuery: { async observeSession() { throw new Error('none'); } },
    agents: { get: () => agent },
    llm: { resolveCallConfig: async (model) => model },
    sessions: { async flush() { calls.flushed += 1; } },
    permissionPresets: {
      names: ['read-only', 'workspace-write', 'danger-full-access'],
      resolve(mode) {
        return { sandbox: mode, approval: mode === 'danger-full-access' ? 'never' : 'ask' };
      },
      async set() {},
      current: () => 'danger-full-access',
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    connection: { requestRejection() { return undefined; } },
  };
  return {
    routes,
    ctx: {
      logger: { info() {}, warn(message) { calls.warnings.push(String(message)); }, error() {} },
      get(name) {
        if (!Object.hasOwn(services, name)) throw new Error(`missing ${name}`);
        return services[name];
      },
      effect(register) { disposers.push(register()); },
    },
    async dispose() {
      const pending = disposers.splice(0).reverse();
      for (const dispose of pending) {
        try { await dispose(); } catch { /* 停掉失败也继续清下一个 */ }
      }
    },
  };
}

function serverFactory(options) {
  return {
    async activate() {},
    async handle(req, res) {
      const url = String(req.url || '/');
      const control = options?.bridgeControl;
      if (url.startsWith('/api/bridge') && control) {
        const data = url.includes('/stop') ? await control.stop()
          : url.includes('/start') ? await control.start()
          : control.status();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('console');
    },
  };
}

async function readHealth(discoveryPath) {
  const info = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
    headers: { authorization: `Bearer ${info.token}` },
  });
  return response.json();
}

const previousExit = process.exitCode;
process.exitCode = undefined;

check('runtime home stays inside the temp directory', os.homedir().startsWith(tmp) && String(process.env.DSH_HOME).startsWith(tmp));
check('switch defaults to standalone', resolveBridgeRunMode({}, {}) === 'standalone');
check('plugin runMode wins over the config file', resolveBridgeRunMode(
  { runMode: 'standalone' },
  { bridge: { runMode: 'embedded' } },
) === 'standalone');
check('config file selects embedded when the plugin does not', resolveBridgeRunMode(
  {},
  { bridge: { runMode: 'embedded' } },
) === 'embedded');
check('plugin embedded overrides standalone config', resolveBridgeRunMode(
  { runMode: 'embedded' }, { bridge: { runMode: 'standalone' } },
) === 'embedded');

{
  const dir = path.join(tmp, 'defaults');
  writeConfig(dir, {});
  const loaded = loadConfig(dir, { createIfMissing: false });
  check('loaded config defaults bridge.runMode to standalone', loaded.config.bridge.runMode === 'standalone');
  writeConfig(dir, { bridge: { runMode: 'nope' } });
  check('invalid bridge.runMode is rejected', (() => {
    try { loadConfig(dir, { createIfMissing: false }); return false; } catch (error) { return /bridge\.runMode/.test(String(error)); }
  })());
}

{
  const calls = { prompt: 0, chat: 0, body: null, abort: null, chatOptions: null };
  const runtime = createInProcessAgentRuntime({
    prompt: async (body, abort) => { calls.prompt += 1; calls.body = body; calls.abort = abort; return { sessionId: 's', text: 'admin-text', model: { provider: 'fixture', model: 'fixture-model' } }; },
    runChatOnly: async (_text, options) => { calls.chat += 1; calls.chatOptions = options; return { sessionId: 'qq-chat-1', finalText: 'chat-text' }; },
    isAdmin: (userId, cfg) => cfg?.security?.adminUserIds?.includes(Number(userId)) === true,
  });
  const admin = await runtime.run('hi', { requesterId: adminId, cfg: { security: { adminUserIds: [adminId] }, dsh: { permissionMode: 'workspace-write' } } });
  check('admin turn uses the in-process prompt', admin.finalText === 'admin-text' && calls.prompt === 1 && calls.chat === 0);
  const member = await runtime.run('hi', { requesterId: 10002, cfg: { security: { adminUserIds: [adminId] } } });
  check('non-admin turn stays on the chat-only function', member.finalText === 'chat-text' && calls.chat === 1 && calls.prompt === 1);
  const source = new AbortController();
  const options = { requesterId: adminId, sessionId: 'previous', cwd: tmp, model: { provider: 'fixture', model: 'fixture-model' }, timeoutMs: 1000, signal: source.signal, cfg: { security: { adminUserIds: [adminId] }, dsh: { permissionMode: 'read-only' } } };
  const forwarded = await runtime.run('admin details', options);
  check('admin call forwards host session workspace model permission and timeout', calls.body.text === 'admin details' && calls.body.sessionId === 'previous' && calls.body.cwd === tmp && calls.body.workspacePath === tmp && calls.body.permissionMode === 'read-only' && calls.body.timeoutMs === 1000 && forwarded.model.model === 'fixture-model');
  source.abort();
  check('completed admin call removes its external abort listener', calls.abort.signal.aborted === false);
  const aborted = new AbortController(); aborted.abort();
  await runtime.run('already cancelled', { ...options, signal: aborted.signal });
  check('already aborted admin call passes cancellation to host', calls.abort.signal.aborted === true);
  const ordinaryOptions = { requesterId: 10002, sessionId: 'ordinary-isolated', cfg: { security: { adminUserIds: [adminId] } }, signal: aborted.signal };
  await runtime.run('member', ordinaryOptions);
  check('ordinary member uses the original isolated chat-only options', calls.chatOptions === ordinaryOptions && calls.prompt === 3 && calls.chat === 2);
}

{
  const broken = createEmbeddedBridge({ projectRoot: tmp, startBridgeImpl() { throw new Error('sync-start-fixture'); } });
  const bad = await broken.start();
  check('synchronous start failure returns stopped status without rejecting', bad.running === false && /sync-start-fixture/.test(bad.lastError));
  await broken.stop();

  let starts = 0, stops = 0;
  const stopGate = deferred();
  const idle = createEmbeddedBridge({ projectRoot: tmp, startBridgeImpl: async () => {
    starts++;
    return { status: () => ({ connected: true }), async stop() { stops++; if (stops === 1) await stopGate.promise; } };
  } });
  await idle.stop(); await idle.stop();
  await Promise.all([idle.start(), idle.start(), idle.start()]);
  check('idle stop permits later concurrent starts with one handle', starts === 1 && idle.status().running === true);
  let stoppedA = false, stoppedB = false;
  const stopA = idle.stop().then(() => { stoppedA = true; });
  const stopB = idle.stop().then(() => { stoppedB = true; });
  await waitFor('one stop begins', () => stops === 1);
  check('concurrent stops both wait for the same cleanup', !stoppedA && !stoppedB && !idle.status().running);
  stopGate.resolve(); await Promise.all([stopA, stopB]);
  check('concurrent stop cleans the shared handle exactly once', stops === 1 && stoppedA && stoppedB && idle.status().pid === 0);
  await idle.start(); await idle.stop();
  check('stopped embedded controller can reload and stop again', starts === 2 && stops === 2 && !idle.status().running);

  const startGate = deferred(); let lateStarts = 0, lateStops = 0, cancelledDone = false;
  const late = createEmbeddedBridge({ projectRoot: tmp, startBridgeImpl: async () => {
    lateStarts++; await startGate.promise;
    return { status: () => ({ connected: true }), async stop() { lateStops++; } };
  } });
  const starting = late.start();
  await waitFor('late start begins', () => lateStarts === 1);
  const cancelled = late.stop().then(() => { cancelledDone = true; });
  await wait(20);
  check('stop during pending startup waits for its returned handle', !cancelledDone);
  startGate.resolve(); await Promise.all([starting, cancelled]);
  check('cancelled startup cleans a late handle without publishing running status', lateStops === 1 && !late.status().running && late.status().pid === 0);
}

const napcat = createFakeNapCat();
const napcatPort = await napcat.listen();
const spawns = [];
function spawnImpl() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0);
  };
  spawns.push(child);
  return child;
}

try {
  const standaloneDir = path.join(tmp, 'standalone');
  const standaloneFile = writeConfig(standaloneDir, {
    ...baseConfig(`ws://127.0.0.1:${napcatPort}`),
    bridge: { runMode: 'standalone' },
  });
  const standaloneCalls = { created: 0, prompted: 0, flushed: 0, cancelled: 0, warnings: [] };
  const standalone = host({ calls: standaloneCalls });
  const standaloneDiscovery = path.join(standaloneDir, 'discovery.json');
  await applyCompanion(standalone.ctx, {
    projectRoot: standaloneDir,
    configFile: standaloneFile,
    discoveryPath: standaloneDiscovery,
    spawnImpl,
    serverFactory,
  });
  await wait(400);
  check('standalone mode does not open a OneBot socket', napcat.liveCount() === 0 && napcat.state.connections === 0);
  check('standalone mode does not spawn until the console starts it', spawns.length === 0);
  const standaloneHealth = await readHealth(standaloneDiscovery);
  check('health reports standalone while the core is stopped', standaloneHealth.bridge?.mode === 'standalone' && standaloneHealth.bridge?.running === false);
  await standalone.dispose();

  const overrideDir = path.join(tmp, 'override');
  const overrideFile = writeConfig(overrideDir, baseConfig(`ws://127.0.0.1:${napcatPort}`));
  let starts = 0;
  const overrideCalls = { created: 0, prompted: 0, flushed: 0, cancelled: 0, warnings: [] };
  const override = host({ calls: overrideCalls });
  await applyCompanion(override.ctx, {
    projectRoot: overrideDir,
    configFile: overrideFile,
    runMode: 'standalone',
    discoveryPath: path.join(overrideDir, 'discovery.json'),
    spawnImpl,
    startBridgeImpl: async () => { starts += 1; return { stop() {}, status: () => ({ running: true }) }; },
    serverFactory,
  });
  await wait(200);
  check('plugin runMode standalone overrides an embedded config file', starts === 0 && napcat.liveCount() === 0);
  await override.dispose();

  const closed = createFakeNapCat();
  const closedPort = await closed.listen();
  await closed.close();
  const closedDir = path.join(tmp, 'closed');
  const closedFile = writeConfig(closedDir, baseConfig(`ws://127.0.0.1:${closedPort}`));
  const closedCalls = { created: 0, prompted: 0, flushed: 0, cancelled: 0, warnings: [] };
  const closedHost = host({ calls: closedCalls });
  await applyCompanion(closedHost.ctx, {
    projectRoot: closedDir,
    configFile: closedFile,
    discoveryPath: path.join(closedDir, 'discovery.json'),
    spawnImpl,
    serverFactory,
  });
  const closedHealth = await waitFor('closed napcat health', async () => {
    const body = await readHealth(path.join(closedDir, 'discovery.json'));
    return body.bridge?.running === true ? body : null;
  });
  check('a down NapCat does not stop the host', closedHealth.bridge.running === true && closedHealth.bridge.mode === 'embedded' && closedHealth.bridge.connected === false);
  check('a down NapCat does not set the process exit code', process.exitCode === undefined || process.exitCode === 0);
  await closedHost.dispose();
  const revived = createFakeNapCat();
  await revived.listen(closedPort);
  await wait(1500);
  check('stopping the plugin cancels NapCat reconnect', revived.liveCount() === 0 && revived.state.connections === 0);
  await revived.close();

  const badDir = path.join(tmp, 'bad-config');
  const badFile = writeConfig(badDir, { bridge: { runMode: 'embedded' }, onebot: { url: 'http://127.0.0.1:9' } });
  const badCalls = { created: 0, prompted: 0, flushed: 0, cancelled: 0, warnings: [] };
  const badHost = host({ calls: badCalls });
  let badThrew = false;
  try {
    await applyCompanion(badHost.ctx, {
      projectRoot: badDir,
      configFile: badFile,
      discoveryPath: path.join(badDir, 'discovery.json'),
      spawnImpl,
      serverFactory,
    });
  } catch {
    badThrew = true;
  }
  const badHealth = await readHealth(path.join(badDir, 'discovery.json'));
  check('bad config stays inside the plugin', badThrew === false && badHealth.bridge?.running === false && /ws/.test(String(badHealth.bridge?.lastError)));
  check('bad config does not request process exit', process.exitCode === undefined || process.exitCode === 0);
  await badHost.dispose();

  const smokeDir = path.join(tmp, 'smoke');
  const smokeFile = writeConfig(smokeDir, baseConfig(`ws://127.0.0.1:${napcatPort}`));
  const smokeCalls = { created: 0, prompted: 0, flushed: 0, cancelled: 0, warnings: [] };
  const smoke = host({ calls: smokeCalls, failTimes: 1 });
  const smokeDiscovery = path.join(smokeDir, 'discovery.json');
  await applyCompanion(smoke.ctx, {
    projectRoot: smokeDir,
    configFile: smokeFile,
    discoveryPath: smokeDiscovery,
    workspacePath: smokeDir,
    spawnImpl,
    serverFactory,
  });
  await waitFor('first socket', async () => napcat.liveCount() === 1);
  check('embedded mode opens one OneBot connection and no child process', napcat.liveCount() === 1 && spawns.length === 0);
  const bridgeSocket = napcat.state.lastSocket;
  const health = await readHealth(smokeDiscovery);
  check('health shows the embedded core', health.bridge?.mode === 'embedded' && health.bridge?.running === true && health.ok === true);
  const bridgeRoute = smoke.routes.find((route) => route.path === '/qq-bridge');
  const bridgeResponse = fakeResponse();
  await bridgeRoute.handler(fakeRequest('/qq-bridge/api/bridge'), bridgeResponse);
  const bridgeBody = JSON.parse(bridgeResponse.body);
  check('plugin console can read embedded bridge status', bridgeResponse.status === 200
    && bridgeBody.data?.mode === 'embedded' && bridgeBody.data?.running === true);

  const probe = new OneBot({
    url: `ws://127.0.0.1:${napcatPort}`,
    reconnect: false,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('later OneBot client timed out')), 4000);
      probe.once('ready', () => { clearTimeout(timer); resolve(); });
      probe.once('error', (error) => { clearTimeout(timer); reject(error); });
      probe.connect();
    });
    check('a later OneBot client stays connected beside the bridge', napcat.liveCount() === 2);
    napcat.state.lastSocket = bridgeSocket;
    napcat.sendPrivateMessage({ userId: adminId, text: 'hello embedded' });
    await waitFor('error reply', async () => napcat.state.calls.some((call) => call.action === 'send_private_msg' && String(call.params?.message).includes('handler-boom')));
    check('inbound injection still reaches the bridge', napcat.state.calls.some((call) => String(call.params?.message).includes('handler-boom')));
  } finally {
    probe.close();
  }
  await waitFor('probe socket closed', async () => napcat.liveCount() === 1);
  check('a thrown handler is contained and reported', napcat.liveCount() === 1 && process.exitCode !== 1);
  napcat.sendPrivateMessage({ userId: adminId, text: 'hello again', messageId: 2 });
  await waitFor('stub reply', async () => napcat.state.calls.some((call) => call.action === 'send_private_msg' && String(call.params?.message).includes('stub-reply')));
  check('inbound message reaches the in-process DSH stub and is sent back', smokeCalls.prompted === 2 && smokeCalls.created >= 1);
  check('embedded smoke never spawned the standalone bridge', spawns.length === 0);

  await smoke.dispose();
  await waitFor('sockets closed', async () => napcat.liveCount() === 0);
  check('dispose closes the OneBot socket', napcat.liveCount() === 0);

  const reloaded = host({ calls: smokeCalls });
  await applyCompanion(reloaded.ctx, {
    projectRoot: smokeDir,
    configFile: smokeFile,
    discoveryPath: path.join(smokeDir, 'reload-discovery.json'),
    workspacePath: smokeDir,
    spawnImpl,
    serverFactory,
  });
  await waitFor('reloaded socket', async () => napcat.liveCount() === 1);
  check('reload keeps a single OneBot connection', napcat.liveCount() === 1 && spawns.length === 0);
  await reloaded.dispose();
  await waitFor('reload sockets closed', async () => napcat.liveCount() === 0);
  check('second dispose closes the socket again', napcat.liveCount() === 0);

  const { startBridge } = await import('../src/index.js');
  const activeDir = path.join(tmp, 'active-stop');
  const activeFile = writeConfig(activeDir, baseConfig(`ws://127.0.0.1:${napcatPort}`));
  const replyGate = deferred(), shutdownGate = deferred();
  let activeRuns = 0, activeAborts = 0, runtimeStops = 0, stopFinishedA = false, stopFinishedB = false;
  const signalCounts = Object.fromEntries(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map(name => [name, process.listenerCount(name)]));
  const activeCore = await startBridge({
    argv: ['--config', activeFile], embedded: true,
    agentRuntime: {
      async run(_text, options) {
        activeRuns++;
        options.signal.addEventListener('abort', () => { activeAborts++; }, { once: true });
        await replyGate.promise;
        return { sessionId: 'late-session', finalText: 'late synthetic reply' };
      },
      async shutdown() { runtimeStops++; await shutdownGate.promise; },
    },
  });
  try {
    await waitFor('active core socket', () => napcat.liveCount() === 1);
    napcat.sendPrivateMessage({ userId: adminId, text: 'active stop fixture', messageId: 100 });
    await waitFor('active runtime request', () => activeRuns === 1);
    const stopA = activeCore.stop().then(() => { stopFinishedA = true; });
    const stopB = activeCore.stop().then(() => { stopFinishedB = true; });
    await waitFor('runtime shutdown begins', () => runtimeStops === 1);
    check('core stop aborts its active turn and immediately clears connected status', activeAborts === 1 && activeCore.status().connected === false && activeCore.status().pid === 0);
    check('repeated core stops wait for the same complete shutdown', !stopFinishedA && !stopFinishedB && runtimeStops === 1);
    shutdownGate.resolve(); await Promise.all([stopA, stopB]);
    const stoppedFile = path.join(activeDir, 'state', 'status.json');
    check('core shutdown writes a stopped status after cleanup', JSON.parse(fs.readFileSync(stoppedFile, 'utf8')).pid === 0 && runtimeStops === 1 && stopFinishedA && stopFinishedB);
    replyGate.resolve(); await wait(150);
    const afterLate = JSON.parse(fs.readFileSync(stoppedFile, 'utf8'));
    check('late request completion cannot resurrect stopped status', afterLate.pid === 0 && afterLate.connected === false && napcat.liveCount() === 0);
    check('embedded core leaves host exit and signal handlers unchanged', Object.entries(signalCounts).every(([name, count]) => process.listenerCount(name) === count) && process.exitCode !== 1);
  } finally {
    shutdownGate.resolve(); replyGate.resolve(); await activeCore.stop();
  }
} finally {
  await napcat?.close?.().catch(() => {});
  restoreEnv();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

if (previousExit !== undefined) process.exitCode = previousExit;
if (failed) {
  console.error(`${failed} failed`);
  process.exitCode = 1;
} else {
  console.log('embedded bridge checks passed');
}

function fakeRequest(url) {
  return {
    url,
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1', localPort: 3080 },
  };
}
function fakeResponse() {
  const response = { status: 0, headers: {}, body: '' };
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers || {};
  };
  response.end = (body) => { response.body = String(body ?? ''); };
  return response;
}
