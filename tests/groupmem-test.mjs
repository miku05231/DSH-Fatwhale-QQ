// tests/groupmem-test.mjs —— 群聊记忆仓库自测（零依赖，只用 node:assert/strict）
//
// 跑法：node tests\groupmem-test.mjs
// 全绿退出码 0，否则 1；末尾打印「通过 N / N」。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GroupMemory } from '../src/groupmem.js';

/* -------------------- 迷你测试器 -------------------- */

const cases = [];

/** 注册一个用例；fn 可 async */
function test(name, fn) {
  cases.push({ name, fn });
}

/** 假装成项目里的 logger，把 warn / debug 收集起来 */
function makeLog() {
  const warns = [];
  const debugs = [];
  return {
    warns,
    debugs,
    log: {
      debug: (m) => debugs.push(String(m)),
      warn: (m) => warns.push(String(m)),
    },
  };
}

/** 读文件的分行（文件不存在 → 空数组） */
function readLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter((s) => s.trim() !== '');
}

/** 目录里的 *.jsonl 文件名 */
function jsonlFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-groupmem-'));

/* -------------------- 用例 -------------------- */

// 1. 空目录初始化
test('空目录初始化：recent 为空数组、digest 为空串，且构造时就建好目录', () => {
  const dir = path.join(root, 't1', 'mem'); // 故意多一级，顺便验证 recursive
  assert.equal(fs.existsSync(dir), false);

  const mem = new GroupMemory({ dir });
  assert.equal(mem.disabled, false);
  assert.equal(fs.statSync(dir).isDirectory(), true);

  assert.deepEqual(mem.recent(200000001), []);
  assert.equal(mem.digest(200000001), '');
  assert.deepEqual(mem.stats(), { groups: 0, totalMessages: 0, dir: path.resolve(dir) });
});

// 2. 追加 + 只取后 n 条 + 持久化
test('append 三条：recent(2) 取后两条且顺序正确，新实例能读回', () => {
  const dir = path.join(root, 't2');
  const mem = new GroupMemory({ dir });

  mem.append('g1', { ts: 1000, userId: 1, nickname: 'A', text: '一' });
  mem.append('g1', { ts: 2000, userId: 2, nickname: 'B', text: '二' });
  mem.append('g1', { ts: 3000, userId: 3, nickname: 'C', text: '三' });

  const two = mem.recent('g1', 2);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((r) => r.text), ['二', '三']);
  assert.equal(two[0].ts, 2000);

  // recent 返回的是副本：改它不能污染内部
  two[0].text = '被改了';
  assert.deepEqual(mem.recent('g1', 10).map((r) => r.text), ['一', '二', '三']);

  // 持久化：新实例（冷缓存）读回同样内容
  const mem2 = new GroupMemory({ dir });
  assert.deepEqual(mem2.recent('g1', 10).map((r) => r.text), ['一', '二', '三']);
  assert.deepEqual(mem2.recent('g1', 10).map((r) => r.userId), [1, 2, 3]);
});

// 3. 无效正文一律不写
test('空 / 全空白 / 缺 text / null / text 是数字：都不写入，行数不增加', () => {
  const dir = path.join(root, 't3');
  const mem = new GroupMemory({ dir, log: makeLog().log });
  const file = path.join(dir, 'g.jsonl');

  mem.append('g', { text: '唯一一条' });
  const before = readLines(file);
  assert.equal(before.length, 1);

  mem.append('g', { text: '' });
  mem.append('g', { text: '   ' });
  mem.append('g', { text: '\n\t' });
  mem.append('g', { text: '\u3000\u3000' }); // 全角空格也是空白
  mem.append('g', { nickname: '没正文' });
  mem.append('g', null);
  mem.append('g', undefined);
  mem.append('g', { text: 123 });
  mem.append('g', { text: ['a'] });
  mem.append('g', 'not-an-object');
  mem.append('g', 42);

  assert.equal(readLines(file).length, 1);
  assert.deepEqual(mem.recent('g', 10).map((r) => r.text), ['唯一一条']);
});

