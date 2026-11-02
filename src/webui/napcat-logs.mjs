import { createHash } from 'node:crypto';
import { readNapcatSettings } from '../napcat-health.js';
import { redactSecrets } from '../redact.js';

const DEFAULT_IDLE_TTL_MS = 30_000;
const DEFAULT_AUTH_TIMEOUT_MS = 2_500;
const DEFAULT_READ_WAIT_MS = 150;
const MAX_CREDENTIAL_CHARS = 16_384;
const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_RING_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 32 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;

const MESSAGES = Object.freeze({
  closed: 'NapCat 实时日志 reader 已关闭',
  unavailable: 'NapCat 实时日志暂不可用',
  auth: 'NapCat WebUI 认证不可用，实时日志暂不可用',
  forbidden: 'NapCat WebUI 认证失败，实时日志暂不可用',
  protocol: 'NapCat 实时日志数据超出安全上限，连接已关闭',
  waiting: '正在等待 NapCat 实时日志连接或新事件',
  connected: 'NapCat 实时日志连接中',
});

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function fixedError(code) {
  return Object.assign(new Error(code), { code });
}

function safeCancel(response) {
  try { response?.body?.cancel?.().catch(() => {}); } catch { /* The stream may already be locked or closed. */ }
}

/**
 * Read the NapCat WebUI SSE stream. The bounded ring contains only events
 * received by this reader's current connection; NapCat may replay its own
 * in-memory subscription history when the connection starts.
 */
