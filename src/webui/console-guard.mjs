import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyProxyAssertion } from './proxy-assertion.mjs';

export function isLoopbackAddress(address) {
  const value = String(address ?? '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export function localConsoleAuthorities(port) {
  const value = String(port ?? '');
  return new Set([`127.0.0.1:${value}`, `localhost:${value}`, `[::1]:${value}`]);
}

function basicPasswordMatches(header, username, passwordHash) {
  if (typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(passwordHash)) return false;
  if (!/^Basic /i.test(String(header ?? ''))) return false;
  let decoded;
  try {
    decoded = Buffer.from(String(header).slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const expectedUser = createHash('sha256').update(String(username ?? 'console')).digest();
  const actualUser = createHash('sha256').update(decoded.slice(0, colon)).digest();
  const expected = Buffer.from(passwordHash, 'hex');
  const actual = createHash('sha256').update(decoded.slice(colon + 1)).digest();
  return actualUser.length === expectedUser.length
    && timingSafeEqual(actualUser, expectedUser)
    && actual.length === expected.length
    && timingSafeEqual(actual, expected);
}

/**
 * A management request is trusted only when the socket is loopback AND the Host
 * header names that local listener, or a NAS gateway assertion matches, or
 * Basic auth matches the configured console password. A forged Host from
 * another container is not enough.
 */
export function consoleRequestTrusted(req, {
  proxySecret, nonceCache, username = 'console', passwordHash,
} = {}) {
  const port = req.socket?.localPort;
  const authority = String(req.headers?.host ?? '').toLowerCase();
  if (isLoopbackAddress(req.socket?.remoteAddress) && localConsoleAuthorities(port).has(authority)) {
    return { ok: true, via: 'loopback' };
  }
  if (verifyProxyAssertion(proxySecret, req.headers?.['x-qq-console-assertion'], {
    method: req.method,
    url: req.url || req.originalUrl || '/',
    host: req.headers?.host,
    nonceCache,
  })) return { ok: true, via: 'gateway' };
  if (basicPasswordMatches(req.headers?.authorization, username, passwordHash || proxySecret)) {
    return { ok: true, via: 'basic' };
  }
  return { ok: false, via: '' };
}
