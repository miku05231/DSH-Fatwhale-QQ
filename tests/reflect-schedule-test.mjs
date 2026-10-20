// 记忆反思「一键 + 每天定时」的回归测试（纯函数 + 文件 + 子进程，全程不调模型）。
//
// 守护的是这几件容易翻车的事：
//   1) 时间判断：到点才跑、一天最多一次、电脑关着错过的那次要能补、别补一串；
//   2) 备份：--force 会整体重写「本周」那一篇，覆盖前必须先留 .bak，且旧备份要限量；
//   3) 锁：桥接和控制台是两个进程，同一时刻只能有一次反思在跑（否则一次反思
//      要开一次 dsh，多开就是烧钱）；
//   4) 记账：跑完要写 state/reflect-state.json，控制台 / 桥接靠它互相汇报。
//
// 所有会写盘的东西都在临时目录里，跑完删干净，不碰真实记忆库。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  REFLECT_DEFAULTS,
  parseClock,
  normalizeReflectSettings,
  nextRunAt,
  dailyDue,
  dayKey,
  isoWeekLabel,
  reflectionPath,
  backupReflectionFile,
  countBackups,
  acquireReflectLock,
  isReflectLocked,
  reflectLockPath,
  reflectStatePath,
  readReflectState,
  writeReflectState,
  summarizeLines,
  runReflect,
  createReflectScheduler,
} from '../src/reflect.js';

let passed = 0;
let failed = 0;
const ok = (label, extra) => {
  passed += 1;
  console.log(`  ✔ ${label}${extra ? `  — ${extra}` : ''}`);
};
const bad = (label, extra) => {
  failed += 1;
  console.log(`  ✘ ${label}${extra ? `  — ${extra}` : ''}`);
};
const section = (title) => console.log(`\n[${title}]`);

