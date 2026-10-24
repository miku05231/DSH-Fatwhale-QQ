// src/security.js —— 白名单 / 群消息准入 / 滑动窗口限流 / 文本清洗（零依赖）
//
// 安全默认：security.allowFrom 为空数组时拒绝一切消息，绝不默认放行。
//
// checkGroupAllowed 的 @ 判定顺序（self_id 不在归一化消息里，由调用方补齐）：
//   1. msg.atSelf === true（或别名 atBot / mentionedSelf / mentionsBot）
//   2. 用机器人 QQ 号（msg.selfId / msg.self_id / msg.raw.self_id / cfg.selfId /
//      cfg.onebot.selfId ...）精确匹配 raw 里的 at 片段
//   3. 两者都拿不到 → 返回 false（保守拒绝，避免“谁被 @ 都触发”）

/** 从配置里取 QQ 号白名单：既接受整个 config，也接受 config.security */
function allowListOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.allowFrom)) return cfg.allowFrom;
  if (cfg.security && Array.isArray(cfg.security.allowFrom)) return cfg.security.allowFrom;
  return [];
}

function allowGroupsOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.allowGroups === 'boolean') return cfg.allowGroups;
  if (cfg.security && typeof cfg.security.allowGroups === 'boolean') return cfg.security.allowGroups;
  return false;
}

/**
 * 群号白名单。
 * 非空时：只有这些群里的消息才可能被受理（仍要求 @ 机器人）。
 * 为空时：退回 allowGroups 布尔开关，任何群都按开关判断。
 */
function allowGroupIdsOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.allowGroupIds)) return cfg.allowGroupIds;
  if (cfg.security && Array.isArray(cfg.security.allowGroupIds)) return cfg.security.allowGroupIds;
  return [];
}

/** 私聊黑名单 security.denyFrom（永远优先于白名单） */
function denyListOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.denyFrom)) return cfg.denyFrom;
  if (cfg.security && Array.isArray(cfg.security.denyFrom)) return cfg.security.denyFrom;
  return [];
}

/** 群黑名单 security.denyGroupIds（永远优先于 allowGroupIds / allowGroups） */
function denyGroupIdsOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.denyGroupIds)) return cfg.denyGroupIds;
  if (cfg.security && Array.isArray(cfg.security.denyGroupIds)) return cfg.security.denyGroupIds;
  return [];
}

/**
 * 私聊准入策略（只影响私聊，群聊有自己的 allowGroupIds / denyGroupIds）：
 *   allowlist（默认）—— 只有 allowFrom 里的号能聊；allowFrom 为空 = 拒绝一切，安全默认
 *   blacklist        —— 除了 denyFrom 里的号，谁都能聊
 */
export function privatePolicyOf(cfg) {
  const value = cfg?.security?.privatePolicy ?? cfg?.privatePolicy;
  return value === 'blacklist' ? 'blacklist' : 'allowlist';
}

/** 数字/字符串混写都兼容的「名单里有没有」 */
function inList(list, value) {
  if (value === undefined || value === null) return false;
  const id = String(value).trim();
  if (id === '') return false;
  for (const entry of list) {
    if (entry === undefined || entry === null) continue;
    if (String(entry).trim() === id) return true;
  }
  return false;
}

/** 这个 QQ 号是否在私聊黑名单里 */
export function isUserBlocked(userId, cfg) {
  return inList(denyListOf(cfg), userId);
}

/** 聊天白名单、群头衔、消息正文都不能授予电脑权限。 */
export function isAdministrator(userId, cfg) {
  const list = cfg?.security?.adminUserIds ?? cfg?.adminUserIds;
  return Array.isArray(list) && !isUserBlocked(userId, cfg) && inList(list, userId);
}

/** 这个群是否在群黑名单里 */
export function isGroupBlocked(groupId, cfg) {
  return inList(denyGroupIdsOf(cfg), groupId);
}

