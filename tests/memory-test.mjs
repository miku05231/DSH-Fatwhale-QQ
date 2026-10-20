#!/usr/bin/env node
/**
 * tests/memory-test.mjs —— ObsidianMemory 的回归测试
 *
 * 全部在 `node:os` 的临时目录里跑，绝不碰真实的 Obsidian 库。
 * 跑法：node tests\memory-test.mjs
 * 结束打印：通过 N 项，失败 0 项（有失败时退出码 1）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ObsidianMemory,
  DEFAULT_ROOT,
  DIRS,
  DIR_DAILY,
  DIR_GROUP,
  DIR_NOTE,
  DIR_PERSON,
  INDEX_FILE,
} from '../src/memory.js';

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
let failed = 0;
const failures = [];

/** 通过一项 */
function ok(cond, name, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`);
  return false;
}

/** 相等断言 */
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(same, name, same ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 包含断言（字符串/数组） */
function includes(haystack, needle, name) {
  const hit = typeof haystack === 'string' ? haystack.includes(needle) : Array.isArray(haystack) && haystack.includes(needle);
  return ok(hit, name, hit ? '' : `找不到 ${JSON.stringify(needle)}`);
}

/** 期望抛错（同步或异步都行） */
async function rejects(fn, name, match = '') {
  try {
    await fn();
  } catch (err) {
    const msg = String(err?.message ?? err);
    return ok(match === '' || msg.includes(match), name, match === '' ? '' : `错误信息是「${msg}」`);
  }
  return ok(false, name, '居然没有报错');
}

/** 读记忆库里的相对文件 */
function readRel(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

function existsRel(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

/** 递归找 .tmp 残留 */
function findTmp(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/* ------------------------------------------------------------------ 跑测试 */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
  console.log(`临时记忆库：${tmp}`);
  console.log('');

  const mem = new ObsidianMemory({ root: tmp });

  /* ---------------- 1. ensure ---------------- */
  console.log('1. ensure 建目录');
  const first = await mem.ensure();
  eq(first.root, tmp, 'ensure 返回根目录');
  ok(fs.existsSync(tmp), '记忆库根目录已创建');
  for (const dir of DIRS) {
    ok(fs.existsSync(path.join(tmp, dir)), `目录存在：${dir}`);
  }
  ok(existsRel(tmp, INDEX_FILE), '根索引页已创建');
  eq(first.created.length, 6, '首次 ensure 创建 6 个文件（根页 + 5 个索引）');

  const second = await mem.ensure();
  eq(second.created.length, 0, 'ensure 幂等：第二次不再创建任何文件');
  ok(fs.existsSync(tmp), 'ensure 幂等：目录还在');

  /* ---------------- 2. captureTurn ---------------- */
  console.log('');
  console.log('2. captureTurn 写日志');
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const dailyRel = `${DIR_DAILY}/${todayStr}.md`;

  const turn = await mem.captureTurn({
    userId: '10001',
    nickname: '小明',
    groupId: '700001',
    groupName: '测试群',
    userText: '今天吃红烧肉',
    replyText: '听起来不错',
  });
  ok(turn && turn.ok === true, 'captureTurn 报告成功');
  eq(turn.daily, dailyRel, 'captureTurn 返回日志相对路径');
  ok(existsRel(tmp, dailyRel), `写出当天日志：${dailyRel}`);

  const dailyText = readRel(tmp, dailyRel);
  includes(dailyText, '小明(10001)', '日志里有说话人和 QQ 号');
  includes(dailyText, '今天吃红烧肉', '日志里有用户原话');
  includes(dailyText, '我：', '日志里有我的回复标记');
  includes(dailyText, '听起来不错', '日志里有回复内容');
  includes(dailyText, '700001', '日志里标了群号');
  ok(existsRel(tmp, `${DIR_PERSON}/10001.md`), 'captureTurn 顺手建了人物页');
  ok(existsRel(tmp, `${DIR_GROUP}/700001.md`), 'captureTurn 顺手建了群页');

  /* ---------------- 3. appendDaily 追加不覆盖 ---------------- */
  console.log('');
  console.log('3. appendDaily 追加');
  await mem.appendDaily('第一条手写日志');
  const midText = readRel(tmp, dailyRel);
  await mem.appendDaily('第二条手写日志');
  const afterText = readRel(tmp, dailyRel);
  includes(afterText, '第一条手写日志', '追加后第一条还在（没被覆盖）');
  includes(afterText, '第二条手写日志', '第二次追加的内容在');
  includes(afterText, '今天吃红烧肉', 'appendDaily 没冲掉 captureTurn 的内容');
  ok(afterText.length > midText.length, '追加后文件变长');

  /* ---------------- 4. upsertPerson 合并 ---------------- */
  console.log('');
  console.log('4. upsertPerson 合并');
  const p1 = await mem.upsertPerson({ qq: '20002', nickname: '阿花', facts: ['喜欢猫'] });
  eq(p1.created, true, '第一次 upsertPerson 是新建');
  eq(p1.added, 1, '第一次写入 1 条记忆');
  const p2 = await mem.upsertPerson({ qq: '20002', facts: ['住在杭州'] });
  eq(p2.created, false, '第二次 upsertPerson 是更新');
  eq(p2.added, 1, '第二次只新增 1 条记忆');

  const personText = readRel(tmp, `${DIR_PERSON}/20002.md`);
  includes(personText, '喜欢猫', '第一条记忆还在');
  includes(personText, '住在杭州', '第二条记忆也写进去了');
  includes(personText, '阿花', '昵称保留');
  ok(
    personText.split('喜欢猫').length - 1 === 1,
    '同一条记忆没有在页面里重复出现',
  );

  const p3 = await mem.upsertPerson({ qq: '20002', facts: ['喜欢猫', '  喜欢猫。 '] });
  eq(p3.added, 0, '重复事实（含标点/空格差异）不重复写入');

  /* ---------------- 5. upsertGroup ---------------- */
  console.log('');
  console.log('5. upsertGroup');
  const g1 = await mem.upsertGroup({ groupId: '30003', name: '闲聊群', topic: '日常', facts: ['气氛轻松'] });
  eq(g1.created, true, '第一次 upsertGroup 是新建');
  const g2 = await mem.upsertGroup({ groupId: '30003', name: '闲聊群2', facts: ['喜欢发表情'] });
  eq(g2.created, false, '第二次 upsertGroup 是更新');
  const groupText = readRel(tmp, `${DIR_GROUP}/30003.md`);
  includes(groupText, '闲聊群2', '群名被更新');
  includes(groupText, '日常', '群话题保留');
  includes(groupText, '气氛轻松', '群记忆 1 在');
  includes(groupText, '喜欢发表情', '群记忆 2 在');

  /* ---------------- 6. writeNote ---------------- */
  console.log('');
  console.log('6. writeNote');
  const note1 = await mem.writeNote({
    title: '红烧肉做法',
    body: '五花肉焯水，冰糖炒糖色，小火慢炖四十分钟。',
    tags: ['菜谱'],
  });
  eq(note1.created, true, '第一次 writeNote 新建');
  includes(note1.path, DIR_NOTE, '默认写进知识目录');
  ok(existsRel(tmp, note1.path), '笔记文件真的写出来了');
  const noteText = readRel(tmp, note1.path);
  includes(noteText, '红烧肉做法', '笔记有标题');
  includes(noteText, '小火慢炖', '笔记有正文');
  includes(noteText, '菜谱', '笔记有标签');

  const note2 = await mem.writeNote({ title: '红烧肉做法', body: '改成先煎后炖。' });
  eq(note2.created, false, '同名笔记第二次是覆盖');
  const noteText2 = readRel(tmp, note2.path);
  includes(noteText2, '改成先煎后炖', '笔记正文被覆盖');
  ok(!noteText2.includes('冰糖炒糖色'), '旧正文没残留');

  /* ---------------- 7. search 中文 ---------------- */
  console.log('');
  console.log('7. search 中文');
  const cn = await mem.search('红烧肉');
  ok(cn.length > 0, '中文查询有命中');
  const cnPaths = cn.map((h) => h.path);
  includes(cnPaths, note2.path, '命中了笔记页');
  const top = cn[0];
  eq(typeof top.path, 'string', '结果有 path');
  eq(typeof top.title, 'string', '结果有 title');
  eq(typeof top.score, 'number', '结果有 score');
  eq(typeof top.snippet, 'string', '结果有 snippet');
  ok(top.snippet.length > 0, '摘录非空');
  ok(!top.path.includes('\\'), 'path 用 / 分隔');

  const cnPerson = await mem.search('杭州');
  includes(cnPerson.map((h) => h.path), `${DIR_PERSON}/20002.md`, '中文查询命中了人物页');
  includes(cnPerson[0].snippet, '杭州', '摘录里带命中词');

  const cnGroup = await mem.search('轻松');
  ok(cnGroup.length >= 1, '中文查询「轻松」有命中');

  /* ---------------- 8. search 英文/数字 ---------------- */
  console.log('');
  console.log('8. search 英文与数字');
  await mem.writeNote({ title: 'Obsidian memory design', body: 'Atomic writes and tokenized search.' });
  const en = await mem.search('obsidian');
  ok(en.length > 0, '英文小写查询有命中（不区分大小写）');
  includes(en.map((h) => h.title), 'Obsidian memory design', '命中了英文笔记');

  const en2 = await mem.search('ATOMIC');
  ok(en2.length > 0, '英文大写查询也能命中');

  const num = await mem.search('20002');
  includes(num.map((h) => h.path), `${DIR_PERSON}/20002.md`, '数字（QQ 号）查询命中人物页');

  const multi = await mem.search('红烧肉 Obsidian');
  ok(multi.length >= 2, '中英混合查询有多个命中');

  /* ---------------- 9. search 空结果 ---------------- */
  console.log('');
  console.log('9. search 空结果');
  const none = await mem.search('完全不存在的关键词xyzzy');
  eq(none, [], '查不到就返回空数组');
  eq(await mem.search(''), [], '空查询返回空数组');
  eq(await mem.search('   '), [], '空白查询返回空数组');

  /* ---------------- 10. buildContext ---------------- */
  console.log('');
  console.log('10. buildContext');
  const ctx = await mem.buildContext('红烧肉', { userId: '20002', groupId: '30003' });
  ok(ctx.length > 0, '有记忆时返回非空文本');
  includes(ctx, '关于这个人', '包含「关于这个人」段');
  includes(ctx, '关于这个群', '包含「关于这个群」段');
  includes(ctx, '相关记忆', '包含「相关记忆」段');
  includes(ctx, '今天说过的话', '包含「今天说过的话」段');
  includes(ctx, '喜欢猫', '人物记忆被注入');

  const shortCtx = await mem.buildContext('红烧肉', {
    userId: '20002',
    groupId: '30003',
    maxChars: 120,
  });
  ok(shortCtx.length <= 120, `maxChars 生效（${shortCtx.length} <= 120）`, `实际 ${shortCtx.length}`);

  const tinyCtx = await mem.buildContext('红烧肉', { userId: '20002', maxChars: 40 });
  ok(tinyCtx.length <= 40, '极大压缩也不超限');

  const emptyMem = new ObsidianMemory({ root: path.join(tmp, 'empty-vault') });
  const emptyCtx = await emptyMem.buildContext('任何东西', { userId: '99999' });
  eq(emptyCtx, '', '没有记忆时返回空字符串');

  /* ---------------- 11. 路径穿越防护 ---------------- */
  console.log('');
  console.log('11. 路径穿越防护');
  await rejects(() => mem.readNote('../outside.md'), '拒绝 ../ 越界读取', '越界');
  await rejects(() => mem.readNote('C:/Windows/win.ini'), '拒绝绝对路径', '相对路径');
  await rejects(() => mem.readNote('\\\\server\\share\\x.md'), '拒绝 UNC 路径');
  await rejects(() => mem.readNote(''), '拒绝空路径');
  await rejects(
    () => mem.writeNote({ dir: '../跑路', title: '坏笔记', body: 'x' }),
    'writeNote 拒绝越界目录',
  );
  await rejects(
    () => mem.saveNote('10-人物/../../x.md', '正文'),
    'saveNote 拒绝中间夹 .. 的路径',
  );

  /* ---------------- 12. recentDaily ---------------- */
  console.log('');
  console.log('12. recentDaily');
  const recent = await mem.recentDaily(3);
  ok(recent.length >= 1, 'recentDaily 至少返回一天');
  eq(recent[0].date, todayStr, '最新一天是今天');
  includes(recent[0].content, '今天吃红烧肉', '日志内容完整');

  /* ---------------- 13. stats ---------------- */
  console.log('');
  console.log('13. stats');
  const s = await mem.stats();
  eq(s.root, tmp, 'stats.root 是记忆根');
  ok(s.files >= 8, `stats.files 数得清（${s.files}）`);
  ok(s.totalBytes > 0, 'stats.totalBytes 大于 0');
  eq(Object.keys(s.byDir).sort(), ['人物', '反思', '日志', '知识', '群聊'].sort(), 'byDir 五个类目齐全');
  ok(s.byDir['人物'] >= 2, '人物类目至少 2 个文件');
  ok(s.byDir['日志'] >= 1, '日志类目至少 1 个文件');
  ok(/^\d{4}-\d{2}-\d{2}/.test(s.lastUpdated), `lastUpdated 是时间字符串（${s.lastUpdated}）`);
  const fileCount = fs.readdirSync(tmp, { recursive: true }).filter((f) => String(f).endsWith('.md')).length;
  eq(s.files, fileCount, 'stats.files 与实际 md 文件数一致');

  /* ---------------- 14. 原子写没留残渣 ---------------- */
  console.log('');
  console.log('14. 原子写');
  eq(findTmp(tmp), [], '没有 .tmp 残留文件');

  /* ---------------- 15. 容错 ---------------- */
  console.log('');
  console.log('15. 容错');
  const silent = new ObsidianMemory({ root: tmp, log: { debug() { throw new Error('日志器炸了'); } } });
  const turn2 = await silent.captureTurn({ userId: '40004', nickname: '阿强', userText: '你好' });
  ok(turn2 && turn2.ok === true && turn2.daily === dailyRel, '日志器抛错也不影响 captureTurn 落盘');
  ok(existsRel(tmp, `${DIR_PERSON}/40004.md`), '日志器抛错时人物页仍然写出来了');

  // 用一个「父级是普通文件」的路径，保证 mkdir 一定失败（ENOTDIR），
  // 这样既测到 disabled 分支，又不会在真实磁盘上乱建目录。
  const blocker = path.join(tmp, 'blocker.txt');
  fs.writeFileSync(blocker, 'x');
  const disabled = new ObsidianMemory({ root: path.join(blocker, 'vault') });
  eq(disabled.disabled, true, '无法初始化的根目录进 disabled 状态');
  const dctx = await disabled.buildContext('x', { userId: '1' });
  ok(typeof dctx === 'string', '根目录不可用时 buildContext 仍返回字符串');
  const dstats = await disabled.stats();
  eq(dstats.files, 0, '根目录不可用时 stats 返回 0 个文件');

  /* ---------------- 收尾 ---------------- */
  console.log('');
  console.log('断言数：' + (passed + failed));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('失败项：');
    for (const name of failures) console.log(`  - ${name}`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'empty-vault'), { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉也无所谓，系统会清 */
  }

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('测试跑崩了：', err);
    process.exitCode = 2;
  });
