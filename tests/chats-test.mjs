import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StatsStore, dayKey } from '../src/stats.js';
import { buildChatRows, createChatsApi, dropChatKeys } from '../src/webui/chats-api.mjs';
import { filterChats, relativeTime } from '../src/webui/public/chat-manager.js';

const NOW = new Date(2026, 10, 24, 12, 0).getTime();

test('统计记录每个会话的最后活跃时间和名字，坏数据被丢弃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chats-'));
  const file = path.join(dir, 'stats.json');
  let now = NOW;
  try {
    const stats = new StatsStore({ file, flushMs: 0, now: () => now });
    stats.recordSpeaker({ groupId: 200000001, userId: 1000000002, groupName: '测试群' });
    now += 1000;
    stats.recordIncoming({ isGroup: false, userId: 1000000003, nickname: '小红' });
    now += 1000;
    stats.recordSpeaker({ groupId: 200000001, userId: 1000000004 });
    assert.deepEqual(stats.chats(), {
      'g:200000001': { lastAt: NOW + 2000, name: '测试群' },
      'p:1000000003': { lastAt: NOW + 1000, name: '小红' },
    });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.chats['bad key'] = { lastAt: 1 };
    raw.chats['g:1'] = { lastAt: 'nope' };
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = new StatsStore({ file, flushMs: 0, now: () => now });
    assert.deepEqual(Object.keys(reloaded.chats()).sort(), ['g:200000001', 'p:1000000003']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话行：合并统计、两份会话映射和人格覆盖，按最后活跃倒序', () => {
  const rows = buildChatRows({
    now: NOW,
    stats: {
      chats: { 'g:200000001': { lastAt: NOW - 60_000, name: '测试群' }, 'p:1000000002': { lastAt: NOW - 1000, name: '' } },
      days: { [dayKey(NOW)]: { speakers: { 200000001: { 1: 3, 2: 4 } }, names: { 1000000002: '小明' } } },
    },
    bridgeSessions: {
      'g:200000001:u:1000000002:chat:v1': { sessionId: 'a', startedAt: NOW - 5000 },
      'g:200000001:u:1000000003:admin:workspace-write': 'legacy',
      'p:1000000002:chat:v1': { sessionId: 'b', startedAt: NOW - 1000 },
      garbage: 'x',
    },
    dshSessions: { 'group:200000009': 'c', private_1000000002: 'd' },
    personaState: { active: '大肥鱼', chats: { 'g:200000009': '客服' } },
  });
  assert.deepEqual(rows.map((r) => r.key), ['p:1000000002', 'g:200000001', 'g:200000009']);
  const [privateRow, group, dshOnly] = rows;
  assert.equal(privateRow.name, '小明');
  assert.equal(privateRow.sessions, 2);
  assert.equal(group.todayMessages, 7);
  assert.equal(group.sessions, 2);
  assert.equal(group.sessionStartedAt, NOW - 5000);
  assert.equal(dshOnly.persona, '客服');
  assert.equal(dshOnly.lastAt, null);
});

test('重置会话只删属于这个会话的键，不改原对象', () => {
  const bridge = { 'g:1:u:2:chat:v1': 'a', 'g:12:u:2:chat:v1': 'b', 'g:1': 'c', 'p:1:chat:v1': 'd' };
  const { next, removed } = dropChatKeys(bridge, 'g:1');
  assert.deepEqual(removed.sort(), ['g:1', 'g:1:u:2:chat:v1']);
  assert.deepEqual(Object.keys(next).sort(), ['g:12:u:2:chat:v1', 'p:1:chat:v1']);
  assert.equal(Object.keys(bridge).length, 4);
  const dsh = dropChatKeys({ 'group:1': 'a', group_1: 'b', 'group:12': 'c', 'private:1': 'd' }, 'g:1', { dsh: true });
  assert.deepEqual(dsh.removed.sort(), ['group:1', 'group_1']);
  assert.deepEqual(dropChatKeys(null, 'g:1'), { next: null, removed: [] });
});

test('页面工具：相对时间和筛选', () => {
  assert.equal(relativeTime(null, NOW), '暂无记录');
  assert.equal(relativeTime(NOW - 10_000, NOW), '刚刚');
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5 分钟前');
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), '3 小时前');
  assert.equal(relativeTime(NOW - 2 * 86_400_000, NOW), '2 天前');
  assert.match(relativeTime(NOW - 30 * 86_400_000, NOW), /^\d{4}-\d{2}-\d{2}$/);
  const items = [
    { kind: 'group', id: '200000001', name: '测试群', persona: '' },
    { kind: 'private', id: '1000000002', name: '小明', persona: '客服' },
  ];
  assert.equal(filterChats(items, { kind: 'group' }).length, 1);
  assert.equal(filterChats(items, { query: '小明' })[0].id, '1000000002');
  assert.equal(filterChats(items, { query: '客服' }).length, 1);
  assert.equal(filterChats(items, { kind: 'private', query: '测试' }).length, 0);
});

test('接口：列表、重置会话、非法会话标识和方法', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chats-api-'));
  const files = {
    statsFile: path.join(dir, 'stats.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    chatSessionsFile: path.join(dir, 'chat-sessions.json'),
  };
  fs.writeFileSync(files.statsFile, JSON.stringify({ chats: { 'g:200000001': { lastAt: NOW, name: '测试群' } }, days: {} }));
  fs.writeFileSync(files.sessionsFile, JSON.stringify({ 'g:200000001:u:2:chat:v1': { sessionId: 'a', startedAt: NOW }, 'p:3:chat:v1': 'b' }));
  fs.writeFileSync(files.chatSessionsFile, JSON.stringify({ 'group:200000001': 'c' }));
  const readJson = async (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const sendJson = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const api = createChatsApi({
    ...files, readJson,
    writeAtomic: async (file, content) => fs.writeFileSync(file, content),
    personaDir: () => dir,
    readStats: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    readPersonaState: async () => ({ active: '大肥鱼', chats: {} }),
    listPersonaNames: async () => ['大肥鱼', '客服'],
    ok: (res, data) => sendJson(res, 200, { ok: true, data }),
    fail: (res, status, error) => sendJson(res, status, { ok: false, error }),
  });
  const server = http.createServer((req, res) => api.route(req, res, decodeURIComponent(new URL(req.url, 'http://x').pathname), req.method));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = (await (await fetch(`${base}/api/chats`)).json()).data;
    assert.deepEqual(list.personas, ['大肥鱼', '客服']);
    assert.equal(list.activePersona, '大肥鱼');
    assert.equal(list.items.find((i) => i.key === 'g:200000001').sessions, 2);

    const reset = await fetch(`${base}/api/chats/${encodeURIComponent('g:200000001')}/session`, { method: 'DELETE' });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).data.removed.length, 2);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(files.sessionsFile, 'utf8'))), ['p:3:chat:v1']);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.chatSessionsFile, 'utf8')), {});

    const again = await (await fetch(`${base}/api/chats/g:200000001/session`, { method: 'DELETE' })).json();
    assert.deepEqual(again.data.removed, []);
    assert.equal((await fetch(`${base}/api/chats/x:1/session`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${base}/api/chats`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/chats/g:1/other`)).status, 404);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