// 4. ts 缺省 / 显式
test('ts 缺省自动填当前时间；显式 ts 原样保留（取整）', () => {
  const dir = path.join(root, 't4');
  const mem = new GroupMemory({ dir });

  const t0 = Date.now();
  mem.append('g', { text: '自动时间' });
  const t1 = Date.now();
  const auto = mem.recent('g', 1)[0];
  assert.equal(typeof auto.ts, 'number');
  assert.ok(auto.ts >= t0 && auto.ts <= t1, `自动 ts=${auto.ts} 不在 [${t0}, ${t1}]`);

  const fixed = 1792427196123;
  mem.append('g', { ts: fixed, text: '固定时间' });
  assert.equal(mem.recent('g', 1)[0].ts, fixed);

  mem.append('g', { ts: fixed + 0.7, text: '小数时间' });
  assert.equal(mem.recent('g', 1)[0].ts, Math.round(fixed + 0.7));

  const disk = readLines(path.join(dir, 'g.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(
    disk.map((r) => r.ts),
    [auto.ts, fixed, Math.round(fixed + 0.7)],
  );
});

// 5. limit 裁剪 + 磁盘收紧 + 新实例一致
test('limit=5 写 8 条：内存 5 条、磁盘 5 行、新实例一致、stats=5', () => {
  const dir = path.join(root, 't5');
  const mem = new GroupMemory({ dir, limit: 5 });

  for (let i = 1; i <= 8; i += 1) mem.append('g', { ts: i * 1000, text: `第${i}条` });

  const want = ['第4条', '第5条', '第6条', '第7条', '第8条'];
  assert.deepEqual(mem.recent('g', 100).map((r) => r.text), want);

  const lines = readLines(path.join(dir, 'g.jsonl'));
  assert.equal(lines.length, 5, '磁盘上必须只剩 5 行');
  assert.deepEqual(lines.map((l) => JSON.parse(l).text), want);

  const mem2 = new GroupMemory({ dir, limit: 5 });
  assert.deepEqual(mem2.recent('g', 100).map((r) => r.text), want);
  assert.equal(mem2.stats().totalMessages, 5);

  // 原子重写不该留 .tmp 垃圾
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

// 6. digest 逐字校验
test('digest 逐字校验：header / 本地时间 / 昵称(QQ) / 压成单行', () => {
  const dir = path.join(root, 't6');
  const mem = new GroupMemory({ dir });

  // 用本地时间构造，保证显示就是 12:03 / 12:04（不受时区影响）
  const t1 = new Date(2026, 9, 20, 12, 3, 0).getTime();
  const t2 = new Date(2026, 9, 20, 12, 4, 0).getTime();

  mem.append(200000001, { ts: t1, userId: 123456, nickname: '张三', text: '今天谁值班' });
  mem.append(200000001, { ts: t2, userId: 234567, nickname: '李四', text: '我' });

  const want = [
    '[群 200000001 最近 2 条]',
    '12:03 张三(123456): 今天谁值班',
    '12:04 李四(234567): 我',
  ].join('\n');
  assert.equal(mem.digest(200000001), want);

  // 边界：没昵称 / 没 QQ / 多行文本
  const g2 = 'g-edge';
  mem.append(g2, { ts: t1, userId: 777, text: '没昵称' });
  mem.append(g2, { ts: t1, nickname: '没号', text: '不带括号' });
  mem.append(g2, { ts: t1, userId: 888, nickname: '多行', text: '第一行\n第二行\t第三行   末尾' });

  const want2 = [
    '[群 g-edge 最近 3 条]',
    '12:03 未知(777): 没昵称',
    '12:03 没号: 不带括号',
    '12:03 多行(888): 第一行 第二行 第三行 末尾',
  ].join('\n');
  assert.equal(mem.digest(g2), want2);

  // 非法/缺失时间戳 → --:--（append 会给缺省 ts，所以手工写盘造这一行）
  fs.writeFileSync(path.join(dir, 'g-nots.jsonl'), '{"text":"缺时间"}\n', 'utf8');
  assert.equal(mem.digest('g-nots'), '[群 g-nots 最近 1 条]\n--:-- 未知: 缺时间');

  // n 限定 + 空群
  assert.equal(mem.digest(g2, 1), '[群 g-edge 最近 1 条]\n12:03 多行(888): 第一行 第二行 第三行 末尾');
  assert.equal(mem.digest('从没聊过的群'), '');
});

// 7. clear
test('clear 后 recent 为空、文件不存在；重复 clear 不报错', () => {
  const dir = path.join(root, 't7');
  const mem = new GroupMemory({ dir });
  mem.append('g', { text: 'x' });

  const file = path.join(dir, 'g.jsonl');
  assert.equal(fs.existsSync(file), true);

  mem.clear('g');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(mem.recent('g'), []);
  assert.equal(mem.digest('g'), '');

  mem.clear('g'); // 再清一次
  mem.clear('不存在的群');
  assert.deepEqual(mem.recent('g'), []);
});

// 8. stats 多群
test('stats 多群统计正确，损坏行不计', () => {
  const dir = path.join(root, 't8');
  const mem = new GroupMemory({ dir });

  assert.deepEqual(mem.stats(), { groups: 0, totalMessages: 0, dir: path.resolve(dir) });

  mem.append('g1', { text: 'a' });
  mem.append('g1', { text: 'b' });
  mem.append('g1', { text: 'c' });
  mem.append('g2', { text: 'd' });
  mem.append('g2', { text: 'e' });

  const s = mem.stats();
  assert.equal(s.groups, 2);
  assert.equal(s.totalMessages, 5);
  assert.equal(s.dir, path.resolve(dir));

  // 手工塞两行垃圾：groups 不变，totalMessages 也不能涨
  fs.appendFileSync(path.join(dir, 'g2.jsonl'), 'oops\n{"foo":1}\n', 'utf8');
  const s2 = mem.stats();
  assert.equal(s2.groups, 2);
  assert.equal(s2.totalMessages, 5);
});

// 9. 100 条并发 append（乱序调度）
test('100 条并发 append（随机延时打乱）：一条不丢、顺序一致、磁盘 100 行', async () => {
  const dir = path.join(root, 't9');
  const mem = new GroupMemory({ dir, limit: 500 });

  const callOrder = []; // 实际被调用的先后
  const jobs = [];
  for (let i = 0; i < 100; i += 1) {
    jobs.push(
      new Promise((resolve) => {
        setTimeout(
          () => {
            callOrder.push(i);
            mem.append('g', {
              ts: 1792427196000 + i,
              userId: i,
              nickname: `u${i}`,
              text: `消息${i}`,
            });
            resolve();
          },
          Math.floor(Math.random() * 25),
        );
      }),
    );
  }
  await Promise.all(jobs);

  assert.equal(callOrder.length, 100);
  const want = callOrder.map((i) => `消息${i}`);

  assert.deepEqual(mem.recent('g', 200).map((r) => r.text), want);

  const lines = readLines(path.join(dir, 'g.jsonl'));
  assert.equal(lines.length, 100, '磁盘必须是 100 行');
  assert.deepEqual(lines.map((l) => JSON.parse(l).text), want);

  const mem2 = new GroupMemory({ dir });
  assert.deepEqual(mem2.recent('g', 200).map((r) => r.text), want);
  assert.equal(mem2.stats().totalMessages, 100);
});

// 10. 多级目录自建
test('多级目录不存在（a/b/c）也能自建并正常读写', () => {
  const dir = path.join(root, 't10', 'a', 'b', 'c');
  assert.equal(fs.existsSync(dir), false);

  const mem = new GroupMemory({ dir });
  assert.equal(mem.disabled, false);
  assert.equal(fs.statSync(dir).isDirectory(), true);

  mem.append('g', { text: 'hi' });
  assert.deepEqual(mem.recent('g').map((r) => r.text), ['hi']);
  assert.deepEqual(new GroupMemory({ dir }).recent('g').map((r) => r.text), ['hi']);
});

// 11. 垃圾行容错
test('手工塞垃圾行（not json / {"foo":1} / [1,2,3]）：不崩、有效消息还在、warn 过', () => {
  const dir = path.join(root, 't11');
  const memA = new GroupMemory({ dir });
  memA.append('g', { ts: 1, userId: 1, nickname: 'A', text: '好的一条' });
  memA.append('g', { ts: 2, userId: 2, nickname: 'B', text: '好的两条' });

  const file = path.join(dir, 'g.jsonl');
  fs.appendFileSync(file, 'not json\n{"foo":1}\n[1,2,3]\n', 'utf8');
  assert.equal(readLines(file).length, 5);

  const { warns, log } = makeLog();
  const memB = new GroupMemory({ dir, log }); // 新实例 → 冷缓存 → 触发加载

  assert.deepEqual(memB.recent('g', 10).map((r) => r.text), ['好的一条', '好的两条']);
  assert.ok(warns.length >= 1, '损坏行必须至少 warn 一次');
  assert.equal(memB.stats().totalMessages, 2);
  assert.equal(memB.digest('g').split('\n').length, 3); // header + 2 条
});

// 12. 群号 → 文件名安全
test('群号做文件名安全处理：编码、超长截断、无路径穿越', () => {
  const dir = path.join(root, 't12');
  const mem = new GroupMemory({ dir });

  mem.append('../../evil', { text: 'a' });
  mem.append('群 200000001', { text: 'b' });
  mem.append('C:\\Windows\\x', { text: 'c' });

  const files = jsonlFiles(dir);
  assert.equal(files.length, 3);
  for (const f of files) {
    assert.ok(!f.includes('/'), `文件名不能带 /：${f}`);
    assert.ok(!f.includes('\\'), `文件名不能带 \\：${f}`);
    assert.ok(!f.includes(':'), `文件名不能带 :：${f}`);
    const stem = f.replace(/\.jsonl$/, '');
    assert.ok(stem.length <= 100, `文件名主干过长（${stem.length}）：${stem}`);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.jsonl')), false);

  // 超长群号：截断 + 短哈希，且还能按同一个群号读回
  const longId = 'x'.repeat(400);
  mem.append(longId, { text: '超长群号' });
  const after = jsonlFiles(dir);
  assert.equal(after.length, 4);
  for (const f of after) assert.ok(f.replace(/\.jsonl$/, '').length <= 100);
  assert.deepEqual(mem.recent(longId).map((r) => r.text), ['超长群号']);
  assert.deepEqual(new GroupMemory({ dir }).recent(longId).map((r) => r.text), ['超长群号']);

  // 中文群号也得能持久化回来
  assert.deepEqual(new GroupMemory({ dir }).recent('群 200000001').map((r) => r.text), ['b']);
});

// 13. 初始化失败降级
test('dir 缺失 / 指向文件：不抛异常，disabled，所有方法返回安全值', () => {
  const mem = new GroupMemory({});
  assert.equal(mem.disabled, true);
  assert.deepEqual(mem.recent('g'), []);
  assert.equal(mem.digest('g'), '');
  mem.append('g', { text: 'x' });
  mem.clear('g');
  assert.deepEqual(mem.stats(), { groups: 0, totalMessages: 0, dir: '' });

  // dir 其实是个文件 → mkdir 失败 → 同样降级
  const dir = path.join(root, 't13');
  fs.mkdirSync(dir, { recursive: true });
  const asFile = path.join(dir, 'i-am-a-file');
  fs.writeFileSync(asFile, 'x', 'utf8');

  const { warns, log } = makeLog();
  const mem2 = new GroupMemory({ dir: asFile, log });
  assert.equal(mem2.disabled, true);
  assert.equal(mem2.digest('g'), '');
  assert.ok(warns.length >= 1);
});

// 14. 没有 logger 也不能崩
test('不传 log 时一切照旧，且不会 fallback 到 console', () => {
  const dir = path.join(root, 't14');
  const mem = new GroupMemory({ dir });
  mem.append('g', { text: '静默' });
  assert.deepEqual(mem.recent('g').map((r) => r.text), ['静默']);
  // 没给 ts 时 append 会补 Date.now()，所以时间是真时间而不是 --:--
  assert.match(mem.digest('g'), /^\[群 g 最近 1 条\]\n\d{2}:\d{2} 未知: 静默$/);
  mem.clear('g');
  assert.deepEqual(mem.recent('g'), []);
});

// 15. 磁盘文件比 limit 长 → 只留 limit 条 + 下次 append 收紧
test('磁盘文件比 limit 长：首次只加载 limit 条，下次 append 补偿性收紧磁盘', () => {
  const dir = path.join(root, 't15');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'g.jsonl');

  const lines = [];
  for (let i = 1; i <= 12; i += 1) lines.push(JSON.stringify({ ts: i * 1000, text: `旧${i}` }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  assert.equal(readLines(file).length, 12);

  const mem = new GroupMemory({ dir, limit: 5 });
  assert.deepEqual(
    mem.recent('g', 100).map((r) => r.text),
    ['旧8', '旧9', '旧10', '旧11', '旧12'],
  );
  // 只是读，不写盘
  assert.equal(readLines(file).length, 12);

  // 下次 append 触发 dirty 补偿：磁盘收紧到 limit 行
  mem.append('g', { ts: 13000, text: '新13' });
  const after = readLines(file).map((l) => JSON.parse(l).text);
  assert.equal(after.length, 5);
  assert.deepEqual(after, ['旧9', '旧10', '旧11', '旧12', '新13']);
  assert.equal(new GroupMemory({ dir, limit: 5 }).stats().totalMessages, 5);
});

// 16. 存储格式逐字校验
test('存储格式：一行一条 JSON，缺省字段不写键', () => {
  const dir = path.join(root, 't16');
  const mem = new GroupMemory({ dir });

  mem.append('g', {
    ts: 1792427196000,
    userId: 1819709466,
    nickname: 'ski',
    text: '今天谁值班',
    messageId: 1250079138,
  });
  mem.append('g', { ts: 1792427196001, text: '没有其它字段' });
  mem.append('g', { ts: 1792427196002, text: '带图', images: 3 });

  const lines = readLines(path.join(dir, 'g.jsonl'));
  assert.equal(lines.length, 3);
  // 与规格里给的那行完全一致（键顺序也一样）
  assert.equal(
    lines[0],
    '{"ts":1792427196000,"userId":1819709466,"nickname":"ski","text":"今天谁值班","messageId":1250079138}',
  );
  assert.deepEqual(Object.keys(JSON.parse(lines[1])), ['ts', 'text']);
  assert.equal(JSON.parse(lines[2]).images, 3);
});

/* -------------------- 跑测试 -------------------- */

let pass = 0;
for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    console.log(`FAIL  ${c.name}`);
    const text = String(err?.stack || err);
    console.log(
      text
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉也不影响结果 */
}

console.log(`\n通过 ${pass} / ${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
