// src/dsh-companion.js —— 连接 DSH Desktop 宿主内的桥接连伴插件
//
// 背景：desktop 模式的旧实现是独立子进程（dsh-desktop-host.mjs），会话虽然
// 落在同一个 ~/.dsh/sessions，但桌面端的会话列表只在连接时刷新，独立进程
// 创建会话不会通知桌面端，用户看不到。
//
// companion 插件跑在桌面端自己的 Host 里，由它创建会话；宿主会推送
// api-session/added，桌面端立即出现。本文件只负责读 discovery 文件、发
// HTTP 请求，以及在失败时区分「请求没发出去」和「会话已经建立」。
//
// 协议（见 src/companion/lib/index.js）：
//   GET  /health   -> {ok,pid,...}
//   POST /prompt   -> {ok,sessionId,text,reason,elapsedMs}
//   POST /cancel   -> {ok,cancelled}
//   POST /attach   -> {ok,sessionId,workspaceId}

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { resolveDshHome } from './dsh-desktop.js';

const DEFAULT_DISCOVERY_NAME = 'qq-bridge-companion.json';
const DEFAULT_TIMEOUT_MS = 300_000;
const HEALTH_TIMEOUT_MS = 1_500;
const PERMISSION_ERROR_CODE = 'companion/permission-unsupported';

function requestedPermissionMode(cfg) {
  return String(cfg?.dsh?.permissionMode ?? 'workspace-write').trim();
}

/** companion discovery 文件路径；配置可写绝对路径。 */
export function resolveCompanionDiscoveryPath(cfg) {
  const configured = String(cfg?.dsh?.companionDiscovery ?? '').trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  return path.join(resolveDshHome(), DEFAULT_DISCOVERY_NAME);
}

/** 读取并校验 discovery；文件不存在/损坏返回 null。 */
export function readCompanionDiscovery(cfg) {
  const file = resolveCompanionDiscoveryPath(cfg);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== 1) return null;
  if (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65_535) return null;
  if (typeof parsed.token !== 'string' || parsed.token.length < 16) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  return { ...parsed, discoveryPath: file };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 发一个 JSON 请求；返回 {status, body} 或抛错（连接阶段错误带 channelError）。 */
