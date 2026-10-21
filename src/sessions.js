// src/sessions.js —— QQ 用户 ⇄ DSH 会话 id 的持久化映射
//
// 文件：<stateDir>/sessions.json
// 形如：{ "g:123:u:456:chat:v1": { "sessionId": "...", "startedAt": 1234567890 } }
// 兼容旧版字符串映射；首次参与窗口判断时补上起始时间。
//
// 关键点：
//   - 每次 set/remove 立即原子落盘（先写 .tmp 再 rename），进程被杀也不会写坏；
//   - 启动时若文件损坏（不是合法 JSON / 不是对象），重建为空表并 warn；
//   - qqId 用 string 做键，数字/字符串都兼容。

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'sessions.json';
export const DEFAULT_SESSION_WINDOW_MINUTES = 180;

export function isValidSessionWindowMinutes(value) {
  return Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 60_000);
}

/** 控制台改完下一轮生效；读取失败时保留上一次有效值。 */
export function readSessionWindowMinutes(configPath, fallback = DEFAULT_SESSION_WINDOW_MINUTES) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    const value = raw?.behavior?.sessionWindowMinutes === undefined
      ? DEFAULT_SESSION_WINDOW_MINUTES : raw.behavior.sessionWindowMinutes;
    if (isValidSessionWindowMinutes(value)) return value;
  } catch {
    /* 配置正在更新或损坏时沿用有效设置。 */
  }
  return fallback;
}

/** 同步睡一会儿（仅用于 Windows 上 rename 撞锁时的重试） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持时忽略 */
  }
}

export class SessionStore {
  /**
   * @param {string} stateDir 状态目录（绝对或相对，相对则按当前工作目录解析）
   * @param {{log?: object}} [opts] 可选日志器
   */
  constructor(stateDir, { log } = {}) {
    if (!stateDir || typeof stateDir !== 'string') {
      throw new Error('SessionStore 初始化失败：stateDir 不能为空');
    }
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, FILE_NAME);
    this.log = log;
    this.map = this.#load();
  }

  /* -------------------- 私有 -------------------- */

  #warn(msg) {
    if (this.log?.warn) this.log.warn(msg);
    else console.warn(msg);
  }

  #load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.#warn(`创建状态目录失败（${this.dir}）：${err.message}`);
    }

    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {}; // 首次运行
      throw new Error(`读取会话文件失败（${this.file}）：${err.message}`);
    }

    if (raw.trim() === '') return {};

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#warn(`会话文件已损坏（不是合法 JSON），已重建：${this.file}`);
      this.#persist({});
      return {};
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#warn(`会话文件格式异常（应为对象），已重建：${this.file}`);
      this.#persist({});
      return {};
    }

    // 旧字符串映射与带起始时间的新记录都可读。
    const clean = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(parsed)) {
      const legacy = typeof v === 'string' && v.trim() !== '';
      const timed = v && typeof v === 'object' && !Array.isArray(v) &&
        typeof v.sessionId === 'string' && v.sessionId.trim() !== '' &&
        Number.isSafeInteger(v.startedAt) && v.startedAt >= 0;
      if (k.trim() !== '' && (legacy || timed)) {
        Object.defineProperty(clean, k, { value: v, enumerable: true, configurable: true, writable: true });
      } else dropped += 1;
    }
    if (dropped > 0) {
      this.#warn(`会话文件里有 ${dropped} 条无效记录，已忽略`);
      this.#persist(clean);
    }
    return clean;
  }

  /** 原子写：先写同目录 .tmp，再 rename 覆盖 */
  #persist(data) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.#warn(`创建状态目录失败（${this.dir}）：${err.message}`);
      return false;
    }

    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(data, null, 2) + '\n';
    let lastErr = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.writeFileSync(tmp, body, { encoding: 'utf8' });
        fs.renameSync(tmp, this.file); // Windows 上 rename 会覆盖已存在文件
        return true;
      } catch (err) {
        lastErr = err;
        // 杀毒/编辑器短暂占用时重试
        if (['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code)) {
          sleepSync(30 + attempt * 70);
          continue;
        }
        break;
      }
    }

    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
    this.#warn(`写入会话文件失败（${this.file}）：${lastErr?.message || '未知错误'}`);
    return false;
  }

  /* -------------------- 公开 API -------------------- */

  /** 固定窗口从首次对话计时；0 不过期，不因续聊延长。 */
  get(qqId, { windowMinutes = 0, now = Date.now() } = {}) {
    if (qqId === undefined || qqId === null) return null;
    if (!isValidSessionWindowMinutes(windowMinutes)) throw new Error('会话窗口必须是非负整数分钟');
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('会话时间必须是非负整数毫秒');
    // 控制台可清除绑定，下一轮必须看到磁盘上的最新状态。
    this.map = this.#load();
    const key = String(qqId);
    if (!Object.hasOwn(this.map, key)) return null;
    let record = this.map[key];
    if (typeof record === 'string') {
      // 旧数据没有创建时间，升级后的首次使用建立一次固定窗口。
      record = { sessionId: record, startedAt: now };
      this.map[key] = record;
      if (!this.#persist(this.map)) throw new Error('会话起始时间保存失败，请检查状态目录');
    }
    if (windowMinutes > 0 &&
        (now < record.startedAt || now - record.startedAt >= windowMinutes * 60_000)) return null;
    return record.sessionId;
  }

  /** 绑定会话 id（立即落盘） */
  set(qqId, sessionId, { startedAt = Date.now() } = {}) {
    if (qqId === undefined || qqId === null) {
      throw new Error('SessionStore.set 失败：qqId 不能为空');
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('SessionStore.set 失败：sessionId 必须是非空字符串');
    }
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error('SessionStore.set 失败：startedAt 必须是非负整数毫秒');
    }
    this.map = this.#load();
    const key = String(qqId);
    const previous = Object.hasOwn(this.map, key) ? this.map[key] : null;
    if (previous?.sessionId !== sessionId) {
      Object.defineProperty(this.map, key, {
        value: { sessionId, startedAt }, enumerable: true, configurable: true, writable: true,
      });
      if (!this.#persist(this.map)) throw new Error('会话绑定保存失败，请检查状态目录');
    }
    return sessionId;
  }

  /** 解除绑定（例如会话失效后重新开一个），返回是否真的删掉了 */
  remove(qqId) {
    if (qqId === undefined || qqId === null) return false;
    this.map = this.#load();
    const key = String(qqId);
    if (!Object.prototype.hasOwnProperty.call(this.map, key)) return false;
    delete this.map[key];
    if (!this.#persist(this.map)) throw new Error('会话清除保存失败，请检查状态目录');
    return true;
  }

  /** 全部映射的浅拷贝 */
  all() {
    this.map = this.#load();
    return Object.fromEntries(Object.entries(this.map).map(([key, value]) =>
      [key, typeof value === 'string' ? value : value.sessionId]));
  }

  /** 当前绑定数量 */
  get size() {
    return Object.keys(this.all()).length;
  }
}
