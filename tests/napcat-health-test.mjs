import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNapcatHealth, createNapcatHealthJournal, readNapcatSettings } from '../src/napcat-health.js';
import { createFakeNapCat } from './ws-harness.mjs';
import { isolatedEnv } from './helpers/isolated-fixtures.mjs';

const TOKEN = 'synthetic-webui-secret';
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-napcat-health-'));
  const state = {
    token: TOKEN, credential: 'synthetic-signed-credential', logins: 0, calls: [],
    status: { isLogin: true, isOffline: false, loginPhase: 'ready' },
    info: { uin: '12345678', nick: 'fixture', online: true },
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    const reply = (data, code = 0, message = '') => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code, data, message }));
    if (state.hang) return;
    if (req.url === '/api/auth/login') {
      state.logins += 1;
      const hash = createHash('sha256').update(`${state.token}.napcat`).digest('hex');
      if (JSON.parse(body).hash !== hash) return reply(null, -1, 'token is invalid');
      return reply(state.twoFactor ? { require2FA: true } : { Credential: state.credential });
    }
    if (req.headers.authorization !== `Bearer ${state.credential}`) return reply(null, -1, 'Unauthorized');
    if (req.url === '/api/QQLogin/CheckLoginStatus') return reply(state.status);
    if (req.url === '/api/QQLogin/GetQQLoginInfo') return reply(state.info);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { napcat: { webui: `http://127.0.0.1:${server.address().port}/webui/`, webuiToken: TOKEN } };
  const health = createNapcatHealth({ root, config, cacheMs: 0, timeoutMs: 500 });
  try { await run({ root, state, config, health }); }
  finally {
    health.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('modern WebUI hash login, authenticated POST and explicit online evidence', () => fixture(async ({ state, health }) => {
  const status = await health.check();
  assert.equal(status.state, 'online');
  assert.equal(status.account, '12345678');
  assert.equal(status.source, 'webui');
  assert.ok(state.calls.every((call) => call.method === 'POST'));
  assert.equal(state.calls[1].authorization, `Bearer ${state.credential}`);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(!JSON.stringify(status).includes(state.credential));
  assert.ok(!state.calls[0].body.includes(TOKEN));
  await health.check({ force: true });
  assert.equal(state.logins, 1, 'reuse session instead of authenticating every poll');
}));

test('cached credentials refresh once after NapCat worker restart', () => fixture(async ({ state, health }) => {
  await health.check();
  state.credential = 'replacement-credential';
  assert.equal((await health.check({ force: true })).loggedIn, true);
  assert.equal(state.logins, 2);
}));

test('changed token invalidates the credential even before expiry', () => fixture(async ({ state, config, health }) => {
  await health.check();
  config.napcat.webuiToken = state.token = 'changed-synthetic-secret';
  assert.equal((await health.check({ force: true })).state, 'online');
  assert.equal(state.logins, 2);
}));

test('offline, QR, reconnect and initialization are distinguished without stale identity', () => fixture(async ({ state, health }) => {
  for (const [loginPhase, expected] of [['offline', 'offline'], ['waiting_qrcode', 'login-required'], ['reconnecting', 'reconnecting'], ['qrcode_scanned', 'starting']]) {
    state.status = { isLogin: false, loginPhase, qrcodeurl: 'https://qr.invalid/sensitive', loginError: '' };
    const status = await health.check({ force: true });
    assert.equal(status.state, expected);
    assert.equal(status.loggedIn, false);
    assert.equal(status.account, '');
    assert.ok(!JSON.stringify(status).includes('sensitive'));
  }
}));

test('an identity response becoming offline overrides an earlier online status', () => fixture(async ({ state, health }) => {
  state.info.online = false;
  assert.equal((await health.check()).loggedIn, false);
}));

test('missing or string-valued isLogin never counts as online', () => fixture(async ({ state, health }) => {
  for (const status of [{ uin: '12345678', nick: 'fixture' }, { isLogin: 'true' }]) {
    state.status = status;
    const got = await health.check({ force: true });
    assert.equal(got.state, 'unknown');
    assert.equal(got.known, false);
    assert.equal(got.loggedIn, false);
  }
}));

test('2FA is respected and failed auth uses a cooldown instead of a login storm', () => fixture(async ({ state, health }) => {
  state.twoFactor = true;
  const first = await health.check();
  assert.equal(first.loggedIn, false);
  assert.equal(first.errorCode, 'webui-2fa-required');
  await health.check({ force: true });
  assert.equal(state.logins, 1);
}));

test('authenticated OneBot get_status works when the WebUI is unavailable', () => fixture(async ({ config, state, health }) => {
  state.twoFactor = true;
  const bot = createFakeNapCat({ token: 'synthetic-onebot-token', onCall(call) {
    call.reply(call.action === 'get_status' ? { online: true, good: true } : { user_id: 12345678, nickname: 'fixture' });
  } });
  const port = await bot.listen();
  config.onebot = { url: `ws://127.0.0.1:${port}`, accessToken: 'synthetic-onebot-token' };
  try {
    const got = await health.check();
    assert.equal(got.loggedIn, true);
    assert.equal(got.source, 'onebot');
    assert.equal(got.account, '12345678');
    assert.deepEqual(bot.state.calls.map((call) => call.action), ['get_status', 'get_login_info']);
  } finally { await bot.close(); }
}));

test('OneBot port/handshake/account alone are insufficient and false online is authoritative', () => fixture(async ({ config, state, health }) => {
  state.twoFactor = true;
  let online = false;
  const bot = createFakeNapCat({ onCall(call) {
    call.reply(call.action === 'get_status' ? { online, good: true, user_id: 12345678 } : { user_id: 12345678 });
  } });
  config.onebot = { url: `ws://127.0.0.1:${await bot.listen()}` };
  try {
    assert.equal((await health.check()).state, 'offline');
    online = undefined;
    assert.equal((await health.check({ force: true })).state, 'unknown');
    assert.ok(bot.state.calls.every((call) => call.action !== 'get_login_info'));
  } finally { await bot.close(); }
}));

test('wrong OneBot token fails closed', () => fixture(async ({ config, state, health }) => {
  state.twoFactor = true;
  const bot = createFakeNapCat({ token: 'expected-token' });
  config.onebot = { url: `ws://127.0.0.1:${await bot.listen()}`, accessToken: 'wrong-token' };
  try { assert.equal((await health.check()).loggedIn, false); } finally { await bot.close(); }
}));

test('a hanging WebUI has one bounded total deadline', () => fixture(async ({ state, health }) => {
  state.hang = true;
  const started = Date.now();
  const got = await health.check({ running: true });
  assert.equal(got.state, 'unknown');
  assert.ok(Date.now() - started < 1300);
}));

test('a hanging WebUI reserves time for a healthy OneBot fallback', () => fixture(async ({ state, config, health }) => {
  state.hang = true;
  const bot = createFakeNapCat({ onCall(call) { call.reply(call.action === 'get_status' ? { online: true } : { user_id: 12345678 }); } });
  config.onebot = { url: `ws://127.0.0.1:${await bot.listen()}` };
  try {
    const started = Date.now();
    assert.equal((await health.check()).state, 'online');
    assert.equal(bot.state.connections, 1);
    assert.ok(Date.now() - started < 1300);
  } finally { await bot.close(); }
}));

async function runHealthCli(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/napcat-health.mjs', import.meta.url)), '--root', root, '--running'],
      { windowsHide: true, env: isolatedEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { killed = true; child.kill(); }, 3800);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(killed, false, 'CLI must exit within the PowerShell parent deadline');
        assert.equal(code, 0, stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}

test('CLI exits after online evidence even when the OneBot peer ignores close frames', () => fixture(async ({ root }) => {
  const bot = createFakeNapCat({ respondToClose: false, onCall(call) {
    call.reply(call.action === 'get_status' ? { online: true } : { user_id: 12345678 });
  } });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ onebot: { url: `ws://127.0.0.1:${await bot.listen()}` } }));
  try { assert.equal((await runHealthCli(root)).loggedIn, true); } finally { await bot.close(); }
}));

