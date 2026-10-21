/**
 * 表情包搜索入库链路：只使用临时配置/图片和本机 HTTP 测试服务。
 * 不启动真实桥接，不读取或修改用户的表情包库。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStickerPrompt } from '../src/sticker-prompt.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(projectRoot, 'tools', 'stickers.mjs');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-tools-'));
const cfgDir = path.join(tmp, 'external config');
const cfgFile = path.join(cfgDir, 'config.json');
const store = path.join(cfgDir, 'state', 'stickers');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIABAAAAAP///yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
let passed = 0;
let server;
const sockets = new Set();

function check(value, label) {
  assert.ok(value, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, ...args], {
      cwd: options.cwd ?? tmp,
      env: { ...process.env, QQ_CONFIG: cfgFile, QQ_STICKER_ROOT: '', ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out); } catch { /* 非 JSON 错误提示保留供断言。 */ }
      resolve({ code, out, err, json });
    });
  });
}

async function writeManifest(file, items) {
  await writeFile(file, JSON.stringify({ items }), 'utf8');
}

try {
  await mkdir(cfgDir, { recursive: true });
  await writeFile(cfgFile, JSON.stringify({ stickers: { root: 'state/stickers', minBytes: 0, maxBytes: 1024 } }), 'utf8');
  await writeFile(path.join(tmp, 'source.png'), png);

  console.log('[1] 空库提示与动态路径');
  const prompt = buildStickerPrompt({ projectRoot, configPath: cfgFile, root: store });
  check(prompt.includes('当前为空'), '空库也给出入库提示');
  check(prompt.includes(tool) && prompt.includes(store), '提示包含实际工具和库的绝对路径');
  check(prompt.includes('--config') && prompt.includes(cfgFile) && prompt.includes('--root'), '外置配置与库目录随命令传递');
  check(prompt.includes(' add ') && prompt.includes('ok:true') && prompt.includes('path'), '提示要求 add 后确认返回保存路径');
  check(!prompt.includes('D:\\example\\qq-bridge'), '没有硬编码的安装路径');
  const otherStore = path.join(tmp, 'moved stickers');
  const movedPrompt = buildStickerPrompt({
    projectRoot, configPath: cfgFile, root: otherStore,
    stats: { count: 2, animated: 1, tags: [{ tag: '开心' }, { tag: '月份:2026-10' }] },
  });
  check(movedPrompt.includes(otherStore) && !movedPrompt.includes(`当前目录：${store}`), '目录变更后使用新库');
  check(movedPrompt.includes('共 2 张') && movedPrompt.includes('常用标签：开心'), '非空库保留数量与标签提示');
  const quoted = buildStickerPrompt({ projectRoot: path.join(tmp, "a'b"), configPath: cfgFile, root: store, platform: 'win32' });
  check(quoted.includes("a''b"), 'PowerShell 路径中的单引号得到转义');
  for (const probability of [0, 0.35, 1]) {
    const controlled = buildStickerPrompt({ projectRoot, configPath: cfgFile, root: store, sendProbability: probability });
    check(controlled.includes(`发送概率为 ${probability}`) && controlled.includes('skipped:true') && controlled.includes('不要重试'),
      `发送概率 ${probability} 传给 Agent 且跳过时不得重新抽签`);
  }

  console.log('[2] 外置配置相对库与命令优先级');
  const stats = await runCli(['stats', '--json']);
  check(stats.code === 0 && stats.json.root === store, 'QQ_CONFIG 文件中的相对库按配置目录解析');
  check(existsSync(path.join(store, 'index.json')), '索引创建在外置库');
  const dirConfig = await runCli(['stats', '--json'], { env: { QQ_CONFIG: cfgDir } });
  check(dirConfig.code === 0 && dirConfig.json.root === store, 'QQ_CONFIG 也接受配置目录');
  const customConfigFile = path.join(cfgDir, 'qq-prod.json');
  await writeFile(customConfigFile, await readFile(cfgFile));
  const namedEnvConfig = await runCli(['stats', '--json'], { env: { QQ_CONFIG: customConfigFile } });
  check(namedEnvConfig.code === 0 && namedEnvConfig.json.root === store, 'QQ_CONFIG 兼容任意 JSON 配置文件名');
  const namedFlagConfig = await runCli(['stats', '--config', customConfigFile, '--json']);
  check(namedFlagConfig.code === 0 && namedFlagConfig.json.root === store, '--config 兼容任意 JSON 配置文件名');
  const relativeEnvConfig = await runCli(['stats', '--json'], { env: { QQ_CONFIG: path.relative(tmp, customConfigFile) } });
  check(relativeEnvConfig.code === 0 && relativeEnvConfig.json.root === store, '相对 QQ_CONFIG 保持按当前工作目录解析');
  const explicitConfig = await runCli(['stats', '--config', cfgFile, '--json'], { env: { QQ_CONFIG: path.join(tmp, 'missing config') } });
  check(explicitConfig.code === 0 && explicitConfig.json.root === store, '--config 优先于环境配置');
  const explicitRoot = await runCli(['stats', '--root', 'other library', '--json']);
  check(explicitRoot.code === 0 && explicitRoot.json.root === path.join(cfgDir, 'other library'), '相对 --root 同样按配置目录解析');
  const badConfig = await runCli(['stats', '--json'], { env: { QQ_CONFIG: path.join(tmp, 'missing config') } });
  check(badConfig.code === 1 && badConfig.err.includes('无法读取配置'), '外置配置缺失时明确失败');

  console.log('[3] 本地添加和路径确认');
  const added = await runCli(['add', 'source.png', '--tag', '本地图', '--json']);
  check(added.code === 0 && added.json.ok, '相对图片路径按命令当前工作目录读取');
  check(added.json.root === store && existsSync(added.json.path), 'add 返回真实库目录和已保存路径');
  check((await readFile(added.json.path)).equals(png), '入库图片内容保持完整');
  const duplicate = await runCli(['add', path.join(tmp, 'source.png'), '--tag', '新标签', '--json']);
  check(duplicate.json.duplicate && duplicate.json.item.seen === 2, '重复添加不重复存图');
  check(duplicate.json.item.tags.includes('新标签'), '重复导入仍可补标签');
  const unsupportedDryRun = await runCli(['add', 'source.png', '--dry-run', '--json']);
  check(unsupportedDryRun.code === 1, 'add 不会静默忽略只属于清单导入的 dry-run');

  console.log('[4] HTTP 原图下载、上限和超时');
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/image':
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(gif);
        break;
      case '/redirect':
        res.writeHead(302, { location: '/image' });
        res.end();
        break;
      case '/large':
        res.writeHead(200, { 'content-length': '2048' });
        res.end(Buffer.alloc(2048));
        break;
      case '/stream':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(Buffer.alloc(700));
        res.end(Buffer.alloc(700));
        break;
      case '/slow': {
        const timer = setTimeout(() => res.end(gif), 14_000);
        res.on('close', () => clearTimeout(timer));
        break;
      }
      default:
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>this is a search result, not an image</html>');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const remote = await runCli(['add', `${base}/image`, '--tag', '搜索结果', '--json']);
  check(remote.code === 0 && remote.json.ok && existsSync(remote.json.path), '原图 URL 直接下载并保存到当前库');
  check(remote.json.item.tags.includes('搜索结果'), '搜索标签随原图入库');
  const redirected = await runCli(['add', `${base}/redirect`, '--json']);
  check(redirected.code === 0 && redirected.json.duplicate, '图片地址的 HTTP 跳转可完成导入');
  const html = await runCli(['add', `${base}/html`, '--json']);
  check(html.code === 2 && html.json?.ok === false && html.json.reason === '不是图片', '搜索结果网页不能冒充图片');
  const large = await runCli(['add', `${base}/large`, '--json']);
  check(large.code === 1 && large.err.includes('大小上限'), 'Content-Length 超限立即拒绝');
  const stream = await runCli(['add', `${base}/stream`, '--json']);
  check(stream.code === 1 && stream.err.includes('大小上限'), '分块传输累计超限同样拒绝');
  const slow = await runCli(['add', `${base}/slow`, '--json']);
  check(slow.code === 1 && slow.err.includes('超时'), '下载在十秒内超时退出');
  const protocol = await runCli(['add', 'ftp://example.invalid/image.gif', '--json']);
  check(protocol.code === 1 && protocol.err.includes('http(s)'), '拒绝非 HTTP 协议地址');
  const credentials = await runCli(['add', 'https://user:private@example.invalid/image.gif', '--json']);
  check(credentials.code === 1 && !credentials.err.includes('private'), '拒绝带密码的 URL 且不回显密码');
  const afterRemote = await runCli(['stats', '--json']);
  check(afterRemote.json.count === 2, '失败下载没有污染库或索引');
  await rm(added.json.path);
  const missingStoredImage = await runCli(['add', path.join(tmp, 'source.png'), '--json']);
  check(missingStoredImage.code === 0 && missingStoredImage.json?.ok &&
    (await readFile(missingStoredImage.json.path)).equals(png), '重新添加会恢复旧索引中缺失的图片');

  console.log('[5] 显式旧库清单导入');
  const legacyRoot = path.join(tmp, 'legacy', 'assets', 'stickers');
  const sceneRoot = path.join(legacyRoot, '开心');
  const manifestFile = path.join(legacyRoot, 'manifest.json');
  const importedRoot = path.join(tmp, 'imported stickers');
  await mkdir(sceneRoot, { recursive: true });
  await writeFile(path.join(sceneRoot, 'one.png'), png);
  await writeFile(path.join(sceneRoot, 'two.gif'), gif);
  await writeFile(path.join(legacyRoot, 'overview.png'), png);
  await writeManifest(manifestFile, [
    { file: 'assets/stickers/开心/one.png', scene: '开心', emotion: '高兴', text: '终于下班啦' },
    { file: '开心/two.gif', scene: '开心', emotion: '期待', text: '准备开饭' },
  ]);
  const dry = await runCli(['import-manifest', manifestFile, '--root', importedRoot, '--dry-run', '--json']);
  check(dry.code === 0 && dry.json.count === 2 && dry.json.dryRun, 'dry-run 验证旧库前缀与普通相对路径');
  check(!existsSync(importedRoot), 'dry-run 不创建或修改目标库');
  const imported = await runCli(['import-manifest', manifestFile, '--root', importedRoot, '--json']);
  check(imported.code === 0 && imported.json.added === 2 && imported.json.duplicate === 0, '只导入清单中的两张图，忽略 overview');
  check(imported.json.items.every((item) => existsSync(item.path)), '每张导入图片都返回实际路径');
  const importedIndex = JSON.parse(await readFile(path.join(importedRoot, 'index.json'), 'utf8'));
  check(importedIndex.items.some((item) => item.tags.includes('开心') && item.tags.includes('高兴') && item.text === '终于下班啦'), '保留旧库场景、情绪及台词');
  const reimported = await runCli(['import-manifest', manifestFile, '--root', importedRoot, '--json']);
  check(reimported.code === 0 && reimported.json.added === 0 && reimported.json.duplicate === 2, '重复导入只计为已有，不复制图片');
  await rm(imported.json.items[0].path);
  const missingImportedImage = await runCli(['import-manifest', manifestFile, '--root', importedRoot, '--json']);
  check(missingImportedImage.code === 0 && missingImportedImage.json.ok && missingImportedImage.json.skipped === 0, '重新导入清单会恢复目标库里缺失的图片');
  check(missingImportedImage.json.items.every((item) => existsSync(item.path)), '清单成功项目不会返回缺失文件路径');

  console.log('[6] 清单路径边界与坏文件');
  const rejectedRoot = path.join(tmp, 'must not be written');
  for (const unsafe of ['../source.png', '/source.png', 'C:/source.png', '开心/../one.png']) {
    await writeManifest(manifestFile, [{ file: unsafe }]);
    const denied = await runCli(['import-manifest', manifestFile, '--root', rejectedRoot, '--json']);
    check(denied.code === 1, `拒绝清单越界路径 ${unsafe}`);
  }
  check(!existsSync(rejectedRoot), '路径验证失败之前不写目标库');
  const external = path.join(tmp, 'external images');
  await mkdir(external);
  await writeFile(path.join(external, 'outside.png'), png);
  await symlink(external, path.join(legacyRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeManifest(manifestFile, [{ file: 'escape/outside.png' }]);
  const linkEscape = await runCli(['import-manifest', manifestFile, '--root', rejectedRoot, '--json']);
  check(linkEscape.code === 1 && linkEscape.err.includes('目录外'), '拒绝清单内链接指向源库以外的图片');
  await writeManifest(manifestFile, [{ file: '开心/one.png' }, { file: '开心/missing.png' }]);
  const missing = await runCli(['import-manifest', manifestFile, '--root', rejectedRoot, '--json']);
  check(missing.code === 1 && !existsSync(rejectedRoot), '完整清单验证在任何写入之前完成');
  await writeFile(path.join(sceneRoot, 'bad.png'), '<html>not an image</html>');
  await writeManifest(manifestFile, [{ file: '开心/bad.png' }]);
  const bad = await runCli(['import-manifest', manifestFile, '--root', rejectedRoot, '--json']);
  check(bad.code === 2 && bad.json.skipped === 1 && !bad.json.ok, '坏图片明确报告失败，不虚报已保存');

  console.log(`\n通过 ${passed} 项，失败 0 项`);
} finally {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
