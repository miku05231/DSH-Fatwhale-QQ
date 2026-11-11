import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { mountCompanionConsole } from '../src/companion/lib/console-mount.js';
import { createWebUiServer } from '../src/webui/server.mjs';
import { prepareIsolatedHome, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-console-lifecycle-'));
await prepareIsolatedHome(tmp);
const restoreEnv = useIsolatedEnv(tmp);
let passed = 0;
const hosts = [];
function check(label, condition) { assert.ok(condition, label); passed++; console.log(`PASS ${label}`); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function host() {
  const services = new Map(), watchers = [], pending = new Set(), rootEffects = [];
  let closed = false;
  const logs = [];
  const logger = { info(message) { logs.push(message); }, warn(message) { logs.push(message); } };
  function track(promise) { const task = Promise.resolve(promise); pending.add(task); task.finally(() => pending.delete(task)); return task; }
  function context(allowed, effects) {
    return {
      logger,
      get(name) {
        if (!allowed.has(name)) throw new Error(`Service ${name} is not declared in this scope`);
        return services.get(name);
      },
      effect(register) { const dispose = register(); if (typeof dispose === 'function') effects.push(dispose); },
    };
  }
  function reconcile() {
    for (const watcher of watchers) {
      const available = !closed && watcher.names.every(name => services.has(name));
      const values = watcher.names.map(name => services.get(name));
      if (watcher.active && (!available || values.some((value, i) => value !== watcher.values[i]))) {
        const active = watcher.active;
        watcher.active = null;
        track((async () => { for (const dispose of active.effects.reverse()) await dispose(); })());
      }
      if (available && !watcher.active) {
        const effects = [];
        watcher.values = values;
        watcher.active = { effects };
        track(watcher.callback(context(new Set(watcher.names), effects)));
      }
    }
  }
  const ctx = context(new Set(), rootEffects);
  ctx.inject = (names, callback) => { watchers.push({ names, callback, active: null }); reconcile(); };
  const api = {
    ctx, logs,
    provide(name, value) { services.set(name, value); reconcile(); },
    remove(name) { services.delete(name); reconcile(); },
    async flush() { while (pending.size) await Promise.all([...pending]); },
    async dispose() {
      if (closed) return;
      closed = true;
      reconcile();
      for (const dispose of rootEffects.reverse()) await dispose();
      await api.flush();
    },
  };
  hosts.push(api);
  return api;
}

function webServer() {
  const active = new Set();
  let registrations = 0;
  return { active, get registrations() { return registrations; }, register(route) { registrations++; active.add(route); return () => active.delete(route); } };
}
const connection = () => ({ requestRejection() {} });
function fixture({ gate = null, failActivate = false } = {}) {
  const state = { starts: 0, bridgeStops: 0, servers: [], created: deferred() };
  return {
    state,
    options: {
      projectRoot: root, configFile: path.join(tmp, 'absent-config.json'), runMode: 'standalone',
      spawnImpl(_execPath, args) {
        state.starts++;
        state.startOptions = { argv: args.slice(1) };
        const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, killed: false });
        child.kill = () => {
          state.bridgeStops++;
          child.killed = true;
          child.exitCode = 0;
          queueMicrotask(() => child.emit('exit', 0));
          return true;
        };
        return child;
      },
      serverFactory(options) {
        const server = {
          options, control: options.bridgeControl, activates: 0, stops: 0,
          async activate() { server.activates++; state.created.resolve(); if (gate) await gate.promise; if (failActivate) throw new Error('fixture activation failed'); },
          async stop() { server.stops++; },
          async handle(_req, res) { res.end('fixture'); },
        };
        state.servers.push(server);
        return server;
      },
    },
  };
}

