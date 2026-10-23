// src/dsh-desktop-host.mjs —— DSH Desktop profile 常驻宿主（子进程）
//
// 为什么需要它：
//   `dsh --profile headless` 只挂 base + headless，没有桌面插件；而
//   `dsh --profile desktop` 被 Electron 独占（CLI 会拒绝）。这个宿主用
//   @deepseek-ai/dsh-app-boot + @deepseek-ai/dsh/profile-boot 在普通 Node 里
//   加载**用户已安装的 desktop profile**，于是 QQ 会话也能用上桌面端的全部
//   工具与插件，并且会话落在同一个 ~/.dsh/sessions 里，桌面端刷新即可看到。
//
// 进程协议（stdin/stdout 各一行一个 JSON，stdout 只允许协议行）：
//   父进程 → 宿主：
//     {"v":1,"op":"prompt","id":"...","sessionId":null|"...","cwd":"...","text":"...","model":{...}|null}
//     {"v":1,"op":"cancel","id":"..."}
//     {"v":1,"op":"shutdown"}
//   宿主 → 父进程：
//     {"v":1,"type":"ready","pid":123,"bootMs":1234}
//     {"v":1,"type":"session","id":"...","sessionId":"session-...","adopted":true|false}
//     {"v":1,"type":"final","id":"...","sessionId":"session-...","text":"...","model":{...}|null}
//     {"v":1,"type":"error","id":"...","sessionId":null|"...","code":"...","message":"..."}
//     {"v":1,"type":"fatal","message":"..."}
//
// 铁律：
//   - DSH 自己会往 stdout 打 banner（其中可能有带 token 的 URL），必须全部吞掉；
//     协议行用保存下来的原始 write 输出。
//   - 绝不把 token / key 写进任何协议消息，错误信息发出去之前先脱敏。
//   - 任何异常都要回 error，不能静默卡死；父进程还有超时杀进程树兜底。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';

/* ------------------------------------------------------------------ *
 * stdout 保护：先接管，再动态 import DSH（import 期间也可能有输出）
 * ------------------------------------------------------------------ */
const rawWrite = process.stdout.write.bind(process.stdout);
let swallowed = 0;
process.stdout.write = function swallow() {
  swallowed += 1;
  return true;
};

function send(event) {
  try {
    rawWrite(`${JSON.stringify(event)}\n`);
  } catch {
    /* 父进程已经退出时写不出去，忽略 */
  }
}

function logStderr(text) {
  try {
    process.stderr.write(`[desktop-host] ${text}\n`);
  } catch {
    /* 忽略 */
  }
}

const sanitize = redactSecrets;

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { dshRoot: '', profileDir: '', cwd: process.cwd(), permission: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      return argv[i] ?? '';
    };
    if (key === '--dsh-root') out.dshRoot = next();
    else if (key === '--profile-dir') out.profileDir = next();
    else if (key === '--cwd') out.cwd = next();
    else if (key === '--permission') out.permission = next();
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

if (!options.dshRoot || !fs.existsSync(path.join(options.dshRoot, 'package.json'))) {
  send({ v: 1, type: 'fatal', message: `找不到 DSH 安装目录：${options.dshRoot || '(空)'}` });
  process.exit(2);
}
if (!options.profileDir || !fs.existsSync(options.profileDir)) {
  send({ v: 1, type: 'fatal', message: `找不到 desktop profile 目录：${options.profileDir || '(空)'}` });
  process.exit(2);
}

if (options.permission) process.env.DSH_PERMISSION_MODE = options.permission;

const requireFromDsh = createRequire(path.join(options.dshRoot, 'package.json'));
function resolveDshModule(id) {
  return requireFromDsh.resolve(id);
}

let ctx = null;
let controller = null;
let agents = null;
let sessions = null;
let sessionQuery = null;
let llm = null;
let shuttingDown = false;
let pending = null;
const queued = [];
let working = false;

