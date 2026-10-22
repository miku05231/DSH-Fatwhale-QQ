import { randomUUID } from 'node:crypto';
import { qrcode } from '../third-party/qrcode-generator/qrcode.mjs';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const FINGER_URL = 'https://api.bilibili.com/x/frontend/finger/spi';
const TTL_MS = 180000;
const POLL_GAP_MS = 1200;
const MAX_BODY_BYTES = 32768;
const QR_SCAN_PATHS = new Map([
  ['passport.bilibili.com', '/h5-app/passport/login/scan'],
  ['account.bilibili.com', '/h5/account-h5/auth/scan-web'],
]);
const COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']);
const SAFE_ERRORS = new Set([
  'qrcode_network_error', 'qrcode_timeout', 'qrcode_response_invalid', 'qrcode_platform_refused',
  'qrcode_login_invalid', 'qrcode_save_failed', 'qrcode_cancelled', 'qrcode_session_invalid', 'busy',
]);

function fail(code) { return new Error(code); }
function safeError(error, fallback = 'qrcode_network_error') {
  return fail(SAFE_ERRORS.has(error?.message) ? error.message : fallback);
}

async function boundedJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BODY_BYTES) throw fail('qrcode_response_invalid');
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('qrcode_response_invalid');
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { cancel(); throw fail('qrcode_response_invalid'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('qrcode_response_invalid'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function loginCookies(headers) {
  const values = headers?.getSetCookie?.();
  if (!Array.isArray(values) || values.length > 40 || values.reduce((size, value) => size + String(value).length, 0) > MAX_BODY_BYTES) {
    throw fail('qrcode_login_invalid');
  }
  const cookies = {};
  for (const header of values) {
    if (typeof header !== 'string' || header.length > 8192 || /[\r\n\x00]/.test(header)) throw fail('qrcode_login_invalid');
    const [pair, ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    if (!COOKIE_NAMES.has(name)) continue;
    const domain = attributes.find(value => /^\s*domain\s*=/i.test(value));
    if (domain && !/^\s*domain\s*=\s*\.?(?:passport\.)?bilibili\.com\s*$/i.test(domain)) throw fail('qrcode_login_invalid');
    const value = pair.slice(separator + 1).trim();
    if (!value || /[\x00-\x20\x7f]/.test(value)) throw fail('qrcode_login_invalid');
    cookies[name] = value;
  }
  if (!cookies.SESSDATA || !/^[a-zA-Z0-9_-]{1,128}$/.test(cookies.bili_jct ?? '')) throw fail('qrcode_login_invalid');
  return cookies;
}

/** Single active Web QR login. Credentials and Bilibili keys never leave this closure. */
export function createBilibiliQrLogin({
  fetchImpl = globalThis.fetch, saveCookies, now = () => Date.now(), timeoutMs = 10000,
} = {}) {
  let active = null;
  let stopped = false;
  const timeout = Math.max(1, Math.min(30000, Number(timeoutMs) || 10000));
  const current = session => active === session && !session.cancelled &&
    (session.committing || session.saved || (now() < session.expiresAt && !stopped));
  const view = (session, status = session.status) => ({ status, expiresAt: new Date(session.expiresAt).toISOString() });
  function revoke(session) {
    if (!session || session.committing) return;
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
    session.cancelled = true;
    session.key = '';
    session.cookies = null;
    for (const controller of session.controllers) controller.abort();
  }
  function assertCurrent(session) { if (!current(session)) throw fail('qrcode_cancelled'); }
  function armExpiry(session) {
    if (session.saved || session.committing || session.cancelled) return;
    const remaining = Math.max(0, session.expiresAt - now());
    session.expiryTimer = setTimeout(() => {
      if (session.committing || session.saved) return;
      revoke(session);
      if (active === session) active = null;
    }, remaining);
    session.expiryTimer.unref?.();
  }
  async function settleCommit(session) {
    while (session.committing && session.pendingSave) {
      try { await session.pendingSave; } catch { /* A failed rename can still be cancelled. */ }
    }
  }

  async function request(url, session) {
    assertCurrent(session);
    const controller = new AbortController();
    session.controllers.add(controller);
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json', referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0 qq-bridge/0.2' },
          });
          assertCurrent(session);
          if (!response?.ok || response.redirected) throw fail('qrcode_platform_refused');
          let headerBytes = 0;
          for (const [name, value] of response.headers?.entries?.() ?? []) {
            headerBytes += name.length + value.length;
            if (headerBytes > MAX_BODY_BYTES) throw fail('qrcode_response_invalid');
          }
          const body = await boundedJson(response, controller.signal);
          assertCurrent(session);
          if (!body || body.code !== 0 || !body.data || typeof body.data !== 'object') throw fail('qrcode_platform_refused');
          return { data: body.data, headers: response.headers };
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(fail('qrcode_timeout')); }, timeout);
        }),
      ]);
    } catch (error) {
      assertCurrent(session);
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      session.controllers.delete(controller);
    }
  }

  async function start() {
    while (active?.committing) await settleCommit(active);
    if (stopped) throw fail('qrcode_cancelled');
    revoke(active);
    const session = {
      id: randomUUID(), expiresAt: now() + TTL_MS, status: 'waiting', key: '', cookies: null,
      controllers: new Set(), lastPollAt: -Infinity, inFlight: null, pendingSave: null,
      saveAttempts: 0, saved: false, committing: false,
    };
    active = session;
    armExpiry(session);
    try {
      const { data } = await request(GENERATE_URL, session);
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(String(data.qrcode_key ?? '')) || typeof data.url !== 'string' || data.url.length > 2048) {
        throw fail('qrcode_response_invalid');
      }
      let url;
      try { url = new URL(data.url); } catch { throw fail('qrcode_response_invalid'); }
      if (url.protocol !== 'https:' || QR_SCAN_PATHS.get(url.hostname) !== url.pathname || url.port || url.username || url.password ||
          url.searchParams.get('qrcode_key') !== data.qrcode_key) throw fail('qrcode_response_invalid');
      const image = qrcode(0, 'M');
      image.addData(data.url);
      image.make();
      assertCurrent(session);
      session.key = data.qrcode_key;
      return { id: session.id, qrImage: image.createDataURL(5, 20), ...view(session) };
    } catch (error) {
      revoke(session);
      if (active === session) active = null;
      throw safeError(error, 'qrcode_response_invalid');
    }
  }

  async function finish(session) {
    assertCurrent(session);
    if (!session.cookies.buvid3) {
      const { data } = await request(FINGER_URL, session);
      if (typeof data.b_3 !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(data.b_3)) throw fail('qrcode_login_invalid');
      session.cookies.buvid3 = data.b_3;
    }
    assertCurrent(session);
    if (typeof saveCookies !== 'function') throw fail('qrcode_save_failed');
    try {
      // The storage callback invokes onCommit synchronously immediately before rename.
      // From that point cancellation waits for the actual persistence result.
      const pending = Promise.resolve().then(async () => {
        await saveCookies({ ...session.cookies }, {
          canSave: () => current(session),
          onCommit: () => {
            assertCurrent(session);
            session.committing = true;
            clearTimeout(session.expiryTimer);
            session.expiryTimer = null;
            return true;
          },
        });
        assertCurrent(session);
        session.saved = true;
        session.key = '';
        session.cookies = null;
        session.status = 'success';
        clearTimeout(session.expiryTimer);
        session.expiryTimer = null;
        return view(session);
      }).finally(() => {
        session.committing = false;
        if (session.pendingSave === pending) session.pendingSave = null;
        if (!session.saved && active === session && !session.cancelled) {
          if (stopped || now() >= session.expiresAt) { revoke(session); active = null; }
          else if (!session.expiryTimer) armExpiry(session);
        }
      });
      session.pendingSave = pending;
      return await pending;
    } catch (error) {
      if (!current(session)) return view(session, 'expired');
      if (error?.message === 'busy') throw fail('busy');
      session.saveAttempts++;
      if (session.saveAttempts >= 3) {
        session.terminalError = 'qrcode_save_failed';
        revoke(session);
        if (active === session) active = null;
        throw fail('qrcode_save_failed');
      }
      throw safeError(error, 'qrcode_save_failed');
    }
  }

  async function performPoll(session) {
    try {
      if (session.cookies) return await finish(session);
      const url = new URL(POLL_URL);
      url.searchParams.set('qrcode_key', session.key);
      const { data, headers } = await request(url, session);
      if (data.code === 86101 || data.code === 86090) {
        session.status = data.code === 86101 ? 'waiting' : 'scanned';
        return view(session);
      }
      if (data.code === 86038) {
        revoke(session);
        if (active === session) active = null;
        return view(session, 'expired');
      }
      if (data.code !== 0) throw fail('qrcode_platform_refused');
      session.cookies = loginCookies(headers);
      session.key = '';
      session.status = 'scanned';
      return await finish(session);
    } catch (error) {
      if (session.terminalError) throw fail(session.terminalError);
      if (!current(session)) return view(session, 'expired');
      throw safeError(error);
    }
  }

  function poll(id) {
    const session = active;
    if (!session || session.id !== id) return Promise.resolve({ status: 'expired' });
    if (session.saved) return Promise.resolve(view(session, 'success'));
    if (session.inFlight) return session.inFlight;
    if (!current(session)) { revoke(session); active = null; return Promise.resolve(view(session, 'expired')); }
    if (now() - session.lastPollAt < POLL_GAP_MS) return Promise.resolve(view(session));
    session.lastPollAt = now();
    session.inFlight = performPoll(session).finally(() => { session.inFlight = null; });
    return session.inFlight;
  }

  async function cancel(id) {
    const session = active;
    if (!session || session.id !== id) return { status: 'expired' };
    if (session.committing) await settleCommit(session);
    if (session.saved) return view(session, 'success');
    if (active === session) { revoke(session); active = null; }
    return { status: 'expired' };
  }
  async function stop() {
    stopped = true;
    const session = active;
    if (!session) return { status: 'expired' };
    if (session.committing) await settleCommit(session);
    if (session.saved) return view(session, 'success');
    if (active === session) { revoke(session); active = null; }
    return { status: 'expired' };
  }
  return { start, poll, cancel, stop };
}
