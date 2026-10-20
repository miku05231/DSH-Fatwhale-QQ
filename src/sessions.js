// src/sessions.js —— QQ 用户 ⇄ DSH 会话 id 的持久化映射
//
// 文件：<stateDir>/sessions.json
// 形如：{ "123456789": "session-xxxx-..." }
//
// 关键点：
//   - 每次 set/remove 立即原子落盘（先写 .tmp 再 rename），进程被杀也不会写坏；
//   - 启动时若文件损坏（不是合法 JSON / 不是对象），重建为空表并 warn；
//   - qqId 用 string 做键，数字/字符串都兼容。

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'sessions.json';

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
      this.#warn(`读取会话文件失败（${this.file}）：${err.message}，将重建`);
      return {};
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

    // 只保留「键非空、值是非空字符串」的条目
    const clean = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim() !== '' && k.trim() !== '') clean[k] = v;
      else dropped += 1;
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

  /** 取该 QQ 用户绑定的会话 id，没有则 null */
  get(qqId) {
    if (qqId === undefined || qqId === null) return null;
    const v = this.map[String(qqId)];
    return typeof v === 'string' && v ? v : null;
  }

  /** 绑定会话 id（立即落盘） */
  set(qqId, sessionId) {
    if (qqId === undefined || qqId === null) {
      throw new Error('SessionStore.set 失败：qqId 不能为空');
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('SessionStore.set 失败：sessionId 必须是非空字符串');
    }
    const key = String(qqId);
    const changed = this.map[key] !== sessionId;
    this.map[key] = sessionId;
    if (changed) this.#persist(this.map);
    return sessionId;
  }

  /** 解除绑定（例如会话失效后重新开一个），返回是否真的删掉了 */
  remove(qqId) {
    if (qqId === undefined || qqId === null) return false;
    const key = String(qqId);
    if (!Object.prototype.hasOwnProperty.call(this.map, key)) return false;
    delete this.map[key];
    this.#persist(this.map);
    return true;
  }

  /** 全部映射的浅拷贝 */
  all() {
    return { ...this.map };
  }

  /** 当前绑定数量 */
  get size() {
    return Object.keys(this.map).length;
  }
}
