import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBilibiliQrLogin } from '../src/platforms/bilibili-login.js';
import { createPlatformScheduler } from '../src/platform-scheduler.js';
import { createWebUiServer } from '../src/webui/server.mjs';
import { freePort, prepareIsolatedHome, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

const KEY = 'fixture-qrcode-key-123456';
const QR_URL = `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${KEY}`;
const COOKIES = {
  SESSDATA: 'synthetic-new-session-secret',
  bili_jct: 'synthetic-new-csrf-secret',
  DedeUserID: '12345',
  buvid3: 'fixture-public-finger-buvid3',
};
const OLD_COOKIES = {
  SESSDATA: 'synthetic-existing-session-secret',
  bili_jct: 'synthetic-existing-csrf-secret',
  buvid3: 'fixture-existing-buvid3',
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(data, headers = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers });
}

function confirmedResponse() {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(COOKIES)) {
    if (name !== 'buvid3') headers.append('set-cookie', `${name}=${value}; Domain=.bilibili.com; Secure`);
  }
  return response({
    code: 0,
    url: `https://redirect.invalid/?SESSDATA=${COOKIES.SESSDATA}`,
    refresh_token: 'synthetic-private-refresh-token',
  }, headers);
}

async function fixture(t, { pollCodes = [0], validate = async () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-bilibili-login-integration-'));
  const configPath = path.join(root, 'config.json');
  const stateDir = path.join(root, 'state');
  const cookieFile = path.join(stateDir, 'bilibili-cookie.json');
  const restoreEnv = useIsolatedEnv(root, { QQ_CONFIG: configPath });
  let instance;
  let scheduler;
  let login;
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    await instance?.stop();
    await login?.stop();
    scheduler?.stop();
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  });
  await prepareIsolatedHome(root);
  const config = {
    stateDir: 'state', logDir: 'logs',
    automation: { bilibili: {
      enabled: false, cron: '0 9 * * *', keywords: ['fixture'], upUsers: ['100'],
      targets: ['123', 'g:456'], mentionUid: '789', commentEnabled: false, commentApproved: false,
    } },
  };
  const originalConfig = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, originalConfig);
  await fs.mkdir(stateDir, { recursive: true });
  const oldCookieBytes = `${JSON.stringify({ browser: 'edge', cookies: OLD_COOKIES })}\n`;
  await fs.writeFile(cookieFile, oldCookieBytes);
  let clock = Date.UTC(2026, 9, 22, 9);
  const calls = [];
  const logs = [];
  const publicResponses = [];
  const statuses = [...pollCodes];
  const fetchImpl = async (value, options) => {
    const url = new URL(value);
    assert.equal(options.method, 'GET', 'login must never publish a comment');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(url.pathname);
    if (url.href === 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate') {
      return response({ qrcode_key: KEY, url: QR_URL });
    }
    if (url.origin === 'https://passport.bilibili.com' && url.pathname === '/x/passport-login/web/qrcode/poll') {
      assert.equal(url.searchParams.get('qrcode_key'), KEY);
      assert.ok(statuses.length, 'unexpected extra confirmation request');
      const code = statuses.shift();
      return code === 0 ? confirmedResponse() : response({ code });
    }
    if (url.href === 'https://api.bilibili.com/x/frontend/finger/spi') {
      return response({ b_3: COOKIES.buvid3 });
    }
    if (url.href === 'https://api.bilibili.com/x/web-interface/nav') {
      const cookie = new Headers(options.headers).get('cookie');
      for (const [name, value] of Object.entries(COOKIES)) assert.ok(cookie.includes(`${name}=${value}`));
      await validate();
      return response({ isLogin: true, mid: 12345 });
    }
    assert.fail(`No live fetch is available: ${url.origin}${url.pathname}`);
  };
  const log = { warn: (...args) => logs.push(args.join(' ')), info() {} };
  scheduler = createPlatformScheduler({ configPath, stateDir, projectRoot: root, fetchImpl, log });
  login = createBilibiliQrLogin({
    fetchImpl, now: () => clock,
    saveCookies: (cookies, options) => scheduler.importLoginCookies(cookies, options),
  });
  instance = createWebUiServer({
    config, configRoot: root, port: await freePort(), platformControl: scheduler,
    platformQrLogin: login, log,
    openPath: () => assert.fail('login must not launch an external process'),
    openUrl: () => assert.fail('login must not launch a browser'),
    updateManager: { async start() {}, stop() {}, async status() { return {}; } },
  });
  await instance.start();
  let token;
  async function request(suffix = '', body) {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${instance.port}/api/automation/bilibili${suffix}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { 'X-QQ-Automation-Token': token } : {}),
        },
      }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          publicResponses.push(raw);
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('isolated HTTP request timed out')));
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const snapshot = await request();
  assert.equal(snapshot.status, 200);
  token = snapshot.body.data.automationToken;
  assert.match(token, /^[a-f\d]{64}$/);
  return {
    cookieFile, oldCookieBytes, calls, releases, request,
    advance: () => { clock += 1300; },
    async assertUnchangedAndPrivate() {
      assert.equal(await fs.readFile(configPath, 'utf8'), originalConfig);
      const snapshot = await request();
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.data.cookieAvailable, true);
      assert.deepEqual(snapshot.body.data.config, config.automation.bilibili);
      const publicText = [...publicResponses, ...logs].join('\n');
      for (const value of [KEY, QR_URL, ...Object.values(COOKIES), ...Object.values(OLD_COOKIES), 'synthetic-private-refresh-token']) {
        assert.equal(publicText.includes(value), false, 'HTTP responses and logs must not contain credentials or raw QR details');
      }
      assert.equal(publicText.includes('redirect.invalid'), false);
      assert.deepEqual((await fs.readdir(stateDir)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
    },
  };
}

