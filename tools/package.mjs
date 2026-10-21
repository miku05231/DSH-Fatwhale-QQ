/**
 * tools/package.mjs —— 把 qq-bridge 打包成可分发、可运行的应用目录（零依赖）
 *
 * 产物（默认 dist\qq-dsh-bridge-<version>\）：
 *   src\ launcher\ tools\ tests\ docs\ patches\
 *   README.md  config.example.json  一键启动.cmd  初始化配置.cmd  打包信息.json  package.json
 *   可选：同名 .zip（--no-zip 关掉）
 *
 * 设计原则：
 *   * 白名单复制：只带运行需要的文件，state\ logs\ napcat\ config.json 一律不进包
 *   * 脱敏：QQ 号、个人路径、WebUI token、私有 API 端点换成占位符
 *   * .ps1 保持 UTF-8 BOM（PS 5.1 读中文的前提）
 *   * 产物自带测试，跑 `node tests\blacklist-test.mjs` 就能验证拷贝出来的代码是活的
 *
 * 用法：
 *   node tools\package.mjs                     # 打包到 dist\qq-dsh-bridge-<ver> + zip
 *   node tools\package.mjs --out D:\tmp\app    # 指定目标目录（必须不存在或配合 --force）
 *   node tools\package.mjs --no-zip            # 只出目录
 *   node tools\package.mjs --force             # 目标已存在时先删掉
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 只复制这些（目录递归、文件单个） */
const INCLUDE_DIRS = ['src', 'launcher', 'tools', 'tests', 'docs', 'patches', 'assets', 'scripts', 'docker'];
const INCLUDE_FILES = [
  'README.md',
  'deepseek-waitou.png',
  'LICENSE',
  'config.example.json',
  'package.json',
  '一键启动.cmd',
  'start-tray.cmd',
  'setup.cmd',
  'install-napcat.cmd',
  'qq-bridge.cmd',
  'start.sh',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
];

