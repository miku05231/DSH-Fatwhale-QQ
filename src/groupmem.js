// src/groupmem.js —— 群聊记忆仓库（零依赖 / 同步 / 绝不把异常抛给调用方）
//
// 文件：<dir>/<groupId>.jsonl，一行一条 JSON：
//   {"ts":1792427196000,"userId":1819709466,"nickname":"ski","text":"今天谁值班","messageId":1250079138}
//
// 关键点：
//   - 每个群最多保留 limit 条，超出后裁剪内存数组并重写整个文件；
//   - 重写一律「写 <file>.<pid>.<seq>.tmp → rename 覆盖」，Windows 上撞锁就
//     sleepSync 重试；实在不行删掉临时文件、把该群标记 dirty，下次 append 补偿；
//   - 每个群的缓存懒加载，损坏行跳过（多少次都只 warn 一次），一行坏 JSON 不会拖垮整群；
//   - 所有公开方法都吞异常：磁盘满 / 无权限 / 文件被占 / JSON 损坏，
//     只通过可选 logger warn，然后返回安全值（[] / '' / 零值）。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LIMIT = 500;
const DEFAULT_N = 30;
/** 文件名主干（不含 .jsonl）的最大长度，超了截断并接短哈希 */
const MAX_NAME = 100;
/** 临时文件名里用的重试错误码（Windows 上 rename 撞锁就这几种） */
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
/** rename 失败后的最多重试次数（首次之外） */
const RETRY_TIMES = 4;

