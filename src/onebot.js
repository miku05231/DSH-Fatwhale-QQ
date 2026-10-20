// src/onebot.js
// OneBot 11 客户端（客户端模式：主动连接 NapCat 的 WebSocket 服务端）。
// 零第三方依赖，使用 Node ≥22 提供的全局 WebSocket。
//
// 对外契约见 SPEC.md 第 4 节：
//   class OneBot extends EventEmitter
//   constructor({ url, accessToken = '', log, reconnect = true })
//   connect() / close() / get connected / call(action, params, { timeoutMs = 15000 })
//   事件：'ready' | 'message' | 'disconnect' | 'error'
//
// 额外导出 normalizeMessage(raw, log?) 以便单元测试。

import { EventEmitter } from 'node:events';

/** 全局 WebSocket（Node ≥22 内置）。模块加载时取一次，便于在构造函数里给出清晰报错。 */
const WebSocketImpl = globalThis.WebSocket;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;

/** 未注入 log 时的空实现：本模块不实现 logger，只保证缺省时不崩。 */
const NOOP_LOG = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
});

/** 把注入的 log 归一成四个安全可调用的方法（缺哪个补哪个）。 */
function adaptLog(log) {
  if (!log || typeof log !== 'object') return NOOP_LOG;
  const pick = (name) => (typeof log[name] === 'function' ? log[name].bind(log) : NOOP_LOG[name]);
  return { info: pick('info'), warn: pick('warn'), error: pick('error'), debug: pick('debug') };
}

/** QQ 号等 id：统一成 number，取不到时返回 0（OneBot 里 id 恒为数字）。 */
function toId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 日志里截断超长 JSON，避免把整个事件刷进日志。 */
function brief(value, max = 300) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== 'string') return String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把 OneBot 消息段数组拼成纯文本。
 * - type:'text' → data.text 原样拼接
 * - type:'at'   → '@昵称'（拿不到昵称时退回 QQ 号；qq==='all' 转 '@全体成员'）
 * - 其它类型忽略，并在传入 log 时记 debug
 */
function segmentsToText(raw, log) {
  const source = raw?.message;
  let segments;
  if (Array.isArray(source)) {
    segments = source;
  } else if (typeof source === 'string') {
    // NapCat / go-cqhttp 在 messagePostFormat=string 时会直接给 CQ 字符串
    segments = [{ type: 'text', data: { text: source } }];
  } else if (typeof raw?.raw_message === 'string') {
    segments = [{ type: 'text', data: { text: raw.raw_message } }];
  } else {
    segments = [];
  }

  let text = '';
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = seg.type;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};

    if (type === 'text') {
      if (typeof data.text === 'string') text += data.text;
      else if (data.text != null) text += String(data.text);
      continue;
    }

    if (type === 'at') {
      const qq = data.qq == null ? '' : String(data.qq);
      if (!qq) continue;
      if (qq === 'all') {
        text += '@全体成员';
      } else {
        const nickname = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : qq;
        text += `@${nickname}`;
      }
      continue;
    }

    log?.debug?.(`[onebot] 忽略非文本消息片段: ${String(type)}`);
  }

  return text.trim();
}

/**
 * 把原始 OneBot 事件对象转成 SPEC 里的归一化结构。
 * @param {object} raw OneBot 11 的 message 事件（post_type === 'message'）
 * @param {{debug?: Function}} [log] 可选，仅用于忽略片段时的 debug 日志
 * @returns {{messageType:'private'|'group', userId:number, groupId:number|null, text:string, raw:object}|null}
 */
export function normalizeMessage(raw, log) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rawType = raw.message_type;
  const messageType = rawType === 'group' || (!rawType && raw.group_id != null) ? 'group' : 'private';
  const userId = toId(raw.user_id ?? raw.sender?.user_id);
  const groupId = messageType === 'group' ? toId(raw.group_id) : null;
  const text = segmentsToText(raw, log);

  return { messageType, userId, groupId, text, raw };
}

export class OneBot extends EventEmitter {
  #url;
  #accessToken;
  #log;
  #shouldReconnect;

  /** @type {WebSocket|null} */
  #ws = null;
  #connected = false;
  #closing = false;
  #reconnectTimer = null;
  #reconnectAttempts = 0;

  #echoSeq = 0;
  /** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout, action:string}>} */
  #pending = new Map();

  constructor({ url, accessToken = '', log, reconnect = true } = {}) {
    super();

    if (!WebSocketImpl) {
      throw new Error('当前 Node 版本没有内置 WebSocket（需要 Node ≥22），无法连接 OneBot 服务端');
    }
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('OneBot 初始化失败：缺少必填参数 url（例如 ws://127.0.0.1:3001）');
    }

