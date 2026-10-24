#!/usr/bin/env node
/**
 * tools/cli.mjs —— 命令行模式：不开托盘也能把桥接和控制台跑起来。
 *
 *   node tools/cli.mjs start          起控制台 + 桥接（后台，关掉窗口也不会停）
 *   node tools/cli.mjs start --no-console   只起桥接（纯机器人，不看网页）
 *   node tools/cli.mjs stop           全停
 *   node tools/cli.mjs restart        重启
 *   node tools/cli.mjs status         看谁在跑、连没连上 QQ
 *   node tools/cli.mjs logs [bridge|webui] [--lines 80] [--follow]
 *   node tools/cli.mjs webui          打印控制台地址（顺便尝试打开浏览器）
 *   node tools/cli.mjs test [--skip-net]  跑全量测试
 *
 * 零第三方依赖；Windows 用 taskkill，类 Unix 用 process.kill。
 * PID 记在 state\cli.json，跟托盘启动器互不影响（它走自己的进程管理）。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_DIR = path.join(ROOT, 'logs');
const CLI_FILE = path.join(STATE_DIR, 'cli.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const PORT_FILE = path.join(STATE_DIR, 'webui-port.txt');
const IS_WIN = process.platform === 'win32';

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

async function ensureDirs() {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readCli() {
  return (await readJson(CLI_FILE, null)) ?? { console: null, bridge: null };
}

async function writeCli(data) {
  await ensureDirs();
  const tmp = `${CLI_FILE}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, CLI_FILE);
}

function openLog(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return fs.openSync(path.join(LOG_DIR, name), 'a');
}

/** 起一个后台子进程，输出重定向到日志文件；env 用来给控制台单独指定端口 */
function spawnBackground(script, logName, extraEnv = {}) {
  const fd = openLog(logName);
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  fs.closeSync(fd);
  return child;
}

function pidAlive(pid, script) {
  if (!isAlive(pid)) return false;
  const expected = path.join(ROOT, script);
  try {
    if (process.platform === 'linux') {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return /^node(?:\.exe)?$/.test(path.basename(argv[0])) && argv[1] === expected;
    }
    let commandLine;
    if (IS_WIN) {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -OperationTimeoutSec 3 -ErrorAction Stop; if ($p.Name -eq 'node.exe') { [Console]::Write([string]$p.CommandLine) }`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (probe.status !== 0) return false;
      commandLine = probe.stdout.replace(/\//g, '\\');
    } else {
      const probe = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
      if (probe.status !== 0) return false;
      commandLine = probe.stdout;
    }
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*(?:"[^"]+"|\\S+)\\s+(?:"${escaped}"|${escaped})(?:\\s|$)`, IS_WIN ? 'i' : '').test(commandLine);
  } catch {
    return false;
  }
}

async function resolveState() {
  const cli = await readCli();
  const status = await readJson(STATUS_FILE, null);
  const portText = (await fsp.readFile(PORT_FILE, 'utf8').catch(() => '')).trim();
  const bridgePid = [Number(status?.pid), cli?.bridge?.pid]
    .find((pid) => pidAlive(pid, path.join('src', 'index.js'))) || 0;
  const consolePid = pidAlive(cli?.console?.pid, path.join('src', 'webui', 'server.mjs')) ? cli.console.pid : 0;
  return {
    cli,
    status,
    port: Number(portText) || Number(cli?.console?.port) || 0,
    bridgePid,
    consolePid,
    bridgeAlive: bridgePid > 0,
    consoleAlive: consolePid > 0,
  };
}