async function boot() {
  const appBootPath = resolveDshModule('@deepseek-ai/dsh-app-boot');
  const profileBootPath = path.join(options.dshRoot, 'lib', 'profile-boot.js');
  if (!fs.existsSync(profileBootPath)) {
    throw new Error(`DSH 安装里缺少 profile-boot.js：${profileBootPath}`);
  }
  const boot = await import(pathToFileURL(appBootPath).href);
  const { runProfile } = await import(pathToFileURL(profileBootPath).href);

  const installAnchor = path.join(options.dshRoot, 'package.json');
  const profile = boot.loadProfileDirectory('dsh', options.profileDir, installAnchor);
  const app = runProfile({
    environment: boot.loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    // --no-open 防止再弹一个浏览器；--port 0 随机端口，只监听回环。
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  });

  const bootTimer = setTimeout(() => {
    logStderr('启动超时（120 秒），退出');
    process.exit(3);
  }, 120_000);
  bootTimer.unref?.();

  const runtime = await app;
  ctx = runtime.ctx;
  await ctx.get('loader')?.await();
  clearTimeout(bootTimer);

  controller = ctx.get('sessionController');
  agents = ctx.get('agents');
  sessions = ctx.get('sessions');
  sessionQuery = ctx.get('sessionQuery');
  llm = ctx.get('llm');
  if (!controller || !agents || !sessions) {
    throw new Error('DSH desktop profile 启动后缺少 sessionController / agents / sessions 服务');
  }
  send({ v: 1, type: 'ready', pid: process.pid, bootMs: Date.now() - startedAt });
  logStderr(`就绪，用时 ${Date.now() - startedAt}ms，插件 stdout 已吞掉 ${swallowed} 次`);
}

function failFatal(error) {
  const message = sanitize(error instanceof Error ? error.message : String(error));
  send({ v: 1, type: 'fatal', message });
  logStderr(`致命错误：${message}`);
  setTimeout(() => process.exit(1), 250);
}

/** 取历史会话记录的 cwd；取不到就返回 undefined（调用方用默认 cwd） */
async function lookupSessionCwd(sessionId) {
  if (!sessionQuery?.observeSession) return undefined;
  try {
    const observation = await sessionQuery.observeSession(sessionId);
    return observation?.header?.cwd;
  } catch {
    return undefined;
  }
}

function isMissingSession(error) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? error);
  return code === 'SESSION_QUERY_SESSION_NOT_FOUND' || /does not exist|not found/i.test(message);
}

/** 把父进程给的模型选择装到本次请求上（不改桌面端的默认模型） */
async function applyModel(agent, model, signal) {
  if (model === undefined || model === null) return null;
  if (typeof model !== 'object') throw new Error('模型选择必须是对象');
  const provider = String(model.provider ?? '').trim();
  const modelId = String(model.model ?? '').trim();
  if (!provider || !modelId) throw new Error('模型选择需要 provider 和 model');
  const modelSelections = controller?.agents?.selectForNextRequest ? controller.agents : agents;
  if (!llm?.resolveCallConfig || !modelSelections?.selectForNextRequest) {
    throw new Error('当前 profile 没有可用的模型选择服务');
  }
  const resolved = await llm.resolveCallConfig({
    provider,
    model: modelId,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  }, signal);
  if (signal?.aborted) throw cancelledError();
  const selected = {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
  await modelSelections.selectForNextRequest(agent, selected);
  return selected;
}

function cancelledError() {
  return Object.assign(new Error('本轮已取消'), { name: 'AbortError', code: 'aborted' });
}

function createPendingRequest(request) {
  const active = {
    id: request.id,
    sessionId: null,
    abort: new AbortController(),
    cancelled: false,
    promptSubmitted: false,
  };
  active.aborted = new Promise((_, reject) => {
    active.onAbort = () => reject(cancelledError());
    active.abort.signal.addEventListener('abort', active.onAbort, { once: true });
  });
  void active.aborted.catch(() => {});
  return active;
}

async function waitForRequest(active, operation) {
  if (active.abort.signal.aborted) throw cancelledError();
  return Promise.race([
    Promise.resolve().then(() => {
      if (active.abort.signal.aborted) throw cancelledError();
      return operation();
    }),
    active.aborted,
  ]);
}

function cancelPendingRequest(active) {
  if (!active || active.cancelled) return;
  active.cancelled = true;
  active.abort.abort();
  if (!active.promptSubmitted) return;
  try {
    Promise.resolve(controller.cancel({ sessionId: active.sessionId })).catch((error) => {
      logStderr(`取消失败：${sanitize(error?.message ?? error)}`);
    });
  } catch (error) {
    logStderr(`取消失败：${sanitize(error?.message ?? error)}`);
  }
}

/** 恢复会话保留自身权限，不能仅依赖进程启动时的 DSH_PERMISSION_MODE。 */
function permissionPlan() {
  const mode = options.permission || 'workspace-write';
  const approval = mode === 'danger-full-access' ? 'never' : 'ask';
  const fail = (message) => Object.assign(new Error(message), {
    code: 'permission-unsupported',
    sessionAccepted: false,
  });
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) {
    throw fail(`无效的权限模式：${mode}`);
  }
  let service;
  try {
    service = ctx.get('permissionPresets');
  } catch {
    throw fail('宿主没有可用的逐会话权限服务');
  }
  if (!service || !['set', 'current', 'resolve'].every((key) => typeof service[key] === 'function')) {
    throw fail('宿主没有可用的逐会话权限服务');
  }
  for (const name of new Set([mode, ...(Array.isArray(service.names) ? service.names : [])])) {
    try {
      const spec = service.resolve(name);
      if (spec?.sandbox === mode && spec?.approval === approval) return { service, name, mode, approval, fail };
    } catch {
      /* 名称由宿主配置，按实际沙箱与审批匹配。 */
    }
  }
  throw fail(`宿主不能保证请求的权限：${mode}`);
}

