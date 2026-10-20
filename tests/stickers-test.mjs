/**
 * stickers-test.mjs —— 表情包系统（src/stickers.js + 控制台表情页接口）的测试。
 *
 * 分两部分：
 *   1) 纯模块：图片嗅探、自动标签、去重、锁、重建索引、搬家、采集器；
 *   2) 真实 HTTP：临时目录起一个控制台实例，打 /api/stickers 全套端点。
 *
 * 全在临时目录里跑，结束删干净；不碰真实的 config.json / 表情包库。
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

/* ---------------------------------------------------------------- 造图 */

/** CRC32（PNG 用），只此一处 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 造一张 w×h 的真 PNG（能过 sniffImage 的宽高检查） */
function makePng(w, h, rgb = [255, 90, 90]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 造一个 GIF 头（宽高 + 可选的帧数），够 sniffImage 认出来就行 */
function makeGif(w, h, frames = 1) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  head[10] = 0x00; // 无全局颜色表
  const parts = [head];
  for (let i = 0; i < frames; i += 1) {
    // 0x21 0xF9 0x04 … 图形控制扩展：多帧会被判成动图
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------ 1) 纯模块 */

async function moduleTests(tmpRoot) {
  const mod = await import('../src/stickers.js');
  const {
    STICKER_DEFAULTS,
    normalizeTag,
    sniffImage,
    keywordsOf,
    autoTagsFor,
    upsertSticker,
    loadIndex,
    listStickers,
    pickSticker,
    updateTags,
    deleteSticker,
    rebuildIndex,
    resolveStickerFile,
    migrateStore,
    storeStats,
    collectFromMessage,
    createStickerCollector,
  } = mod;

  const loose = { ...STICKER_DEFAULTS, minBytes: 0, maxBytes: 5 * 1024 * 1024, perMinute: 20 };

  section('1/6 图片嗅探');
  const png = makePng(64, 48);
  const pngInfo = sniffImage(png);
  eq(pngInfo.ext, '.png', 'PNG 认出来了');
  eq([pngInfo.width, pngInfo.height], [64, 48], 'PNG 宽高读对了');
  eq(pngInfo.mime, 'image/png', 'PNG MIME 对了');
  eq(pngInfo.kind, '静态', 'PNG 是静态图');

  const gif = makeGif(32, 32, 1);
  const gifInfo = sniffImage(gif);
  eq(gifInfo.ext, '.gif', 'GIF 认出来了');
  eq([gifInfo.width, gifInfo.height], [32, 32], 'GIF 宽高读对了');
  eq(gifInfo.animated, false, '单帧 GIF 不算动图');
  eq(sniffImage(makeGif(32, 32, 2)).animated, true, '多帧 GIF 判成动图');
  eq(sniffImage(Buffer.from('这不是图片，只是一段文字而已')), null, '非图片返回 null');

  section('2/6 标签');
  eq(normalizeTag('  猫猫  '), '猫猫', '标签去空格');
  truthy(normalizeTag('x'.repeat(60)).length <= 24, '标签长度截到 24');
  const keywords = keywordsOf('这个表情包好可爱，笑死我了 [图片] https://example.com/a.png');
  truthy(keywords.length > 0, '关键词抽出来了', keywords.join(' / '));
  truthy(keywords.every((k) => k.length >= 2 && k.length <= 8), '关键词长度合理');
  const tags = autoTagsFor({
    source: { kind: 'group', groupId: '123456', nickname: '小明' },
    text: '红烧肉真好吃，笑死我了',
    summary: '动画表情',
    image: pngInfo,
    now: Date.parse('2026-10-20T12:00:00+08:00'),
  });
  truthy(tags.includes('来源:群'), '有来源标签');
  truthy(tags.includes('群:123456'), '有群号标签');
  truthy(tags.includes('用户:小明'), '有用户标签');
  truthy(tags.includes('类型:静态'), '有类型标签');
  truthy(tags.includes('月份:2026-10'), '有月份标签');
  truthy(tags.some((t) => t.startsWith('关键词:')), '有关键词标签');

  section('3/6 入库 / 去重 / 改标签 / 删除');
  const store = path.join(tmpRoot, 'store');
  const first = await upsertSticker({ root: store, buffer: png, settings: loose, source: { kind: 'group', groupId: '1', nickname: '甲' }, text: '好可爱' });
  eq(first.added, true, '第一次入库成功');
  truthy(existsSync(path.join(store, first.item.file)), '图片落盘了', first.item.file);
  truthy(first.item.tags.some((t) => t.startsWith('来源:')), '入库时带了自动标签');
  const again = await upsertSticker({ root: store, buffer: png, settings: loose });
  eq(again.duplicate, true, '同一张图第二次是重复');
  eq(again.item.seen, 2, '重复计数 +1');
  eq((await loadIndex(store)).items.length, 1, '库里还是只有一张');

  const small = await upsertSticker({ root: store, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), settings: { ...loose, minBytes: 999 } });
  eq(small.reason, '太小', '小图被拒：太小');
  const junk = await upsertSticker({ root: store, buffer: Buffer.from('hello world, not an image at all'), settings: loose });
  eq(junk.reason, '不是图片', '非图片被拒');

  await updateTags(store, first.item.id, { add: ['猫', '搞笑'] });
  const tagged = await updateTags(store, first.item.id, { remove: ['搞笑'] });
  truthy(tagged.tags.includes('猫'), '手动加的标签在');
  truthy(!tagged.tags.includes('搞笑'), '删掉的标签没了');
  const filtered = listStickers(await loadIndex(store), { tag: '猫' });
  eq(filtered.total, 1, '按标签能筛到');
  const search = listStickers(await loadIndex(store), { query: '可爱' });
  eq(search.total, 1, '按文字能搜到');
  truthy(pickSticker(await loadIndex(store), { tag: '猫' })?.id === first.item.id, 'pick 能挑到这张');

  const second = await upsertSticker({ root: store, buffer: makePng(200, 200, [1, 2, 3]), settings: loose, source: { kind: 'private', nickname: '乙' }, text: '哈哈' });
  eq((await storeStats(await loadIndex(store))).count, 2, '第二张入库，合计 2');

  section('4/6 重建索引 / 搬家 / 越界');
  await rm(path.join(store, 'index.json'), { force: true });
  const rebuilt = await rebuildIndex(store, { settings: loose });
  eq(rebuilt.scanned, 2, '重扫到 2 个文件');
  eq(rebuilt.added, 2, '索引没了之后全部重收');
  eq(rebuilt.stats.count, 2, '重建后合计 2');

  const newStore = path.join(tmpRoot, 'store-moved');
  const moved = await migrateStore({ fromRoot: store, toRoot: newStore });
  eq(moved.copied, 2, '搬家复制了 2 张');
  truthy(existsSync(path.join(newStore, 'index.json')), '索引也搬过去了');
  const movedIndex = await loadIndex(newStore);
  eq(movedIndex.items.length, 2, '新目录索引里有 2 张');
  const oneFile = movedIndex.items[0].file;
  truthy(existsSync(path.join(newStore, oneFile)), '新目录图片在');
  const sizes = await stat(path.join(newStore, oneFile));
  truthy(sizes.size > 0, '新目录图片不是空文件');

  eq(resolveStickerFile(newStore, '2026-10/ok.png') !== null, true, '库内图片路径能解析');
  for (const evil of ['../evil.png', '..\\evil.png', 'C:\\Windows\\win.ini']) {
    try {
      resolveStickerFile(newStore, evil);
      bad(`路径穿越没被拒：${evil}`);
    } catch (err) {
      truthy(/越界|图片/.test(err.message), `路径穿越被拒：${evil}`, err.message);
    }
  }
  try {
    resolveStickerFile(newStore, 'not-an-image.txt');
    bad('非图片扩展名没被拒');
  } catch (err) {
    truthy(/图片/.test(err.message), '非图片扩展名被拒', err.message);
  }

  const removed = await deleteSticker(newStore, movedIndex.items[0].id);
  eq(removed.removedFile, true, '删除时图片文件也删了');
  eq((await loadIndex(newStore)).items.length, 1, '索引里只剩 1 张');

  section('5/6 采集器（注入 fetch，不联网）');
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => png });
  const collected = await collectFromMessage({
    root: path.join(tmpRoot, 'collected'),
    msg: {
      raw: {
        message: [{ type: 'image', data: { url: 'https://example.invalid/a.png', summary: '动画表情' } }],
        sender: { card: '小明小明', nickname: '小明' },
      },
      messageType: 'group',
      groupId: '777',
      userId: '42',
      text: '干嘛呢',
    },
    settings: loose,
    fetchImpl,
  });
  eq(collected.added, 1, '从消息里收到 1 张');
  eq(collected.skipped, 0, '没有跳过');
  truthy(
    (collected.items[0]?.tags ?? []).includes('用户:小明小明'),
    '发言人名从 raw.sender 里取（归一化消息不带 nickname）',
    (collected.items[0]?.tags ?? []).join(' / '),
  );

  const collector = createStickerCollector({ root: path.join(tmpRoot, 'queued'), settings: loose, fetchImpl, now: () => Date.now() });
  const pushed = await collector.push({
    raw: { message: [{ type: 'image', data: { url: 'https://example.invalid/b.png', summary: '' } }] },
    messageType: 'private',
    nickname: '小红',
    text: '哈哈哈',
  });
  truthy(pushed !== null, '采集器 push 返回结果');
  await collector.flush();
  eq(collector.stats.added, 1, '采集器记账 added=1');
  eq((await storeStats(await loadIndex(path.join(tmpRoot, 'queued')))).count, 1, '采集器的图进库了');

  const quiet = await collector.push({ raw: { message: [{ type: 'text', data: { text: '纯文字' } }] }, messageType: 'private' });
  eq(quiet, null, '纯文字消息不采集');

  section('6/6 坏索引自愈');
  const brokenDir = path.join(tmpRoot, 'broken');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'index.json'), '{ 这不是 JSON ', 'utf8');
  const brokenLoad = await loadIndex(brokenDir).then(
    (index) => ({ ok: true, index }),
    (err) => ({ ok: false, err }),
  );
  truthy(brokenLoad.ok, '坏索引不抛异常');
  eq((brokenLoad.index?.items ?? []).length, 0, '坏索引当空库处理');
  const leftovers = (await readdir(brokenDir)).filter((name) => name.includes('.bad-'));
  truthy(leftovers.length > 0, '坏索引被改名留档', leftovers.join(','));
}

