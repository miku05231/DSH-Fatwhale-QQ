import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULTS, saveConfig } from '../../src/config.js';
import { createImagegenService } from '../../src/imagegen.js';

export async function createImagegenFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-imagegen-'));
  const png = await fs.readFile(new URL('../../src/webui/public/app-icon.png', import.meta.url));
  const state = { mode: 'normal', pollsBeforeComplete: 1, posts: [], gets: [], requests: [], speech: [], jobs: new Map(), png };
  const server = http.createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
      if (req.method === 'GET' && req.url.endsWith('/v1/models')) return json(200, { data: [{ id: 'fixture-model' }] });
      if (req.method === 'POST' && req.url.endsWith('/v1/audio/speech')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const speech = JSON.parse(body);
        state.speech.push({ body: speech, headers: req.headers, url: req.url });
        if (state.mode === 'audioHttpError') return json(401, { error: 'Bearer fixture-secret' });
        if (state.mode === 'audioWait') return;
        if (state.mode === 'audioJson') return json(200, { error: 'wrong format' });
        if (state.mode === 'audioLarge') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 11 * 1024 * 1024 }); return res.end('x'); }
        const audio = Buffer.alloc(256, 7);
        const wav = speech.response_format === 'wav';
        audio.write(state.mode === 'audioInvalid' ? 'bad' : wav ? 'RIFF' : 'ID3');
        if (wav) audio.write('WAVE', 8);
        res.writeHead(200, { 'Content-Type': wav ? 'audio/wav' : 'audio/mpeg', 'Content-Length': audio.length });
        return res.end(audio);
      }
    if (req.method === 'POST' && req.url.endsWith('/v1/images/generations')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        state.posts.push({ body, headers: req.headers });
        if (state.mode === 'reject') return json(400, { error: 'bad request' });
        if (state.mode === 'serverError') return json(500, { error: 'internal' });
        if (state.mode === 'syncBase64') return json(200, { data: [{ b64_json: state.png.toString('base64') }] });
        if (state.mode === 'syncUrl') return json(200, { data: [{ url: '/v1/images/sync/0' }] });
        if (state.mode === 'syncSiliconflow') return json(200, { images: [{ url: '/v1/images/sync/0' }] });
        if (state.mode === 'syncBadBase64') return json(200, { data: [{ b64_json: '<not base64>' }] });
        const id = randomUUID();
        state.jobs.set(id, { polls: 0 });
        if (state.mode === 'dropSubmit') return req.socket.destroy();
        const status_url = state.mode === 'foreignStatus' ? 'http://127.0.0.1:1/private' : `/v1/jobs/${id}`;
        return json(202, { id, status: 'queued', seed: JSON.rawJSON('9082908179802593871'), status_url });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/jobs/')) {
        state.gets.push(req.url);
        if (state.mode === 'pollError') return json(503, { error: 'unavailable' });
        const id = req.url.split('/').at(-1);
        const job = state.jobs.get(id);
        if (!job) return json(404, { error: 'missing' });
        job.polls += 1;
        if (state.mode === 'remoteFail') return json(200, { id, status: 'failed' });
        if (job.polls <= state.pollsBeforeComplete) return json(200, { id, status: 'running' });
        const url = state.mode === 'foreignImage' ? 'http://127.0.0.1:1/private' : `/v1/images/${id}/0`;
        return json(200, { id, status: 'completed', images: [{ url }] });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/images/')) {
        state.gets.push(req.url);
        if (state.mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); return res.end(); }
        if (state.mode === 'badImage') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>not an image</html>'); }
        if (state.mode === 'oversize') { res.writeHead(200, { 'Content-Length': 99 * 1024 * 1024 }); return res.end('x'); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        return res.end(png);
      }
      json(404, { error: 'missing' });
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const configPath = path.join(root, 'config.json');
  const config = structuredClone(DEFAULTS);
  config.security.allowFrom = [123, 456];
  config.security.adminUserIds = [123];
  config.memory.enabled = false;
  config.memory.reflectDaily = false;
  config.memory.reflectEvery = 0;
  config.persona.enabled = false;
  // These are local in-process mocks; generous limits keep the browser test
  // deterministic when the machine is busy running the rest of the suite.
  config.imagegen = { ...config.imagegen, enabled: true, baseUrl, pollIntervalMs: 50, requestTimeoutMs: 10000, timeoutMs: 30000 };
  saveConfig(configPath, config);
  const service = createImagegenService({ configPath });
  return {
    root, configPath, config, baseUrl, state, service,
    save() { saveConfig(configPath, config); },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    },
  };
}

export async function waitUntil(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for isolated fixture');
}
