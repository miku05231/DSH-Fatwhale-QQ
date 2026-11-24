/**
 * src/keywords.js —— 关键词自动回复（零依赖）
 *
 * 在控制台配好「关键词 → 固定回复 / 图片」，群友或私聊命中就直接回，
 * 不排队、不调模型、不碰电脑。规则存在 state/keywords.json，
 * 桥接按文件修改时间热加载，控制台保存后下一条消息就生效。
 *
 * 规则字段：
 *   id               稳定 id（控制台生成）
 *   enabled          默认 true
 *   keywords         触发词列表（至少一个）
 *   match            exact 整句相同 | contains 包含 | regex 正则
 *   reply            回复文本（与 image 至少有一个）
 *   image            图片：http(s) 地址，或本机图片文件的绝对路径
 *   scope            all | group | private
 *   groupIds         只在这些群生效；空 = 所有已授权的群
 *   cooldownSeconds  同一会话里同一条规则的冷却，默认 30 秒，0 不冷却
 */

import fs from 'node:fs';
import path from 'node:path';

export const MATCH_MODES = Object.freeze(['exact', 'contains', 'regex']);
export const SCOPES = Object.freeze(['all', 'group', 'private']);
export const MAX_RULES = 200;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LEN = 100;
const MAX_REGEX_LEN = 200;
const MAX_REPLY_LEN = 2000;
const MAX_TEXT_TO_MATCH = 500;
const DEFAULT_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 86_400;
const MAX_TRACKED_HITS = 5000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : str(value).split(/[\s,，]+/);
  return [...new Set(list.map((v) => str(v).trim()).filter((v) => /^\d{4,12}$/.test(v)))];
}

function normalizeImage(raw) {
  const image = str(raw).trim();
  if (!image) return '';
  if (/^https?:\/\//i.test(image)) {
    try {
      return new URL(image).href;
    } catch {
      throw new RuleError(`图片地址不合法：${image}`);
    }
  }
  if (!path.isAbsolute(image)) throw new RuleError('图片要填 http(s) 地址或本机文件的绝对路径');
  if (!IMAGE_EXT.test(image)) throw new RuleError('只支持 png / jpg / gif / webp / bmp 图片');
  return path.normalize(image);
}

function normalizeKeywords(raw, match, label) {
  const keywords = [...new Set((Array.isArray(raw) ? raw : [raw])
    .map((k) => str(k).trim()).filter(Boolean))];
  if (!keywords.length) throw new RuleError(`${label}至少要有一个关键词`);
  if (keywords.length > MAX_KEYWORDS) throw new RuleError(`${label}关键词最多 ${MAX_KEYWORDS} 个`);
  const limit = match === 'regex' ? MAX_REGEX_LEN : MAX_KEYWORD_LEN;
  for (const k of keywords) {
    if (k.length > limit) throw new RuleError(`${label}的关键词太长（最多 ${limit} 字）`);
    if (match !== 'regex') continue;
    try {
      new RegExp(k, 'iu');
    } catch (err) {
      throw new RuleError(`${label}的正则写错了：${err.message}`);
    }
  }
  return keywords;
}

/**
 * 校验并规范化一条规则；不合法时抛带 statusCode=400 的错误。
 * @param {object} raw
 * @param {number} index 在列表里的位置（报错提示用）
 */
export function normalizeRule(raw, index = 0) {
  const label = `第 ${index + 1} 条规则`;
  if (!raw || typeof raw !== 'object') throw new RuleError(`${label}格式不对`);
  const match = MATCH_MODES.includes(raw.match) ? raw.match : 'contains';
  const keywords = normalizeKeywords(raw.keywords, match, label);
  const reply = str(raw.reply).trim();
  if (reply.length > MAX_REPLY_LEN) throw new RuleError(`${label}的回复太长（最多 ${MAX_REPLY_LEN} 字）`);
  const image = normalizeImage(raw.image);
  if (!reply && !image) throw new RuleError(`${label}要填回复文本或图片`);
  const cooldown = Math.trunc(Number(raw.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS));
  const id = str(raw.id).trim().replace(/[^\w-]/g, '').slice(0, 40) || `kw-${Date.now().toString(36)}-${index}`;
  return {
    id,
    enabled: raw.enabled !== false,
    keywords,
    match,
    reply,
    image,
    scope: SCOPES.includes(raw.scope) ? raw.scope : 'all',
    groupIds: normalizeIdList(raw.groupIds),
    cooldownSeconds: Number.isFinite(cooldown)
      ? Math.min(MAX_COOLDOWN_SECONDS, Math.max(0, cooldown))
      : DEFAULT_COOLDOWN_SECONDS,
  };
}

