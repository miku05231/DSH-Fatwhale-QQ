// src/logger.js —— 按天切分的文件日志（零依赖）
//
// 用法：
//   const log = createLogger('onebot', { logDir: 'C:\\D\\DSH\\qq-bridge\\logs' })
//   log.info('已连接'); log.child('ws').debug('帧', { id: 1 })
//
// 文件：<logDir>/bridge-YYYY-MM-DD.log（UTF-8 无 BOM，追加写）
// 行格式：<ISO时间> <LEVEL> [name] 消息
// 保留：最近 7 天（含今天），启动时清理更早的；跨天时再清理一次

import fs from 'node:fs';
import { join, resolve } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RETAIN_DAYS = 7;
const FILE_PREFIX = 'bridge-';
const FILE_EXT = '.log';

/** @type {Map<string, Sink>} 每个日志目录共用一个写入器（appendFileSync，天然按行原子） */
const sinks = new Map();
/** @type {Set<string>} 已做过启动清理的目录 */
const cleanedDirs = new Set();

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n) {
  return `00${n}`.slice(-3);
}

/** 本地日历日期：YYYY-MM-DD（与“按天切文件”的直觉一致，不随 UTC 偏移漂移） */
function dateStamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间的 ISO 8601 时间戳，带显式时区偏移，例如 2026-10-19T23:43:25.123+08:00 */
function isoLocal(d) {
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${dateStamp(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `.${pad3(d.getMilliseconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** 安全 JSON：遇到循环引用不抛异常 */
function safeJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch {
    return undefined;
  }
}

/** 把任意参数转成可读文本（Error 保留堆栈） */
function formatArg(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'object') {
    const json = safeJson(value);
    if (json !== undefined) return json;
    return String(value);
  }
  return String(value);
}

/** 解析 bridge-YYYY-MM-DD.log 的日期；不是本模块的文件返回 null */
function parseLogDate(fileName) {
  if (!fileName.startsWith(FILE_PREFIX) || !fileName.endsWith(FILE_EXT)) return null;
  const stamp = fileName.slice(FILE_PREFIX.length, fileName.length - FILE_EXT.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return null;
  const time = new Date(`${stamp}T00:00:00`).getTime();
  if (!Number.isFinite(time)) return null;
  return time;
}

/** 删除早于“今天 - 6 天”的日志文件（即只保留最近 7 天） */
function cleanupOldLogs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = new Date(`${dateStamp(new Date())}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - (RETAIN_DAYS - 1));
  const minTime = cutoff.getTime();
  for (const name of names) {
    const time = parseLogDate(name);
    if (time === null || time >= minTime) continue;
    try {
      fs.rmSync(join(dir, name), { force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

class Sink {
  constructor(logDir) {
    this.dir = logDir;
    this.currentDate = null;
    this.broken = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.broken = true;
      console.error(`[qq-bridge] 无法创建日志目录：${this.dir}（${err.message}）`);
    }
    if (!cleanedDirs.has(this.dir)) {
      cleanedDirs.add(this.dir);
      cleanupOldLogs(this.dir);
    }
  }

  /**
   * 追加一行日志，返回实际写入的完整行（含换行），便于 echo。
   */
  append(now, levelName, name, message) {
    const date = dateStamp(now);
    if (this.currentDate !== date) {
      this.currentDate = date;
      // 跨天（或首次写入）时清理一次，长期运行的进程也不会堆积旧文件
      cleanupOldLogs(this.dir);
    }
    const line = `${isoLocal(now)} ${levelName} [${name}] ${message}\n`;
    if (!this.broken) {
      try {
        fs.appendFileSync(join(this.dir, `${FILE_PREFIX}${date}${FILE_EXT}`), line, 'utf8');
      } catch (err) {
        this.broken = true;
        console.error(`[qq-bridge] 写入日志文件失败：${this.dir}（${err.message}）`);
      }
    }
    return line;
  }
}

function sinkFor(logDir) {
  let sink = sinks.get(logDir);
  if (!sink) {
    sink = new Sink(logDir);
    sinks.set(logDir, sink);
  }
  return sink;
}

/**
 * 创建一个日志器。
 * @param {string} name 日志器名字（写进 [name]）
 * @param {{logDir?: string, level?: 'debug'|'info'|'warn'|'error', echo?: boolean}} [opts]
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, child: Function}}
 */
export function createLogger(name, opts = {}) {
  const baseName = typeof name === 'string' && name.trim() ? name.trim() : 'app';
  const options = opts && typeof opts === 'object' ? opts : {};
  const logDir = resolve(
    typeof options.logDir === 'string' && options.logDir.trim()
      ? options.logDir
      : join(process.cwd(), 'logs'),
  );
  const echo = options.echo !== false;
  const requested = typeof options.level === 'string' ? options.level.trim().toLowerCase() : '';
  const levelName = Object.hasOwn(LEVELS, requested) ? requested : 'info';
  const threshold = LEVELS[levelName];

  const emit = (level, args) => {
    if (LEVELS[level] < threshold) return;
    let text;
    try {
      text = args.map(formatArg).join(' ');
    } catch {
      text = args.join(' ');
    }
    const line = sinkFor(logDir).append(new Date(), level.toUpperCase(), baseName, text);
    if (!echo) return;
    try {
      const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
      stream.write(line);
    } catch {
      /* 终端不可写（被关掉/管道断开）时不影响文件日志 */
    }
  };

  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => emit('debug', args),
    /** 派生同名子日志器：parent.child('ws') → [parent:ws] */
    child: (sub) => {
      const suffix = typeof sub === 'string' && sub.trim() ? sub.trim() : String(sub);
      return createLogger(`${baseName}:${suffix}`, { logDir, level: levelName, echo });
    },
  };
}
