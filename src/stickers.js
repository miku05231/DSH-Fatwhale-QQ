// src/stickers.js —— 表情包库：自动采集 / 打标签 / 索引 / 迁移（零依赖）
//
// 为什么单独一个模块：三拨人要用同一个库 ——
//   1) 桥接（src/index.js）收到群消息/私聊里的 QQ 表情时把它存盘；
//   2) 控制台（src/webui/server.mjs）要列出来、按标签筛、改标签、重建索引、迁移目录；
//   3) 命令行（tools/stickers.mjs）让 DSH 自己在对话里挑一张发出去、或者补标签。
// 所以这里只做纯文件/纯函数的事，不认识 OneBot、不认识 HTTP。
//
// 目录长这样（<root> 可以在控制台改成任意位置）：
//   <root>/index.json              —— 索引（跟库一起搬走，迁移后不用重建）
//   <root>/.lock                   —— 写索引用的小锁（下次改标签/采集时抢）
//   <root>/2026-10/<sha16>.png     —— 图片本体，按月份分目录，文件名取 sha256 前 16 位
//
// 设计取舍：
//   * 去重按**内容**（sha256），同一张表情被转存/改名一百次也只留一份，只加 seen 计数；
//   * 标签是纯字符串数组，自动标签和手改标签混在一起，删的时候按值删；
//   * 索引丢了不慌：rebuildIndex() 扫盘重建，标签按 sha256 从旧索引捞回来（能捞多少捞多少）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { expandPath } from './persona.js';
import { resolvePath } from './config.js';

/** 表情包库的默认设置（写进 config.js 的 DEFAULTS，这里是兜底与归一化） */
export const STICKER_DEFAULTS = Object.freeze({
  enabled: true,
  root: path.join('state', 'stickers'),
  autoCollect: true,
  autoTag: true,
  // 单张上限 5MB，限制表情包或手动导入图片的存储开销
  maxBytes: 5 * 1024 * 1024,
  // 小于 200 字节的图片是坏图/占位符，别收
  minBytes: 200,
  // 一条消息最多收几张（有人一口气发九宫格，不必全要）
  maxPerMessage: 3,
  // 每分钟最多收几张，防止有人刷图把磁盘写满
  perMinute: 20,
});

/** 认得出、存得下的图片扩展名（顺序有意义：嗅探时按内容判断，不靠扩展名） */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 自动标签里不要的词：太泛，打上去等于没打 */
const STOP_WORDS = new Set([
  '图片', '表情', '表情包', '动画表情', '这个', '那个', '什么', '怎么', '可以', '真的', '不是',
  '就是', '我们', '你们', '他们', '已经', '还是', '因为', '所以', '然后', '现在', '时候',
  '一个', '一下', '没有', '知道', '觉得', '有点', '哈哈', '哈哈哈', '哈哈哈哈哈', '呵呵',
  '自己', '这样', '那样', '如果', '但是', '而且', '还有', '这些', '那些', '东西', '感觉',
]);

const INDEX_VERSION = 1;
const LOCK_STALE_MS = 30_000;

// ---------------------------------------------------------------- 小工具

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 标签归一化：去控制字符、压空白、截断；空串返回 '' */
export function normalizeTag(value) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned;
}

/** 去重 + 去空 + 排序的标签数组 */
export function uniqTags(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const tag = normalizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 把配置里的 stickers 段归一化成完整设置 */
export function normalizeStickerSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const root = typeof s.root === 'string' && s.root.trim() ? s.root.trim() : STICKER_DEFAULTS.root;
  return {
    enabled: s.enabled !== false,
    root,
    autoCollect: s.autoCollect !== false,
    autoTag: s.autoTag !== false,
    maxBytes: clampInt(s.maxBytes, STICKER_DEFAULTS.maxBytes, 1024, 64 * 1024 * 1024),
    minBytes: clampInt(s.minBytes, STICKER_DEFAULTS.minBytes, 0, 1024 * 1024),
    maxPerMessage: clampInt(s.maxPerMessage, STICKER_DEFAULTS.maxPerMessage, 1, 9),
    perMinute: clampInt(s.perMinute, STICKER_DEFAULTS.perMinute, 1, 200),
  };
}

/**
 * 库里图片的绝对根目录。
 * 支持绝对路径、相对项目根的路径、~ 与 %USERPROFILE% 这类变量（跟人格/记忆库一致）。
 */
