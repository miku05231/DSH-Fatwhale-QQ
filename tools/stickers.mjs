#!/usr/bin/env node
/**
 * tools/stickers.mjs —— 表情包库的命令行工具
 *
 * 谁在用：
 *   - DSH 想回一张表情时：`pick` 拿本地路径，再用 qq.mjs 发出去；
 *   - 人想手动管库时：`list / tags / add / tag / delete / rebuild / migrate`；
 *   - 排查索引问题时：`stats`、`rebuild`。
 *
 * 设计要点：
 *   - 零第三方依赖，纯 ESM。
 *   - 默认输出人读的中文；加 --json 输出机器可读 JSON。
 *   - 退出码：0 成功 / 1 参数错误 / 2 运行错误。
 *   - 库目录：默认读 config.json 的 stickers.root（相对项目根解析），
 *     可以用 --root <目录> 或环境变量 QQ_STICKER_ROOT 覆盖。
 *
 * 用法：
 *   node tools\stickers.mjs list   [--tag 类型:动图] [--query 猫] [--limit 20] [--json]
 *   node tools\stickers.mjs tags   [--json]
 *   node tools\stickers.mjs pick   [--tag 类型:动图] [--query 猫] [--json]
 *   node tools\stickers.mjs add    <图片文件或http(s)地址> [--tag a,b] [--json]
 *   node tools\stickers.mjs import-manifest <manifest.json> [--dry-run] [--json]
 *   node tools\stickers.mjs tag    <id> [--add a,b] [--remove c] [--json]
 *   node tools\stickers.mjs delete <id> [--json]
 *   node tools\stickers.mjs rebuild [--json]
 *   node tools\stickers.mjs stats  [--json]
 *   node tools\stickers.mjs migrate <目标目录> [--no-config] [--delete-source] [--json]
 *   node tools\stickers.mjs open
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalPath } from '../src/open-path.js';

import {
  deleteSticker,
  ensureIndex,
  listStickers,
  loadIndex,
  migrateStore,
  normalizeStickerSettings,
  pickSticker,
  rebuildIndex,
  resolveStickerFile,
  stickerRootDir,
  storeStats,
  tagCounts,
  updateTags,
  upsertSticker,
} from '../src/stickers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/** 参数错误：只打印 message，不打印堆栈，退出码 1 */
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

function printJson(value) {
  out(JSON.stringify(value, null, 2));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 参数 */

/**
 * 极简参数解析：--flag 布尔；--key value / --key=value 带值；其余位置参数。
 * 同一个 key 出现多次收集成数组。
 */
function parseArgs(argv, { valueKeys = [], boolKeys = [] } = {}) {
  const positional = [];
  const options = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase();
      if (boolKeys.includes(key)) {
        flags.add(key);
        continue;
      }
      if (valueKeys.includes(key)) {
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
        if (value === undefined) throw new CliError(`--${key} 后面要跟一个值`);
        if (eq < 0) i += 1;
        const list = options.get(key) ?? [];
        list.push(value);
        options.set(key, list);
        continue;
      }
      throw new CliError(`不认识的参数：--${key}`);
    }
    positional.push(arg);
  }
  return {
    positional,
    flags,
    option: (key) => options.get(key)?.at(-1),
    optionList: (key) => options.get(key) ?? [],
  };
}

/** "a,b, c" → ['a','b','c']；也支持多次 --tag */
function splitTags(values) {
  const out2 = [];
  for (const value of values) {
    for (const piece of String(value).split(/[,，]/)) {
      const tag = piece.trim();
      if (tag && !out2.includes(tag)) out2.push(tag);
    }
  }
  return out2;
}

/* ------------------------------------------------------------------ 配置 */

function configFile(parsed) {
  const custom = String(parsed?.option('config') ?? process.env.QQ_CONFIG ?? '').trim();
  if (!custom) return path.join(PROJECT_ROOT, 'config.json');
  const wanted = path.resolve(process.cwd(), custom);
  let stat;
  try { stat = fs.statSync(wanted); } catch { /* 缺失路径仍按文件后缀区分，读取时会报错。 */ }
  if (stat?.isDirectory()) return path.join(wanted, 'config.json');
  if (stat?.isFile() || path.extname(wanted).toLowerCase() === '.json') return wanted;
  return path.join(wanted, 'config.json');
}

