import assert from 'node:assert/strict';
import test from 'node:test';
import { createBilibiliQrLogin } from '../src/platforms/bilibili-login.js';

const KEY = 'fixture-qrcode-key-123456';
const SESSION_SECRET = 'synthetic-session-secret';
const CSRF_SECRET = 'synthetic-csrf-secret';
const qrUrl = `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${KEY}`;
const response = (data, options = {}) => new Response(JSON.stringify({ code: 0, data }), {
  status: 200, headers: { 'content-type': 'application/json' }, ...options,
});
function confirmed({ buvid = true } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of [
    `SESSDATA=${SESSION_SECRET}; Domain=.bilibili.com; HttpOnly; Secure`,
    `bili_jct=${CSRF_SECRET}; Domain=.bilibili.com; Secure`,
    'DedeUserID=12345; Domain=.bilibili.com',
    ...(buvid ? ['buvid3=fixture-public-buvid3; Domain=.bilibili.com'] : []),
  ]) headers.append('set-cookie', value);
  return response({ code: 0, url: `https://redirect.invalid/?SESSDATA=${SESSION_SECRET}`, refresh_token: 'private-refresh-token' }, { headers });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, extra = {}) {
  let clock = Date.UTC(2026, 9, 22, 9);
  const calls = [];
  const saved = [];
  const queue = [];
  const login = createBilibiliQrLogin({
    now: () => clock,
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'GET');
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(['passport.bilibili.com', 'api.bilibili.com'].includes(target.hostname));
      calls.push({ url: target, options });
      const next = queue.shift();
      if (typeof next === 'function') return await next(target, options);
      if (next) return next;
      if (target.pathname.endsWith('/generate')) return response({ url: qrUrl, qrcode_key: KEY });
      throw new Error('Unmocked request: no live fetch is available');
    },
    saveCookies: async (cookies, { canSave, onCommit }) => {
      assert.equal(canSave(), true);
      onCommit();
      saved.push(cookies);
    },
    ...extra,
  });
  t.after(() => login.stop());
  return { login, calls, saved, queue, advance: (ms = 1300) => { clock += ms; } };
}

test('generate uses fixed endpoint and renders a local GIF without exposing URL or key', async t => {
  const f = fixture(t);
  const started = await f.login.start();
  assert.match(started.id, /^[0-9a-f-]{36}$/);
  assert.equal(started.status, 'waiting');
  assert.equal(started.expiresAt, '2026-10-22T09:03:00.000Z');
  assert.match(started.qrImage, /^data:image\/gif;base64,/);
  const gif = Buffer.from(started.qrImage.split(',')[1], 'base64');
  assert.equal(gif.subarray(0, 6).toString(), 'GIF87a');
  assert.ok(gif.readUInt16LE(6) > 100);
  assert.ok(gif.readUInt16LE(8) > 100);
  assert.equal(f.calls[0].url.href, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  assert.equal(JSON.stringify(started).includes(KEY), false);
  assert.equal(JSON.stringify(started).includes(qrUrl), false);
});

test('current official account scan URL is accepted with the same strict key boundary', async t => {
  const f = fixture(t);
  const currentUrl = `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=fixture&qrcode_key=${KEY}&from=main-fe-header`;
  f.queue.push(response({ url: currentUrl, qrcode_key: KEY }));
  const started = await f.login.start();
  assert.equal(started.status, 'waiting');
  assert.match(started.qrImage, /^data:image\/gif;base64,/);
  assert.equal(JSON.stringify(started).includes(KEY), false);
});

test('waiting/scanned/success map known states and authenticated cookies save only once', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  f.queue.push(response({ code: 86101 }), response({ code: 86090 }), confirmed());
  assert.equal((await f.login.poll(id)).status, 'waiting');
  f.advance();
  assert.equal((await f.login.poll(id)).status, 'scanned');
  f.advance();
  const success = await f.login.poll(id);
  assert.equal(success.status, 'success');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].SESSDATA, SESSION_SECRET);
  assert.equal(f.saved[0].bili_jct, CSRF_SECRET);
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal(f.saved.length, 1);
  assert.equal(f.calls.length, 4);
  assert.doesNotMatch(JSON.stringify(success), /synthetic|SESSDATA|bili_jct|refresh_token|redirect\.invalid/);
});