/** 这些目录/文件永远不进包 */
const EXCLUDE = [
  /(^|[\\/])state([\\/]|$)/,
  /(^|[\\/])logs([\\/]|$)/,
  /(^|[\\/])napcat([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])qq-workspace([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])config\.json$/,
  // 开发用工具：它自己就写着本机的私有路径/QQ 号清单，不该进发行包
  /(^|[\\/])tools[\\/]export-public\.mjs$/,
  // 本机专用的模型路由补丁（含私有中转地址）
  /\.local\.ya?ml$/,
  /\.tmp$/,
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.ps1', '.cmd', '.sh', '.txt', '.html', '.css']);

/**
 * 个人/私有信息 → 占位符（顺序敏感：长的先换）。
 *
 * 本机的用户目录、工程目录都在运行时由 os.homedir() / import.meta.url 算出来，
 * 源码里不写死任何绝对路径，换机器也不用改这张表。
 */
const HOME = os.homedir();
const WORK_ROOT = path.resolve(ROOT, '..');
const VAULT_ROOT = path.join(HOME, 'Documents', 'Obsidian Vault');

/** 同一个路径在文档里是单反斜杠、在 JS 源码里是双反斜杠，小写化还可能不同，全都要换 */
function variants(from, to) {
  const out = [[from, to]];
  const escaped = from.replace(/\\/g, '\\\\');
  const escapedTo = to.replace(/\\/g, '\\\\');
  if (escaped !== from) out.push([escaped, escapedTo]);
  const lower = from.toLowerCase();
  if (lower !== from) out.push([lower, to]);
  const lowerEscaped = escaped.toLowerCase();
  if (lowerEscaped !== escaped) out.push([lowerEscaped, escapedTo]);
  return out;
}

const REPLACEMENTS = [
  ...variants(ROOT, 'C:\\your\\path\\qq-bridge'),
  ...variants(WORK_ROOT, 'C:\\your\\path'),
  ...variants(VAULT_ROOT, 'C:\\Users\\you\\Documents\\Obsidian Vault'),
  ...variants(HOME, 'C:\\Users\\you'),
];

/** 打包后绝不允许出现的片段：上面的明文 + 私有端点/密钥特征 */
const FORBIDDEN = [
  ...REPLACEMENTS.map(([from]) => new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
  /xianapi\.cloud/i,
  /apikey\.fan/i,
  /sk-[A-Za-z0-9]{16,}/,
];

const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MANIFEST_NAME = '打包信息.json';

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

/** 一条路径是否要排除 */
function excluded(rel) {
  const normalized = rel.split(path.sep).join('/');
  if (EXCLUDE.some((re) => re.test(normalized))) return true;
  // 测试夹具里偶尔出现 .bak / .old
  return /\.(bak|old|orig)$/i.test(normalized);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function readVersion() {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    return String(raw.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

async function walk(dir, base = '') {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (excluded(rel)) continue;
    if (entry.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** 文本脱敏；非文本原样 */
async function copyFile(src, dest, rel) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) {
    await fsp.copyFile(src, dest);
    return false;
  }
  let text = await fsp.readFile(src, 'utf8');
  for (const [from, to] of REPLACEMENTS) {
    if (!text.includes(from)) continue;
    text = text.split(from).join(to);
  }
  // .ps1 必须是 UTF-8 with BOM，否则 PS 5.1 会把中文读成乱码
  const bom = ext === '.ps1' ? '\uFEFF' : '';
  await fsp.writeFile(dest, `${bom}${text.replace(/^\uFEFF/, '')}`, 'utf8');
  return true;
}

const FIRST_RUN = `@echo off
rem ============================================================
rem  QQ-DSH Bridge - first run helper (ASCII only on purpose)
rem
rem  Copies config.example.json to config.json when missing, then
rem  tells you what to edit.  Safe to run repeatedly.
rem ============================================================
setlocal
cd /d "%~dp0"

if exist "config.json" (
  echo [i] config.json already exists - nothing to do.
) else (
  copy /y "config.example.json" "config.json" >nul
  echo [i] Created config.json from config.example.json.
  echo [i] Edit it first: security.allowFrom / allowGroupIds / denyFrom / denyGroupIds
)

echo.
echo [i] Next steps:
echo     1^) Install NapCat 4.x Shell package into the napcat\\ folder
echo        ^(see README.md - https://github.com/NapNeko/NapCatQQ^)
echo     2^) Double-click 一键启动.cmd
echo     3^) The console opens at http://127.0.0.1:5830
echo.
pause
exit /b 0
`;

async function build({ outDir, zip }) {
  const version = await readVersion();
  const files = [];
  for (const dir of INCLUDE_DIRS) {
    const rels = await walk(ROOT, dir);
    for (const rel of rels) files.push(rel);
  }
  for (const file of INCLUDE_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) files.push(file);
  }

  await fsp.mkdir(outDir, { recursive: true });
  let sanitized = 0;
  for (const rel of files) {
    const worked = await copyFile(path.join(ROOT, rel), path.join(outDir, rel), rel);
    if (worked) sanitized += 1;
  }

  await fsp.writeFile(path.join(outDir, '初始化配置.cmd'), FIRST_RUN.replace(/\r?\n/g, '\r\n'), 'utf8');

  const manifest = {
    name: 'qq-dsh-bridge',
    version,
    builtAt: new Date().toISOString(),
    builtFrom: 'tools/package.mjs',
    files: files.length + 2,
    sanitizedFiles: sanitized,
    notes: [
      '运行前先双击「初始化配置.cmd」生成 config.json，并按自己的 QQ 号改黑白名单',
      'NapCat 不进包：把 NapCat.Shell.Windows.Node 解压到 napcat\\ 目录（见 README）',
      'state\\ 与 logs\\ 首次运行时自动创建',
    ],
  };
  await fsp.writeFile(path.join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 自检：产物里不能有个人信息
  const hits = [];
  const packaged = await walk(outDir, '');
  for (const rel of packaged) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
    const text = await fsp.readFile(path.join(outDir, rel), 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(text)) hits.push(`${rel} → ${re}`);
    }
  }

  let zipPath = null;
  if (zip) {
    zipPath = `${outDir}.zip`;
    await fsp.rm(zipPath, { force: true });
    try {
      execFileSync(PS, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Compress-Archive -Path ${psQuote(outDir)} -DestinationPath ${psQuote(zipPath)} -Force`,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      console.log(`[!] 生成 zip 失败（目录仍然可用）：${err?.message ?? err}`);
      zipPath = null;
    }
  }

  return { version, outDir, files: packaged.length, sanitized, zipPath, hits };
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log('用法：node tools\\package.mjs [--out <dir>] [--no-zip] [--force]');
    return;
  }

  const version = await readVersion();
  const outDir = path.resolve(argValue('--out', path.join(ROOT, 'dist', `qq-dsh-bridge-${version}`)));
  const zip = !hasFlag('--no-zip');
  const force = hasFlag('--force');

  if (fs.existsSync(outDir)) {
    if (!force) {
      console.error(`目标已存在：${outDir}\n加 --force 覆盖，或换一个 --out。`);
      process.exitCode = 1;
      return;
    }
    await fsp.rm(outDir, { recursive: true, force: true });
  }

  console.log(`打包 qq-dsh-bridge v${version}`);
  console.log(`  源目录：${ROOT}`);
  console.log(`  目标：  ${outDir}`);
  const result = await build({ outDir, zip });

  console.log('');
  console.log(`✔ 文件 ${result.files} 个（其中文本脱敏 ${result.sanitized} 个）`);
  if (result.zipPath) {
    const size = fs.statSync(result.zipPath).size;
    console.log(`✔ zip：${result.zipPath}（${(size / 1024 / 1024).toFixed(2)} MB）`);
  }
  if (result.hits.length) {
    console.error(`\n✘ 脱敏自检失败，发现 ${result.hits.length} 处：`);
    for (const hit of result.hits.slice(0, 20)) console.error(`   ${hit}`);
    process.exitCode = 1;
    return;
  }
  console.log('✔ 脱敏自检通过：没有 QQ 号、个人路径、token 或私有端点残留');
  console.log('');
  console.log('下一步：');
  console.log(`  1) 把 NapCat 解压到 ${path.join(outDir, 'napcat')}`);
  console.log(`  2) 双击 ${path.join(outDir, '初始化配置.cmd')}，按自己的号改 config.json`);
  console.log(`  3) 双击 ${path.join(outDir, '一键启动.cmd')}`);
  console.log(`  自检：node ${path.join(outDir, 'tests', 'blacklist-test.mjs')}`);
}

await main();
