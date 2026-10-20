/**
 * cli-test.mjs —— 命令行入口（tools/cli.mjs + qq-bridge.cmd + start.sh + exe 宿主）的端到端测试。
 *
 * 在临时目录里复制一份工程，用真实进程起停，验证：
 *   1) --help / 未知命令的退出码与提示；
 *   2) start 能同时起控制台和桥接，写 state/cli.json、state/status.json、state/webui-port.txt；
 *   3) 控制台真的能访问（/api/overview），端口可以由 --port 指定；
 *   4) status 读出 PID / 连接状态 / 控制台地址；
 *   5) logs 能读 bridge 日志；
 *   6) 重复 start 不会起第二个进程（避免双桥接）；
 *   7) stop 把进程停干净，pid 不再存活；
 *   8) start --no-console 只起桥接。
 *
 * 不碰真实工程的 state/logs/config.json，也不碰真的 NapCat（指向一个没人监听的端口）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
function ok(label, detail = '') {
  passed += 1;
  console.log(`  ✔ ${label}${detail ? `  — ${detail}` : ''}`);
}
function bad(label, detail = '') {
  failed += 1;
  console.log(`  ✘ ${label}${detail ? `  — ${detail}` : ''}`);
}
function check(cond, label, detail = '') {
  if (cond) ok(label, detail);
  else bad(label, detail);
  return cond;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 跑 cli 命令，等它结束，收集 stdout/stderr/退出码 */
function runCli(root, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'tools', 'cli.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, QQ_CONFIG: '' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const CONFIG = {
  onebot: { url: 'ws://127.0.0.1:39997', accessToken: '' },
  dsh: { command: 'dsh', profile: 'headless', patchPath: '', cwd: 'qq-workspace', timeoutMs: 60000 },
  persona: { enabled: true, path: 'qq-workspace/AGENTS.md', maxChars: 8000, dir: 'state/personas', active: '' },
  security: { allowFrom: [10001], allowGroups: true, allowGroupMembers: false, allowGroupIds: [], rateLimitPerMinute: 10, maxChars: 4000 },
  behavior: {
    queuedNotice: '收到',
    maxReplyChunk: 1200,
    showErrors: true,
    wakeWord: '',
    wakeWordMatch: 'contains',
    groupContextCount: 40,
  },
  groupMemory: { limit: 300 },
  memory: {
    enabled: true,
    root: 'memory',
    capture: false,
    reflectEvery: 20,
    maxInjectChars: 1200,
    reflectDaily: false,
    reflectTime: '04:00',
    reflectForce: true,
    reflectDays: 3,
    reflectBackup: true,
    reflectCatchUp: false,
  },
  stickers: { enabled: false, root: 'state/stickers', autoCollect: false, autoTag: false, maxBytes: 5242880, minBytes: 200, maxPerMessage: 3, perMinute: 20 },
  logDir: 'logs',
  stateDir: 'state',
};

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-cli-'));
const webPort = 5900 + Math.floor(Math.random() * 80);
let startedPids = [];

