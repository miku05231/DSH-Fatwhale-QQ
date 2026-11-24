/**
 * src/stats.js —— 运行统计（零依赖）
 *
 * 为什么单独做一份统计：控制台原来的「今日消息」是从群聊记忆 JSONL 里数的，
 * 私聊不算、每群有条数上限会被裁剪、没唤醒它的群消息也算进去，数字既偏大又偏小。
 * 这里只记桥接自己真正经手的事：
 *
 *   received   通过准入、真的要交给模型的请求（私聊 + 群聊）
 *   replied    成功把回复发出去
 *   failed     模型调用失败 / 出错
 *   latency    从出队到回复发出的耗时
 *   speakers   已授权群里每个人的发言条数（给 /排行 用，不论是否唤醒它）
 *   chats      每个会话（g:群号 / p:QQ号）最后活跃时间和名字（给会话管理页用）
 *
 * 按「本地日期」分桶，存 <stateDir>/stats.json，默认保留 30 天。
 * 写盘：防抖 + 临时文件 + rename。任何异常只记 debug，绝不影响收发。
 */

import fs from 'node:fs';
import path from 'node:path';

export const STATS_VERSION = 1;
const DEFAULT_RETAIN_DAYS = 30;
const DEFAULT_FLUSH_MS = 5000;
/** 单日单个映射的上限，防止被刷爆（超出后新键不再记录，老键继续累加） */
const MAX_GROUPS = 500;
const MAX_USERS = 5000;
const MAX_SPEAKERS_PER_GROUP = 2000;
const MAX_NAME = 32;
const MAX_CHATS = 2000;

/** 本地日期键：YYYY-MM-DD */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyDay(date) {
  return {
    date,
    received: 0,
    privateIn: 0,
    groupIn: 0,
    replied: 0,
    failed: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyMax: 0,
    hours: new Array(24).fill(0),
    groups: {},
    users: {},
    speakers: {},
    names: {},
  };
}