function readConfig(parsed) {
  try {
    return JSON.parse(fs.readFileSync(configFile(parsed), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    if (parsed?.option('config') || process.env.QQ_CONFIG) {
      throw new CliError(`无法读取配置：${configFile(parsed)}`);
    }
    return null;
  }
}

/** 库目录：--root > QQ_STICKER_ROOT > config.json 的 stickers.root > 默认 state\stickers */
function resolveRoot(parsed) {
  const configRoot = path.dirname(configFile(parsed));
  const explicit = parsed.option('root') ?? process.env.QQ_STICKER_ROOT;
  if (explicit) return path.resolve(configRoot, explicit);
  const config = readConfig(parsed);
  return stickerRootDir({ configRoot, config: config ?? {} });
}

function resolveSettings(parsed) {
  const config = readConfig(parsed);
  return normalizeStickerSettings(config?.stickers ?? {});
}

/** 迁移成功后把 config.json 的 stickers.root 指到新目录（桥接 15 秒内热生效） */
function pointConfigAt(target, parsed) {
  const config = readConfig(parsed);
  if (!config) return { updated: false, reason: '没有 config.json，先启动一次桥接生成默认配置' };
  config.stickers = { ...(config.stickers ?? {}), root: target };
  const file = configFile(parsed);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { updated: true, path: file };
}

/* ------------------------------------------------------------------ 命令 */

async function cmdList(parsed) {
  const root = resolveRoot(parsed);
  const settings = resolveSettings(parsed);
  const index = await ensureIndex(root, { settings });
  const limit = Number(parsed.option('limit') ?? 20);
  const { total, items } = listStickers(index, {
    tag: parsed.option('tag') ?? '',
    query: parsed.option('query') ?? '',
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
  });
  if (parsed.flags.has('json')) {
    printJson({ root, total, items });
    return 0;
  }
  if (total === 0) {
    out(`库里还没有表情包（${root}）。收到 QQ 表情或用 \`add\` 导入后会显示在这里。`);
    return 0;
  }
  out(`库里共 ${total} 张，显示 ${items.length} 张（${root}）：`);
  for (const item of items) {
    const size = `${formatBytes(item.bytes)} ${item.width}×${item.height}`;
    const tags = (item.tags ?? []).join(' ');
    out(`  ${item.id}  ${size.padEnd(18, ' ')}  ${formatTime(item.lastAt)}  ${tags}`);
  }
  return 0;
}

async function cmdTags(parsed) {
  const root = resolveRoot(parsed);
  const index = await ensureIndex(root, { settings: resolveSettings(parsed) });
  const tags = tagCounts(index);
  if (parsed.flags.has('json')) {
    printJson({ root, tags });
    return 0;
  }
  if (tags.length === 0) {
    out('还没有标签。');
    return 0;
  }
  out(`共 ${tags.length} 个标签：`);
  for (const { tag, count } of tags) out(`  ${String(count).padStart(4, ' ')}  ${tag}`);
  return 0;
}

async function cmdPick(parsed) {
  const root = resolveRoot(parsed);
  const settings = resolveSettings(parsed);
  const index = await ensureIndex(root, { settings });
  const item = pickSticker(index, {
    tag: parsed.option('tag') ?? '',
    query: parsed.option('query') ?? '',
  });
  if (!item) {
    if (parsed.flags.has('json')) printJson({ ok: false, root, reason: '没有匹配的表情包' });
    else out(`没有匹配的表情包（${root}）。先攒几张，或者换个 --tag / --query。`);
    return 2;
  }
  const abs = resolveStickerFile(root, item.file);
  if (parsed.flags.has('json')) {
    printJson({ ok: true, root, id: item.id, path: abs, tags: item.tags, width: item.width, height: item.height });
    return 0;
  }
  // 人读模式：第一行就是路径，方便 `FOR /F` 或飞书那种「复制一行」
  out(abs);
  out(`（${item.width}×${item.height}，${formatBytes(item.bytes)}，标签：${(item.tags ?? []).join(' ') || '无'}）`);
  return 0;
}

async function readImageInput(input, settings) {
  if (/^https?:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new CliError('图片地址无效');
    }
    if (url.username || url.password) throw new CliError('图片地址不能包含用户名或密码');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new CliError(`图片下载失败：HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > settings.maxBytes) throw new CliError('图片超过单张大小上限');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of res.body ?? []) {
        bytes += chunk.length;
        if (bytes > settings.maxBytes) throw new CliError('图片超过单张大小上限');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, bytes);
    } catch (err) {
      if (controller.signal.aborted) throw new CliError('图片下载超时（10 秒）');
      if (err instanceof CliError) throw err;
      throw new CliError('图片下载失败，请检查原图地址和网络');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new CliError('只支持本地图片文件或 http(s) 图片地址');
  const abs = path.resolve(process.cwd(), input);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new CliError(`图片文件不存在：${abs}`);
  if (stat.size > settings.maxBytes) throw new CliError('图片超过单张大小上限');
  return fs.promises.readFile(abs);
}

async function cmdAdd(parsed) {
  const input = parsed.positional[0];
  if (!input) throw new CliError('add 后面要跟图片文件路径或 http(s) 原图地址');
  const settings = resolveSettings(parsed);
  const buffer = await readImageInput(input, settings);
  const root = resolveRoot(parsed);
  const result = await upsertSticker({
    root,
    buffer,
    settings,
    tags: splitTags(parsed.optionList('tag')),
    source: { kind: 'manual' },
    text: '',
    summary: '',
  });
  if (!result.item) {
    if (parsed.flags.has('json')) printJson({ ok: false, reason: result.reason });
    else out(`没存进去：${result.reason}`);
    return 2;
  }
  const savedPath = resolveStickerFile(root, result.item.file);
  if (!fs.existsSync(savedPath)) throw new CliError('索引记录已存在，但图片文件缺失，请重建索引后重新添加');
  if (parsed.flags.has('json')) {
    printJson({ ok: true, duplicate: result.duplicate, root, path: savedPath, item: result.item });
    return 0;
  }
  out(
    result.duplicate
      ? `这张库里已经有（${result.item.id}），只把见到的次数 +1。`
      : `已入库：${result.item.id}（${result.item.width}×${result.item.height}，${formatBytes(result.item.bytes)}）`,
  );
  out(`文件：${savedPath}`);
  out(`标签：${(result.item.tags ?? []).join(' ') || '无'}`);
  return 0;
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function cmdImportManifest(parsed) {
  const input = parsed.positional[0];
  if (!input) throw new CliError('import-manifest 后面要跟 manifest.json 路径');
  const manifestPath = path.resolve(process.cwd(), input);
  const stat = await fs.promises.stat(manifestPath).catch(() => null);
  if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) throw new CliError('manifest 文件不存在或超过 8MB');
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8').then((text) => text.replace(/^\uFEFF/, '')));
  } catch {
    throw new CliError('manifest 不是有效的 JSON');
  }
  if (!Array.isArray(manifest?.items) || manifest.items.length > 10_000) throw new CliError('manifest 需要 items 数组（最多 10000 张）');
  const sourceRoot = await fs.promises.realpath(path.dirname(manifestPath));
  const legacy = path.basename(sourceRoot).toLowerCase() === 'stickers' &&
    path.basename(path.dirname(sourceRoot)).toLowerCase() === 'assets';
  const entries = [];
  // 先验证清单中每个路径，再开始写库；只读清单列出的库内文件。
  for (const item of manifest.items) {
    if (!item || typeof item.file !== 'string') throw new CliError('manifest 的每一项都需要 file 路径');
    let rel = item.file.replace(/\\/g, '/');
    if (/[:\0]/.test(rel) || rel.startsWith('/') || rel.split('/').some((part) => part === '..' || part === '.')) {
      throw new CliError('manifest 只能引用所在表情包目录内的相对路径');
    }
    if (legacy && rel.toLowerCase().startsWith('assets/stickers/')) rel = rel.slice('assets/stickers/'.length);
    const requested = path.resolve(sourceRoot, rel);
    if (!isInside(sourceRoot, requested)) throw new CliError('manifest 图片路径超出了源表情包目录');
    const file = await fs.promises.realpath(requested).catch(() => null);
    if (!file) throw new CliError(`manifest 图片不存在：${rel}`);
    if (!isInside(sourceRoot, file)) throw new CliError('manifest 图片链接指向了源表情包目录外');
    const info = await fs.promises.stat(file);
    if (!info.isFile()) throw new CliError(`manifest 图片不是文件：${rel}`);
    entries.push({ file, item });
  }
  const root = resolveRoot(parsed);
  if (parsed.flags.has('dry-run')) {
    if (parsed.flags.has('json')) printJson({ ok: true, dryRun: true, root, sourceRoot, count: entries.length });
    else out(`清单验证通过：${entries.length} 张 → ${root}（尚未导入）`);
    return 0;
  }
  const settings = resolveSettings(parsed);
  const result = { ok: true, root, added: 0, duplicate: 0, skipped: 0, items: [], reasons: [] };
  for (const { file, item } of entries) {
    try {
      const buffer = await readImageInput(file, settings);
      const saved = await upsertSticker({
        root,
        buffer,
        settings,
        source: { kind: 'manual' },
        tags: [...splitTags(parsed.optionList('tag')), ...[item.scene, item.emotion].filter((tag) => typeof tag === 'string')],
        text: typeof item.text === 'string' ? item.text : '',
      });
      if (!saved.item) throw new CliError(saved.reason ?? '图片未入库');
      const savedPath = resolveStickerFile(root, saved.item.file);
      if (!fs.existsSync(savedPath)) throw new CliError('索引记录已存在，但图片文件缺失，请重建索引后重新导入');
      if (saved.added) result.added += 1;
      else if (saved.duplicate) result.duplicate += 1;
      result.items.push({ id: saved.item.id, path: savedPath });
    } catch (err) {
      result.skipped += 1;
      result.reasons.push({ file, reason: err?.message ?? String(err) });
    }
  }
  result.ok = result.skipped === 0;
  if (parsed.flags.has('json')) printJson(result);
  else out(`清单导入完成：新增 ${result.added} 张，已有 ${result.duplicate} 张，跳过 ${result.skipped} 张 → ${root}`);
  return result.ok ? 0 : 2;
}

async function cmdTag(parsed) {
  const id = parsed.positional[0];
  if (!id) throw new CliError('tag 后面要跟一个表情 id（list 里第一列）');
  const add = splitTags(parsed.optionList('add'));
  const remove = splitTags(parsed.optionList('remove'));
  if (add.length === 0 && remove.length === 0) throw new CliError('至少给一个 --add a,b 或 --remove c');
  const root = resolveRoot(parsed);
  try {
    const item = await updateTags(root, id, { add, remove });
    if (parsed.flags.has('json')) printJson({ ok: true, item });
    else out(`改好了：${item.id} → ${(item.tags ?? []).join(' ') || '（没有标签）'}`);
    return 0;
  } catch (err) {
    if (err?.code === 'STICKER_NOT_FOUND') throw new CliError(err.message);
    throw err;
  }
}

async function cmdDelete(parsed) {
  const id = parsed.positional[0];
  if (!id) throw new CliError('delete 后面要跟一个表情 id');
  const root = resolveRoot(parsed);
  try {
    const result = await deleteSticker(root, id);
    if (parsed.flags.has('json')) printJson({ ok: true, ...result });
    else out(`删掉了 ${result.item.id}${result.removedFile ? '' : '（图片文件被占用，索引已清，文件下次重建时会扫回来）'}`);
    return 0;
  } catch (err) {
    if (err?.code === 'STICKER_NOT_FOUND') throw new CliError(err.message);
    throw err;
  }
}

async function cmdRebuild(parsed) {
  const root = resolveRoot(parsed);
  const settings = resolveSettings(parsed);
  const result = await rebuildIndex(root, { settings });
  if (parsed.flags.has('json')) {
    printJson({
      ok: true,
      root,
      scanned: result.scanned,
      kept: result.kept,
      added: result.added,
      dropped: result.dropped,
      stats: { ...result.stats, tags: result.stats.tags.length },
    });
    return 0;
  }
  out(`扫了 ${result.scanned} 个图片文件：原有 ${result.kept} 张、新收 ${result.added} 张、掉了 ${result.dropped} 张。`);
  out(`现在是 ${result.stats.count} 张（动图 ${result.stats.animated}），占 ${formatBytes(result.stats.bytes)}。`);
  return 0;
}

async function cmdStats(parsed) {
  const root = resolveRoot(parsed);
  const index = await ensureIndex(root, { settings: resolveSettings(parsed) });
  const stats = storeStats(index);
  if (parsed.flags.has('json')) printJson({ root, ...stats });
  else {
    out(`库：${root}`);
    out(`  ${stats.count} 张（动图 ${stats.animated} / 静态 ${stats.staticCount}），占 ${formatBytes(stats.bytes)}`);
    out(`  最后更新：${formatTime(stats.lastAt)}`);
    out(`  标签 ${stats.tags.length} 个：${stats.tags.slice(0, 12).map((t) => t.tag).join('、') || '无'}`);
  }
  return 0;
}

async function cmdMigrate(parsed) {
  const target = parsed.positional[0];
  if (!target) throw new CliError('migrate 后面要跟目标目录');
  const fromRoot = resolveRoot(parsed);
  const toRoot = path.resolve(path.dirname(configFile(parsed)), target);
  const result = await migrateStore({ fromRoot, toRoot });
  const config = parsed.flags.has('no-config') ? { updated: false, reason: '按 --no-config 没改配置' } : pointConfigAt(toRoot, parsed);
  let deleted = false;
  if (parsed.flags.has('delete-source')) {
    fs.rmSync(fromRoot, { recursive: true, force: true });
    deleted = true;
  }
  if (parsed.flags.has('json')) {
    printJson({ ok: true, ...result, config, deleted });
    return 0;
  }
  out(`搬完了：${result.copied} 张（${formatBytes(result.bytes)}）→ ${toRoot}`);
  out(config.updated ? `config.json 里的 stickers.root 已指到新目录，桥接 15 秒内自动跟上。` : `没改配置：${config.reason}`);
  out(deleted ? '旧目录已删除。' : `旧目录还在（${fromRoot}），确认没问题后自己删。`);
  return 0;
}

async function cmdOpen(parsed) {
  const root = resolveRoot(parsed);
  fs.mkdirSync(root, { recursive: true });
  await openLocalPath(root);
  out(root);
  return 0;
}

const USAGE = `表情包库命令行 —— 采集 / 打标签 / 挑图 / 迁移

  node tools\\stickers.mjs list    [--tag 类型:动图] [--query 猫] [--limit 20] [--json]
  node tools\\stickers.mjs tags    [--json]
  node tools\\stickers.mjs pick    [--tag 类型:动图] [--query 猫] [--json]
  node tools\\stickers.mjs add     <图片文件或http(s)地址> [--tag a,b] [--json]
  node tools\\stickers.mjs import-manifest <manifest.json> [--dry-run] [--tag a,b] [--json]
  node tools\\stickers.mjs tag     <id> [--add a,b] [--remove c] [--json]
  node tools\\stickers.mjs delete  <id> [--json]
  node tools\\stickers.mjs rebuild [--json]
  node tools\\stickers.mjs stats   [--json]
  node tools\\stickers.mjs migrate <目标目录> [--no-config] [--delete-source] [--json]
  node tools\\stickers.mjs open

通用参数：
  --config <文件或目录>  使用指定 config.json（也支持 QQ_CONFIG）
  --root <目录>   临时换一个库（相对配置目录解析，默认读 stickers.root）
  --json          机器可读输出（给脚本用）
  --help          看这份说明

例子：
  # 挑一张动图，拿路径后用 qq.mjs 发到群里
  node tools\\stickers.mjs pick --tag 类型:动图 --json

  # 给某张补标签
  node tools\\stickers.mjs tag 3f9a1c2b7d4e5f60 --add 猫,搞笑

  # 搜到原图后入库；输出会给出实际保存路径
  node tools\\stickers.mjs add https://example.com/meme.gif --tag 猫 --json

  # 只导入旧库 manifest 列出的图片，不扫描整个工作区
  node tools\\stickers.mjs import-manifest D:\\旧库\\assets\\stickers\\manifest.json --json

  # 把库整个搬到 D:\\表情包（会改 config.json，桥接自动跟上）
  node tools\\stickers.mjs migrate D:\\表情包`;

/* ------------------------------------------------------------------ 入口 */

async function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE);
    return 0;
  }
  const rest = argv.slice(1);
  const valueKeys = ['tag', 'query', 'limit', 'add', 'remove', 'root', 'config'];
  const boolKeys = ['json', 'help', 'no-config', 'delete-source', ...(command === 'import-manifest' ? ['dry-run'] : [])];

  switch (command) {
    case 'list':
      return cmdList(parseArgs(rest, { valueKeys, boolKeys }));
    case 'tags':
      return cmdTags(parseArgs(rest, { valueKeys, boolKeys }));
    case 'pick':
      return cmdPick(parseArgs(rest, { valueKeys, boolKeys }));
    case 'add':
      return cmdAdd(parseArgs(rest, { valueKeys, boolKeys }));
    case 'import-manifest':
      return cmdImportManifest(parseArgs(rest, { valueKeys, boolKeys }));
    case 'tag':
      return cmdTag(parseArgs(rest, { valueKeys, boolKeys }));
    case 'delete':
      return cmdDelete(parseArgs(rest, { valueKeys, boolKeys }));
    case 'rebuild':
      return cmdRebuild(parseArgs(rest, { valueKeys, boolKeys }));
    case 'stats':
      return cmdStats(parseArgs(rest, { valueKeys, boolKeys }));
    case 'migrate':
      return cmdMigrate(parseArgs(rest, { valueKeys, boolKeys }));
    case 'open':
      return cmdOpen(parseArgs(rest, { valueKeys, boolKeys }));
    default:
      throw new CliError(`不认识的命令：${command}（跑 --help 看用法）`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`出错了：${err?.stack ?? err}\n`);
    process.exitCode = 2;
  });