test('confirmation without buvid3 fetches public finger data before saving credentials', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  f.queue.push(confirmed({ buvid: false }), response({ b_3: 'public-finger-buvid3' }));
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal(f.saved[0].buvid3, 'public-finger-buvid3');
  assert.equal(f.calls.at(-1).url.href, 'https://api.bilibili.com/x/frontend/finger/spi');
});

test('finger failure retains confirmed credentials and retries without polling confirmation again', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  f.queue.push(confirmed({ buvid: false }), () => { throw new Error('private finger error token'); });
  await assert.rejects(f.login.poll(id), /^Error: qrcode_network_error$/);
  assert.equal(f.saved.length, 0);
  f.advance();
  f.queue.push(response({ b_3: 'public-finger-recovered' }));
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/poll')).length, 1);
  assert.equal(f.saved.length, 1);
});

test('poll expiry and local TTL both clean the session', async t => {
  const f = fixture(t);
  const first = await f.login.start();
  f.queue.push(response({ code: 86038 }));
  assert.equal((await f.login.poll(first.id)).status, 'expired');
  assert.equal((await f.login.poll(first.id)).status, 'expired');
  const second = await f.login.start();
  const count = f.calls.length;
  f.advance(180000);
  assert.equal((await f.login.poll(second.id)).status, 'expired');
  assert.equal(f.calls.length, count);
});

test('expiry timer revokes an abandoned session without requiring another poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const { id } = await f.login.start();
  t.mock.timers.tick(180000);
  assert.equal((await f.login.poll(id)).status, 'expired');
  assert.equal(f.calls.length, 1, 'timer expiry must remove the active session even if the injected clock stays fixed');
});

test('poll is single-flight and throttles repeated waiting checks', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  const gate = deferred();
  f.queue.push(() => gate.promise);
  const first = f.login.poll(id);
  const second = f.login.poll(id);
  assert.equal(first, second);
  gate.resolve(response({ code: 86101 }));
  await first;
  await f.login.poll(id);
  assert.equal(f.calls.length, 2);
  f.advance();
  f.queue.push(confirmed());
  await Promise.all([f.login.poll(id), f.login.poll(id)]);
  assert.equal(f.saved.length, 1);
});

test('cancel during a late confirmation prevents saving and expires the prior session', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  const gate = deferred();
  f.queue.push(() => gate.promise);
  const pending = f.login.poll(id);
  f.login.cancel(id);
  gate.resolve(confirmed());
  assert.equal((await pending).status, 'expired');
  assert.equal(f.saved.length, 0);
});

test('new start revokes the previous generation even if its network response arrives late', async t => {
  const f = fixture(t);
  const gate = deferred();
  f.queue.push(() => gate.promise);
  const oldStart = f.login.start();
  const latest = await f.login.start();
  gate.resolve(response({ url: qrUrl, qrcode_key: KEY }));
  await assert.rejects(oldStart, /^Error: qrcode_cancelled$/);
  f.queue.push(response({ code: 86101 }));
  assert.equal((await f.login.poll(latest.id)).status, 'waiting');
});