async function cleanup() {
  for (const pid of startedPids) {
    if (alive(pid)) {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

try {
  console.log(`[准备] 临时工程：${tmpRoot}`);
  await mkdir(tmpRoot, { recursive: true });
  for (const dir of ['src', 'tools', 'patches']) {
    await cp(path.join(PROJECT_ROOT, dir), path.join(tmpRoot, dir), { recursive: true });
  }
  await cp(path.join(PROJECT_ROOT, 'package.json'), path.join(tmpRoot, 'package.json'));
  await writeFile(path.join(tmpRoot, 'config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`, 'utf8');
  await mkdir(path.join(tmpRoot, 'qq-workspace'), { recursive: true });
  await writeFile(path.join(tmpRoot, 'qq-workspace', 'AGENTS.md'), '# 测试人格\n\n你是测试用的人格。\n', 'utf8');

  console.log('\n[1] 帮助与错误命令');
  const help = await runCli(tmpRoot, ['--help'], 20_000);
  check(help.code === 0, '--help 退出码 0', String(help.code));
  check(help.out.includes('用法：node tools/cli.mjs'), '--help 有用法');
  check(help.out.includes('start') && help.out.includes('stop') && help.out.includes('status'), '--help 列出主要命令');
  check(help.out.includes('--port'), '--help 写了 --port');
  const bogus = await runCli(tmpRoot, ['bogus'], 20_000);
  check(bogus.code === 1, '未知命令退出码 1', String(bogus.code));
  check(bogus.err.includes('不认识的命令'), '未知命令有中文提示');

  console.log('\n[2] start（控制台 + 桥接）');
  const start1 = await runCli(tmpRoot, ['start', '--port', String(webPort)], 120_000);
  check(start1.code === 0, 'start 退出码 0', String(start1.code));
  check(start1.out.includes('桥接已启动'), '输出桥接已启动');
  check(start1.out.includes('控制台已启动'), '输出控制台已启动');
  check(start1.out.includes(`http://127.0.0.1:${webPort}/`), `控制台端口是 ${webPort}`);
  check(start1.out.includes('还没连上 NapCat') || start1.out.includes('已连上 NapCat'), '报告了 OneBot 连接状态');

  const cliJsonPath = path.join(tmpRoot, 'state', 'cli.json');
  const statusPath = path.join(tmpRoot, 'state', 'status.json');
  const portPath = path.join(tmpRoot, 'state', 'webui-port.txt');
  check(existsSync(cliJsonPath), '写了 state/cli.json');
  check(existsSync(statusPath), '桥接写了 state/status.json');
  const cliJson = JSON.parse(await readFile(cliJsonPath, 'utf8'));
  const bridgePid = Number(cliJson?.bridge?.pid) || 0;
  const consolePid = Number(cliJson?.console?.pid) || 0;
  startedPids.push(bridgePid, consolePid);
  check(bridgePid > 0, 'cli.json 记了桥接 PID', String(bridgePid));
  check(consolePid > 0, 'cli.json 记了控制台 PID', String(consolePid));
  check(alive(bridgePid), '桥接进程还活着');
  check(alive(consolePid), '控制台进程还活着');
  check((await readFile(portPath, 'utf8')).trim() === String(webPort), '端口文件写了指定端口');

  const overview = await fetch(`http://127.0.0.1:${webPort}/api/overview`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json())
    .catch(() => null);
  check(Boolean(overview?.data), '控制台 /api/overview 能访问');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  check(status.connected === false, '没 NapCat 时状态是 connected:false');
  check(Number(status.pid) === bridgePid, 'status.json 的 pid 与 cli.json 一致');

  console.log('\n[3] status / logs');
  const st = await runCli(tmpRoot, ['status'], 30_000);
  check(st.code === 0, 'status 退出码 0', String(st.code));
  check(st.out.includes(`PID ${bridgePid}`), 'status 显示的桥接 PID 正确');
  check(st.out.includes('控制台'), 'status 有控制台一行');
  check(st.out.includes(`http://127.0.0.1:${webPort}/`), 'status 显示控制台地址');
  check(st.out.includes('未连接'), 'status 显示 OneBot 未连接');

  const logs = await runCli(tmpRoot, ['logs', 'bridge', '--lines', '30'], 30_000);
  check(logs.code === 0, 'logs 退出码 0', String(logs.code));
  check(
    /配置文件|工作目录|正在连接/.test(logs.out),
    '日志里有桥接的启动行',
    logs.out.replace(/\s+/g, ' ').slice(0, 160),
  );
  const logsMissing = await runCli(tmpRoot, ['logs', 'webui', '--lines', '5'], 30_000);
  check(logsMissing.code === 0 || logsMissing.code === 1, 'logs webui 不炸');
  check(logsMissing.out.includes('控制台') || logsMissing.out.includes('就绪') || logsMissing.code === 1, 'logs webui 有内容或是明确的错');

  console.log('\n[4] 重复 start 不会起第二个进程');
  const start2 = await runCli(tmpRoot, ['start', '--port', String(webPort)], 60_000);
  check(start2.code === 0, '第二次 start 退出码 0');
  check(start2.out.includes('已经在跑'), '第二次 start 说已经在跑');
  const cliJson2 = JSON.parse(await readFile(cliJsonPath, 'utf8'));
  check(Number(cliJson2.bridge.pid) === bridgePid, '桥接 PID 没变（没有双桥接）');
  check(Number(cliJson2.console.pid) === consolePid, '控制台 PID 没变');

  console.log('\n[5] stop');
  const stop1 = await runCli(tmpRoot, ['stop'], 60_000);
  check(stop1.code === 0, 'stop 退出码 0', String(stop1.code));
  check(stop1.out.includes('已停止'), 'stop 报告已停止');
  await sleep(1200);
  check(!alive(bridgePid), '桥接进程已退出');
  check(!alive(consolePid), '控制台进程已退出');
  check(!existsSync(cliJsonPath), 'stop 后清掉了 state/cli.json');
  startedPids = [];

  const stop2 = await runCli(tmpRoot, ['stop'], 30_000);
  check(stop2.code === 0, '重复 stop 退出码 0');
  check(stop2.out.includes('没有在跑'), '重复 stop 提示没有在跑');

  console.log('\n[6] start --no-console');
  const start3 = await runCli(tmpRoot, ['start', '--no-console'], 60_000);
  check(start3.code === 0, 'start --no-console 退出码 0');
  check(start3.out.includes('桥接已启动'), '只起桥接');
  check(!start3.out.includes('控制台已启动'), '没有起控制台');
  const cliJson3 = JSON.parse(await readFile(cliJsonPath, 'utf8'));
  const bridgePid3 = Number(cliJson3?.bridge?.pid) || 0;
  startedPids.push(bridgePid3);
  check(bridgePid3 > 0 && bridgePid3 !== bridgePid, '桥接换成新 PID');
  check(!cliJson3?.console, 'cli.json 里没有控制台记录');
  const stop3 = await runCli(tmpRoot, ['stop'], 60_000);
  check(stop3.code === 0, '收尾 stop 退出码 0');
} catch (err) {
  bad('测试过程抛异常', err?.stack || String(err));
} finally {
  await cleanup();
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