export function stickerRootDir({ configRoot, config } = {}) {
  const settings = normalizeStickerSettings(config?.stickers ?? {});
  const expanded = expandPath(settings.root);
  return resolvePath(configRoot ?? process.cwd(), expanded || settings.root);
}

export function indexFile(root) {
  return path.join(root, 'index.json');
}

export function lockFile(root) {
  return path.join(root, '.lock');
}

export function mimeOf(file) {
  return IMAGE_MIME[path.extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

export function isImageFile(file) {
  return IMAGE_EXTS.includes(path.extname(String(file)).toLowerCase());
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readUIntBE(buffer, offset, size) {
  if (offset < 0 || offset + size > buffer.length) return 0;
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
  return value;
}

function readUIntLE(buffer, offset, size) {
  if (offset < 0 || offset + size > buffer.length) return 0;
  let value = 0;
  for (let i = size - 1; i >= 0; i -= 1) value = value * 256 + buffer[offset + i];
  return value;
}

/**
 * 靠文件头认图片（不信扩展名 —— QQ 发来的临时文件常常叫 xxx.image）。
 * @returns {{ext:string, mime:string, width:number, height:number, animated:boolean, kind:string}|null}
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  const b = buffer;

  // PNG：签名 + IHDR 宽高；带 acTL 块的是 APNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const width = readUIntBE(b, 16, 4);
    const height = readUIntBE(b, 20, 4);
    const animated = b.includes(Buffer.from('acTL', 'ascii'));
    return imageInfo('.png', width, height, animated);
  }

  // GIF：GIF87a / GIF89a，多帧就是动图
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const width = readUIntLE(b, 6, 2);
    const height = readUIntLE(b, 8, 2);
    let frames = 0;
    for (let i = 0; i < b.length - 1; i += 1) {
      if (b[i] === 0x21 && b[i + 1] === 0xf9) {
        frames += 1;
        if (frames > 1) break;
      }
    }
    return imageInfo('.gif', width, height, frames > 1);
  }

  // JPEG：FF D8，往后找 SOFn 段取宽高
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = b[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = readUIntBE(b, offset + 2, 2);
      if (length < 2) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = readUIntBE(b, offset + 5, 2);
        const width = readUIntBE(b, offset + 7, 2);
        return imageInfo('.jpg', width, height, false);
      }
      offset += 2 + length;
    }
    return imageInfo('.jpg', 0, 0, false);
  }

  // WebP：RIFF....WEBP，VP8X 里存宽高（更老的 VP8/VP8L 就不解了，反正能存）
  if (
    b.length > 30 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    let width = 0;
    let height = 0;
    let animated = false;
    const chunk = b.slice(12, 16).toString('ascii');
    if (chunk === 'VP8X' && b.length >= 30) {
      animated = (b[20] & 0x02) !== 0;
      width = 1 + readUIntLE(b, 24, 3);
      height = 1 + readUIntLE(b, 27, 3);
    }
    return imageInfo('.webp', width, height, animated);
  }

  // BMP：BM + 宽高（高度可能为负，表示自上而下）
  if (b[0] === 0x42 && b[1] === 0x4d) {
    const width = readUIntLE(b, 18, 4);
    const height = Math.abs(readUIntLE(b, 22, 4));
    return imageInfo('.bmp', width, height, false);
  }

  return null;
}

function imageInfo(ext, width, height, animated) {
  return {
    ext,
    mime: IMAGE_MIME[ext] ?? 'application/octet-stream',
    width: width || 0,
    height: height || 0,
    animated: Boolean(animated),
    kind: animated ? '动图' : '静态',
  };
}

/** 尺寸档：表情包一般很小，太大的多半是照片 */
function sizeBucket(width, height) {
  const max = Math.max(width || 0, height || 0);
  if (!max) return null;
  if (max <= 64) return '小图';
  if (max <= 240) return '中图';
  return '大图';
}

const NOISY_PREFIXES = ['哈哈', '这个', '那个', '什么', '怎么', '可以', '真的', '不是', '就是', '我们', '你们', '他们', '已经', '还是', '因为', '所以', '然后', '现在', '时候', '一个', '一下', '没有', '知道', '觉得', '有点', '自己', '这样', '那样', '如果', '但是', '而且', '还有', '这些', '那些', '东西', '感觉'];

// ---------------------------------------------------------------- 自动标签

/**
 * 从消息文字里抠关键词。
 * 中文没有空格，「哈哈这个好搞笑」会整段被当成一个词，所以还要再筛：
 * 纯汉字的词只留 2–4 个字、不能拿上面那堆口语词开头，最多两个。
 */
export function keywordsOf(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return [];
  const cleaned = raw
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[(图片|表情|动画表情|视频|语音|文件)[^\]]*\]/g, ' ');
  const words = cleaned.match(/[\p{Script=Han}\p{L}\p{N}]{2,8}/gu) ?? [];
  const out = [];
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    const hanOnly = /^[\p{Script=Han}]+$/u.test(word);
    if (hanOnly) {
      if (word.length > 4) continue;
      if (NOISY_PREFIXES.some((prefix) => word.startsWith(prefix) && word.length > prefix.length)) continue;
    }
    if (out.includes(word)) continue;
    out.push(word);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 采集时自动打的标签。
 * 目标是「以后能找回来」：谁发的、哪个群、什么图、什么由头。
 * @param {{source?:object, text?:string, summary?:string, image?:object, now?:number}} input
 */
export function autoTagsFor({ source, text, summary, image, now = Date.now() } = {}) {
  const tags = [];
  const src = source && typeof source === 'object' ? source : {};
  if (src.kind === 'group') tags.push('来源:群');
  else if (src.kind === 'private') tags.push('来源:私聊');
  if (src.groupId) tags.push(`群:${src.groupId}`);
  if (src.nickname) tags.push(`用户:${src.nickname}`);
  for (const keyword of keywordsOf(text)) tags.push(`关键词:${keyword}`);
  const cleanSummary = String(summary ?? '').replace(/^\[|\]$/g, '').trim();
  if (cleanSummary && cleanSummary !== '图片') tags.push(`标记:${cleanSummary}`);
  if (image?.kind) tags.push(`类型:${image.kind}`);
  const bucket = image ? sizeBucket(image.width, image.height) : null;
  if (bucket) tags.push(`尺寸:${bucket}`);
  const date = new Date(now);
  if (!Number.isNaN(date.getTime())) {
    tags.push(`月份:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }
  return uniqTags(tags);
}

// ---------------------------------------------------------------- 索引读写

export function emptyIndex(root) {
  return { version: INDEX_VERSION, root: String(root ?? ''), updatedAt: null, items: [] };
}

/** 归一化一条索引记录（读盘时兜底，别让坏数据把页面搞崩） */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = typeof raw.file === 'string' ? raw.file.replace(/\\/g, '/') : '';
  if (!file) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : path.basename(file, path.extname(file)),
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
    file,
    bytes: Number.isFinite(Number(raw.bytes)) ? Math.trunc(Number(raw.bytes)) : 0,
    width: Number.isFinite(Number(raw.width)) ? Math.trunc(Number(raw.width)) : 0,
    height: Number.isFinite(Number(raw.height)) ? Math.trunc(Number(raw.height)) : 0,
    mime: typeof raw.mime === 'string' && raw.mime ? raw.mime : mimeOf(file),
    animated: raw.animated === true,
    firstAt: typeof raw.firstAt === 'string' && raw.firstAt ? raw.firstAt : null,
    lastAt: typeof raw.lastAt === 'string' && raw.lastAt ? raw.lastAt : null,
    seen: Number.isFinite(Number(raw.seen)) && Number(raw.seen) > 0 ? Math.trunc(Number(raw.seen)) : 1,
    tags: uniqTags(raw.tags),
    source: raw.source && typeof raw.source === 'object' ? { ...raw.source } : null,
    text: typeof raw.text === 'string' ? raw.text.slice(0, 200) : '',
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 60) : '',
  };
}

export function normalizeIndex(raw, root) {
  const base = emptyIndex(root);
  if (!raw || typeof raw !== 'object') return base;
  const items = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
  }
  return {
    version: Number(raw.version) || INDEX_VERSION,
    root: typeof raw.root === 'string' && raw.root ? raw.root : String(root ?? ''),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    items,
  };
}

/** 读索引；文件不存在/坏了都返回空索引（坏的那份先备份成 .bad-时间戳，别悄悄丢） */
export async function loadIndex(root) {
  const file = indexFile(root);
  let text = null;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyIndex(root);
    throw err;
  }
  try {
    return normalizeIndex(JSON.parse(text.replace(/^\uFEFF/, '')), root);
  } catch {
    const backup = `${file}.bad-${Date.now()}`;
    try {
      await fsp.rename(file, backup);
    } catch {
      /* 备份失败也不影响重建 */
    }
    return emptyIndex(root);
  }
}

/** 原子写索引（临时文件 + rename，断电不会留半截 JSON） */
export async function saveIndex(root, index) {
  const normalized = normalizeIndex(index, root);
  const payload = {
    version: INDEX_VERSION,
    root: String(root ?? ''),
    updatedAt: new Date().toISOString(),
    items: normalized.items,
  };
  const file = indexFile(root);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return normalizeIndex(payload, root);
}

/** 标签计数（页面上的标签云就靠它） */
export function tagCounts(index) {
  const counts = new Map();
  for (const item of index?.items ?? []) {
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

/** 库的概况（控制台/CLI 都要用同一份口径） */
export function storeStats(index) {
  const items = index?.items ?? [];
  let bytes = 0;
  let animated = 0;
  for (const item of items) {
    bytes += Number(item.bytes) || 0;
    if (item.animated) animated += 1;
  }
  return {
    count: items.length,
    bytes,
    animated,
    staticCount: items.length - animated,
    tags: tagCounts(index),
    lastAt: items.reduce((acc, item) => (item.lastAt && (!acc || item.lastAt > acc) ? item.lastAt : acc), null),
  };
}

// ---------------------------------------------------------------- 写锁

async function sleep(ms) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 拿写锁（桥接在采集、控制台在改标签、命令行在重建，三边都可能同时写）。
 * 抢不到就等一会儿；等不到就把锁当僵尸接管（进程崩了锁会留在盘上）。
 */
export async function acquireIndexLock(root, { timeoutMs = 5000, staleMs = LOCK_STALE_MS } = {}) {
  const file = lockFile(root);
  await fsp.mkdir(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fsp.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return {
        file,
        async release() {
          try {
            await fsp.rm(file, { force: true });
          } catch {
            /* 已经没了就算了 */
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let stat = null;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (Date.now() - stat.mtimeMs > staleMs) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) return null;
      await sleep(60);
    }
  }
}

/** 拿锁跑一段（拿不到就抛 REFLECT 风格的 STICKER_BUSY，让上层给 409/跳过） */
export async function withIndexLock(root, fn) {
  const lock = await acquireIndexLock(root);
  if (!lock) {
    const err = new Error('表情包库正忙（另一个进程在写索引），稍后再试');
    err.code = 'STICKER_BUSY';
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------- 写入 / 采集

/** 库内相对路径：<YYYY-MM>/<sha16><ext> */
export function relativePathFor(sha, ext, now = Date.now()) {
  const date = new Date(now);
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `${month}/${sha.slice(0, 16)}${ext}`;
}

/** 索引里按 sha 找（去重就靠它） */
export function findBySha(index, sha) {
  if (!sha) return null;
  return (index?.items ?? []).find((item) => item.sha256 === sha) ?? null;
}

export function findById(index, id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return (index?.items ?? []).find((item) => item.id === key) ?? null;
}

async function restoreMissingStickerFile(root, file, buffer) {
  if (path.isAbsolute(file) || path.win32.isAbsolute(file)) throw new Error('文件路径越界');
  const abs = resolveStickerFile(root, file);
  const parent = path.dirname(abs);
  let dir = path.resolve(root);
  for (const part of path.relative(dir, parent).split(path.sep).filter(Boolean)) {
    dir = path.join(dir, part);
    try {
      const info = await fsp.lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('表情包文件路径包含链接或非目录');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      break;
    }
  }
  try {
    const info = await fsp.lstat(abs);
    if (!info.isFile()) throw new Error('表情包文件路径不是普通文件');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    await fsp.mkdir(parent, { recursive: true });
    await fsp.writeFile(abs, buffer, { flag: 'wx' });
  }
}

/**
 * 把一张图收进库。
 * 同一张图（sha 相同）只更新计数、时间、标签；物理文件丢失时用本次内容恢复。
 * @param {{root:string, buffer:Buffer, source?:object, text?:string, summary?:string,
 *          tags?:string[], settings?:object, now?:number, force?:boolean}} input
 * @returns {Promise<{added:boolean, duplicate:boolean, item:object, reason?:string}>}
 */
export async function upsertSticker({
  root,
  buffer,
  source,
  text = '',
  summary = '',
  tags = [],
  settings,
  now = Date.now(),
  force = false,
}) {
  const cfg = settings ? normalizeStickerSettings(settings) : normalizeStickerSettings({});
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { added: false, duplicate: false, item: null, reason: '空文件' };
  }
  if (buffer.length < cfg.minBytes) return { added: false, duplicate: false, item: null, reason: '太小' };
  if (buffer.length > cfg.maxBytes) return { added: false, duplicate: false, item: null, reason: '太大' };
  const image = sniffImage(buffer);
  if (!image) return { added: false, duplicate: false, item: null, reason: '不是图片' };

  const sha = sha256(buffer);
  const stamp = new Date(now).toISOString();

  return withIndexLock(root, async () => {
    const index = await loadIndex(root);
    const existing = findBySha(index, sha);
    if (existing && !force) {
      await restoreMissingStickerFile(root, existing.file, buffer);
      existing.seen += 1;
      existing.lastAt = stamp;
      if (!existing.firstAt) existing.firstAt = stamp;
      if (!existing.text && text) existing.text = text.slice(0, 200);
      if (!existing.summary && summary) existing.summary = summary.slice(0, 60);
      if (source && !existing.source) existing.source = { ...source };
      existing.tags = uniqTags([...(existing.tags ?? []), ...tags]);
      await saveIndex(root, index);
      return { added: false, duplicate: true, item: existing };
    }

    const rel = relativePathFor(sha, image.ext, now);
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buffer);

    const item = {
      id: sha.slice(0, 16),
      sha256: sha,
      file: rel,
      bytes: buffer.length,
      width: image.width,
      height: image.height,
      mime: image.mime,
      animated: image.animated,
      firstAt: stamp,
      lastAt: stamp,
      seen: 1,
      tags: uniqTags([...(cfg.autoTag ? autoTagsFor({ source, text, summary, image, now }) : []), ...tags]),
      source: source ? { ...source } : null,
      text: String(text ?? '').slice(0, 200),
      summary: String(summary ?? '').slice(0, 60),
    };
    index.items.push(item);
    await saveIndex(root, index);
    return { added: true, duplicate: false, item };
  });
}

/** 手改标签：add 加、remove 删（按值删；加完自动排序） */
export async function updateTags(root, id, { add = [], remove = [] } = {}) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('要改哪一张？id 不能为空');
  return withIndexLock(root, async () => {
    const index = await loadIndex(root);
    const item = findById(index, key) ?? findBySha(index, key);
    if (!item) {
      const err = new Error(`库里没有这张：${key}`);
      err.code = 'STICKER_NOT_FOUND';
      throw err;
    }
    const drop = new Set(uniqTags(remove));
    const kept = (item.tags ?? []).filter((tag) => !drop.has(tag));
    item.tags = uniqTags([...kept, ...add]);
    await saveIndex(root, index);
    return item;
  });
}

/** 删掉一张（文件 + 索引），文件删失败只记警告，索引照样清 */
export async function deleteSticker(root, id) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('要删哪一张？id 不能为空');
  return withIndexLock(root, async () => {
    const index = await loadIndex(root);
    const item = findById(index, key) ?? findBySha(index, key);
    if (!item) {
      const err = new Error(`库里没有这张：${key}`);
      err.code = 'STICKER_NOT_FOUND';
      throw err;
    }
    index.items = index.items.filter((entry) => entry !== item);
    await saveIndex(root, index);
    let removedFile = false;
    try {
      await fsp.rm(path.join(root, item.file), { force: true });
      removedFile = true;
    } catch {
      /* 文件可能被别的程序占着，索引先清掉 */
    }
    return { item, removedFile };
  });
}

// ---------------------------------------------------------------- 索引重建

/** 递归列出 root 下所有图片（跳过 index.json / .lock / 隐藏文件） */
export async function scanImageFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile() && isImageFile(entry.name)) {
        out.push(childRel);
      }
    }
  }
  if (!fs.existsSync(root)) return out;
  await walk(root, '');
  return out.sort();
}

/**
 * 扫盘重建索引（控制台的「重建索引」、CLI 的 rebuild 都走这里）。
 * 旧索引里同 sha 的记录会把标签/来源/首见时间捞回来 —— 索引文件丢了也不至于把标签丢光。
 * @returns {Promise<{scanned:number, kept:number, added:number, dropped:number, index:object, stats:object}>}
 */
export async function rebuildIndex(root, { settings, now = Date.now() } = {}) {
  const cfg = settings ? normalizeStickerSettings(settings) : normalizeStickerSettings({});
  return withIndexLock(root, async () => {
    const previous = await loadIndex(root);
    const bySha = new Map();
    for (const item of previous.items) {
      if (item.sha256) bySha.set(item.sha256, item);
    }

    const files = await scanImageFiles(root);
    const items = [];
    let kept = 0;
    let added = 0;
    for (const rel of files) {
      const abs = path.join(root, rel);
      let buffer;
      try {
        buffer = await fsp.readFile(abs);
      } catch {
        continue;
      }
      if (buffer.length < cfg.minBytes) continue;
      const image = sniffImage(buffer);
      if (!image) continue;
      const sha = sha256(buffer);
      const old = bySha.get(sha);
      const stamp = new Date(now).toISOString();
      if (old) {
        kept += 1;
        old.file = rel;
        old.bytes = buffer.length;
        old.width = image.width;
        old.height = image.height;
        old.mime = image.mime;
        old.animated = image.animated;
        old.tags = uniqTags(old.tags);
        items.push(old);
      } else {
        added += 1;
        items.push({
          id: sha.slice(0, 16),
          sha256: sha,
          file: rel,
          bytes: buffer.length,
          width: image.width,
          height: image.height,
          mime: image.mime,
          animated: image.animated,
          firstAt: stamp,
          lastAt: stamp,
          seen: 1,
          tags: cfg.autoTag ? autoTagsFor({ image, now }) : [],
          source: null,
          text: '',
          summary: '',
        });
      }
    }

    const index = { version: INDEX_VERSION, root: String(root ?? ''), updatedAt: null, items };
    const saved = await saveIndex(root, index);
    return {
      scanned: files.length,
      kept,
      added,
      dropped: Math.max(0, previous.items.length - kept),
      index: saved,
      stats: storeStats(saved),
    };
  });
}

/** 页面用：没有索引就先建一个（扫盘），有就直接读 */
export async function ensureIndex(root, { settings } = {}) {
  const file = indexFile(root);
  if (!fs.existsSync(file)) {
    const result = await rebuildIndex(root, { settings });
    return result.index;
  }
  return loadIndex(root);
}

// ---------------------------------------------------------------- 查询

/** 按标签/关键词挑图（tag 必须完全命中；query 模糊匹配标签、文字、发送者） */
export function listStickers(index, { tag = '', query = '', limit = 200, offset = 0 } = {}) {
  const tagWant = normalizeTag(tag);
  const q = String(query ?? '').trim().toLowerCase();
  let items = index?.items ?? [];
  if (tagWant) items = items.filter((item) => (item.tags ?? []).includes(tagWant));
  if (q) {
    items = items.filter((item) => {
      const haystack = [
        item.file,
        item.text,
        item.summary,
        item.source?.nickname,
        item.source?.groupId,
        ...(item.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }
  const sorted = [...items].sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const size = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 200)));
  return { total: sorted.length, items: sorted.slice(start, start + size) };
}

/** 随机挑一张（DSH 想发表情包时用） */
export function pickSticker(index, { tag = '', query = '', seed = Math.random } = {}) {
  const { items } = listStickers(index, { tag, query, limit: 1000 });
  if (items.length === 0) return null;
  const i = Math.min(items.length - 1, Math.floor(seed() * items.length));
  return items[i];
}

/** 路径安全：只允许库内的图片相对路径（防 ../ 和绝对路径） */
export function resolveStickerFile(root, rel) {
  const raw = String(rel ?? '').trim();
  if (!raw) throw new Error('缺少文件路径');
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, raw.replace(/^[\\/]+/, ''));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error('文件路径越界');
  }
  if (!isImageFile(abs)) throw new Error('只能读图片文件');
  return abs;
}

// ---------------------------------------------------------------- 迁移

/**
 * 把整个库搬到新目录（复制，不删旧的 —— 确认没问题再自己删）。
 * 校验方式：复制完按大小+sha 复核，任何一张对不上就整体报错，不写索引。
 * @returns {Promise<{from:string,to:string,copied:number,bytes:number,items:number}>}
 */
export async function migrateStore({ fromRoot, toRoot, onProgress = () => {} }) {
  const from = path.resolve(String(fromRoot ?? ''));
  const to = path.resolve(String(toRoot ?? ''));
  if (!fromRoot || !toRoot) throw new Error('迁移需要源目录和目标目录');
  if (from === to) throw new Error('目标就是当前目录，不用迁移');
  if (to.startsWith(from + path.sep)) throw new Error('不能把库搬到它自己的子目录里');
  if (!fs.existsSync(from)) throw new Error(`源目录不存在：${from}`);

  const files = await scanImageFiles(from);
  await fsp.mkdir(to, { recursive: true });

  let copied = 0;
  let bytes = 0;
  for (const rel of files) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const buffer = await fsp.readFile(src);
    await fsp.writeFile(dest, buffer);
    // 复核：字节数 + sha 都对上才算这一张搬成功
    const check = await fsp.readFile(dest);
    if (check.length !== buffer.length || sha256(check) !== sha256(buffer)) {
      throw new Error(`迁移校验失败：${rel}`);
    }
    copied += 1;
    bytes += buffer.length;
    onProgress({ copied, total: files.length, file: rel });
  }

  // 索引跟着搬：把 root 改成新目录，items 里的相对路径不变
  const index = await loadIndex(from);
  const saved = await saveIndex(to, { ...index, root: to });
  return { from, to, copied, bytes, items: saved.items.length };
}

// ---------------------------------------------------------------- 从消息里采集

function stickerSubType(data) {
  const value = data?.sub_type ?? data?.subType;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function marketEmojiId(data) {
  return typeof data?.emoji_id === 'string' && /^[a-f0-9]{32}$/i.test(data.emoji_id.trim())
    ? data.emoji_id.trim()
    : '';
}

function hasMarketEmojiMetadata(data) {
  const packageId = data?.emoji_package_id;
  const validPackage = (typeof packageId === 'number' && Number.isInteger(packageId) && packageId > 0) ||
    (typeof packageId === 'string' && /^\d+$/.test(packageId.trim()) && Number(packageId) > 0);
  return Boolean(marketEmojiId(data) && validPackage);
}

/**
 * NapCat 的 KCUSTOM=1 是 QQ 自定义表情；商城表情接收时也可能转换成 image。
 * 不根据摘要、后缀、尺寸或动图猜测，缺少明确元数据的图片留给手动导入。
 */
export function isQQStickerSegment(segment) {
  if (!segment || !segment.data || typeof segment.data !== 'object' || Array.isArray(segment.data)) return false;
  if (segment.type === 'mface') return true;
  return segment.type === 'image' &&
    (stickerSubType(segment.data) === 1 || hasMarketEmojiMetadata(segment.data));
}

/** 挑出图片和商城表情段，保留是否为 QQ 表情的元数据（不在这里下载）。 */
export function extractImageSegments(raw) {
  const message = Array.isArray(raw?.message) ? raw.message : [];
  const out = [];
  for (const segment of message) {
    if (!segment || !['image', 'mface'].includes(segment.type)) continue;
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
    const isSticker = isQQStickerSegment(segment);
    const emojiId = marketEmojiId(data);
    // 与 NapCat marketFaceElement 使用相同的 QQ 官方资源地址。
    const marketUrl = isSticker && emojiId
      ? `https://gxh.vip.qq.com/club/item/parcel/item/${emojiId.slice(0, 2)}/${emojiId}/raw300.gif`
      : '';
    out.push({
      url: typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url : marketUrl,
      file: typeof data.file === 'string' ? data.file : '',
      summary: typeof data.summary === 'string' ? data.summary : '',
      subType: stickerSubType(data),
      isSticker,
    });
  }
  return out;
}

/** 把一段图片描述换成 Buffer：优先 url 下载，其次本地文件，最后 base64 */
export async function readSegmentBuffer(segment, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (segment?.url) {
    if (typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch');
    const res = await fetchImpl(segment.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const file = String(segment?.file ?? '');
  if (file.startsWith('base64://')) return Buffer.from(file.slice('base64://'.length), 'base64');
  if (file && path.isAbsolute(file) && fs.existsSync(file)) return fsp.readFile(file);
  throw new Error('这个图片段没有可用的来源（只有文件名，没有 url）');
}

/** 发言人显示名：群名片 > 昵称 > 归一化消息里带的 nickname */
function nicknameOf(msg) {
  const sender = msg?.raw?.sender ?? {};
  for (const value of [sender.card, sender.nickname, msg?.nickname]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 采集一条消息里的表情包。
 * 抽成纯函数（fetch 可注入、根目录可传）是为了能单测，桥接里只负责调它。
 * @returns {Promise<{added:number, duplicate:number, skipped:number, items:object[], reasons:string[]}>}
 */
export async function collectFromMessage({
  root,
  msg,
  settings,
  fetchImpl,
  now = Date.now(),
  source: sourceOverride,
  text: textOverride,
} = {}) {
  const cfg = normalizeStickerSettings(settings ?? {});
  const result = { added: 0, duplicate: 0, skipped: 0, items: [], reasons: [] };
  if (!cfg.enabled || !cfg.autoCollect) return result;

  const segments = extractImageSegments(msg?.raw).filter((segment) => segment.isSticker).slice(0, cfg.maxPerMessage);
  if (segments.length === 0) return result;

  const source = sourceOverride ?? {
    kind: msg?.messageType === 'group' ? 'group' : 'private',
    groupId: msg?.groupId ? String(msg.groupId) : '',
    userId: msg?.userId ? String(msg.userId) : '',
    // 桥接归一化后的消息不带 nickname（在 raw.sender 里），两条路都认
    nickname: nicknameOf(msg),
  };
  const text = typeof textOverride === 'string' ? textOverride : typeof msg?.text === 'string' ? msg.text : '';

  for (const segment of segments) {
    let buffer;
    try {
      buffer = await readSegmentBuffer(segment, { fetchImpl });
    } catch (err) {
      result.skipped += 1;
      result.reasons.push(err?.message ?? String(err));
      continue;
    }
    try {
      const out = await upsertSticker({
        root,
        buffer,
        source,
        text,
        summary: segment.summary,
        settings: cfg,
        now,
      });
      if (out.added) result.added += 1;
      else if (out.duplicate) result.duplicate += 1;
      else {
        result.skipped += 1;
        result.reasons.push(out.reason ?? '未收');
      }
      if (out.item) result.items.push(out.item);
    } catch (err) {
      result.skipped += 1;
      result.reasons.push(err?.message ?? String(err));
    }
  }
  return result;
}

/**
 * 桥接用的采集器：串行队列 + 每分钟上限，保证刷图不会把桥接拖住。
 * 返回 { push(msg, opts) }，push 是同步的（内部排队），永远不会把异常抛给调用方。
 */
/**
 * 桥接用的采集器：串行队列 + 每分钟上限，刷图不会把桥接拖住。
 * 返回 { push, flush, stats }，push 永远不抛异常。
 *
 * target 可选：返回「当前应该写到哪个目录 / 用哪套设置」的函数。
 * 传了它，控制台改目录/迁移后桥接不用重启就能跟着换地方（每张图前现问一次）。
 */
export function createStickerCollector({
  root,
  config,
  log,
  settings,
  fetchImpl,
  now = () => Date.now(),
  target,
} = {}) {
  const baseSettings = normalizeStickerSettings(settings ?? config?.stickers ?? {});
  let tail = Promise.resolve();
  let windowStart = 0;
  let windowCount = 0;

  const stats = { added: 0, duplicate: 0, skipped: 0, lastAt: null, lastError: null };

  /** 现在写哪儿、用哪套设置 */
  function current() {
    if (typeof target === 'function') {
      try {
        const next = target();
        if (next?.root) {
          return { root: next.root, settings: normalizeStickerSettings(next.settings ?? baseSettings) };
        }
      } catch {
        /* 现问失败就退回启动时那套 */
      }
    }
    return { root, settings: baseSettings };
  }

  function allow(limit) {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      windowCount = 0;
    }
    if (windowCount >= limit) return false;
    windowCount += 1;
    return true;
  }

  function push(msg) {
    const cur = current();
    if (!cur.settings.enabled || !cur.settings.autoCollect) return Promise.resolve(null);
    if (!extractImageSegments(msg?.raw).some((segment) => segment.isSticker)) return Promise.resolve(null);
    if (!allow(cur.settings.perMinute)) {
      stats.skipped += 1;
      log?.debug?.('表情包采集已达每分钟上限，跳过');
      return Promise.resolve(null);
    }
    tail = tail
      .then(() =>
        collectFromMessage({ root: cur.root, msg, settings: cur.settings, fetchImpl, now: now() }).then((result) => {
          stats.added += result.added;
          stats.duplicate += result.duplicate;
          stats.skipped += result.skipped;
          stats.lastAt = new Date().toISOString();
          if (result.added > 0) log?.info?.(`收到 ${result.added} 张表情包（已打标签入库）`);
          return result;
        }),
      )
      .catch((err) => {
        stats.skipped += 1;
        stats.lastError = String(err?.message ?? err);
        log?.debug?.('采集表情包失败：', err?.message ?? err);
        return null;
      });
    return tail;
  }

  /** 等手上正在收的那张写完（退出前调一下，别留半张图） */
  function flush() {
    return tail.catch(() => null);
  }

  return { push, flush, stats, root, settings: baseSettings };
}
