/**
 * tools/export-public.mjs —— 把私有工程「另存为」一份可以公开到 GitHub 的源码。
 *
 * 用户要求：「最终交付完毕后另存一份可公开的 github 项目源码」。
 *
 * 做法：**白名单复制 + 文本脱敏 + 生成公开文档**，而不是把整个目录打包 ——
 * 因为私有目录里有 QQ 号、个人路径、真实配置与日志，一旦随手 zip 就会泄出去。
 *
 * 用法：
 *   node tools\export-public.mjs                    # 默认输出到 ..\qq-bridge-public
 *   node tools\export-public.mjs --out D:\pub\bot   # 指定输出目录
 *   node tools\export-public.mjs --force            # 输出目录已存在时先清空
 *
 * 退出码 0 = 导出成功且脱敏自检通过；1 = 失败（会打印原因）。
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

/** 白名单：相对路径（目录会递归复制） */
const INCLUDE = [
  'src',
  'launcher',
  'assets',
  'tools',
  'tests',
  'runtime',
  'docs/astrbot.md',
  'docs/console.md',
  'docs/releases/v3.3.0-verification.md',
  'docs/releases/images/console-ui-20261110/embedded-light.png',
  'docs/releases/images/console-ui-20261110/embedded-dark.png',
  'docs/releases/images/console-ui-20261110/full-overview.png',
  'docs/控制台架构.md',
  'docs/测试清单.md',
  'docs/Docker部署.md',
  'docs/screenshots',
  'docs/更新发布.md',
  'docs/automation-and-voice.md',
  'docs/image-generation.md',
  'docs/media-providers.md',
  'docs/releases/v3.3.0.md',
  'docs/releases/v3.2.1.md',
  'docs/releases/v3.2.1-verification.md',
  'docs/releases/v3.2.0.md',
  'docs/releases/v3.2.0-verification.md',
  'docs/releases/v3.1.5.md',
  'docs/releases/v3.1.4.md',
  'docs/releases/v3.1.3.md',
  'docs/releases/v3.1.2.md',
  'docs/releases/v3.1.1.md',
  'docs/releases/v3.1.0.md',
  'docs/releases/v3.0.0.md',
  'docs/releases/v0.2.9.md',
  'docs/releases/v0.2.8.md',
  'docs/releases/v0.2.7.md',
  'docs/releases/v0.2.6.md',
  'docs/releases/v0.2.5.md',
  '.github',
  'README.md',
  'SPEC.md',
  'SPEC-2.md',
  'SPEC-launcher.md',
  'package.json',
  'deepseek-waitou.png',
  'scripts',
  'docker',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
  'qq-bridge.cmd',
  '一键启动.cmd',
  'install-napcat.cmd',
  'start-tray.cmd',
  'setup.cmd',
  'start.sh',
];

/** 这些即使在白名单里也不复制 */
const EXCLUDE = [/(^|[\\/])\.imagegen-runtime([\\/]|$)/, /(^|[\\/])(?:__pycache__|\.venv)([\\/]|$)/, /\.py[co]$/i, /^AGENTS\.md$/i, /^tools[\\/]sticker\.mjs$/, /state[\\/]/, /logs[\\/]/, /napcat[\\/]/, /node_modules[\\/]/, /\.tmp$/, /config\.json$/, /\.credentials/];

/** 文本文件后缀：参与脱敏 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.cmd', '.sh', '.bat', '.css', '.html', '.md', '.json', '.yml', '.yaml', '.txt', '.example', '.py', '.toml']);

/**
 * 替换表：越靠前越先替换（顺序要紧，长串在前）。
 *
 * 本机的用户目录 / 工程目录 / Obsidian 库都在运行时由环境算出，
 * 源码里不留任何个人绝对路径。
 */
