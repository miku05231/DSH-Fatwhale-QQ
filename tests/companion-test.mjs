// tests/companion-test.mjs —— 桌面端连伴插件 + 桥接客户端 + 安装器
//
// 不启动 DSH：用本机 HTTP 假服务验证 discovery/鉴权/超时/错误语义；
// 安装器在临时 DSH_HOME 上真实执行一遍安装+卸载，不碰真实 profile。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import {
  probeCompanion,
  readCompanionDiscovery,
  resolveCompanionDiscoveryPath,
  runCompanionDsh,
} from '../src/dsh-companion.js';
import { runAgent } from '../src/agent-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-companion-'));
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
let passed = 0;

function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function okAsync(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const discoveryPath = path.join(tmp, 'discovery.json');
const cfg = { dsh: { companionDiscovery: discoveryPath } };

function writeDiscovery(port, overrides = {}) {
  fs.writeFileSync(
    discoveryPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      token: TOKEN,
      startedAt: new Date().toISOString(),
      ...overrides,
    }),
  );
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- discovery
ok('discovery 默认路径 = $DSH_HOME/qq-bridge-companion.json', () => {
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmp, 'home');
  try {
    assert.equal(
      resolveCompanionDiscoveryPath({ dsh: {} }),
      path.join(tmp, 'home', 'qq-bridge-companion.json'),
    );
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});

ok('discovery 文件缺失/损坏返回 null', () => {
  assert.equal(readCompanionDiscovery(cfg), null);
  fs.writeFileSync(discoveryPath, '{oops');
  assert.equal(readCompanionDiscovery(cfg), null);
  writeDiscovery(1, { token: 'short' });
  assert.equal(readCompanionDiscovery(cfg), null);
});

