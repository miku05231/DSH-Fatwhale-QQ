// src/reflect.js —— 记忆反思的「一键运行 + 每天定时」（零依赖）
//
// 为什么单独一个模块：桥接（src/index.js）和控制台（src/webui/server.mjs）都要能
// 触发反思，而这是**两个进程**。所以这里把三件事收到一起做：
//   1) 一把锁（state/reflect.lock）—— 同一时刻只允许一次反思在跑。手动点按钮
//      撞上定时任务时，不会同时开两个模型调用（一次反思要调一次 dsh，很贵）。
//   2) 一本账（state/reflect-state.json）—— 谁跑的、成没成、上次输出几行。
//      两个进程共读同一个文件，控制台刷新一下就能看到桥接那边跑的定时任务结果。
//   3) 一份备份 —— tools/reflect.mjs 的 --force 会**整体重写本周**的
//      `50-反思/反思 YYYY-Www.md`，覆盖前先留一份 `.bak-<时间>`。
//
// 时间规则（纯函数 dailyDue，方便测试）：
//   - 到点就跑，一天最多一次（记 state.lastDailyDate）；
//   - catchUp 打开时，如果到点那一刻桥接没在跑（电脑关着 / 刚重启），
//     启动后补跑上一次错过的那天，且只补一次，不会补一串。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { killProcessTree } from './dsh.js';

/** 默认设置（与 src/config.js 的 DEFAULTS.memory.reflect* 保持一致） */
export const REFLECT_DEFAULTS = Object.freeze({
  daily: true,
  time: '04:00',
  force: true,
  days: 3,
  backup: true,
  catchUp: true,
});

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- 设置

/** "04:00" → {hour:4, minute:0}；不合法返回 null */
export function parseClock(value) {
  const m = CLOCK_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function boolOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return Boolean(value);
}

/**
 * 把 config.memory.* 归一化成 reflect 设置。
 * 时间写错不报错、退回默认值 —— 反思是后台任务，绝不能因为一个手滑的
 * "4:00" 就让桥接起不来。
 */
export function normalizeReflectSettings(memory = {}) {
  const src = memory && typeof memory === 'object' ? memory : {};
  const clock = parseClock(src.reflectTime) ?? parseClock(REFLECT_DEFAULTS.time);
  return {
    daily: boolOf(src.reflectDaily, REFLECT_DEFAULTS.daily),
    force: boolOf(src.reflectForce, REFLECT_DEFAULTS.force),
    days: clampInt(src.reflectDays, 1, 30, REFLECT_DEFAULTS.days),
    backup: boolOf(src.reflectBackup, REFLECT_DEFAULTS.backup),
    catchUp: boolOf(src.reflectCatchUp, REFLECT_DEFAULTS.catchUp),
    time: `${pad2(clock.hour)}:${pad2(clock.minute)}`,
  };
}

// ---------------------------------------------------------------- 时间

/** 本地日期键 `YYYY-MM-DD`（比大小就是比时间，跨年也对） */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 某天 HH:MM 的本地时刻 */
export function atClock(date, hour, minute) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

