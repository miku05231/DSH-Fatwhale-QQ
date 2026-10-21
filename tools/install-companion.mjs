#!/usr/bin/env node
// tools/install-companion.mjs —— 把 qq-bridge companion 插件装进 DSH Desktop 的 profile
//
// 装好并重启一次 DSH 之后，桥接的 QQ 会话会由桌面宿主自己创建：
//   - 会话直接挂到 qq-workspace 下，不再是「未分组」
//   - 桌面端会话列表实时出现，不用刷新
//
// 用法：
//   node tools/install-companion.mjs                  安装（默认 desktop profile）
//   node tools/install-companion.mjs --remove         卸载
//   node tools/install-companion.mjs --dry-run        只打印将写入的补丁
//   node tools/install-companion.mjs --profile work   指定 profile 名
//
// 只改 <DSH_HOME>/profiles/<profile>/cordis.patch.yml，写入前备份；
// 块用显式标记包住，可重复执行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK_START = '# >>> qq-bridge companion（由 tools/install-companion.mjs 管理）>>>';
const MARK_END = '# <<< qq-bridge companion <<<';

function parseArgs(argv) {
  const options = { profile: 'desktop', remove: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--remove') options.remove = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--profile') options.profile = String(argv[++i] ?? '').trim();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.profile) throw new Error('--profile 不能为空');
  return options;
}

function fail(message) {
  console.error(`安装失败：${message}`);
  process.exit(1);
}

function dshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh');
}

/** 从 config.json 读 dsh.cwd；读不到就用 qq-workspace。 */
function resolveWorkspace() {
  const configPath = path.join(PROJECT_ROOT, 'config.json');
  let cwd = 'qq-workspace';
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const raw = String(config?.dsh?.cwd ?? '').trim();
    if (raw && raw !== '.') cwd = raw;
  } catch {
    // 没有 config.json 时用默认值，不阻塞安装
  }
  const absolute = path.isAbsolute(cwd) ? cwd : path.resolve(PROJECT_ROOT, cwd);
  return absolute === PROJECT_ROOT ? path.join(PROJECT_ROOT, 'qq-workspace') : absolute;
}

function pluginUrl() {
  const entry = path.join(PROJECT_ROOT, 'src', 'companion', 'lib', 'index.js');
  if (!fs.existsSync(entry)) fail(`找不到插件入口 ${entry}`);
  return `file:///${entry.replaceAll('\\', '/')}`;
}

function yamlPath(value) {
  // YAML 单引号里反斜杠不转义；路径里的单引号转成两个
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildBlock(workspace, sessionMap) {
  return [
    MARK_START,
    '- insert:',
    '    - id: qq-bridge-companion',
    `      name: ${yamlPath(pluginUrl())}`,
    '      config:',
    `        workspacePath: ${yamlPath(workspace)}`,
    `        sessionMapPath: ${yamlPath(sessionMap)}`,
    MARK_END,
    '',
  ].join('\n');
}

function stripBlock(text) {
  const start = text.indexOf(MARK_START);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END, start);
  if (end < 0) fail('cordis.patch.yml 里的 companion 标记不完整，请手动检查');
  const after = text.indexOf('\n', end);
  return text.slice(0, start) + (after < 0 ? '' : text.slice(after + 1));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node tools/install-companion.mjs [--profile desktop] [--remove] [--dry-run]');
    return;
  }
  const home = dshHome();
  const profileDir = path.join(home, 'profiles', options.profile);
  if (!fs.existsSync(profileDir)) {
    fail(`profile 目录不存在：${profileDir}\n请先在 DSH Desktop 里创建/使用 profile「${options.profile}」`);
  }
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  const cleaned = stripBlock(original);

  if (options.remove) {
    if (cleaned === original) {
      console.log(`没有找到 companion 补丁，无需卸载：${patchPath}`);
      return;
    }
    if (options.dryRun) {
      console.log(`--- 将从 ${patchPath} 删除 companion 块（dry-run）---`);
      return;
    }
    backup(patchPath, original);
    fs.writeFileSync(patchPath, cleaned, 'utf8');
    console.log(`已卸载 companion：${patchPath}\n重启 DSH 后生效。`);
    return;
  }

  const workspace = resolveWorkspace();
  const sessionMap = path.join(PROJECT_ROOT, 'state', 'sessions.json');
  const block = buildBlock(workspace, sessionMap);
  const next = `${cleaned}${cleaned.endsWith('\n') || cleaned === '' ? '' : '\n'}${block}`;

  console.log('DSH_HOME   :', home);
  console.log('profile    :', profileDir);
  console.log('workspace  :', workspace);
  console.log('sessionMap :', sessionMap);
  if (options.dryRun) {
    console.log(`--- 将写入 ${patchPath}（dry-run）---`);
    console.log(block);
    return;
  }
  backup(patchPath, original);
  fs.writeFileSync(patchPath, next, 'utf8');
  console.log(`\n已写入 companion 补丁：${patchPath}`);
  console.log('请重启 DSH Desktop（完全退出再打开），之后 QQ 消息会在桌面端实时出现。');
  console.log('验证：看日志出现「DSH desktop 连伴可用」，或检查', path.join(home, 'qq-bridge-companion.json'));
}

function backup(file, content) {
  if (!content) return;
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/, '');
  const backupPath = `${file}.bak-${stamp}`;
  fs.writeFileSync(backupPath, content, 'utf8');
  console.log('已备份   :', backupPath);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
