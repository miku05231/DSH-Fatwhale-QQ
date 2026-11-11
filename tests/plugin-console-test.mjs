import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWebUiServer } from '../src/webui/server.mjs';
import { consoleRequestTrusted } from '../src/webui/console-guard.mjs';
import { createProxyAssertion } from '../src/webui/proxy-assertion.mjs';
import { createBridgeSupervisor } from '../src/companion/lib/bridge-supervisor.js';
import { mountCompanionConsole, CONSOLE_PREFIX } from '../src/companion/lib/console-mount.js';
import { startBridge } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    return;
  }
  console.log(`  PASS ${label}`);
}

const secret = 'ab'.repeat(32);
const nonceCache = new Map();
const forged = consoleRequestTrusted({
  socket: { remoteAddress: '172.18.0.4', localPort: 5830 },
  headers: { host: '127.0.0.1:5830' },
  method: 'PUT',
  url: '/api/settings',
}, { proxySecret: secret, nonceCache, passwordHash: secret });
check('a forged Host from another container is not trusted', forged.ok === false);

const assertion = createProxyAssertion(secret, { method: 'PUT', url: '/api/settings', host: 'nas.local:5830' });
const gateway = consoleRequestTrusted({
  socket: { remoteAddress: '172.18.0.4', localPort: 5830 },
  headers: { host: 'nas.local:5830', 'x-qq-console-assertion': assertion },
  method: 'PUT',
  url: '/api/settings',
}, { proxySecret: secret, nonceCache, passwordHash: secret });
check('a gateway assertion is trusted without trusting Host alone', gateway.ok === true && gateway.via === 'gateway');

const loopback = consoleRequestTrusted({
  socket: { remoteAddress: '127.0.0.1', localPort: 5830 },
  headers: { host: '127.0.0.1:5830' },
  method: 'GET',
  url: '/api/settings',
}, { proxySecret: secret, nonceCache });
check('loopback with a matching Host is trusted', loopback.ok === true);