try {
  const first = host(), f = fixture(), web1 = webServer();
  const mounted = await mountCompanionConsole(first.ctx, f.options);
  check('headless console does not spawn a standalone bridge', f.state.starts === 0 && !mounted.bridge.status().running);
  await mounted.bridge.start();
  first.provide('webServer', web1);
  await first.flush();
  check('console waits for connection authentication', web1.active.size === 0);
  first.provide('connection', connection());
  await first.flush();
  check('late declared Web services mount the console route', web1.active.size === 1 && mounted.mounted === true);
  check('late Web services preserve the manually started standalone child', f.state.starts === 1 && f.state.servers[0].control === mounted.bridge);
  first.remove('connection');
  await first.flush();
  check('authentication removal unregisters and stops console resources', web1.active.size === 0 && f.state.servers[0].stops === 1);
  check('Web service disposal preserves the shared bridge', f.state.bridgeStops === 0 && mounted.bridge.status().running);
  first.provide('connection', connection());
  await first.flush();
  check('authentication restoration remounts exactly one route', web1.active.size === 1 && f.state.servers.length === 2 && f.state.starts === 1);
  const web2 = webServer();
  first.provide('webServer', web2);
  await first.flush();
  check('Web server replacement removes old route and resources', web1.active.size === 0 && f.state.servers[1].stops === 1 && web2.active.size === 1);
  check('all console generations share the original bridge', f.state.servers.every(server => server.control === mounted.bridge) && f.state.bridgeStops === 0);
  await first.dispose();
  check('plugin disposal stops bridge and every console once', f.state.bridgeStops === 1 && f.state.servers.every(server => server.stops === 1) && web2.active.size === 0);
  first.provide('connection', connection());
  await first.flush();
  check('disposed plugin cannot register routes again', web2.active.size === 0 && f.state.servers.length === 3);

  const slow = host(), gate = deferred(), s = fixture({ gate }), slowWeb = webServer();
  slow.provide('webServer', slowWeb);
  slow.provide('connection', connection());
  const slowMounted = await mountCompanionConsole(slow.ctx, s.options);
  await slowMounted.bridge.start();
  await s.state.created.promise;
  slow.remove('connection');
  gate.resolve();
  await slow.flush();
  check('disposing during activation never registers a stale route', slowWeb.registrations === 0 && s.state.servers[0].stops === 1);
  check('cancelled activation leaves the shared bridge running', s.state.starts === 1 && s.state.bridgeStops === 0 && slowMounted.bridge.status().running);
  await slow.dispose();
  check('cancelled activation resources and bridge stop exactly once', s.state.bridgeStops === 1 && s.state.servers[0].stops === 1);

  const broken = host(), b = fixture({ failActivate: true }), brokenWeb = webServer();
  broken.provide('webServer', brokenWeb);
  broken.provide('connection', connection());
  const brokenMounted = await mountCompanionConsole(broken.ctx, b.options);
  await broken.flush();
  await brokenMounted.bridge.start();
  check('failed activation is contained and closes console resources', brokenWeb.registrations === 0 && b.state.servers[0].stops === 1 && broken.logs.some(text => text.includes('fixture activation failed')));
  check('failed console does not prevent starting the standalone bridge', b.state.starts === 1 && brokenMounted.bridge.status().running);
  await broken.dispose();

  const custom = host(), c = fixture(), customWeb = webServer();
  const dataRoot = path.join(tmp, 'separate-data');
  const customFile = path.join(dataRoot, 'custom.bridge.json');
  const envFile = path.join(dataRoot, 'environment-decoy.json');
  await fs.mkdir(dataRoot);
  await fs.writeFile(customFile, JSON.stringify({ onebot: { url: 'ws://127.0.0.1:9' }, behavior: { sessionWindowMinutes: 31 } }));
  await fs.writeFile(envFile, JSON.stringify({ behavior: { sessionWindowMinutes: 1 } }));
  custom.provide('webServer', customWeb);
  custom.provide('connection', connection());
  const customMounted = await mountCompanionConsole(custom.ctx, { ...c.options, configFile: customFile });
  await customMounted.bridge.start();
  await custom.flush();
  const selected = c.state.servers[0].options;
  check('explicit config resolves console data independently of source root', selected.configRoot === dataRoot && selected.configFile === customFile && selected.config.behavior.sessionWindowMinutes === 31);
  check('standalone child receives the same custom configuration file', c.state.startOptions.argv[1] === customFile);
  await custom.dispose();

  const embeddedHost = host(), embeddedFixture = fixture(), embeddedWeb = webServer();
  let embeddedStarts = 0, embeddedStops = 0;
  const embedded = await mountCompanionConsole(embeddedHost.ctx, {
    ...embeddedFixture.options, runMode: 'embedded', autoStart: true,
    startBridgeImpl: async options => {
      embeddedStarts++;
      assert.equal(options.embedded, true);
      return { status: () => ({ connected: true }), async stop() { embeddedStops++; } };
    },
  });
  check('embedded autoStart runs before Web services arrive without a child', embeddedStarts === 1 && embeddedFixture.state.starts === 0 && embedded.bridge.status().running);
  embeddedHost.provide('webServer', embeddedWeb);
  embeddedHost.provide('connection', connection());
  await embeddedHost.flush();
  check('late Web services reuse the already running embedded controller', embeddedWeb.active.size === 1 && embeddedStarts === 1 && embeddedFixture.state.servers[0].control === embedded.bridge);
  embeddedHost.remove('connection');
  await embeddedHost.flush();
  check('auth revocation removes embedded console while preserving message core', embeddedWeb.active.size === 0 && embeddedStops === 0 && embedded.bridge.status().running);
  embeddedHost.provide('connection', connection());
  await embeddedHost.flush();
  check('auth restoration mounts once without restarting embedded core', embeddedWeb.active.size === 1 && embeddedStarts === 1 && embeddedFixture.state.servers.length === 2);
  await embeddedHost.dispose();
  check('plugin disposal stops embedded core and all console generations once', embeddedStops === 1 && embeddedFixture.state.servers.every(item => item.stops === 1) && embeddedWeb.active.size === 0 && !embedded.bridge.status().running);

  const oldConfig = process.env.QQ_CONFIG;
  process.env.QQ_CONFIG = envFile;
  const server = createWebUiServer({
    configRoot: dataRoot, configFile: 'custom.bridge.json', config: selected.config,
    napcatHealth: { close() {}, async check() { return { state: 'stopped', loggedIn: false, reachable: false }; } },
    updateManager: { async start() {}, stop() {}, async status() { return {}; } },
    platformQrLogin: { async stop() {} },
  });
  try {
    function response() {
      return { code: 0, body: '', writeHead(code) { this.code = code; }, end(body) { this.body = String(body); } };
    }
    function request(method, body = null) {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      return Object.assign(req, { method, url: '/api/settings', headers: { host: '127.0.0.1:5830', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 5830 } });
    }
    const read = response();
    await server.handle(request('GET'), read);
    check('settings identifies the explicit custom file before environment fallback', read.code === 200 && JSON.parse(read.body).data.path === customFile);
    const write = response();
    await server.handle(request('PUT', { behavior: { sessionWindowMinutes: 45 } }), write);
    const saved = JSON.parse(await fs.readFile(customFile, 'utf8'));
    const untouched = JSON.parse(await fs.readFile(envFile, 'utf8'));
    check('settings saves only the explicit custom file', write.code === 200 && saved.behavior.sessionWindowMinutes === 45 && untouched.behavior.sessionWindowMinutes === 1);
    check('custom filename does not create a default config.json', await fs.stat(path.join(dataRoot, 'config.json')).then(() => false, error => error.code === 'ENOENT'));
  } finally {
    await server.stop();
    if (oldConfig === undefined) delete process.env.QQ_CONFIG;
    else process.env.QQ_CONFIG = oldConfig;
  }

  console.log(`${passed}/${passed} lifecycle checks passed`);
} finally {
  for (const item of hosts.reverse()) await item.dispose();
  restoreEnv();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