async function applyPermission(plan, session) {
  try {
    await plan.service.set(session, plan.name);
    const effective = plan.service.resolve(plan.service.current(session));
    if (effective?.sandbox !== plan.mode || effective?.approval !== plan.approval) {
      throw new Error('应用后权限与请求不匹配');
    }
  } catch (error) {
    throw plan.fail(`不能应用请求的会话权限：${String(error?.message ?? error)}`);
  }
}

function readTurnResult(session, firstSeq) {
  let text = '';
  let end = null;
  const eventTypes = [];
  const modelsUsed = [];
  let model = null;
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
  const record = (value, header = false) => {
    if (typeof value?.provider !== 'string' || typeof value?.model !== 'string') return;
    const effort = !header && value.reasoningEffort === undefined &&
      activeHeader?.provider === value.provider && activeHeader?.model === value.model
      ? activeHeader.reasoningEffort : value.reasoningEffort;
    model = { provider: value.provider, model: value.model,
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) };
    const key = JSON.stringify(model);
    if (!seen.has(key)) { seen.add(key); modelsUsed.push(model); }
  };
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    eventTypes.push(event.type);
    if (event.type === 'assistant/message' && event.data?.message?.content) {
      record(event.data.message.source);
      const joined = event.data.message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (joined.trim()) text = joined;
    } else if (event.type === 'request/header') {
      activeHeader = event.data?.header?.config ?? null;
      record(activeHeader, true);
    } else if (event.type === 'turn/end') {
      end = event.data ?? null;
    }
  }
  return { text, end, eventTypes, model, modelsUsed };
}