function killPid(pid, script) {
  if (!pidAlive(pid, script)) return false;
  try {
    if (IS_WIN) {
      return spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).status === 0;
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- start */

/** --port 5831：给控制台指定端口（多个实例 / 端口被占时用） */
function portFromArgs(args) {
  const index = args.indexOf('--port');
  const value = index >= 0 ? Number(args[index + 1]) : 0;
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 0;
}

async function cmdStart(args) {
  const withConsole = !args.includes('--no-console');
  const wantedPort = portFromArgs(args);
  await ensureDirs();
  const before = await resolveState();
  if (before.bridgeAlive) {
    say(`桥接已经在跑（PID ${before.bridgePid}），不重复启动。`);
    if (withConsole && !before.consoleAlive) {
      await startConsole(wantedPort);
    }
    return printAddresses();
  }

  if (withConsole && !before.consoleAlive) {
    await startConsole(wantedPort);
  }
  const child = spawnBackground(path.join('src', 'index.js'), 'bridge-cli.log');
  const cli = await readCli();
  cli.bridge = { pid: child.pid, startedAt: new Date().toISOString() };
  await writeCli(cli);
  say(`桥接已启动（PID ${child.pid}），日志：logs\\bridge-cli.log`);

  const connected = await waitFor(
    async () => {
      const status = await readJson(STATUS_FILE, null);
      return status?.pid === child.pid && status?.connected === true;
    },
    20_000,
    500,
  );
  const status = await readJson(STATUS_FILE, null);
  if (connected) say('已连上 NapCat（OneBot 服务端）。');
  else if (status) say('桥接在跑，但还没连上 NapCat：先把 NapCat 起来（napcat\\ 目录或 Docker）。');
  else say('桥接在跑，状态文件还没写出来，稍后用 status 再看。');
  await printAddresses();
}

async function startConsole(wantPort = 0) {
  const child = spawnBackground(
    path.join('src', 'webui', 'server.mjs'),
    'webui-console.log',
    wantPort ? { WEBUI_PORT: String(wantPort) } : {},
  );
  const cli = await readCli();
  cli.console = { pid: child.pid, startedAt: new Date().toISOString() };
  await writeCli(cli);
  const port = await waitFor(async () => {
    const text = (await fsp.readFile(PORT_FILE, 'utf8').catch(() => '')).trim();
    return Number(text) > 0 ? Number(text) : 0;
  }, 15_000, 300);
  cli.console.port = port || null;
  await writeCli(cli);
  say(port ? `控制台已启动（PID ${child.pid}）：http://127.0.0.1:${port}/` : `控制台已启动（PID ${child.pid}），端口还没写出来`);
  return port;
}

async function printAddresses() {
  const state = await resolveState();
  if (state.port) say(`控制台：http://127.0.0.1:${state.port}/`);
  if (state.bridgePid) say(`桥接 PID：${state.bridgePid}`);
  say('停止：node tools/cli.mjs stop');
}

/* -------------------------------------------------------------- stop */

async function cmdStop() {
  const state = await resolveState();
  const killed = [];
  if (state.bridgePid && killPid(state.bridgePid, path.join('src', 'index.js'))) killed.push(`桥接 ${state.bridgePid}`);
  if (state.consolePid && killPid(state.consolePid, path.join('src', 'webui', 'server.mjs'))) killed.push(`控制台 ${state.consolePid}`);
  // 兜底：CLI 文件里的 pid 与 status.json 不一致时也清掉
  if (state.cli?.bridge?.pid && state.cli.bridge.pid !== state.bridgePid &&
      killPid(state.cli.bridge.pid, path.join('src', 'index.js'))) {
    killed.push(`桥接 ${state.cli.bridge.pid}`);
  }
  await writeCli({ console: null, bridge: null });
  await fsp.rm(CLI_FILE, { force: true }).catch(() => {});
  say(killed.length ? `已停止：${killed.join('、')}` : '没有在跑的桥接或控制台（可能本来就是停的）。');
}

/* ------------------------------------------------------------ status */

async function cmdStatus() {
  const state = await resolveState();
  const status = state.status;
  say('QQ-DSH 桥接 · 命令行状态');
  say('────────────────────────────');
  say(`工程目录：${ROOT}`);
  say(`桥接：${state.bridgePid ? `PID ${state.bridgePid}（${state.bridgeAlive ? '在跑' : '已退出'}）` : '没跑'}`);
  if (status) {
    say(`  OneBot：${status.connected ? '已连接' : '未连接'}${status.onebotUrl ? `（${status.onebotUrl}）` : ''}`);
    say(`  会话：${status.sessions ?? 0} 个${status.inFlight ? `，处理中 ${status.inFlight}` : ''}`);
    if (status.model) say(`  模型：${status.model}`);
    if (status.updatedAt) say(`  心跳：${status.updatedAt}`);
    if (status.lastError) say(`  最近错误：${status.lastError}`);
  }
  const overview = state.port ? await fetchJson(`http://127.0.0.1:${state.port}/api/overview`) : null;
  const consolePid = state.consolePid || overview?.data?.runtime?.pid || 0;
  if (!state.port) say('控制台：没跑');
  else if (!state.consolePid && consolePid) say(`控制台：PID ${consolePid}（托盘或别的方式起的） http://127.0.0.1:${state.port}/`);
  else say(`控制台：PID ${consolePid || '?'}（${state.consoleAlive ? '在跑' : '进程没了'}） http://127.0.0.1:${state.port}/`);
  if (overview?.data) {
    const d = overview.data;
    say(`NapCat：${d.napcat?.running ? '在跑' : '没跑'}${d.napcat?.loggedIn ? '（已登录）' : ''}`);
    // overview 里的 memory 是一层 {ok,data} 信封（前端也是这么取的）
    const mem = d.memory?.data ?? d.memory ?? {};
    say(`记忆：${mem.files ?? 0} 篇 · 今日消息 ${d.today?.messages ?? 0} 条`);
  }
}

/* -------------------------------------------------------------- logs */

async function cmdLogs(args) {
  const target = args.find((a) => !a.startsWith('--')) || 'bridge';
  const linesIdx = args.indexOf('--lines');
  const lines = linesIdx >= 0 ? Number(args[linesIdx + 1]) || 80 : 80;
  const follow = args.includes('--follow');
  const dir = LOG_DIR;
  const prefix = target === 'webui' || target === 'console' ? 'webui' : 'bridge';
  const files = (await fsp.readdir(dir).catch(() => []))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  // 优先按天切的那份（bridge-2026-10-20.log）；*-cli.log / *-console.log 是进程 stdout，可能只有几行
  const dated = files.find((f) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.log$`).test(f.name));
  const latest = dated ?? files[0];
  if (!latest) throw new CliError(`logs 目录里没有 ${prefix} 的日志：${dir}`);
  const file = path.join(dir, latest.name);
  const text = await fsp.readFile(file, 'utf8');
  const tail = text.split(/\r?\n/).slice(-lines).join('\n');
  say(`# ${path.relative(ROOT, file)}（最后 ${lines} 行）`);
  say(tail);
  if (!follow) return;
  let size = fs.statSync(file).size;
  say('（跟随中，Ctrl+C 退出）');
  for (;;) {
    await sleep(700);
    const now = fs.statSync(file).size;
    if (now > size) {
      const handle = await fsp.open(file, 'r');
      const buffer = Buffer.alloc(now - size);
      await handle.read(buffer, 0, buffer.length, size);
      await handle.close();
      process.stdout.write(buffer.toString('utf8'));
      size = now;
    }
  }
}

/* ------------------------------------------------------------- webui */

async function cmdWebui() {
  const state = await resolveState();
  if (!state.port) throw new CliError('控制台没在跑：先 node tools/cli.mjs start');
  const url = `http://127.0.0.1:${state.port}/`;
  say(url);
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，地址已经打出来了 */
  }
}

/* -------------------------------------------------------------- test */

async function cmdTest(args) {
  const passthrough = args.filter((a) => a === '--skip-net' || a === '--only');
  const onlyIdx = args.indexOf('--only');
  if (onlyIdx >= 0 && args[onlyIdx + 1]) passthrough.push(args[onlyIdx + 1]);
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'run-all.mjs'), ...passthrough], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  await new Promise((resolve) => child.on('exit', resolve));
  process.exitCode = child.exitCode ?? 0;
}

/* ------------------------------------------------------------- utils */

async function fetchJson(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => false);
    if (value) return value;
    await sleep(stepMs);
  }
  return 0;
}

function usage() {
  say(`用法：node tools/cli.mjs <命令>

  start [--no-console] [--port 5831]
                          起控制台 + 桥接（后台）；--port 换控制台端口
  stop                    全停
  restart                 重启
  status                  看状态（桥接 / 控制台 / NapCat / 记忆条数）
  logs [bridge|webui] [--lines 80] [--follow]
  webui                   打印控制台地址并尝试打开
  test [--skip-net]       跑全量测试

Windows 也可以直接双击 qq-bridge.cmd。`);
}

/* -------------------------------------------------------------- main */

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'start':
      await cmdStart(args);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdStop();
      await sleep(800);
      await cmdStart(args);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      await cmdLogs(args);
      break;
    case 'webui':
    case 'open':
      await cmdWebui();
      break;
    case 'test':
      await cmdTest(args);
      break;
    case undefined:
    case '':
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      throw new CliError(`不认识的命令：${command}（跑 node tools/cli.mjs --help 看用法）`);
  }
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error('出错了：', err?.stack ?? err);
  process.exit(2);
}