test('cancel while save preflight awaits invalidates canSave and avoids late persistence', async t => {
  const gate = deferred();
  const entered = deferred();
  const writes = [];
  const f = fixture(t, { saveCookies: async (cookies, { canSave }) => {
    entered.resolve();
    await gate.promise;
    if (canSave()) writes.push(cookies);
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const pending = f.login.poll(id);
  await entered.promise;
  f.login.cancel(id);
  gate.resolve();
  assert.equal((await pending).status, 'expired');
  assert.deepEqual(writes, []);
});

test('stop revokes in-flight work and prevents new sessions', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  f.login.stop();
  assert.equal((await f.login.poll(id)).status, 'expired');
  await assert.rejects(f.login.start(), /^Error: qrcode_cancelled$/);
  assert.equal(f.saved.length, 0);
});

test('busy saves retain pending credentials without consuming failure budget or repeating auth poll', async t => {
  let attempts = 0;
  const f = fixture(t, { saveCookies: async () => {
    attempts++;
    if (attempts <= 4) throw new Error('busy');
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  for (let index = 0; index < 4; index++) {
    await assert.rejects(f.login.poll(id), /^Error: busy$/);
    f.advance();
  }
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal(attempts, 5);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/poll')).length, 1);
});

test('ordinary save failures have a finite retry budget and never expose raw errors', async t => {
  const f = fixture(t, { saveCookies: async () => { throw new Error(`private path ${SESSION_SECRET}`); } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  for (let index = 0; index < 3; index++) {
    await assert.rejects(f.login.poll(id), /^Error: qrcode_save_failed$/);
    f.advance();
  }
  assert.equal((await f.login.poll(id)).status, 'expired');
  assert.equal(f.calls.length, 2);
});

test('HTTP, unexpected platform codes and malformed JSON expose only fixed errors', async t => {
  const f = fixture(t);
  const { id } = await f.login.start();
  for (const [reply, code] of [
    [new Response(`private ${SESSION_SECRET}`, { status: 503 }), 'qrcode_platform_refused'],
    [response({ code: 7777, message: SESSION_SECRET }), 'qrcode_platform_refused'],
    [new Response(`invalid ${SESSION_SECRET}`), 'qrcode_response_invalid'],
  ]) {
    f.queue.push(reply);
    await assert.rejects(f.login.poll(id), error => error.message === code);
    f.advance();
  }
  assert.equal(f.saved.length, 0);
});

test('hard timeout bounds a fetch that ignores abort and late data never saves', async t => {
  const gate = deferred();
  const f = fixture(t, { timeoutMs: 15 });
  f.queue.push(() => gate.promise);
  await assert.rejects(f.login.start(), /^Error: qrcode_timeout$/);
  gate.resolve(response({ url: qrUrl, qrcode_key: KEY }));
  assert.equal(f.saved.length, 0);
});

test('hard timeout also bounds a stalled response body', async t => {
  const f = fixture(t, { timeoutMs: 15 });
  const { id } = await f.login.start();
  let cancelled = false;
  f.queue.push(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(f.login.poll(id), /^Error: qrcode_timeout$/);
  assert.equal(cancelled, true);
  assert.equal(f.saved.length, 0);
});

test('oversized bodies and headers are rejected without returning sensitive content', async t => {
  for (const mode of ['body', 'header']) {
    const f = fixture(t);
    const { id } = await f.login.start();
    f.queue.push(mode === 'body' ? new Response('x'.repeat(32769)) : response({ code: 86101 }, { headers: { 'x-private': 'x'.repeat(32769) } }));
    await assert.rejects(f.login.poll(id), /^Error: qrcode_response_invalid$/);
    assert.equal(f.saved.length, 0);
  }
});

test('missing or foreign-domain confirmation cookies fail closed', async t => {
  for (const headers of [
    { 'set-cookie': `SESSDATA=${SESSION_SECRET}; Domain=.bilibili.com` },
    { 'set-cookie': `SESSDATA=${SESSION_SECRET}; Domain=attacker.example` },
  ]) {
    const f = fixture(t);
    const { id } = await f.login.start();
    f.queue.push(response({ code: 0 }, { headers }));
    await assert.rejects(f.login.poll(id), /^Error: qrcode_login_invalid$/);
    assert.equal(f.saved.length, 0);
  }
});

test('login URL from an unexpected origin is rejected before QR rendering', async t => {
  for (const url of [
    `https://attacker.example/?qrcode_key=${KEY}`,
    `https://passport.bilibili.com:444/h5-app/passport/login/scan?qrcode_key=${KEY}`,
    `https://passport.bilibili.com/other/path?qrcode_key=${KEY}`,
    `https://passport.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=${KEY}`,
    `https://account.bilibili.com/h5-app/passport/login/scan?qrcode_key=${KEY}`,
    `https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=wrong-fixture-key`,
  ]) {
    const f = fixture(t);
    f.queue.push(response({ url, qrcode_key: KEY }));
    await assert.rejects(f.login.start(), /^Error: qrcode_response_invalid$/);
  }
});

test('unexpected redirects are rejected even if an injected fetch follows them', async t => {
  const f = fixture(t);
  const redirected = response({ url: qrUrl, qrcode_key: KEY });
  Object.defineProperty(redirected, 'redirected', { value: true });
  f.queue.push(redirected);
  await assert.rejects(f.login.start(), /^Error: qrcode_platform_refused$/);
});

test('cancellation after commit waits for persistence and returns success without overwriting it', async t => {
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  const f = fixture(t, { saveCookies: async (cookies, { onCommit }) => {
    assert.equal(onCommit(), true);
    entered.resolve();
    await release.promise;
    writes++;
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const pending = f.login.poll(id);
  await entered.promise;
  let cancelled = false;
  const cancelling = f.login.cancel(id).then(result => { cancelled = true; return result; });
  await Promise.resolve();
  assert.equal(cancelled, false, 'cancellation must wait while the atomic rename is in flight');
  assert.equal(f.login.poll(id), pending, 'poll must join the committing request');
  release.resolve();
  assert.equal((await pending).status, 'success');
  assert.equal((await cancelling).status, 'success');
  assert.equal((await f.login.cancel(id)).status, 'success');
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal(writes, 1);
});

test('starting a replacement QR waits until the previous committed save finishes', async t => {
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  const f = fixture(t, { saveCookies: async (cookies, { onCommit }) => {
    onCommit();
    entered.resolve();
    await release.promise;
    writes++;
  } });
  const first = await f.login.start();
  f.queue.push(confirmed());
  const polling = f.login.poll(first.id);
  await entered.promise;
  let generated = false;
  const replacement = f.login.start().then(value => { generated = true; return value; });
  await Promise.resolve();
  assert.equal(generated, false);
  assert.equal(f.calls.length, 2, 'generate must not run before the prior save settles');
  release.resolve();
  assert.equal((await polling).status, 'success');
  const next = await replacement;
  assert.notEqual(next.id, first.id);
  assert.equal(next.status, 'waiting');
  assert.equal(f.calls.length, 3);
  assert.equal(writes, 1);
});

test('stop waits for a committed save and reports its actual successful result', async t => {
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  const f = fixture(t, { saveCookies: async (cookies, { onCommit }) => {
    onCommit();
    entered.resolve();
    await release.promise;
    writes++;
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const polling = f.login.poll(id);
  await entered.promise;
  let stopped = false;
  const stopping = f.login.stop().then(value => { stopped = true; return value; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  assert.equal((await polling).status, 'success');
  assert.equal((await stopping).status, 'success');
  assert.equal((await f.login.poll(id)).status, 'success');
  await assert.rejects(f.login.start(), /^Error: qrcode_cancelled$/);
  assert.equal(writes, 1);
});

test('TTL crossing after commit cannot turn a successful persisted login into expired', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, { saveCookies: async (cookies, { onCommit, canSave }) => {
    onCommit();
    entered.resolve();
    await release.promise;
    assert.equal(canSave(), true, 'the commit boundary keeps the in-flight persistence valid');
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const polling = f.login.poll(id);
  await entered.promise;
  f.advance(181000);
  t.mock.timers.tick(181000);
  assert.equal(f.login.poll(id), polling);
  release.resolve();
  assert.equal((await polling).status, 'success');
  assert.equal((await f.login.poll(id)).status, 'success');
  assert.equal((await f.login.cancel(id)).status, 'success');
});

test('a failed rename releases the commit boundary so cancellation can accurately report expired', async t => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, { saveCookies: async (cookies, { onCommit }) => {
    onCommit();
    entered.resolve();
    await release.promise;
    throw new Error('private rename failure token');
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const polling = f.login.poll(id).catch(error => ({ error: error.message }));
  await entered.promise;
  const cancelling = f.login.cancel(id);
  release.resolve();
  assert.equal((await cancelling).status, 'expired');
  const outcome = await polling;
  assert.ok(outcome.status === 'expired' || outcome.error === 'qrcode_save_failed');
  assert.equal((await f.login.poll(id)).status, 'expired');
  assert.doesNotMatch(JSON.stringify(outcome), /private|token/);
});

test('cancel before commit makes a late onCommit throw before any credential write', async t => {
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  const f = fixture(t, { saveCookies: async (cookies, { onCommit }) => {
    entered.resolve();
    await release.promise;
    onCommit();
    writes++;
  } });
  const { id } = await f.login.start();
  f.queue.push(confirmed());
  const polling = f.login.poll(id);
  await entered.promise;
  assert.equal((await f.login.cancel(id)).status, 'expired');
  release.resolve();
  assert.equal((await polling).status, 'expired');
  assert.equal(writes, 0);
});
