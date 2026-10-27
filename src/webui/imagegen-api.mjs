import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, saveConfig, validateConfig } from '../config.js';
import { createImagegenService } from '../imagegen.js';
import { IMAGE_PROVIDERS } from '../media-api.js';

const publicSettings = ({ apiKey, ...settings }) => ({ ...settings, hasApiKey: Boolean(apiKey?.trim()) });

const view = (job) => ({
  id: job.id, status: job.status, mode: job.mode, prompt: job.request.prompt,
  provider: job.server.provider ?? 'comfyui', baseUrl: job.server.baseUrl,
  createdAt: job.createdAt, updatedAt: job.updatedAt, seed: job.seed ?? null,
  error: job.error ?? null, artifact: job.artifact, sticker: job.sticker,
  delivery: job.delivery ? { state: job.delivery.state, probability: job.delivery.probability } : null,
});

export function createImagegenApi({ configPath, configRoot, config, readBody, ok, fail, log }) {
  let service;
  const token = randomBytes(32).toString('hex');
  const tasks = new Map();

  function authorized(req, res, needToken) {
    const port = req.socket.localPort;
    const authority = String(req.headers.host ?? '').toLowerCase();
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        !new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(authority)) {
      fail(res, 403, '生图接口仅允许本机控制台访问');
      return false;
    }
    const origin = String(req.headers.origin ?? '');
    if ((origin && origin !== `http://${authority}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      fail(res, 403, '生图接口不接受跨站请求');
      return false;
    }
    const supplied = Buffer.from(String(req.headers['x-qq-imagegen-token'] ?? ''));
    const expected = Buffer.from(token);
    if (needToken && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
      fail(res, 403, '请刷新生图页面后再操作');
      return false;
    }
    return true;
  }

  async function body(req) {
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw Object.assign(new Error('生图请求需要 JSON'), { statusCode: 415 });
    }
    let value;
    try { value = JSON.parse(await readBody(req, 128 * 1024) || '{}'); }
    catch { throw Object.assign(new Error('生图请求格式不正确'), { statusCode: 400 }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('生图请求需要 JSON 对象'), { statusCode: 400 });
    return value;
  }

  async function launch(operation) {
    const controller = new AbortController();
    let resolveCreated;
    let rejectCreated;
    const created = new Promise((resolve, reject) => { resolveCreated = resolve; rejectCreated = reject; });
    const pending = operation({ signal: controller.signal, onCreated: resolveCreated });
    tasks.set(controller, pending);
    void pending.then(resolveCreated, rejectCreated).finally(() => tasks.delete(controller)).catch(() => {});
    return view(await created);
  }

  async function route(req, res, pathname, method, url) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const base = '/api/imagegen';
    if (!authorized(req, res, pathname !== base || method !== 'GET')) return;
    try {
      service ??= createImagegenService({ configPath, configRoot });
      if (pathname === base && method === 'GET') return ok(res, { imagegenToken: token, settings: publicSettings(service.readConfig().imagegen), providers: IMAGE_PROVIDERS });
      if (pathname === `${base}/settings` && method === 'PUT') {
        const input = await body(req);
        return await service.transaction(async () => {
          const current = loadConfig(configRoot, { configFile: configPath, createIfMissing: false }).config;
          for (const key of Object.keys(input)) if (!Object.hasOwn(current.imagegen, key)) return fail(res, 400, `未知生图设置：${key}`);
          const candidate = { ...current, imagegen: { ...current.imagegen, ...input } };
          if (!Object.hasOwn(input, 'apiKey') && (candidate.imagegen.provider !== current.imagegen.provider ||
              String(candidate.imagegen.baseUrl).replace(/\/+$/, '') !== current.imagegen.baseUrl.replace(/\/+$/, ''))) candidate.imagegen.apiKey = '';
          try { validateConfig(candidate); } catch (error) { return fail(res, 400, error.message); }
          const routeChanged = ['provider', 'model', 'generationPath'].some((key) => candidate.imagegen[key] !== current.imagegen[key]) ||
            candidate.imagegen.baseUrl.replace(/\/+$/, '') !== current.imagegen.baseUrl.replace(/\/+$/, '');
          if (routeChanged && current.imagegen.baseUrl) {
            const previousUrl = new URL(current.imagegen.baseUrl).href.replace(/\/$/, '');
            const busy = (await service.list()).some((job) => job.server.baseUrl === previousUrl &&
              !['completed', 'failed', 'cancelled', 'released'].includes(job.status));
            if (busy) return fail(res, 409, '当前服务还有未结束的生图任务，请完成或解除占用后再修改平台、地址或模型');
          }
          const raw = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
          raw.imagegen = candidate.imagegen;
          saveConfig(configPath, raw);
          config.imagegen = candidate.imagegen;
          return ok(res, { settings: publicSettings(candidate.imagegen) });
        });
      }
      if (pathname === `${base}/check` && method === 'POST') {
        if (Object.keys(await body(req)).length) return fail(res, 400, '连接检测不接受额外参数');
        return ok(res, await service.check());
      }
      if (pathname === `${base}/jobs` && method === 'GET') return ok(res, { jobs: (await service.list()).slice(0, 50).map(view) });
      if (pathname === `${base}/jobs` && method === 'POST') {
        const input = await body(req);
        return ok(res, await launch((options) => service.generate(input, options)));
      }
      const match = pathname.match(/^\/api\/imagegen\/jobs\/([a-f\d-]+)(?:\/(image|resume|release))?$/i);
      if (match) {
        const [, id, action] = match;
        if (!action && method === 'GET') return ok(res, view(await service.get(id)));
        if (action === 'image' && method === 'GET') {
          const image = await service.artifact(id);
          res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.buffer.length });
          return res.end(image.buffer);
        }
        if (action === 'resume' && method === 'POST') {
          if (Object.keys(await body(req)).length) return fail(res, 400, '恢复任务不接受额外参数');
          return ok(res, await launch((options) => service.resume(id, options)));
        }
        if (action === 'release' && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).length !== 1 || input.confirmed !== true) return fail(res, 400, '需要先确认服务端没有未结束任务');
          return ok(res, view(await service.release(id)));
        }
        return fail(res, 405, '生图请求方法不支持');
      }
      return fail(res, 404, '没有这个生图接口');
    } catch (error) {
      const safe = error.code?.startsWith('IMAGEGEN_') || (error.statusCode && !error.code);
      if (!safe) log?.warn?.('生图控制台操作失败');
      return fail(res, safe ? Math.max(400, Math.min(Number(error.statusCode) || 400, 599)) : 500,
        safe ? error.message : '生图操作失败，请检查本地任务记录');
    }
  }

  return {
    route,
    async stop() {
      for (const controller of tasks.keys()) controller.abort();
      await Promise.allSettled([...tasks.values()]);
    },
  };
}
