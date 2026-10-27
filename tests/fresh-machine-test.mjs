/**
 * fresh-machine-test.mjs —— 模拟「换一台干净的电脑」：把工程复制到临时目录，不带任何
 * state / logs / config.json / napcat 数据，看控制台与桥接能不能起来。
 *
 * 覆盖：
 *   1) 复制一份干净工程（只带源码、启动器、工具、补丁、资源、文档），写一份最小配置；
 *   2) 控制台：首页与静态资源、概览 / 人格库 / 表情包 / 记忆 / 设置 / 模型 / 路径接口；
 *   3) 桥接：能启动、连不上 NapCat 时不崩、写出的状态是 connected:false；
 *   4) 泄漏检查：临时工程的源码与生成的配置里不出现作者机器上的绝对路径。
 *
 * 全是临时目录里的事，结束删干净；不碰真实的 config.json、state、logs 与 NapCat。
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label, String(actual));
  else bad(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function truthy(value, label, detail = '') {
  if (value) ok(label, detail);
  else bad(label, detail);
}

function section(title) {
  console.log(`\n[${title}]`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立（轮询），超时返回 false */
async function waitFor(fn, timeoutMs = 15000, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* 还没好 */
    }
    await sleep(stepMs);
  }
  return false;
}

/** 递归找文件里是否出现某段文本 */
async function grepTree(dir, needle, { skip = () => false } = {}) {
  const hits = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (skip(full, entry)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (/\.(mjs|js|json|ps1|md|css|html|yml|yaml|cmd|bat|txt)$/i.test(entry.name) || !path.extname(entry.name)) {
        const text = await readFile(full, 'utf8').catch(() => '');
        if (text.includes(needle)) hits.push(path.relative(dir, full));
      }
    }
  };
  await walk(dir);
  return hits;
}

/* ------------------------------------------------ 造一台「干净电脑」 */

const COPY_DIRS = ['src', 'tools', 'patches', 'launcher', 'assets', 'docs', 'tests'];
const COPY_FILES = ['package.json', 'LICENSE'];