/**
 * 这个群是不是「我们被允许在场的群」。
 * 与 checkGroupAllowed 的区别：只看群号，不要求 @ 机器人。
 * 用来决定要不要把群消息写进群记忆 —— 没授权的群连记录都不该留。
 */
export function isGroupWatched(groupId, cfg) {
  const id = groupId === undefined || groupId === null ? '' : String(groupId);
  if (!id) return false;
  if (isGroupBlocked(id, cfg)) return false; // 黑名单永远先行，连记录都不记
  const groupIds = allowGroupIdsOf(cfg);
  if (groupIds.length > 0) return groupIds.some((g) => String(g) === id);
  return Boolean(cfg?.security?.allowGroups ?? cfg?.allowGroups);
}

function firstValue(...candidates) {  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value) !== '') return String(value);
  }
  return null;
}

function looksLikeGroup(msg) {
  if (msg.messageType === 'group') return true;
  // 兼容只给了 groupId、没写 messageType 的调用方
  return msg.messageType === undefined && msg.groupId !== undefined && msg.groupId !== null;
}

/** 收集消息里所有 at 的 QQ 号（数组片段 + CQ 码字符串都要认） */
function collectAtIds(msg) {
  const ids = [];
  const segmentCandidates = [msg.raw?.message, msg.raw?.data?.message, msg.message];
  for (const candidate of segmentCandidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    for (const segment of candidate) {
      if (segment && segment.type === 'at' && segment.data && segment.data.qq !== undefined && segment.data.qq !== null) {
        ids.push(String(segment.data.qq));
      }
    }
    break; // 只取第一个可用的片段数组
  }
  const stringCandidates = [
    msg.raw?.message,
    msg.raw?.raw_message,
    msg.raw_message,
    msg.raw?.data?.message,
    msg.text,
  ];
  for (const candidate of stringCandidates) {
    if (typeof candidate !== 'string') continue;
    for (const match of candidate.matchAll(/\[CQ:at,qq=([^,\]]+)/g)) ids.push(String(match[1]).trim());
  }
  return ids;
}

/** 判断这条消息是否 @ 了机器人（对外导出，编排层判断「算不算在跟它说话」要用） */
export function isAtSelf(msg, cfg) {
  if (msg.atSelf === true || msg.atBot === true || msg.mentionedSelf === true || msg.mentionsBot === true) {
    return true;
  }
  const selfId = firstValue(
    msg.selfId,
    msg.self_id,
    msg.botId,
    msg.raw?.self_id,
    msg.raw?.selfId,
    cfg?.selfId,
    cfg?.self_id,
    cfg?.onebot?.selfId,
    cfg?.onebot?.self_id,
    cfg?.security?.selfId,
  );
  if (selfId === null) return false; // 无法确定机器人 QQ 号 → 保守拒绝
  return collectAtIds(msg).some((id) => id === selfId);
}

/**
 * 该 QQ 号是否允许私聊。
 *
 * 判定顺序（黑名单永远最高优先级）：
 *   1. denyFrom 命中 → false
 *   2. privatePolicy = blacklist → true（除黑名单外都能聊）
 *   3. privatePolicy = allowlist（默认）→ allowFrom 命中才 true；allowFrom 为空 = 拒绝一切
 *
 * @param {number|string} userId QQ 号
 * @param {object} cfg 整个 config（也接受 config.security）
 * @param {{isGroup?: boolean}} [options] 群成员准入始终检查白名单，不应用私聊策略
 * @returns {boolean}
 */
export function isAllowed(userId, cfg, { isGroup = false } = {}) {
  if (userId === undefined || userId === null) return false;
  const id = String(userId).trim();
  if (id === '') return false;
  if (isUserBlocked(id, cfg)) return false;
  if (!isGroup && privatePolicyOf(cfg) === 'blacklist') return true;
  const list = allowListOf(cfg);
  if (list.length === 0) return false; // 安全默认：空名单 = 拒绝一切
  return inList(list, id);
}

