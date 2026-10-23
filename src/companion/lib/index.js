// src/companion/lib/index.js —— 在 DSH Desktop 宿主进程内运行的桥接连伴插件
//
// 为什么需要它：
//   - 桥接之前用独立子进程加载 desktop profile。会话确实写在同一个
//     ~/.dsh/sessions 里，但桌面端的会话列表只在「连接建立」时拉一次
//     （dsh-api-session-controller/lib/client.js 的 refreshList），独立进程
//     创建会话不会通知已经打开的桌面端，所以用户看不到。
//   - 这个插件挂在桌面端自己的 Host 里。它用宿主内的 sessionController 创建
//     会话，宿主会发 api-session/added 事件，列表立即出现；再配合
//     workspaceId，会话归到 qq-workspace 工作区，而不是「未分组」。
//
// 通信：
//   - 只监听 127.0.0.1 的随机端口，随机 token 放在
//     ~/.dsh/qq-bridge-companion.json，桥接进程读它来调用。
//   - 协议是普通 HTTP JSON：GET /health、POST /prompt、POST /cancel、
//     POST /attach。
//
// 约束：
//   - 只 import node: 内置模块；插件随 DSH 桌面端启动，任何异常都不能把宿主
//     带崩，所以 handler 全部 catch。
//   - 不把聊天正文写日志；日志只记 sessionId、耗时、错误。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const name = 'qq-bridge-companion';
export const inject = [
  'sessionController',
  'workspaceRegistry',
  'sessionPersistence',
  'sessionQuery',
  'sessions',
  'agents',
  'llm',
];

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BODY_BYTES = 256 * 1024;
const ATTACH_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const PERMISSION_ERROR_CODE = 'companion/permission-unsupported';
const MODEL_ERROR_CODE = 'companion/model-unavailable';

/** DSH home：优先 $DSH_HOME，否则 ~/.dsh（和桥接 src/dsh-desktop.js 保持一致） */
function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

function normalizePath(value) {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const a = normalizePath(left);
  const b = normalizePath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isLoopback(address) {
  const value = String(address ?? '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

/** 常量时间比较 token；长度不同直接失败。 */
function tokenEquals(expected, actual) {
  const left = Buffer.from(String(expected ?? ''));
  const right = Buffer.from(String(actual ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** 读取并限制大小的 JSON body；超过上限直接抛错。 */
async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed;
}

function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 宿主 cancel 有同步和异步实现；取消失败不能逃出 AbortSignal 回调。 */
function cancelSession(controller, sessionId, log) {
  try {
    Promise.resolve(controller.cancel({ sessionId })).catch((error) => {
      log.warn(`companion: 取消会话 ${sessionId} 失败：${String(error)}`);
    });
  } catch (error) {
    log.warn(`companion: 取消会话 ${sessionId} 失败：${String(error)}`);
  }
}

function permissionError(message) {
  return Object.assign(new Error(message), {
    code: PERMISSION_ERROR_CODE,
    sessionAccepted: false,
  });
}

/** 预设名字可自定义；核对沙箱与审批实际取值，不能只信同名预设。 */
function permissionPlan(ctx, mode) {
  if (!PERMISSION_MODES.includes(mode)) throw permissionError('必须明确有效的 permissionMode');
  let service;
  try {
    service = ctx.get('permissionPresets');
  } catch {
    throw permissionError('宿主没有可用的逐会话权限服务');
  }
  if (!service || !['set', 'current', 'resolve'].every((key) => typeof service[key] === 'function')) {
    throw permissionError('宿主没有可用的逐会话权限服务');
  }
  const approval = mode === 'danger-full-access' ? 'never' : 'ask';
  const names = new Set([mode, ...(Array.isArray(service.names) ? service.names : [])]);
  for (const name of names) {
    try {
      const spec = service.resolve(name);
      if (spec?.sandbox === mode && spec?.approval === approval) return { service, name, mode, approval };
    } catch {
      /* 预设不受支持，继续检查配置中的其它名字。 */
    }
  }
  throw permissionError(`宿主不能保证请求的权限：${mode}`);
}

function supportedPermissionModes(ctx) {
  return PERMISSION_MODES.filter((mode) => {
    try {
      permissionPlan(ctx, mode);
      return true;
    } catch {
      return false;
    }
  });
}

async function applyPermission(plan, session) {
  try {
    await plan.service.set(session, plan.name);
    const effective = plan.service.resolve(plan.service.current(session));
    if (effective?.sandbox !== plan.mode || effective?.approval !== plan.approval) {
      throw new Error('应用后权限与请求不匹配');
    }
  } catch (error) {
    throw permissionError(`不能应用请求的会话权限：${String(error?.message ?? error)}`);
  }
}

/** 从会话事件里取最后一条 assistant 文本和 turn/end 原因。 */
function readTurnResult(session, firstSeq) {
  let text = '';
  let reason = null;
  let model = null;
  const modelsUsed = [];
  const seen = new Set();
  let activeHeader = null;
  // DSH omits unchanged request headers; the preceding snapshot stays in force.
  for (let seq = firstSeq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'request/header') {
      activeHeader = event.data?.header?.config ?? null;
      break;
    }
  }
  const recordModel = (value, header = false) => {
    if (typeof value?.provider !== 'string' || typeof value?.model !== 'string') return;
    const effort = !header && value.reasoningEffort === undefined &&
      activeHeader?.provider === value.provider && activeHeader?.model === value.model
      ? activeHeader.reasoningEffort : value.reasoningEffort;
    model = {
      provider: value.provider,
      model: value.model,
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    };
    const key = JSON.stringify(model);
    if (!seen.has(key)) { seen.add(key); modelsUsed.push(model); }
  };
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'assistant/message') {
      recordModel(event.data?.message?.source);
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        const parts = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text);
        if (parts.length > 0) text = parts.join('');
      }
    } else if (event.type === 'request/header') {
      activeHeader = event.data?.header?.config ?? null;
      recordModel(activeHeader, true);
    } else if (event.type === 'turn/end') {
      reason = event.data?.reason ?? null;
    }
  }
  return { text, reason, model, modelsUsed };
}