/** 读进来的数据可能是旧版/坏的，逐字段收敛成安全形状 */
function normalizeDay(date, raw) {
  const day = emptyDay(date);
  if (!raw || typeof raw !== 'object') return day;
  for (const key of ['received', 'privateIn', 'groupIn', 'replied', 'failed', 'latencySum', 'latencyCount', 'latencyMax']) {
    const n = Number(raw[key]);
    day[key] = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  if (Array.isArray(raw.hours)) {
    for (let i = 0; i < 24; i++) {
      const n = Number(raw.hours[i]);
      day.hours[i] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  for (const key of ['groups', 'users', 'names']) {
    if (raw[key] && typeof raw[key] === 'object') day[key] = { ...raw[key] };
  }
  if (raw.speakers && typeof raw.speakers === 'object') {
    for (const [gid, map] of Object.entries(raw.speakers)) {
      if (map && typeof map === 'object') day.speakers[gid] = { ...map };
    }
  }
  return day;
}

function bump(map, key, limit, by = 1) {
  if (Object.hasOwn(map, key)) {
    map[key] = (Number(map[key]) || 0) + by;
    return;
  }
  if (Object.keys(map).length >= limit) return;
  map[key] = by;
}

function cleanName(name) {
  return String(name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME);
}

/** 读进来的 chats 映射收敛成 { key: { lastAt, name } } */
function normalizeChats(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const lastAt = Number(value?.lastAt);
    if (!/^[gp]:\d{1,20}$/.test(key) || !Number.isFinite(lastAt) || lastAt <= 0) continue;
    out[key] = { lastAt, name: cleanName(value?.name) };
  }
  return out;
}

function topEntries(map, limit) {
  return Object.entries(map ?? {})
    .map(([id, count]) => ({ id, count: Number(count) || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * 纯函数：把 stats.json 的内容整理成控制台要的摘要。
 * 桥接进程和控制台进程都用它，保证两边口径一致。
 * @param {{days?: Record<string, object>}} data
 * @param {{days?: number, now?: number, top?: number}} [opts]
 */
export function summarizeStats(data, { days = 7, now = Date.now(), top = 5 } = {}) {
  const span = Math.min(90, Math.max(1, Math.trunc(Number(days)) || 7));
  const stored = data && typeof data.days === 'object' && data.days ? data.days : {};
  const series = [];
  const base = new Date(now);
  base.setHours(12, 0, 0, 0); // 取中午，跨夏令时也不会算错日期
  for (let i = span - 1; i >= 0; i--) {
    const date = dayKey(base.getTime() - i * 86_400_000);
    const day = normalizeDay(date, stored[date]);
    series.push({
      date,
      received: day.received,
      replied: day.replied,
      failed: day.failed,
      privateIn: day.privateIn,
      groupIn: day.groupIn,
      avgLatencyMs: day.latencyCount ? Math.round(day.latencySum / day.latencyCount) : 0,
    });
  }
  const todayKey = dayKey(now);
  const today = normalizeDay(todayKey, stored[todayKey]);
  const done = today.replied + today.failed;
  const nameOf = (id) => cleanName(today.names[id]) || '';
  const totals = series.reduce((acc, d) => {
    acc.received += d.received;
    acc.replied += d.replied;
    acc.failed += d.failed;
    return acc;
  }, { received: 0, replied: 0, failed: 0 });
  const totalDone = totals.replied + totals.failed;
  return {
    version: STATS_VERSION,
    now: new Date(now).toISOString(),
    days: series,
    totals: { ...totals, successRate: totalDone ? totals.replied / totalDone : null },
    today: {
      date: todayKey,
      received: today.received,
      replied: today.replied,
      failed: today.failed,
      privateIn: today.privateIn,
      groupIn: today.groupIn,
      successRate: done ? today.replied / done : null,
      avgLatencyMs: today.latencyCount ? Math.round(today.latencySum / today.latencyCount) : 0,
      maxLatencyMs: today.latencyMax,
      hours: today.hours.slice(),
      activeGroups: Object.keys(today.groups).length,
      activeUsers: Object.keys(today.users).length,
      topGroups: topEntries(today.groups, top),
      topUsers: topEntries(today.users, top).map((e) => ({ ...e, name: nameOf(e.id) })),
    },
  };
}

/**
 * 纯函数：某个群某天的发言排行。
 * @returns {Array<{id: string, name: string, count: number}>}
 */
export function rankSpeakers(data, groupId, { date = dayKey(), limit = 10 } = {}) {
  const day = data?.days?.[date];
  if (!day) return [];
  const map = day.speakers?.[String(groupId)] ?? {};
  return topEntries(map, limit).map((e) => ({ ...e, name: cleanName(day.names?.[e.id]) }));
}

export class StatsStore {
  /**
   * @param {{file: string, retainDays?: number, flushMs?: number, log?: object, now?: () => number}} opts
   */
  constructor({ file, retainDays = DEFAULT_RETAIN_DAYS, flushMs = DEFAULT_FLUSH_MS, log, now } = {}) {
    this.file = file ? path.resolve(file) : '';
    this.retainDays = Math.max(1, Math.trunc(Number(retainDays)) || DEFAULT_RETAIN_DAYS);
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.log = log ?? null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.data = { version: STATS_VERSION, days: {}, chats: {} };
    this.timer = null;
    this.dirty = false;
    this.closed = false;
    this.#load();
  }

  #debug(...args) {
    try { this.log?.debug?.(...args); } catch { /* 日志器坏了也不管 */ }
  }

  #load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.days === 'object' && raw.days) {
        for (const [date, day] of Object.entries(raw.days)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) this.data.days[date] = normalizeDay(date, day);
        }
      }
      this.data.chats = normalizeChats(raw?.chats);
    } catch (err) {
      if (err?.code !== 'ENOENT') this.#debug('读取统计文件失败，从空白开始：', err?.message ?? err);
    }
    this.#prune();
  }

  #prune() {
    const keep = new Set();
    const base = new Date(this.now());
    base.setHours(12, 0, 0, 0);
    for (let i = 0; i < this.retainDays; i++) keep.add(dayKey(base.getTime() - i * 86_400_000));
    for (const date of Object.keys(this.data.days)) {
      if (!keep.has(date)) delete this.data.days[date];
    }
  }

  #today() {
    const date = dayKey(this.now());
    let day = this.data.days[date];
    if (!day) {
      day = emptyDay(date);
      this.data.days[date] = day;
      this.#prune();
    }
    return day;
  }

  #touch() {
    this.dirty = true;
    if (this.closed || !this.file) return;
    if (this.flushMs === 0) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  #remember(day, userId, nickname) {
    const name = cleanName(nickname);
    if (!name) return;
    const id = String(userId);
    if (day.names[id] === name) return;
    if (!Object.hasOwn(day.names, id) && Object.keys(day.names).length >= MAX_USERS) return;
    day.names[id] = name;
  }

  /** 记一个会话的最后活跃时间；超过上限时挤掉最久没动的 */
  #noteChat(key, name) {
    const chats = this.data.chats;
    const clean = cleanName(name);
    const previous = chats[key];
    chats[key] = { lastAt: this.now(), name: clean || previous?.name || '' };
    const keys = Object.keys(chats);
    if (keys.length <= MAX_CHATS) return;
    const oldest = keys.reduce((a, b) => (chats[a].lastAt <= chats[b].lastAt ? a : b));
    delete chats[oldest];
  }

  /** 一条通过准入、要交给模型的请求 */
  recordIncoming({ isGroup = false, groupId = null, userId = null, nickname = '', groupName = '' } = {}) {
    try {
      const day = this.#today();
      if (isGroup && groupId != null) this.#noteChat(`g:${groupId}`, groupName);
      else if (!isGroup && userId != null) this.#noteChat(`p:${userId}`, nickname);
      day.received += 1;
      if (isGroup) day.groupIn += 1; else day.privateIn += 1;
      day.hours[new Date(this.now()).getHours()] += 1;
      if (isGroup && groupId != null) bump(day.groups, String(groupId), MAX_GROUPS);
      if (userId != null) {
        bump(day.users, String(userId), MAX_USERS);
        this.#remember(day, userId, nickname);
      }
      this.#touch();
    } catch (err) {
      this.#debug('统计 recordIncoming 失败：', err?.message ?? err);
    }
  }

  /** 一次请求的结果 */
  recordResult({ ok = true, latencyMs = null } = {}) {
    try {
      const day = this.#today();
      if (ok) day.replied += 1; else day.failed += 1;
      const ms = Number(latencyMs);
      if (ok && Number.isFinite(ms) && ms >= 0) {
        day.latencySum += Math.round(ms);
        day.latencyCount += 1;
        day.latencyMax = Math.max(day.latencyMax, Math.round(ms));
      }
      this.#touch();
    } catch (err) {
      this.#debug('统计 recordResult 失败：', err?.message ?? err);
    }
  }

  /** 已授权群里的一条发言（不论是否唤醒），给 /排行 用 */
  recordSpeaker({ groupId, userId, nickname = '', groupName = '' } = {}) {
    try {
      if (groupId == null || userId == null) return;
      const day = this.#today();
      this.#noteChat(`g:${groupId}`, groupName);
      const gid = String(groupId);
      if (!day.speakers[gid]) {
        if (Object.keys(day.speakers).length >= MAX_GROUPS) return;
        day.speakers[gid] = {};
      }
      bump(day.speakers[gid], String(userId), MAX_SPEAKERS_PER_GROUP);
      this.#remember(day, userId, nickname);
      this.#touch();
    } catch (err) {
      this.#debug('统计 recordSpeaker 失败：', err?.message ?? err);
    }
  }

  /** 今天有人发言的群号（已授权的群才会被记） */
  activeGroupsToday() {
    return Object.keys(this.data.days[dayKey(this.now())]?.speakers ?? {});
  }

  /** 会话最后活跃时间（浅拷贝） */
  chats() {
    return { ...this.data.chats };
  }

  summary(opts) {
    return summarizeStats(this.data, { now: this.now(), ...opts });
  }

  ranking(groupId, { yesterday = false, limit = 10 } = {}) {
    const ts = this.now() - (yesterday ? 86_400_000 : 0);
    return rankSpeakers(this.data, groupId, { date: dayKey(ts), limit });
  }

  /** 立刻写盘；失败只记日志，下次变更再试 */
  flush() {
    if (!this.file || !this.dirty) return false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      this.#debug('写统计文件失败：', err?.message ?? err);
      try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      return false;
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.closed = true;
  }
}

/** 控制台用：只读地读一次 stats.json，坏了就当空 */
export function readStatsFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : { days: {} };
  } catch {
    return { days: {} };
  }
}