const HOME = os.homedir();
const WORK_ROOT = path.resolve(ROOT, '..');
const VAULT_ROOT = path.join(HOME, 'Documents', 'Obsidian Vault');
const BASE_REPLACEMENTS = [
  [VAULT_ROOT, 'C:\\Users\\you\\Documents\\Obsidian Vault'],
  [ROOT, 'D:\\code\\qq-bridge'],
  [WORK_ROOT, 'C:\\your\\path'],
  [HOME, 'C:\\Users\\you'],
];

/**
 * 同一个文件在不同机器上的路径写法不一样：文档里写反斜杠的单层路径，JS 字符串里写双层反斜杠。
 * 以及被小写化的本机路径。三种都要换，否则自检会漏。
 */
function expandReplacements(pairs) {
  const out = [];
  for (const [from, to] of pairs) {
    out.push([from, to]);
    const escapedFrom = from.replace(/\\/g, '\\\\');
    const escapedTo = to.replace(/\\/g, '\\\\');
    if (escapedFrom !== from) out.push([escapedFrom, escapedTo]);
    const lowerFrom = from.toLowerCase();
    if (lowerFrom !== from) out.push([lowerFrom, to]);
    const lowerEscapedFrom = escapedFrom.toLowerCase();
    if (lowerEscapedFrom !== escapedFrom) out.push([lowerEscapedFrom, escapedTo]);
  }
  return out;
}

const REPLACEMENTS = expandReplacements(BASE_REPLACEMENTS);

