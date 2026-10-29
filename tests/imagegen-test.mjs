import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { imageRequest, parseImageJson, imageServiceUrl } from '../src/imagegen-client.js';
import { createImagegenService } from '../src/imagegen.js';
import { deliverGeneratedImages } from '../src/imagegen-delivery.js';
import { buildImagegenPrompt } from '../src/imagegen-prompt.js';
import { computerSessionKey } from '../src/computer-access.js';
import { loadConfig } from '../src/config.js';
import { loadIndex, stickerRootDir } from '../src/stickers.js';
import { createImagegenFixture, waitUntil } from './helpers/imagegen-fixture.mjs';
import { isolatedEnv } from './helpers/isolated-fixtures.mjs';

const input = { prompt: 'A friendly cartoon robot, white background' };
const withFixture = (name, fn) => test(name, async () => {
  const fixture = await createImagegenFixture();
  try { await fn(fixture); } finally { await fixture.close(); }
});

withFixture('a failed pre-submit metadata write can be cancelled without another POST', async (f) => {
  const lock = path.join(f.service.runtimeDir, 'metadata.lock');
  let id;
  try {
    await assert.rejects(() => f.service.generate(input, { onCreated(job) {
      id = job.id;
      fsSync.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
    } }), { code: 'IMAGEGEN_BUSY' });
  } finally { await fs.rm(lock, { force: true }); }
  assert.equal((await f.service.get(id)).status, 'created');
  assert.equal(f.state.posts.length, 0);
  const cancelled = await f.service.resume(id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.worker, null);
  assert.equal(f.state.posts.length, 0);
  // A possible paid submission must retain the live-worker protection.
  await f.service.update(id, (job) => {
    job.status = 'submitting';
    job.worker = { pid: process.pid, token: 'live-submission' };
  });
  await assert.rejects(() => f.service.resume(id), { code: 'IMAGEGEN_BUSY' });
  await f.service.update(id, (job) => { job.status = 'cancelled'; job.worker = null; });
  assert.equal((await f.service.generate(input)).status, 'completed');
  assert.equal(f.state.posts.length, 1);
});

test('request validation, presets and exact uint64 seeds', () => {
  for (const value of [null, [], {}, { prompt: '' }, { prompt: 42 }, { prompt: 'x'.repeat(16001) },
    { ...input, model: 'x' }, { ...input, size: '1024x1024' }, { ...input, width: 12 },
    { ...input, steps: 0 }, { ...input, cfg: NaN }, { ...input, cfg: 16 },
    { ...input, seed: 9082908179802593871 }, { ...input, seed: '18446744073709551616' },
    { ...input, seed: '1e3' }, { ...input, mode: 'other' }, { ...input, tags: ['x'.repeat(61)] }]) {
    assert.throws(() => imageRequest(value));
  }
  assert.equal(imageRequest({ ...input, preset: 'portrait' }).request.height, 1344);
  assert.equal(imageRequest({ ...input, cfg: 0, seed: '18446744073709551615' }).request.seed, '18446744073709551615');
  assert.equal(parseImageJson('{"seed":9082908179802593871}').seed, '9082908179802593871');
  assert.throws(() => imageServiceUrl({ baseUrl: 'http://127.0.0.1:1' }, 'http://127.0.0.1:2/x'));
});

withFixture('health, asynchronous generation, safe wire fields and verified artifact', async (f) => {
  assert.deepEqual(await f.service.check(), { status: 'ok' });
  const job = await f.service.generate({ ...input, seed: '18446744073709551615', cfg: 0, steps: 8 });
  assert.equal(job.status, 'completed');
  assert.equal(job.seed, '9082908179802593871');
  assert.equal(f.state.posts.length, 1);
  assert.match(f.state.posts[0].body, /"seed":18446744073709551615/);
  assert.equal(f.state.posts[0].headers.authorization, undefined);
  const wire = JSON.parse(f.state.posts[0].body);
  assert.deepEqual(Object.keys(wire).sort(), ['cfg', 'height', 'prompt', 'seed', 'steps', 'width']);
  const artifact = await f.service.artifact(job.id);
  assert.deepEqual(artifact.buffer, f.state.png);
  assert.equal((await f.service.get(job.id)).artifact.sha256, job.artifact.sha256);
  await fs.appendFile(artifact.file, 'tampered');
  await assert.rejects(() => f.service.artifact(job.id), /校验失败/);
});

