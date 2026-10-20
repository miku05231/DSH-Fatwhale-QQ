// src/memory.js —— Obsidian 记忆库（零第三方依赖 / 原子写 / 绝不拖垮 QQ 收发）
//
// 目录结构（SPEC-2 第 2 节）：
//   大肥鱼/
//   ├── 大肥鱼.md              索引页（图谱入口）
//   ├── 10-人物/<QQ号>.md       一人一页
//   ├── 20-群聊/<群号>.md       一群一页
//   ├── 30-日志/YYYY-MM-DD.md   每日流水，追加式
//   ├── 40-知识/<标题>.md       学到的东西
//   ├── 50-反思/YYYY-Www.md     自学习产物
//   └── .attachments/          图片等（本模块不写，只建目录）
//
// 设计要点：
//   - 只用 node: 内置模块，ESM；写盘一律「临时文件 + rename」，Windows 撞锁就重试；
//   - 人物页 / 群聊页是「合并更新」：只补新事实、只改该改的那几行，手写内容一律保留；
//   - 日志是追加式：原子写实现（读旧 + 拼新 + rename），内容只增不改；
//   - 所有写操作串行化（#withLock），避免两个 await 交错把同一个文件写坏；
//   - captureTurn / appendDaily 吞掉全部异常，只 log.debug —— 记忆挂了也不能影响发消息；
//   - 检索不用向量库：CJK 2-gram + 英文数字按词切，tf/长度归一，标题命中 ×3，updated 新的略加权；
//   - 一切对外暴露的路径都是**记忆根内的相对路径**，统一用 `/` 分隔。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/* ================================================================== 常量 */

/** 五个抽屉的目录名（与 SPEC-2 第 2 节严格一致，别改） */
export const DIR_PERSON = '10-人物';
export const DIR_GROUP = '20-群聊';
export const DIR_DAILY = '30-日志';
export const DIR_NOTE = '40-知识';
export const DIR_REFLECT = '50-反思';
/** 目录顺序：ensure / stats / 索引都用这个顺序 */
export const DIRS = [DIR_PERSON, DIR_GROUP, DIR_DAILY, DIR_NOTE, DIR_REFLECT];
/** 附件目录（只建不写） */
const ATTACH_DIR = '.attachments';
/** 索引页文件名（记忆库根目录下那个） */
export const INDEX_FILE = '大肥鱼.md';
/** 各目录的小索引页 */
const INDEX_NAMES = {
  [DIR_PERSON]: '人物索引.md',
  [DIR_GROUP]: '群聊索引.md',
  [DIR_DAILY]: '日志索引.md',
  [DIR_NOTE]: '知识索引.md',
  [DIR_REFLECT]: '反思索引.md',
};
/** stats().byDir 用的中文短名 */
const STAT_LABELS = {
  [DIR_PERSON]: '人物',
  [DIR_GROUP]: '群聊',
  [DIR_DAILY]: '日志',
  [DIR_NOTE]: '知识',
  [DIR_REFLECT]: '反思',
};

/** 默认记忆库根目录 */
export const DEFAULT_ROOT = path.join(
  process.env.USERPROFILE || os.homedir(),
  'Documents',
  'Obsidian Vault',
  '大肥鱼',
);

/** 默认返回条数 / 注入长度上限 / 单日日志软上限 */
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_INJECT_MAX = 1200;
const DEFAULT_DAILY_SOFT_LIMIT = 400;

/** 单个 md 文件超过这个大小就不参与检索（防止误把大文件塞进库里拖慢每次对话） */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
/** 递归扫描的最大深度 */
const MAX_SCAN_DEPTH = 6;
/** 文件名主干最大长度（超了截断 + 短哈希） */
const MAX_FILE_STEM = 80;
/** rename 撞锁时值得重试的错误码（Windows 上杀毒/编辑器会短暂占用） */
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
/** rename 失败后的最多重试次数（首次之外） */
const RETRY_TIMES = 4;
/** 追加时如果旧文件超过这个大小，放弃「读旧拼新」，退回直接 appendFile */
const APPEND_REWRITE_MAX = 2 * 1024 * 1024;

/** CJK（含扩展 A、兼容区、假名、谚文）：按 2-gram 切 */
const CJK_RANGE = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff';
const CJK_RE = new RegExp(`[${CJK_RANGE}]`);
const TOKEN_RE = new RegExp(`[${CJK_RANGE}]+|[A-Za-z0-9_]+`, 'g');
/** YAML frontmatter（文件开头） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/* ================================================================== 小工具 */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日历日期 YYYY-MM-DD（按用户看到的「今天」，不随 UTC 漂移） */
function dateStamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地 HH:MM */
function timeStamp(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 时间戳归一：Date 原样、数字按毫秒（小于 1e12 视为秒，兼容 OneBot）、
 * 字符串交给 Date；解析失败用当前时间。
 */
function toDate(ts) {
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts : new Date();
  if (ts === undefined || ts === null || ts === '') return new Date();
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    if (Number.isFinite(d.getTime())) return d;
    return new Date();
  }
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

/** 数字 / 数字字符串 → 有限数字；其它 → null */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 正整数；非法 / <=0 / 非有限都退回 fallback */
function positiveInt(v, fallback) {
  const n = toNumber(v);
  if (n === null) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}

/** 压成单行：控制字符换空格，连续空白折叠，首尾去掉 */
function oneLine(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截断到 max 个字符（超了用省略号结尾，保证结果长度 <= max） */
function clamp(text, max) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return `${s.slice(0, n - 1)}…`;
}

/** 32 位 FNV-1a，给超长/非法文件名生成稳定短哈希 */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 任意标识（QQ 号 / 群号 / 笔记标题）→ 安全的文件名主干（不含 .md）。
 * 去掉 Windows 非法字符与会破坏 Obsidian 双链的符号；空/纯点返回 ''。
 */
function safeStem(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') return '';
  s = s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g, '-');
  s = s.replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  if (s === '' || s === '.' || s === '..') return '';
  if (s.length > MAX_FILE_STEM) s = `${s.slice(0, MAX_FILE_STEM - 9)}-${shortHash(s)}`;
  return s;
}

