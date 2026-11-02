import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createGateway, createHealthServer } from '../docker/nas-gateway.mjs';
import { verifyProxyAssertion } from '../src/webui/proxy-assertion.mjs';

const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({
    url: req.url,
    host: req.headers.host,
    authorization: req.headers.authorization,
    assertion: req.headers['x-qq-console-assertion'],
  });
  res.end('upstream ok');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const gateway = createGateway({
  username: 'test',
  passwordHash: createHash('sha256').update('test-password').digest('hex'),
  upstream: `http://127.0.0.1:${upstream.address().port}`,
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${gateway.address().port}`;
const authorization = `Basic ${Buffer.from('test:test-password').toString('base64')}`;
const passwordHash = createHash('sha256').update('test-password').digest('hex');
const health = createHealthServer({ upstream: `http://127.0.0.1:${upstream.address().port}` });
await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
try {
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Basic eDp5' } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization, origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await fetch(url, { headers: { authorization, 'sec-fetch-site': 'cross-site' } })).status, 403);
  const response = await fetch(`${url}/api/overview?test=1`, {
    headers: { authorization, origin: url, 'x-qq-console-assertion': 'attacker-forged-value' },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'upstream ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/overview?test=1');
  assert.equal(seen[0].authorization, undefined);
  assert.notEqual(seen[0].assertion, 'attacker-forged-value');
  const nonceCache = new Map();
  const assertionInput = {
    method: 'GET', url: seen[0].url, host: seen[0].host, nonceCache,
  };
  assert.equal(verifyProxyAssertion(passwordHash, seen[0].assertion, assertionInput), true);
  assert.equal(verifyProxyAssertion(passwordHash, seen[0].assertion, assertionInput), false, 'gateway assertion is replay protected');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`http://127.0.0.1:${health.address().port}/healthz`)).status, 200);
  assert.throws(() => createGateway({ username: 'test', passwordHash: '', upstream: url }));
  console.log('NAS gateway: authentication, CSRF boundary, forwarding and secret stripping passed');
} finally {
  await new Promise((resolve) => health.close(resolve));
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
}
