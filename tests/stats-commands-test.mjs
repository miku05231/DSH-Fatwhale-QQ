import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StatsStore, dayKey, readStatsFile, summarizeStats, rankSpeakers } from '../src/stats.js';
import { commandSettings, formatHelp, formatRanking, formatStatus, maskId, parseBuiltinCommand } from '../src/commands.js';
import { filterLogLines } from '../src/webui/public/logs.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stats-'));
  return { dir, file: path.join(dir, 'state', 'stats.json') };
}

test('统计按本地日期分桶，记录收发、失败、耗时和活跃对象', () => {
  const { dir, file } = tempFile();
  let now = new Date(2026, 10, 24, 9, 30).getTime();
  try {
    const stats = new StatsStore({ file, flushMs: 0, now: () => now });
    stats.recordIncoming({ isGroup: true, groupId: 200000001, userId: 1000000002, nickname: '小明' });
    stats.recordIncoming({ isGroup: true, groupId: 200000001, userId: 1000000003 });
    stats.recordIncoming({ isGroup: false, userId: 1000000002 });
    stats.recordResult({ ok: true, latencyMs: 1000 });
    stats.recordResult({ ok: true, latencyMs: 3000 });
    stats.recordResult({ ok: false });
    const today = stats.summary({ days: 7 }).today;
    assert.equal(today.received, 3);
    assert.equal(today.groupIn, 2);
    assert.equal(today.privateIn, 1);
    assert.equal(today.replied, 2);
    assert.equal(today.failed, 1);
    assert.equal(today.avgLatencyMs, 2000);
    assert.equal(today.maxLatencyMs, 3000);
    assert.equal(Math.round(today.successRate * 100), 67);
    assert.equal(today.hours[9], 3);
    assert.equal(today.activeGroups, 1);
    assert.equal(today.activeUsers, 2);
    assert.deepEqual(today.topUsers[0], { id: '1000000002', count: 2, name: '小明' });

    // 跨天：新一天从零开始，7 天序列里两天都在
    now += 86_400_000;
    stats.recordIncoming({ userId: 1000000002 });
    const summary = stats.summary({ days: 7 });
    assert.equal(summary.days.length, 7);
    assert.equal(summary.days.at(-1).received, 1);
    assert.equal(summary.days.at(-2).received, 3);
    assert.equal(summary.totals.received, 4);

    // 写盘后能被控制台进程读出同样的口径
    stats.close();
    const fromDisk = summarizeStats(readStatsFile(file), { days: 7, now });
    assert.equal(fromDisk.totals.received, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('统计只保留配置的天数，坏文件从空白开始', () => {
  const { dir, file } = tempFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{坏掉的 json', 'utf8');
    const now = new Date(2026, 10, 24, 12).getTime();
    const stats = new StatsStore({ file, flushMs: 0, retainDays: 3, now: () => now });
    assert.equal(stats.summary().totals.received, 0);

    const old = { days: {} };
    for (let i = 0; i < 6; i++) old.days[dayKey(now - i * 86_400_000)] = { received: 1 };
    fs.writeFileSync(file, JSON.stringify(old), 'utf8');
    const reloaded = new StatsStore({ file, flushMs: 0, retainDays: 3, now: () => now });
    assert.equal(Object.keys(reloaded.data.days).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('群发言排行按条数排序，昨日排行读前一天', () => {
  const { dir, file } = tempFile();
  let now = new Date(2026, 10, 23, 20).getTime();
  try {
    const stats = new StatsStore({ file, flushMs: 0, now: () => now });
    for (let i = 0; i < 3; i++) stats.recordSpeaker({ groupId: 1, userId: 11, nickname: 'A' });
    stats.recordSpeaker({ groupId: 1, userId: 12, nickname: 'B' });
    stats.recordSpeaker({ groupId: 2, userId: 13, nickname: 'C' });
    now += 86_400_000;
    stats.recordSpeaker({ groupId: 1, userId: 12, nickname: 'B' });
    assert.deepEqual(stats.ranking(1).map((r) => r.id), ['12']);
    assert.deepEqual(stats.ranking(1, { yesterday: true }).map((r) => [r.name, r.count]), [['A', 3], ['B', 1]]);
    assert.deepEqual(rankSpeakers(stats.data, 2, { date: dayKey(now - 86_400_000) })[0].name, 'C');
    assert.deepEqual(stats.ranking(999), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('统计写盘失败不抛错，也不影响继续计数', () => {
  const { dir } = tempFile();
  try {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const stats = new StatsStore({ file: path.join(blocker, 'stats.json'), flushMs: 0 });
    assert.doesNotThrow(() => stats.recordIncoming({ userId: 1 }));
    assert.equal(stats.summary().today.received, 1);
    assert.doesNotThrow(() => stats.close());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('内置指令只认整句，避免误伤正常聊天', () => {
  assert.deepEqual(parseBuiltinCommand('/帮助'), { name: 'help' });
  assert.deepEqual(parseBuiltinCommand(' ／状态 '), { name: 'status' });
  assert.deepEqual(parseBuiltinCommand('/HELP'), { name: 'help' });
  assert.deepEqual(parseBuiltinCommand('/排行'), { name: 'rank' });
  assert.deepEqual(parseBuiltinCommand('/昨日排行'), { name: 'rankYesterday' });
  assert.equal(parseBuiltinCommand('帮助'), null);
  assert.equal(parseBuiltinCommand('/帮助 我写个脚本'), null);
  assert.equal(parseBuiltinCommand('/人格'), null);
  assert.equal(parseBuiltinCommand(''), null);
  assert.deepEqual(commandSettings({}), { enabled: true, rank: true, rankSize: 10 });
  assert.deepEqual(commandSettings({ commands: { enabled: false, rank: false, rankSize: 99 } }), { enabled: false, rank: false, rankSize: 30 });
});

test('指令回复文本：帮助、状态、排行', () => {
  const groupHelp = formatHelp({ isGroup: true, pluginCommands: [{ cmd: '/ping', desc: '测试' }] });
  assert.match(groupHelp, /\/排行/);
  assert.match(groupHelp, /\/ping —— 测试/);
  assert.doesNotMatch(formatHelp({ isGroup: false }), /\/排行/);
  assert.doesNotMatch(formatHelp({ isGroup: true, rankEnabled: false }), /\/排行/);

  const status = formatStatus({
    uptimeSeconds: 3 * 3600 + 120, connected: true, model: 'test/chat', queueDepth: 2,
    today: { received: 5, privateIn: 2, groupIn: 3, replied: 4, successRate: 0.8, avgLatencyMs: 2500 },
  });
  assert.match(status, /在线 · 已运行 3 小时 2 分/);
  assert.match(status, /成功率 80% · 平均耗时 2\.5 秒/);
  assert.match(status, /模型：test\/chat/);
  assert.match(status, /排队中：2 条/);

  const rank = formatRanking([{ id: '1000000002', name: '', count: 5 }, { id: '3', name: 'B', count: 1 }]);
  assert.match(rank, /🥇 QQ 10\*\*\*02 —— 5 条/);
  assert.match(rank, /🥈 B —— 1 条/);
  assert.equal(formatRanking([], { yesterday: true }), '昨日发言排行：还没有记录。');
  assert.equal(maskId('123'), '123');
});

test('日志筛选：按级别和关键词，认不出级别的行保留', () => {
  const lines = [
    '2026-11-24 10:00:00.000 DEBUG [bridge] 细节',
    '2026-11-24 10:00:01.000 INFO [bridge] 收到 群 消息',
    '2026-11-24 10:00:02.000 WARN [bridge] 触发限流',
    '2026-11-24 10:00:03.000 ERROR [bridge] DSH 调用失败',
    '    at stack (file.js:1:1)',
  ];
  assert.equal(filterLogLines(lines, {}), lines);
  assert.deepEqual(filterLogLines(lines, { level: 'WARN' }), [lines[2], lines[3], lines[4]]);
  assert.deepEqual(filterLogLines(lines, { level: 'ERROR' }), [lines[3], lines[4]]);
  assert.deepEqual(filterLogLines(lines, { keyword: '限流' }), [lines[2]]);
  assert.deepEqual(filterLogLines(lines, { level: 'INFO', keyword: 'dsh' }), [lines[3]]);
});
