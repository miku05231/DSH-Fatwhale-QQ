import fs from 'node:fs/promises';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;
const DAILY_LOG = /^bridge-\d{4}-\d{2}-\d{2}\.log$/;

export function logLineLimit(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? 200 : Math.min(1000, Math.max(1, Math.floor(number)));
}

async function latestBridgeFile(logDir) {
  try {
    const entries = await fs.readdir(logDir, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile() && DAILY_LOG.test(entry.name)).map((entry) => entry.name).sort();
    return names.length ? path.join(logDir, names.at(-1)) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function tailFile(file, { name, source, limit, redact }) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('日志路径不是文件');
    const from = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    let chunk = buffer.subarray(0, bytesRead).toString('utf8');
    if (from > 0) {
      const newline = chunk.indexOf('\n');
      chunk = newline < 0 ? '' : chunk.slice(newline + 1);
    }
    const all = chunk.split(/\r?\n/);
    if (all.at(-1) === '') all.pop();
    return { name, source, file, lines: all.slice(-limit).map(redact), total: all.length,
      bytes: stat.size, truncated: from > 0, updatedAt: stat.mtime.toISOString(), missing: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { name, source, file, lines: [], bytes: 0, updatedAt: null, missing: true };
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Resolve the source afresh on every poll so appends, restarts and daily
 * rotation are visible without restarting the console. Explicit container
 * sources never fall back to stale launcher console files. */
export function createWebUiLogReader({ logDir, bridgeSource = 'auto', napcatSource = 'console', readNapcat, redact = String }) {
  return async function readLogs(name, lines) {
    const limit = logLineLimit(lines);
    if (name === 'napcat' && napcatSource === 'webui') {
      if (!readNapcat) throw new Error('NapCat 日志接口尚未接入');
      const data = await readNapcat(limit);
      return { ...data, name, source: 'napcat-webui', lines: (data.lines || []).slice(-limit).map(redact) };
    }
    let file = path.join(logDir, `${name}-console.log`);
    let source = 'launcher-console';
    if (name === 'bridge' && bridgeSource !== 'console') {
      const daily = await latestBridgeFile(logDir);
      if (daily || bridgeSource === 'daily') {
        source = 'bridge-daily';
        file = daily;
      }
    }
    if (!file) return { name, source, file: null, lines: [], bytes: 0, updatedAt: null, missing: true };
    return tailFile(file, { name, source, limit, redact });
  };
}