async function handlePrompt(request, active) {
  const cwd = String(request.cwd || options.cwd || process.cwd());
  const requestedSessionId = request.sessionId ? String(request.sessionId) : null;
  const permission = permissionPlan();
  let created = null;
  let adopted = false;
  let restoredAgent;

  if (requestedSessionId && typeof controller.resolveAgent === 'function') {
    const restored = await waitForRequest(active, () => controller.resolveAgent(requestedSessionId));
    if (restored?.error) throw restored.error;
    restoredAgent = restored?.agent ?? restored;
    created = { sessionId: requestedSessionId };
    adopted = true;
  } else if (requestedSessionId) {
    const knownCwd = await waitForRequest(active, () => lookupSessionCwd(requestedSessionId));
    try {
      created = await waitForRequest(active, () => controller.create({
        cwd: knownCwd || cwd,
        sessionId: requestedSessionId,
      }));
      adopted = true;
    } catch (error) {
      if (!isMissingSession(error)) throw error;
      created = await waitForRequest(active, () => controller.create({ cwd }));
    }
  } else {
    created = await waitForRequest(active, () => controller.create({ cwd }));
  }

  const sessionId = created.sessionId;
  active.sessionId = sessionId;
  const agent = restoredAgent ?? agents.get(sessionId);
  if (!agent) throw new Error(`会话 ${sessionId} 创建后没有活的 agent`);

  if (agent.status === 'running') await waitForRequest(active, () => agent.whenIdle());
  try {
    const select = () => applyModel(agent, request.model, active.abort.signal);
    const modelSelections = controller?.agents?.selectForNextRequest ? controller.agents : agents;
    await waitForRequest(active, () => typeof modelSelections?.serializeImageAdmission === 'function'
      ? modelSelections.serializeImageAdmission(agent, select) : select());
  } catch (error) {
    if (active.abort.signal.aborted) throw error;
    throw Object.assign(new Error(`指定的模型不可用：${error instanceof Error ? error.message : String(error)}`), {
      code: 'desktop/model-unavailable', sessionAccepted: true,
    });
  }
  await waitForRequest(active, () => applyPermission(permission, agent.session));
  if (active.abort.signal.aborted) throw cancelledError();
  send({ v: 1, type: 'session', id: request.id, sessionId, adopted });

  const firstSeq = agent.session.seq;
  let idleError = null;

  try {
    await waitForRequest(active, () => {
      active.promptSubmitted = true;
      return controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: String(request.text ?? '') }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        active.abort.signal,
      );
    });
    try {
      await waitForRequest(active, () => agent.whenIdle());
    } catch (error) {
      if (active.abort.signal.aborted) throw error;
      // 回合失败时 whenIdle 也可能抛；真正的错误原因在 turn/end 事件里，
      // 先记下来，等下面读完事件再决定怎么回。
      idleError = error;
    }
  } finally {
    try {
      await sessions.flush(agent.session);
    } catch (error) {
      logStderr(`flush 失败（不影响回复）：${sanitize(error?.message ?? error)}`);
    }
  }

  const { text, end, model, modelsUsed } = readTurnResult(agent.session, firstSeq);
  if (text) {
    send({
      v: 1,
      type: 'final',
      id: request.id,
      sessionId,
      text,
      model,
      modelsUsed,
      reason: end?.reason?.kind ?? null,
    });
    return;
  }

  const reason = end?.reason;
  if (idleError && !reason) {
    send({
      v: 1,
      type: 'error',
      id: request.id,
      sessionId,
      code: 'turn-error',
      message: sanitize(`本轮执行失败：${idleError instanceof Error ? idleError.message : String(idleError)}`),
    });
    return;
  }
  if (reason?.kind === 'aborted') {
    send({ v: 1, type: 'error', id: request.id, sessionId, code: 'aborted', message: '本轮已取消' });
    return;
  }
  if (reason?.kind === 'error') {
    const detail = reason.error?.message ?? reason.error?.code ?? JSON.stringify(reason.error ?? {});
    send({ v: 1, type: 'error', id: request.id, sessionId, code: 'turn-error', message: sanitize(`本轮执行失败：${detail}`) });
    return;
  }
  send({ v: 1, type: 'error', id: request.id, sessionId, code: 'empty', message: '本轮没有产生可发送的回复' });
}

async function handleCancel(request) {
  if (request?.id) {
    const index = queued.findIndex((item) => item.id === request.id);
    if (index >= 0) {
      const [cancelled] = queued.splice(index, 1);
      send({ v: 1, type: 'error', id: cancelled.id, sessionId: null, code: 'aborted', message: '本轮已取消' });
      return;
    }
  }
  if (request?.id && pending?.id !== request.id) return;
  cancelPendingRequest(pending);
}

async function runQueue() {
  if (working) return;
  working = true;
  try {
    while (queued.length > 0) {
      if (shuttingDown) break;
      const request = queued.shift();
      const active = createPendingRequest(request);
      pending = active;
      try {
        await handlePrompt(request, active);
      } catch (error) {
        send({
          v: 1,
          type: 'error',
          id: request.id,
          sessionId: active.sessionId,
          code: error?.code ?? 'internal',
          sessionAccepted: error?.sessionAccepted ?? Boolean(active.sessionId),
          message: sanitize(error instanceof Error ? error.message : String(error)),
        });
        logStderr(`处理失败：${sanitize(error?.stack ?? error)}`);
      } finally {
        active.abort.signal.removeEventListener('abort', active.onAbort);
        if (pending === active) pending = null;
      }
    }
  } finally {
    working = false;
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelPendingRequest(pending);
  try {
    await ctx?.fiber?.dispose?.();
  } catch (error) {
    logStderr(`dispose 失败：${sanitize(error?.message ?? error)}`);
  }
  process.exit(code);
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    logStderr('收到非 JSON 协议行，已忽略');
    return;
  }
  if (!message || message.v !== 1) return;
  if (message.op === 'prompt') {
    queued.push(message);
    void runQueue();
    return;
  }
  if (message.op === 'cancel') {
    void handleCancel(message);
    return;
  }
  if (message.op === 'shutdown') {
    void shutdown(0);
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
process.on('uncaughtException', (error) => {
  failFatal(error);
});
process.on('unhandledRejection', (error) => {
  failFatal(error);
});

try {
  await boot();
} catch (error) {
  failFatal(error);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', onLine);
rl.on('close', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