/**
 * 群消息是否准入：allowGroups=true 且 @ 了机器人。
 * 只检查“群开关 + @”，成员白名单请调用 isAllowed(msg.userId, cfg, { isGroup: true })。
 * @param {object} msg 归一化消息
 * @param {object} cfg 整个 config
 * @returns {boolean}
 */
export function checkGroupAllowed(msg, cfg) {
  if (!msg || typeof msg !== 'object') return false;
  if (!looksLikeGroup(msg)) return false;

  // 黑名单先行：哪怕群号在白名单里，被拉黑也不受理
  const rawGroupId = firstValue(msg.groupId, msg.group_id, msg.raw?.group_id, msg.raw?.data?.group_id);
  if (rawGroupId !== null && isGroupBlocked(rawGroupId, cfg)) return false;

  const groupIds = allowGroupIdsOf(cfg);
  if (groupIds.length > 0) {
    // 配了群号白名单：只认这些群（比 allowGroups 布尔开关更精确）
    const groupId = firstValue(msg.groupId, msg.group_id, msg.raw?.group_id, msg.raw?.data?.group_id);
    if (groupId === null) return false;
    const hit = groupIds.some((entry) => entry !== undefined && entry !== null && String(entry).trim() === groupId);
    if (!hit) return false;
  } else if (!allowGroupsOf(cfg)) {
    return false;
  }

  return isAtSelf(msg, cfg);
}

/**
 * 滑动窗口限流器（内存里存时间戳数组）。
 * perMinute <= 0 或非法值 → 不限流，take() 永远返回 true。
 */
export class RateLimiter {
  constructor({ perMinute = 0 } = {}) {
    const value = Number(perMinute);
    this.perMinute = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    this.windowMs = 60_000;
    this.nextCleanupAt = 0;
    /** @type {Map<string, number[]>} key → 窗口内的请求时间戳 */
    this.hits = new Map();
  }

  /**
   * 记一次请求；是否放行。
   * @param {string|number} key 限流维度（一般用 QQ 号）
   * @returns {boolean} true=放行，false=超限
   */
  take(key) {
    if (this.perMinute <= 0) return true;
    const now = Date.now();
    // 每个窗口清理一次不再发言的用户，保留活跃用户的限流额度。
    if (now >= this.nextCleanupAt) {
      for (const [k, stamps] of this.hits) {
        if (!stamps.length || now - stamps.at(-1) >= this.windowMs) this.hits.delete(k);
      }
      this.nextCleanupAt = now + this.windowMs;
    }
    const mapKey = String(key ?? '');
    let stamps = this.hits.get(mapKey);
    if (!stamps) {
      stamps = [];
      this.hits.set(mapKey, stamps);
    }
    // 丢掉滑出窗口的时间戳
    let expired = 0;
    while (expired < stamps.length && now - stamps[expired] >= this.windowMs) expired += 1;
    if (expired > 0) stamps.splice(0, expired);
    if (stamps.length >= this.perMinute) return false;
    stamps.push(now);
    return true;
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// 只去零宽空格 / 词连接符 / BOM；保留 ZWJ(200D)、ZWNJ(200C)，否则组合 emoji 会被拆散
const INVISIBLE_CHARS = /[\u200B\u2060\uFEFF]/g;

/**
 * 清洗要发给 QQ 的文本：去控制字符、统一换行、去首尾空白、按 maxChars 截断。
 * maxChars 非正数或非法 → 不截断。
 * @param {string} text 原始文本
 * @param {number} [maxChars] 最大字符数（按 UTF-16 码元计，且不会切断代理对）
 * @returns {string}
 */
export function sanitizeText(text, maxChars) {
  if (text === undefined || text === null) return '';
  let value = typeof text === 'string' ? text : String(text);
  if (value === '') return '';
  value = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (limit > 0 && value.length > limit) {
    value = value.slice(0, limit);
    // 不要把一个 emoji（代理对）劈成两半
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  }
  return value;
}