async function start(f) {
  const result = await f.request('/login/start', {});
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body.data).sort(), ['expiresAt', 'id', 'qrImage', 'status']);
  assert.equal(result.body.data.status, 'waiting');
  assert.match(result.body.data.qrImage, /^data:image\/gif;base64,/);
  assert.equal(Buffer.from(result.body.data.qrImage.split(',')[1], 'base64').subarray(0, 6).toString(), 'GIF87a');
  assert.ok(Number.isFinite(Date.parse(result.body.data.expiresAt)));
  return result.body.data.id;
}

test('real QR, scheduler and HTTP console complete an isolated login without exposing credentials', { timeout: 10000 }, async t => {
  const f = await fixture(t, { pollCodes: [86101, 86090, 0] });
  const id = await start(f);
  for (const status of ['waiting', 'scanned', 'success']) {
    const result = await f.request('/login/poll', { id });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, { status });
    f.advance();
  }
  assert.deepEqual(JSON.parse(await fs.readFile(f.cookieFile, 'utf8')), { browser: 'qrcode', cookies: COOKIES });
  assert.deepEqual(f.calls, [
    '/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll',
    '/x/passport-login/web/qrcode/poll', '/x/passport-login/web/qrcode/poll',
    '/x/frontend/finger/spi', '/x/web-interface/nav',
  ]);
  const repeat = await f.request('/login/poll', { id });
  assert.deepEqual(repeat.body.data, { status: 'success' });
  const cancelled = await f.request('/login/cancel', { id });
  assert.deepEqual(cancelled.body.data, { cancelled: false, status: 'success' });
  assert.equal(f.calls.length, 6, 'completed credentials are saved once without another remote poll');
  await f.assertUnchangedAndPrivate();
});

test('HTTP cancellation during real adapter validation preserves the existing cookie', { timeout: 10000 }, async t => {
  const validating = deferred();
  const validationGate = deferred();
  const f = await fixture(t, { validate: async () => { validating.resolve(); await validationGate.promise; } });
  f.releases.push(() => validationGate.resolve());
  const id = await start(f);
  const pendingPoll = f.request('/login/poll', { id });
  await validating.promise;
  const cancelled = await f.request('/login/cancel', { id });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body.data, { cancelled: true, status: 'expired' });
  assert.equal(await fs.readFile(f.cookieFile, 'utf8'), f.oldCookieBytes);
  validationGate.resolve();
  assert.deepEqual((await pendingPoll).body.data, { status: 'expired' });
  assert.deepEqual((await f.request('/login/poll', { id })).body.data, { status: 'expired' });
  assert.equal(await fs.readFile(f.cookieFile, 'utf8'), f.oldCookieBytes);
  assert.equal(f.calls.filter(name => name === '/x/web-interface/nav').length, 1);
  await f.assertUnchangedAndPrivate();
});

test('HTTP cancellation after cookie commit begins waits for persistence and reports success', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const committing = deferred();
  const renameGate = deferred();
  f.releases.push(() => renameGate.resolve());
  const originalRename = fs.rename.bind(fs);
  let cookieRenames = 0;
  const renameMock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(destination) === f.cookieFile) {
      cookieRenames++;
      committing.resolve();
      await renameGate.promise;
    }
    return originalRename(source, destination);
  });
  try {
    const id = await start(f);
    const pendingPoll = f.request('/login/poll', { id });
    await committing.promise;
    const pendingCancel = f.request('/login/cancel', { id });
    assert.equal(await Promise.race([
      pendingCancel.then(() => 'responded'), delay(50).then(() => 'waiting'),
    ]), 'waiting', 'cancel must wait while the temporary Cookie file is committing');
    assert.equal(await fs.readFile(f.cookieFile, 'utf8'), f.oldCookieBytes);
    renameGate.resolve();
    const [polled, cancelled] = await Promise.all([pendingPoll, pendingCancel]);
    assert.equal(polled.status, 200);
    assert.deepEqual(polled.body.data, { status: 'success' });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body.data, { cancelled: false, status: 'success' });
    assert.deepEqual(JSON.parse(await fs.readFile(f.cookieFile, 'utf8')), { browser: 'qrcode', cookies: COOKIES });
    assert.equal(cookieRenames, 1);
    await f.assertUnchangedAndPrivate();
  } finally {
    renameGate.resolve();
    renameMock.mock.restore();
  }
});