await okAsync('probeCompanion：没有文件时不可用且给出原因', async () => {
  fs.rmSync(discoveryPath, { force: true });
  const result = await probeCompanion(cfg);
  assert.equal(result.available, false);
  assert.match(result.reason, /discovery/);
});
// ---------------------------------------------------------------- HTTP 协议
await okAsync('probeCompanion：health 校验 token 并返回 pid', async () => {
  const server = await listen((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, version: 1 }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    const result = await probeCompanion(cfg);
    assert.equal(result.available, true);
    assert.equal(result.info.port, port);
    assert.equal(result.health.pid, process.pid);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：发 text/workspace/model，返回 final 文本', async () => {
  let received = null;
  const server = await listen(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    received = JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        sessionId: 'session-test-1',
        text: 'pong',
        elapsedMs: 12,
        workspaceId: 'ws-test',
      }),
    );
  });
  const { port } = server.address();
  writeDiscovery(port);
  const logs = [];
  try {
    const result = await runCompanionDsh('ping', {
      cfg,
      cwd: 'C:/work/qq-workspace',
      model: { provider: 'relay-a', model: 'm1' },
      log: { info: (line) => logs.push(line), warn: () => {} },
    });
    assert.equal(result.sessionId, 'session-test-1');
    assert.equal(result.finalText, 'pong');
    assert.equal(result.workspaceId, 'ws-test');
    assert.equal(received.text, 'ping');
    assert.equal(received.workspacePath, 'C:/work/qq-workspace');
    assert.deepEqual(received.model, { provider: 'relay-a', model: 'm1' });
    assert.match(logs.join('\n'), /session-test-1/);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：HTTP 错误保留 sessionId，标记 sessionAccepted', async () => {
  const server = await listen((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'model failed', sessionId: 'session-test-2' }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    await assert.rejects(
      () => runCompanionDsh('boom', { cfg, cwd: tmp }),
      (error) => {
        assert.equal(error.sessionAccepted, true);
        assert.equal(error.sessionId, 'session-test-2');
        assert.match(error.message, /model failed/);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：连不上时 channelError 且可安全回退', async () => {
  const server = await listen((req, res) => res.end());
  const { port } = server.address();
  await close(server);
  writeDiscovery(port);
  await assert.rejects(
    () => runCompanionDsh('x', { cfg, cwd: tmp }),
    (error) => {
      assert.equal(error.channelError, true);
      assert.equal(error.sessionAccepted, false);
      return true;
    },
  );
});

await okAsync('runAgent：companion 可用时优先走 companion', async () => {
  const fakeDshDir = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh');
  const fakeBin = path.join(fakeDshDir, 'lib', 'bin.js');
  const fakeProfile = path.join(tmp, 'profiles', 'desktop');
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.mkdirSync(fakeProfile, { recursive: true });
  fs.writeFileSync(
    path.join(fakeDshDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }),
  );
  fs.writeFileSync(fakeBin, '// fake bin\n');
  fs.writeFileSync(path.join(fakeProfile, 'package.json'), '{"name":"fake-desktop"}\n');
  const server = await listen((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    res.end(JSON.stringify({ ok: true, sessionId: 'session-route', text: 'via-companion' }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    const result = await runAgent('hi', {
      cfg: {
        dsh: {
          mode: 'desktop',
          command: fakeBin,
          desktopProfile: fakeProfile,
          companionDiscovery: discoveryPath,
        },
      },
      cwd: tmp,
      log: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.finalText, 'via-companion');
    assert.equal(result.sessionId, 'session-route');
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------- 配置
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), '{}\n');

ok('默认配置：companion 开启、discovery 为空', () => {
  const loaded = loadConfig(configDir, { createIfMissing: false });
  assert.equal(loaded.config.dsh.companion, true);
  assert.equal(loaded.config.dsh.companionDiscovery, '');
});

ok('配置校验：companion 必须是布尔、discovery 必须是字符串', () => {
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"dsh":{"companion":"yes"}}\n');
  assert.throws(
    () => loadConfig(configDir, { createIfMissing: false }),
    /dsh\.companion/,
  );
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"dsh":{"companionDiscovery":1}}\n');
  assert.throws(
    () => loadConfig(configDir, { createIfMissing: false }),
    /dsh\.companionDiscovery/,
  );
});

// ---------------------------------------------------------------- 安装器
const fakeHome = path.join(tmp, 'fake-home');
const profileDir = path.join(fakeHome, 'profiles', 'desktop');
fs.mkdirSync(profileDir, { recursive: true });
const patchPath = path.join(profileDir, 'cordis.patch.yml');
fs.writeFileSync(patchPath, '# existing\n');

function runInstaller(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools/install-companion.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: fakeHome },
  });
}

ok('安装器：dry-run 只打印、不改文件', () => {
  const before = fs.readFileSync(patchPath, 'utf8');
  const result = runInstaller(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qq-bridge-companion/);
  assert.equal(fs.readFileSync(patchPath, 'utf8'), before);
});

ok('安装器：安装后写入标记块，卸载后恢复原内容', () => {
  const install = runInstaller([]);
  assert.equal(install.status, 0, install.stderr);
  const installed = fs.readFileSync(patchPath, 'utf8');
  assert.match(installed, /# >>> qq-bridge companion/);
  assert.match(installed, /name: 'file:\/\/\/.*companion\/lib\/index\.js'/);
  assert.match(installed, /workspacePath: '/);
  assert.match(installed, /sessionMapPath: '/);
  assert.match(installed, /# existing/);

  const remove = runInstaller(['--remove']);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.readFileSync(patchPath, 'utf8'), '# existing\n');
});

ok('安装器：重复安装不会重复写块', () => {
  assert.equal(runInstaller([]).status, 0);
  assert.equal(runInstaller([]).status, 0);
  const text = fs.readFileSync(patchPath, 'utf8');
  assert.equal(text.match(/# >>> qq-bridge companion/g)?.length, 1);
  assert.equal(runInstaller(['--remove']).status, 0);
});

// ---------------------------------------------------------------- 源码契约
const pluginSource = fs.readFileSync(path.join(ROOT, 'companion/lib/index.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(ROOT, 'src/dsh-companion.js'), 'utf8');

ok('插件：只依赖 node: 内置模块，导出 name/inject/apply', () => {
  assert.match(pluginSource, /export const name = 'qq-bridge-companion'/);
  assert.match(pluginSource, /export const inject = \[/);
  assert.match(pluginSource, /export async function apply\(ctx/);
  assert.doesNotMatch(pluginSource, /from '(?!node:)[^']+'/);
  assert.doesNotMatch(pluginSource, /require\(/);
});

ok('插件：只监听 loopback、token 常量时间校验、有 discovery', () => {
  assert.match(pluginSource, /127\.0\.0\.1/);
  assert.match(pluginSource, /timingSafeEqual/);
  assert.match(pluginSource, /qq-bridge-companion\.json/);
  assert.match(pluginSource, /renameSync/);
});

ok('插件：按 workspaceId 建会话、支持历史补挂和取消', () => {
  assert.match(pluginSource, /workspaceId/);
  assert.match(pluginSource, /attachSession/);
  assert.match(pluginSource, /attachKnownSessions/);
  assert.match(pluginSource, /\/cancel/);
  assert.match(pluginSource, /controller\.cancel/);
});

ok('客户端：channelError / sessionAccepted 语义完整', () => {
  assert.match(clientSource, /channelError/);
  assert.match(clientSource, /sessionAccepted/);
  assert.match(clientSource, /\/prompt/);
  assert.match(clientSource, /workspacePath/);
});

ok('新文件都能通过 node --check', () => {
  for (const file of [
    'src/dsh-companion.js',
    'src/agent-runner.js',
    'src/config.js',
    'companion/lib/index.js',
    'tools/install-companion.mjs',
  ]) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

console.log(`\n通过 ${passed} 项`);
