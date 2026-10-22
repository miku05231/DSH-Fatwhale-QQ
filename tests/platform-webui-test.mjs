import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { freePort, useIsolatedEnv, prepareIsolatedHome, browserRuntimeEnv, createConsoleFixture } from './helpers/isolated-fixtures.mjs';
import { createWebUiServer } from '../src/webui/server.mjs';
import { killProcessTree } from '../src/dsh.js';

const QR_SESSION_ID = '12345678-1234-4123-8123-123456789abc';

function syntheticQrImage() {
  const size = 232;
  const raw = Buffer.alloc(size * (size * 3 + 1), 255);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const mx = Math.floor(x / 8) - 4;
      const my = Math.floor(y / 8) - 4;
      let black = mx >= 0 && mx < 21 && my >= 0 && my < 21 && (mx * 3 + my * 7) % 5 < 2;
      for (const [left, top] of [[0, 0], [14, 0], [0, 14]]) {
        const dx = mx - left; const dy = my - top;
        if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) black = dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      }
      if (black) raw.fill(0, y * (size * 3 + 1) + 1 + x * 3, y * (size * 3 + 1) + 4 + x * 3);
    }
  }
  function chunk(type, bytes) {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}

test('platform control API uses isolated state and never starts or publishes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-platform-webui-'));
  const restore = useIsolatedEnv(root, { QQ_CONFIG: path.join(root, 'config.json') });
  let instance;
  try {
    await prepareIsolatedHome(root);
    const config = { stateDir: 'state', logDir: 'logs' };
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
    const calls = [];
    const logs = [];
    let failure = '';
    let saved = {
      enabled: false, cron: '0 9 * * *', keywords: ['fixture'], upUsers: ['100'],
      targets: ['123', 'g:456'], mentionUid: '789', commentEnabled: false, commentApproved: false,
    };
    const secret = 'synthetic-cookie-secret-do-not-expose';
    const qrCalls = [];
    let qrStatus = 'waiting';
    let qrFailure = '';
    let qrImage = syntheticQrImage();
    let qrCancelStatus = 'expired';
    const platformQrLogin = {
      async start() {
        qrCalls.push(['start']);
        if (qrFailure) throw Object.assign(new Error(secret), { code: qrFailure });
        return { id: QR_SESSION_ID, qrImage, expiresAt: new Date(Date.now() + 180_000).toISOString(), status: 'waiting', cookies: { SESSDATA: secret }, qrcodeKey: secret };
      },
      async poll(id) { qrCalls.push(['poll', id]); return { status: qrStatus, cookies: { SESSDATA: secret }, redirectUrl: `https://fixture.invalid/?SESSDATA=${secret}` }; },
      async cancel(id) { qrCalls.push(['cancel', id]); return { cancelled: qrCancelStatus !== 'success', status: qrCancelStatus, secret }; },
      stop() { qrCalls.push(['stop']); },
    };
    const platformControl = {
      start() { calls.push(['start']); },
      async snapshot() {
        if (failure === 'snapshot') throw new Error(`Cookie: SESSDATA=${secret}`);
        return {
          config: { ...saved, cookie: secret }, cookie: secret, cookies: { SESSDATA: secret },
          cookieAvailable: true, nextRunAt: '2026-10-23T01:00:00Z', busy: false,
          lastRun: { status: 'ok', at: '2026-10-22T01:00:00Z', found: 2, published: 1, cookie: secret },
          todayComments: 1, commentPublicationAvailable: true, blockedReason: '',
          audit: [{ dynamicId: '101', targetUid: '789', at: '2026-10-22T01:00:00Z', status: 'published', text: '<script>fixture</script>', cookie: secret }],
        };
      },
      async saveConfig(value) {
        if (failure === 'save') throw new Error(`token=${secret}`);
        calls.push(['save', value]); saved = value;
      },
      async queueManualRun() { calls.push(['queue']); },
      async extractBrowserCookie(browser) {
        calls.push(['cookie', browser]);
        if (failure === 'cookie') throw new Error(`SESSDATA=${secret}`);
        if (failure.startsWith('cookie-error:')) throw new Error(failure.slice('cookie-error:'.length));
        return { imported: true, browser, cookies: { SESSDATA: secret } };
      },
    };
    instance = createWebUiServer({
      config, configRoot: root, port: await freePort(), platformControl, platformQrLogin,
      log: { warn: (...args) => logs.push(args.join(' ')), info() {} },
      updateManager: { async start() {}, stop() {}, async status() { return {}; } },
    });
    await instance.start();
    const base = `http://127.0.0.1:${instance.port}`;
    const endpoint = '/api/automation/bilibili';
    let token;
    async function request(suffix = '', { method = 'GET', body, headers = {}, withToken = true } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(base + endpoint + suffix, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(token && withToken ? { 'X-QQ-Automation-Token': token } : {}),
            ...headers,
          },
        }, (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: JSON.parse(data) }); }
            catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
      });
    }
    await t.test('snapshot exposes config and audit but strips all cookie objects', async () => {
      const result = await request();
      assert.equal(result.status, 200);
      assert.equal(result.body.data.cookieAvailable, true);
      assert.equal(result.body.data.todayComments, 1);
      assert.equal(result.body.data.lastRun.found, 2);
      assert.equal(result.body.data.config.commentApproved, false);
      assert.equal(result.body.data.audit[0].dynamicId, '101');
      assert.equal(JSON.stringify(result).includes(secret), false);
      token = result.body.data.automationToken;
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.deepEqual(calls, []);
    });
    await t.test('all routes reject cross-origin websites and DNS rebound hostnames', async () => {
      for (const headers of [{ Origin: 'https://foreign.invalid' }, { Host: `foreign.invalid:${instance.port}` }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await request('', { headers })).status, 403);
        assert.equal((await request('/run', { method: 'POST', body: {}, headers })).status, 403);
      }
      assert.deepEqual(calls, []);
    });
    await t.test('writes require a console token and JSON', async () => {
      assert.equal((await request('/run', { method: 'POST', body: {}, withToken: false })).status, 403);
      assert.equal((await request('/run', { method: 'POST', body: {}, headers: { 'X-QQ-Automation-Token': 'invalid' } })).status, 403);
      assert.equal((await request('/run', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.deepEqual(calls, []);
    });
    await t.test('config save passes explicit approval and only allowed fields', async () => {
      const next = { ...saved, enabled: true, commentEnabled: true, commentApproved: true };
      const result = await request('', { method: 'PUT', body: next });
      assert.equal(result.status, 200);
      assert.deepEqual(calls.at(-1), ['save', next]);
      assert.equal(result.body.data.config.commentApproved, true);
      const before = calls.length;
      assert.equal((await request('', { method: 'PUT', body: { ...next, cookie: secret } })).status, 400);
      assert.equal(calls.length, before);
    });
    await t.test('run request queues bridge work without starting a scheduler', async () => {
      const result = await request('/run', { method: 'POST', body: {} });
      assert.equal(result.status, 200);
      assert.equal(result.body.data.queued, true);
      assert.deepEqual(calls.at(-1), ['queue']);
      const before = calls.length;
      assert.equal((await request('/run', { method: 'POST', body: { force: true } })).status, 400);
      assert.equal(calls.length, before);
      assert.equal(calls.some(([action]) => action === 'start'), false);
    });
    await t.test('Cookie import requires an explicit supported browser and strips provider result', async () => {
      for (const body of [{}, { browser: 'firefox' }, { browser: 'edge', cookie: secret }]) {
        assert.equal((await request('/cookie', { method: 'POST', body })).status, 400);
      }
      for (const browser of ['edge', 'chrome']) {
        const result = await request('/cookie', { method: 'POST', body: { browser } });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.imported, true);
        assert.equal(JSON.stringify(result).includes(secret), false);
        assert.deepEqual(calls.at(-1), ['cookie', browser]);
      }
    });
    await t.test('audit endpoint returns bounded public audit fields', async () => {
      const result = await request('/audit');
      assert.equal(result.status, 200);
      assert.deepEqual(Object.keys(result.body.data), ['audit']);
      assert.equal(result.body.data.audit[0].text, '<script>fixture</script>');
      assert.equal(JSON.stringify(result).includes(secret), false);
    });
    await t.test('invalid bodies and methods fail without invoking the controller', async () => {
      const before = calls.length;
      for (const body of ['{invalid', '[]', 'null']) assert.equal((await request('', { method: 'PUT', body })).status, 400);
      assert.equal((await request('', { method: 'POST', body: {} })).status, 405);
      assert.equal((await request('/run')).status, 405);
      assert.equal((await request('/unknown')).status, 404);
      assert.equal(calls.length, before);
    });
    await t.test('provider failures never disclose their sensitive messages or stacks', async () => {
      failure = 'save';
      const save = await request('', { method: 'PUT', body: saved });
      assert.equal(save.status, 400);
      failure = 'cookie';
      const cookie = await request('/cookie', { method: 'POST', body: { browser: 'edge' } });
      assert.equal(cookie.status, 400);
      failure = 'snapshot';
      const snapshot = await request();
      assert.equal(snapshot.status, 500);
      for (const result of [save, cookie, snapshot]) assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(logs.join('\n').includes(secret), false);
      failure = '';
    });
    await t.test('Cookie import failures explain safe causes without exposing provider details', async () => {
      for (const [code, text] of [
        ['cookie_database_locked', '后台进程'], ['cookie_app_bound_unsupported', 'v20'],
        ['bilibili_login_not_found', '未找到'], ['cookie_crypto_unavailable', 'cryptography'],
        ['cookie_decryption_failed', 'Windows'], ['browser_profile_not_found', '浏览器配置'],
        ['cookie_database_unreadable', '访问权限'], ['bilibili_login_required', '已失效'],
        ['cookie_extractor_failed', '提取失败'], ['bilibili_request_timeout', '超时'],
      ]) {
        failure = `cookie-error:${code}`;
        const result = await request('/cookie', { method: 'POST', body: { browser: 'edge' } });
        assert.equal(result.status, 400);
        assert.ok(JSON.stringify(result.body).includes(text));
        assert.ok(logs.some(line => line.includes(`（${code}）`)));
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
      failure = '';
    });
    await t.test('QR routes retain token, origin, JSON and method protections', async () => {
      for (const action of ['start', 'poll', 'cancel']) {
        const suffix = `/login/${action}`;
        const body = action === 'start' ? {} : { id: QR_SESSION_ID };
        assert.equal((await request(suffix, { method: 'POST', body, withToken: false })).status, 403);
        assert.equal((await request(suffix, { method: 'POST', body, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
        assert.equal((await request(suffix, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
        assert.equal((await request(suffix)).status, 405);
      }
      assert.deepEqual(qrCalls, []);
    });
    await t.test('QR routes reject extra parameters and malformed session IDs before provider calls', async () => {
      assert.equal((await request('/login/start', { method: 'POST', body: { force: true } })).status, 400);
      for (const suffix of ['/login/poll', '/login/cancel']) {
        for (const body of [{}, { id: 'invalid' }, { id: 123 }, { id: QR_SESSION_ID, cookie: secret }, { id: '12345678-1234-1123-8123-123456789abc' }]) {
          assert.equal((await request(suffix, { method: 'POST', body })).status, 400);
        }
      }
      assert.deepEqual(qrCalls, []);
    });
    await t.test('QR start, poll and cancel expose only the public login contract', async () => {
      const started = await request('/login/start', { method: 'POST', body: {} });
      assert.equal(started.status, 200);
      assert.deepEqual(Object.keys(started.body.data).sort(), ['expiresAt', 'id', 'qrImage', 'status']);
      assert.equal(started.body.data.id, QR_SESSION_ID);
      assert.equal(JSON.stringify(started).includes(secret), false);
      for (const status of ['waiting', 'scanned', 'expired', 'success']) {
        qrStatus = status;
        const polled = await request('/login/poll', { method: 'POST', body: { id: QR_SESSION_ID } });
        assert.deepEqual(polled.body.data, { status });
      }
      for (const status of ['expired', 'success']) {
        qrCancelStatus = status;
        const cancelled = await request('/login/cancel', { method: 'POST', body: { id: QR_SESSION_ID } });
        assert.deepEqual(cancelled.body.data, { cancelled: status !== 'success', status });
        assert.equal(JSON.stringify(cancelled).includes(secret), false);
      }
      qrCancelStatus = 'expired';
      assert.deepEqual(qrCalls.at(-1), ['cancel', QR_SESSION_ID]);
    });
    await t.test('QR malformed provider images, states and exceptions fail without leaking details', async () => {
      for (const invalid of ['https://fixture.invalid/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<private>']) {
        qrImage = invalid;
        const result = await request('/login/start', { method: 'POST', body: {} });
        assert.equal(result.status, 400);
        assert.equal(JSON.stringify(result).includes(invalid), false);
      }
      qrImage = syntheticQrImage();
      qrStatus = secret;
      assert.equal((await request('/login/poll', { method: 'POST', body: { id: QR_SESSION_ID } })).status, 400);
      for (const status of ['waiting', 'scanned', secret, undefined]) {
        qrCancelStatus = status;
        const invalid = await request('/login/cancel', { method: 'POST', body: { id: QR_SESSION_ID } });
        assert.equal(invalid.status, 400);
        assert.equal(JSON.stringify(invalid).includes(secret), false);
      }
      qrCancelStatus = 'expired';
      qrFailure = 'private-provider-error';
      const result = await request('/login/start', { method: 'POST', body: {} });
      assert.equal(result.status, 400);
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(logs.join('\n').includes(secret), false);
      qrFailure = '';
    });
    await t.test('QR errors show safe instructions while provider exception details remain private', async () => {
      for (const [code, text] of [['qrcode_timeout', '超时'], ['qrcode_session_invalid', '失效'], ['qrcode_login_invalid', '不完整']]) {
        qrFailure = code;
        const result = await request('/login/start', { method: 'POST', body: {} });
        assert.equal(result.status, 400);
        assert.ok(result.body.error.includes(text));
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
      assert.equal(logs.join('\n').includes(secret), false);
      qrFailure = '';
    });
    await t.test('automation HTML retains unique IDs, browser selection, approval and navigation', async () => {
      const html = await fs.readFile(new URL('../src/webui/public/index.html', import.meta.url), 'utf8');
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(ids.length, new Set(ids).size);
      for (const id of ['page-memory', 'page-automation', 'biliCookieBrowser', 'biliCommentApproved', 'biliAudit', 'biliRefresh']) assert.ok(ids.includes(id));
      assert.ok(html.includes('data-page="automation"'));
      const script = await fs.readFile(new URL('../src/webui/public/app.js', import.meta.url), 'utf8');
      assert.ok(script.includes("name === 'automation'"));
      assert.ok(script.includes("'X-QQ-Automation-Token'"));
    });
  } finally {
    await instance?.stop();
    restore();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('isolated real browser platform settings and responsive navigation', { skip: process.env.QQ_PLATFORM_BROWSER_TEST !== '1' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-platform-browser-'));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-platform-ui-report-'));
  const browserEnv = browserRuntimeEnv(root);
  const report = { isolated: true, checks: [], screenshots: [], layouts: [], errors: [], visualRegression: 'INCONCLUSIVE: no baseline for the new automation page.' };
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  let fixture;
  let instance;
  let browser;
  let browserDone;
  let ws;
  try {
    fixture = await createConsoleFixture(root);
    await fixture.instance.stop();
    const writes = [];
    let cookieAvailable = false;
    const qr = { starts: [], polls: [], cancels: [], status: 'waiting', hold: false, release: null, image: null, failure: '', cancelStatus: 'expired', holdCancel: false, releaseCancel: null };
    let saved = { enabled: false, cron: '0 9 * * *', keywords: ['fixture'], upUsers: ['100'], targets: ['g:456'], mentionUid: '789', commentEnabled: false, commentApproved: false };
    instance = createWebUiServer({
      config: fixture.config, configRoot: root, port: await freePort(),
      updateManager: { async start() {}, stop() {}, async status() { return { available: false, phase: 'idle' }; } },
      platformQrLogin: {
        async start() {
          if (qr.failure) throw Object.assign(new Error('synthetic-private-login-detail'), { code: qr.failure });
          const id = `12345678-1234-4123-8123-${(qr.starts.length + 1).toString(16).padStart(12, '0')}`;
          qr.starts.push(id);
          return { id, qrImage: qr.image ?? syntheticQrImage(), status: 'waiting', expiresAt: new Date(Date.now() + 180_000).toISOString() };
        },
        async poll(id) {
          qr.polls.push({ id, at: Date.now() });
          const status = qr.hold ? await new Promise(resolve => { qr.release = resolve; }) : qr.status;
          if (status === 'success') cookieAvailable = true;
          return { status };
        },
        async cancel(id) {
          qr.cancels.push(id);
          const status = qr.holdCancel ? await new Promise(resolve => { qr.releaseCancel = resolve; }) : qr.cancelStatus;
          if (status === 'success') cookieAvailable = true;
          return { cancelled: status !== 'success', status };
        },
        stop() {},
      },
      platformControl: {
        async snapshot() { return {
          config: saved, cookieAvailable, todayComments: 1, blockedReason: 'cooldown',
          commentPublicationAvailable: true, lastRun: { status: 'ok', at: '2026-10-22T01:00:00Z', found: 2 },
          audit: [{ dynamicId: '101', targetUid: '789', at: '2026-10-22T01:00:00Z', status: 'published', text: '<img src=x onerror="window.auditInjection=true">' }],
        }; },
        async saveConfig(value) { writes.push(['save', value]); saved = value; },
        async queueManualRun() { writes.push(['queue']); },
        async extractBrowserCookie(browserName) { writes.push(['cookie', browserName]); return { imported: true }; },
      },
    });
    await instance.start();
    let executable;
    for (const candidate of [process.env.QQ_TEST_BROWSER_EXE, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)) {
      try { await fs.access(candidate); executable = candidate; break; } catch {}
    }
    assert.ok(executable, 'Microsoft Edge or QQ_TEST_BROWSER_EXE is required');
    const debugPort = await freePort();
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(root, 'browser')}`, '--window-size=1440,1080', 'about:blank'],
    { stdio: 'ignore', windowsHide: true, env: browserEnv });
    browserDone = new Promise((resolve, reject) => { browser.once('error', reject); browser.once('close', resolve); });
    browserDone.catch(() => {});
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (predicate, name) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) { if (await predicate().catch(() => false)) return; await delay(80); }
      throw new Error(`Timeout: ${name}`);
    };
    let target;
    await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = targets.find((item) => item.type === 'page');
      return target?.webSocketDebuggerUrl;
    }, 'isolated browser startup');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      const value = JSON.parse(data);
      const callback = pending.get(value.id);
      if (callback) { pending.delete(value.id); value.error ? callback.reject(new Error(value.error.message)) : callback.resolve(value.result); }
      if (value.method === 'Runtime.exceptionThrown') report.errors.push(value.params.exceptionDetails.text);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `${instance.url}#automation` });
    await until(() => evaluate(`document.querySelector('#biliAutomationStatus')?.textContent.includes('尚未导入')`), 'automation load');
    check('audit content is text and cannot inject markup', await evaluate(`!window.auditInjection && !document.querySelector('#biliAudit img') && document.querySelector('#biliAudit').textContent.includes('<img')`));
    check('all nine navigation targets exist', await evaluate(`document.querySelectorAll('#navBar .nav-item').length === 9 && [...document.querySelectorAll('#navBar .nav-item')].every(item => document.querySelector('#page-' + item.dataset.page))`));
    await evaluate(`document.querySelector('#biliQrLogin').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting' && document.querySelector('#biliQrImage').naturalWidth > 0`), 'login QR image');
    check('QR login is the visible primary login path', await evaluate(`!document.querySelector('#biliQrPanel').hidden && !document.querySelector('#biliBrowserImport').open && document.querySelector('#biliQrImage').src.startsWith('data:image/png;base64,')`));
    for (const width of [375, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: width < 600 });
      await delay(100);
      const layout = await evaluate(`(() => {
        const nav = document.querySelector('#navBar');
        const fields = [...document.querySelectorAll('#page-automation input, #page-automation select, #page-automation textarea, #page-automation button')];
        const boxes = fields.map(node => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
        const pills = [...document.querySelectorAll('#navBar .nav-item__pill')].map(node => node.getBoundingClientRect());
        return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, navWidth: nav.clientWidth, navScrollWidth: nav.scrollWidth,
          fieldOverflow: boxes.filter(box => box.left < -1 || box.right > innerWidth + 1), navOverlap: pills.some((box, index) => index > 0 && box.left < pills[index - 1].right - 1) };
      })()`);
      report.layouts.push(layout);
      check(`page and fields fit ${width}px`, layout.pageWidth <= width && !layout.fieldOverflow.length);
      check(`navigation items do not overlap at ${width}px`, !layout.navOverlap);
      check(`login QR remains readable at ${width}px`, await evaluate(`(() => { const image=document.querySelector('#biliQrImage'); const box=image.getBoundingClientRect(); return image.naturalWidth===232 && box.width>=200 && box.width===box.height && box.left>=0 && box.right<=innerWidth; })()`));
      const shot = path.join(output, `automation-${width}.png`);
      const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await fs.writeFile(shot, Buffer.from(image.data, 'base64'));
      report.screenshots.push(shot);
    }
    qr.status = 'scanned';
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'scanned'`), 'scanned login status');
    qr.status = 'success';
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'success' && document.querySelector('#biliAutomationStatus').textContent.includes('登录态已就绪')`), 'QR login success');
    check('QR success clears the image and preserves disabled automation and comments', await evaluate(`document.querySelector('#biliQrImage').hidden && !document.querySelector('#biliEnabled').checked && !document.querySelector('#biliCommentEnabled').checked && !document.querySelector('#biliCommentApproved').checked`));
    check('polls are spaced at least two seconds apart', qr.polls.length >= 2 && qr.polls.every((row, index) => !index || row.at - qr.polls[index - 1].at >= 1900));
    qr.status = 'waiting';
    qr.hold = true;
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(async () => qr.release !== null, 'slow QR poll');
    const slowId = qr.starts.at(-1);
    const countDuringSlow = qr.polls.length;
    await delay(2100);
    check('a slow QR poll remains singleflight', qr.polls.length === countDuringSlow);
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(async () => qr.starts.at(-1) !== slowId, 'replacement QR session');
    qr.hold = false;
    qr.release('success');
    qr.release = null;
    await delay(120);
    check('an old successful response cannot replace a refreshed QR session', await evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting' && !document.querySelector('#biliQrImage').hidden`));
    check('refresh cancels the previous QR session', qr.cancels.includes(slowId));
    qr.status = 'expired';
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'expired'`), 'expired QR status');
    check('expired QR stops displaying the image', await evaluate(`document.querySelector('#biliQrImage').hidden`));
    qr.image = 'https://fixture.invalid/untrusted-qr.png';
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'error'`), 'QR failure state');
    check('invalid remote QR image is never rendered', await evaluate(`!document.querySelector('#biliQrImage').hasAttribute('src')`));
    qr.image = null;
    qr.status = 'waiting';
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting'`), 'QR retry');
    const cancelId = qr.starts.at(-1);
    await evaluate(`document.querySelector('#biliQrCancel').click()`);
    await until(async () => qr.cancels.includes(cancelId), 'QR explicit cancellation');
    const cancelledPolls = qr.polls.length;
    await delay(2100);
    check('cancel hides QR and stops future polling', qr.polls.length === cancelledPolls && await evaluate(`document.querySelector('#biliQrPanel').hidden`));
    qr.failure = 'qrcode_timeout';
    await evaluate(`document.querySelector('#biliQrLogin').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'error' && document.querySelector('#snackbarText').textContent.includes('超时')`), 'safe QR network error');
    check('QR network errors preserve generic state and show sanitized instructions', await evaluate(`document.querySelector('#biliQrStatus').textContent.includes('登录检查失败') && !document.body.innerText.includes('synthetic-private-login-detail')`));
    qr.failure = '';
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting'`), 'QR before committed cancellation');
    qr.holdCancel = true;
    cookieAvailable = false;
    await evaluate(`document.querySelector('#biliQrRefresh').click()`);
    await until(async () => qr.releaseCancel !== null, 'committed cancellation in flight');
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting'`), 'QR replacement while cancellation waits');
    qr.holdCancel = false;
    qr.releaseCancel('success');
    qr.releaseCancel = null;
    await until(() => evaluate(`document.querySelector('#biliAutomationStatus').textContent.includes('登录态已就绪') && document.querySelector('#snackbarText').textContent === 'B站登录成功，登录态已保存'`), 'committed cancellation success notice');
    check('committed cancellation refreshes login state without replacing a new QR', await evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting' && !document.querySelector('#biliQrImage').hidden && !document.querySelector('#biliEnabled').checked && !document.querySelector('#biliCommentEnabled').checked`));
    await evaluate(`document.querySelector('#biliQrCancel').click()`);
    await evaluate(`document.querySelector('#biliQrLogin').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting'`), 'QR before page leave');
    const leaveId = qr.starts.at(-1);
    qr.cancelStatus = 'success';
    await evaluate(`document.querySelector('#snackbarText').textContent='page-leave-sentinel'; document.querySelector('#navBar [data-page="memory"]').click()`);
    await until(async () => qr.cancels.includes(leaveId), 'page leave cancellation');
    await delay(100);
    check('page leave suppresses committed-login notices', await evaluate(`document.querySelector('#page-memory').classList.contains('is-active') && document.querySelector('#snackbarText').textContent === 'page-leave-sentinel'`));
    qr.cancelStatus = 'expired';
    await evaluate(`document.querySelector('#navBar [data-page="automation"]').click()`);
    const leavePolls = qr.polls.length;
    await delay(2100);
    check('returning to automation does not revive an old QR timer', qr.polls.length === leavePolls && await evaluate(`document.querySelector('#biliQrPanel').hidden`));
    await evaluate(`document.querySelector('#biliQrLogin').click()`);
    await until(() => evaluate(`document.querySelector('#biliQrPanel').dataset.status === 'waiting'`), 'QR before visibility pause');
    await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))`);
    const hiddenPolls = qr.polls.length;
    await delay(2100);
    check('a hidden page pauses QR polling', qr.polls.length === hiddenPolls);
    await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange'))`);
    await until(async () => qr.polls.length > hiddenPolls, 'single resumed poll');
    await delay(200);
    check('repeated visibility events resume exactly one poll timer', qr.polls.length === hiddenPolls + 1);
    await evaluate(`delete document.hidden; document.querySelector('#biliQrCancel').click()`);
    await evaluate(`document.querySelector('#biliMentionUid').value='invalid'; document.querySelector('#biliSave').click()`);
    await until(() => evaluate(`document.querySelector('#snackbarText').textContent.includes('UID')`), 'invalid UID feedback');
    check('invalid UID does not save', writes.length === 0);
    await evaluate(`document.querySelector('#biliMentionUid').value='789'; document.querySelector('#biliCommentEnabled').checked=true; document.querySelector('#biliCommentApproved').checked=true; document.querySelector('#biliSave').click()`);
    await until(async () => writes.some(([action]) => action === 'save'), 'save from browser');
    check('browser submits explicit acceptance', writes.find(([action]) => action === 'save')[1].commentApproved === true);
    await evaluate(`document.querySelector('#biliRunNow').click()`);
    await until(async () => writes.some(([action]) => action === 'queue'), 'manual queue');
    await evaluate(`document.querySelector('#biliBrowserImport').open=true; document.querySelector('#biliCookieBrowser').value='chrome'; document.querySelector('#biliCookieImport').click()`);
    await until(async () => writes.some(([action]) => action === 'cookie'), 'cookie import');
    check('browser selection reaches isolated provider', writes.some(([action, name]) => action === 'cookie' && name === 'chrome'));
    await until(() => evaluate(`!document.querySelector('#biliCookieImport').disabled`), 'cookie import complete');
    await evaluate(`document.querySelector('#biliCookieBrowser').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    check('keyboard reaches import command', await evaluate(`document.activeElement.id === 'biliCookieImport'`));
    for (const name of ['memory', 'system', 'automation']) {
      await evaluate(`document.querySelector('#navBar [data-page="${name}"]').click()`);
      check(`navigation activates ${name}`, await evaluate(`document.querySelector('#page-${name}').classList.contains('is-active')`));
    }
    await evaluate(`document.querySelector('#navBar [data-page="system"]').click()`);
    await until(() => evaluate(`document.querySelector('#jevModel').value !== undefined && !document.querySelector('#settingsSave').disabled`), 'system settings');
    check('JEV token input is masked', await evaluate(`document.querySelector('#jevToken').type === 'password'`));
    const syntheticToken = 'synthetic-browser-jev-secret';
    await evaluate(`document.querySelector('#jevBaseUrl').value='http://127.0.0.1:1/v1'; document.querySelector('#jevModel').value='fixture-jev'; document.querySelector('#jevToken').value=${JSON.stringify(syntheticToken)}; document.querySelector('#settingsSave').click()`);
    await until(async () => JSON.parse(await fs.readFile(fixture.configPath, 'utf8')).jev?.token === syntheticToken, 'isolated JEV save');
    await until(() => evaluate(`document.querySelector('#jevToken').value === '' && !document.querySelector('#settingsSave').disabled`), 'JEV token cleared after save');
    await evaluate(`document.querySelector('#jevModel').value='fixture-jev-updated'; document.querySelector('#settingsSave').click()`);
    await until(async () => JSON.parse(await fs.readFile(fixture.configPath, 'utf8')).jev?.model === 'fixture-jev-updated', 'empty JEV token retention');
    check('blank JEV input preserves stored token', JSON.parse(await fs.readFile(fixture.configPath, 'utf8')).jev.token === syntheticToken);
    check('JEV secret absent from visible page', !(await evaluate(`document.body.innerText`)).includes(syntheticToken));
    check('no page exceptions', report.errors.length === 0);
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Platform browser report: ${path.join(output, 'report.json')}`);
    ws?.close();
    if (browser?.pid && browser.exitCode === null) killProcessTree(browser);
    await browserDone?.catch(() => {});
    await instance?.stop();
    await fixture?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