/** Return only public model identifiers and resolved reasoning capabilities. */
function publicModelCatalog(catalog) {
  return { providers: (catalog.groups ?? []).map((group) => ({
    id: group.id,
    models: (group.models ?? []).map((model) => ({
      id: model.id,
      reasoning: model.reasoning === undefined
        ? { status: 'none', efforts: [] }
        : {
            status: 'known',
            efforts: model.reasoning.efforts.map((effort) => effort.id),
            ...(model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
          },
    })),
  })) };
}

/** 在 workspaceRegistry 里按路径找工作区。 */
function findWorkspace(registry, workspacePath) {
  if (!workspacePath) return undefined;
  try {
    return registry.list().find((workspace) => samePath(workspace.path, workspacePath));
  } catch {
    return undefined;
  }
}

/** 把桥接 state/sessions.json 里记录的会话挂进工作区，只补最近一周的。 */
async function attachKnownSessions(ctx, workspace, sessionMapPath, log) {
  if (!workspace || !sessionMapPath) return;
  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
  } catch {
    return;
  }
  const now = Date.now();
  const attached = [];
  const sessionIds = Object.values(mapping ?? {}).map((value) =>
    typeof value === 'string' ? value : value?.sessionId);
  for (const sessionId of new Set(sessionIds)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || /^qq-chat-/i.test(sessionId)) continue;
    try {
      if (workspace.sessionIds.includes(sessionId)) continue;
      let header;
      try {
        const observation = await ctx.get('sessionQuery').observeSession(sessionId);
        header = observation?.header;
      } catch {
        continue;
      }
      if (!header || !samePath(header.cwd, workspace.path)) continue;
      if (header && Number.isFinite(header.createdAt) && now - header.createdAt > ATTACH_HISTORY_MS) continue;
      await workspace.attachSession(sessionId);
      attached.push(sessionId);
    } catch (error) {
      log?.warn?.(`companion: 挂载历史会话 ${sessionId} 失败：${String(error)}`);
    }
  }
  if (attached.length > 0) log?.info?.(`companion: 已把 ${attached.length} 个桥接会话挂进工作区 ${workspace.path}`);
}