const tmpDirs = [];
async function tmpDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `qq-reflect-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 造一个假项目根：只放一个 tools/reflect.mjs，行为可控，永不调模型 */
async function fakeProject({ exitCode = 0, lines = ['[反思] 记忆库 CLI：假的', '[反思] 已写入 50-反思/反思 2000-W01.md', '[反思] 完成于 2000-01-01'] } = {}) {
  const root = await tmpDir('proj');
  await fsp.mkdir(path.join(root, 'tools'), { recursive: true });
  const body = [
    'const code = Number(process.env.FAKE_EXIT ?? ' + JSON.stringify(exitCode) + ');',
    `for (const line of ${JSON.stringify(lines)}) console.log(line);`,
    'process.exitCode = code;',
  ].join('\n');
  await fsp.writeFile(path.join(root, 'tools', 'reflect.mjs'), body, 'utf8');
  return root;
}

async function main() {
  console.log(`记忆反思（一键 + 每天定时）测试\n`);

  // ---------------------------------------------------------------- 1
  section('1/8 解析时间');
  {
    const a = parseClock('04:00');
    if (a && a.hour === 4 && a.minute === 0) ok('04:00 → 4:0');
    else bad('04:00 解析失败', JSON.stringify(a));

    const b = parseClock('23:59');
    if (b && b.hour === 23 && b.minute === 59) ok('23:59 → 23:59');
    else bad('23:59 解析失败', JSON.stringify(b));

    for (const badValue of ['24:00', '4:00', '04:60', '', 'abc', null, ' 04:00 ']) {
      const expected = badValue === ' 04:00 ' ? true : false;
      const got = parseClock(badValue);
      if (Boolean(got) === expected) ok(`非法值 ${JSON.stringify(badValue)} 处理正确`, got ? `${got.hour}:${got.minute}` : '拒绝');
      else bad(`非法值 ${JSON.stringify(badValue)} 处理错误`, JSON.stringify(got));
    }
  }

  // ---------------------------------------------------------------- 2
  section('2/8 设置归一化');
  {
    const def = normalizeReflectSettings({});
    if (def.daily === REFLECT_DEFAULTS.daily && def.time === REFLECT_DEFAULTS.time && def.days === 3) {
      ok('空配置 → 默认值', JSON.stringify(def));
    } else bad('空配置默认值不对', JSON.stringify(def));

    const weird = normalizeReflectSettings({ reflectTime: '4:00', reflectDays: 99, reflectDaily: false });
    if (weird.time === '04:00') ok('写错的时间（4:00）退回默认，不报错', weird.time);
    else bad('写错的时间没有退回默认', weird.time);
    if (weird.days === 30) ok('天数上限钳到 30', String(weird.days));
    else bad('天数没有钳制', String(weird.days));
    if (weird.daily === false) ok('daily=false 保留');
    else bad('daily=false 丢了');

    const low = normalizeReflectSettings({ reflectDays: 0 });
    if (low.days === 1) ok('天数下限钳到 1', String(low.days));
    else bad('天数下限没钳住', String(low.days));
  }

  // ---------------------------------------------------------------- 3
  section('3/8 下次运行时间');
  {
    const now = new Date(2026, 9, 20, 3, 30, 0); // 10-20 03:30
    const next = nextRunAt('04:00', now);
    if (dayKey(next) === '2026-10-20' && next.getHours() === 4) ok('03:30 时，下次是今天 04:00', next.toString());
    else bad('下次时间算错', next.toString());

    const now2 = new Date(2026, 9, 20, 4, 30, 0);
    const next2 = nextRunAt('04:00', now2);
    if (dayKey(next2) === '2026-10-21' && next2.getHours() === 4) ok('04:30 时，下次是明天 04:00', next2.toString());
    else bad('跨天算错', next2.toString());

    const exactly = nextRunAt('04:00', new Date(2026, 9, 20, 4, 0, 0));
    if (dayKey(exactly) === '2026-10-21') ok('正好 04:00 时取明天（严格晚于 now）');
    else bad('正好到点时没有推到明天', exactly.toString());
  }

  // ---------------------------------------------------------------- 4
  section('4/8 到点判断（dailyDue）');
  {
    const s = { daily: true, time: '04:00', catchUp: true };

    const before = dailyDue({ settings: s, now: new Date(2026, 9, 20, 3, 0), lastDateKey: '2026-10-19' });
    if (!before) ok('今天没到点、昨天跑过了 → 不跑');
    else bad('不该跑却要跑', JSON.stringify(before));

    const catchUp = dailyDue({ settings: s, now: new Date(2026, 9, 20, 3, 0), lastDateKey: '2026-10-18' });
    if (catchUp && catchUp.scheduledFor === '2026-10-19' && catchUp.catchUp) ok('今天没到点、昨天漏了 → 补昨天');
    else bad('补跑判断错', JSON.stringify(catchUp));

    const never = dailyDue({ settings: s, now: new Date(2026, 9, 20, 3, 0), lastDateKey: '' });
    if (never && never.catchUp) ok('从来没跑过 → 启动后补一次');
    else bad('首次启动没有补跑', JSON.stringify(never));

    const after = dailyDue({ settings: s, now: new Date(2026, 9, 20, 5, 0), lastDateKey: '2026-10-19' });
    if (after && after.scheduledFor === '2026-10-20' && !after.catchUp) ok('过了今天 04:00 → 今天正常跑');
    else bad('到点后没跑', JSON.stringify(after));

    const sameDay = dailyDue({ settings: s, now: new Date(2026, 9, 20, 5, 0), lastDateKey: '2026-10-20' });
    if (!sameDay) ok('今天已经跑过 → 一天不跑第二次');
    else bad('同一天跑了第二次', JSON.stringify(sameDay));

    const weekOff = dailyDue({ settings: s, now: new Date(2026, 9, 20, 5, 0), lastDateKey: '2026-10-14' });
    if (weekOff && weekOff.scheduledFor === '2026-10-20') ok('关了六天再开 → 只补一次（不补一串）', weekOff.scheduledFor);
    else bad('关机多天后补跑逻辑错', JSON.stringify(weekOff));

    const noCatch = dailyDue({ settings: { ...s, catchUp: false }, now: new Date(2026, 9, 20, 3, 0), lastDateKey: '2026-10-18' });
    if (!noCatch) ok('catchUp=false 时不补跑');
    else bad('关了补跑还在补', JSON.stringify(noCatch));

    const off = dailyDue({ settings: { ...s, daily: false }, now: new Date(2026, 9, 20, 5, 0), lastDateKey: '' });
    if (!off) ok('daily=false 时永远不跑');
    else bad('关掉定时还在跑', JSON.stringify(off));
  }

  // ---------------------------------------------------------------- 5
  section('5/8 周标签与文件路径');
  {
    const label = isoWeekLabel(new Date(2026, 9, 20, 12, 0)); // 2026-10-20 周二
    if (label === '2026-W43') ok('2026-10-20 → 2026-W43', label);
    else bad('ISO 周算错', label);

    const monday = isoWeekLabel(new Date(2026, 9, 19, 0, 1)); // 周一
    const sunday = isoWeekLabel(new Date(2026, 9, 25, 23, 59)); // 同周周日
    if (monday === sunday) ok('同一周的周一和周日标签一致', monday);
    else bad('跨周边界错', `${monday} vs ${sunday}`);

    const newYear = isoWeekLabel(new Date(2027, 0, 1, 12, 0)); // 2027-01-01 周五 → 21 属于 2026-W53
    if (/^\d{4}-W\d{2}$/.test(newYear)) ok('元旦附近格式正确', newYear);
    else bad('元旦附近格式错', newYear);

    const dir = await tmpDir('mem');
    const file = reflectionPath(dir, new Date(2026, 9, 20, 12, 0));
    const expect = path.join(dir, '50-反思', '反思 2026-W43.md');
    if (file === expect) ok('反思路径与 tools/reflect.mjs 的命名一致', '50-反思/反思 2026-W43.md');
    else bad('反思路径不对', file);

    if (reflectionPath('') === '') ok('没有记忆库根目录时返回空串');
    else bad('空根目录应当返回空串');
  }

  // ---------------------------------------------------------------- 6
  section('6/8 覆盖前备份');
  {
    const dir = await tmpDir('bak');
    const file = path.join(dir, '50-反思', '反思 2026-W43.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '原文', 'utf8');

    const first = await backupReflectionFile(file);
    if (first && fs.existsSync(first) && (await fsp.readFile(first, 'utf8')) === '原文') ok('备份内容与原文一致', path.basename(first));
    else bad('备份没生成或内容不对', String(first));

    if ((await countBackups(file)) === 1) ok('备份计数 1');
    else bad('备份计数不对', String(await countBackups(file)));

    if (!first.endsWith('.md')) ok('备份不以 .md 结尾（记忆库索引不会把它当笔记）', path.basename(first));
    else bad('备份会污染记忆库索引', first);

    // 再备两次，keep=2 只留最近两份
    await new Promise((r) => setTimeout(r, 1100));
    await backupReflectionFile(file, { keep: 2 });
    await new Promise((r) => setTimeout(r, 1100));
    await backupReflectionFile(file, { keep: 2 });
    const kept = await countBackups(file);
    if (kept === 2) ok('旧备份按 keep 限量（留 2 份）', `${kept} 份`);
    else bad('旧备份没有限量', `${kept} 份`);

    const missing = await backupReflectionFile(path.join(dir, '不存在.md'));
    if (missing === null) ok('原文件不存在 → 返回 null（不报错）');
    else bad('原文件不存在时行为不对', String(missing));
  }

  // ---------------------------------------------------------------- 7
  section('7/8 锁（跨进程互斥）');
  {
    const dir = await tmpDir('lock');
    const a = await acquireReflectLock(dir, { holder: 'manual' });
    if (a) ok('第一次抢锁成功');
    else bad('第一次抢锁失败');

    const b = await acquireReflectLock(dir, { holder: 'daily' });
    if (b === null) ok('第二次抢锁失败（同时只允许一次反思）');
    else bad('居然允许两次并发反思');

    if (await isReflectLocked(dir)) ok('isReflectLocked 看到锁');
    else bad('isReflectLocked 没看到锁');

    await a.release();
    if (!(await isReflectLocked(dir))) ok('释放后锁消失');
    else bad('释放后锁还在');

    // 僵尸锁：锁文件在，但时间戳很旧 → 可以抢
    await fsp.writeFile(reflectLockPath(dir), JSON.stringify({ pid: 1 }), 'utf8');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(reflectLockPath(dir), longAgo, longAgo);
    const revived = await acquireReflectLock(dir, { holder: 'manual' });
    if (revived) {
      ok('超过 staleMs 的僵尸锁会被接管');
      await revived.release();
    } else bad('僵尸锁挡住了新任务');
  }

  // ---------------------------------------------------------------- 8
  section('8/8 端到端（假 reflect.mjs，不调模型）');
  {
    // 8.1 正常跑一次：备份 + 记账 + 输出行
    const projectRoot = await fakeProject();
    const stateDir = await tmpDir('state');
    const memRoot = await tmpDir('mem2');
    const paper = reflectionPath(memRoot);
    await fsp.mkdir(path.dirname(paper), { recursive: true });
    await fsp.writeFile(paper, '本周旧反思', 'utf8');

    const seen = [];
    const result = await runReflect({
      stateDir,
      projectRoot,
      memoryRoot: memRoot,
      trigger: 'manual',
      force: true,
      days: 3,
      backup: true,
      onLine: (line) => seen.push(line),
    });

    if (result.ok && result.exitCode === 0) ok('runReflect 返回成功');
    else bad('runReflect 失败', JSON.stringify({ code: result.exitCode, message: result.message }));

    if (result.backupPath && fs.existsSync(result.backupPath)) ok('--force 前自动备份了本周笔记', path.basename(result.backupPath));
    else bad('没有备份就重写了', String(result.backupPath));

    const st = await readReflectState(stateDir);
    if (st.lastOk === true && st.runningSince === null && st.lastRunAt) ok('状态文件记下了「跑完且成功」');
    else bad('状态文件不对', JSON.stringify(st));
    if (st.lastTrigger === 'manual' && st.lastBackup) ok('状态里记了触发来源和备份路径');
    else bad('状态缺字段', JSON.stringify(st));
    if (Array.isArray(st.lastLines) && st.lastLines.length > 0) ok('状态里留了最后几行输出', `${st.lastLines.length} 行`);
    else bad('状态里没有输出行');

    if (seen.some((line) => /已备份本周反思/.test(line))) ok('onLine 收到了备份提示');
    else bad('onLine 没收到备份提示', seen.join(' | ').slice(0, 120));
    if (seen.some((line) => /已写入/.test(line))) ok('onLine 收到了脚本输出');
    else bad('onLine 没收到脚本输出');

    if (!(await isReflectLocked(stateDir))) ok('跑完后锁已释放');
    else bad('跑完后锁没释放');

    // 8.2 失败要记账
    const badProject = await fakeProject({ exitCode: 2, lines: ['[反思] 读日志失败：假的'] });
    const failState = await tmpDir('state2');
    const failRun = await runReflect({
      stateDir: failState,
      projectRoot: badProject,
      trigger: 'daily',
      force: false,
      days: 3,
      backup: false,
      dailyDate: '2026-10-20',
    });
    if (!failRun.ok && failRun.exitCode === 2) ok('脚本失败时 runReflect 报失败');
    else bad('失败没有被识别', JSON.stringify({ ok: failRun.ok, code: failRun.exitCode }));

    const failSt = await readReflectState(failState);
    if (failSt.lastOk === false && failSt.lastDailyDate === '2026-10-20') ok('失败也记了日期（不会每分钟重试轰炸）');
    else bad('失败没记日期', JSON.stringify(failSt));

    // 8.3 抢不到锁 → REFLECT_BUSY
    const busyState = await tmpDir('state3');
    const holder = await acquireReflectLock(busyState, { holder: 'daily' });
    let busyErr = null;
    try {
      await runReflect({ stateDir: busyState, projectRoot, trigger: 'manual' });
    } catch (err) {
      busyErr = err;
    }
    if (busyErr && busyErr.code === 'REFLECT_BUSY') ok('别的进程在跑时抛 REFLECT_BUSY');
    else bad('并发时没有拦住', String(busyErr?.message ?? '没抛错'));
    await holder.release();

    // 8.4 定时器：到点跑一次，同一天不跑第二次
    const cfgDir = await tmpDir('cfg');
    const configPath = path.join(cfgDir, 'config.json');
    const past = new Date(Date.now() - 60 * 1000);
    const hhmm = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
    await fsp.writeFile(configPath, JSON.stringify({ memory: { reflectDaily: true, reflectTime: hhmm, reflectForce: true, reflectDays: 3 } }), 'utf8');

    const schedState = await tmpDir('state4');
    const calls = [];
    const scheduler = createReflectScheduler({
      configPath,
      stateDir: schedState,
      projectRoot,
      memoryRoot: memRoot,
      intervalMs: 60_000,
      run: async (opts) => {
        calls.push(opts);
        return { ok: true, exitCode: 0, lines: [], message: '假的' };
      },
    });

    const firstTick = await scheduler.tick();
    if (firstTick && calls.length === 1) ok('到点了 tick 会跑一次', `${calls[0].trigger}`);
    else bad('tick 没有触发', JSON.stringify({ firstTick, calls: calls.length }));

    // runReflect 是假的，dailyDate 得由真实 runReflect 记账；这里手动补上再 tick 一次
    await writeReflectState(schedState, { lastDailyDate: dayKey(new Date()) });
    const secondTick = await scheduler.tick();
    if (secondTick === null && calls.length === 1) ok('同一天第二次 tick 不再跑');
    else bad('同一天重复触发', JSON.stringify({ secondTick, calls: calls.length }));

    // 8.5 关掉定时就不跑
    await fsp.writeFile(configPath, JSON.stringify({ memory: { reflectDaily: false } }), 'utf8');
    await writeReflectState(schedState, { lastDailyDate: '' });
    const offTick = await scheduler.tick();
    if (offTick === null) ok('reflectDaily=false 时 tick 什么都不做');
    else bad('关掉定时后仍在跑');

    // 8.6 summarizeLines 挑得准
    const summary = summarizeLines(['[反思] 记忆库 CLI：x', '[反思] 已写入 50-反思/反思 2026-W43.md']);
    if (/已写入/.test(summary)) ok('summarizeLines 挑到最后那句结果', summary);
    else bad('summarizeLines 挑错行', summary);
    if (summarizeLines([]) === '') ok('空输出不炸');
    else bad('空输出处理不对');
  }

  // ---------------------------------------------------------------- 收尾
  for (const dir of tmpDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(52));
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试异常：', err?.stack ?? err);
  process.exitCode = 1;
});