/** 同步睡一会儿（仅用于 Windows 上 rename 撞锁时的重试） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持时忽略 */
  }
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 32 位 FNV-1a，给超长群号生成稳定的短哈希 */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 群号 → 文件名主干（不含扩展名）。
 * 用 encodeURIComponent 顺带干掉 `/`、`\`、`:` 等路径敏感字符；
 * 极端输入（孤立代理项）会让它抛 URIError，退回哈希；过长则截断 + 短哈希。
 */
function safeName(groupId) {
  const raw = typeof groupId === 'string' ? groupId : String(groupId);
  let name;
  try {
    name = encodeURIComponent(raw);
  } catch {
    // 孤立代理项（"\uD800" 之类）会让 encodeURIComponent 抛 URIError
    name = `x${shortHash(raw)}`;
  }
  if (name === '') name = `x${shortHash(raw)}`;
  if (name.length > MAX_NAME) {
    // 91 + '-' + 8 = 100，加上 .jsonl 也不会撞 ENAMETOOLONG
    name = `${name.slice(0, MAX_NAME - 9)}-${shortHash(raw)}`;
  }
  return name;
}

/** 数字/数字字符串 → 有限数字；其它（含空串、NaN、Infinity、对象）→ null */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 时间戳 → 本地 HH:MM；非法时间戳给 --:-- */
function formatTime(ts) {
  const n = toNumber(ts);
  if (n === null) return '--:--';
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 消息正文压成单行：控制字符换成空格，连续空白折叠成一个，首尾去掉 */
function flattenText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 发言人：昵称(QQ号)；没昵称用「未知」，没 QQ 号只写昵称 */
function speaker(record) {
  const nick = flattenText(record.nickname);
  const label = nick === '' ? '未知' : nick;
  const uid = record.userId;
  const hasUid = uid !== undefined && uid !== null && String(uid).trim() !== '';
  return hasUid ? `${label}(${uid})` : label;
}

/** 正整数（<=0 / 非数字 / 非有限都退回 fallback） */
function positiveInt(v, fallback) {
  const n = toNumber(v);
  if (n === null) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}

export class GroupMemory {
  /**
   * @param {{dir?: string, limit?: number, log?: {debug?: Function, warn?: Function}}} [opts]
   */
  constructor({ dir, limit = DEFAULT_LIMIT, log } = {}) {
    /** 可选日志器；只有真的有 debug/warn 才调用，绝不 fallback 到 console */
    this.log = log || null;
    /** 每个群最多保留的条数 */
    this.limit = positiveInt(limit, DEFAULT_LIMIT);
    /** 记忆目录（绝对路径） */
    this.dir = '';
    /** 初始化失败后所有方法只返回安全值，绝不抛 */
    this.disabled = false;
    /** 群缓存：文件名主干 → { key, file, records, loaded, dirty } */
    this.groups = new Map();
    /** 临时文件序号（同一进程内避免同名撞车） */
    this.tmpSeq = 0;

    try {
      if (!dir || typeof dir !== 'string') {
        this.disabled = true;
        this.#warn('群聊记忆初始化失败：dir 不能为空，记忆功能已停用');
        return;
      }
      this.dir = path.resolve(dir);
      fs.mkdirSync(this.dir, { recursive: true });
      this.#debug(`群聊记忆目录就绪：${this.dir}（每群上限 ${this.limit} 条）`);
    } catch (err) {
      this.disabled = true;
      this.#warn(`群聊记忆初始化失败（${dir}）：${err?.message || err}，记忆功能已停用`);
    }
  }

  /* -------------------- 私有 -------------------- */

  #warn(msg) {
    try {
      if (this.log?.warn) this.log.warn(msg);
    } catch {
      /* 日志器自己出问题也不能影响主流程 */
    }
  }

  #debug(msg) {
    try {
      if (this.log?.debug) this.log.debug(msg);
    } catch {
      /* 同上 */
    }
  }

  /** 群号 → 文件名主干；不可用返回 '' */
  #keyOf(groupId) {
    if (typeof groupId !== 'string' && typeof groupId !== 'number') return '';
    if (typeof groupId === 'string' && groupId.trim() === '') return '';
    try {
      return safeName(groupId);
    } catch {
      return '';
    }
  }

  /** 校验并整理一条待写入的记录；不合法（空文本 / 结构不对）返回 null */
  #normalizeInput(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    // 只认字符串正文：'' / '   ' / '\n\t' / 数字 / 数组 一律不写
    if (typeof record.text !== 'string' || record.text.trim() === '') return null;

    const out = { ts: Date.now() };
    const ts = toNumber(record.ts);
    if (ts !== null) out.ts = Math.round(ts); // 显式给了就保留（取整）

    const uid = record.userId;
    if (typeof uid === 'number' && Number.isFinite(uid)) out.userId = uid;
    else if (typeof uid === 'string' && uid.trim() !== '') out.userId = uid.trim();

    if (typeof record.nickname === 'string' && record.nickname.trim() !== '') {
      out.nickname = record.nickname.trim(); // 空昵称不写这个键
    }

    out.text = record.text;

    if (record.messageId !== undefined && record.messageId !== null) {
      const mid = record.messageId;
      if (typeof mid === 'number' && Number.isFinite(mid)) out.messageId = mid;
      else if (typeof mid === 'string' && mid.trim() !== '') out.messageId = mid.trim();
    }
    if (record.images !== undefined && record.images !== null) {
      const imgs = toNumber(record.images);
      if (imgs !== null) out.images = imgs;
    }
    return out;
  }

  /** 校验一条磁盘记录；不合法返回 null（损坏行跳过用） */
  #fromLine(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof obj.text !== 'string' || obj.text.trim() === '') return null;

    const out = {};
    const ts = toNumber(obj.ts);
    if (ts !== null) out.ts = Math.round(ts); // 解析不出来的 ts 直接丢，digest 显示 --:--

    if (typeof obj.userId === 'number' && Number.isFinite(obj.userId)) out.userId = obj.userId;
    else if (typeof obj.userId === 'string' && obj.userId.trim() !== '') out.userId = obj.userId.trim();

    if (typeof obj.nickname === 'string' && obj.nickname.trim() !== '') out.nickname = obj.nickname.trim();

    out.text = obj.text;

    if (typeof obj.messageId === 'number' && Number.isFinite(obj.messageId)) out.messageId = obj.messageId;
    else if (typeof obj.messageId === 'string' && obj.messageId.trim() !== '') {
      out.messageId = obj.messageId.trim();
    }

    const imgs = toNumber(obj.images);
    if (imgs !== null) out.images = imgs;
    return out;
  }

  /** 懒加载某个群的缓存；损坏行跳过，只 warn 一次 */
  #load(g, label) {
    g.loaded = true;

    let raw;
    try {
      raw = fs.readFileSync(g.file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.#warn(`读取群记忆失败（${g.file}）：${err?.message || err}`);
      }
      return; // 首次运行 / 读不到：当作空群
    }
    if (raw === '') return;

    const records = [];
    let bad = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim(); // 顺带吃掉 CRLF 的 \r
      if (s === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch {
        bad += 1;
        continue;
      }
      const rec = this.#fromLine(parsed);
      if (rec) records.push(rec);
      else bad += 1;
    }

    if (bad > 0) {
      this.#warn(`群 ${label} 的记忆文件有 ${bad} 行无法识别，已跳过：${g.file}`);
    }

    if (records.length > this.limit) {
      g.records = records.slice(-this.limit);
      g.dirty = true; // 文件比上限长，等下次 append 时收紧
      this.#debug(`群 ${label} 记忆超限（${records.length} > ${this.limit}），已标记待重写`);
    } else {
      g.records = records;
    }
  }

  /** 取（必要时创建并加载）某个群的缓存；群号不可用返回 null */
  #group(groupId) {
    const key = this.#keyOf(groupId);
    if (key === '') return null;

    let g = this.groups.get(key);
    if (!g) {
      g = {
        key,
        file: path.join(this.dir, `${key}.jsonl`),
        records: [],
        loaded: false,
        dirty: false,
      };
      this.groups.set(key, g);
    }
    if (!g.loaded) {
      try {
        this.#load(g, String(groupId));
      } catch (err) {
        this.#warn(`加载群 ${groupId} 的记忆失败：${err?.message || err}`);
        g.loaded = true;
      }
    }
    return g;
  }

  /** 快路径：追加一行；失败返回 false（由调用方标记 dirty） */
  #appendLine(file, line) {
    try {
      fs.appendFileSync(file, line, { encoding: 'utf8' });
      return true;
    } catch (err) {
      this.#warn(`追加群记忆失败（${file}）：${err?.message || err}`);
      return false;
    }
  }

  #cleanupTmp(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉就算了，别影响主流程 */
    }
  }

  /** 原子重写整个文件：.tmp → rename；失败返回 false（调用方保持 dirty） */
  #rewrite(g) {
    const body = g.records.length > 0 ? `${g.records.map((r) => JSON.stringify(r)).join('\n')}\n` : '';

    this.tmpSeq += 1;
    const tmp = `${g.file}.${process.pid}.${this.tmpSeq}.tmp`;

    try {
      fs.writeFileSync(tmp, body, { encoding: 'utf8' });
    } catch (err) {
      this.#cleanupTmp(tmp); // 绝不留下写了一半的文件
      this.#warn(`写群记忆临时文件失败（${tmp}）：${err?.message || err}`);
      return false;
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt += 1) {
      try {
        fs.renameSync(tmp, g.file); // Windows 上 rename 会覆盖已存在的文件
        return true;
      } catch (err) {
        lastErr = err;
        if (!RETRY_CODES.has(err?.code)) break;
        if (attempt < RETRY_TIMES) sleepSync(30 + attempt * 70); // 杀毒/编辑器短暂占用时重试
      }
    }

    this.#cleanupTmp(tmp);
    this.#warn(`重写群记忆失败（${g.file}）：${lastErr?.message || '未知错误'}`);
    return false;
  }

  /* -------------------- 公开 API -------------------- */

  /**
   * 记一条群消息。空正文 / 结构不对直接丢弃；任何异常都吞掉。
   * @param {string|number} groupId 群号
   * @param {{ts?: number, userId?: number|string, nickname?: string, text: string,
   *          messageId?: number|string, images?: number}} record
   * @returns {void}
   */
  append(groupId, record) {
    if (this.disabled) return;
    try {
      const clean = this.#normalizeInput(record);
      if (!clean) return; // 空文本等无效消息：不写文件、不建缓存

      const g = this.#group(groupId);
      if (!g) return;

      g.records.push(clean);

      let needRewrite = g.dirty;
      if (g.records.length > this.limit) {
        g.records.splice(0, g.records.length - this.limit); // 先裁剪内存
        needRewrite = true;
      }

      if (!needRewrite) {
        if (this.#appendLine(g.file, `${JSON.stringify(clean)}\n`)) return;
        g.dirty = true; // 追写失败：下次 append 时补偿性重写
        return;
      }

      if (this.#rewrite(g)) {
        g.dirty = false;
        this.#debug(`群 ${groupId} 记忆已重写：${g.records.length} 条`);
      } else {
        g.dirty = true;
      }
    } catch (err) {
      this.#warn(`写入群记忆失败（群 ${String(groupId)}）：${err?.message || err}`);
    }
  }

  /**
   * 最近 n 条（旧 → 新），返回副本，调用方随便改。
   * @param {string|number} groupId
   * @param {number} [n]
   * @returns {Array<object>}
   */
  recent(groupId, n = DEFAULT_N) {
    if (this.disabled) return [];
    try {
      const g = this.#group(groupId);
      if (!g) return [];

      const want = positiveInt(n, DEFAULT_N); // 非法 / <=0 按默认 30
      const cap = Math.min(want, this.limit); // 且不超过每群上限
      const start = Math.max(0, g.records.length - cap);
      return g.records.slice(start).map((r) => ({ ...r }));
    } catch (err) {
      this.#warn(`读取群记忆失败（群 ${String(groupId)}）：${err?.message || err}`);
      return [];
    }
  }

  /**
   * 整理成一段给 AI 看的纯文本；没消息返回 ''（不返回只有 header 的空壳）。
   * @param {string|number} groupId
   * @param {number} [n]
   * @returns {string}
   */
  digest(groupId, n = DEFAULT_N) {
    if (this.disabled) return '';
    try {
      const list = this.recent(groupId, n);
      if (list.length === 0) return '';

      const lines = [`[群 ${String(groupId)} 最近 ${list.length} 条]`];
      for (const r of list) {
        lines.push(`${formatTime(r.ts)} ${speaker(r)}: ${flattenText(r.text)}`);
      }
      return lines.join('\n');
    } catch (err) {
      this.#warn(`生成群记忆摘要失败（群 ${String(groupId)}）：${err?.message || err}`);
      return '';
    }
  }

  /**
   * 清空某个群：删文件 + 丢缓存。文件本来就不存在不算错。
   * @param {string|number} groupId
   * @returns {void}
   */
  clear(groupId) {
    if (this.disabled) return;
    try {
      const key = this.#keyOf(groupId);
      if (key === '') return;
      this.groups.delete(key); // 先丢缓存，下次访问重新从磁盘加载

      const file = path.join(this.dir, `${key}.jsonl`);
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_TIMES; attempt += 1) {
        try {
          fs.rmSync(file, { force: true }); // force 下 ENOENT 不抛
          this.#debug(`已清空群 ${groupId} 的记忆：${file}`);
          return;
        } catch (err) {
          lastErr = err;
          if (!RETRY_CODES.has(err?.code)) break;
          if (attempt < RETRY_TIMES) sleepSync(30 + attempt * 70);
        }
      }
      this.#warn(`删除群记忆文件失败（${file}）：${lastErr?.message || '未知错误'}`);
    } catch (err) {
      this.#warn(`清空群记忆失败（群 ${String(groupId)}）：${err?.message || err}`);
    }
  }

  /**
   * 目录概览：文件数 / 有效记录行数 / 绝对路径（损坏行不计）。
   * @returns {{groups: number, totalMessages: number, dir: string}}
   */
  stats() {
    const out = { groups: 0, totalMessages: 0, dir: this.dir };
    if (this.disabled) return out;

    try {
      let names;
      try {
        names = fs.readdirSync(this.dir);
      } catch (err) {
        this.#warn(`读取群记忆目录失败（${this.dir}）：${err?.message || err}`);
        return out;
      }

      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const full = path.join(this.dir, name);

        try {
          if (!fs.statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        out.groups += 1;

        let raw;
        try {
          raw = fs.readFileSync(full, 'utf8');
        } catch (err) {
          this.#warn(`统计时读取群记忆失败（${full}）：${err?.message || err}`);
          continue;
        }

        for (const line of raw.split('\n')) {
          const s = line.trim();
          if (s === '') continue;
          let parsed;
          try {
            parsed = JSON.parse(s);
          } catch {
            continue; // 损坏行不计
          }
          if (this.#fromLine(parsed)) out.totalMessages += 1;
        }
      }
    } catch (err) {
      this.#warn(`统计群记忆失败：${err?.message || err}`);
    }
    return out;
  }
}