/** YAML 标量：需要时加双引号，避免冒号/井号把 frontmatter 弄坏 */
function yamlScalar(v) {
  const s = oneLine(v);
  if (s === '') return "''";
  if (/^[-?:,[\]{}&*!|>'"%@`]/.test(s) || /:\s/.test(s) || /\s#/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** frontmatter 行数组（不含结尾空行） */
function frontmatterLines(pairs) {
  const lines = ['---'];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const items = value.map((x) => yamlScalar(x)).filter((x) => x !== "''");
      lines.push(`${key}: [${items.join(', ')}]`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return lines;
}

/** 解析文件开头的 YAML frontmatter（只认 key: value / [a, b] 这种简单形态） */
function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_\u4e00-\u9fff-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s !== '');
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: src.slice(m[0].length), hasFrontmatter: true };
}

/** 取正文里第一个 `# 标题`；没有再退回 fallback */
function extractTitle(body, fallback = '') {
  const m = /^#[ \t]+(.+)$/m.exec(String(body ?? ''));
  return m ? oneLine(m[1]) : oneLine(fallback);
}

/**
 * 切词：CJK 连串 → 全部 2-gram（单字串就保留单字），英文数字 → 小写整词。
 * 例：「今天天气不错 abc123」→ 今天/天天/天气/气不/不错/abc123
 */
function tokenize(text) {
  const out = [];
  const src = String(text ?? '').toLowerCase();
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    const chunk = m[0];
    if (CJK_RE.test(chunk[0])) {
      if (chunk.length === 1) out.push(chunk);
      else for (let i = 0; i + 1 < chunk.length; i += 1) out.push(chunk.slice(i, i + 2));
    } else if (chunk !== '') {
      out.push(chunk);
    }
  }
  return out;
}

/** 数组 → 计数表 */
function countTokens(tokens) {
  const map = new Map();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

/**
 * 事实去重用的归一化：去掉所有空白与句末标点，全小写。
 * 「测试事实」与「测试事实。」「测试 事实」都算同一条。
 */
function factKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。，、；：！？.,;:!?~～…]+$/g, '');
}

/** facts 参数归一：只留非空字符串，去首尾空白，按 factKey 去重 */
function normalizeFacts(facts) {
  const list = [];
  const seen = new Set();
  const arr = Array.isArray(facts) ? facts : facts === undefined || facts === null ? [] : [facts];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const text = oneLine(item);
    if (text === '') continue;
    const key = factKey(text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
  }
  return list;
}

/** 「昵称(QQ号)」；两部分都缺时给「未知」 */
function speakerName(nickname, id) {
  const nick = oneLine(nickname);
  const hasId = id !== undefined && id !== null && String(id).trim() !== '';
  if (nick === '' && !hasId) return '未知';
  if (nick === '') return String(id).trim();
  return hasId ? `${nick}(${String(id).trim()})` : nick;
}