withFixture('known remote task resumes after a polling error without another POST', async (f) => {
  f.state.mode = 'pollError';
  const paused = await f.service.generate(input);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.remote.id);
  assert.equal(paused.worker, null);
  await assert.rejects(() => f.service.generate(input), { code: 'IMAGEGEN_BUSY' });
  f.state.mode = 'normal';
  const restored = createImagegenService({ configPath: f.configPath });
  const completed = await restored.resume(paused.id);
  assert.equal(completed.status, 'completed');
  assert.equal(f.state.posts.length, 1);
});

withFixture('cross-process concurrency reserves one remote task and abort is recoverable', async (f) => {
  f.state.pollsBeforeComplete = 9999;
  const controller = new AbortController();
  const pending = f.service.generate(input, { signal: controller.signal });
  await waitUntil(() => f.state.posts.length);
  const cli = path.resolve('tools/imagegen.mjs');
  const child = spawn(process.execPath, [cli, 'generate', '--config', f.configPath, '--prompt', 'concurrent', '--json'], {
    cwd: f.root, env: isolatedEnv(f.root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  assert.equal(exit, 1, output);
  assert.match(output, /IMAGEGEN_BUSY/);
  controller.abort();
  const paused = await pending;
  assert.equal(paused.status, 'paused');
  f.state.pollsBeforeComplete = 0;
  assert.equal((await f.service.resume(paused.id)).status, 'completed');
  assert.equal(f.state.posts.length, 1);
});

withFixture('a lost submit response stays unknown and never automatically resubmits', async (f) => {
  f.state.mode = 'dropSubmit';
  const unknown = await f.service.generate(input);
  assert.equal(unknown.status, 'unknown');
  assert.equal((await f.service.resume(unknown.id)).status, 'unknown');
  await assert.rejects(() => f.service.generate(input), { code: 'IMAGEGEN_BUSY' });
  assert.equal(f.state.posts.length, 1);
  assert.equal((await f.service.release(unknown.id)).status, 'released');
  f.state.mode = 'normal';
  assert.equal((await f.service.generate(input)).status, 'completed');
});

for (const [mode, expected] of [
  ['reject', 'failed'], ['serverError', 'unknown'], ['foreignStatus', 'unknown'],
  ['foreignImage', 'failed'], ['badImage', 'failed'], ['oversize', 'failed'], ['redirect', 'failed'], ['remoteFail', 'failed'],
]) withFixture(`service failure ${mode}: ${expected}, no submission retry`, async (f) => {
  f.state.mode = mode;
  const job = await f.service.generate(input);
  assert.equal(job.status, expected);
  assert.equal(f.state.posts.length, 1);
  assert.equal(job.artifact, null);
});

withFixture('disabled service and invalid configuration fail before network access', async (f) => {
  f.config.imagegen.enabled = false; f.save();
  await assert.rejects(() => f.service.generate(input), { code: 'IMAGEGEN_DISABLED' });
  assert.equal(f.state.posts.length, 0);
  for (const [key, value] of [['baseUrl', 'file:///x'], ['baseUrl', 'http://name:secret@localhost/'], ['baseUrl', 'http://localhost/a'], ['timeoutMs', 0], ['enabled', 'true']]) {
    const copy = structuredClone(f.config);
    copy.imagegen[key] = value;
    await fs.writeFile(f.configPath, JSON.stringify(copy));
    assert.throws(() => loadConfig(f.root, { createIfMissing: false }));
  }
});

withFixture('administrator context binds jobs to a unique current turn and original target', async (f) => {
  const msg = { userId: 123, groupId: 789, messageType: 'group' };
  const contextId = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  const another = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  assert.notEqual(contextId, another);
  const job = await f.service.generate(input, { contextId });
  await f.service.closeContext(contextId);
  await assert.rejects(() => f.service.generate(input, { contextId }), { code: 'IMAGEGEN_CONTEXT' });
  const sent = [];
  const options = { service: f.service, contextId, configPath: f.configPath, configRoot: f.root, send: async (action, params) => sent.push({ action, params }) };
  assert.equal((await deliverGeneratedImages(options)).sent, 1);
  assert.equal((await deliverGeneratedImages(options)).sent, 0);
  assert.equal(sent[0].action, 'send_group_msg');
  assert.equal(sent[0].params.group_id, 789);
  assert.equal((await f.service.get(job.id)).delivery.state, 'sent');
  await assert.rejects(() => f.service.resume(job.id, { contextId: another }), { code: 'IMAGEGEN_CONTEXT' });
  assert.equal((await deliverGeneratedImages({ ...options, contextId: another })).matched, 0);
  const prompt = buildImagegenPrompt({ projectRoot: '/test', configPath: '/test/config.json', contextId });
  assert.ok(prompt.includes(contextId));
  assert.ok(prompt.includes('不要再用 qq.mjs'));
});

withFixture('sticker import deduplicates and the send probability is persisted exactly once', async (f) => {
  const msg = { userId: 123, messageType: 'private' };
  const contextId = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  f.config.stickers.sendProbability = 0.5; f.save();
  const job = await f.service.generate({ ...input, mode: 'sticker', tags: ['开心'] }, { contextId });
  await f.service.closeContext(contextId);
  assert.equal(job.status, 'completed');
  const index = await loadIndex(stickerRootDir({ configRoot: f.root, config: f.config }));
  assert.equal(index.items.length, 1);
  assert.ok(index.items[0].tags.includes('开心'));
  let draws = 0;
  let sends = 0;
  const options = { service: f.service, contextId, configPath: f.configPath, configRoot: f.root,
    random: () => { draws += 1; return 0.9; }, send: async () => { sends += 1; } };
  assert.equal((await deliverGeneratedImages(options)).skipped, 1);
  f.config.stickers.sendProbability = 1; f.save();
  await deliverGeneratedImages(options);
  assert.equal(draws, 1);
  assert.equal(sends, 0);
  assert.equal((await f.service.get(job.id)).delivery.state, 'skipped');
  const second = await f.service.generate({ ...input, mode: 'sticker' });
  assert.equal(second.sticker.duplicate, true);
});

withFixture('a lost QQ acknowledgement is marked unknown with no duplicate send', async (f) => {
  const msg = { userId: 123, messageType: 'private' };
  const contextId = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  const job = await f.service.generate(input, { contextId });
  await f.service.closeContext(contextId);
  let calls = 0;
  const options = { service: f.service, contextId, configPath: f.configPath, configRoot: f.root,
    send: async () => { calls += 1; throw new Error('connection lost after sending'); } };
  await deliverGeneratedImages(options);
  await deliverGeneratedImages(options);
  assert.equal(calls, 1);
  assert.equal((await f.service.get(job.id)).delivery.state, 'unknown');
});

withFixture('revoked administrator and cancelled/expired turns cannot generate or deliver', async (f) => {
  const msg = { userId: 123, messageType: 'private' };
  const contextId = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  f.state.pollsBeforeComplete = 9999;
  const pending = f.service.generate(input, { contextId });
  await waitUntil(() => f.state.gets.length);
  f.config.security.adminUserIds = []; f.save();
  const job = await pending;
  assert.equal(job.status, 'paused');
  await assert.rejects(() => f.service.generate(input, { contextId }), { code: 'IMAGEGEN_CONTEXT' });
  f.state.pollsBeforeComplete = 0;
  assert.equal((await f.service.resume(job.id)).status, 'completed');
  await assert.rejects(() => deliverGeneratedImages({ service: f.service, contextId, configPath: f.configPath, configRoot: f.root, send: async () => assert.fail('must not send') }), { code: 'IMAGEGEN_CONTEXT' });
  f.config.security.adminUserIds = [123]; f.save();
  await f.service.closeContext(contextId, 'cancelled');
  await assert.rejects(() => f.service.generate(input, { contextId }), { code: 'IMAGEGEN_CONTEXT' });
  const expiredId = await f.service.createContext(msg, computerSessionKey(msg, f.config));
  const file = path.join(f.service.runtimeDir, 'contexts', `${expiredId}.json`);
  const expired = JSON.parse(await fs.readFile(file, 'utf8'));
  expired.expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(expired));
  await assert.rejects(() => f.service.generate(input, { contextId: expiredId }), { code: 'IMAGEGEN_CONTEXT' });
});

withFixture('dead metadata owner and dead polling worker recover without repeating generation', async (f) => {
  f.state.mode = 'pollError';
  const paused = await f.service.generate(input);
  await f.service.update(paused.id, (job) => { job.worker = { pid: 2147483647, token: 'dead-fixture-worker' }; });
  await fs.writeFile(path.join(f.service.runtimeDir, 'metadata.lock'), JSON.stringify({ pid: 2147483647 }));
  f.state.mode = 'normal';
  const recovered = await createImagegenService({ configPath: f.configPath }).resume(paused.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(f.state.posts.length, 1);
});