/**
 * 插件入口。
 * @param {object} ctx Cordis context
 * @param {{discoveryPath?: string, sessionMapPath?: string, workspacePath?: string, promptTimeoutMs?: number}} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const log = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    error: (message) => ctx.logger?.error?.(message),
  };
  const discoveryPath = path.resolve(
    String(config.discoveryPath ?? '').trim() || path.join(resolveDshHome(), 'qq-bridge-companion.json'),
  );
  const token = randomBytes(24).toString('hex');
  const startedAt = new Date().toISOString();
  /** @type {Map<string, AbortController>} */
  const running = new Map();
  let server;
  let closing = false;

  /** 写 discovery 文件；先写临时文件再 rename，避免桥接读到半截 JSON。 */
  function publishDiscovery(port) {
    const payload = {
      version: 1,
      pid: process.pid,
      port,
      token,
      startedAt,
      discoveryPath,
    };
    const temp = `${discoveryPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(discoveryPath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      try {
        fs.rmSync(discoveryPath, { force: true });
      } catch {
        /* 文件可能不存在 */
      }
      fs.renameSync(temp, discoveryPath);
    } catch (error) {
      log.warn(`companion: 写 discovery 文件失败：${String(error)}`);
    }
  }

  async function handlePrompt(body, requestAbort) {
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) throw new Error('text 不能为空');
    const requestedSessionId =
      typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined;
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : config.workspacePath;
    const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : workspacePath;
    const timeoutMs = Number.isFinite(body.timeoutMs)
      ? Math.min(Math.max(Number(body.timeoutMs), 5_000), 20 * 60_000)
      : Number.isFinite(config.promptTimeoutMs)
        ? Number(config.promptTimeoutMs)
        : DEFAULT_TIMEOUT_MS;

    const controller = ctx.get('sessionController');
    const registry = ctx.get('workspaceRegistry');
    const agents = ctx.get('agents');
    // DSH 0.2.x owns session selections on the controller, not the Agent registry.
    const modelSelections = controller?.agents?.selectForNextRequest ? controller.agents : agents;
    const sessions = ctx.get('sessions');
    if (!controller || !agents || !sessions) throw new Error('DSH 会话服务尚未就绪');
    const permission = permissionPlan(ctx, body.permissionMode);

    const workspace = findWorkspace(registry, workspacePath);
    let created;
    let restoredAgent;
    if (requestedSessionId && typeof controller.resolveAgent === 'function') {
      // 新宿主的 create 只复用空白会话，已有对话必须显式恢复。
      const restored = await controller.resolveAgent(requestedSessionId);
      if (restored?.error) throw restored.error;
      restoredAgent = restored?.agent ?? restored;
      created = { sessionId: requestedSessionId };
      if (workspace && !workspace.sessionIds.includes(requestedSessionId)) {
        try {
          await workspace.attachSession(requestedSessionId);
        } catch (attachError) {
          log.warn(`companion: 会话 ${requestedSessionId} 挂载工作区失败：${String(attachError)}`);
        }
      }
    } else try {
      created = workspace
        ? await controller.create({
            workspaceId: workspace.id,
            ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
          })
        : await controller.create({
            ...(cwd === undefined ? {} : { cwd }),
            ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
          });
    } catch (error) {
      // 续传旧会话时，它的 cwd 可能和工作区路径不同；按旧 cwd 恢复后再挂载。
      if (!requestedSessionId) throw error;
      let storedCwd = cwd;
      try {
        const observation = await ctx.get('sessionQuery').observeSession(requestedSessionId);
        storedCwd = observation?.header?.cwd ?? storedCwd;
      } catch {
        /* 会话不存在，保留原 cwd */
      }
      created = await controller.create({ cwd: storedCwd, sessionId: requestedSessionId });
      if (workspace) {
        try {
          await workspace.attachSession(created.sessionId);
        } catch (attachError) {
          log.warn(`companion: 会话 ${created.sessionId} 挂载工作区失败：${String(attachError)}`);
        }
      }
    }

    const sessionId = created.sessionId;
    if (running.has(sessionId)) throw new Error(`会话 ${sessionId} 正在处理上一条消息`);
    const agent = restoredAgent ?? agents.get(sessionId);
    if (!agent) throw new Error(`会话 ${sessionId} 没有可用的 Agent`);
    const abort = new AbortController();
    running.set(sessionId, abort);
    const onRequestAbort = () => abort.abort();
    if (requestAbort) {
      if (requestAbort.signal.aborted) abort.abort();
      else requestAbort.signal.addEventListener('abort', onRequestAbort, { once: true });
    }

    let firstSeq = agent.session.seq;
    let timer;
    let timedOut = false;
    let promptSubmitted = false;
    let rejectAborted;
    const abortedPromise = new Promise((_, reject) => { rejectAborted = reject; });
    void abortedPromise.catch(() => {});
    const onAbort = () => {
      if (promptSubmitted) cancelSession(controller, sessionId, log);
      rejectAborted(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs);
      if (abort.signal.aborted) {
        onAbort();
        await abortedPromise;
      }
      // Leave a desktop turn in flight on its original selection.
      if (agent.status === 'running') await Promise.race([agent.whenIdle(), abortedPromise]);
      const admit = async () => {
        if (abort.signal.aborted) await abortedPromise;
        let selected = null;
        if (body.model !== undefined && body.model !== null) {
          const model = body.model;
          try {
            if (typeof model.provider !== 'string' || !model.provider.trim() ||
                typeof model.model !== 'string' || !model.model.trim()) throw new Error('模型选择需要 provider 和 model');
            selected = await Promise.race([
              ctx.get('llm').resolveCallConfig({
                provider: model.provider,
                model: model.model,
                ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
              }, abort.signal),
              abortedPromise,
            ]);
            if (abort.signal.aborted) await abortedPromise;
          } catch (error) {
            if (abort.signal.aborted) throw error;
            throw Object.assign(new Error(`指定的模型不可用：${String(error?.message ?? error)}`), {
              code: MODEL_ERROR_CODE, sessionAccepted: true,
            });
          }
        }
        await Promise.race([applyPermission(permission, agent.session), abortedPromise]);
        if (abort.signal.aborted) await abortedPromise;
        firstSeq = agent.session.seq;
        if (selected) {
          try {
            await modelSelections.selectForNextRequest(agent, {
              provider: selected.provider,
              model: selected.model,
              ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
            });
          } catch (error) {
            throw Object.assign(new Error(`不能应用模型选择：${String(error?.message ?? error)}`), {
              code: MODEL_ERROR_CODE, sessionAccepted: true,
            });
          }
        }
        if (abort.signal.aborted) await abortedPromise;
        promptSubmitted = true;
        await Promise.race([controller.prompt({
          requestId: randomUUID(), sessionId, mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, abort.signal), abortedPromise]);
      };
      await Promise.race([
        typeof modelSelections?.serializeImageAdmission === 'function' ? modelSelections.serializeImageAdmission(agent, admit) : admit(),
        abortedPromise,
      ]);
      await Promise.race([agent.whenIdle(), abortedPromise]);
      if (timedOut) throw new Error(`对话超时（${timeoutMs}ms）`);
      const { text: finalText, reason, model, modelsUsed } = readTurnResult(agent.session, firstSeq);
      if (finalText.trim().length === 0) {
        const kind = reason?.kind ?? 'empty';
        const detail = reason?.error?.message ? `：${reason.error.message}` : '';
        throw new Error(`本轮没有生成回复（${String(kind)}${detail}）`);
      }
      return { sessionId, text: finalText, reason, model, modelsUsed, workspaceId: workspace?.id ?? null };
    } catch (error) {
      if (timedOut) error = new Error(`对话超时（${timeoutMs}ms）`);
      if (error && typeof error === 'object' && !error.sessionId) error.sessionId = sessionId;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      if (requestAbort) requestAbort.signal.removeEventListener('abort', onRequestAbort);
      running.delete(sessionId);
      try {
        await sessions.flush(agent.session);
      } catch (error) {
        log.warn(`companion: 会话 ${sessionId} 落盘失败：${String(error)}`);
      }
    }
  }

  async function handleAttach(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) throw new Error('sessionId 不能为空');
    const workspace = findWorkspace(ctx.get('workspaceRegistry'), body.workspacePath ?? config.workspacePath);
    if (!workspace) throw new Error('找不到对应的工作区');
    await workspace.attachSession(sessionId);
    return { sessionId, workspaceId: workspace.id };
  }

  async function route(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '只接受本机连接' });
      return;
    }
    const auth = String(req.headers.authorization ?? '');
    const actual = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenEquals(token, actual)) {
      sendJson(res, 401, { ok: false, error: 'token 无效' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        startedAt,
        workspace: config.workspacePath ?? null,
        running: [...running.keys()],
        permissionProtocol: 1,
        permissionModes: supportedPermissionModes(ctx),
        modelProtocol: 1,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      const controller = ctx.get('sessionController');
      if (typeof controller?.modelCatalog !== 'function') {
        sendJson(res, 404, { ok: false, error: '模型目录不可用' });
      } else {
        try {
          sendJson(res, 200, { ok: true, ...publicModelCatalog(await controller.modelCatalog()) });
        } catch {
          sendJson(res, 503, { ok: false, error: '模型目录暂不可用' });
        }
      }
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      return;
    }
    if (url.pathname === '/cancel') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const runningAbort = running.get(sessionId);
      if (runningAbort) runningAbort.abort();
      sendJson(res, 200, { ok: true, cancelled: runningAbort !== undefined });
      return;
    }
    if (url.pathname === '/attach') {
      try {
        sendJson(res, 200, { ok: true, ...(await handleAttach(body)) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (url.pathname !== '/prompt') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    const started = Date.now();
    let sessionId = null;
    const requestAbort = new AbortController();
    // 客户端断开（桥接超时/退出）时取消这一轮，避免后台空转。
    res.on('close', () => {
      if (!res.writableEnded) requestAbort.abort();
    });
    try {
      const result = await handlePrompt(body, requestAbort);
      sessionId = result.sessionId;
      const elapsedMs = Date.now() - started;
      log.info(`companion: 会话 ${result.sessionId} 完成，用时 ${elapsedMs}ms`);
      sendJson(res, 200, { ok: true, ...result, elapsedMs });
    } catch (error) {
      sessionId = sessionId ?? error?.sessionId ?? null;
      const message = String(error?.message ?? error);
      log.warn(`companion: 对话失败：${message}`);
      sendJson(res, error?.code === MODEL_ERROR_CODE ? 400 : 500, {
        ok: false,
        error: message,
        sessionId,
        ...(error?.code === PERMISSION_ERROR_CODE && error?.sessionAccepted === false
          ? { code: PERMISSION_ERROR_CODE, sessionAccepted: false }
          : {}),
        ...(error?.code === MODEL_ERROR_CODE ? { code: MODEL_ERROR_CODE, sessionAccepted: true } : {}),
      });
    }
  }

  server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      } catch {
        /* 连接已经断了 */
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  publishDiscovery(port);
  log.info(`companion: 已监听 127.0.0.1:${port}（discovery：${discoveryPath}）`);

  ctx.effect(() => () => {
    closing = true;
    for (const abort of running.values()) abort.abort();
    running.clear();
    try {
      server.close();
    } catch {
      /* 已关闭 */
    }
    try {
      const current = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      if (current.pid === process.pid) fs.rmSync(discoveryPath, { force: true });
    } catch {
      /* discovery 可能已被替换 */
    }
  });

  // 异步补挂历史会话，不阻塞宿主启动。
  const workspace = findWorkspace(ctx.get('workspaceRegistry'), config.workspacePath);
  attachKnownSessions(ctx, workspace, config.sessionMapPath, log).catch((error) => {
    log.warn(`companion: 补挂历史会话失败：${String(error)}`);
  });

  // 关闭时不再处理新请求。
  server.on('close', () => {
    closing = true;
  });
  void closing;
}