/** 是不是一个长得像 QQ 号 / 群号的东西（数字或 4 位以上字母数字） */
function isIdLike(raw) {
  const s = String(raw ?? '').trim();
  return s !== '' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/* ================================================================== 正文编辑 */

/** 在正文行数组里合并一条 `- 标签：值`：有就改、没有就插在第一个 ## 之前 */
function upsertBullet(lines, label, value) {
  const re = new RegExp(`^\\s*[-*]\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m) {
      const current = oneLine(m[1]);
      if (current === value) return false;
      lines[i] = `- ${label}：${value}`;
      return true;
    }
  }
  let at = lines.findIndex((line) => /^##\s+/.test(line));
  if (at < 0) at = lines.length;
  while (at > 0 && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, `- ${label}：${value}`);
  return true;
}

/** 读某一行的值（`- 标签：值`），没有返回 '' */
function readBullet(lines, label) {
  const re = new RegExp(`^\\s*[-*]\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*(.*)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return oneLine(m[1]);
  }
  return '';
}

/**
 * 把新事实合并进正文的「## 记忆」小节：已存在的整段里任意 `- ` 条目都参与去重，
 * 所以重复调用只会累加，不会写两遍。
 * @returns {number} 实际新增条数
 */
function mergeFacts(lines, facts) {
  if (facts.length === 0) return 0;
  const seen = new Set();
  for (const line of lines) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) seen.add(factKey(m[1]));
  }
  const fresh = [];
  for (const fact of facts) {
    const key = factKey(fact);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    fresh.push(`- ${fact}`);
  }
  if (fresh.length === 0) return 0;

  const start = lines.findIndex((line) => /^##\s*(记忆|事实|要点|facts)/i.test(line));
  if (start >= 0) {
    let end = lines.findIndex((line, i) => i > start && /^##\s+/.test(line));
    if (end < 0) end = lines.length;
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at -= 1;
    lines.splice(at, 0, ...fresh);
  } else {
    const relatedAt = lines.findIndex((line) => /^##\s*(相关|链接|参考)/.test(line));
    const block = ['## 记忆', '', ...fresh, ''];
    if (relatedAt >= 0) lines.splice(relatedAt, 0, ...block);
    else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', ...block);
    }
  }
  return fresh.length;
}

/** 正文里最后一个 `## xxx` 的标题文本；没有返回 '' */
function lastSectionHeading(text) {
  const matches = String(text ?? '').match(/^##[ \t]+(.+)$/gm);
  if (!matches || matches.length === 0) return '';
  return oneLine(matches[matches.length - 1].replace(/^##[ \t]+/, ''));
}

/** 一行一行的正文 → 行数组（去掉 BOM 与尾部空行） */
function splitBody(body) {
  const lines = String(body ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/** 行数组 → 正文文本（结尾正好一个换行） */
function joinBody(lines) {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

/** 一页的紧凑摘要（给 buildContext 用）：标题 + 字段 + 事实，跳过「相关」段的双链噪音 */
function pageDigest(text, { maxLines = 14 } = {}) {
  const { body } = parseFrontmatter(text);
  const out = [];
  let inRelated = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      inRelated = /相关|链接|参考/.test(heading[1]);
      continue;
    }
    if (inRelated) continue;
    if (/^#\s+/.test(line)) out.push(line.replace(/^#\s+/, '').trim());
    else if (/^[-*]\s+/.test(line)) out.push(line);
    if (out.length >= maxLines) break;
  }
  return out.join('\n');
}

/** 取日志末尾若干个小节（给「今天说过的话」用） */
function tailSections(text, sections = 2) {
  const src = parseFrontmatter(text).body;
  const starts = [];
  const re = /^##[ \t]+.*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) starts.push(m.index);
  if (starts.length === 0) return oneLine(src);
  const from = starts[Math.max(0, starts.length - sections)];
  return src.slice(from).trim();
}

/* ================================================================== 主类 */

export class ObsidianMemory {
  /** 串行化所有写操作：上一个没落地，下一个不开始 */
  #tail = Promise.resolve();

  /** 临时文件序号（同一进程内避免同名撞车） */
  #seq = 0;

  /**
   * @param {{root?: string, log?: object, maxSearchResults?: number,
   *          injectMaxChars?: number, dailySoftLimit?: number}} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    /** 可选日志器；只有真的有 debug / warn 才调用，绝不 fallback 到 console */
    this.log = o.log || null;
    /** 记忆库根目录（绝对路径） */
    this.root = '';
    /** 初始化失败后所有方法只返回安全值 */
    this.disabled = false;
    /** ensure() 是否成功跑过 */
    this.ready = false;
    /** 检索默认返回条数 */
    this.maxSearchResults = positiveInt(o.maxSearchResults, DEFAULT_MAX_RESULTS);
    /** buildContext 默认长度上限（字符） */
    this.injectMaxChars = positiveInt(o.injectMaxChars, DEFAULT_INJECT_MAX);
    /** 单日日志小节软上限，超了就按月份归档 */
    this.dailySoftLimit = positiveInt(o.dailySoftLimit, DEFAULT_DAILY_SOFT_LIMIT);

    try {
      const raw = typeof o.root === 'string' && o.root.trim() !== '' ? o.root.trim() : DEFAULT_ROOT;
      this.root = path.resolve(raw);
      fs.mkdirSync(this.root, { recursive: true });
      this.#debug(`记忆库就绪：${this.root}`);
    } catch (err) {
      this.disabled = true;
      this.root = '';
      this.#warn(`记忆库初始化失败（${o.root ?? DEFAULT_ROOT}）：${err?.message || err}`);
    }
  }

  /* -------------------- 日志 -------------------- */

  #debug(msg) {
    try {
      if (this.log?.debug) this.log.debug(msg);
    } catch {
      /* 日志器自己出问题也不能影响主流程 */
    }
  }

  #warn(msg) {
    try {
      if (this.log?.warn) this.log.warn(msg);
    } catch {
      /* 同上 */
    }
  }

  /* -------------------- 路径与写盘 -------------------- */

  /**
   * 相对路径 → 绝对路径。只接受记忆根内的相对路径：
   * 绝对路径、盘符、UNC、`..` 越界一律抛错（这是防目录穿越的唯一入口）。
   */
  #resolve(rel) {
    const raw = String(rel ?? '').trim();
    if (raw === '') throw new Error('路径不能为空');
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) {
      throw new Error(`只接受记忆库内的相对路径：${raw}`);
    }
    const abs = path.resolve(this.root, raw.replace(/[\\/]+/g, path.sep));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`路径越界（不在记忆库内）：${raw}`);
    }
    return abs;
  }

  /** 绝对路径 → 记忆根内的相对路径（`/` 分隔） */
  #rel(abs) {
    const r = path.relative(this.root, abs);
    return r.split(path.sep).join('/');
  }

  /** 临时文件名：<file>.<pid>.<seq>.tmp */
  #tmpName(file) {
    this.#seq += 1;
    return `${file}.${process.pid}.${this.#seq}.tmp`;
  }

  /** 原子写：写临时文件 → rename 覆盖；失败重试，绝不留半截文件 */
  async #atomicWrite(file, text) {
    const content = String(text ?? '').replace(/^\uFEFF/, '');
    const dir = path.dirname(file);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const tmp = this.#tmpName(file);
    try {
      await fsp.writeFile(tmp, content, { encoding: 'utf8' });
    } catch (err) {
      await this.#unlink(tmp);
      throw err;
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt += 1) {
      try {
        await fsp.rename(tmp, file); // Windows 上 rename 会覆盖已存在的文件
        return;
      } catch (err) {
        lastErr = err;
        if (!RETRY_CODES.has(err?.code)) break;
        if (attempt < RETRY_TIMES) await delay(30 + attempt * 70);
      }
    }
    await this.#unlink(tmp);
    throw lastErr ?? new Error(`写入失败：${file}`);
  }

  async #unlink(file) {
    try {
      await fsp.rm(file, { force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }

  /** 读文件；不存在返回 null（其它错误照抛，由调用方决定怎么办） */
  async #readIfExists(file) {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** 文件存在就什么都不做；不存在才写（ensure 的幂等基础） */
  async #ensureFile(rel, make) {
    const file = this.#resolve(rel);
    try {
      await fsp.access(file, fs.constants.F_OK);
      return false;
    } catch {
      /* 不存在 → 继续创建 */
    }
    await this.#atomicWrite(file, make());
    return true;
  }

  /** 把写操作排进串行队列 */
  #withLock(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 递归列出记忆库里的所有 .md（跳过隐藏目录 / node_modules / 超大文件） */
  async #listMarkdown() {
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > MAX_SCAN_DEPTH) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.') || name === 'node_modules') continue;
        const abs = path.join(dir, name);
        if (entry.isDirectory()) {
          await walk(abs, depth + 1);
          continue;
        }
        if (!entry.isFile() || !name.toLowerCase().endsWith('.md')) continue;
        let stat;
        try {
          stat = await fsp.stat(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) {
          this.#debug(`跳过过大的记忆文件：${abs}（${stat.size} 字节）`);
          continue;
        }
        out.push({ abs, rel: this.#rel(abs), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    await walk(this.root, 0);
    return out;
  }

  /* ==================== 1. ensure ==================== */

  /**
   * 建目录、索引页、必要子目录。幂等，可在每次启动时调用。
   * @returns {Promise<{root: string, created: string[]}>}
   */
  async ensure() {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    await fsp.mkdir(this.root, { recursive: true });
    for (const dir of [...DIRS, ATTACH_DIR]) {
      await fsp.mkdir(path.join(this.root, dir), { recursive: true });
    }

    const today = dateStamp(new Date());
    const created = [];
    if (await this.#ensureFile(INDEX_FILE, () => rootIndexPage(today))) created.push(INDEX_FILE);
    for (const dir of DIRS) {
      const rel = `${dir}/${INDEX_NAMES[dir]}`;
      if (await this.#ensureFile(rel, () => sectionIndexPage(dir, today))) created.push(rel);
    }
    this.ready = true;
    if (created.length > 0) this.#debug(`记忆库已补齐：${created.join('、')}`);
    return { root: this.root, created };
  }

  /* ==================== 2. captureTurn ==================== */

  /**
   * 每轮对话结束后调用：写当天日志 + 必要时更新人物页 / 群页。
   * 必须吞掉所有异常（失败只 log.debug）。
   * @returns {Promise<{ok: boolean, date?: string, person?: string, group?: string}>}
   */
  async captureTurn({ userId, nickname, groupId, groupName, userText, replyText, ts } = {}) {
    if (this.disabled) {
      this.#debug('记忆库未就绪，跳过本轮记忆');
      return { ok: false };
    }
    try {
      return await this.#withLock(() =>
        this.#captureTurnInner({ userId, nickname, groupId, groupName, userText, replyText, ts }),
      );
    } catch (err) {
      this.#debug(`记录本轮对话失败：${err?.message || err}`);
      return { ok: false };
    }
  }

  /** captureTurn 的实际实现（已在锁内，只能调用 *Locked 系列） */
  async #captureTurnInner({ userId, nickname, groupId, groupName, userText, replyText, ts }) {
    const when = toDate(ts);
    const said = clamp(oneLine(userText), 300);
    const replied = clamp(oneLine(replyText), 300);
    const out = { ok: false, date: dateStamp(when) };

    // 1) 当天日志：一条「谁说了什么」，一条「我怎么回的」
    const lines = [];
    if (said !== '') {
      const who = speakerName(nickname, userId);
      lines.push(groupId ? `- [群 ${String(groupId)}] ${who}：${said}` : `- [私聊] ${who}：${said}`);
    }
    if (replied !== '') lines.push(`- 我：${replied}`);
    if (lines.length > 0) {
      try {
        const written = await this.#appendDailyLocked(lines.join('\n'), when, timeStamp(when));
        out.daily = written?.path;
        out.ok = true;
      } catch (err) {
        this.#debug(`写当天日志失败：${err?.message || err}`);
      }
    }

    // 2) 人物页：首次见面建一页；之后每天最多改一次「最后说话」
    if (isIdLike(userId)) {
      try {
        out.person = await this.#touchPersonLocked({ userId, nickname, when, firstFact: said });
      } catch (err) {
        this.#debug(`更新人物页失败（${String(userId)}）：${err?.message || err}`);
      }
    }

    // 3) 群页：同理，有群名就顺手建/更新
    if (isIdLike(groupId)) {
      try {
        out.group = await this.#touchGroupLocked({ groupId, name: groupName, when });
      } catch (err) {
        this.#debug(`更新群页失败（${String(groupId)}）：${err?.message || err}`);
      }
    }
    return out;
  }

  /** 首次见面建人物页；已存在则每天最多刷新一次「最后说话」 */
  async #touchPersonLocked({ userId, nickname, when, firstFact }) {
    const stem = safeStem(userId);
    if (stem === '') return null;
    const rel = `${DIR_PERSON}/${stem}.md`;
    const file = this.#resolve(rel);
    const today = dateStamp(when);
    const existing = await this.#readIfExists(file);

    if (existing === null) {
      const facts = [];
      if (firstFact) facts.push(clamp(`第一次说话：${firstFact}`, 160));
      const page = personPage({ qq: userId, nickname, facts, dateStr: today });
      await this.#atomicWrite(file, page.text);
      await this.#linkIndexLocked(DIR_PERSON, stem, page.title);
      return rel;
    }

    const { data, body } = parseFrontmatter(existing);
    const lines = splitBody(body);
    const nic = oneLine(nickname);
    let changed = false;
    if (readBullet(lines, '最后说话') !== today) {
      changed = upsertBullet(lines, '最后说话', today) || changed;
    }
    if (nic !== '' && readBullet(lines, '昵称') !== nic) {
      changed = upsertBullet(lines, '昵称', nic) || changed;
    }
    if (!changed && data.updated === today) return rel;
    const pairs = rebuildFrontmatter(existing, { updated: today, qq: userId });
    await this.#atomicWrite(file, `${pairs}\n${joinBody(lines)}`);
    return rel;
  }

  /** 首次见面建群页；已存在则每天最多刷新一次「最后活跃」 */
  async #touchGroupLocked({ groupId, name, when }) {
    const stem = safeStem(groupId);
    if (stem === '') return null;
    const rel = `${DIR_GROUP}/${stem}.md`;
    const file = this.#resolve(rel);
    const today = dateStamp(when);
    const existing = await this.#readIfExists(file);

    if (existing === null) {
      const page = groupPage({ groupId, name, facts: [], dateStr: today });
      await this.#atomicWrite(file, page.text);
      await this.#linkIndexLocked(DIR_GROUP, stem, page.title);
      return rel;
    }

    const { data, body } = parseFrontmatter(existing);
    const lines = splitBody(body);
    let changed = false;
    if (readBullet(lines, '最后活跃') !== today) {
      changed = upsertBullet(lines, '最后活跃', today) || changed;
    }
    if (name && readBullet(lines, '群名') !== oneLine(name)) {
      changed = upsertBullet(lines, '群名', oneLine(name)) || changed;
    }
    if (!changed && data.updated === today) return rel;
    const pairs = rebuildFrontmatter(existing, { updated: today, group: groupId });
    await this.#atomicWrite(file, `${pairs}\n${joinBody(lines)}`);
    return rel;
  }

  /** 往目录索引页补一条 `- [[dir/target|label]]`（已存在就跳过） */
  async #linkIndexLocked(dir, stem, label) {
    const indexRel = `${dir}/${INDEX_NAMES[dir]}`;
    const file = this.#resolve(indexRel);
    const text = (await this.#readIfExists(file)) ?? sectionIndexPage(dir, dateStamp(new Date()));
    const { body } = parseFrontmatter(text);
    const lines = splitBody(body);
    const needle = `[[${dir}/${stem}`;
    if (lines.some((line) => line.includes(needle))) return false;

    const link = `- ${needle}|${oneLine(label)}]]`;
    const lastLink = lines.reduce((acc, line, i) => (line.trim().startsWith('- ') ? i : acc), -1);
    if (lastLink >= 0) lines.splice(lastLink + 1, 0, link);
    else lines.push('', link);
    const pairs = rebuildFrontmatter(text, { updated: dateStamp(new Date()) });
    await this.#atomicWrite(file, `${pairs}\n${joinBody(lines)}`);
    return true;
  }

  /* ==================== 3. appendDaily ==================== */

  /**
   * 追加一条日志（自定义文本），供工具 / 反思脚本用。
   * 任何异常都吞掉，只在 log.debug 留一条。
   * @returns {Promise<{path: string, heading: string} | null>}
   */
  async appendDaily(text, opts = {}) {
    const body = String(text ?? '').trim();
    if (body === '') return null;
    if (this.disabled) {
      this.#debug('记忆库未就绪，跳过日志写入');
      return null;
    }
    try {
      const when = toDate(opts?.ts);
      const heading =
        typeof opts?.heading === 'string' && opts.heading.trim() !== ''
          ? oneLine(opts.heading)
          : timeStamp(when);
      return await this.#withLock(() => this.#appendDailyLocked(body, when, heading));
    } catch (err) {
      this.#debug(`追加日志失败：${err?.message || err}`);
      return null;
    }
  }

  /**
   * 日志追加的实际实现。
   * 原子写法：读旧内容 → 拼上新小节 → 临时文件 → rename，
   * 所以外人永远看不到写了一半的日志，历史内容也一个字都不会丢。
   */
  async #appendDailyLocked(body, when, heading) {
    const dateStr = dateStamp(when);
    const file = this.#resolve(`${DIR_DAILY}/${dateStr}.md`);
    const existing = await this.#readIfExists(file);

    // 单日小节太多 → 往当月的归档文件里写，避免一天一个文件无限膨胀
    const dayCount = existing ? (existing.match(/^##[ \t]+/gm) ?? []).length : 0;
    if (existing !== null && dayCount >= this.dailySoftLimit) {
      const month = dateStr.slice(0, 7);
      const archiveRel = `${DIR_DAILY}/${month}.md`;
      const archiveFile = this.#resolve(archiveRel);
      const archiveHead = `${dateStr.slice(5)} ${heading}`;
      const archiveExisting =
        (await this.#readIfExists(archiveFile)) ?? dailyPage({ title: month, dateStr, tags: ['日志', '归档'] });
      const chunk = lastSectionHeading(archiveExisting) === archiveHead
        ? `\n${body}\n`
        : `\n## ${archiveHead}\n\n${body}\n`;
      await this.#appendRaw(archiveFile, archiveExisting, chunk);
      return { path: archiveRel, heading: archiveHead };
    }

    const head = existing ?? dailyPage({ title: dateStr, dateStr, tags: ['日志'] });
    // 同一分钟内多条：不再重复写 `## HH:MM`，直接接着往下排
    const sameHeading = lastSectionHeading(head) === heading;
    const chunk = sameHeading
      ? `\n${body}\n`
      : `\n## ${heading}\n\n${body}\n`;
    await this.#appendRaw(file, head, chunk);
    return { path: `${DIR_DAILY}/${dateStr}.md`, heading };
  }

  /** 原子追加：old + chunk 一起写进临时文件再 rename */
  async #appendRaw(file, oldText, chunk) {
    const base = String(oldText ?? '');
    // 超大文件别整篇读进内存重写，直接追加（appendFile 对小写入本身是原子的）
    if (base.length > APPEND_REWRITE_MAX) {
      await fsp.appendFile(file, chunk, { encoding: 'utf8' });
      return;
    }
    const merged = base === '' || base.endsWith('\n') ? base + chunk : `${base}\n${chunk}`;
    await this.#atomicWrite(file, merged);
  }

  /* ==================== 4. upsertPerson ==================== */

  /**
   * 合并式创建 / 更新人物页。
   * 已有页面只增补新事实、只改需要改的几行，手写内容一律保留。
   * @param {{qq: string|number, nickname?: string, facts?: string[]}} input
   * @returns {Promise<{path: string, created: boolean, added: number}>}
   */
  async upsertPerson({ qq, nickname, facts = [] } = {}) {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    const id = String(qq ?? '').trim();
    if (id === '') throw new Error('人物页需要 QQ 号');
    const stem = safeStem(id);
    if (stem === '') throw new Error(`QQ 号不合法：${id}`);
    return this.#withLock(() => this.#upsertPersonLocked({ qq: id, nickname, facts }));
  }

  async #upsertPersonLocked({ qq, nickname, facts }) {
    const stem = safeStem(qq);
    const rel = `${DIR_PERSON}/${stem}.md`;
    const file = this.#resolve(rel);
    const today = dateStamp(new Date());
    const list = normalizeFacts(facts);
    const nic = oneLine(nickname);
    const existing = await this.#readIfExists(file);

    if (existing === null) {
      const page = personPage({ qq, nickname: nic, facts: list, dateStr: today });
      await this.#atomicWrite(file, page.text);
      await this.#linkIndexLocked(DIR_PERSON, stem, page.title);
      return { path: rel, created: true, added: list.length };
    }

    const { data, body } = parseFrontmatter(existing);
    const lines = splitBody(body);
    let changed = false;
    if (nic !== '' && readBullet(lines, '昵称') !== nic) changed = upsertBullet(lines, '昵称', nic) || changed;
    if (readBullet(lines, 'QQ') === '') changed = upsertBullet(lines, 'QQ', qq) || changed;
    const added = mergeFacts(lines, list);
    if (added > 0) changed = true;
    if (!changed && data.updated === today) return { path: rel, created: false, added: 0 };

    const pairs = rebuildFrontmatter(existing, { updated: today, qq });
    await this.#atomicWrite(file, `${pairs}\n${joinBody(lines)}`);
    await this.#linkIndexLocked(DIR_PERSON, stem, extractTitle(body, nic || `QQ ${qq}`));
    return { path: rel, created: false, added };
  }

  /* ==================== 5. upsertGroup ==================== */

  /**
   * 合并式创建 / 更新群页。
   * @param {{groupId: string|number, name?: string, topic?: string, facts?: string[]}} input
   * @returns {Promise<{path: string, created: boolean, added: number}>}
   */
  async upsertGroup({ groupId, name, topic, facts = [] } = {}) {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    const id = String(groupId ?? '').trim();
    if (id === '') throw new Error('群页需要群号');
    const stem = safeStem(id);
    if (stem === '') throw new Error(`群号不合法：${id}`);
    return this.#withLock(() =>
      this.#upsertGroupLocked({ groupId: id, name, topic, facts }),
    );
  }

  async #upsertGroupLocked({ groupId, name, topic, facts }) {
    const stem = safeStem(groupId);
    const rel = `${DIR_GROUP}/${stem}.md`;
    const file = this.#resolve(rel);
    const today = dateStamp(new Date());
    const list = normalizeFacts(facts);
    const gname = oneLine(name);
    const gtopic = oneLine(topic);
    const existing = await this.#readIfExists(file);

    if (existing === null) {
      const page = groupPage({ groupId, name: gname, topic: gtopic, facts: list, dateStr: today });
      await this.#atomicWrite(file, page.text);
      await this.#linkIndexLocked(DIR_GROUP, stem, page.title);
      return { path: rel, created: true, added: list.length };
    }

    const { data, body } = parseFrontmatter(existing);
    const lines = splitBody(body);
    let changed = false;
    if (gname !== '' && readBullet(lines, '群名') !== gname) changed = upsertBullet(lines, '群名', gname) || changed;
    if (gtopic !== '' && readBullet(lines, '话题') !== gtopic) changed = upsertBullet(lines, '话题', gtopic) || changed;
    if (readBullet(lines, '群号') === '') changed = upsertBullet(lines, '群号', groupId) || changed;
    const added = mergeFacts(lines, list);
    if (added > 0) changed = true;
    if (!changed && data.updated === today) return { path: rel, created: false, added: 0 };

    const pairs = rebuildFrontmatter(existing, { updated: today, group: groupId });
    await this.#atomicWrite(file, `${pairs}\n${joinBody(lines)}`);
    await this.#linkIndexLocked(DIR_GROUP, stem, extractTitle(body, gname || `群 ${groupId}`));
    return { path: rel, created: false, added };
  }

  /* ==================== 6. writeNote ==================== */

  /**
   * 新建 / 覆盖一篇知识或反思笔记。
   * @param {{dir?: string, title: string, body: string, tags?: string[]}} input
   * @returns {Promise<{path: string, created: boolean, bytes: number}>}
   */
  async writeNote({ dir = DIR_NOTE, title, body, tags = [] } = {}) {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    const name = oneLine(title);
    if (name === '') throw new Error('笔记标题不能为空');
    const stem = safeStem(name);
    if (stem === '') throw new Error(`标题不合法：${name}`);

    let dirRel = String(dir ?? DIR_NOTE).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (dirRel === '') dirRel = DIR_NOTE;
    this.#resolve(dirRel); // 只做越界校验，越界会在这里抛

    const rel = `${dirRel}/${stem}.md`;
    const file = this.#resolve(rel);
    const tagList = (Array.isArray(tags) ? tags : [tags])
      .map((t) => oneLine(t))
      .filter((t) => t !== '');

    return this.#withLock(async () => {
      const today = dateStamp(new Date());
      const existing = await this.#readIfExists(file);
      const content =
        existing === null
          ? notePage({ title: name, body, tags: tagList, dateStr: today })
          : notePage({ title: name, body, tags: tagList, dateStr: today, existing });
      await this.#atomicWrite(file, content);
      return { path: rel, created: existing === null, bytes: Buffer.byteLength(content, 'utf8') };
    });
  }

  /* ==================== 7. search ==================== */

  /**
   * 关键词检索。中文按 2-gram 切，英文 / 数字按词切。
   * 分数 = Σ(query 词在正文的出现次数 / 正文词数)，标题命中 ×3，updated 新的再加一点。
   * 任何异常都会吞掉返回 []（检索失败绝不能影响聊天）。
   * @returns {Promise<Array<{path: string, title: string, score: number, snippet: string}>>}
   */
  async search(query, { limit = 0 } = {}) {
    try {
      const q = String(query ?? '').trim();
      if (q === '' || this.disabled) return [];

      const tokens = [...new Set(tokenize(q))];
      if (tokens.length === 0) return [];
      // 单字中文查询（「群」「鱼」）拿 2-gram 是匹配不到的，单独按字计数
      const needsCharCount = tokens.some((t) => t.length === 1 && CJK_RE.test(t));

      const wanted = Math.min(positiveInt(limit, this.maxSearchResults), 100);
      const files = await this.#listMarkdown();
      if (files.length === 0) return [];

      const now = Date.now();
      const results = [];
      for (const item of files) {
        let raw;
        try {
          raw = await fsp.readFile(item.abs, 'utf8');
        } catch (err) {
          this.#debug(`检索跳过（读取失败）：${item.rel}：${err?.message || err}`);
          continue;
        }
        const { data, body } = parseFrontmatter(raw);
        const tags = Array.isArray(data.tags) ? data.tags.join(' ') : String(data.tags ?? '');
        const title = extractTitle(body, path.basename(item.abs, '.md'));
        const haystack = `${body}\n${tags}`;

        const docCounts = countTokens(tokenize(haystack));
        const docLen = Math.max(1, tokensTotal(docCounts));
        const titleCounts = countTokens(tokenize(title));
        const charCounts = needsCharCount ? countChars(haystack) : null;

        let score = 0;
        let hitCount = 0;
        for (const token of tokens) {
          let bodyHits = docCounts.get(token) ?? 0;
          if (bodyHits === 0 && charCounts) bodyHits = charCounts.get(token) ?? 0;
          const titleHits = titleCounts.get(token) ?? 0;
          if (bodyHits === 0 && titleHits === 0) continue;
          hitCount += 1;
          // 正文命中：出现次数 / 正文词数（归一化，长文档不吃亏也不会霸榜）
          score += (bodyHits / docLen) * 1000;
          // 标题命中：同样的归一化再 ×3
          score += ((titleHits / docLen) * 1000) * 3;
        }
        if (score <= 0) continue;

        // 命中越多查询词越相关：轻微加成，避免被短文档的单个词霸榜
        score *= 1 + 0.5 * (hitCount / tokens.length);
        // updated 越新越靠前（最多 +20%，半年线性衰减）
        const updatedMs = parseStamp(data.updated) ?? item.mtimeMs;
        const ageDays = (now - updatedMs) / 86400000;
        const recency = ageDays <= 0 ? 1 : Math.max(0, 1 - ageDays / 180);
        score *= 1 + 0.2 * recency;

        results.push({
          path: item.rel,
          title,
          score: Math.round(score * 1000) / 1000,
          snippet: makeSnippet(body, tokens, 90),
        });
      }

      results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return results.slice(0, wanted);
    } catch (err) {
      this.#warn(`检索记忆失败：${err?.message || err}`);
      return [];
    }
  }

  /* ==================== 8. recentDaily ==================== */

  /**
   * 最近 n 天的日志（新 → 旧）。
   * @returns {Promise<Array<{date: string, path: string, content: string, bytes: number}>>}
   */
  async recentDaily(n = 3) {
    const want = Math.min(positiveInt(n, 3), 400);
    if (this.disabled) return [];
    const dir = path.join(this.root, DIR_DAILY);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const days = names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // 新 → 旧
      .slice(0, want);

    const out = [];
    for (const date of days) {
      const rel = `${DIR_DAILY}/${date}.md`;
      const content = await this.#readIfExists(this.#resolve(rel));
      if (content === null) continue;
      out.push({ date, path: rel, content, bytes: Buffer.byteLength(content, 'utf8') });
    }
    return out;
  }

  /* ==================== 9. buildContext ==================== */

  /**
   * 给 DSH prompt 用的记忆块：关于这个人 / 关于这个群 / 相关记忆 / 今天说过的话。
   * 哪段没内容就整段省略；总长度不超过 maxChars（默认 injectMaxChars）。
   * @returns {Promise<string>} 没有可用记忆时返回 ''
   */
  async buildContext(query, { userId, groupId, maxChars } = {}) {
    const limit = Math.min(positiveInt(maxChars, this.injectMaxChars), 20000);
    if (this.disabled) return '';

    const sections = [];

    // 关于这个人
    if (isIdLike(userId)) {
      const stem = safeStem(userId);
      const text = stem ? await this.#readIfExists(this.#resolve(`${DIR_PERSON}/${stem}.md`)) : null;
      if (text) {
        const digest = pageDigest(text, { maxLines: 12 });
        if (digest.trim() !== '') sections.push({ title: '关于这个人', body: digest });
      }
    }

    // 关于这个群
    if (isIdLike(groupId)) {
      const stem = safeStem(groupId);
      const text = stem ? await this.#readIfExists(this.#resolve(`${DIR_GROUP}/${stem}.md`)) : null;
      if (text) {
        const digest = pageDigest(text, { maxLines: 12 });
        if (digest.trim() !== '') sections.push({ title: '关于这个群', body: digest });
      }
    }

    // 相关记忆（检索命中的其它笔记）
    const q = String(query ?? '').trim();
    if (q !== '') {
      // 索引页和根页只是目录，会挤掉真正的记忆，这里去掉
      const hits = (await this.search(q, { limit: 8 }))
        .filter((hit) => hit.path !== INDEX_FILE && !/索引$/.test(hit.title))
        .slice(0, 4);
      if (hits.length > 0) {
        const body = hits
          .map((hit) => `- ${hit.title}（${hit.path}）：${clamp(oneLine(hit.snippet), 120)}`)
          .join('\n');
        sections.push({ title: '相关记忆', body });
      }
    }

    // 今天说过的话
    const todayFile = `${DIR_DAILY}/${dateStamp(new Date())}.md`;
    const todayText = await this.#readIfExists(this.#resolve(todayFile));
    if (todayText) {
      const tail = tailSections(todayText, 2);
      if (tail.trim() !== '') sections.push({ title: '今天说过的话', body: tail });
    }

    if (sections.length === 0) return '';

    // 每段先按比例给个软上限，再按总长度硬压
    const soft = {
      关于这个人: Math.round(limit * 0.3),
      关于这个群: Math.round(limit * 0.3),
      相关记忆: Math.round(limit * 0.32),
      今天说过的话: Math.round(limit * 0.22),
    };
    const blocks = sections.map((s) => ({
      head: `【${s.title}】`,
      body: softClamp(s.body.trim(), soft[s.title] ?? Math.round(limit * 0.3)),
    }));

    const render = () =>
      blocks
        .filter((b) => b.body.trim() !== '')
        .map((b) => `${b.head}\n${b.body}`)
        .join('\n\n');

    let text = render();
    let guard = 0;
    while (text.length > limit && blocks.length > 0 && guard < 40) {
      guard += 1;
      const over = text.length - limit;
      const last = blocks[blocks.length - 1];
      const target = last.body.length - over - 1;
      if (target < 40 || last.body.length === 0) {
        blocks.pop();
        text = render();
        continue;
      }
      last.body = softClamp(last.body, target);
      text = render();
    }
    return clamp(text.trim(), limit);
  }

  /* ==================== 10. stats ==================== */

  /**
   * 统计：文件数、各类目数量、总字节、最近更新时间。
   * @returns {Promise<{root: string, files: number, byDir: object, totalBytes: number, lastUpdated: string}>}
   */
  async stats() {
    const byDir = {};
    for (const dir of DIRS) byDir[STAT_LABELS[dir]] = 0;
    const out = { root: this.root, files: 0, byDir, totalBytes: 0, lastUpdated: '' };
    if (this.disabled) return out;

    const files = await this.#listMarkdown();
    let newest = 0;
    for (const item of files) {
      out.files += 1;
      out.totalBytes += item.size;
      if (item.mtimeMs > newest) newest = item.mtimeMs;
      const [top] = item.rel.split('/');
      const label = STAT_LABELS[top];
      if (label) byDir[label] += 1;
    }
    out.lastUpdated = newest > 0 ? new Date(newest).toISOString() : '';
    return out;
  }

  /* ==================== 11. 额外小工具（WebUI 用） ==================== */

  /** 相对路径 → 绝对路径（越界抛错），给控制台复用 */
  absolutePath(rel) {
    return this.#resolve(rel);
  }

  /** 相对路径 → 记忆根内相对路径（`/` 分隔） */
  relativePath(abs) {
    return this.#rel(abs);
  }

  /**
   * 按相对路径读一篇笔记（路径必须落在记忆根内，越界抛错）。
   * @returns {Promise<{path: string, title: string, body: string, frontmatter: object, text: string}>}
   */
  async readNote(rel) {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    const abs = this.#resolve(rel);
    const text = await fsp.readFile(abs, { encoding: 'utf8' });
    const { data, body } = parseFrontmatter(text);
    return {
      path: this.#rel(abs),
      title: extractTitle(body, path.basename(abs, '.md')),
      body,
      frontmatter: data,
      text,
    };
  }

  /**
   * 按相对路径覆盖写一篇笔记（路径必须落在记忆根内，越界抛错）。
   * @returns {Promise<{path: string, bytes: number}>}
   */
  async saveNote(rel, body) {
    if (this.disabled) throw new Error('记忆库未就绪（初始化失败）');
    const abs = this.#resolve(rel);
    const content = String(body ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    await this.#withLock(() => this.#atomicWrite(abs, content));
    return { path: this.#rel(abs), bytes: Buffer.byteLength(content, 'utf8') };
  }
}

/* ================================================================== 页面模板 */

/** 记忆库根索引页 */
function rootIndexPage(dateStr) {
  return [
    ...frontmatterLines([
      ['tags', ['索引', '大肥鱼']],
      ['updated', dateStr],
    ]),
    '',
    '# 大肥鱼记忆库',
    '',
    'QQ 里那只 DSH 鲸鱼娘的长期记忆。它自己会往里写，你也可以直接改。',
    '',
    '## 四个抽屉',
    '',
    `- [[${DIR_PERSON}/人物索引|人物]] —— 每个聊过的人一页`,
    `- [[${DIR_GROUP}/群聊索引|群聊]] —— 每个群一页，记群风、常聊话题、谁是谁`,
    `- [[${DIR_DAILY}/日志索引|日志]] —— 每天一页流水账`,
    `- [[${DIR_NOTE}/知识索引|知识]] —— 学到的东西`,
    `- [[${DIR_REFLECT}/反思索引|反思]] —— 阶段性自我总结`,
    '',
    '## 使用约定',
    '',
    '1. 每页开头有 `tags`，方便在 Obsidian 里按标签筛。',
    '2. 人物页和群聊页是「合并更新」的，同一件事别写两遍。',
    '3. 日志是追加式，只往下写，不改历史。',
    '4. 想让它记住什么，直接往对应页面写一句就行；下次对话它会读到。',
    '',
  ].join('\n');
}

/** 某个抽屉的小索引页 */
function sectionIndexPage(dir, dateStr) {
  const label = STAT_LABELS[dir] ?? dir;
  const notes = {
    [DIR_PERSON]: '本目录一人一页，文件名是 QQ 号。',
    [DIR_GROUP]: '本目录一群一页，文件名是群号。',
    [DIR_DAILY]: '按天记录。每天一个 `30-日志/YYYY-MM-DD.md`。',
    [DIR_NOTE]: '学到的东西、结论、教程，一篇一个标题。',
    [DIR_REFLECT]: '阶段性自我总结，一周一篇 `50-反思/YYYY-Www.md`。',
  };
  return [
    ...frontmatterLines([
      ['tags', ['索引', label]],
      ['updated', dateStr],
    ]),
    '',
    `# ${label}索引`,
    '',
    notes[dir] ?? '',
    '',
  ].join('\n');
}

/** 日志页（新建当天文件时用） */
function dailyPage({ title, dateStr, tags }) {
  return [
    ...frontmatterLines([
      ['tags', tags],
      ['updated', dateStr],
    ]),
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

/** 人物页模板 */
function personPage({ qq, nickname, facts, dateStr }) {
  const nic = oneLine(nickname);
  const title = nic !== '' ? nic : `QQ ${qq}`;
  const lines = [
    ...frontmatterLines([
      ['tags', ['人物', 'QQ']],
      ['qq', String(qq)],
      ['updated', dateStr],
    ]),
    '',
    `# ${title}`,
    '',
    `- QQ：${qq}`,
    ...(nic !== '' ? [`- 昵称：${nic}`] : []),
    `- 首次记录：${dateStr}`,
    `- 最后说话：${dateStr}`,
    '',
    '## 记忆',
    '',
    ...facts.map((f) => `- ${f}`),
    '',
    '## 相关',
    '',
    `- [[${DIR_PERSON}/人物索引|人物索引]]`,
    '',
  ];
  return { title, text: lines.join('\n') };
}

/** 群页模板 */
function groupPage({ groupId, name, topic, facts, dateStr }) {
  const gname = oneLine(name);
  const gtopic = oneLine(topic);
  const title = gname !== '' ? gname : `群 ${groupId}`;
  const lines = [
    ...frontmatterLines([
      ['tags', ['群聊', 'QQ']],
      ['group', String(groupId)],
      ['updated', dateStr],
    ]),
    '',
    `# ${title}`,
    '',
    `- 群号：${groupId}`,
    ...(gname !== '' ? [`- 群名：${gname}`] : []),
    ...(gtopic !== '' ? [`- 话题：${gtopic}`] : []),
    `- 首次记录：${dateStr}`,
    `- 最后活跃：${dateStr}`,
    '',
    '## 记忆',
    '',
    ...facts.map((f) => `- ${f}`),
    '',
    '## 相关',
    '',
    `- [[${DIR_GROUP}/群聊索引|群聊索引]]`,
    '',
  ];
  return { title, text: lines.join('\n') };
}

/** 知识 / 反思笔记 */
function notePage({ title, body, tags, dateStr, existing }) {
  const text = String(body ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const tagList = tags.length > 0 ? tags : ['笔记'];
  if (existing !== undefined && existing !== null) {
    // 覆盖正文，但保留旧 frontmatter 里的自定义字段（例如 created、source）
    const pairs = rebuildFrontmatter(existing, { updated: dateStr, tags: tagList });
    return `${pairs}\n# ${title}\n\n${text.trim()}\n`;
  }
  return [
    ...frontmatterLines([
      ['tags', tagList],
      ['updated', dateStr],
    ]),
    '',
    `# ${title}`,
    '',
    text.trim(),
    '',
  ].join('\n');
}

/* ================================================================== 内部工具（依赖上面的模板） */

/**
 * 基于旧文件的 frontmatter 重建，只覆盖 patch 里的键，其余原样保留（顺序也尽量保留）。
 * @returns {string} 含首尾 `---` 的 frontmatter 文本
 */
function rebuildFrontmatter(oldText, patch) {
  const { data, hasFrontmatter } = parseFrontmatter(oldText);
  const merged = hasFrontmatter ? { ...data, ...patch } : { ...patch };
  if (!hasFrontmatter && merged.tags === undefined) merged.tags = ['笔记'];
  const pairs = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) continue;
    pairs.push([key, value]);
  }
  return frontmatterLines(pairs).join('\n');
}

/** 计数表里所有 token 的总数 */
function tokensTotal(counts) {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/** 单个 CJK 字的出现次数（单字查询用） */
function countChars(text) {
  const map = new Map();
  for (const ch of String(text ?? '').toLowerCase()) {
    if (CJK_RE.test(ch)) map.set(ch, (map.get(ch) ?? 0) + 1);
  }
  return map;
}

/** 按查询词在正文里的首次出现位置截一小段 */
function makeSnippet(body, tokens, width = 90) {
  // 摘录是给人（和 LLM）读的，先把 markdown 记号去掉，省得像乱码
  const flat = oneLine(parseFrontmatter(body).body)
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (flat === '') return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return clamp(flat, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  const piece = flat.slice(start, end).trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return `${prefix}${piece}${suffix}`;
}

/** 按软上限截断但保留省略号；上限 <=0 直接给空 */
function softClamp(text, max) {
  const n = Math.max(0, Math.floor(Number(max) || 0));
  if (n === 0) return '';
  return clamp(text, n);
}

/** `2026-10-20` / ISO 字符串 → 毫秒；解析不出来返回 null */
function parseStamp(value) {
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`).getTime() : new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}