/** 导出后绝不允许出现的片段（由替换表的明文自动推导，外加密钥/端点特征） */
const FORBIDDEN = [
  ...REPLACEMENTS.map(([from]) => ['本机路径', new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]),
  ['疑似密钥', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['URL 内嵌长凭据', /https?:\/\/[^/\s"'`<>:]+:[^/\s"'`<>@]{16,}@/i],
];


const GITIGNORE = `# 私有配置与运行产物
config.json
patches/*.yml
!patches/example-headless-model.yml
state/
logs/
napcat/
node_modules/
*.log
*.jsonl
.DS_Store
Thumbs.db
session*.json
docs/testing/
docs/work-progress.md
docs/full-verification-*.md
docs/update-program.md
`;

const GITATTRIBUTES = `# .ps1 必须保持「UTF-8 带 BOM + CRLF」原样：PS 5.1 没有 BOM 会按 ANSI 读、
# 直接乱码甚至语法错误。所以对 .ps1 关掉换行转换，让 git 按字节存。
*.ps1 -text
*.cmd text eol=crlf
*.bat text eol=crlf
*.js text eol=lf
*.mjs text eol=lf
*.md text eol=lf
*.css text eol=lf
*.html text eol=lf
*.json text eol=lf
*.yml text eol=lf
*.sh text eol=lf
`;

const LICENSE = `MIT License

Copyright (c) 2026 qq-dsh-bridge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const EXAMPLE_PATCH = `# patches/example-headless-model.yml
#
# headless profile 默认指向官方端点。如果你的账号余额不足（会报
# "QUOTA: Insufficient Balance"），就在这里覆写成任何 OpenAI 兼容的端点，
# 然后在 config.json 的 dsh.patchPath 指向本文件。
#
# 密钥不要写在这里：在 DSH 凭据库（~/.dsh/.credentials.yaml 的 refs 段）
# 里存一个同名变量，apiKeyEnv 按名字去取。
- id: llm-pi-ai
  config:
    providers:
      my-openai-compatible:
        apiKeyEnv: MY_LLM_API_KEY
        api: openai-completions
        baseURL: https://api.example.com/v1
        models:
          - id: some-fast-model
            contextWindow: 200000
            reasoningEfforts:
              off: null
              high: high
              max: max
- id: agent-default-model
  config:
    provider: my-openai-compatible
    model: some-fast-model
    reasoningEffort: max
`;

const EXAMPLE_CONFIG = {
  onebot: { url: 'ws://127.0.0.1:3001', accessToken: '' },
  dsh: {
    command: 'dsh',
    profile: 'headless',
    patchPath: 'patches/example-headless-model.yml',
    cwd: 'qq-workspace',
    timeoutMs: 300000,
    permissionMode: 'danger-full-access',
  },
  persona: {
    enabled: true,
    path: 'qq-workspace/AGENTS.md',
    maxChars: 8000,
    // 多套人格：每套一个 <dir>/<名字>.md，当前选择记在 <dir>/active.json
    dir: 'state/personas',
    active: '', // 想固定在某一套就写名字；空 = 听 active.json
  },
  security: {
    allowFrom: [1000000002],
    allowGroups: true,
    allowGroupMembers: true,
    allowGroupIds: [200000001],
    rateLimitPerMinute: 10,
    maxChars: 4000,
  },
  behavior: {
    queuedNotice: '收到，马上回复。',
    maxReplyChunk: 1200,
    sessionWindowMinutes: 180,
    showErrors: true,
    wakeWord: '',
    wakeWordMatch: 'contains',
    groupContextCount: 40,
  },
  groupMemory: { limit: 300 },
  memory: {
    enabled: true,
    root: '记忆库',
    capture: true,
    reflectEvery: 20,
    maxInjectChars: 1200,
    // 记忆反思：控制台「记忆」页有「立即反思」按钮，这里配自动那部分
    reflectDaily: true, // 每天自动跑一次；false 就只手动
    reflectTime: '04:00', // 几点跑（24 小时制，桥接每分钟看一次）
    reflectForce: true, // 重写本周那篇（不加 --force 时，已有素材就跳过）
    reflectDays: 3, // 拿最近几天的日志/对话当素材（1–30）
    reflectBackup: true, // 重写前备份成 .bak-时间戳（留最近 10 份）
    reflectCatchUp: true, // 关机错过的那次，开机后补跑一次
  },
  stickers: {
    enabled: true,
    root: 'state/stickers', // 表情包存这儿（相对项目根，也可以写 D:/表情包）
    autoCollect: true, // 自动收对话里出现的表情包（不用 @ 它）
    autoTag: true, // 自动打标签：来源/群/谁发的/关键词/动图还是静态/尺寸
    maxBytes: 5242880, // 单张上限 5 MB
    minBytes: 200, // 太小的不要
    maxPerMessage: 3, // 一条消息最多收几张
    perMinute: 20, // 每分钟最多收几张
  },
  plugins: { enabled: true, dir: 'src/plugins' },
  logDir: 'logs',
  stateDir: 'state',
};

function parseArgs(argv) {
  const out = { out: path.resolve(ROOT, '..', 'qq-bridge-public'), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      out.out = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--force') {
      out.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools\\export-public.mjs [--out <目录>] [--force]');
      process.exit(0);
    }
  }
  return out;
}

function redact(text) {
  let out = text;
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  return out;
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function safeOutputDirectory(value) {
  const resolved = path.resolve(value);
  const missing = [];
  let canonical;
  for (let probe = resolved; ; probe = path.dirname(probe)) {
    try {
      const item = await fsp.lstat(probe);
      if (item.isSymbolicLink()) throw new Error('Output paths must not traverse symbolic links or junctions.');
      if (probe === resolved && !item.isDirectory()) throw new Error('The output target must be a directory.');
      if (!canonical) canonical = path.join(await fsp.realpath(probe), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!canonical) missing.unshift(path.basename(probe));
    }
    if (path.dirname(probe) === probe) break;
  }
  const source = await fsp.realpath(ROOT);
  if (!canonical || isWithin(source, canonical) ||
      (isWithin(canonical, source) && !isWithin(canonical, path.join(source, 'dist')))) {
    throw new Error('Output must not contain the source tree or overlap its files; use dist or a separate directory.');
  }
  return canonical;
}

async function publicReadme() {
  // Keep the reviewed source documentation instead of regenerating stale release guidance.
  return redact(await fsp.readFile(path.join(ROOT, 'README.md'), 'utf8'));
}

/** 复制一个文件；文本文件顺便脱敏，.ps1 保持 BOM */
async function copyOne(srcPath, destPath) {
  const ext = path.extname(srcPath).toLowerCase();
  const raw = await fsp.readFile(srcPath);
  if (!TEXT_EXT.has(ext)) {
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, raw);
    return { redacted: false };
  }

  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  const next = redact(text);
  const normalized = ext === '.sh' ? next.replace(/\r\n/g, '\n') : next;
  const body = hasBom || ext === '.ps1' ? `\uFEFF${normalized}` : normalized;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, body, 'utf8');
  return { redacted: normalized !== text };
}

async function copyTree(srcDir, destDir, stats) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const rel = path.relative(ROOT, src);
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest, stats);
    } else if (entry.isFile()) {
      const result = await copyOne(src, dest);
      stats.files += 1;
      if (result.redacted) stats.redacted += 1;
      stats.bytes += (await fsp.stat(dest)).size;
    }
  }
}

async function walk(dir, visit) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let out = await safeOutputDirectory(args.out);
  const readme = await publicReadme();

  if (fs.existsSync(out)) {
    if (!args.force) {
      console.error(`输出目录已存在：${out}\n加 --force 覆盖，或换 --out 指定别的位置。`);
      process.exit(1);
    }
    out = await safeOutputDirectory(out);
    await fsp.rm(out, { recursive: true, force: true });
  }
  await fsp.mkdir(out, { recursive: true });

  console.log(`导出源：${ROOT}`);
  console.log(`导出到：${out}\n`);

  const stats = { files: 0, redacted: 0, bytes: 0 };
  for (const item of INCLUDE) {
    if (EXCLUDE.some((re) => re.test(item))) continue;
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      console.log(`  - 跳过（不存在）：${item}`);
      continue;
    }
    const dest = path.join(out, item);
    const st = await fsp.stat(src);
    if (st.isDirectory()) {
      await copyTree(src, dest, stats);
    } else {
      const result = await copyOne(src, dest);
      stats.files += 1;
      if (result.redacted) stats.redacted += 1;
      stats.bytes += (await fsp.stat(dest)).size;
    }
  }

  // 生成公开文档与模板
  const generated = [
    ['README.md', readme],
    ['LICENSE', LICENSE],
    ['.gitignore', GITIGNORE],
    ['.gitattributes', GITATTRIBUTES],
    ['config.example.json', `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`],
    ['patches/example-headless-model.yml', EXAMPLE_PATCH],
  ];
  for (const [rel, content] of generated) {
    const dest = path.join(out, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, 'utf8');
    stats.files += 1;
  }

  // 脱敏自检
  const leaks = [];
  await walk(out, async (file) => {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext) && path.basename(file) !== 'LICENSE' && !path.basename(file).startsWith('.git')) return;
    const text = await fsp.readFile(file, 'utf8');
    for (const [label, re] of FORBIDDEN) {
      if (re.test(text)) leaks.push(`${path.relative(out, file)} → ${label}`);
    }
  });

  console.log(`${'='.repeat(60)}`);
  console.log(`复制 ${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(2)} MB，其中 ${stats.redacted} 个做过文本脱敏`);
  if (leaks.length) {
    console.log(`\n✘ 脱敏自检发现 ${leaks.length} 处可疑内容：`);
    for (const leak of leaks.slice(0, 20)) console.log(`   - ${leak}`);
    console.log('\n请先修 EXPORT 规则或源文件，再重新导出。');
    process.exitCode = 1;
  } else {
    console.log('✔ 脱敏自检通过：未命中本机路径、已知密钥格式或 URL 内嵌长凭据；QQ 号及其他隐私需另行审查');
  }

  try {
    const head = execFileSync('git', ['-C', out, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    console.log(head.trim() ? `提示：${out} 已是 git 仓库（有未提交改动）` : `提示：${out} 已是 git 仓库（工作区干净）`);
  } catch {
    console.log(`\n下一步（可选）：\n  cd ${out}\n  git init -b main\n  git add -A\n  git commit -m "feat: initial public release"`);
  }
  console.log('='.repeat(60));
}

await main();
