/**
 * tests/package-test.mjs —— 验证「封装应用」产物是真的能跑、且不泄露个人信息。
 *
 * 不只是看文件在不在：
 *   * 把产物里的 tests\blacklist-test.mjs 单独跑一遍 —— 它会起两个真桥接、
 *     证明拷贝出来的 src 在这个新目录里依然可执行（路径可移植的证据）
 *   * 扫一遍产物文本，QQ 号 / 个人路径 / token / 私有端点一律不允许出现
 *   * 检查 .ps1 还是 UTF-8 BOM（PS 5.1 读中文的前提）
 *
 * 用法：node tests\package-test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, prepareIsolatedHome } from './helpers/isolated-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PACKAGER = path.join(ROOT, 'tools', 'package.mjs');

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  failed += 1;
  console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

function check(cond, name, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

const REQUIRED = [
  'src/index.js',
  'src/napcat-health.js',
  'src/napcat-health-onebot.js',
  'scripts/napcat-health.mjs',
  'src/security.js',
  'src/computer-access.js',
  'src/chat-only.js',
  'src/chat-only-host.js',
    'src/sticker-send-policy.js',
  'src/jev-classifier.js',
  'src/reply-delivery.js',
  'src/plugins.js',
  'src/plugins/reply-tts.js',
  'src/model-follow.js',
  'src/platform-model.js',
  'src/platform-scheduler.js',
  'src/platforms/bilibili.js',
  'src/platforms/bilibili-login.js',
  'src/third-party/croner/croner.js',
  'src/third-party/croner/LICENSE',
  'src/third-party/croner/README.md',
  'src/third-party/qrcode-generator/qrcode.mjs',
  'src/third-party/qrcode-generator/LICENSE',
  'src/third-party/qrcode-generator/README.md',
  'src/webui/server.mjs',
  'src/updates.mjs',
  'src/companion/lib/index.js',
  'src/companion/package.json',
  'launcher/Launcher.ps1',
  'launcher/bootstrap.ps1',
  'launcher/lib/ProcessControl.ps1',
  'launcher/lib/UiWindows.ps1',
  'launcher/lib/TrayAppearance.ps1',
  'assets/app-icon.ico',
  'assets/app-icon.png',
  'deepseek-waitou.png',
  'docs/screenshots/console-overview-light.png',
  'docs/screenshots/console-overview-dark.png',
  'docs/screenshots/tray-menu-light.png',
  'docs/screenshots/tray-menu-dark.png',
  'docs/screenshots/tray-dialog-light.png',
  'docs/screenshots/tray-dialog-dark.png',
  'scripts/build-exe.ps1',
  'scripts/install-update.ps1',
  'docs/更新发布.md',
  'tests/tray-appearance.ps1',
  'tests/tray-appearance-test.mjs',
  'tests/exe-host-test.mjs',
  'tools/qq.mjs',
  'tools/memory.mjs',
  'tools/requirements-voice.txt',
  'tools/bili_cookies.py',
  'tests/blacklist-test.mjs',
  'config.example.json',
  '初始化配置.cmd',
  '一键启动.cmd',
  'README.md',
  'docs/控制台架构.md',
  'docs/automation-and-voice.md',
  'docs/verification-v3.0.0.md',
  'docs/releases/v3.0.0.md',
  'docs/verification-v3.1.0.md',
  'docs/releases/v3.1.0.md',
  'docs/verification-v3.1.1.md',
  'docs/releases/v3.1.1.md',
  'docs/verification-v3.1.2.md',
  'docs/releases/v3.1.2.md',
  'docs/verification-v3.1.3.md',
  'docs/releases/v3.1.3.md',
  'docs/screenshots/console-jev-settings.png',
  'docs/screenshots/console-reply-tts.png',
  'docs/screenshots/console-bilibili-automation.png',
  'docs/screenshots/console-bilibili-safeguards.png',
  'package.json',
  '打包信息.json',
];

const MUST_NOT_EXIST = [
  'config.json',
  'state',
  'logs',
  'napcat',
  'node_modules',
  'qq-workspace',
  'companion',
  '.git',
  'dist',
  'tools/export-public.mjs',
  'docs/testing',
  'docs/work-progress.md',
  'docs/update-program.md',
  'docs/model-switch-session-reuse-implementation.md',
  'docs/model-switch-session-reuse-repair-plan.md',
  'docs/napcat-login-persistence-diagnosis.md',
  'docs/napcat-login-persistence-implementation.md',
  'docs/napcat-login-persistence-investigation-progress.md',
  'tools/sticker.mjs',
];

const FORBIDDEN = [
  // 账号/群号已统一换成占位值（config.example.json 里本来就有），这里只盯真正私有的痕迹
  // 本机目录不在源码里写死，按当前机器算出来再查
  [new RegExp(path.dirname(ROOT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '本机路径'],
  [new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '个人用户名'],
  [/xianapi\.cloud/i, '私有 API 端点'],
  [/apikey\.fan/i, '私有 API 端点'],
  [/sk-[A-Za-z0-9]{16,}/, '疑似 API 密钥'],
];

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function localReadmeImages(text) {
  const markdown = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  const html = [...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
  return [...new Set([...markdown, ...html])]
    .filter((src) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src))
    .map((src) => decodeURIComponent(src.split(/[?#]/)[0]));
}

function walk(dir, base = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    ...opts,
  });
}

async function verifyOutputSafety(tmpRoot) {
  const fixtureParent = path.join(tmpRoot, 'output-safety');
  const fixtureRoot = path.join(fixtureParent, 'source');
  const fixtureTool = path.join(fixtureRoot, 'tools', 'package.mjs');
  const sourceSentinel = path.join(fixtureRoot, 'src', 'sentinel.txt');
  await fsp.mkdir(path.dirname(fixtureTool), { recursive: true });
  await fsp.mkdir(path.dirname(sourceSentinel), { recursive: true });
  await fsp.copyFile(PACKAGER, fixtureTool);
  await fsp.writeFile(path.join(fixtureRoot, 'package.json'), '{"name":"qq-bridge","version":"0.0.0"}\n');
  await fsp.writeFile(path.join(fixtureRoot, 'config.json'), '{"synthetic":true}\n');
  await fsp.writeFile(path.join(fixtureRoot, 'AGENTS.md'), 'private-maintenance-fixture\n');
  await fsp.writeFile(sourceSentinel, 'preserve-source-fixture\n');
  const privateReports = [
    'docs/testing/private.md', 'docs/work-progress.md', 'docs/full-verification-fixture.md', 'docs/update-program.md',
    'docs/model-switch-session-reuse-implementation.md', 'docs/model-switch-session-reuse-repair-plan.md',
    'docs/napcat-login-persistence-diagnosis.md', 'docs/napcat-login-persistence-implementation.md',
    'docs/napcat-login-persistence-investigation-progress.md', 'tools/sticker.mjs',
  ];
  for (const file of privateReports) {
    await fsp.mkdir(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    await fsp.writeFile(path.join(fixtureRoot, file), 'synthetic-private-test-evidence\n');
  }

  for (const [label, target] of [
    ['source root', fixtureRoot],
    ['source ancestor', fixtureParent],
    ['included directory', path.join(fixtureRoot, 'src')],
    ['source child', path.join(fixtureRoot, 'new-output')],
    ['existing source file', path.join(fixtureRoot, 'package.json')],
  ]) {
    const rejected = run([fixtureTool, '--out', target, '--force', '--no-zip'], { cwd: tmpRoot });
    check(rejected.status !== 0, `unsafe output rejected: ${label}`);
    check(fs.existsSync(sourceSentinel) && fs.existsSync(path.join(fixtureRoot, 'config.json')),
      `source and local data preserved: ${label}`);
  }

  const victim = path.join(fixtureParent, 'victim');
  const link = path.join(fixtureParent, 'linked-output');
  const victimSentinel = path.join(victim, 'sentinel.txt');
  await fsp.mkdir(path.join(victim, 'nested'), { recursive: true });
  await fsp.writeFile(victimSentinel, 'preserve-link-target-fixture\n');
  await fsp.symlink(victim, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [link, path.join(link, 'nested')]) {
    const rejected = run([fixtureTool, '--out', target, '--force', '--no-zip'], { cwd: tmpRoot });
    check(rejected.status !== 0 && fs.existsSync(victimSentinel), 'linked output rejected without deleting its target');
  }

  for (const target of [path.join(fixtureRoot, 'dist', 'package'), path.join(fixtureParent, 'source-output')]) {
    await fsp.mkdir(target, { recursive: true });
    const stale = path.join(target, 'stale.txt');
    await fsp.writeFile(stale, 'replaceable-output-fixture\n');
    const accepted = run([fixtureTool, '--out', target, '--force', '--no-zip'], { cwd: tmpRoot });
    check(accepted.status === 0 && !fs.existsSync(stale), 'separate output can be rebuilt with --force');
    check(!fs.existsSync(path.join(target, 'AGENTS.md')), 'maintenance AGENTS.md is not packaged');
    for (const file of privateReports) {
      check(!fs.existsSync(path.join(target, file)), `private maintenance evidence is not packaged: ${file}`);
    }
  }
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-package-'));
  const outDir = path.join(tmpRoot, 'app');

  try {
    section('Output path safety (synthetic source tree)');
    await verifyOutputSafety(tmpRoot);

    section('1/7 打包器能跑通');
    const build = run([PACKAGER, '--out', outDir, '--no-zip', '--force']);
    check(build.status === 0, '打包器退出码为 0', String(build.status));
    const buildOut = `${build.stdout ?? ''}${build.stderr ?? ''}`;
    check(buildOut.includes('脱敏自检通过'), '打包器自检通过');
    check(fs.existsSync(path.join(outDir, '打包信息.json')), '生成了 打包信息.json');

    section('2/7 该有的文件都在');
    for (const rel of REQUIRED) {
      check(fs.existsSync(path.join(outDir, rel)), `存在 ${rel}`);
    }
    for (const rel of [
      'src/third-party/croner/croner.js', 'src/third-party/croner/LICENSE', 'src/third-party/croner/README.md',
      'src/third-party/qrcode-generator/qrcode.mjs', 'src/third-party/qrcode-generator/LICENSE', 'src/third-party/qrcode-generator/README.md',
    ]) {
      check(fs.readFileSync(path.join(ROOT, rel)).equals(fs.readFileSync(path.join(outDir, rel))),
        `第三方源文件与许可证保持原始字节 ${rel}`);
    }

    section('3/7 展示图片和原始图标完整');
    const readme = readText(path.join(outDir, 'README.md'));
    const imageRefs = localReadmeImages(readme);
    check(imageRefs.length >= 7, 'README 含应用图标与界面截图');
    const missingImages = imageRefs.filter((rel) => !fs.existsSync(path.join(outDir, rel)));
    check(missingImages.length === 0, 'README 的本地图片引用都能在产物中打开', missingImages.join('；'));
    const sourceIcon = fs.readFileSync(path.join(ROOT, 'deepseek-waitou.png'));
    const packagedIcon = fs.readFileSync(path.join(outDir, 'deepseek-waitou.png'));
    check(packagedIcon.equals(sourceIcon), '根目录图标源文件按原始字节打包');
    check(packagedIcon.equals(fs.readFileSync(path.join(outDir, 'assets', 'app-icon.png'))), '图标源文件与应用 PNG 图标一致');
    const screenshots = walk(path.join(ROOT, 'docs', 'screenshots'));
    const changedImages = screenshots.filter((rel) =>
      !fs.readFileSync(path.join(ROOT, 'docs', 'screenshots', rel))
        .equals(fs.readFileSync(path.join(outDir, 'docs', 'screenshots', rel))));
    check(changedImages.length === 0, '展示截图按原始字节打包', changedImages.join('；'));

    section('4/7 不该进包的东西不在');
    for (const rel of MUST_NOT_EXIST) {
      check(!fs.existsSync(path.join(outDir, rel)), `不存在 ${rel}`);
    }

    section('5/7 产物里没有个人信息');
    const files = walk(outDir);
    const hits = [];
    for (const rel of files) {
      if (!/\.(js|mjs|json|md|yml|yaml|ps1|cmd|txt|html|css)$/i.test(rel)) continue;
      const text = readText(path.join(outDir, rel));
      for (const [re, label] of FORBIDDEN) {
        if (re.test(text)) hits.push(`${rel} → ${label}`);
      }
    }
    check(hits.length === 0, '文本文件里没有 QQ 号 / 个人路径 / 密钥', hits.slice(0, 5).join('；'));

    const manifest = JSON.parse(readText(path.join(outDir, '打包信息.json')));
    const pkg = JSON.parse(readText(path.join(outDir, 'package.json')));
    check(manifest.version === pkg.version, '打包信息里的版本与 package.json 一致', String(manifest.version));
    check(Number.isFinite(Date.parse(manifest.builtAt)), '构建时间是合法时间戳', String(manifest.builtAt));
    check(manifest.files > 50, '产物文件数合理', `${manifest.files} 个`);

    const example = JSON.parse(readText(path.join(outDir, 'config.example.json')));
    const allow = example?.security?.allowFrom ?? [];
    check(Array.isArray(allow) && allow.length > 0 && allow.every((n) => String(n).length === 10), '示例配置里是占位 QQ 号', JSON.stringify(allow));

    section('6/7 拷过去的代码是活的（真跑产物里的测试）');
    const checkJs = run(['--check', path.join(outDir, 'src', 'index.js')]);
    check(checkJs.status === 0, '产物 src/index.js 语法正确');
    const checkSec = run(['--check', path.join(outDir, 'src', 'security.js')]);
    check(checkSec.status === 0, '产物 src/security.js 语法正确');
    const checkChatHost = run(['--check', path.join(outDir, 'src', 'chat-only-host.js')]);
    check(checkChatHost.status === 0, '产物 src/chat-only-host.js 语法正确');
    const importPlatform = run(['--input-type=module', '-e',
      'await Promise.all([import("./src/platform-scheduler.js"),import("./src/platform-model.js"),import("./src/reply-delivery.js"),import("./src/jev-classifier.js"),import("./src/platforms/bilibili-login.js"),import("./src/webui/server.mjs")]);' +
      'const {qrcode}=await import("./src/third-party/qrcode-generator/qrcode.mjs");const image=qrcode(0,"M");image.addData("https://example.com/fixture");image.make();if(!/^data:image\\/gif;base64,/.test(image.createDataURL()))throw new Error("packaged QR rendering failed");'], { cwd: outDir });
    check(importPlatform.status === 0, '产物中的 JEV、语音、平台与扫码模块可加载，二维码可生成',
      importPlatform.status === 0 ? '' : String(importPlatform.stderr ?? '').slice(-1200));

    await prepareIsolatedHome(tmpRoot);
    const blacklist = run([path.join(outDir, 'tests', 'blacklist-test.mjs')], { cwd: outDir, env: isolatedEnv(tmpRoot) });
    const blacklistOut = `${blacklist.stdout ?? ''}${blacklist.stderr ?? ''}`;
    check(blacklist.status === 0, '产物里的 blacklist-test 通过', `exit=${blacklist.status}`);
    check(/通过 \d+ 项，失败 0 项/.test(blacklistOut), '黑白名单用例全过（新目录里也能起真桥接）');

    const ps1Bom = fs.readFileSync(path.join(outDir, 'launcher', 'Launcher.ps1'));
    check(ps1Bom[0] === 0xef && ps1Bom[1] === 0xbb && ps1Bom[2] === 0xbf, '.ps1 仍是 UTF-8 BOM（PS 5.1 才不会乱码）');
    const processControl = readText(path.join(outDir, 'launcher', 'lib', 'ProcessControl.ps1'));
    check(!/C:\\DSH/i.test(processControl), 'ProcessControl 里没有写死本机路径');
    check(processControl.includes('$PSScriptRoot'), 'ProcessControl 靠 $PSScriptRoot 定位项目根目录');

    section('7/7 默认会打 zip');
    const zipDir = path.join(tmpRoot, 'app-zip');
    const zipped = run([PACKAGER, '--out', zipDir, '--force']);
    check(zipped.status === 0, '带 zip 打包退出码为 0', String(zipped.status));
    const zipPath = `${zipDir}.zip`;
    check(fs.existsSync(zipPath), '生成了 zip', zipPath);
    if (fs.existsSync(zipPath)) {
      const size = fs.statSync(zipPath).size;
      check(size > 100 * 1024, 'zip 体积合理', `${(size / 1024).toFixed(0)} KB`);
    }
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
