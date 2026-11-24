/**
 * 控制台「会话」页：按群 / 私聊各一行，汇总
 *   - 最后活跃时间和名字（stats.json 的 chats）
 *   - 今日群发言条数（stats.json 当天的 speakers）
 *   - 当前绑定的 DSH 会话（桥接 sessions.json + DSH 自己的 chat-sessions.json）
 *   - 这个会话单独指定的人格（personas/active.json 的 chats）
 *
 *   GET    /api/chats                 列表 + 人格库名字
 *   DELETE /api/chats/<g:群号|p:QQ号>/session   重置这个会话（下一条消息开新会话）
 *
 * 切换人格走已有的 PUT /api/personas/chat。写接口的来源校验由 server.mjs 统一做。
 */

import { dayKey } from '../stats.js';

const CHAT_KEY = /^([gp]):(\d{1,20})$/;
const BRIDGE_KEY = /^([gp]:\d{1,20})(?::|$)/;
const DSH_KEY = /^(private|group)[:_](\d{1,20})$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** DSH 映射里 group:123 / private:456 → g:123 / p:456 */
function dshChatKey(key) {
  const m = DSH_KEY.exec(key);
  if (m) return `${m[1] === 'group' ? 'g' : 'p'}:${m[2]}`;
  return /^\d{1,20}$/.test(key) ? `p:${key}` : '';
}

function startedAtOf(value) {
  const n = Number(value?.startedAt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 纯函数：把几份状态文件拼成会话行，按最后活跃时间倒序。
 * @param {{stats?: object, bridgeSessions?: object, dshSessions?: object, personaState?: object, now?: number}} input
 */
export function buildChatRows({ stats = {}, bridgeSessions = {}, dshSessions = {}, personaState = {}, now = Date.now() } = {}) {
  const rows = new Map();
  const row = (key) => {
    const m = CHAT_KEY.exec(key);
    if (!m) return null;
    if (!rows.has(key)) {
      rows.set(key, {
        key, kind: m[1] === 'g' ? 'group' : 'private', id: m[2], name: '', lastAt: null,
        todayMessages: 0, persona: '', sessions: 0, sessionStartedAt: null,
      });
    }
    return rows.get(key);
  };

  for (const [key, info] of Object.entries(isPlainObject(stats.chats) ? stats.chats : {})) {
    const r = row(key);
    if (!r) continue;
    const lastAt = Number(info?.lastAt);
    r.lastAt = Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null;
    r.name = typeof info?.name === 'string' ? info.name : '';
  }

  const today = stats.days?.[dayKey(now)];
  for (const [gid, speakers] of Object.entries(isPlainObject(today?.speakers) ? today.speakers : {})) {
    const r = row(`g:${gid}`);
    if (r && isPlainObject(speakers)) r.todayMessages = Object.values(speakers).reduce((a, b) => a + (Number(b) || 0), 0);
  }
  const names = isPlainObject(today?.names) ? today.names : {};
  for (const r of rows.values()) if (r.kind === 'private' && !r.name && names[r.id]) r.name = String(names[r.id]);

  for (const [key, value] of Object.entries(isPlainObject(bridgeSessions) ? bridgeSessions : {})) {
    const m = BRIDGE_KEY.exec(key);
    const r = m && row(m[1]);
    if (!r) continue;
    r.sessions += 1;
    const started = startedAtOf(value);
    if (started && (!r.sessionStartedAt || started > r.sessionStartedAt)) r.sessionStartedAt = started;
  }
  for (const key of Object.keys(isPlainObject(dshSessions) ? dshSessions : {})) {
    const r = row(dshChatKey(key));
    if (r) r.sessions += 1;
  }
  for (const [key, name] of Object.entries(isPlainObject(personaState?.chats) ? personaState.chats : {})) {
    const r = row(key);
    if (r && typeof name === 'string') r.persona = name;
  }

  return [...rows.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.key.localeCompare(b.key));
}

/** 从映射里删掉属于这个会话的键，返回新对象和删掉的键；不改原对象 */
export function dropChatKeys(map, chatKey, { dsh = false } = {}) {
  if (!isPlainObject(map)) return { next: map, removed: [] };
  const belongs = dsh
    ? (key) => dshChatKey(key) === chatKey
    : (key) => BRIDGE_KEY.exec(key)?.[1] === chatKey;
  const removed = Object.keys(map).filter(belongs);
  const next = Object.fromEntries(Object.entries(map).filter(([key]) => !belongs(key)));
  return { next, removed };
}

export function createChatsApi({
  statsFile, sessionsFile, chatSessionsFile, personaDir, readJson, writeAtomic, readStats, readPersonaState, listPersonaNames,
  ok, fail, log,
}) {
  async function list(res) {
    const [bridgeSessions, dshSessions, personaState, personas] = await Promise.all([
      readJson(sessionsFile), readJson(chatSessionsFile),
      readPersonaState(personaDir()).catch(() => ({ active: '', chats: {} })),
      listPersonaNames(personaDir()).catch(() => []),
    ]);
    const items = buildChatRows({
      stats: readStats(statsFile), bridgeSessions: bridgeSessions ?? {}, dshSessions: dshSessions ?? {}, personaState,
    });
    return ok(res, {
      items, personas, activePersona: personaState?.active ?? '',
      counts: { total: items.length, group: items.filter((i) => i.kind === 'group').length },
    });
  }

  async function reset(chatKey, res) {
    if (!CHAT_KEY.test(chatKey)) return fail(res, 400, '会话标识应为 g:群号 或 p:QQ号');
    const removed = [];
    for (const [file, dsh] of [[sessionsFile, false], [chatSessionsFile, true]]) {
      const { next, removed: keys } = dropChatKeys(await readJson(file), chatKey, { dsh });
      if (!keys.length) continue;
      await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      removed.push(...keys);
    }
    if (removed.length) log?.info?.(`已重置会话 ${chatKey}（${removed.length} 条绑定）`);
    return ok(res, { key: chatKey, removed });
  }

  async function route(req, res, pathname, method) {
    if (pathname === '/api/chats') {
      if (method !== 'GET') return fail(res, 405, '只支持 GET');
      return list(res);
    }
    const m = /^\/api\/chats\/([^/]+)\/session$/.exec(pathname);
    if (!m) return fail(res, 404, `没有这个接口：${pathname}`);
    if (method !== 'DELETE') return fail(res, 405, '只支持 DELETE');
    return reset(m[1], res);
  }

  return { route };
}
