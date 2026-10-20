// tests/agent-runner-test.mjs —— DSH 运行模式（desktop / headless）与配置校验
//
// 不启动真实 DSH：用临时目录伪造一个 @deepseek-ai/dsh 安装 + desktop profile，
// 验证安装根解析、profile 探测、auto/desktop/headless 路由和配置默认值/校验。
// 真实宿主启动属于慢速集成测试，放 tests/desktop-live.mjs（默认不进 run-all）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  loadConfig,
  resolvePath,
} from '../src/config.js';
import {
  detectDesktopProfile,
  resolveDesktopProfileDir,
  resolveDshInstallRoot,
} from '../src/dsh-desktop.js';
import { resolveAgentMode } from '../src/agent-runner.js';
import { redactSecrets } from '../src/redact.js';

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-agent-'));
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

// ---------------------------------------------------------------- 伪造安装
const dshDir = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh');
const binPath = path.join(dshDir, 'lib', 'bin.js');
const profileDir = path.join(tmp, 'profiles', 'desktop');
fs.mkdirSync(path.dirname(binPath), { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(
  path.join(dshDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }),
);
fs.writeFileSync(binPath, '// fake dsh bin\n');
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-desktop' }));

const baseCfg = {
  dsh: {
    command: binPath,
    mode: 'auto',
    desktopProfile: profileDir,
    timeoutMs: 30000,
  },
};

// ---------------------------------------------------------------- 安装根
ok('从 bin.js 解析出 @deepseek-ai/dsh 安装根', () => {
  assert.equal(resolveDshInstallRoot(binPath, tmp), dshDir);
});

ok('profile 目录支持绝对路径', () => {
  assert.equal(resolveDesktopProfileDir(baseCfg), profileDir);
});

ok('profile 目录默认落在 $DSH_HOME/profiles/<name>', () => {
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmp, 'fake-home');
  try {
    assert.equal(
      resolveDesktopProfileDir({ dsh: { desktopProfile: 'desktop' } }),
      path.join(tmp, 'fake-home', 'profiles', 'desktop'),
    );
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});

ok('探测到完整 desktop profile', () => {
  const probe = detectDesktopProfile(baseCfg, tmp);
  assert.equal(probe.available, true);
  assert.equal(probe.root, dshDir);
  assert.equal(probe.profileDir, profileDir);
});

ok('profile 不存在时给出原因而不是抛异常', () => {
  const probe = detectDesktopProfile(
    { dsh: { command: binPath, desktopProfile: path.join(tmp, 'nope') } },
    tmp,
  );
  assert.equal(probe.available, false);
  assert.match(probe.reason, /没有 desktop profile/);
});

// ---------------------------------------------------------------- 路由
ok('mode=headless 直接走 headless', () => {
  const result = resolveAgentMode({ dsh: { ...baseCfg.dsh, mode: 'headless' } }, { cwd: tmp });
  assert.equal(result.mode, 'headless');
  assert.match(result.reason, /headless/);
});

ok('mode=auto 且 profile 可用 → desktop', () => {
  const result = resolveAgentMode(baseCfg, { cwd: tmp });
  assert.equal(result.mode, 'desktop');
  assert.equal(result.probe.available, true);
});

ok('mode=auto 且 profile 缺失 → headless（带原因）', () => {
  const result = resolveAgentMode(
    { dsh: { ...baseCfg.dsh, desktopProfile: path.join(tmp, 'nope') } },
    { cwd: tmp },
  );
  assert.equal(result.mode, 'headless');
  assert.match(result.reason, /desktop profile/);
});

ok('mode=desktop 即使探测失败也强制 desktop（由回退兜底）', () => {
  const result = resolveAgentMode(
    { dsh: { ...baseCfg.dsh, mode: 'desktop', desktopProfile: path.join(tmp, 'nope') } },
    { cwd: tmp },
  );
  assert.equal(result.mode, 'desktop');
  assert.equal(result.probe.available, false);
});

// ---------------------------------------------------------------- 配置
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), '{}\n');

