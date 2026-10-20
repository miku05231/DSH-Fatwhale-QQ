#!/usr/bin/env node
/**
 * tools/memory.mjs —— 读写 Obsidian 记忆库的命令行工具
 *
 * 设计要点：
 *   - 零第三方依赖，纯 ESM，只用 node: 内置模块。
 *   - 默认输出人读的中文；加 --json 输出机器可读 JSON。
 *   - 退出码：0 成功 / 1 参数错误 / 2 运行错误。
 *   - 记忆库路径：默认 <用户目录>\Documents\Obsidian Vault\大肥鱼，
 *     可以用 --root <目录> 或环境变量 QQ_MEMORY_ROOT 覆盖（测试用）。
 *
 * 用法：
 *   node tools\memory.mjs search <关键词> [--limit 8] [--json]
 *   node tools\memory.mjs recent [--days 3] [--json]
 *   node tools\memory.mjs person <QQ号> [--name 昵称] [--fact "…"]… [--json]
 *   node tools\memory.mjs group <群号> [--name 群名] [--fact "…"]… [--json]
 *   node tools\memory.mjs note --title "标题" --body "正文" [--dir 40-知识] [--tag x]… [--json]
 *   node tools\memory.mjs daily "要记的内容" [--json]
 *   node tools\memory.mjs stats [--json]
 *   node tools\memory.mjs path
 */

import path from 'node:path';

import { ObsidianMemory, DEFAULT_ROOT } from '../src/memory.js';

/** 本工具自己抛的「参数错误」：只打印 message，不打印堆栈，退出码 1 */
class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

/* ------------------------------------------------------------------ 输出 */

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function note(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** 打印 JSON（--json 模式统一走这里） */
function printJson(value) {
  out(JSON.stringify(value, null, 2));
}

/** 字节数 → 人读的大小 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:MM`；空值给「（还没有记录）」 */
function formatTime(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '（还没有记录）';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 参数 */

/**
 * 极简参数解析：
 *   --flag            布尔开关（值为 true）
 *   --key value       带值
 *   --key=value       带值（等号形式）
 *   其余              位置参数
 * 同一个 key 出现多次 → 收集成数组（--fact 就用这个）。
 * @returns {{positional: string[], options: Map<string, string[]>, flags: Set<string>}}
 */
function parseArgs(argv, { valueKeys = [], boolKeys = [] } = {}) {
  const positional = [];
  const options = new Map();
  const flags = new Set();
  const wantsValue = new Set(valueKeys);
  const isBool = new Set(boolKeys);

  const push = (key, value) => {
    if (!options.has(key)) options.set(key, []);
    options.get(key).push(value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];

    if (item === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (item.startsWith('--') && item.length > 2) {
      const eq = item.indexOf('=');
      const key = eq >= 0 ? item.slice(2, eq) : item.slice(2);
      if (eq >= 0) {
        push(key, item.slice(eq + 1));
        continue;
      }
      if (isBool.has(key) || (!wantsValue.has(key) && key === 'json')) {
        flags.add(key);
        continue;
      }
      if (wantsValue.has(key)) {
        if (i + 1 >= argv.length) throw new CliError(`--${key} 后面要跟一个值`);
        push(key, argv[i + 1]);
        i += 1;
        continue;
      }
      // 未知选项：按布尔开关处理，方便以后加参数
      flags.add(key);
      continue;
    }

    positional.push(item);
  }

  return { positional, options, flags };
}

/** 取第一个值（没有返回 undefined） */
function optOne(parsed, key) {
  const list = parsed.options.get(key);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** 取全部值（--fact 可重复） */
function optAll(parsed, key) {
  return parsed.options.get(key) ?? [];
}

/** 校验正整数参数 */
function optInt(parsed, key, fallback, { min = 1, max = 500 } = {}) {
  const raw = optOne(parsed, key);
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new CliError(`--${key} 必须是正整数，收到：${text}`);
  const n = Number(text);
  if (n < min || n > max) throw new CliError(`--${key} 必须在 ${min} 到 ${max} 之间，收到：${n}`);
  return n;
}

/** 建记忆库实例（--root / 环境变量优先，其次默认根目录） */
function makeMemory(parsed, { quiet = true } = {}) {
  const root = optOne(parsed, 'root') || (process.env.QQ_MEMORY_ROOT ?? '').trim() || DEFAULT_ROOT;
  const log = quiet
    ? { debug: () => {}, info: () => {}, warn: (m) => note(`提示：${m}`) }
    : undefined;
  return new ObsidianMemory({ root, log });
}

/* ------------------------------------------------------------------ 子命令 */

/** search <关键词> [--limit 8] [--json] */
async function cmdSearch(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['limit', 'root'], boolKeys: ['json'] });
  const query = parsed.positional.join(' ').trim();
  if (query === '') {
    throw new CliError('用法：node tools\\memory.mjs search <关键词> [--limit 8] [--json]');
  }
  const limit = optInt(parsed, 'limit', 8, { min: 1, max: 100 });

  const mem = makeMemory(parsed);
  await mem.ensure();
  const hits = await mem.search(query, { limit });

  if (parsed.flags.has('json')) {
    printJson({ ok: true, query, count: hits.length, results: hits });
    return 0;
  }
  if (hits.length === 0) {
    out(`没有找到和「${query}」有关的记忆。`);
    return 0;
  }
  out(`找到 ${hits.length} 条和「${query}」有关的记忆：`);
  hits.forEach((hit, i) => {
    out('');
    out(`${i + 1}. ${hit.title}`);
    out(`   位置：${hit.path}（相关度 ${hit.score}）`);
    out(`   摘录：${hit.snippet}`);
  });
  return 0;
}

/** recent [--days 3] [--json] */
async function cmdRecent(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['days', 'root'], boolKeys: ['json', 'full'] });
  const days = optInt(parsed, 'days', 3, { min: 1, max: 60 });

  const mem = makeMemory(parsed);
  await mem.ensure();
  const list = await mem.recentDaily(days);

  if (parsed.flags.has('json')) {
    printJson({ ok: true, days, count: list.length, items: list });
    return 0;
  }
  if (list.length === 0) {
    out('最近还没有日志。');
    return 0;
  }
  out(`最近 ${list.length} 天的日志（新 → 旧）：`);
  for (const item of list) {
    out('');
    out(`=== ${item.date}（${formatBytes(item.bytes)}）${item.path} ===`);
    out(parsed.flags.has('full') ? item.content.trimEnd() : clampText(item.content, 1200));
  }
  return 0;
}

