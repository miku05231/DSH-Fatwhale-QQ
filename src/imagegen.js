import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, resolvePath } from './config.js';
import { isAdministrator } from './security.js';
import { computerSessionKey } from './computer-access.js';
import { sniffImage, upsertSticker, stickerRootDir } from './stickers.js';
import { createImageClient, imagegenError, imageRequest, imageServiceUrl, providerImageRequest } from './imagegen-client.js';

const ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'released']);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

async function readJson(file, optional = false) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export function createImagegenService({ configPath, configRoot = path.dirname(configPath) } = {}) {
  const readConfig = () => loadConfig(configRoot, { configFile: configPath, createIfMissing: false }).config;
  const runtimeDir = path.join(resolvePath(configRoot, readConfig().stateDir), '.imagegen-runtime');
  const jobFile = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw imagegenError('生图任务编号无效');
    return path.join(runtimeDir, 'jobs', `${id}.json`);
  };
  const contextFile = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw imagegenError('生图会话编号无效');
    return path.join(runtimeDir, 'contexts', `${id}.json`);
  };

  // This lock covers metadata only. A persisted job reserves the GPU until resolved.
  async function transaction(fn) {
    await fs.mkdir(runtimeDir, { recursive: true });
    const file = path.join(runtimeDir, 'metadata.lock');
    const deadline = Date.now() + 6000;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } catch (error) {
        if (handle) { await handle.close(); await fs.rm(file, { force: true }); throw error; }
        if (error.code !== 'EEXIST') throw error;
        try {
          const [owner, stat] = await Promise.all([readJson(file).catch(() => null), fs.stat(file)]);
          if ((owner?.pid && !alive(owner.pid)) || (!owner?.pid && Date.now() - stat.mtimeMs > 10000)) {
            let recovery;
            try { recovery = await fs.open(`${file}.recovery`, 'wx', 0o600); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            if (recovery) {
              try {
                const latest = await readJson(file).catch(() => null);
                const latestStat = await fs.stat(file).catch(() => null);
                if (latestStat && ((latest?.pid && !alive(latest.pid)) || (!latest?.pid && Date.now() - latestStat.mtimeMs > 10000))) {
                  await fs.rm(file, { force: true });
                }
              } finally { await recovery.close(); await fs.rm(`${file}.recovery`, { force: true }); }
            }
            if (Date.now() > deadline) throw imagegenError('生图任务记录正忙，请稍后再试', 'IMAGEGEN_BUSY', 409);
            await sleep(40);
            continue;
          }
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (Date.now() > deadline) throw imagegenError('生图任务记录正忙，请稍后再试', 'IMAGEGEN_BUSY', 409);
        await sleep(40);
      }
    }
    try { return await fn(); }
    finally { await handle.close(); await fs.rm(file, { force: true }); }
  }

  async function get(id) {
    const job = await readJson(jobFile(id), true);
    if (!job) throw imagegenError('找不到这个生图任务', 'IMAGEGEN_NOT_FOUND', 404);
    return job;
  }

  async function update(id, fn) {
    return transaction(async () => {
      const job = await get(id);
      const result = await fn(job);
      job.updatedAt = new Date().toISOString();
      await atomic(jobFile(id), job);
      return result === undefined ? job : result;
    });
  }

  async function list() {
    const files = await fs.readdir(path.join(runtimeDir, 'jobs')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const jobs = [];
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (!ID.test(id) || file !== `${id}.json`) continue;
      jobs.push(await get(id));
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function enabled() {
    const config = readConfig();
    if (!config.imagegen.enabled || !config.imagegen.baseUrl) throw imagegenError('请先启用并配置生图服务', 'IMAGEGEN_DISABLED', 409);
    return config;
  }

  async function checkContext(id, { delivery = false } = {}) {
    if (!id) return null;
    const context = await readJson(contextFile(id), true);
    const config = enabled();
    if (!context || !['open', ...(delivery ? ['sealed'] : [])].includes(context.state) || Date.now() >= context.expiresAt ||
        !isAdministrator(context.message.userId, config) || computerSessionKey(context.message, config) !== context.grantKey) {
      throw imagegenError('生图会话已结束或管理员权限已变更', 'IMAGEGEN_CONTEXT', 403);
    }
    return context;
  }

  async function createContext(message, grantKey) {
    const config = enabled();
    const id = randomUUID();
    await atomic(contextFile(id), {
      id, state: 'open', message: { userId: message.userId, messageType: message.messageType, groupId: message.groupId ?? null },
      grantKey, expiresAt: Date.now() + Math.max(config.dsh.timeoutMs, config.imagegen.timeoutMs) + 30000,
    });
    await checkContext(id);
    return id;
  }

  async function closeContext(id, state = 'sealed') {
    if (!id) return;
    return transaction(async () => {
      const context = await readJson(contextFile(id), true);
      if (!context) return;
      context.state = state;
      await atomic(contextFile(id), context);
    });
  }

  async function saveWorker(id, token, fields) {
    return update(id, (job) => {
      if (job.worker?.token !== token) throw imagegenError('生图任务已由其他进程接管', 'IMAGEGEN_BUSY', 409);
      Object.assign(job, fields);
    });
  }

  async function finish(id, token, fields) {
    return saveWorker(id, token, { ...fields, worker: null });
  }

  async function artifact(id) {
    const job = await get(id);
    if (!job.artifact || job.status !== 'completed') throw imagegenError('任务还没有可用图片', 'IMAGEGEN_NOT_READY', 409);
    if (!/^result\.(?:png|jpg|jpeg|webp)$/.test(job.artifact.file)) throw imagegenError('图片记录无效');
    const file = path.join(runtimeDir, 'images', id, job.artifact.file);
    const [base, real] = await Promise.all([fs.realpath(runtimeDir), fs.realpath(file)]);
    const relative = path.relative(base, real);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw imagegenError('图片路径越界');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > readConfig().imagegen.maxBytes) throw imagegenError('图片文件大小无效');
    const buffer = await fs.readFile(real);
    if (sha256(buffer) !== job.artifact.sha256) throw imagegenError('图片文件校验失败');
    return { job, file: real, buffer, mime: job.artifact.mime };
  }

  async function monitor(job, token, signal, initial, configured) {
    const settings = { ...(configured ?? readConfig().imagegen), ...job.server };
    const client = createImageClient(settings, { signal });
    const deadline = Date.now() + settings.timeoutMs;
    let remote = initial;
    let terminalRemote = false;
    try {
      while (true) {
        signal?.throwIfAborted();
        await checkContext(job.contextId);
        if (Date.now() >= deadline) throw imagegenError('等待生图超时，可按任务编号恢复', 'IMAGEGEN_PAUSED', 409);
        remote ??= job.remote.resultFile
          ? await readJson(path.join(runtimeDir, 'responses', `${job.id}.json`))
          : await client.status(job.remote.statusUrl);
        if (String(remote?.id) !== job.remote.id) throw imagegenError('生图服务返回的任务编号不一致');
        if (['failed', 'error', 'cancelled', 'canceled'].includes(remote.status)) {
          terminalRemote = true;
          throw imagegenError('生图服务未能完成任务', 'IMAGEGEN_REMOTE_FAILED', 502);
        }
        if (remote.status === 'completed') {
          terminalRemote = true;
          if (!Array.isArray(remote.images) || remote.images.length !== 1 ||
              (typeof remote.images[0]?.url !== 'string' && typeof remote.images[0]?.b64_json !== 'string')) {
            throw imagegenError('生图服务未返回一张有效图片');
          }
          const buffer = await client.download(remote.images[0]);
          const image = sniffImage(buffer);
          if (!image || !['.png', '.jpg', '.jpeg', '.webp'].includes(image.ext) || !image.width || !image.height || image.width > 2048 || image.height > 2048) {
            throw imagegenError('生图结果不是受支持的有效图片');
          }
          await checkContext(job.contextId);
          const dir = path.join(runtimeDir, 'images', job.id);
          await fs.mkdir(dir, { recursive: true });
          const file = `result${image.ext}`;
          const temp = path.join(dir, `${randomUUID()}.tmp`);
          await fs.writeFile(temp, buffer, { mode: 0o600 });
          await fs.rename(temp, path.join(dir, file));
          let sticker = null;
          if (job.mode === 'sticker') {
            const current = enabled();
            if (!current.stickers.enabled) throw imagegenError('表情包库已关闭，无法导入生成的表情');
            const imported = await upsertSticker({
              root: stickerRootDir({ configRoot, config: current }), buffer,
              text: job.request.prompt, tags: ['来源:生图', ...job.tags], settings: current.stickers,
              source: { type: 'imagegen', jobId: job.id },
            });
            if (!imported.item) throw imagegenError(`表情入库失败：${imported.reason}`);
            sticker = { id: imported.item.id, duplicate: imported.duplicate };
          }
          return await finish(job.id, token, {
            status: 'completed', error: null, completedAt: new Date().toISOString(), sticker,
            seed: remote.seed ?? job.seed,
            artifact: { file, sha256: sha256(buffer), bytes: buffer.length, mime: image.mime, width: image.width, height: image.height },
          });
        }
        if (!['queued', 'running'].includes(remote.status)) throw imagegenError('生图服务返回了未知任务状态');
        await saveWorker(job.id, token, { status: remote.status, error: null });
        remote = null;
        await client.wait();
      }
    } catch (error) {
      const message = error.code?.startsWith('IMAGEGEN_') ? error.message : '生图等待已停止，可按任务编号恢复';
      return finish(job.id, token, { status: terminalRemote ? 'failed' : 'paused', error: message });
    }
  }

  async function generate(input, { contextId = null, signal, onCreated } = {}) {
    const config = enabled();
    const { request, mode, tags } = imageRequest(input);
    providerImageRequest(config.imagegen, request);
    await checkContext(contextId);
    signal?.throwIfAborted();
    const token = randomUUID();
    const server = { baseUrl: new URL(config.imagegen.baseUrl).href.replace(/\/$/, ''),
      provider: config.imagegen.provider, model: config.imagegen.model, generationPath: config.imagegen.generationPath };
    const job = await transaction(async () => {
      if (JSON.stringify(enabled().imagegen) !== JSON.stringify(config.imagegen)) {
        throw imagegenError('生图设置已变更，请确认当前设置后重新生成', 'IMAGEGEN_CONFIG_CHANGED', 409);
      }
      const busy = (await list()).find((item) => item.server.baseUrl === server.baseUrl && !TERMINAL.has(item.status));
      if (busy) throw imagegenError(`生图服务已有未结束任务：${busy.id}（${busy.status}）`, 'IMAGEGEN_BUSY', 409);
      const id = randomUUID();
      const record = {
        version: 1, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        status: 'created', server, request, mode, tags, contextId,
        worker: { pid: process.pid, token }, remote: null, artifact: null, delivery: null,
      };
      await atomic(jobFile(id), record);
      return record;
    });
    onCreated?.(job);
    try {
      await checkContext(contextId);
      signal?.throwIfAborted();
    } catch (error) {
      return finish(job.id, token, { status: 'cancelled', error: error.message });
    }
    await saveWorker(job.id, token, { status: 'submitting' });
    let response;
    try {
      const client = createImageClient(config.imagegen, { signal });
      response = await client.submit(request);
      if (client.synchronous) {
        // Keep the received result durably before downloading; recovery must never repeat a paid POST.
        await atomic(path.join(runtimeDir, 'responses', `${job.id}.json`), response);
        job.remote = { id: response.id, resultFile: true };
        job.seed = request.seed ?? null;
        await saveWorker(job.id, token, { remote: job.remote, seed: job.seed, status: 'queued' });
      } else {
        if (typeof response?.id !== 'string' || !/^[\w-]{1,128}$/.test(response.id) || typeof response.status_url !== 'string') {
          throw imagegenError('提交结果缺少任务编号，禁止自动重复提交', 'IMAGEGEN_UNKNOWN', 409);
        }
        imageServiceUrl(config.imagegen, response.status_url);
        job.remote = { id: response.id, statusUrl: response.status_url };
        job.seed = response.seed ?? request.seed ?? null;
        await saveWorker(job.id, token, { remote: job.remote, seed: job.seed, status: 'queued' });
      }
    } catch (error) {
      const rejected = error.code === 'IMAGEGEN_HTTP' && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408;
      return finish(job.id, token, {
        status: rejected ? 'failed' : 'unknown',
        error: rejected ? error.message : '提交结果不确定；任务已保留，请先在生图服务确认，禁止直接重试',
      });
    }
    return monitor(job, token, signal, ['queued', 'running', 'completed'].includes(response.status) ? { ...response, id: job.remote.id } : undefined, config.imagegen);
  }

  async function resume(id, { signal, contextId, onCreated } = {}) {
    let config;
    const token = randomUUID();
    const job = await update(id, async (record) => {
      if (contextId !== undefined) {
        if (record.contextId !== contextId) throw imagegenError('任务不属于当前生图会话', 'IMAGEGEN_CONTEXT', 403);
        await checkContext(contextId);
      }
      if (TERMINAL.has(record.status)) return record;
      // The submitting transition is durable before any paid POST. Cancelling
      // a created record invalidates its token under the same metadata lock,
      // so an original worker racing recovery cannot proceed to submission.
      if (record.status === 'created' && !record.remote) {
        record.status = 'cancelled';
        record.error = '已取消尚未提交的任务，可以重新生成';
        record.worker = null;
        return record;
      }
      config = enabled();
      if (record.worker && alive(record.worker.pid)) throw imagegenError('已有进程正在等待这个任务', 'IMAGEGEN_BUSY', 409);
      if (!record.remote) {
        record.status = record.status === 'created' ? 'cancelled' : 'unknown';
        record.error = '没有远端任务编号，不能自动重提';
        record.worker = null;
        return record;
      }
      if (new URL(config.imagegen.baseUrl).href.replace(/\/$/, '') !== record.server.baseUrl ||
          config.imagegen.provider !== (record.server.provider ?? 'comfyui')) {
        throw imagegenError('当前生图平台或地址已变更，请恢复原设置后继续任务');
      }
      // A local console/CLI recovery may finish an expired QQ task, but cannot deliver it.
      record.status = 'queued';
      record.worker = { pid: process.pid, token };
    });
    onCreated?.(job);
    if (TERMINAL.has(job.status) || !job.remote) return job;
    return monitor({ ...job, contextId: contextId === undefined ? null : job.contextId }, token, signal, undefined, config.imagegen);
  }

  async function release(id) {
    return update(id, (job) => {
      if (job.worker && alive(job.worker.pid)) throw imagegenError('任务仍有进程运行，不能解除占用', 'IMAGEGEN_BUSY', 409);
      if (job.status !== 'unknown') throw imagegenError('只有提交结果不确定的任务可以手动解除占用');
      job.status = 'released';
      job.worker = null;
      job.error = '用户已在服务端确认后手动解除占用';
    });
  }

  return {
    runtimeDir, readConfig, transaction, get, list, update, generate, resume, release, artifact,
    createContext, closeContext, checkContext,
    async check() { return createImageClient(enabled().imagegen).health(); },
  };
}