/** 下一次该跑的时刻（严格晚于 now，用于控制台「下次运行」提示） */
export function nextRunAt(timeText, now = new Date()) {
  const clock = parseClock(timeText) ?? parseClock(REFLECT_DEFAULTS.time);
  const at = atClock(now, clock.hour, clock.minute);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * 今天/昨天是不是该跑一次（纯函数）。
 * @returns {{scheduledFor: string, at: Date, catchUp: boolean}|null}
 */
export function dailyDue({ settings, now = new Date(), lastDateKey = '' } = {}) {
  const s = settings ?? {};
  if (s.daily === false) return null;
  const clock = parseClock(s.time) ?? parseClock(REFLECT_DEFAULTS.time);
  const todayAt = atClock(now, clock.hour, clock.minute);
  const todayKey = dayKey(todayAt);

  if (now.getTime() >= todayAt.getTime()) {
    if (lastDateKey === todayKey) return null;
    return { scheduledFor: todayKey, at: todayAt, catchUp: false };
  }
  if (s.catchUp === false) return null;

  const yesterdayAt = new Date(todayAt.getTime() - DAY_MS);
  const yesterdayKey = dayKey(yesterdayAt);
  // 已经跑过昨天（或今天更早）就不再补
  if (lastDateKey && lastDateKey >= yesterdayKey) return null;
  return { scheduledFor: yesterdayKey, at: yesterdayAt, catchUp: true };
}

// ---------------------------------------------------------------- 反思文件

/**
 * 本周反思笔记的绝对路径。
 * 名字必须和 tools/reflect.mjs 的 isoWeek() 逐字一致，否则备份不到真文件。
 */
export function isoWeekLabel(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function reflectionPath(memoryRoot, date = new Date()) {
  if (!memoryRoot) return '';
  return path.join(memoryRoot, '50-反思', `反思 ${isoWeekLabel(date)}.md`);
}

/** 备份文件名：`反思 2026-W43.md.bak-20261020-193500`（不以 .md 结尾，记忆库索引不会收它） */
function backupStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

export function backupPathFor(file, date = new Date()) {
  return `${file}.bak-${backupStamp(date)}`;
}

/**
 * 覆盖前备份一份，并只保留最近 keep 份。
 * @returns {Promise<string|null>} 备份文件路径；原文件不存在时 null
 */
export async function backupReflectionFile(file, { keep = 10, now = new Date() } = {}) {
  if (!file || !fs.existsSync(file)) return null;
  const target = backupPathFor(file, now);
  await fsp.copyFile(file, target);
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const olds = (await fsp.readdir(dir))
      .filter((name) => name.startsWith(`${base}.bak-`))
      .sort();
    for (const name of olds.slice(0, Math.max(0, olds.length - keep))) {
      await fsp.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch {
    /* 清理旧备份失败不影响本次备份 */
  }
  return target;
}

/** 数一下现在还有几份备份（控制台展示用） */
export async function countBackups(file) {
  if (!file) return 0;
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    return (await fsp.readdir(dir)).filter((name) => name.startsWith(`${base}.bak-`)).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 锁

export function reflectLockPath(stateDir) {
  return path.join(stateDir, 'reflect.lock');
}

export function reflectStatePath(stateDir) {
  return path.join(stateDir, 'reflect-state.json');
}

/** 锁还在不在（staleMs 内算「在跑」，超过就当上次异常退出留下的） */
export async function isReflectLocked(stateDir, { staleMs = 15 * 60 * 1000, now = Date.now() } = {}) {
  try {
    const st = await fsp.stat(reflectLockPath(stateDir));
    return now - st.mtimeMs < staleMs;
  } catch {
    return false;
  }
}

/** 读锁里记的信息（谁在跑），没有就当空 */
export async function readReflectLock(stateDir) {
  try {
    const raw = await fsp.readFile(reflectLockPath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 抢锁。抢不到返回 null（说明别的进程正在跑）。
 * staleMs 之后视为僵尸锁，可以清掉重抢。
 */
export async function acquireReflectLock(
  stateDir,
  { holder = '', staleMs = 15 * 60 * 1000, now = Date.now() } = {},
) {
  const file = reflectLockPath(stateDir);
  await fsp.mkdir(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fh = await fsp.open(file, 'wx');
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, holder, startedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      await fh.close();
      return {
        path: file,
        release: async () => {
          try {
            await fsp.unlink(file);
          } catch {
            /* 已经被删掉就算了 */
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (await isReflectLocked(stateDir, { staleMs, now })) return null;
      await fsp.unlink(file).catch(() => {});
    }
  }
  return null;
}

// ---------------------------------------------------------------- 记账

export async function readReflectState(stateDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(reflectStatePath(stateDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeReflectState(stateDir, patch) {
  const next = { ...(await readReflectState(stateDir)), ...(patch ?? {}) };
  const target = reflectStatePath(stateDir);
  const tmp = `${target}.tmp`;
  try {
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, target);
  } catch {
    await fsp.unlink(tmp).catch(() => {});
  }
  return next;
}

// ---------------------------------------------------------------- 跑

/** 从输出里挑一句最像「结果」的，给状态文件和日志用 */
export function summarizeLines(lines) {
  const list = Array.isArray(lines) ? lines.filter((line) => String(line).trim() !== '') : [];
  const tail = list.slice().reverse();
  const wanted = tail.find((line) => /已写入|跳过|失败|完成|没有对话日志|异常/.test(line));
  return (wanted ?? tail[0] ?? '').replace(/^\[反思\]\s*/, '').slice(0, 200);
}

/**
 * 直接跑 tools/reflect.mjs 子进程，边跑边把输出行喂给 onLine。
 * 超时用 taskkill 杀整棵树（dsh 自己还会再开子进程）。
 */
export function runReflectScript({ projectRoot, force = false, days = REFLECT_DEFAULTS.days, timeoutMs = 420000, onLine } = {}) {
  const script = path.join(projectRoot, 'tools', 'reflect.mjs');
  const args = [script];
  if (force) args.push('--force');
  args.push('--days', String(days));

  return new Promise((resolve) => {
    const lines = [];
    let out = '';
    let err = '';
    let timedOut = false;
    const emit = (chunk) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        if (raw.trim() === '') continue;
        lines.push(raw);
        try {
          onLine?.(raw);
        } catch {
          /* 回调炸了不能拖垮任务 */
        }
      }
    };

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, lines, out, err: String(error?.message ?? error), timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(5000, Number(timeoutMs) || 420000));

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      out += chunk;
      emit(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      err += chunk;
      emit(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, lines, out, err: `${err}${String(error?.message ?? error)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, lines, out, err, timedOut });
    });
  });
}

/**
 * 跑一次完整的反思：抢锁 → 备份 → 跑脚本 → 记账 → 放锁。
 * 抢不到锁抛 code=REFLECT_BUSY 的错误。
 */
export async function runReflect({
  stateDir,
  projectRoot,
  memoryRoot = '',
  trigger = 'manual',
  force = true,
  days = REFLECT_DEFAULTS.days,
  backup = true,
  timeoutMs = 420000,
  dailyDate = '',
  onLine,
  log,
} = {}) {
  if (!stateDir) throw new Error('runReflect 需要 stateDir');
  if (!projectRoot) throw new Error('runReflect 需要 projectRoot');

  const lock = await acquireReflectLock(stateDir, { holder: trigger });
  if (!lock) {
    const busy = new Error('正在反思中（另一次反思还没跑完）');
    busy.code = 'REFLECT_BUSY';
    throw busy;
  }

  const startedAt = new Date().toISOString();
  const lines = [];
  const emit = (line) => {
    lines.push(line);
    if (lines.length > 400) lines.shift();
    try {
      onLine?.(line);
    } catch {
      /* 同上 */
    }
  };

  let backupPath = null;
  let result = { code: -1, lines, out: '', err: '', timedOut: false };
  let failure = '';

  try {
    await writeReflectState(stateDir, {
      runningSince: startedAt,
      runningTrigger: trigger,
      lastTrigger: trigger,
      lastForce: Boolean(force),
      lastDays: Number(days) || REFLECT_DEFAULTS.days,
    });

    if (force && backup) {
      const file = reflectionPath(memoryRoot);
      try {
        backupPath = await backupReflectionFile(file);
        if (backupPath) emit(`[控制] 已备份本周反思：${path.basename(backupPath)}`);
      } catch (error) {
        emit(`[控制] 备份失败（继续跑）：${error?.message ?? error}`);
      }
    }

    emit(`[控制] 开始反思（${trigger}${force ? ' · --force' : ''} · 素材 ${days} 天）`);
    result = await runReflectScript({ projectRoot, force, days, timeoutMs, onLine: emit });
  } catch (error) {
    failure = String(error?.message ?? error);
    emit(`[控制] 执行异常：${failure}`);
  } finally {
    await lock.release();
  }

  const ok = !failure && result.code === 0;
  const message = failure || summarizeLines(result.lines) || (ok ? '完成' : `退出码 ${result.code}`);
  await writeReflectState(stateDir, {
    runningSince: null,
    runningTrigger: null,
    lastRunAt: new Date().toISOString(),
    lastOk: ok,
    lastExitCode: result.code,
    lastTimedOut: Boolean(result.timedOut),
    lastBackup: backupPath,
    lastMessage: message,
    lastLines: lines.slice(-30),
    ...(dailyDate ? { lastDailyDate: dailyDate } : {}),
  });

  const text = `记忆反思结束（${trigger}）：${message}`;
  if (log && typeof log.info === 'function') {
    if (ok) log.info(text);
    else log.warn(text);
  }
  return { ok, exitCode: result.code, lines, backupPath, timedOut: Boolean(result.timedOut), message };
}

// ---------------------------------------------------------------- 定时器

/**
 * 桥接进程里的每天定时。
 * 每分钟 tick 一次：读配置（每次重读，控制台改完时间不用重启桥接）→ 判断该不该跑。
 */
export function createReflectScheduler({
  configPath,
  stateDir,
  projectRoot,
  memoryRoot = '',
  log,
  intervalMs = 60000,
  now = () => new Date(),
  run = runReflect,
} = {}) {
  let timer = null;
  let busy = false;
  let stopped = false;

  function readSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return normalizeReflectSettings(raw?.memory ?? {});
    } catch (error) {
      log?.debug?.('读配置失败，反思定时用默认设置：', error?.message ?? error);
      return normalizeReflectSettings({});
    }
  }

  function resolveMemoryRoot() {
    return typeof memoryRoot === 'function' ? memoryRoot() : memoryRoot;
  }

  async function tick() {
    if (stopped || busy) return null;
    const settings = readSettings();
    if (!settings.daily) return null;

    const state = await readReflectState(stateDir);
    const due = dailyDue({ settings, now: now(), lastDateKey: state.lastDailyDate || '' });
    if (!due) return null;

    busy = true;
    try {
      log?.info?.(`到点了，开始每天的反思（${due.catchUp ? '补跑 ' + due.scheduledFor : due.scheduledFor}）`);
      return await run({
        stateDir,
        projectRoot,
        memoryRoot: resolveMemoryRoot(),
        trigger: 'daily',
        force: settings.force,
        days: settings.days,
        backup: settings.backup,
        dailyDate: due.scheduledFor,
        log,
      });
    } catch (error) {
      log?.warn?.('定时反思失败：', error?.message ?? error);
      return null;
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    const settings = readSettings();
    timer = setInterval(() => {
      void tick().catch((error) => log?.debug?.('反思定时 tick 异常：', error?.message ?? error));
    }, Math.max(10000, Number(intervalMs) || 60000));
    timer.unref?.();
    // 启动 3 秒后先看一次：电脑关着错过的那次，开机就能补上
    const warm = setTimeout(() => {
      void tick().catch(() => {});
    }, 3000);
    warm.unref?.();
    if (settings.daily) log?.info?.(`记忆反思定时已就绪：每天 ${settings.time}${settings.catchUp ? '（错过了会在启动后补一次）' : ''}`);
    else log?.info?.('记忆反思定时未开启（memory.reflectDaily=false），只保留手动按钮');
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 手动/到点/攒够轮次都走这里，busy 保证同一进程内不并发 */
  async function runNow({ force = true, days, trigger = 'manual', backup = true, onLine, dailyDate = '' } = {}) {
    busy = true;
    try {
      return await run({
        stateDir,
        projectRoot,
        memoryRoot: resolveMemoryRoot(),
        trigger,
        force,
        days: Number(days) || readSettings().days,
        backup,
        dailyDate,
        onLine,
        log,
      });
    } finally {
      busy = false;
    }
  }

  return { start, stop, tick, runNow, readSettings, get busy() { return busy; } };
}