/** person <QQ号> [--name 昵称] [--fact "…"]… [--json] */
async function cmdPerson(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['name', 'fact', 'root'], boolKeys: ['json'] });
  const qq = String(parsed.positional[0] ?? '').trim();
  if (qq === '') {
    throw new CliError('用法：node tools\\memory.mjs person <QQ号> [--name 昵称] [--fact "…"]… [--json]');
  }
  if (!/^\d+$/.test(qq)) throw new CliError(`QQ 号必须是纯数字，收到：${qq}`);

  const mem = makeMemory(parsed);
  await mem.ensure();
  const result = await mem.upsertPerson({
    qq,
    nickname: optOne(parsed, 'name'),
    facts: optAll(parsed, 'fact'),
  });

  if (parsed.flags.has('json')) {
    printJson({ ok: true, qq, ...result });
    return 0;
  }
  const how = result.created ? '新建' : '更新';
  const add = result.added > 0 ? `，新增 ${result.added} 条记忆` : '，没有新内容';
  out(`已${how}人物页：${result.path}${add}`);
  return 0;
}

/** group <群号> [--name 群名] [--fact "…"]… [--json] */
async function cmdGroup(argv) {
  const parsed = parseArgs(argv, {
    valueKeys: ['name', 'topic', 'fact', 'root'],
    boolKeys: ['json'],
  });
  const groupId = String(parsed.positional[0] ?? '').trim();
  if (groupId === '') {
    throw new CliError(
      '用法：node tools\\memory.mjs group <群号> [--name 群名] [--fact "…"]… [--json]',
    );
  }
  if (!/^\d+$/.test(groupId)) throw new CliError(`群号必须是纯数字，收到：${groupId}`);

  const mem = makeMemory(parsed);
  await mem.ensure();
  const result = await mem.upsertGroup({
    groupId,
    name: optOne(parsed, 'name'),
    topic: optOne(parsed, 'topic'),
    facts: optAll(parsed, 'fact'),
  });

  if (parsed.flags.has('json')) {
    printJson({ ok: true, groupId, ...result });
    return 0;
  }
  const how = result.created ? '新建' : '更新';
  const add = result.added > 0 ? `，新增 ${result.added} 条记忆` : '，没有新内容';
  out(`已${how}群聊页：${result.path}${add}`);
  return 0;
}

/** note --title "标题" --body "正文" [--dir 40-知识] [--tag x]… [--json] */
async function cmdNote(argv) {
  const parsed = parseArgs(argv, {
    valueKeys: ['title', 'body', 'dir', 'tag', 'root'],
    boolKeys: ['json'],
  });
  const title = (optOne(parsed, 'title') ?? parsed.positional[0] ?? '').trim();
  if (title === '') {
    throw new CliError(
      '用法：node tools\\memory.mjs note --title "标题" --body "正文" [--dir 40-知识] [--tag x]…',
    );
  }
  const body = optOne(parsed, 'body') ?? parsed.positional.slice(1).join(' ');
  const dir = optOne(parsed, 'dir') ?? '40-知识';

  const mem = makeMemory(parsed);
  await mem.ensure();
  const result = await mem.writeNote({ dir, title, body, tags: optAll(parsed, 'tag') });

  if (parsed.flags.has('json')) {
    printJson({ ok: true, title, ...result });
    return 0;
  }
  out(`已${result.created ? '新建' : '覆盖'}笔记：${result.path}（${formatBytes(result.bytes)}）`);
  return 0;
}

