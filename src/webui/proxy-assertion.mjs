import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_HASH = /^[a-f0-9]{64}$/i;
const NONCE = /^[A-Za-z0-9_-]{20,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

function keyFrom(secret) {
  if (typeof secret !== 'string' || !SECRET_HASH.test(secret)) return null;
  return createHashKey(secret);
}

function createHashKey(secret) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('qq-bridge-console-proxy-assertion-v1')
    .digest();
}

function canonical({ method, url, host, timestamp, nonce }) {
  return ['v1', String(method).toUpperCase(), String(url), String(host).toLowerCase(), String(timestamp), nonce].join('\n');
}

export function createProxyAssertion(secret, { method, url, host, now = Date.now(), nonce = randomBytes(18).toString('base64url') } = {}) {
  const key = keyFrom(secret);
  if (!key || !method || !url || !host || !NONCE.test(nonce)) throw new TypeError('Valid proxy assertion inputs are required');
  const timestamp = String(now);
  const signature = createHmac('sha256', key)
    .update(canonical({ method, url, host, timestamp, nonce }))
    .digest('base64url');
  return `v1.${timestamp}.${nonce}.${signature}`;
}

/** Validates an assertion and consumes its nonce in the supplied per-server map. */
export function verifyProxyAssertion(secret, assertion, {
  method, url, host, now = Date.now(), maxSkewMs = 30_000, nonceCache,
} = {}) {
  const key = keyFrom(secret);
  if (!key || typeof assertion !== 'string' || !method || !url || !host) return false;
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43})$/.exec(assertion);
  if (!match) return false;
  const [, timestamp, nonce, suppliedText] = match;
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > maxSkewMs) return false;
  if (nonceCache instanceof Map) {
    for (const [seen, expiry] of nonceCache) if (expiry <= now) nonceCache.delete(seen);
    if (nonceCache.has(nonce)) return false;
  }
  const expected = createHmac('sha256', key)
    .update(canonical({ method, url, host, timestamp, nonce }))
    .digest();
  let supplied;
  try { supplied = Buffer.from(suppliedText, 'base64url'); } catch { return false; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  if (nonceCache instanceof Map) {
    if (nonceCache.size >= 10_000) nonceCache.delete(nonceCache.keys().next().value);
    nonceCache.set(nonce, sentAt + maxSkewMs);
  }
  return true;
}