/** 校验整份规则列表；id 重复时后面的自动改名 */
export function normalizeRules(list) {
  if (!Array.isArray(list)) throw new RuleError('rules 必须是数组');
  if (list.length > MAX_RULES) throw new RuleError(`规则最多 ${MAX_RULES} 条`);
  const seen = new Set();
  return list.map((raw, i) => {
    const rule = normalizeRule(raw, i);
    const id = seen.has(rule.id) ? `${rule.id}-${i}` : rule.id;
    seen.add(id);
    return { ...rule, id };
  });
}

function ruleMatches(rule, text) {
  if (rule.match === 'exact') return rule.keywords.some((k) => text === k);
  if (rule.match === 'contains') return rule.keywords.some((k) => text.includes(k));
  return rule.keywords.some((k) => {
    try {
      return new RegExp(k, 'iu').test(text);
    } catch {
      return false;
    }
  });
}

/**
 * 找第一条命中的规则（不处理冷却）。
 * @param {Array} rules 已规范化的规则
 * @param {string} text 消息正文
 * @param {{isGroup: boolean, groupId?: number|string}} ctx
 */
export function findKeywordRule(rules, text, { isGroup, groupId } = {}) {
  const body = str(text).trim();
  if (!body || body.length > MAX_TEXT_TO_MATCH) return null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.enabled) continue;
    if (rule.scope === 'group' && !isGroup) continue;
    if (rule.scope === 'private' && isGroup) continue;
    if (isGroup && rule.groupIds?.length && !rule.groupIds.includes(String(groupId))) continue;
    if (ruleMatches(rule, body)) return rule;
  }
  return null;
}

/** 把规则变成 OneBot 消息段（纯文本段，不解析 CQ 码，避免注入） */
export function keywordMessage(rule, { toFileUrl } = {}) {
  const segments = [];
  if (rule.reply) segments.push({ type: 'text', data: { text: rule.reply } });
  if (rule.image) {
    const isUrl = /^https?:\/\//i.test(rule.image);
    segments.push({ type: 'image', data: { file: isUrl || !toFileUrl ? rule.image : toFileUrl(rule.image) } });
  }
  return segments;
}

async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  await fs.promises.rename(tmp, file);
}

/**
 * 规则文件读写 + 冷却。桥接和控制台各自 new 一个，共用同一份文件。
 */
export class KeywordStore {
  constructor({ file, log, now = () => Date.now() } = {}) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.cache = { mtimeMs: -1, rules: [] };
    this.lastHit = new Map();
  }

  /** 同步读，按 mtime 缓存；文件坏了就当没有规则，绝不影响收发 */
  rules() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.cache = { mtimeMs: -1, rules: [] };
      return [];
    }
    if (stat.mtimeMs === this.cache.mtimeMs) return this.cache.rules;
    let rules = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      rules = normalizeRules(Array.isArray(parsed) ? parsed : parsed?.rules ?? []);
    } catch (err) {
      this.log?.warn?.(`关键词规则文件读不了，暂时全部停用：${err?.message ?? err}`);
    }
    this.cache = { mtimeMs: stat.mtimeMs, rules };
    return rules;
  }

  async save(list) {
    const rules = normalizeRules(list);
    await writeAtomic(this.file, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
    this.cache = { mtimeMs: -1, rules: [] };
    return rules;
  }

  /**
   * 命中且不在冷却里时返回规则，并记下这次命中。
   * @param {string} text
   * @param {{isGroup: boolean, groupId?: number|string, chatKey: string}} ctx
   */
  take(text, ctx) {
    const rule = findKeywordRule(this.rules(), text, ctx);
    if (!rule) return null;
    const key = `${rule.id}|${ctx.chatKey}`;
    const at = this.now();
    const last = this.lastHit.get(key);
    if (last != null && rule.cooldownSeconds > 0 && at - last < rule.cooldownSeconds * 1000) return null;
    this.lastHit.delete(key);
    this.lastHit.set(key, at);
    if (this.lastHit.size > MAX_TRACKED_HITS) this.lastHit.delete(this.lastHit.keys().next().value);
    return rule;
  }
}