function requestJson(info, method, pathname, body, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { authorization: `Bearer ${info.token}` };
    if (payload !== null) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    let response = null;
    let connected = false;
    let timer;
    let onAbort;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const fail = (error, channelError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (channelError && error && typeof error === 'object') error.channelError = true;
      reject(error);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: pathname,
        method,
        headers,
        agent: false,
      },
      (res) => {
        response = res;
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text });
        });
        res.on('aborted', () => fail(new Error('companion 响应传输中断')));
        res.on('error', (error) => fail(error));
        res.on('close', () => {
          if (!res.complete) fail(new Error('companion 响应未接收完整'));
        });
      },
    );
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once('connect', () => { connected = true; });
    });
    req.on('error', (error) => {
      // 没收到响应并不代表宿主没执行。仅确定 TCP 尚未连接的错误允许重跑。
      const connectFailed =
        !connected &&
        response === null &&
        ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN']
          .includes(error?.code) &&
        ['connect', 'getaddrinfo'].includes(error?.syscall);
      fail(error, connectFailed);
    });
    timer = setTimeout(() => {
      req.destroy(new Error(`companion 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    onAbort = () => {
      req.destroy(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('close', () => {
      if (response === null) fail(new Error('companion 在返回响应前关闭连接'));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 探测 companion 是否可用。
 * @returns {Promise<{available: boolean, info?: object, reason?: string}>}
 */
export async function probeCompanion(cfg, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const info = readCompanionDiscovery(cfg);
  if (!info) return { available: false, reason: '没有 companion discovery（插件未安装或 DSH 未重启）' };
  if (!isPidAlive(info.pid)) {
    return { available: false, reason: `companion 进程 ${info.pid} 已不在运行`, info };
  }
  try {
    const result = await requestJson(info, 'GET', '/health', undefined, { timeoutMs });
    if (result.status !== 200 || result.body?.ok !== true) {
      return { available: false, reason: `health 返回 ${result.status}`, info };
    }
    const permissionMode = requestedPermissionMode(cfg);
    if (result.body.permissionProtocol !== 1 ||
        !Array.isArray(result.body.permissionModes) ||
        !result.body.permissionModes.includes(permissionMode)) {
      return { available: false, reason: `companion 不能保证请求的权限：${permissionMode}`, info };
    }
    return { available: true, info, health: result.body };
  } catch (error) {
    return {
      available: false,
      reason: `连不上 companion：${error instanceof Error ? error.message : String(error)}`,
      info,
    };
  }
}

/** 取消请求：用完即弃，不阻塞主流程。 */
function cancelCompanion(info, sessionId) {
  if (!sessionId) return;
  requestJson(info, 'POST', '/cancel', { sessionId }, { timeoutMs: 2_000 }).catch(() => {});
}

/**
 * 通过 companion 跑一轮对话。
 *
 * @param {string} text
 * @param {object} options runDsh/runDesktopDsh 同款选项
 * @returns {Promise<{sessionId: string, finalText: string, events: object[]}>}
 */
export async function runCompanionDsh(text, options = {}) {
  const { cfg, log, sessionId: requestedSessionId, signal, timeoutMs, model } = options;
  const info = readCompanionDiscovery(cfg);
  if (!info) {
    const error = new Error('companion 未安装或 discovery 文件缺失');
    error.code = 'companion/missing';
    error.companion = true;
    error.channelError = true;
    error.sessionAccepted = false;
    throw error;
  }
  if (!isPidAlive(info.pid)) {
    const error = new Error(`companion 进程 ${info.pid} 已退出`);
    error.code = 'companion/stale';
    error.companion = true;
    error.channelError = true;
    error.sessionAccepted = false;
    throw error;
  }

  const workspacePath = options.workspacePath ?? options.cwd;
  const requestedTimeoutMs = timeoutMs ?? cfg?.dsh?.timeoutMs;
  const request = {
    text,
    ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(model ? { model } : {}),
    permissionMode: requestedPermissionMode(cfg),
    timeoutMs: Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : DEFAULT_TIMEOUT_MS,
  };
  const started = Date.now();
  log?.info?.(`DSH(companion)：会话 ${requestedSessionId ?? '新会话'} 已提交，等待宿主回复`);
  let result;
  try {
    result = await requestJson(info, 'POST', '/prompt', request, {
      timeoutMs: request.timeoutMs + 5_000,
      signal,
    });
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.companion = true;
    if (wrapped.channelError === true && wrapped.name !== 'AbortError') {
      // 连接没建立，宿主没收到请求，可以安全回退 host/headless。
      wrapped.sessionAccepted = false;
    } else {
      wrapped.sessionAccepted = true;
      if (requestedSessionId) wrapped.sessionId = requestedSessionId;
      cancelCompanion(info, requestedSessionId);
    }
    throw wrapped;
  }

  const body = result.body;
  if (result.status !== 200 || body?.ok !== true) {
    const detail = body?.error ?? result.text?.slice(0, 300) ?? `HTTP ${result.status}`;
    const error = new Error(`companion 对话失败：${detail}`);
    error.companion = true;
    error.sessionId = body?.sessionId ?? requestedSessionId ?? null;
    const permissionRejected = body?.code === PERMISSION_ERROR_CODE && body?.sessionAccepted === false;
    error.sessionAccepted = !permissionRejected;
    if (permissionRejected) {
      error.code = PERMISSION_ERROR_CODE;
      error.channelError = true;
    }
    throw error;
  }
  const elapsedMs = Number.isFinite(body.elapsedMs) ? body.elapsedMs : Date.now() - started;
  log?.info?.(`DSH(companion)：会话 ${body.sessionId} 完成，用时 ${elapsedMs}ms`);
  return {
    sessionId: body.sessionId,
    finalText: String(body.text ?? ''),
    events: [
      { type: 'session', sessionId: body.sessionId },
      { type: 'final', sessionId: body.sessionId, text: String(body.text ?? '') },
    ],
    elapsedMs,
    workspaceId: body.workspaceId ?? null,
  };
}