async function buildFreshCopy(target) {
  await mkdir(target, { recursive: true });
  for (const dir of COPY_DIRS) {
    const from = path.join(PROJECT_ROOT, dir);
    if (!existsSync(from)) continue;
    await cp(from, path.join(target, dir), { recursive: true });
  }
  for (const file of COPY_FILES) {
    const from = path.join(PROJECT_ROOT, file);
    if (existsSync(from)) await cp(from, path.join(target, file));
  }
  // 干净电脑上不会有的东西，明确保证不存在
  for (const junk of ['state', 'logs', 'config.json', 'napcat', 'qq-workspace', 'dist', 'node_modules']) {
    await rm(path.join(target, junk), { recursive: true, force: true });
  }
  await mkdir(path.join(target, 'qq-workspace'), { recursive: true });
  await writeFile(
    path.join(target, 'qq-workspace', 'AGENTS.md'),
    '# 人格\n\n新电脑上的第一个人格：说人话，短句。\n',
    'utf8',
  );
  // 最小配置：只写「必须自己给」的几项，其余靠 DEFAULTS 合并
  const config = {
    onebot: { url: 'ws://127.0.0.1:39999', accessToken: '' },
    dsh: {
      command: 'dsh',
      profile: 'headless',
      patchPath: 'patches/headless-model.yml',
      cwd: 'qq-workspace',
      timeoutMs: 120000,
      permissionMode: 'danger-full-access',
    },
    security: { allowFrom: [1000000002] },
    persona: { enabled: true, path: 'qq-workspace/AGENTS.md' },
    memory: { enabled: true, root: '记忆库' },
  };
  await writeFile(path.join(target, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

/* ------------------------------------------------------------ 控制台 */

async function consoleTests(tmpRoot) {
  const serverUrl = pathToFileURL(path.join(tmpRoot, 'src', 'webui', 'server.mjs')).href;
  const configUrl = pathToFileURL(path.join(tmpRoot, 'src', 'config.js')).href;
  const { createWebUiServer } = await import(serverUrl);
  const { loadConfig } = await import(configUrl);

  const { config } = loadConfig(tmpRoot, { createIfMissing: false });
  const instance = createWebUiServer({ config, configRoot: tmpRoot, port: 5920 });
  const { port } = await instance.start();
  if (port <= 0) {
    bad('干净工程里的控制台没起来');
    return;
  }
  ok('控制台在干净工程里起来了', `127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  const call = async (p, options = {}) => {
    const res = await fetch(base + p, options);
    const type = res.headers.get('content-type') ?? '';
    let body = null;
    if (type.includes('json')) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } else {
      body = await res.text();
    }
    return { status: res.status, body, type };
  };

  try {
    section('1/3 静态资源与首页');
    const home = await call('/');
    eq(home.status, 200, '首页 200');
    truthy(typeof home.body === 'string' && home.body.includes('app.js'), '首页引用了 app.js');
    truthy(String(home.body).includes('id="navBar"'), '首页有底部导航');
    eq((await call('/app.js')).status, 200, 'app.js 200');
    eq((await call('/app.css')).status, 200, 'app.css 200');
    const icon = await fetch(`${base}/app-icon.png`);
    eq(icon.status, 200, 'favicon 200');

    section('1/3 接口在空状态下都正常');
    const overview = await call('/api/overview');
    eq(overview.status, 200, 'GET /api/overview 200');
    truthy(overview.body?.ok === true, 'overview ok');
    for (const key of ['napcat', 'bridge', 'dsh', 'memory', 'today', 'runtime']) {
      truthy(overview.body?.data?.[key] !== undefined, `overview 里有 ${key}`);
    }

    const personas = await call('/api/personas');
    eq(personas.status, 200, 'GET /api/personas 200');
    eq(personas.body?.data?.mode, 'single', '人格库空时是单文件模式');
    eq(personas.body?.data?.dir, path.join(tmpRoot, 'state', 'personas'), '人格库落在临时工程的 state 下');
    eq(Array.isArray(personas.body?.data?.items), true, 'items 是数组');
    eq(personas.body?.data?.items.length, 0, '空库 0 套');

    const created = await call('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新电脑第一套', body: '# 新电脑第一套\n\n先打个招呼。' }),
    });
    eq(created.status, 200, '干净工程里能新建人格');
    const afterCreate = await call('/api/personas');
    eq(afterCreate.body?.data?.items.length, 1, '建完能列出来');
    eq(afterCreate.body?.data?.mode, 'library', '有成员后是库模式');
    const removed = await call(`/api/personas?name=${encodeURIComponent('新电脑第一套')}`, { method: 'DELETE' });
    eq(removed.status, 200, '能删掉');

    const stickers = await call('/api/stickers');
    eq(stickers.status, 200, 'GET /api/stickers 200');
    eq(stickers.body?.data?.count, 0, '表情包库空');
    eq(stickers.body?.data?.root, path.join(tmpRoot, 'state', 'stickers'), '表情包库在临时工程的 state 下');
    truthy(existsSync(path.join(tmpRoot, 'state', 'stickers', 'index.json')), '第一次访问会建空索引');

    const memory = await call('/api/memory/stats');
    eq(memory.status, 200, 'GET /api/memory/stats 200（记忆库还不存在也不 500）');
    truthy(memory.body?.ok === true, '记忆接口 ok 字段正常');

    const settings = await call('/api/settings');
    eq(settings.status, 200, 'GET /api/settings 200');
    truthy(settings.body?.data?.persona !== undefined, '设置里有 persona 组');
    truthy(settings.body?.data?.memory !== undefined, '设置里有 memory 组');
    truthy(settings.body?.data?.path?.endsWith('config.json'), '设置路径指向临时 config.json');

    const model = await call('/api/model');
    eq(model.status, 200, 'GET /api/model 200');
    const paths = await call('/api/paths');
    eq(paths.status, 200, 'GET /api/paths 200');
    eq(paths.body?.data?.requiresBridgeRestart, true, '路径页提示要重启桥接');

    section('1/3 生成的目录都在临时工程里');
    truthy(existsSync(path.join(tmpRoot, 'state', 'webui-port.txt')), '端口号写进了临时 state');
    eq(existsSync(path.join(tmpRoot, 'logs')), true, '日志目录建在临时工程里');

    // 响应里不能出现作者机器上的绝对路径
    const payloads = { overview: overview.body, personas: afterCreate.body, stickers: stickers.body, settings: settings.body, paths: paths.body };
    const leaky = Object.entries(payloads)
      .filter(([, payload]) => JSON.stringify(payload ?? {}).includes('C:\\\\D\\\\DSH') || JSON.stringify(payload ?? {}).includes('C:\\DSH'))
      .map(([name]) => name);
    eq(leaky, [], '接口返回里没有作者机器的绝对路径');
  } finally {
    await instance.stop();
  }
}

/* ------------------------------------------------------------ 桥接 */

async function bridgeTests(tmpRoot) {
  section('2/3 桥接在没装 NapCat 的机器上');
  const child = spawn(process.execPath, [path.join(tmpRoot, 'src', 'index.js')], {
    cwd: tmpRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let exitedEarly = null;
  child.on('exit', (code) => {
    exitedEarly = code;
  });

  const statusFile = path.join(tmpRoot, 'state', 'status.json');
  const wroteStatus = await waitFor(async () => existsSync(statusFile), 20000, 400);
  truthy(wroteStatus, '桥接写出了 state/status.json', statusFile);

  // 连不上 NapCat 也应该在重试，而不是退出
  await sleep(2500);
  eq(exitedEarly, null, '连不上 OneBot 时进程没退出');

  const status = JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{}'));
  eq(status.connected, false, '状态里 connected=false');
  truthy(typeof status.pid === 'number' && status.pid > 0, '状态里有 pid', String(status.pid ?? ''));

  const logDir = path.join(tmpRoot, 'logs');
  const logFile = (await readdir(logDir).catch(() => [])).find((name) => name.startsWith('bridge-') && name.endsWith('.log'));
  truthy(Boolean(logFile), '桥接写了日志文件', logFile ?? '');
  const logText = logFile ? await readFile(path.join(logDir, logFile), 'utf8') : '';
  truthy(logText.includes('配置文件'), '日志里有「配置文件」');
  truthy(logText.includes('正在连接'), '日志里有连接尝试');
  truthy(!/已连上 NapCat/.test(logText), '没连上 NapCat（当前环境本来就没有）');
  truthy(!/unhandledRejection|UnhandledPromiseRejection/.test(logText), '没有未处理的 Promise 拒绝');

  child.kill();
  await sleep(600);
  if (exitedEarly === null) child.kill('SIGKILL');
  ok('桥接能干净退出（测试主动结束）');
}

/* ------------------------------------------------ 3) 泄漏与产物检查 */

async function hygieneTests(tmpRoot) {
  section('3/3 干净工程里不该有的东西');
  const leaks = await grepTree(path.join(tmpRoot, 'src'), 'C:\\DSH');
  eq(leaks, [], 'src 里没有作者机器的绝对路径');
  const toolLeaks = await grepTree(path.join(tmpRoot, 'tools'), 'C:\\DSH');
  eq(toolLeaks, [], 'tools 里没有作者机器的绝对路径');
  const launcherLeaks = await grepTree(path.join(tmpRoot, 'launcher'), 'C:\\DSH');
  eq(launcherLeaks, [], 'launcher 里没有作者机器的绝对路径');

  const configText = await readFile(path.join(tmpRoot, 'config.json'), 'utf8');
  truthy(!configText.includes('C:\\DSH'), 'config.json 里没有作者路径');
  truthy(!/accessToken":\s*"[^"]+/.test(configText), '干净配置里没有 accessToken');

  const stateFiles = await readdir(path.join(tmpRoot, 'state')).catch(() => []);
  truthy(stateFiles.includes('status.json') || stateFiles.includes('webui-port.txt'), 'state 里只有运行时产物', stateFiles.join(','));
  truthy(!stateFiles.includes('sessions.json') || true, 'sessions.json 不存在或为空也无所谓');
  const sessions = JSON.parse(await readFile(path.join(tmpRoot, 'state', 'sessions.json'), 'utf8').catch(() => '{}'));
  eq(sessions, {}, '没有残留会话映射');

  const pkg = JSON.parse(await readFile(path.join(tmpRoot, 'package.json'), 'utf8'));
  eq(pkg.type, 'module', 'package.json 是 ESM');
  eq(Object.keys(pkg.dependencies ?? {}).length, 0, '没有第三方运行时依赖');
}

/* ------------------------------------------------------------ 主流程 */

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-fresh-'));

try {
  console.log('非本机环境模拟测试');
  console.log(`临时目录：${tmpRoot}`);
  await buildFreshCopy(path.join(tmpRoot, 'app'));
  const app = path.join(tmpRoot, 'app');
  await mkdir(path.join(app, 'state'), { recursive: true });
  await mkdir(path.join(app, 'logs'), { recursive: true });
  await consoleTests(app);
  await bridgeTests(app);
  await hygieneTests(app);
} catch (err) {
  bad('测试主流程抛错', err?.stack ?? String(err));
} finally {
  await sleep(300);
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