/* -------------------------------------------------------------- 2) HTTP */

async function httpTests(tmpRoot) {
  const { createWebUiServer } = await import('../src/webui/server.mjs');
  const { loadConfig } = await import('../src/config.js');
  const { ...stickers } = await import('../src/stickers.js');

  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  const storeDir = path.join(tmpRoot, 'http-store');
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(storeDir, { recursive: true });

  const { config } = loadConfig(PROJECT_ROOT, { createIfMissing: false });
  const tempConfig = {
    ...config,
    stateDir,
    logDir,
    stickers: { ...stickers.STICKER_DEFAULTS, root: storeDir, minBytes: 0 },
  };
  // 控制台的 configRoot 换成临时目录：PUT 设置 / 搬家改写配置都只动这里
  await writeFile(path.join(tmpRoot, 'config.json'), `${JSON.stringify(tempConfig, null, 2)}\n`, 'utf8');

  const instance = createWebUiServer({ config: tempConfig, configRoot: tmpRoot, port: 5901 });
  const { port } = await instance.start();
  if (port <= 0) {
    bad('控制台没起来');
    return;
  }
  ok('控制台已启动（临时目录）', `127.0.0.1:${port}`);

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body };
  };
  const postJson = async (p, body) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    section('HTTP 1/4 空库与文件服务');
    const empty = await get('/api/stickers');
    eq(empty.status, 200, 'GET /api/stickers 通了');
    eq(empty.body?.data?.count, 0, '空库 count=0');
    eq(empty.body?.data?.root, storeDir, '返回的根目录是配置里那个');
    truthy(empty.body?.data?.settings?.autoCollect === true, '设置一起返回');

    const png = makePng(80, 60);
    const seeded = await stickers.upsertSticker({
      root: storeDir,
      buffer: png,
      settings: { ...stickers.STICKER_DEFAULTS, minBytes: 0 },
      source: { kind: 'group', groupId: '555', nickname: '大肥鱼' },
      text: '这图不错',
    });
    truthy(seeded.added, '预置一张进库');

    const listed = await get('/api/stickers');
    eq(listed.body?.data?.count, 1, '列出来 1 张');
    const item = listed.body?.data?.items?.[0] ?? {};
    truthy(String(item.url).startsWith('/api/stickers/file?id='), '带图片地址', item.url);
    truthy(Array.isArray(item.tags) && item.tags.length > 0, '带标签');

    const imgRes = await fetch(base + item.url);
    eq(imgRes.status, 200, '图片接口 200');
    eq(imgRes.headers.get('content-type'), 'image/png', '图片 MIME 正确');
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    eq(bytes.length, png.length, '图片字节数一致');
    const missing = await get('/api/stickers/file?id=nope');
    eq(missing.status, 404, '不存在的 id 返回 404');

    section('HTTP 2/4 改标签');
    const addTags = await postJson('/api/stickers/tag', { id: item.id, add: ['猫', '搞笑'] });
    eq(addTags.status, 200, '加标签 200');
    const added = await addTags.json();
    truthy(added?.data?.item?.tags?.includes('猫'), '加进去了');
    const removeTags = await postJson('/api/stickers/tag', { id: item.id, remove: ['搞笑'] });
    const removedBody = await removeTags.json();
    truthy(!removedBody?.data?.item?.tags?.includes('搞笑'), '删掉了');
    truthy(removedBody?.data?.item?.tags?.includes('猫'), '别的标签没被误删');
    eq((await postJson('/api/stickers/tag', { add: ['x'] })).status, 400, '缺 id 返回 400');
    eq((await postJson('/api/stickers/tag', { id: item.id })).status, 400, '空增删返回 400');
    eq((await postJson('/api/stickers/tag', { id: 'missing', add: ['x'] })).status, 404, '改不存在的 id 返回 404');

    section('HTTP 3/4 重建索引 / 搬家');
    const rebuild = await postJson('/api/stickers/rebuild', {});
    eq(rebuild.status, 200, '重建索引 200');
    const rebuildBody = await rebuild.json();
    eq(rebuildBody?.data?.kept, 1, '重建保留 1 张');

    const movedDir = path.join(tmpRoot, 'http-store-moved');
    const migrate = await postJson('/api/stickers/migrate', { to: movedDir });
    eq(migrate.status, 200, '搬家 200');
    const migrateBody = await migrate.json();
    eq(migrateBody?.data?.copied, 1, '搬过去 1 张');
    truthy(existsSync(path.join(movedDir, 'index.json')), '新目录有索引');
    const diskConfig = JSON.parse(await readFile(path.join(tmpRoot, 'config.json'), 'utf8'));
    eq(diskConfig.stickers.root, movedDir, 'config.json 里的目录改掉了');
    const afterMove = await get('/api/stickers');
    eq(afterMove.body?.data?.root, movedDir, '接口跟着切到新目录');
    eq((await postJson('/api/stickers/migrate', {})).status, 400, '缺 to 返回 400');

    section('HTTP 4/4 删除');
    const idNow = afterMove.body?.data?.items?.[0]?.id;
    const del = await postJson('/api/stickers/delete', { id: idNow });
    eq(del.status, 200, '删除 200');
    eq((await get('/api/stickers')).body?.data?.count, 0, '删完是空库');
    eq((await postJson('/api/stickers/delete', { id: idNow })).status, 404, '再删返回 404');

    const openUnknown = await postJson('/api/open', { target: 'stickers-typo' });
    eq(openUnknown.status, 400, '未知 target 被拒');
  } finally {
    await instance.stop();
  }
}

async function main() {
  console.log('表情包系统测试');
  console.log('='.repeat(60));

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-test-'));
  try {
    await moduleTests(tmpRoot);
    await httpTests(tmpRoot);
  } catch (err) {
    bad('测试过程抛异常', err?.stack ?? String(err));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