export function createNapcatLogReader({
  root,
  config,
  healthProbe,
  readSettings = readNapcatSettings,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  readWaitMs = DEFAULT_READ_WAIT_MS,
  maxLines = DEFAULT_MAX_LINES,
  maxRingBytes = DEFAULT_MAX_RING_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
} = {}) {
  const projectRoot = root;
  const limits = {
    idleTtlMs: boundedInteger(idleTtlMs, DEFAULT_IDLE_TTL_MS, 10, 300_000),
    authTimeoutMs: boundedInteger(authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, 50, 15_000),
    readWaitMs: boundedInteger(readWaitMs, DEFAULT_READ_WAIT_MS, 10, 1_500),
    maxLines: boundedInteger(maxLines, DEFAULT_MAX_LINES, 1, 2_000),
    maxRingBytes: boundedInteger(maxRingBytes, DEFAULT_MAX_RING_BYTES, 1_024, 1_048_576),
    maxEventBytes: boundedInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 128, 128 * 1024),
    maxChunkBytes: boundedInteger(maxChunkBytes, DEFAULT_MAX_CHUNK_BYTES, 128, 256 * 1024),
  };

  const ring = [];
  const pendingControllers = new Set();
  let ringBytes = 0;
  let active = null;
  let opening = null;
  let idleTimer = null;
  let lastReadAt = 0;
  let lastUpdatedAt = null;
  let lastFailureCode = '';
  let lastCredential = '';
  let lastSettings = null;
  let closed = false;

  function currentTime() {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch { return Date.now(); }
  }

  function timestamp() {
    try { return new Date(currentTime()).toISOString(); } catch { return null; }
  }

  function endpointFor(settings) {
    if (!settings?.webuiEnabled || typeof settings.token !== 'string' || !settings.token) {
      throw fixedError('auth');
    }
    let base;
    try { base = new URL(settings.baseUrl); } catch { throw fixedError('unavailable'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw fixedError('unavailable');
    }
    const baseUrl = base.origin;
    const key = createHash('sha256').update(`${baseUrl}\0${settings.token}`).digest('hex');
    return { url: new URL('/api/Log/GetLogRealTime', baseUrl).toString(), key };
  }

  async function credentialFor(force, expectedKey) {
    if (!healthProbe || typeof healthProbe.check !== 'function' || typeof healthProbe.exportSession !== 'function') {
      throw fixedError('auth');
    }
    let timer = null;
    try {
      const checking = Promise.resolve().then(() => healthProbe.check({ force }));
      await Promise.race([
        checking,
        new Promise((_, reject) => {
          timer = setTimer(() => reject(fixedError('auth-timeout')), limits.authTimeoutMs);
        }),
      ]);
    } catch { /* A still-valid in-memory session can serve the stream. */ }
    finally { if (timer !== null) clearTimer(timer); }

    let session;
    try { session = healthProbe.exportSession(); } catch { throw fixedError('auth'); }
    const credential = session?.credential;
    if (session?.key !== expectedKey || typeof credential !== 'string' || !credential || credential.length > MAX_CREDENTIAL_CHARS
      || !(Number(session?.expiresAt) > currentTime())) {
      throw fixedError('auth');
    }
    lastCredential = credential;
    return credential;
  }

  function responseSnapshot(limit, missing, message, { empty = false } = {}) {
    return {
      lines: empty ? [] : ring.slice(-limit).map((line) => line),
      missing,
      message,
      updatedAt: empty ? null : lastUpdatedAt,
    };
  }

  function messageFor(code) {
    if (code === 'auth') return MESSAGES.auth;
    if (code === 'forbidden') return MESSAGES.forbidden;
    if (code === 'protocol') return MESSAGES.protocol;
    if (code === 'closed') return MESSAGES.closed;
    if (code === 'idle') return MESSAGES.waiting;
    return MESSAGES.unavailable;
  }

  function safeLine(value) {
    let line = redactSecrets(value, 4_000);
    for (const secret of [lastCredential, lastSettings?.token]) {
      if (typeof secret === 'string' && secret.length > 0) line = line.split(secret).join('***');
    }
    line = line
      .replace(/([?&](?:napcat[_-]?)?webui[_-]?token=)[^&\s"'#]+/gi, '$1***')
      .replace(/((?:napcat[_-]?)?(?:webui[_-]?)?token["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1***')
      .replace(/((?:napcat[_-]?)?credential["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1***');
    return line;
  }

  function appendLine(line) {
    const bytes = utf8Bytes(line);
    if (!line || bytes > limits.maxRingBytes) return;
    ring.push(line);
    ringBytes += bytes;
    while (ring.length > limits.maxLines || ringBytes > limits.maxRingBytes) {
      ringBytes -= utf8Bytes(ring.shift());
    }
    lastUpdatedAt = timestamp();
  }

  function addEvent(block) {
    if (utf8Bytes(block) > limits.maxEventBytes) throw fixedError('protocol');
    const data = [];
    for (const row of block.split(/\r\n|\r|\n/)) {
      if (!row || row.startsWith(':')) continue;
      const colon = row.indexOf(':');
      const field = colon < 0 ? row : row.slice(0, colon);
      if (field !== 'data') continue;
      let value = colon < 0 ? '' : row.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
    }
    if (!data.length) return;
    const payload = data.join('\n');
    if (utf8Bytes(payload) > limits.maxEventBytes) throw fixedError('protocol');
    let event;
    let parsed = true;
    try { event = JSON.parse(payload); } catch { event = payload; parsed = false; }
    const structured = parsed && event && typeof event === 'object' && !Array.isArray(event);
    const message = typeof event === 'string' ? event
      : structured && Object.hasOwn(event, 'message')
        ? typeof event.message === 'string' ? event.message
          : event.message == null ? '' : JSON.stringify(event.message)
        : payload;
    if (!message) return;
    const level = structured && typeof event.level === 'string' ? event.level.replace(/[\r\n]/g, ' ').slice(0, 32) : '';
    const oneLine = message.replace(/[\r\n\u2028\u2029]+/g, ' ');
    appendLine(safeLine(`${level ? `[${level}] ` : ''}${oneLine}`));
  }

  function stopState(state, code = '') {
    if (active === state) active = null;
    if (code) lastFailureCode = code;
    try { state.controller.abort(); } catch { /* Already closed. */ }
    try { state.reader.cancel().catch(() => {}); } catch { /* The stream may already be closed. */ }
  }

  async function consume(state) {
    const decoder = new TextDecoder();
    let buffer = '';
    let failureCode = '';
    try {
      while (!closed && active === state) {
        const { done, value } = await state.reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength > limits.maxChunkBytes) {
          failureCode = 'protocol';
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
          if (!match) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          addEvent(block);
        }
        if (utf8Bytes(buffer) > limits.maxEventBytes) {
          failureCode = 'protocol';
          break;
        }
      }
    } catch (error) {
      failureCode = error?.code === 'protocol' ? 'protocol' : 'unavailable';
    } finally {
      if (active === state) {
        active = null;
        if (!closed && failureCode) lastFailureCode = failureCode;
        if (!closed && !failureCode && !state.controller.signal.aborted) lastFailureCode = 'unavailable';
      }
      try { state.controller.abort(); } catch { /* Already closed. */ }
      try { state.reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
    }
  }

  function assertAttempt(attempt) {
    if (closed || attempt.cancelReason === 'closed') throw fixedError('closed');
    if (attempt.cancelled) throw fixedError('idle');
  }

  async function boundedFetch(url, credential, attempt) {
    assertAttempt(attempt);
    if (typeof fetchImpl !== 'function') throw fixedError('unavailable');
    const controller = new AbortController();
    pendingControllers.add(controller);
    const request = Promise.resolve().then(() => fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${credential}`,
      },
    }));
    try {
      const response = await request;
      assertAttempt(attempt);
      return { response, controller };
    } catch (error) {
      controller.abort();
      pendingControllers.delete(controller);
      request.then(safeCancel).catch(() => {});
      if (attempt.cancelled || closed) throw fixedError(attempt.cancelReason === 'closed' || closed ? 'closed' : 'idle');
      throw fixedError(error?.code === 'closed' ? 'closed' : 'unavailable');
    }
  }

  function discard(opened) {
    if (!opened) return;
    pendingControllers.delete(opened.controller);
    opened.controller.abort();
    safeCancel(opened.response);
  }

  async function connect(attempt) {
    assertAttempt(attempt);
    let settings;
    try { settings = readSettings(projectRoot, config); } catch { throw fixedError('unavailable'); }
    lastSettings = { token: typeof settings?.token === 'string' ? settings.token : '' };
    const { url, key } = endpointFor(settings);
    let credential = await credentialFor(false, key);
    assertAttempt(attempt);
    let opened = await boundedFetch(url, credential, attempt);
    try { assertAttempt(attempt); } catch (error) { discard(opened); throw error; }
    if (opened.response.status === 401 || opened.response.status === 403) {
      discard(opened);
      opened = null;
      credential = await credentialFor(true, key);
      assertAttempt(attempt);
      opened = await boundedFetch(url, credential, attempt);
      try { assertAttempt(attempt); } catch (error) { discard(opened); throw error; }
      if (opened.response.status === 401 || opened.response.status === 403) {
        discard(opened);
        throw fixedError('forbidden');
      }
    }
    const response = opened.response;
    const contentType = response.headers?.get?.('content-type') || '';
    if (!response.ok || !/^text\/event-stream\b/i.test(contentType) || !response.body?.getReader) {
      discard(opened);
      throw fixedError(response.ok ? 'unavailable' : 'unavailable');
    }
    let reader;
    try { reader = response.body.getReader(); } catch { discard(opened); throw fixedError('unavailable'); }
    const state = { controller: opened.controller, reader };
    pendingControllers.delete(opened.controller);
    if (closed) {
      stopState(state, 'closed');
      throw fixedError('closed');
    }
    active = state;
    lastFailureCode = '';
    state.consumePromise = consume(state);
    return state;
  }

  function clearRing() {
    ring.length = 0;
    ringBytes = 0;
    lastUpdatedAt = null;
  }

  function ensureConnected() {
    if (active) return Promise.resolve(active);
    if (opening) return opening.promise;
    clearRing();
    lastFailureCode = '';
    const attempt = { cancelled: false, cancelReason: '', promise: null };
    opening = attempt;
    attempt.promise = connect(attempt);
    attempt.promise.then(
      () => { if (opening === attempt) opening = null; },
      (error) => {
        if (opening === attempt) opening = null;
        if (!closed && !attempt.cancelled) lastFailureCode = error?.code || 'unavailable';
      },
    );
    return attempt.promise;
  }

  async function waitForOpen(promise) {
    let timer = null;
    const settled = promise.then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    );
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve({ settled: false }), limits.readWaitMs);
    });
    try { return await Promise.race([settled, timeout]); }
    finally { if (timer !== null) clearTimer(timer); }
  }

  function idleTick() {
    idleTimer = null;
    if (closed) return;
    const remaining = limits.idleTtlMs - (currentTime() - lastReadAt);
    if (remaining > 0) {
      idleTimer = setTimer(idleTick, remaining);
      return;
    }
    if (active) stopState(active);
    if (opening) {
      opening.cancelled = true;
      opening.cancelReason = 'idle';
      for (const controller of pendingControllers) controller.abort();
    }
  }

  function scheduleIdleClose() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(idleTick, limits.idleTtlMs);
  }

  async function read(limit = 200) {
    const count = boundedInteger(limit, 200, 1, 1_000);
    if (closed) return responseSnapshot(count, true, MESSAGES.closed);
    lastReadAt = currentTime();
    if (!active && !opening && lastFailureCode) {
      const code = lastFailureCode;
      lastFailureCode = '';
      return responseSnapshot(count, true, messageFor(code), { empty: true });
    }
    let outcome = { settled: true };
    if (!active) outcome = await waitForOpen(ensureConnected());
    if (closed) return responseSnapshot(count, true, MESSAGES.closed);
    if (!outcome.settled) {
      lastReadAt = currentTime();
      scheduleIdleClose();
      return responseSnapshot(count, false, MESSAGES.waiting, { empty: true });
    }
    if (outcome.error) {
      const code = outcome.error?.code || lastFailureCode || 'unavailable';
      if (lastFailureCode === code) lastFailureCode = '';
      return responseSnapshot(count, true, messageFor(code), { empty: true });
    }
    lastReadAt = currentTime();
    scheduleIdleClose();
    if (!active) {
      const code = lastFailureCode || 'unavailable';
      lastFailureCode = '';
      return responseSnapshot(count, true, messageFor(code), { empty: true });
    }
    return responseSnapshot(count, false, ring.length ? MESSAGES.connected : MESSAGES.waiting);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    if (opening) {
      opening.cancelled = true;
      opening.cancelReason = 'closed';
    }
    for (const controller of pendingControllers) controller.abort();
    pendingControllers.clear();
    if (active) stopState(active, 'closed');
    ring.length = 0;
    ringBytes = 0;
    lastCredential = '';
    lastSettings = null;
    lastUpdatedAt = null;
  }

  return { read, close };
}
