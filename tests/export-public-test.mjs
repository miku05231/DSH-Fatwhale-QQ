/**
 * export-public-test.mjs —— 「另存一份可公开的源码」这件事要能重复、能自证。
 *
 * 只检查导出产物，不检查私有工程：导出脚本自己会跑脱敏自检，
 * 这里再加一层外部视角的断言（万一脚本的规则被改坏了）。
 *
 * 产物写到系统临时目录，跑完删掉，不碰 D:\code\qq-bridge-public。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const TOOL = path.join(PROJECT_ROOT, 'tools', 'export-public.mjs');

let passed = 0;
let failed = 0;

function ok(cond, name, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function localReadmeImages(text) {
  const markdown = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  const html = [...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
  return [...new Set([...markdown, ...html])]
    .filter((src) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src))
    .map((src) => decodeURIComponent(src.split(/[?#]/)[0]));
}

/** 递归找出所有文件 */
async function walk(dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

async function verifyOutputSafety(tmpRoot) {
  const fixtureParent = path.join(tmpRoot, 'output-safety');
  const fixtureRoot = path.join(fixtureParent, 'source');
  const fixtureTool = path.join(fixtureRoot, 'tools', 'export-public.mjs');
  const sourceSentinel = path.join(fixtureRoot, 'src', 'sentinel.txt');
  await fsp.mkdir(path.dirname(fixtureTool), { recursive: true });
  await fsp.mkdir(path.dirname(sourceSentinel), { recursive: true });
  await fsp.copyFile(TOOL, fixtureTool);
  await fsp.writeFile(path.join(fixtureRoot, 'package.json'), '{"name":"qq-bridge","version":"0.0.0"}\n');
  await fsp.writeFile(path.join(fixtureRoot, 'README.md'), '<!-- showcase:start -->\nSynthetic fixture\n<!-- showcase:end -->\n');
  await fsp.writeFile(path.join(fixtureRoot, 'config.json'), '{"synthetic":true}\n');
  await fsp.writeFile(path.join(fixtureRoot, 'AGENTS.md'), 'private-maintenance-fixture\n');
  const privateFiles = [
    'docs/model-switch-session-reuse-implementation.md', 'docs/model-switch-session-reuse-repair-plan.md',
    'docs/napcat-login-persistence-diagnosis.md', 'docs/napcat-login-persistence-implementation.md',
    'docs/napcat-login-persistence-investigation-progress.md', 'tools/sticker.mjs',
  ];
  for (const file of privateFiles) {
    await fsp.mkdir(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    await fsp.writeFile(path.join(fixtureRoot, file), 'synthetic-private-maintenance-fixture\n');
  }
  await fsp.writeFile(sourceSentinel, 'preserve-source-fixture\n');
  const runFixture = (target) => spawnSync(process.execPath, [fixtureTool, '--out', target, '--force'], {
    cwd: tmpRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });

  for (const [label, target] of [
    ['source root', fixtureRoot],
    ['source ancestor', fixtureParent],
    ['included directory', path.join(fixtureRoot, 'src')],
    ['source child', path.join(fixtureRoot, 'new-output')],
    ['existing source file', path.join(fixtureRoot, 'package.json')],
  ]) {
    const rejected = runFixture(target);
    ok(rejected.status !== 0, `unsafe output rejected: ${label}`);
    ok(fs.existsSync(sourceSentinel) && fs.existsSync(path.join(fixtureRoot, 'config.json')),
      `source and local data preserved: ${label}`);
  }

  const victim = path.join(fixtureParent, 'victim');
  const link = path.join(fixtureParent, 'linked-output');
  const victimSentinel = path.join(victim, 'sentinel.txt');
  await fsp.mkdir(path.join(victim, 'nested'), { recursive: true });
  await fsp.writeFile(victimSentinel, 'preserve-link-target-fixture\n');
  await fsp.symlink(victim, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [link, path.join(link, 'nested')]) {
    const rejected = runFixture(target);
    ok(rejected.status !== 0 && fs.existsSync(victimSentinel), 'linked output rejected without deleting its target');
  }

  for (const target of [path.join(fixtureRoot, 'dist', 'public'), path.join(fixtureParent, 'source-output')]) {
    await fsp.mkdir(target, { recursive: true });
    const stale = path.join(target, 'stale.txt');
    await fsp.writeFile(stale, 'replaceable-output-fixture\n');
    const accepted = runFixture(target);
    ok(accepted.status === 0 && !fs.existsSync(stale), 'separate output can be rebuilt with --force');
    ok(!fs.existsSync(path.join(target, 'AGENTS.md')), 'maintenance AGENTS.md is not exported');
    for (const file of privateFiles) {
      ok(!fs.existsSync(path.join(target, file)), `private maintenance evidence is not exported: ${file}`);
    }
  }
}

async function main() {
  const out = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-public-')), 'repo');

  console.log('[Output path safety (synthetic source tree)]');
  await verifyOutputSafety(path.dirname(out));

  console.log('[1/5 跑导出脚本]');
  const run = spawnSync(process.execPath, [TOOL, '--out', out, '--force'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  ok(run.status === 0, '导出脚本退出码 0', `status=${run.status}`);
  ok(String(run.stdout).includes('脱敏自检通过'), '脚本自检通过');
  const files = await walk(out);

  console.log('\n[2/5 该有的文件都在]');
  const required = [
    'README.md',
    'LICENSE',
    '.gitignore',
    '.gitattributes',
    'config.example.json',
    'patches/example-headless-model.yml',
    'src/index.js',
    'src/computer-access.js',
    'src/chat-only.js',
    'src/chat-only-host.js',
    'src/sticker-send-policy.js',
    'src/plugins.js',
    'src/plugins/ping.js',
    'src/webui/server.mjs',
    'src/updates.mjs',
    'src/companion/lib/index.js',
    'src/companion/package.json',
    'src/webui/public/index.html',
    'launcher/Launcher.ps1',
    'tests/run-all.mjs',
    'docs/控制台架构.md',
    'docs/Docker部署.md',
    'docs/Docker验证报告.md',
    'docs/隐私审计报告.md',
    'docs/从零验证报告.md',
    'docs/更新发布.md',
    'docs/automation-and-voice.md',
    'docs/verification-v3.0.0.md',
    'docs/releases/v3.0.0.md',
    'docs/verification-v3.1.0.md',
    'docs/releases/v3.1.0.md',
    'docs/verification-v3.1.1.md',
    'docs/releases/v3.1.1.md',
    'docs/verification-v3.1.2.md',
    'docs/releases/v3.1.2.md',
    'scripts/install-update.ps1',
    '.github/workflows/release.yml',
    'deepseek-waitou.png',
    'assets/app-icon.png',
    'docs/screenshots/console-overview-light.png',
    'docs/screenshots/console-overview-dark.png',
    'docs/screenshots/tray-menu-light.png',
    'docs/screenshots/tray-menu-dark.png',
    'docs/screenshots/tray-dialog-light.png',
    'docs/screenshots/tray-dialog-dark.png',
    'docs/screenshots/console-jev-settings.png',
    'docs/screenshots/console-reply-tts.png',
    'docs/screenshots/console-bilibili-automation.png',
    'docs/screenshots/console-bilibili-safeguards.png',
  ];
  for (const rel of required) {
    const full = path.join(out, rel.split('/').join(path.sep));
    ok(fs.existsSync(full), `产物含 ${rel}`);
  }
  ok(!fs.existsSync(path.join(out, 'companion')), '公开源码不带顶级 companion 目录');

  console.log('\n[3/5 项目展示完整保留]');
  const readme = await fsp.readFile(path.join(out, 'README.md'), 'utf8');
  const sourceReadme = await fsp.readFile(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
  const showcasePattern = /<!-- showcase:start -->[\s\S]*?<!-- showcase:end -->/;
  const sourceShowcase = sourceReadme.match(showcasePattern)?.[0];
  const exportedShowcase = readme.match(showcasePattern)?.[0];
  ok(Boolean(sourceShowcase) && exportedShowcase === sourceShowcase, '公开 README 复用源 README 的图标与展示区');
  ok((readme.match(/<!-- showcase:start -->/g) ?? []).length === 1, '展示区只生成一次');
  ok(readme.includes('九个页签') && readme.includes('当前 DSH 默认模型'), '公开说明包含新导航和默认模型判定');
  ok(readme.includes('未实测') && readme.includes('真实 QQ 文字/语音投递') && readme.includes('B站实际评论与 @'), '公开说明明确真实账号未测试范围');
  const imageRefs = localReadmeImages(readme);
  ok(imageRefs.length >= 7, '公开 README 含应用图标与界面截图');
  const missingImages = imageRefs.filter((rel) => !fs.existsSync(path.join(out, rel)));
  ok(missingImages.length === 0, '公开 README 的本地图片引用都能打开', missingImages.join('; '));
  const sourceIcon = fs.readFileSync(path.join(PROJECT_ROOT, 'deepseek-waitou.png'));
  const exportedIcon = fs.readFileSync(path.join(out, 'deepseek-waitou.png'));
  ok(exportedIcon.equals(sourceIcon), '根目录图标源文件按原始字节导出');
  ok(exportedIcon.equals(fs.readFileSync(path.join(out, 'assets', 'app-icon.png'))), '图标源文件与应用 PNG 图标一致');
  const screenshotRoot = path.join(PROJECT_ROOT, 'docs', 'screenshots');
  const screenshots = await walk(screenshotRoot);
  const changedImages = screenshots.filter((file) =>
    !fs.readFileSync(file).equals(fs.readFileSync(path.join(out, 'docs', 'screenshots', path.relative(screenshotRoot, file)))));
  ok(changedImages.length === 0, '展示截图按原始字节导出', changedImages.map((file) => path.relative(screenshotRoot, file)).join('; '));

  console.log('\n[4/5 不该出的东西一个都没有]');
  const forbiddenDirs = ['AGENTS.md', 'config.json', 'state', 'logs', 'napcat', 'node_modules', '.env', 'qq-workspace', 'docs/testing', 'docs/work-progress.md', 'docs/update-program.md'];
  for (const rel of forbiddenDirs) {
    ok(!fs.existsSync(path.join(out, rel)), `没有 ${rel}`);
  }
  const leaks = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.js', '.mjs', '.ps1', '.cmd', '.md', '.json', '.yml', '.html', '.css', '.txt'].includes(ext) && !file.endsWith('LICENSE')) continue;
    const text = await fsp.readFile(file, 'utf8');
    for (const [label, re] of [
      ['个人路径', new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
      ['本机工程路径', new RegExp(path.dirname(PROJECT_ROOT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
      ['疑似密钥', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
      ['URL 内嵌长凭据', /https?:\/\/[^/\s"'`<>:]+:[^/\s"'`<>@]{16,}@/i],
    ]) {
      if (re.test(text)) leaks.push(`${path.relative(out, file)} → ${label}`);
    }
  }
  ok(leaks.length === 0, '产物未命中本机路径、已知密钥格式或 URL 内嵌长凭据', leaks.slice(0, 5).join('; '));
  ok(String(run.stdout).includes('QQ 号及其他隐私需另行审查'), '导出提示保留 QQ 号及其他隐私的人工审查范围');

  const syntheticKey = `sk-${'a1B2c3D4'.repeat(4)}`;
  const syntheticCredential = 'not-a-real-credential-'.repeat(2);
  const syntheticUrl = ['https://fixture', syntheticCredential].join(':') + '@example.invalid/v1';
  const fixture = path.join(out, 'src', 'privacy-negative-fixture.js');
  await fsp.writeFile(fixture, `export const key = ${JSON.stringify(syntheticKey)};\nexport const url = ${JSON.stringify(syntheticUrl)};\n`, 'utf8');
  const rejected = spawnSync(process.execPath, [path.join(out, 'tools', 'export-public.mjs'), '--out', path.join(path.dirname(out), 'rejected')], {
    cwd: out,
    encoding: 'utf8',
    timeout: 120000,
  });
  ok(rejected.status === 1, '含合成密钥的导出被拒绝');
  ok(String(rejected.stdout).includes('privacy-negative-fixture.js') && String(rejected.stdout).includes('疑似密钥'), '拒绝日志包含文件和类别');
  ok(String(rejected.stdout).includes('URL 内嵌长凭据'), '含合成 URL 长凭据的导出被拒绝');
  ok(!`${rejected.stdout}${rejected.stderr}`.includes(syntheticKey) && !`${rejected.stdout}${rejected.stderr}`.includes(syntheticCredential), '拒绝日志不回显匹配到的凭据');
  await fsp.rm(fixture);

  console.log('\n[5/5 产物自身可跑]');
  const check = spawnSync(process.execPath, ['--check', path.join(out, 'src', 'plugins.js')], { encoding: 'utf8', timeout: 30000 });
  ok(check.status === 0, '产物里的 src/plugins.js 语法正确');
  const checkChatHost = spawnSync(process.execPath, ['--check', path.join(out, 'src', 'chat-only-host.js')], { encoding: 'utf8', timeout: 30000 });
  ok(checkChatHost.status === 0, '产物里的 src/chat-only-host.js 语法正确');
  const pkg = path.join(out, 'package.json');
  const publicPackage = JSON.parse(await fsp.readFile(pkg, 'utf8'));
  const projectPackage = JSON.parse(await fsp.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  ok(publicPackage.name === 'qq-bridge' && publicPackage.version === projectPackage.version,
    'package.json 保留应用身份与版本（仍为零第三方依赖）');

  ok(/QQ-DSH/.test(readme) && /MIT/.test(readme), 'README 有项目名与许可说明');
  ok(/NapCat/.test(readme) && /封号风险|服务条款/.test(readme), 'README 写清了 NapCat 与风险提示');

  await fsp.rm(path.dirname(out), { recursive: true, force: true }).catch(() => {});

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