/** daily "要记的内容" [--json] */
async function cmdDaily(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['heading', 'root'], boolKeys: ['json'] });
  const text = parsed.positional.join(' ').trim();
  if (text === '') {
    throw new CliError('用法：node tools\\memory.mjs daily "要记的内容" [--json]');
  }

  const mem = makeMemory(parsed);
  await mem.ensure();
  const result = await mem.appendDaily(text, { heading: optOne(parsed, 'heading') });
  if (result === null) throw new Error('写入日志失败（记忆库不可写？）');

  if (parsed.flags.has('json')) {
    printJson({ ok: true, ...result });
    return 0;
  }
  out(`已记到 ${result.path}（小节 ${result.heading}）`);
  return 0;
}

/** stats [--json] */
async function cmdStats(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['root'], boolKeys: ['json'] });
  const mem = makeMemory(parsed);
  await mem.ensure();
  const s = await mem.stats();

  if (parsed.flags.has('json')) {
    printJson({ ok: true, ...s });
    return 0;
  }
  const parts = Object.entries(s.byDir).map(([label, n]) => `${label} ${n}`);
  out(`记忆库：${s.root}`);
  out(`文件数：${s.files}（${parts.join('、')}）`);
  out(`总大小：${formatBytes(s.totalBytes)}`);
  out(`最近更新：${formatTime(s.lastUpdated)}`);
  return 0;
}

/** path —— 打印记忆库绝对路径 */
async function cmdPath(argv) {
  const parsed = parseArgs(argv, { valueKeys: ['root'], boolKeys: ['json'] });
  const mem = makeMemory(parsed);
  await mem.ensure();
  if (parsed.flags.has('json')) printJson({ ok: true, root: mem.root });
  else out(mem.root);
  return 0;
}

/** 截断文本（给人读的输出用） */
function clampText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ 帮助 */

const USAGE = [
  '记忆库工具（Obsidian）',
  '',
  '用法：',
  '  node tools\\memory.mjs search <关键词> [--limit 8] [--json]',
  '  node tools\\memory.mjs recent [--days 3] [--json]',
  '  node tools\\memory.mjs person <QQ号> [--name 昵称] [--fact "…"]… [--json]',
  '  node tools\\memory.mjs group <群号> [--name 群名] [--fact "…"]… [--json]',
  '  node tools\\memory.mjs note --title "标题" --body "正文" [--dir 40-知识] [--tag x]… [--json]',
  '  node tools\\memory.mjs daily "要记的内容" [--json]',
  '  node tools\\memory.mjs stats [--json]',
  '  node tools\\memory.mjs path',
  '',
  '通用选项：',
  '  --json          输出机器可读的 JSON',
  '  --root <目录>   临时指定记忆库根目录（默认 ~\\Documents\\Obsidian Vault\\大肥鱼）',
  '',
  '示例：',
  '  node tools\\memory.mjs search 群聊',
  '  node tools\\memory.mjs person 1000000002 --name 主人 --fact "喜欢短句"',
  '  node tools\\memory.mjs daily "今天学会了做红烧肉"',
  '',
  '退出码：0 成功，1 参数错误，2 运行错误。',
].join('\n');

/* ------------------------------------------------------------------ 主流程 */

const COMMANDS = {
  search: cmdSearch,
  recent: cmdRecent,
  person: cmdPerson,
  group: cmdGroup,
  note: cmdNote,
  daily: cmdDaily,
  stats: cmdStats,
  path: cmdPath,
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    out(USAGE);
    return 0;
  }

  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    out(USAGE);
    return 0;
  }
  if (first === '--version' || first === '-v') {
    out('memory.mjs 1.0.0');
    return 0;
  }

  const handler = Object.prototype.hasOwnProperty.call(COMMANDS, first) ? COMMANDS[first] : null;
  if (!handler) {
    note(`未知子命令：${first}`);
    note('用 --help 查看用法。');
    return 1;
  }
  return handler(argv.slice(1));
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    if (err instanceof CliError) {
      note(`参数错误：${err.message}`);
      process.exitCode = 1;
      return;
    }
    note(`运行出错：${err?.message || err}`);
    if (process.env.QQ_MEMORY_DEBUG === '1' && err?.stack) note(err.stack);
    process.exitCode = 2;
  });
