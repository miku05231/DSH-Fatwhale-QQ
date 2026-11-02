import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isAdministrator, isAllowed, isUserBlocked, isGroupWatched } from './security.js';
import { prepareFileForNapcat, normalizeFileMappings } from './file-bridge.js';
import { astrbotAdmission, astrbotError, astrbotStateRoot, atomicAstrbotJson } from './astrbot-policy.mjs';
import { astrbotScheduledOriginEpochs, assertAstrbotScheduledOrigin } from './astrbot-outbound.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const uuid = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const digest = (v) => createHash('sha256').update(v).digest('hex');
const deny = () => { throw astrbotError('ASTRBOT_PERMISSION_DENIED'); };

/** The sidecar never owns QQ credentials. Every effect returns through this gate. */
export function createAstrbotBridge({ root, readConfig, policy, manager, send, generate, logger = {},
  host = '127.0.0.1', port = 5832 } = {}) {
  let server;
  let starting;
  const active = new Map(), operations = new Map();
  const dir = () => astrbotStateRoot(root, readConfig());
  const contextFile = (id) => {
    if (!uuid(id)) deny();
    return path.join(dir(), 'contexts', `${id}.json`);
  };
  async function context(id) {
    try { return JSON.parse(await fs.readFile(contextFile(id), 'utf8')); }
    catch { deny(); }
  }
  async function enabledIds() {
    const list = await manager.listPlugins();
    return (Array.isArray(list) ? list : list.plugins || []).filter((p) => p.enabled === true)
      .map((p) => p.id ?? p.name);
  }
  async function authorize(id, pluginId, method) {
    const [ctx, p, ids] = await Promise.all([context(id), policy.get(), enabledIds()]);
    const cfg = readConfig();
    if (pluginId !== '__ai__') {
      try { await assertAstrbotScheduledOrigin({ root: dir(), pluginId, context: ctx }); }
      catch { deny(); }
    }
    const admin = isAdministrator(ctx.userId, cfg);
    if (!p.enabled || ctx.cancelled || isUserBlocked(ctx.userId, cfg) || (ctx.isAdmin && !admin)) deny();
    if (ctx.isGroup) {
      if (!cfg.security?.allowGroups || !isGroupWatched(ctx.groupId, cfg)) deny();
      const group = p.groups[ctx.groupId];
      if (!group) deny();
      if (pluginId === '__ai__') {
        if (method === 'tools.authorize' || !ctx.allowAi || group.chatMode !== 'astrbot') deny();
      } else if (!ctx.pluginIds.includes(pluginId) || !group.pluginIds.includes(pluginId) || !ids.includes(pluginId)) deny();
    } else if (!admin || !isAllowed(ctx.userId, cfg) || !ctx.pluginIds.includes(pluginId) || !ids.includes(pluginId)) deny();
    return ctx;
  }
  async function effect(id, change) {
    // Concurrent sends/tools for one origin must not lose the durable effect flag.
    const op = (operations.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const ctx = await context(id);
      Object.assign(ctx, change);
      await atomicAstrbotJson(contextFile(id), ctx);
      return ctx;
    });
    operations.set(id, op);
    try { return await op; } finally { if (operations.get(id) === op) operations.delete(id); }
  }
  async function mediaMessage(message, ctx) {
    if (!Array.isArray(message) || !message.length || message.length > 100) throw astrbotError('ASTRBOT_MESSAGE_INVALID');
    const normalized = [];
    for (const item of message) {
      const data = item?.data || {};
      if (item?.type === 'text' && typeof data.text === 'string' && data.text.length <= 16000) {
        normalized.push({ type: 'text', data: { text: data.text } });
      } else if (item?.type === 'at' && (/^[1-9]\d{0,19}$/.test(String(data.qq)) || (ctx.isAdmin && data.qq === 'all'))) {
        normalized.push({ type: 'at', data: { qq: String(data.qq) } });
      } else if (item?.type === 'reply' && /^[1-9]\d{0,19}$/.test(String(data.id))) {
        normalized.push({ type: 'reply', data: { id: String(data.id) } });
      } else if (['image', 'record', 'video', 'file'].includes(item?.type) && typeof data.file === 'string') {
        let file = data.file;
        const handle = /^astrbot-media:\/\/([a-f0-9-]{36}\.[a-z0-9]{1,8})$/.exec(file);
        if (handle) {
          const mediaDir = path.join(dir(), 'media');
          const local = await fs.realpath(path.join(mediaDir, handle[1]));
          const relative = path.relative(await fs.realpath(mediaDir), local);
          if (path.isAbsolute(relative) || relative.startsWith('..')) deny();
          const prepared = await prepareFileForNapcat(local, { config: readConfig(), configRoot: root });
          if (!prepared.ok) throw astrbotError('ASTRBOT_MEDIA_UNAVAILABLE');
          // A Windows bridge may send to a Linux NapCat mount; keep that target's
          // POSIX path instead of letting Windows add a drive letter to the URL.
          file = prepared.file.startsWith('/')
            ? `file://${prepared.file.split('/').map(encodeURIComponent).join('/')}`
            : pathToFileURL(prepared.file).href;
        } else if (!/^https?:\/\//i.test(file) && !/^base64:\/\/[A-Za-z0-9+/=]+$/.test(file)) {
          throw astrbotError('ASTRBOT_MEDIA_HANDLE_REQUIRED');
        }
        if (file.length > 12 * 1024 * 1024) throw astrbotError('ASTRBOT_MEDIA_TOO_LARGE');
        normalized.push({ type: item.type, data: { file, ...(item.type === 'image' && data.sub_type === 1 ? { sub_type: 1 } : {}),
          ...(item.type === 'file' ? { name: String(data.name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120) } : {}) } });
      } else throw astrbotError('ASTRBOT_SEGMENT_UNSUPPORTED');
    }
    return normalized;
  }
  async function incomingMessage(message) {
    // A local QQ media path is never a sidecar filesystem path. Read only the
    // controlled media caches and explicit media mounts, then transfer bytes.
    if (message.length > 100) throw astrbotError('ASTRBOT_MESSAGE_INVALID');
    const cfg = readConfig();
    const state = path.dirname(dir());
    const roots = await Promise.all([
      path.join(dir(), 'media'), path.join(state, 'inbox'), path.join(state, 'outbox'),
      ...normalizeFileMappings(cfg).map((mapping) => mapping.container),
    ].map((value) => fs.realpath(value).catch(() => null)));
    let transferred = 0;
    const normalize = async (item) => {
      if (!['image', 'record', 'audio'].includes(item?.type)) return item;
      const data = { ...item.data };
      const remote = [data.url, data.file].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
      if (remote) return { ...item, data: { ...data, file: remote, url: remote } };
      if (typeof data.file !== 'string' || (!path.isAbsolute(data.file) && !data.file.startsWith('file:'))) return item;
      let local;
      try { local = await fs.realpath(data.file.startsWith('file:') ? fileURLToPath(data.file) : data.file); }
      catch { throw astrbotError('ASTRBOT_MEDIA_UNAVAILABLE'); }
      if (!roots.some((allowed) => {
        if (!allowed) return false;
        const relative = path.relative(allowed, local);
        return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      })) deny();
      const stat = await fs.stat(local);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw astrbotError('ASTRBOT_MEDIA_TOO_LARGE');
      const bytes = await fs.readFile(local);
      transferred += bytes.length;
      if (bytes.length > 8 * 1024 * 1024 || transferred > 10 * 1024 * 1024) throw astrbotError('ASTRBOT_MEDIA_TOO_LARGE');
      return { ...item, data: { file: `base64://${bytes.toString('base64')}` } };
    };
    const result = [];
    for (const item of message) result.push(await normalize(item));
    return result;
  }
  async function callback(body, { signal } = {}) {
    if (body?.version !== 1) throw astrbotError('ASTRBOT_RPC_VERSION');
    const { method, contextId, pluginId, params = {} } = body;
    const assertLive = () => {
      if (signal?.aborted || active.get(contextId)?.signal.aborted) throw astrbotError('ASTRBOT_RPC_ABORTED');
    };
    assertLive();
    if (method === 'outbound.send') {
      if (contextId !== undefined && contextId !== null) deny();
      if (!params || !Array.isArray(params.message) || !params.message.length || params.message.length > 32
        || params.message.some((item) => item?.type !== 'text' || typeof item?.data?.text !== 'string'
          || !item.data.text.length || item.data.text.length > 16000)
        || typeof policy.authorizeOutbound !== 'function') deny();
      const authorization = { pluginId, purpose: params.purpose, sourceSHA256: params.sourceSHA256, target: params.target };
      await policy.authorizeOutbound(authorization);
      assertLive();
      const target = params.target;
      const message = params.message.map((item) => ({ type: 'text', data: { text: item.data.text } }));
      // The final check includes explicit revoke, lifecycle epochs, current
      // source/config, global policy and the exact approved destination.
      await policy.authorizeOutbound(authorization);
      assertLive();
      return send(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
        ...(target.kind === 'group' ? { group_id: Number(target.id) } : { user_id: Number(target.id) }), message,
      });
    }
    const ctx = await authorize(contextId, pluginId, method);
    assertLive();
    if (method === 'send') {
      const target = params.target;
      if (!target || target.isGroup !== ctx.isGroup
        || String(ctx.isGroup ? target.groupId : target.userId) !== String(ctx.isGroup ? ctx.groupId : ctx.userId)) deny();
      const message = await mediaMessage(params.message, ctx);
      assertLive();
      await effect(contextId, { sent: true });
      await authorize(contextId, pluginId, method);
      assertLive();
      return send(ctx.isGroup ? 'send_group_msg' : 'send_private_msg', {
        ...(ctx.isGroup ? { group_id: Number(ctx.groupId) } : { user_id: Number(ctx.userId) }), message,
      });
    }
    if (method === 'llm') {
      await effect(contextId, { modelUsed: true });
      await authorize(contextId, pluginId, method);
      assertLive();
      const signals = [active.get(contextId)?.signal, signal].filter(Boolean);
      const result = await generate(params, { signal: signals.length ? AbortSignal.any(signals) : undefined });
      await authorize(contextId, pluginId, method);
      assertLive();
      return result;
    }
    if (method === 'tools.authorize') {
      if (typeof params.name !== 'string' || !params.name || pluginId === '__ai__') deny();
      if (params.recordUse !== false) await effect(contextId, { toolUsed: true });
      await authorize(contextId, pluginId, method);
      assertLive();
      return { allowed: true };
    }
    if (method === 'media.put') {
      if (!/^[a-z0-9]{1,8}$/.test(params.extension || '') || typeof params.base64 !== 'string'
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.base64)) throw astrbotError('ASTRBOT_MEDIA_INVALID');
      const bytes = Buffer.from(params.base64, 'base64');
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw astrbotError('ASTRBOT_MEDIA_TOO_LARGE');
      const name = `${randomUUID()}.${params.extension}`;
      await fs.mkdir(path.join(dir(), 'media'), { recursive: true });
      assertLive();
      const filename = path.join(dir(), 'media', name);
      await fs.writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
      if (signal?.aborted || active.get(contextId)?.signal.aborted) {
        await fs.rm(filename, { force: true });
        throw astrbotError('ASTRBOT_RPC_ABORTED');
      }
      return { file: `astrbot-media://${name}` };
    }
    throw astrbotError('ASTRBOT_RPC_METHOD');
  }
  async function listenCallback() {
    if (server) return server.address();
    const token = await manager.getToken();
    const candidate = http.createServer(async (req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/rpc/callback') return respond(404, { error: { code: 'NOT_FOUND' } });
      if (!token || !same(req.headers.authorization || '', `Bearer ${token}`) || req.headers.origin) return respond(403, { error: { code: 'FORBIDDEN' } });
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw astrbotError('ASTRBOT_RPC_TOO_LARGE'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await callback(body, { signal: abort.signal });
        respond(200, { version: 1, id: body.id, result });
      } catch (error) {
        const code = String(error.code || '').startsWith('ASTRBOT_') ? error.code : 'ASTRBOT_CALLBACK_FAILED';
        logger.warn?.(`AstrBot callback: ${code}`);
        respond(code === 'ASTRBOT_PERMISSION_DENIED' ? 403 : 400, { version: 1, error: { code, message: code } });
      }
    });
    candidate.requestTimeout = 180000; candidate.headersTimeout = 10000;
    await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(port, host, resolve); });
    server = candidate;
    return server.address();
  }
  function start() {
    if (server) return Promise.resolve(server.address());
    if (!starting) starting = listenCallback().finally(() => { starting = null; });
    return starting;
  }
  async function dispatch(msg, { signal, text = msg.text, isWake = false } = {}) {
    const p = await policy.get();
    if (!p.enabled) return { handled: false, status: 'unhandled' };
    const admitted = astrbotAdmission(msg, readConfig(), p, await enabledIds());
    if (!admitted) return { handled: false, status: 'unhandled' };
    const messageId = String(msg.raw?.message_id ?? msg.messageId ?? randomUUID());
    const claimFile = path.join(dir(), 'claims', `${digest(`${msg.messageType}:${msg.groupId || msg.userId}:${messageId}`)}.json`);
    await fs.mkdir(path.dirname(claimFile), { recursive: true });
    const id = randomUUID();
    try { await fs.writeFile(claimFile, JSON.stringify({ contextId: id }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return { handled: true, status: 'duplicate' }; throw error; }
    await atomicAstrbotJson(contextFile(id), {
      id, messageId, createdAt: new Date().toISOString(), userId: String(msg.userId),
      scheduledAuthorization: await astrbotScheduledOriginEpochs(dir(), admitted.pluginIds),
      groupId: admitted.isGroup ? String(msg.groupId) : null, isGroup: admitted.isGroup,
      isAdmin: admitted.isAdmin, pluginIds: admitted.pluginIds,
      allowAi: admitted.chatMode === 'astrbot' && isWake, sent: false, toolUsed: false, status: 'pending',
    });
    const abort = new AbortController(); active.set(id, abort);
    const cancel = () => {
      abort.abort();
      void effect(id, { cancelled: true }).catch(() => {});
      void manager.runtimeRpc('cancel', { contextId: id }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    let timer;
    try {
      signal?.throwIfAborted();
      await start();
      await manager.start();
      timer = setTimeout(cancel, 180000); timer.unref?.();
      const result = await manager.runtimeRpc('dispatch', {
        contextId: id,
        event: { messageId, text: String(text || ''), userId: String(msg.userId), nickname: String(msg.raw?.sender?.card || msg.raw?.sender?.nickname || ''),
          groupId: admitted.isGroup ? String(msg.groupId) : null, isGroup: admitted.isGroup, isAdmin: admitted.isAdmin, isWake,
          message: await incomingMessage(Array.isArray(msg.raw?.message) ? msg.raw.message : [{ type: 'text', data: { text: String(text || '') } }]) },
        policy: { pluginIds: admitted.pluginIds, chatMode: admitted.chatMode, allowAi: admitted.chatMode === 'astrbot' && isWake },
        deadlineAt: Date.now() + 180000,
      }, { signal: abort.signal });
      const latest = await effect(id, { status: result?.status || 'complete' });
      const handled = latest.sent || latest.toolUsed || result?.handled === true || admitted.chatMode === 'astrbot';
      return { handled, status: handled ? 'handled' : 'unhandled' };
    } catch (error) {
      await effect(id, { status: 'failed', cancelled: true });
      logger.warn?.('AstrBot dispatch failed; this message will not be replayed.');
      return { handled: true, status: 'failed' };
    } finally {
      clearTimeout(timer); active.delete(id); signal?.removeEventListener('abort', cancel);
    }
  }
  return { dispatch, callback, start, async admit(msg) {
    try { return Boolean(astrbotAdmission(msg, readConfig(), await policy.get(), await enabledIds())); }
    catch { return false; }
  }, async stop() {
    for (const [id, controller] of active) { controller.abort(); await effect(id, { cancelled: true }); }
    if (starting) await starting.catch(() => {});
    if (server) { const old = server; server = null; old.closeAllConnections(); await new Promise((resolve) => old.close(resolve)); }
  } };
}