test('CLI exits within its deadline when the OneBot upgrade never responds', () => fixture(async ({ root }) => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ onebot: { url: `ws://127.0.0.1:${server.address().port}` } }));
  try { assert.equal((await runHealthCli(root)).state, 'unknown'); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('concurrent probes coalesce and imported PS session avoids another auth', () => fixture(async ({ root, state, config, health }) => {
  await Promise.all([health.check(), health.check(), health.check()]);
  assert.equal(state.logins, 1);
  const next = createNapcatHealth({ root, config, session: health.exportSession(), timeoutMs: 500 });
  try {
    assert.equal((await next.check()).loggedIn, true);
    assert.equal(state.logins, 1);
  } finally { next.close(); }
}));

test('nested config, BOM and disabled WebUI do not contact another installation', () => fixture(async ({ root }) => {
  const dir = path.join(root, 'napcat', 'napcat', 'config');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'webui.json'), '\uFEFF' + JSON.stringify({ token: TOKEN, host: '0.0.0.0', port: 12345, disableWebUI: true }));
  const settings = readNapcatSettings(root, {});
  assert.equal(settings.baseUrl, 'http://127.0.0.1:12345');
  assert.equal(settings.token, TOKEN);
  assert.equal(settings.webuiEnabled, false);
  const health = createNapcatHealth({ root, config: {} });
  try { assert.equal((await health.check({ running: false })).state, 'stopped'); } finally { health.close(); }
}));

test('lifecycle journal preserves transitions and bounds files without identity or secrets', () => fixture(async ({ root }) => {
  const logDir = path.join(root, 'logs');
  const journal = createNapcatHealthJournal({ logDir, maxBytes: 250, heartbeatMs: 60_000 });
  const status = { state: 'online', source: 'webui', phase: 'ready', known: true, loggedIn: true, errorCode: '', checkedAt: new Date().toISOString(), account: '12345678', nickname: 'private-name', token: TOKEN };
  journal(status);
  journal(status);
  const file = path.join(logDir, 'napcat-health.jsonl');
  assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 1);
  for (let i = 0; i < 20; i += 1) journal({ ...status, state: i % 2 ? 'online' : 'offline' });
  const files = await fs.readdir(logDir);
  assert.ok(files.length <= 3);
  const text = (await Promise.all(files.map((name) => fs.readFile(path.join(logDir, name), 'utf8')))).join('');
  for (const secret of [TOKEN, '12345678', 'private-name']) assert.ok(!text.includes(secret));
}));
