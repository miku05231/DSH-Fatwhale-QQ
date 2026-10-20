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

async function main() {
  const out = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-public-')), 'repo');

  console.log('[1/4 跑导出脚本]');
  const run = spawnSync(process.execPath, [TOOL, '--out', out, '--force'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  ok(run.status === 0, '导出脚本退出码 0', `status=${run.status}`);
  ok(String(run.stdout).includes('脱敏自检通过'), '脚本自检通过');
  const files = await walk(out);

  console.log('\n[2/4 该有的文件都在]');
  const required = [
    'README.md',
    'LICENSE',
    '.gitignore',
    '.gitattributes',
    'config.example.json',
    'patches/example-headless-model.yml',
    'src/index.js',
    'src/plugins.js',
    'src/plugins/ping.js',
    'src/webui/server.mjs',
    'src/webui/public/index.html',
    'launcher/Launcher.ps1',
    'tests/run-all.mjs',
    'docs/控制台架构.md',
  ];
  for (const rel of required) {
    const full = path.join(out, rel.split('/').join(path.sep));
    ok(fs.existsSync(full), `产物含 ${rel}`);
  }

  console.log('\n[3/4 不该出的东西一个都没有]');
  const forbiddenDirs = ['config.json', 'state', 'logs', 'napcat', 'node_modules', '.env', 'qq-workspace'];
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
      ['私有端点', /xianapi\.cloud|apikey\.fan/i],
      ['疑似密钥', /sk-[A-Za-z0-9]{20,}/],
    ]) {
      if (re.test(text)) leaks.push(`${path.relative(out, file)} → ${label}`);
    }
  }
  ok(leaks.length === 0, '产物里没有 QQ 号/个人路径/私有端点/密钥', leaks.slice(0, 5).join('; '));

  console.log('\n[4/4 产物自身可跑]');
  const check = spawnSync(process.execPath, ['--check', path.join(out, 'src', 'plugins.js')], { encoding: 'utf8', timeout: 30000 });
  ok(check.status === 0, '产物里的 src/plugins.js 语法正确');
  const pkg = path.join(out, 'package.json');
  ok(!fs.existsSync(pkg), '没有 package.json（零依赖，不需要 npm install）');

  const readme = await fsp.readFile(path.join(out, 'README.md'), 'utf8');
  ok(/qq-dsh-bridge/.test(readme) && /MIT/.test(readme), 'README 有项目名与许可说明');
  ok(/NapCat/.test(readme) && /封号风险|服务条款/.test(readme), 'README 写清了 NapCat 与风险提示');

  await fsp.rm(path.dirname(out), { recursive: true, force: true }).catch(() => {});

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