ok('默认配置：auto + desktop profile + 回退开启', () => {
  const loaded = loadConfig(configDir, { createIfMissing: false });
  assert.equal(loaded.config.dsh.mode, 'auto');
  assert.equal(loaded.config.dsh.desktopProfile, 'desktop');
  assert.equal(loaded.config.dsh.desktopBootTimeoutMs, 120000);
  assert.equal(loaded.config.dsh.desktopIdleMs, 900000);
  assert.equal(loaded.config.dsh.fallbackToHeadless, true);
  assert.equal(DEFAULTS.dsh.mode, 'auto');
});

function withConfig(patch) {
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(patch, null, 2)}\n`,
  );
  return loadConfig(configDir, { createIfMissing: false });
}

ok('dsh.mode 只接受 auto/desktop/headless', () => {
  assert.throws(() => withConfig({ dsh: { mode: 'electron' } }), /dsh\.mode/);
});

ok('dsh.desktopIdleMs 必须是非负整数', () => {
  assert.throws(() => withConfig({ dsh: { desktopIdleMs: -1 } }), /dsh\.desktopIdleMs/);
  assert.throws(() => withConfig({ dsh: { desktopIdleMs: 1.5 } }), /dsh\.desktopIdleMs/);
});

ok('dsh.desktopBootTimeoutMs 必须是正整数', () => {
  assert.throws(() => withConfig({ dsh: { desktopBootTimeoutMs: 0 } }), /desktopBootTimeoutMs/);
});

ok('dsh.fallbackToHeadless 必须是布尔', () => {
  assert.throws(() => withConfig({ dsh: { fallbackToHeadless: 'yes' } }), /fallbackToHeadless/);
});

ok('resolvePath 仍按项目根解析相对路径', () => {
  assert.equal(resolvePath(configDir, 'logs'), path.join(configDir, 'logs'));
});

// ---------------------------------------------------------------- 脱敏
ok('脱敏 token / Bearer / sk- / apiKey', () => {
  assert.doesNotMatch(redactSecrets('http://127.0.0.1:3080/?token=abc123'), /abc123/);
  assert.doesNotMatch(redactSecrets('Authorization: Bearer abc.def-123'), /abc\.def/);
  assert.doesNotMatch(redactSecrets('s' + 'k-1234567890abcdefg'), /1234567890/);
  assert.doesNotMatch(redactSecrets('"apiKey": "secret-value"'), /secret-value/);
  assert.match(redactSecrets('x'.repeat(5000), 100), /…$/);
});

// ---------------------------------------------------------------- 文件契约
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostSource = fs.readFileSync(path.join(root, 'src/dsh-desktop-host.mjs'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'src/dsh-desktop.js'), 'utf8');

ok('宿主：stdout 只走协议、吞掉 DSH banner', () => {
  assert.match(hostSource, /rawWrite/);
  assert.match(hostSource, /process\.stdout\.write = function swallow/);
  assert.match(hostSource, /--no-open/);
  assert.match(hostSource, /--port', '0'/);
});

ok('宿主：有启动超时、取消、flush 和脱敏', () => {
  assert.match(hostSource, /bootTimer/);
  assert.match(hostSource, /handleCancel/);
  assert.match(hostSource, /sessions\.flush/);
  assert.match(hostSource, /redactSecrets/);
});

ok('客户端：失败可区分「启动失败」与「会话已接受」', () => {
  assert.match(clientSource, /desktopBootFailure/);
  assert.match(clientSource, /sessionAccepted/);
  assert.match(clientSource, /killProcessTree/);
  assert.match(clientSource, /desktopIdleMs/);
});

ok('三个新文件都能通过 node --check', () => {
  for (const file of ['src/dsh-desktop-host.mjs', 'src/dsh-desktop.js', 'src/agent-runner.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

console.log(`\n通过 ${passed} 项`);