const script = path.join(os.tmpdir(), `qq-bridge-supervisor-${process.pid}.mjs`);
fs.writeFileSync(script, `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n`);
const supervisor = createBridgeSupervisor({
  projectRoot: root,
  spawnImpl: (exec, args, options) => spawn(exec, [script], options),
});
const started = supervisor.start();
check('supervisor reports a running child', started.running === true && started.pid > 0);
const stopped = await supervisor.stop();
check('supervisor stops the child', stopped.running === false && stopped.pid === 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-console-'));
const bridgeActions = [];
let bridgeStartFails = false;
const bridge = {
  async start() { bridgeActions.push('start'); return { running: !bridgeStartFails, pid: bridgeStartFails ? 0 : 42, projectRoot: root, ...(bridgeStartFails ? { lastError: 'fixture start failed' } : {}) }; },
  async stop() { bridgeActions.push('stop'); return { running: false, pid: 0, projectRoot: root }; },
  status() { return { running: false, pid: 0, projectRoot: root }; },
};
const server = createWebUiServer({
  configRoot: tmp,
  config: {},
  host: '127.0.0.1',
  port: 0,
  publicBase: CONSOLE_PREFIX,
  bridgeControl: bridge,
  napcatHealth: { async check() { return { state: 'stopped', loggedIn: false, reachable: false }; }, close() {} },
  platformQrLogin: { async stop() {} },
  updateManager: { async start() {}, stop() {}, async status() { return { automatic: false, phase: 'idle' }; } },
});
await server.activate();
const routes = [];
const ctx = {
  logger: { info() {}, warn() {} },
  get(name) {
    if (name === 'webServer') return { register(route) { routes.push(route); return () => {}; } };
    if (name === 'connection') return { requestRejection() { return undefined; } };
    throw new Error(name);
  },
  effect() {},
};
const mounted = await mountCompanionConsole(ctx, {
  projectRoot: root,
  supervisor: bridge,
  serverFactory: () => server,
});
check('console mounts on the DSH prefix', mounted.mounted === true && routes[0]?.path === CONSOLE_PREFIX);

const rejected = [];
const blocking = {
  logger: { info() {}, warn() {} },
  get(name) {
    if (name === 'webServer') return { register(route) { rejected.push(route); return () => {}; } };
    if (name === 'connection') return { requestRejection() { return 401; } };
    throw new Error(name);
  },
  effect() {},
};
await mountCompanionConsole(blocking, { projectRoot: root, supervisor: bridge, serverFactory: () => server });
const res = fakeResponse();
await rejected[0].handler(fakeRequest('/qq-bridge/api/settings', { cookie: '' }), res);
check('plugin route rejects a DSH session that the host refuses', res.status === 401);

const openRes = fakeResponse();
await routes[0].handler(fakeRequest('/qq-bridge/api/bridge', {}), openRes);
check('an admitted plugin request can read bridge status', openRes.status === 200 && JSON.parse(openRes.body).data.running === false);

const startRes = fakeResponse();
await routes[0].handler({ ...fakeRequest('/qq-bridge/api/bridge/start', {}), method: 'POST' }, startRes);
check('bridge start resolves the asynchronous embedded status', startRes.status === 200
  && JSON.parse(startRes.body).data.running === true && JSON.parse(startRes.body).data.pid === 42);

for (const [action, expected] of [['start', ['start']], ['stop', ['stop']], ['restart', ['stop', 'start']]]) {
  bridgeActions.length = 0;
  const response = fakeResponse();
  await routes[0].handler({ ...fakeRequest(`/qq-bridge/api/service/bridge/${action}`, {}), method: 'POST' }, response);
  check(`legacy bridge ${action} uses the shared controller without ProcessControl`, response.status === 200
    && JSON.stringify(bridgeActions) === JSON.stringify(expected)
    && JSON.parse(response.body).data.running === (action !== 'stop'));
}
bridgeStartFails = true;
const failedLegacyStart = fakeResponse();
await routes[0].handler({ ...fakeRequest('/qq-bridge/api/service/bridge/start', {}), method: 'POST' }, failedLegacyStart);
check('legacy bridge start reports embedded startup failure', failedLegacyStart.status === 500
  && JSON.parse(failedLegacyStart.body).error.includes('fixture start failed'));
bridgeStartFails = false;

const page = fakeResponse();
await routes[0].handler(fakeRequest('/qq-bridge/', {}), page);
check('admitted plugin page exposes inert console base metadata', page.status === 200
  && page.body.includes('<meta name="qq-bridge-base" content="/qq-bridge" />'));
check('plugin page needs no inline base initializer', !page.body.includes('__QQ_BRIDGE_BASE__')
  && /(?:^|;)\s*script-src\s+'self'\s*(?:;|$)/.test(page.headers['content-security-policy']));
check('plugin page does not widen framing', page.headers['x-frame-options'] === 'SAMEORIGIN'
  && String(page.headers['content-security-policy']).includes("frame-ancestors 'self'"));

const escapedServer = createWebUiServer({ configRoot: tmp, config: {}, publicBase: '/qq&"<>-bridge' });
const escapedPage = fakeResponse();
await escapedServer.handle(fakeRequest('/', {}), escapedPage);
check('base metadata escapes HTML attribute delimiters', escapedPage.body.includes(
  '<meta name="qq-bridge-base" content="/qq&amp;&quot;&lt;&gt;-bridge" />'));
check('asset URLs use the same escaped base', escapedPage.body.includes(
  'src="/qq&amp;&quot;&lt;&gt;-bridge/app.js"'));
await escapedServer.stop();

for (const [base, escapedBase] of [
  ['/qq$&-bridge', '/qq$&amp;-bridge'],
  ["/qq$'-bridge", "/qq$'-bridge"],
  ['/qq$`-bridge', '/qq$`-bridge'],
]) {
  const literalServer = createWebUiServer({ configRoot: tmp, config: {}, publicBase: base });
  const literalPage = fakeResponse();
  await literalServer.handle(fakeRequest('/', {}), literalPage);
  check(`replacement tokens stay literal in base ${base}`, literalPage.body.includes(
    `<meta name="qq-bridge-base" content="${escapedBase}" />`)
    && literalPage.body.includes(`src="${escapedBase}/app.js"`)
    && literalPage.body.includes(`href="${escapedBase}/`));
  await literalServer.stop();
}

const forgedWrite = fakeResponse();
const forgedRequest = fakeRequest('/api/settings', { host: '127.0.0.1:3080' });
forgedRequest.method = 'PUT';
forgedRequest.socket = { remoteAddress: '172.18.0.4', localPort: 3080 };
await server.handle(forgedRequest, forgedWrite);
check('non-loopback settings write is refused even with a local Host', forgedWrite.status === 401 || forgedWrite.status === 403);

const cross = fakeResponse();
await routes[0].handler(fakeRequest('/qq-bridge/api/settings', { 'sec-fetch-site': 'cross-site' }), cross);
check('cross-site plugin requests are refused', cross.status === 403);

globalThis.window = {
  __ModuleLoader__: { load(registration) { globalThis.__captured = registration; } },
};
await import('../src/companion/lib/client.js');
const client = globalThis.__captured.factory((id) => {
  if (id !== 'react') throw new Error(id);
  return { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {}, useState: (value) => [value, () => {}] };
});
const slots = [];
client.apply({
  slots: {
    inject(_name, register) { register(); },
    register(spec) { slots.push(spec); },
  },
});
check('client registers the bundle config under the package name', slots[0]?.key === 'qq-bridge-companion');

const imported = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./src/index.js'); console.log('imported')"], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 4000);
  child.once('exit', (code) => { clearTimeout(timer); resolve(`${code}:${out.trim()}`); });
});
check('importing the bridge does not start it', imported === '0:imported');

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-start-bridge-'));
const configFile = path.join(configDir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  onebot: { url: 'ws://127.0.0.1:9', accessToken: '' },
  security: { allowFrom: [] },
  behavior: { sessionWindowMinutes: 30 },
}));
const handle = await startBridge({ argv: ['--config', configFile], embedded: true });
check('embedded start returns a stop handle', typeof handle?.stop === 'function');
await handle.stop();
check('embedded stop does not request process exit', process.exitCode === undefined || process.exitCode === 0);
assert.equal(path.dirname(configDir), os.tmpdir());
fs.rmSync(configDir, { recursive: true, force: true });

function fakeRequest(url, headers) {
  return {
    url,
    method: 'GET',
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress: '127.0.0.1', localPort: 3080 },
  };
}
function fakeResponse() {
  const response = { status: 0, headers: {}, body: '' };
  response.writeHead = (status, headers) => { response.status = status; response.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])); };
  response.end = (body) => { response.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''); };
  return response;
}

await server.stop();
fs.rmSync(script, { force: true });
assert.equal(path.dirname(tmp), os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`${failed} failed`);
  process.exitCode = 1;
} else {
  console.log('plugin console checks passed');
}
