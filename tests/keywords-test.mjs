import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KeywordStore, findKeywordRule, keywordMessage, normalizeRule, normalizeRules } from '../src/keywords.js';
import { createKeywordsApi } from '../src/webui/keywords-api.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-keywords-'));
}

const imagePath = path.join(os.tmpdir(), 'kw.png');

test('规则校验：默认值、去重、必填项和非法输入', () => {
  const rule = normalizeRule({ keywords: [' 早安 ', '早安', ''], reply: ' 早呀 ' });
  assert.deepEqual(
    { ...rule, id: undefined },
    { id: undefined, enabled: true, keywords: ['早安'], match: 'contains', reply: '早呀', image: '', scope: 'all', groupIds: [], cooldownSeconds: 30 },
  );
  assert.deepEqual(normalizeRule({ keywords: 'x', reply: 'y', groupIds: '200000001，abc, 200000001' }).groupIds, ['200000001']);
  assert.equal(normalizeRule({ keywords: 'x', reply: 'y', cooldownSeconds: -5 }).cooldownSeconds, 0);
  assert.throws(() => normalizeRule({ keywords: [], reply: 'y' }), /至少要有一个关键词/);
  assert.throws(() => normalizeRule({ keywords: 'x' }), /要填回复文本或图片/);
  assert.throws(() => normalizeRule({ keywords: '(a', match: 'regex', reply: 'y' }), /正则写错了/);
  assert.throws(() => normalizeRule({ keywords: 'x', image: 'relative.png' }), /绝对路径/);
  assert.throws(() => normalizeRule({ keywords: 'x', image: path.join(os.tmpdir(), 'a.exe') }), /只支持/);
  assert.equal(normalizeRule({ keywords: 'x', image: imagePath }).image, path.normalize(imagePath));
  assert.equal(normalizeRule({ keywords: 'x', image: 'https://example.com/a.png' }).image, 'https://example.com/a.png');
  const rules = normalizeRules([{ id: 'a', keywords: 'x', reply: '1' }, { id: 'a', keywords: 'y', reply: '2' }]);
  assert.deepEqual(rules.map((r) => r.id), ['a', 'a-1']);
  assert.throws(() => normalizeRules('nope'), /必须是数组/);
});

test('匹配：三种方式、范围、指定群、停用和超长消息', () => {
  const rules = normalizeRules([
    { id: 'off', enabled: false, keywords: '早安', reply: 'off' },
    { id: 'exact', keywords: '签到', match: 'exact', reply: '已签到' },
    { id: 'group', keywords: '群规', scope: 'group', groupIds: ['200000001'], reply: '看群公告' },
    { id: 'private', keywords: '帮忙', scope: 'private', reply: '私聊找我' },
    { id: 'regex', keywords: '^天气\\s*(北京|上海)$', match: 'regex', reply: '自己查' },
    { id: 'contains', keywords: '早安', reply: '早呀' },
  ]);
  const group = { isGroup: true, groupId: 200000001 };
  assert.equal(findKeywordRule(rules, '大家早安', group)?.id, 'contains');
  assert.equal(findKeywordRule(rules, '签到', group)?.id, 'exact');
  assert.equal(findKeywordRule(rules, '我要签到', group), null);
  assert.equal(findKeywordRule(rules, '群规是什么', group)?.id, 'group');
  assert.equal(findKeywordRule(rules, '群规是什么', { isGroup: true, groupId: 200000009 }), null);
  assert.equal(findKeywordRule(rules, '帮忙', group), null);
  assert.equal(findKeywordRule(rules, '帮忙', { isGroup: false })?.id, 'private');
  assert.equal(findKeywordRule(rules, '天气 上海', group)?.id, 'regex');
  assert.equal(findKeywordRule(rules, '', group), null);
  assert.equal(findKeywordRule(rules, `早安${'啊'.repeat(600)}`, group), null);
});

test('消息段：只用 text / image 段，本地图片转 file URL', () => {
  const [rule] = normalizeRules([{ keywords: 'x', reply: '[CQ:at,qq=all]', image: imagePath }]);
  const segments = keywordMessage(rule, { toFileUrl: (file) => `file:///${file}` });
  assert.deepEqual(segments[0], { type: 'text', data: { text: '[CQ:at,qq=all]' } });
  assert.equal(segments[1].type, 'image');
  assert.match(segments[1].data.file, /^file:\/\/\//);
  const [remote] = normalizeRules([{ keywords: 'x', image: 'https://example.com/a.png' }]);
  assert.deepEqual(keywordMessage(remote), [{ type: 'image', data: { file: 'https://example.com/a.png' } }]);
});

test('存储：保存、热加载、坏文件当作没有规则、冷却按会话计算', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state', 'keywords.json');
  let now = 1_000_000;
  const warnings = [];
  try {
    const store = new KeywordStore({ file, now: () => now, log: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(store.rules(), []);
    await store.save([{ id: 'hi', keywords: '早安', reply: '早呀', cooldownSeconds: 10 }]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.rules[0].id, 'hi');

    const ctxA = { isGroup: true, groupId: 200000001, chatKey: 'g:200000001' };
    const ctxB = { isGroup: true, groupId: 200000002, chatKey: 'g:200000002' };
    assert.equal(store.take('早安', ctxA)?.id, 'hi');
    assert.equal(store.take('早安', ctxA), null, '冷却中不重复回');
    assert.equal(store.take('早安', ctxB)?.id, 'hi', '另一个群不受影响');
    now += 10_000;
    assert.equal(store.take('早安', ctxA)?.id, 'hi', '冷却过了再回');

    // 另一个进程（控制台）改了文件，桥接这边按 mtime 热加载
    const other = new KeywordStore({ file });
    await other.save([{ id: 'bye', keywords: '晚安', reply: '晚安' }]);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    assert.equal(store.take('晚安', ctxA)?.id, 'bye');

    fs.writeFileSync(file, '{ not json');
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(file, later, later);
    assert.deepEqual(store.rules(), []);
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withApi(fn) {
  const dir = tempDir();
  const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const readJsonBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); } });
  });
  const api = createKeywordsApi({
    stateDir: dir, readJsonBody,
    ok: (res, data) => sendJson(res, 200, { ok: true, data }),
    fail: (res, status, error) => sendJson(res, status, { ok: false, error }),
  });
  const server = http.createServer((req, res) => api.route(req, res, new URL(req.url, 'http://x').pathname, req.method));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, dir);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('接口：GET 空列表、PUT 保存、错误返回 400、其他方法 405', async () => {
  await withApi(async (base, dir) => {
    const empty = await (await fetch(`${base}/api/keywords`)).json();
    assert.deepEqual(empty.data.rules, []);
    assert.deepEqual(empty.data.matchModes, ['exact', 'contains', 'regex']);

    const put = await fetch(`${base}/api/keywords`, {
      method: 'PUT', body: JSON.stringify({ rules: [{ keywords: ['早安'], reply: '早呀' }] }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).data.rules[0].reply, '早呀');
    assert.ok(fs.existsSync(path.join(dir, 'keywords.json')));

    const bad = await fetch(`${base}/api/keywords`, { method: 'PUT', body: JSON.stringify({ rules: [{ keywords: ['x'] }] }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /回复文本或图片/);

    const del = await fetch(`${base}/api/keywords`, { method: 'DELETE' });
    assert.equal(del.status, 405);
  });
});
