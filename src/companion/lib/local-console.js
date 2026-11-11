import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { openLocalConsoleUrl } from './browser-opener.js';

export const CONSOLE_PAGES = Object.freeze(['overview', 'memory', 'stickers', 'persona', 'sessions', 'model', 'plugins', 'automation', 'system']);
const GRANT_MS = 60_000;
const SESSION_MS = 8 * 60 * 60_000;
function isLoopbackAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
}
const digest = token => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const content = Buffer.from(body);
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': content.length, ...extra });
  res.end(content);
}
function fail(res, status, error) {
  send(res, status, JSON.stringify({ ok: false, error }));
}

async function readGrant(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024) return null;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body)
      && Object.keys(body).length === 1 && typeof body.grant === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(body.grant) ? body.grant : null;
  } catch {
    return null;
  }
}

/** One ephemeral listener per mounted console; no second bot or updater. */
export function createLocalConsole({ handle, openBrowser = openLocalConsoleUrl, now = Date.now, prefix = '/qq-bridge' } = {}) {
  if (typeof handle !== 'function') throw new TypeError('console handler is required');
  const grants = new Map();
  const sessions = new Map();
  let server = null;
  let starting = null;
  let closing = null;
  let disposed = false;
  let origin = '';
  let cookieName = '';

  function prune() {
    for (const [key, value] of grants) if (value.expires <= now()) grants.delete(key);
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
  }

  const authScript = `const fragment = new URLSearchParams(location.hash.slice(1));
const grant = fragment.get('grant');
history.replaceState(null, '', location.pathname);
try {
  const response = await fetch('${prefix}/api/console/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }) });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || '授权失败');
  location.replace('${prefix}/?mode=full#' + payload.data.page);
} catch (error) { document.querySelector('p').textContent = error.message + '，请回到 DSH 重新打开控制台。'; }
`;

  async function route(req, res) {
    if (disposed) return fail(res, 503, '控制台已关闭');
    const host = String(req.headers.host || '');
    if (!isLoopbackAddress(req.socket.remoteAddress) || host !== new URL(origin).host) return fail(res, 403, '仅允许本机控制台来源');
    const requestOrigin = req.headers.origin;
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
    if ((unsafe && requestOrigin !== origin) || (requestOrigin && requestOrigin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, '控制台来源不匹配');
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === `${prefix}/auth` && !unsafe) {
      return send(res, 200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>打开 QQ-DSH 控制台</title><p>正在授权本机控制台…</p><script type="module" src="./console-auth.js"></script></html>', 'text/html; charset=utf-8');
    }
    if (pathname === `${prefix}/console-auth.js` && !unsafe) return send(res, 200, authScript, 'text/javascript; charset=utf-8');
    prune();
    if (pathname === `${prefix}/api/console/session`) {
      if (req.method !== 'POST') return fail(res, 405, '只支持 POST');
      const grant = await readGrant(req);
      const key = grant ? digest(grant) : '';
      const entry = grants.get(key);
      if (!entry || entry.expires <= now()) return fail(res, 401, '本机授权已过期或已使用');
      grants.delete(key);
      const session = token();
      sessions.set(digest(session), now() + SESSION_MS);
      return send(res, 200, JSON.stringify({ ok: true, data: { page: entry.page } }), undefined, {
        'set-cookie': `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=${SESSION_MS / 1000}`,
      });
    }
    const cookies = String(req.headers.cookie || '').split(';').map(part => part.trim().split('='));
    const session = cookies.find(([name]) => name === cookieName)?.[1];
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session) || !sessions.has(digest(session))) return fail(res, 401, '请从 DSH 打开本机控制台');
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return fail(res, 404, '没有这个页面');
    const url = new URL(req.url, origin);
    req.url = `${pathname.slice(prefix.length) || '/'}${url.search}`;
    await handle(req, res);
  }

  async function listen() {
    if (disposed) throw new Error('控制台已关闭');
    if (server?.listening) return;
    if (!starting) starting = (async () => {
      server = http.createServer((req, res) => route(req, res).catch(() => {
        if (!res.headersSent) fail(res, 500, '本机控制台暂时不可用');
        else res.destroy();
      }));
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      cookieName = `qq_bridge_console_${server.address().port}`;
    })().finally(() => { starting = null; });
    await starting;
    if (disposed) throw new Error('控制台已关闭');
  }

  return {
    async open(page) {
      if (!CONSOLE_PAGES.includes(page)) throw Object.assign(new Error('未知控制台页面'), { statusCode: 400 });
      await listen();
      prune();
      // Bound outstanding handles even if the same UI repeatedly opens tabs.
      if (grants.size >= 128) grants.delete(grants.keys().next().value);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      const grant = token();
      const key = digest(grant);
      grants.set(key, { page, expires: now() + GRANT_MS });
      try {
        await openBrowser(`${origin}${prefix}/auth#grant=${grant}`);
      } catch {
        grants.delete(key);
        throw Object.assign(new Error('无法打开默认浏览器，请重试'), { statusCode: 503 });
      }
      if (disposed) throw Object.assign(new Error('控制台已关闭'), { statusCode: 503 });
      return { opened: true };
    },
    async stop() {
      if (closing) return closing;
      disposed = true;
      grants.clear();
      sessions.clear();
      closing = (async () => {
        try { await starting; } catch { /* failed to listen */ }
        const active = server;
        server = null;
        if (!active) return;
        await new Promise(resolve => {
          active.close(resolve);
          active.closeAllConnections?.();
        });
      })();
      return closing;
    },
  };
}
