import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import { createConsoleFixture } from './helpers/isolated-fixtures.mjs';
import { createImagegenFixture, waitUntil } from './helpers/imagegen-fixture.mjs';

test('isolated image generation console API, settings and private images', async (t) => {
  const f = await createImagegenFixture();
  let consoleFixture;
  try {
    consoleFixture = await createConsoleFixture(f.root);
    const origin = consoleFixture.instance.url.replace(/\/$/, '');
    const bootstrap = await (await fetch(`${origin}/api/imagegen`)).json();
    assert.equal(bootstrap.ok, true);
    const token = bootstrap.data.imagegenToken;
    const request = (url, { method = 'GET', body, headers = {} } = {}) => fetch(`${origin}/api/imagegen${url}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-QQ-Imagegen-Token': token, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    await t.test('bootstrap has a scoped token and no private job history', async () => {
      assert.equal(token.length, 64);
      assert.equal(bootstrap.data.jobs, undefined);
      assert.equal(bootstrap.data.settings.enabled, true);
    });
    await t.test('token, Origin, Host and fetch metadata are enforced', async () => {
      for (const headers of [
        { 'X-QQ-Imagegen-Token': '' }, { 'X-QQ-Imagegen-Token': 'wrong' },
        { Origin: 'http://attacker.invalid' }, { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ]) assert.equal((await request('/jobs', { headers })).status, 403, JSON.stringify(headers));
      const foreignHost = await new Promise((resolve, reject) => {
        http.get(`${origin}/api/imagegen/jobs`, { headers: { Host: 'attacker.invalid', 'X-QQ-Imagegen-Token': token } }, (res) => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(foreignHost, 403);
      assert.equal((await fetch(`${origin}/api/imagegen/jobs?token=${token}`)).status, 403);
      assert.equal((await fetch(`${origin}/api/imagegen`, { headers: { Origin: 'http://attacker.invalid' } })).status, 403);
      assert.equal((await request('/check', { method: 'POST', body: {}, headers: { 'X-QQ-Imagegen-Token': '' } })).status, 403);
      assert.equal(f.state.posts.length, 0);
    });
    await t.test('validation rejects invalid parameters without changing configuration', async () => {
      const before = await fs.readFile(consoleFixture.configPath, 'utf8');
      for (const body of [{ apiKey: 'invalid\nkey' }, { apiKey: '***' }, { provider: 'unknown' }, { baseUrl: 7 }, { baseUrl: 'file:///tmp' }, { timeoutMs: 0 }, { enabled: 'true' }]) {
        assert.equal((await request('/settings', { method: 'PUT', body })).status, 400);
      }
      assert.equal(await fs.readFile(consoleFixture.configPath, 'utf8'), before);
      assert.equal((await request('/jobs', { method: 'POST', body: { prompt: 'x', model: 'wrong' } })).status, 400);
      assert.equal(f.state.posts.length, 0);
    });
    await t.test('health uses the keyless configured service', async () => {
      const response = await request('/check', { method: 'POST', body: {} });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { status: 'ok' });
    });
    await t.test('a live process with a stranded created task can cancel it through the API', async () => {
      let createdId;
      const fault = new Error('isolated pre-submit failure');
      await assert.rejects(() => f.service.generate({ prompt: 'not submitted' }, { onCreated(job) {
        createdId = job.id;
        throw fault;
      } }), fault);
      assert.equal((await f.service.get(createdId)).worker.pid, process.pid);
      assert.equal((await request('/settings', { method: 'PUT', body: { enabled: false } })).status, 200);
      const result = await (await request(`/jobs/${createdId}/resume`, { method: 'POST', body: {} })).json();
      assert.equal(result.ok, true);
      assert.equal(result.data.status, 'cancelled');
      assert.equal((await f.service.get(createdId)).worker, null);
      assert.equal(f.state.posts.length, 0);
      assert.equal((await request('/settings', { method: 'PUT', body: { enabled: true } })).status, 200);
    });
    let id;
    await t.test('asynchronous generation returns immediately then exposes a private preview', async () => {
      f.state.pollsBeforeComplete = 3;
      const response = await request('/jobs', { method: 'POST', body: { prompt: 'console fixture', preset: 'portrait' } });
      const payload = await response.json();
      assert.equal(payload.ok, true, JSON.stringify(payload));
      id = payload.data.id;
      assert.ok(['created', 'submitting', 'queued'].includes(payload.data.status));
      assert.equal((await request('/jobs', { method: 'POST', body: { prompt: 'concurrent' } })).status, 409);
      const job = await waitUntil(async () => {
        const result = await (await request(`/jobs/${id}`)).json();
        return result.data?.status === 'completed' ? result.data : null;
      });
      assert.ok(job.artifact.bytes > 100);
      assert.equal(job.seed, '9082908179802593871');
      assert.equal(job.delivery, null);
      assert.equal(f.state.posts.length, 1);
      const preview = await request(`/jobs/${id}/image`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/png');
      assert.equal(preview.headers.get('cache-control'), 'no-store');
      assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), f.state.png);
      assert.equal((await fetch(`${origin}/api/imagegen/jobs/${id}/image`)).status, 403);
      assert.equal((await request('/jobs/../../config.json/image')).status, 404);
    });
    await t.test('saving settings preserves all unrelated configuration and takes effect immediately', async () => {
      const previous = JSON.parse(await fs.readFile(consoleFixture.configPath, 'utf8'));
      assert.equal((await request('/settings', { method: 'PUT', body: { enabled: false } })).status, 200);
      const current = JSON.parse(await fs.readFile(consoleFixture.configPath, 'utf8'));
      const beforeImage = previous.imagegen;
      const afterImage = current.imagegen;
      delete previous.imagegen; delete current.imagegen;
      assert.deepEqual(current, previous);
      assert.deepEqual(afterImage, { ...beforeImage, enabled: false });
      assert.equal((await request('/jobs', { method: 'POST', body: { prompt: 'disabled' } })).status, 409);
      await request('/settings', { method: 'PUT', body: { enabled: true } });
    });
    await t.test('console shutdown pauses a known task; local resume never submits twice', async () => {
      f.state.pollsBeforeComplete = 9999;
      const payload = await (await request('/jobs', { method: 'POST', body: { prompt: 'shutdown recovery' } })).json();
      const pendingId = payload.data.id;
      await waitUntil(async () => (await f.service.get(pendingId)).status === 'running');
      await consoleFixture.close(); consoleFixture = null;
      const paused = await f.service.get(pendingId);
      assert.equal(paused.status, 'paused');
      assert.ok(paused.remote.id);
      f.state.pollsBeforeComplete = 0;
      assert.equal((await f.service.resume(pendingId)).status, 'completed');
      assert.equal(f.state.posts.length, 2);
    });
  } finally {
    await consoleFixture?.close();
    await f.close();
  }
});
