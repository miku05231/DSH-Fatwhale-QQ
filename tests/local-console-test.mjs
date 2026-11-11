import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLocalConsole, CONSOLE_PAGES } from '../src/companion/lib/local-console.js';
import { openLocalConsoleUrl } from '../src/companion/lib/browser-opener.js';
import { createWebUiServer } from '../src/webui/server.mjs';
import { mountCompanionConsole } from '../src/companion/lib/console-mount.js';

let passed = 0;
async function check(label, test) {
  await test();
  passed += 1;
  console.log(`  PASS ${label}`);
}
let clock = 1000;
const opened = [];
let handled = 0;
const local = createLocalConsole({
  now: () => clock,
  openBrowser: async url => opened.push(new URL(url)),
  handle(req, res) {
    handled += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }));
  },
});
let apiServer;
let consoleServer;
let tmp;
const originFor = url => url.origin;
const grantFor = url => new URLSearchParams(url.hash.slice(1)).get('grant');
const exchange = (url, body = { grant: grantFor(url) }, extra = {}) => fetch(`${url.origin}/qq-bridge/api/console/session`, {
  method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});
try {
  await check('only canonical page identifiers can be opened', async () => {
    for (const page of ['https://example.com', '../system', 'memes', '', null]) {
      await assert.rejects(local.open(page), /未知控制台页面/);
    }
    assert.equal(opened.length, 0);
    assert.equal(CONSOLE_PAGES.length, 9);
  });
  await check('opening is lazy and uses an ephemeral IPv4 loopback listener', async () => {
    assert.deepEqual(await local.open('model'), { opened: true });
    assert.equal(opened[0].hostname, '127.0.0.1');
    assert.ok(Number(opened[0].port) > 0);
    assert.equal(opened[0].pathname, '/qq-bridge/auth');
    assert.equal(opened[0].search, '');
    assert.match(grantFor(opened[0]), /^[A-Za-z0-9_-]{43}$/);
  });
  const first = opened[0];
  await check('the bootstrap is strict-CSP and never returns the fragment grant', async () => {
    const response = await fetch(first);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
    assert.match(html, /type="module" src="\.\/console-auth.js"/);
    assert.ok(!html.includes(grantFor(first)));
    const script = await (await fetch(`${first.origin}/qq-bridge/console-auth.js`)).text();
    assert.ok(script.indexOf('history.replaceState') < script.indexOf('await fetch'));
    assert.match(script, /mode=full#/);
  });
  await check('HTML, static resources, and all APIs require the browser cookie', async () => {
    for (const route of ['/', '/app.js', '/api/overview', '/api/settings']) {
      const response = await fetch(`${first.origin}/qq-bridge${route}`);
      assert.equal(response.status, 401);
    }
    assert.equal(handled, 0);
  });
  await check('forged Host and cross-port/cross-site exchanges are rejected', async () => {
    for (const headers of [{ host: 'evil.invalid' }, { origin: 'http://127.0.0.1:1' }, { 'sec-fetch-site': 'cross-site' }]) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request(`${first.origin}/qq-bridge/api/console/session`, {
          method: 'POST', headers: { origin: first.origin, 'content-type': 'application/json', ...headers },
        }, response => { response.resume(); resolve(response.statusCode); });
        request.once('error', reject);
        request.end(JSON.stringify({ grant: grantFor(first) }));
      });
      assert.equal(status, 403, Object.keys(headers).join(','));
    }
    assert.equal((await fetch(`${first.origin}/qq-bridge/api/console/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: grantFor(first) }),
    })).status, 403);
  });
  await check('malformed grant exchange does not authenticate', async () => {
    assert.equal((await exchange(first, { grant: grantFor(first), url: 'https://example.com' })).status, 401);
    assert.equal((await exchange(first, { grant: 'wrong' })).status, 401);
  });
  let cookie;
  await check('a one-use grant yields a port-scoped HttpOnly Strict cookie', async () => {
    const response = await exchange(first);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { page: 'model' } });
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`^qq_bridge_console_${first.port}=`));
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/qq-bridge; Max-Age=28800/);
    assert.doesNotMatch(setCookie, /Domain=/);
    cookie = setCookie.split(';')[0];
    assert.equal((await exchange(first)).status, 401);
  });
  await check('authorized requests reuse the original console handler with a stripped prefix', async () => {
    const response = await fetch(`${first.origin}/qq-bridge/api/overview?lines=8`, { headers: { cookie } });
    assert.deepEqual(await response.json(), { ok: true, url: '/api/overview?lines=8', method: 'GET' });
    assert.equal(handled, 1);
  });
  await check('session cookies do not bypass cross-origin write protection', async () => {
    for (const origin of [undefined, 'http://127.0.0.1:1', 'https://example.com', 'null']) {
      const headers = { cookie };
      if (origin !== undefined) headers.origin = origin;
      const response = await fetch(`${first.origin}/qq-bridge/api/bridge/start`, { method: 'POST', headers });
      assert.equal(response.status, 403);
    }
    const response = await fetch(`${first.origin}/qq-bridge/api/bridge/start`, { method: 'POST', headers: { cookie, origin: first.origin } });
    assert.equal(response.status, 200);
  });
  await check('repeated opens reuse the listener but issue different grants', async () => {
    await Promise.all([local.open('persona'), local.open('stickers')]);
    assert.ok(opened.slice(1).every(url => originFor(url) === first.origin));
    assert.notEqual(grantFor(opened[1]), grantFor(opened[2]));
  });
  await check('grants expire at 60 seconds and sessions at eight hours', async () => {
    clock += 60_000;
    assert.equal((await exchange(opened[1])).status, 401);
    clock += 8 * 60 * 60_000;
    assert.equal((await fetch(`${first.origin}/qq-bridge/api/settings`, { headers: { cookie } })).status, 401);
  });
  await check('scope disposal closes the listener and permanently revokes access', async () => {
    await local.stop();
    await local.stop();
    await assert.rejects(fetch(`${first.origin}/qq-bridge/api/settings`, { headers: { cookie } }));
    await assert.rejects(local.open('overview'), /控制台已关闭/);
  });
  await check('opener failure revokes its grant without exposing it in errors', async () => {
    let attempted;
    const bad = createLocalConsole({ handle() {}, openBrowser: async url => { attempted = new URL(url); throw new Error(url); } });
    try {
      await assert.rejects(bad.open('overview'), error => !error.message.includes('grant=') && error.statusCode === 503);
      assert.equal((await exchange(attempted)).status, 401);
    } finally { await bad.stop(); }
  });
  await check('disposing during a pending opener closes the listener and cancels completion', async () => {
    let attempted;
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = createLocalConsole({ handle() {}, openBrowser: url => {
      attempted = new URL(url);
      started();
      return new Promise(resolve => { release = resolve; });
    } });
    const opening = pending.open('overview');
    await ready;
    await pending.stop();
    release();
    await assert.rejects(opening, error => error.statusCode === 503);
    await assert.rejects(fetch(attempted));
  });
  await check('a Web scope owns the local listener and preserves single console activation', async () => {
    const cleanups = [];
    let options;
    let activations = 0;
    let stops = 0;
    let bridgeStops = 0;
    let url;
    const ctx = {
      logger: { info() {}, warn() {} },
      get(name) {
        if (name === 'webServer') return { register() { return () => {}; } };
        if (name === 'connection') return { requestRejection() {} };
        throw new Error(name);
      },
      effect(callback) { cleanups.push(callback()); },
    };
    await mountCompanionConsole(ctx, {
      projectRoot: path.resolve(import.meta.dirname, '..'),
      configFile: path.join(os.tmpdir(), `qq-missing-console-${process.pid}.json`),
      supervisor: { status() { return { running: false }; }, async stop() { bridgeStops += 1; } },
      openBrowser: async target => { url = new URL(target); },
      serverFactory(opts) {
        options = opts;
        return {
          async activate() { activations += 1; },
          async stop() { stops += 1; },
          handle(req, res) { res.end(req.url); },
        };
      },
    });
    try {
      await options.openConsole('overview');
      const response = await exchange(url);
      const scopeCookie = response.headers.get('set-cookie').split(';')[0];
      const page = await fetch(`${url.origin}/qq-bridge/api/overview`, { headers: { cookie: scopeCookie } });
      assert.equal(await page.text(), '/api/overview');
      assert.equal(activations, 1);
      assert.equal(stops, 0);
      await Promise.all(cleanups.map(cleanup => cleanup()));
      assert.equal(stops, 1);
      assert.equal(bridgeStops, 1);
      await assert.rejects(fetch(url));
    } finally { await Promise.all(cleanups.map(cleanup => cleanup())); }
  });
  await check('parameterized OS openers use no shell and do not concatenate URL commands', async () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      let call;
      const url = `http://127.0.0.1:12345/qq-bridge/auth#grant=${'a'.repeat(43)}`;
      await openLocalConsoleUrl(url, {
        platform,
        spawnImpl(command, args, options) {
          call = { command, args, options };
          const child = new EventEmitter();
          queueMicrotask(() => child.emit('close', 0));
          return child;
        },
      });
      assert.equal(call.options.shell, false);
      assert.equal(call.args.at(-1), url);
      assert.ok(!call.args.includes('/c'));
      assert.equal(call.command, platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'open' : 'xdg-open');
      if (platform === 'win32') assert.ok(call.args.includes('-File'));
    }
    assert.throws(() => openLocalConsoleUrl('https://example.com/'), /只允许打开本机控制台/);
  });
  await check('the open API validates pages and waits for the injected opener', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-local-console-'));
    const pages = [];
    consoleServer = createWebUiServer({
      configRoot: tmp,
      configFile: path.join(tmp, 'config.json'),
      config: { chatSessionsPath: path.join(tmp, 'chat-sessions.json') },
      openConsole: async page => { await Promise.resolve(); pages.push(page); return { opened: true }; },
      napcatHealth: { async check() { return { state: 'stopped', loggedIn: false, reachable: false }; }, close() {} },
      platformQrLogin: { async stop() {} },
      updateManager: { async start() {}, stop() {}, async status() { return { automatic: false }; } },
    });
    apiServer = http.createServer(consoleServer.handle);
    await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${apiServer.address().port}`;
    const post = body => fetch(`${base}/api/console/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const body of [{ page: 'https://example.com' }, { page: 'model', url: 'https://example.com' }, {}, { page: 'memes' }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal((await fetch(`${base}/api/console/open`)).status, 405);
    const response = await post({ page: 'persona' });
    assert.deepEqual(await response.json(), { ok: true, data: { opened: true } });
    assert.deepEqual(pages, ['persona']);
  });
  console.log(`${passed}/${passed} local console checks passed`);
} finally {
  await local.stop();
  if (apiServer) {
    apiServer.closeAllConnections?.();
    await new Promise(resolve => apiServer.close(resolve));
  }
  await consoleServer?.stop();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
}