    const normalizedUrl = url.trim();
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      throw new Error(`OneBot 初始化失败：url 不是合法的地址（${normalizedUrl}）`);
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error(`OneBot 初始化失败：url 必须以 ws:// 或 wss:// 开头（当前为 ${parsed.protocol}）`);
    }

    this.#url = normalizedUrl;
    this.#accessToken = typeof accessToken === 'string' ? accessToken.trim() : '';
    this.#log = adaptLog(log);
    this.#shouldReconnect = reconnect !== false;
  }

  /** 当前是否已握手成功且连接可用。 */
  get connected() {
    if (!this.#connected || !this.#ws) return false;
    return this.#ws.readyState === WebSocketImpl.OPEN;
  }

  /**
   * 建立连接；断线后按 1s→2s→4s… 上限 30s 指数退避自动重连。
   * 重复调用是安全的（已连接/连接中时为空操作）。
   */
  connect() {
    this.#closing = false;
    this.#reconnectAttempts = 0;
    this.#clearReconnectTimer();
    this.#open();
    return this;
  }

  /** 主动关闭，之后不再重连；所有未完成的 call 会立刻 reject。 */
  close() {
    this.#closing = true;
    this.#clearReconnectTimer();

    const ws = this.#ws;
    this.#ws = null;
    const wasConnected = this.#connected;
    this.#connected = false;

    this.#rejectAllPending('OneBot 客户端已关闭，未完成的调用被取消');

    if (ws) {
      try {
        if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) {
          ws.close(1000, 'client closing');
        }
      } catch (err) {
        this.#log.debug(`[onebot] 关闭连接时出错（已忽略）: ${err?.message || err}`);
      }
    }

    if (wasConnected) this.#log.info('[onebot] 已主动断开与 OneBot 服务端的连接');
  }

  /**
   * 调用 OneBot API，按自增 echo 关联响应。
   * @returns {Promise<any>} 成功时 resolve 响应里的 data
   */
  call(action, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof action !== 'string' || !action) {
        reject(new Error('OneBot 调用失败：action 必须是非空字符串'));
        return;
      }
      if (!this.connected) {
        reject(new Error(`OneBot 尚未连接，无法调用 ${action}`));
        return;
      }

      const waitMs =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
      const echo = String(++this.#echoSeq);

      const timer = setTimeout(() => {
        if (!this.#pending.delete(echo)) return;
        const err = new Error(`OneBot 调用 ${action} 超时（${waitMs}ms 内无响应）`);
        err.action = action;
        err.timeoutMs = waitMs;
        reject(err);
      }, waitMs);

      this.#pending.set(echo, { resolve, reject, timer, action });

      try {
        this.#ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        this.#pending.delete(echo);
        clearTimeout(timer);
        const wrapped = new Error(`OneBot 调用 ${action} 发送失败: ${err?.message || err}`);
        wrapped.action = action;
        wrapped.cause = err;
        reject(wrapped);
      }
    });
  }

  // ---------------------------------------------------------------- 内部实现

  #open() {
    if (this.#closing) return;
    if (this.#ws) {
      const state = this.#ws.readyState;
      if (state === WebSocketImpl.CONNECTING || state === WebSocketImpl.OPEN) return;
      this.#ws = null;
    }

    let ws;
    try {
      ws = this.#accessToken
        ? new WebSocketImpl(this.#url, {
            headers: { Authorization: `Bearer ${this.#accessToken}` },
          })
        : new WebSocketImpl(this.#url);
    } catch (err) {
      this.#log.error(`[onebot] 创建 WebSocket 连接失败: ${err?.message || err}`);
      this.#reportError(err);
      this.#scheduleReconnect();
      return;
    }

    this.#ws = ws;
    this.#log.debug(`[onebot] 正在连接 ${this.#url}`);
    ws.addEventListener('open', () => this.#onOpen(ws));
    ws.addEventListener('message', (event) => {
      void this.#onMessage(ws, event);
    });
    ws.addEventListener('error', (event) => this.#onSocketError(ws, event));
    ws.addEventListener('close', (event) => this.#onClose(ws, event));
  }

  #onOpen(ws) {
    if (this.#ws !== ws || this.#closing) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this.#connected = true;
    this.#reconnectAttempts = 0;
    this.#log.info(`[onebot] 已连接 OneBot 服务端 ${this.#url}`);
    this.#safeEmit('ready');
  }

  async #onMessage(ws, event) {
    if (this.#ws !== ws) return;
    try {
      let text = event?.data;
      if (typeof text !== 'string') {
        if (text && typeof text.text === 'function') text = await text.text(); // Blob
        else if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8');
        else if (ArrayBuffer.isView(text)) text = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8');
        else {
          this.#log.debug(`[onebot] 收到无法解析的数据类型: ${Object.prototype.toString.call(text)}`);
          return;
        }
      }
      const payload = JSON.parse(text);
      this.#onPayload(payload);
    } catch (err) {
      this.#log.warn(`[onebot] 解析服务端消息失败: ${err?.message || err}`);
    }
  }

  #onPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      this.#log.debug('[onebot] 收到非对象数据，已忽略');
      return;
    }

    // 1) API 响应：带 echo
    if (payload.echo !== undefined && payload.echo !== null) {
      const key = String(payload.echo);
      const pending = this.#pending.get(key);
      if (!pending) {
        this.#log.debug(`[onebot] 收到无对应请求的响应 echo=${brief(key, 64)}（可能已超时）`);
        return;
      }
      this.#pending.delete(key);
      clearTimeout(pending.timer);

      const failed =
        payload.status === 'failed' ||
        (payload.status === undefined && typeof payload.retcode === 'number' && payload.retcode !== 0);

      if (failed) {
        const detail = payload.message || payload.wording || payload.msg || `retcode=${payload.retcode}`;
        const err = new Error(`OneBot 调用 ${pending.action} 失败: ${detail}`);
        err.action = pending.action;
        err.retcode = payload.retcode;
        err.response = payload;
        pending.reject(err);
        return;
      }

      pending.resolve(payload.data);
      return;
    }

    // 2) 消息事件
    if (payload.post_type === 'message' || payload.post_type === 'message_sent') {
      if (payload.post_type === 'message_sent') {
        // 自身发出的消息：忽略，避免桥接把机器人回复当成用户输入形成回环
        this.#log.debug('[onebot] 收到自身发送的消息（message_sent），已忽略');
        return;
      }
      const msg = normalizeMessage(payload, this.#log);
      if (!msg) {
        this.#log.warn(`[onebot] 无法归一化的消息事件: ${brief(payload)}`);
        return;
      }
      this.#safeEmit('message', msg);
      return;
    }

    // 3) 心跳 / 生命周期 / 通知 / 请求：不参与桥接，仅 debug
    if (payload.post_type === 'meta_event') {
      this.#log.debug(
        `[onebot] 元事件 meta_event_type=${brief(payload.meta_event_type, 32)}` +
          (payload.status ? ` status=${brief(payload.status, 80)}` : ''),
      );
      return;
    }
    if (payload.post_type === 'notice' || payload.post_type === 'request') {
      this.#log.debug(`[onebot] 忽略事件 post_type=${payload.post_type}`);
      return;
    }

    this.#log.debug(`[onebot] 收到未知数据: ${brief(payload)}`);
  }

  #onSocketError(ws, event) {
    if (this.#ws !== ws) return;
    const err =
      event?.error instanceof Error
        ? event.error
        : new Error(event?.message || `与 OneBot 服务端的 WebSocket 连接出错（${this.#url}）`);
    this.#log.warn(`[onebot] WebSocket 错误: ${err.message}`);
    this.#reportError(err);
    // 之后必然跟随 close 事件，重连在那里统一处理
  }

  #onClose(ws, event) {
    if (this.#ws !== ws) return; // 已被 close() 接管，或旧连接的回调
    this.#ws = null;

    const wasConnected = this.#connected;
    this.#connected = false;
    const code = event?.code;
    const reason = event?.reason;

    this.#rejectAllPending(`与 OneBot 的连接已断开（code=${code}），未完成的调用被取消`);

    if (this.#closing) return; // 主动关闭：不再重连、不再报事件

    if (wasConnected) {
      this.#log.warn(`[onebot] 与 OneBot 的连接已断开（code=${code}${reason ? `, ${reason}` : ''}）`);
      const err = code === 1000 ? undefined : new Error(`WebSocket 连接已关闭（code=${code}）`);
      this.#safeEmit('disconnect', err);
    } else {
      const hint =
        this.#accessToken && code === 1006
          ? '（若 NapCat 开启了 token 校验，请检查 config.json 里的 accessToken 是否一致）'
          : '';
      this.#log.warn(`[onebot] 连接 OneBot 服务端失败（code=${code}），稍后重试${hint}`);
    }

    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#closing || !this.#shouldReconnect || this.#reconnectTimer) return;

    const attempt = this.#reconnectAttempts;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    this.#reconnectAttempts = attempt + 1;

    this.#log.warn(`[onebot] ${Math.round(delay / 1000)} 秒后尝试第 ${attempt + 1} 次重连…`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #rejectAllPending(reason) {
    if (this.#pending.size === 0) return;
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of entries) {
      clearTimeout(pending.timer);
      const err = new Error(`${reason}（action=${pending.action}）`);
      err.action = pending.action;
      pending.reject(err);
    }
  }

  /** 触发用户回调时兜底：监听器抛错不能把桥接进程带崩。 */
  #safeEmit(eventName, ...args) {
    try {
      this.emit(eventName, ...args);
    } catch (err) {
      this.#log.error(`[onebot] 处理 ${eventName} 事件时抛错: ${err?.stack || err?.message || err}`);
    }
  }

  /** 'error' 事件没有监听者时 EventEmitter 会直接抛出，因此按需分发。 */
  #reportError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      if (this.listenerCount('error') > 0) this.emit('error', error);
      else this.#log.error(`[onebot] ${error.message}`);
    } catch (emitErr) {
      this.#log.error(`[onebot] 触发 error 事件时出错: ${emitErr?.message || emitErr}`);
    }
  }
}

export default OneBot;
