import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { OneBot } from './onebot.js';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

export function readNapcatSettings(root, config) {
  config ??= readJson(process.env.QQ_CONFIG || path.join(root, 'config.json'));
  const files = [path.join(root, 'napcat', 'napcat', 'config', 'webui.json'), path.join(root, 'napcat', 'config', 'webui.json')];
  const file = files.find((candidate) => fs.existsSync(candidate));
  const webui = file ? readJson(file) : {};
  let host = String(webui.host || '127.0.0.1');
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '[::1]';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  let baseUrl = '';
  try {
    const url = new URL(config?.napcat?.webui || `http://${host}:${Number(webui.port) || 6099}`);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) baseUrl = url.origin;
  } catch { /* Invalid endpoints remain unavailable, never authenticated. */ }
  return {
    baseUrl,
    webuiEnabled: Boolean(baseUrl && (file || config?.napcat?.webui) && !webui.disableWebUI),
    token: String(config?.napcat?.webuiToken || webui.token || ''),
    onebotUrl: String(config?.onebot?.url || ''),
    accessToken: String(config?.onebot?.accessToken || ''),
  };
}

const DETAILS = Object.freeze({
  online: 'QQ 在线状态已确认',
  offline: 'QQ 已离线，等待恢复连接',
  reconnecting: 'QQ 正在恢复连接',
  starting: 'QQ 登录正在初始化',
  'login-required': 'QQ 需要在 NapCat 登录页重新确认',
  stopped: 'NapCat 进程未运行',
  unknown: '暂时无法确认 QQ 登录状态',
});
const PHASES = new Set(['ready', 'offline', 'reconnecting', 'initializing', 'qrcode_scanned', 'waiting_qrcode', 'generating_qrcode']);
const failure = (code) => Object.assign(new Error(code), { code });

function result(state, source, { phase = '', account = '', nickname = '', errorCode = '', reachable = false } = {}) {
  return {
    state, source, known: !['unknown', 'stopped'].includes(state), loggedIn: state === 'online',
    phase, account, nickname, errorCode, reachable, detail: DETAILS[state], checkedAt: new Date().toISOString(),
  };
}

function fromWebui(data) {
  const phase = PHASES.has(data?.loginPhase) ? data.loginPhase : '';
  if (data?.isLogin === true && data?.isOffline !== true) return result('online', 'webui', { phase, reachable: true });
  if (data?.isLogin !== false) throw failure('webui-invalid-status');
  let state = 'offline';
  if (phase === 'reconnecting') state = 'reconnecting';
  else if (['initializing', 'qrcode_scanned', 'generating_qrcode'].includes(phase)) state = 'starting';
  else if (phase === 'waiting_qrcode' || data.loginError) state = 'login-required';
  return result(state, 'webui', { phase, reachable: true });
}

function identity(data, source) {
  const account = String(source === 'onebot' ? (data?.user_id ?? '') : (data?.uin ?? ''));
  return {
    account: /^\d{5,20}$/.test(account) ? account : '',
    nickname: typeof (data?.nickname ?? data?.nick) === 'string'
      ? String(data.nickname ?? data.nick).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '',
  };
}

/** One deadline covers connection, status and optional identity; no reconnect loop. */
export async function probeNapcatOnebot(settings, signal, deadline) {
  const bot = new OneBot({ url: settings.onebotUrl, accessToken: settings.accessToken, reconnect: false });
  let cancelReady;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await new Promise((resolve, reject) => {
      const failed = () => reject(failure('onebot-unavailable'));
      cancelReady = () => {
        bot.off('ready', ready);
        bot.off('error', failed);
        bot.off('disconnect', failed);
        signal.removeEventListener('abort', failed);
      };
      const ready = () => { cancelReady(); resolve(); };
      bot.once('ready', ready);
      bot.once('error', failed);
      bot.once('disconnect', failed);
      signal.addEventListener('abort', failed, { once: true });
      if (signal.aborted) failed(); else bot.connect();
    });
    // OneBot emits error events even when a peer drops during an API call.
    bot.on('error', () => {});
    const close = () => bot.close();
    signal.addEventListener('abort', close, { once: true });
    try {
      const status = await bot.call('get_status', {}, { timeoutMs: remaining() });
      if (typeof status?.online !== 'boolean') throw failure('onebot-invalid-status');
      const health = result(status.online ? 'online' : 'offline', 'onebot', { reachable: true });
      if (health.loggedIn && !signal.aborted) {
        try {
          Object.assign(health, identity(await bot.call('get_login_info', {}, { timeoutMs: Math.min(400, remaining()) }), 'onebot'));
        } catch { /* Identity is optional; an account alone never proves online. */ }
      }
      return health;
    } finally { signal.removeEventListener('abort', close); }
  } finally {
    cancelReady?.();
    bot.on('error', () => {});
    bot.close();
  }
}

async function checkOnebot(settings, signal, deadline) {
  if (signal.aborted) throw failure('onebot-unavailable');
  // A peer can ignore WebSocket close indefinitely. Terminating a dedicated
  // worker bounds both the probe and its network handles in the console/CLI.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./napcat-health-onebot.js', import.meta.url), {
      workerData: { url: settings.onebotUrl, accessToken: settings.accessToken, deadline },
      execArgv: [],
    });
    let finished = false;
    const finish = async (error, health) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', aborted);
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(health);
    };
    const aborted = () => { void finish(failure('onebot-unavailable')); };
    signal.addEventListener('abort', aborted, { once: true });
    worker.once('message', (message) => {
      void finish(message.ok ? null : failure('onebot-unavailable'), message.health);
    });
    worker.once('error', () => { void finish(failure('onebot-unavailable')); });
    worker.once('exit', () => { void finish(failure('onebot-unavailable')); });
    if (signal.aborted) aborted();
  });
}

