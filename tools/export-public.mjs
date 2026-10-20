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
  'docs/控制台架构.md',
  'docs/测试清单.md',
  'docs/Docker部署.md',
  'README.md',
  'AGENTS.md',
  'scripts',
  'docker',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
  'qq-bridge.cmd',
  'start.sh',
];

/** 这些即使在白名单里也不复制 */
const EXCLUDE = [/state[\\/]/, /logs[\\/]/, /napcat[\\/]/, /node_modules[\\/]/, /\.tmp$/, /config\.json$/, /\.credentials/];

/** 文本文件后缀：参与脱敏 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.cmd', '.sh', '.bat', '.css', '.html', '.md', '.json', '.yml', '.yaml', '.txt', '.example']);

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
  [WORK_ROOT, 'C:\\DSH'],
  [HOME, 'C:\\Users\\you'],
];

/**
 * 同一个文件在不同机器上的路径写法不一样：文档里写反斜杠的单层路径，JS 字符串里写双层反斜杠。
 * 以及被小写化的 `c:\d\dsh`。三种都要换，否则自检会漏。
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
  ...REPLACEMENTS.map(([from]) => new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
  /xianapi\.cloud/i,
  /apikey\.fan/i,
  /sk-[A-Za-z0-9]{16,}/,
];

const PUBLIC_README = `# qq-dsh-bridge

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）接到 QQ 上的桥接程序：私聊、群聊、@ 唤醒、长期记忆、人格设定、模型跟随，外加一个 Material You 风格的本机控制台和一套插件系统。

> 非官方项目。QQ 侧通过第三方协议端 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）连接，**不符合腾讯服务条款，有封号风险**。请使用小号，并自行评估。

## 它能做什么

- **私聊 / 群聊**：白名单控制；群里 @ 或喊唤醒词才搭话，其余消息只记入群记忆
- **长期记忆**：对话自动落盘到 Obsidian 笔记库（日志 / 人物页 / 群页 / 反思），回复前按相关度召回
- **记忆反思**：控制台记忆页「立即反思」手动跑一次；也能每天定时（默认 04:00，关机错过会补跑），重写前自动备份成 \`.bak-时间戳\`
- **模型跟随**：读 DSH 桌面端的当前模型，QQ 侧下一条消息立刻跟着换，无需重启
- **人格**：用一份 \`AGENTS.md\` 定义它是谁、怎么说话
- **Native 能力**：DSH 的 MCP 工具与 skills 原样可用（drawio、duckduckgo、windows…）
- **控制台**：\`127.0.0.1:5830\`，八个页签（概览 / 记忆 / 表情 / 人格 / 会话 / 模型 / 插件 / 系统），可启停服务、改设置、看日志
- **表情包库**：自动收集聊天里的表情并打标签（来源 / 群 / 谁发的 / 关键词 / 动图静态 / 尺寸），可筛选、改标签、换存放目录、重建索引
- **插件**：往 \`src/plugins/\` 扔一个 .js 就能加功能，控制台自动生成开关与配置表单
- **托盘 / 自启**：一键启动全部、左键直达控制台、开机自启；托盘与窗口图标用 \`assets/app-icon.png\`

## 环境要求

- Windows 10/11（托盘用 WinForms，测试与 CDP 用 Edge）
- Node.js ≥ 20（无第三方 npm 依赖）
- DSH（DeepSeek Harness）已安装并可用 \`dsh\` 命令
- NapCat（同一个发布包里的无头版本即可，无需另装 QQ 客户端）

## 快速开始

\`\`\`powershell
# 1) 复制配置模板并改成你自己的
Copy-Item config.example.json config.json

# 2) 启动 NapCat（首次要扫码登录）
cd napcat; .\\node.exe index.js -q <你的机器人QQ号>

# 3) 启动桥接
node src\\index.js

# 4) 打开控制台
node src\\webui\\server.mjs   # 然后访问 http://127.0.0.1:5830
\`\`\`

也可以双击 \`launcher\\一键启动.cmd\`（托盘版，会依次拉起 NapCat → 桥接 → 控制台 → DSH）。

## 配置

见 \`config.example.json\`，每个字段都有注释式说明写在 \`docs/控制台架构.md\` 与 \`README.md\`（本文件由导出脚本生成，更完整的说明在导出的 \`README.md\` 之外的 \`docs/\`）。

关键字段：\`onebot.url\`、\`security.allowFrom\`（主人 QQ）、\`security.allowGroupIds\`、\`behavior.wakeWord\`、\`dsh.command\` = \`dsh\`、\`memory.root\`（Obsidian 库路径）。

## 测试

\`\`\`powershell
node tests\\run-all.mjs          # 全量（25 组，约 4 分钟）
node tests\\plugins-test.mjs     # 单跑插件宿主
\`\`\`

绝大多数用例自带假 NapCat / 假 dsh，不需要真账号；少数用例（\`perm-mode-check\`、\`real-config-check\`、\`e2e-memory\`）需要本机装有 DSH 和可用模型。

## 插件

\`\`\`js
export const meta = {
  name: 'ping',
  displayName: 'Ping',
  version: '1.0.0',
  description: '收到 /ping 时回一句',
  configSchema: [{ key: 'reply', type: 'string', label: '回复', default: 'pong' }],
};
export async function onMessage(ctx) {
  if (!ctx.text.startsWith('/ping')) return;
  await ctx.reply(ctx.config.reply);
  return { handled: true };
}
\`\`\`

三个钩子：\`onMessage\` / \`beforeReply\` / \`afterReply\`；插件按文件名排序，异常只记日志。详见 \`docs/控制台架构.md\`。

## 目录

\`\`\`
src/         桥接主体（index / onebot / dsh / security / memory / groupmem / plugins / model-follow）
src/webui/   控制台（零依赖 HTTP + Material 3 前端）
src/plugins/ 插件
launcher/    Windows 托盘（PowerShell 5.1 + WinForms）
tools/       命令行工具（qq / memory / model / reflect / export-public）
tests/       自测（假 NapCat、假 dsh、CDP 真渲染）
docs/        架构与测试清单
\`\`\`

## 许可

MIT，见 \`LICENSE\`。QQ 协议端是第三方项目，按其自身许可使用。
`;

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
    showErrors: true,
    wakeWord: '',
    wakeWordMatch: 'contains',
    groupContextCount: 40,
  },
  groupMemory: { limit: 300 },
  memory: {
    enabled: true,
    root: 'C:\\Users\\you\\Documents\\Obsidian Vault\\YourBot',
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
  const body = hasBom || ext === '.ps1' ? `\uFEFF${next}` : next;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, body, 'utf8');
  return { redacted: next !== text };
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
  const out = args.out;

  if (fs.existsSync(out)) {
    if (!args.force) {
      console.error(`输出目录已存在：${out}\n加 --force 覆盖，或换 --out 指定别的位置。`);
      process.exit(1);
    }
    await fsp.rm(out, { recursive: true, force: true });
  }
  await fsp.mkdir(out, { recursive: true });

  console.log(`导出源：${ROOT}`);
  console.log(`导出到：${out}\n`);

  const stats = { files: 0, redacted: 0, bytes: 0 };
  for (const item of INCLUDE) {
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
    ['README.md', PUBLIC_README],
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
    for (const re of FORBIDDEN) {
      const m = text.match(re);
      if (m) leaks.push(`${path.relative(out, file)} → ${m[0]}`);
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
    console.log('✔ 脱敏自检通过：没有 QQ 号、个人路径、密钥或私有端点残留');
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
