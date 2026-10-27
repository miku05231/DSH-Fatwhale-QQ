import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(headers) {
  const connectionTokens = new Set(
    String(headers.connection || '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean),
  );
  return Object.fromEntries(Object.entries(headers).filter(
    ([name]) => !HOP_BY_HOP.has(name.toLowerCase()) && !connectionTokens.has(name.toLowerCase()),
  ));
}

export function createGateway({ username, passwordHash, upstream, timeoutMs = 300_000 }) {
  if (!username || !/^[a-f0-9]{64}$/i.test(passwordHash || '')) {
    throw new Error('CONSOLE_USER and a SHA-256 CONSOLE_PASSWORD_SHA256 are required');
  }
  const target = new URL(upstream);
  if (target.protocol !== 'http:') throw new Error('Only a private HTTP upstream is supported');
  const expected = Buffer.from(passwordHash, 'hex');
  const userHash = createHash('sha256').update(username).digest();
  return http.createServer((req, res) => {
    let valid = false;
    if (/^Basic /i.test(req.headers.authorization || '')) {
      const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) {
        const actualUser = createHash('sha256').update(decoded.slice(0, colon)).digest();
        const actual = createHash('sha256').update(decoded.slice(colon + 1)).digest();
        valid = timingSafeEqual(actualUser, userHash) && timingSafeEqual(actual, expected);
      }
    }
    if (!valid) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="QQ Bridge NAS", charset="UTF-8"',
        'Cache-Control': 'no-store',
      });
      return res.end('Authentication required');
    }
    // Browsers may reuse Basic credentials for cross-site requests.
    if (req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
      res.writeHead(403);
      return res.end('Cross-site requests are forbidden');
    }
    const headers = cleanHeaders(req.headers);
    delete headers.authorization;
    delete headers['proxy-authorization'];
    const proxy = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const responseHeaders = cleanHeaders(response.headers);
      res.writeHead(response.statusCode || 502, {
        ...responseHeaders,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "frame-ancestors 'self'",
      });
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    proxy.on('timeout', () => proxy.destroy(new Error('Upstream timeout')));
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Console is temporarily unavailable');
    });
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  });
}

export function createHealthServer({ upstream, timeoutMs = 5000 }) {
  const target = new URL(upstream);
  return http.createServer(async (req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404);
      return res.end();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${target.origin}/api/overview`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      res.writeHead(response.ok ? 200 : 503, { 'Cache-Control': 'no-store' });
      res.end(response.ok ? 'ok' : 'upstream unhealthy');
    } catch {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      res.end('upstream unavailable');
    } finally {
      clearTimeout(timer);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstream = process.env.CONSOLE_UPSTREAM || 'http://bridge:5830';
  const server = createGateway({
    username: process.env.CONSOLE_USER,
    passwordHash: process.env.CONSOLE_PASSWORD_SHA256,
    upstream,
  });
  const health = createHealthServer({ upstream });
  server.listen(Number(process.env.CONSOLE_PORT || 5830), '0.0.0.0', () => {
    console.log('[nas-console] Authenticated console is listening');
  });
  health.listen(Number(process.env.HEALTH_PORT || 5831), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    health.close();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