/** Shared by the console and the PowerShell helper. Credentials stay in memory. */
export function createNapcatHealth({ root, config, timeoutMs = 2500, cacheMs = 2000, session: initialSession, onResult } = {}) {
  let session = initialSession;
  let cached;
  let pending;
  let controller;
  let cachedAt = 0;
  let cachedRunning;

  async function probe(running) {
    const settings = readNapcatSettings(root, config);
    const key = createHash('sha256').update(`${settings.baseUrl}\0${settings.token}`).digest('hex');
    if (session?.key !== key) session = { key };
    controller = new AbortController();
    const signal = controller.signal;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    const webuiController = new AbortController();
    const webuiSignal = AbortSignal.any([signal, webuiController.signal]);
    let webuiTimer;
    let errorCode = 'health-unavailable';
    let reachable = false;

    async function post(endpoint, body, credential) {
      let response;
      try {
        response = await fetch(`${settings.baseUrl}/api${endpoint}`, {
          method: 'POST', redirect: 'error', signal: webuiSignal,
          headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
          body: JSON.stringify(body),
        });
      } catch { throw failure('webui-unavailable'); }
      reachable = true;
      if (response.status === 401 || response.status === 403) throw failure('webui-unauthorized');
      if (!response.ok) throw failure('webui-unavailable');
      let json;
      try { json = await response.json(); } catch { throw failure(webuiSignal.aborted ? 'webui-unavailable' : 'webui-invalid-response'); }
      if (json?.code !== 0) {
        const unauthorized = /unauthorized|authorization failed|token has been revoked/i.test(String(json?.message || ''));
        throw failure(unauthorized ? 'webui-unauthorized' : 'webui-request-failed');
      }
      return json.data;
    }

    async function credential() {
      if (typeof session.credential === 'string' && session.credential && session.expiresAt > Date.now()) return session.credential;
      if (session.retryAt > Date.now()) throw failure(session.errorCode || 'webui-auth-failed');
      try {
        const data = await post('/auth/login', { hash: createHash('sha256').update(`${settings.token}.napcat`).digest('hex') });
        if (data?.require2FA) throw failure('webui-2fa-required');
        if (typeof data?.Credential !== 'string' || !data.Credential || data.Credential.length > 16_384) throw failure('webui-auth-failed');
        session = { key, credential: data.Credential, expiresAt: Date.now() + 50 * 60_000 };
        return session.credential;
      } catch (error) {
        if (error.code !== 'webui-unavailable') session = { key, retryAt: Date.now() + 60_000, errorCode: error.code };
        throw error;
      }
    }

    try {
      if (settings.webuiEnabled && settings.token) {
        if (settings.onebotUrl) webuiTimer = setTimeout(() => webuiController.abort(), Math.floor(timeoutMs * 0.6));
        try {
          let data;
          try { data = await post('/QQLogin/CheckLoginStatus', {}, await credential()); }
          catch (error) {
            if (error.code !== 'webui-unauthorized' || !session.credential) throw error;
            // A worker restart changes NapCat's signing key; refresh once.
            session = { key };
            data = await post('/QQLogin/CheckLoginStatus', {}, await credential());
          }
          const health = fromWebui(data);
          if (health.loggedIn && !signal.aborted) {
            try {
              const info = await post('/QQLogin/GetQQLoginInfo', {}, session.credential);
              if (info?.online === false) return result('offline', 'webui', { phase: 'offline', reachable: true });
              Object.assign(health, identity(info, 'webui'));
            } catch { /* The explicit status is sufficient without nickname. */ }
          }
          return health;
        } catch (error) { errorCode = error.code || 'webui-unavailable'; }
        finally { clearTimeout(webuiTimer); }
      } else if (settings.webuiEnabled) errorCode = 'webui-token-missing';
      if (settings.onebotUrl && !signal.aborted) {
        try { return await checkOnebot(settings, signal, deadline); }
        catch (error) {
          if (errorCode === 'health-unavailable') errorCode = error.code || 'onebot-unavailable';
        }
      }
      return result(running === false && !reachable ? 'stopped' : 'unknown', '', { errorCode, reachable });
    } finally {
      clearTimeout(timer);
      clearTimeout(webuiTimer);
      controller = null;
    }
  }

  return {
    async check({ running, force = false } = {}) {
      if (pending) return pending;
      if (!force && cached && running === cachedRunning && Date.now() - cachedAt < cacheMs) return { ...cached };
      pending = probe(running).then((health) => {
        cached = health;
        cachedAt = Date.now();
        cachedRunning = running;
        try { onResult?.(health); } catch { /* Telemetry cannot change login state. */ }
        return { ...health };
      }).finally(() => { pending = null; });
      return pending;
    },
    // Used only for a private stdin/stdout exchange with a reusable PS runspace.
    exportSession() { return session ? { ...session } : null; },
    close() { controller?.abort(); cached = null; },
  };
}

/** Keep evidence across console restarts without copying QR codes or identities. */
export function createNapcatHealthJournal({ logDir, maxBytes = 2 * 1024 * 1024, heartbeatMs = 60_000 } = {}) {
  const file = path.join(logDir, 'napcat-health.jsonl');
  let lastKey = '';
  let lastAt = 0;
  return (health) => {
    const entry = Object.fromEntries(['state', 'source', 'phase', 'known', 'loggedIn', 'errorCode'].map((key) => [key, health[key]]));
    const key = JSON.stringify(entry);
    if (key === lastKey && Date.now() - lastAt < heartbeatMs) return;
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
      if (fs.existsSync(`${file}.2`)) fs.rmSync(`${file}.2`);
      if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: health.checkedAt, ...entry })}\n`, { mode: 0o600 });
    lastKey = key;
    lastAt = Date.now();
  };
}
