/**
 * Real HTTP update endpoints with an injected manager. No downloads or services.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWebUiServer } from '../src/webui/server.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-update-api-'));
const calls = { start: 0, stop: 0, check: 0, install: 0, settings: 0 };
let snapshot = {
  currentVersion: '0.2.0', latestVersion: '0.3.0', phase: 'available',
  automatic: true, checkedAt: null, releaseUrl: 'https://github.com/miku05231/DSH-Fatwhale-QQ/releases/tag/v0.3.0',
  releaseNotes: 'Fixture release', canInstall: true, installReason: '', progress: null, error: '',
};
const manager = {
  async start() { calls.start += 1; },
  stop() { calls.stop += 1; },
  async status() { return { ...snapshot }; },
  async check() { calls.check += 1; return { ...snapshot }; },
  async setAutomatic(value) {
    calls.settings += 1;
    snapshot = { ...snapshot, automatic: value };
    return { ...snapshot };
  },
  async install({ version }) {
    if (version !== snapshot.latestVersion) throw new Error('The selected version is no longer available');
    calls.install += 1;
    return { ...snapshot, phase: 'downloading' };
  },
};
const instance = createWebUiServer({
  configRoot: temporary, config: {}, port: await freePort(), updateManager: manager,
});

try {
  await instance.start();
  const port = instance.port;
  check('The update scheduler starts with the local console', calls.start === 1);
  const first = await request(port, '/api/updates');
  check('Status reads without triggering network or installation', first.status === 200 && calls.check === 0 && calls.install === 0);
  const token = first.body.data.updateToken;
  check('The session token survives the existing secret redaction', /^[a-f0-9]{64}$/.test(token));
  check('Status does not grant cross-origin reading', !first.headers['access-control-allow-origin']);
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-QQ-Update-Token': token, Origin: instance.url.slice(0, -1) };
  let response = await request(port, '/api/updates/check', { method: 'POST', headers: jsonHeaders, body: '{}' });
  check('A same-origin explicit check reaches the manager', response.status === 200 && calls.check === 1);
  response = await request(port, '/api/updates/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('A missing session token is refused', response.status === 403 && calls.check === 1);
  response = await request(port, '/api/updates/check', { method: 'POST', headers: { ...jsonHeaders, 'X-QQ-Update-Token': '0'.repeat(64) }, body: '{}' });
  check('An invalid session token is refused', response.status === 403 && calls.check === 1);
  for (const headers of [
    { Origin: 'https://untrusted.invalid' },
    { Host: `untrusted.invalid:${port}` },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null' },
  ]) {
    response = await request(port, '/api/updates', { headers });
    check(`Untrusted update reads are refused: ${JSON.stringify(headers)}`, response.status === 403);
  }
  response = await request(port, '/api/updates/install', {
    method: 'POST', headers: { ...jsonHeaders, Origin: 'http://localhost:1' }, body: '{"version":"0.3.0"}',
  });
  check('Cross-origin installation is refused even with a token', response.status === 403 && calls.install === 0);
  response = await request(port, '/api/updates/install', {
    method: 'POST', headers: { ...jsonHeaders, 'Content-Type': 'text/plain' }, body: '{"version":"0.3.0"}',
  });
  check('Simple form/text requests cannot trigger installation', response.status === 415 && calls.install === 0);
  for (const body of [
    'null', '[]', '{', '{}', '{"version":3}',
    '{"version":"0.3.0","url":"https://untrusted.invalid/payload.zip"}',
    '{"version":"0.3.0","projectRoot":"C:/Windows"}',
  ]) {
    response = await request(port, '/api/updates/install', { method: 'POST', headers: jsonHeaders, body });
    check(`Malformed installation input cannot reach the installer: ${body}`, response.status === 400 && calls.install === 0);
  }
  response = await request(port, '/api/updates/install', {
    method: 'POST', headers: jsonHeaders, body: '{"version":"0.2.0"}',
  });
  check('A stale confirmation cannot install another version', response.status === 400 && calls.install === 0);
  response = await request(port, '/api/updates/install', {
    method: 'POST', headers: jsonHeaders, body: '{"version":"0.3.0"}',
  });
  check('Only the explicitly selected version reaches installation', response.status === 200 && calls.install === 1);
  check('Download status remains available for polling', response.body.data.phase === 'downloading' && response.body.data.updateToken === token);
  response = await request(port, '/api/updates/settings', {
    method: 'PUT', headers: jsonHeaders, body: '{"automatic":false}',
  });
  check('Automatic checks can be disabled independently', response.status === 200 && !snapshot.automatic && calls.settings === 1);
  response = await request(port, '/api/updates/settings', {
    method: 'PUT', headers: jsonHeaders, body: '{"automatic":"false"}',
  });
  check('Automatic settings require an actual boolean', response.status === 400 && calls.settings === 1);
  response = await request(port, '/api/updates/check', { method: 'PUT', headers: jsonHeaders, body: '{}' });
  check('Update actions enforce their HTTP method', response.status === 405);
  response = await request(port, '/api/updates/check', { method: 'POST', headers: jsonHeaders, body: '{"url":"x"}' });
  check('Checking cannot redirect the backend to a supplied URL', response.status === 400 && calls.check === 1);
  response = await request(port, '/api/overview');
  check('The existing overview remains usable', response.status === 200 && response.body.ok);
} finally {
  await instance.stop();
  await rm(temporary, { recursive: true, force: true });
}
check('Stopping the console stops the update scheduler', calls.stop === 1);
console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
