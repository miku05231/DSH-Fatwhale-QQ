// 自学习（反思）回归测试。
//
// 守护的是两个真踩过的坑：
//   1) memory.mjs 的 `recent --json` 返回的是 {ok, days, count, items:[{date,path,content,bytes}]}，
//      reflect.mjs 一度只认 data/entries，导致「最近没有对话日志，跳过」；
//   2) dsh 在 Windows 上是 dsh.cmd 批处理，直接 spawn('dsh') 会 ENOENT；
//      而且 dsh 没有 --cwd 选项，工作目录只能靠 spawn 的 cwd 传。
//
// 测试策略：不真的跑一次 80 秒的模型调用，只验证「当天反思已存在时能在 5 秒内跳过」，
// 以及「跳过时不会改动已有笔记」。这样既守住回归，又不会把测试拖成几分钟。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REFLECT = path.join(ROOT, 'tools', 'reflect.mjs');
const MEMORY_CLI = path.join(ROOT, 'tools', 'memory.mjs');

let passed = 0;
let failed = 0;
const ok = (label, extra) => {
  passed += 1;
  console.log(`  ✔ ${label}${extra ? `  — ${extra}` : ''}`);
};
const bad = (label, extra) => {
  failed += 1;
  console.log(`  ✘ ${label}${extra ? `  — ${extra}` : ''}`);
};
const section = (title) => console.log(`\n[${title}]`);

function run(cmd, args, { timeoutMs = 20000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* 忽略 */
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

async function main() {
  console.log(`自学习回归测试\n项目根：${ROOT}\n`);

  section('1/4 memory.mjs recent --json 契约');
  const recent = await run(process.execPath, [MEMORY_CLI, 'recent', '--days', '7', '--json'], { timeoutMs: 30000 });
  if (recent.code === 0) ok('recent --json 退出码 0');
  else bad('recent --json 退出码非 0', (recent.err || recent.out).slice(0, 200));

  let parsed = null;
  try {
    parsed = JSON.parse(recent.out);
  } catch {
    bad('recent --json 输出不是合法 JSON', recent.out.slice(0, 160));
  }
  if (parsed) {
    if (Array.isArray(parsed.items)) ok('字段是 items（不是 data/entries）', `${parsed.items.length} 条`);
    else bad('缺少 items 数组，reflect.mjs 会误判为「没有日志」', Object.keys(parsed).join(','));

    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      const first = parsed.items[0];
      if (typeof first.content === 'string') ok('条目正文在 content 字段');
      else bad('条目缺少 content 字段', Object.keys(first).join(','));
      if (typeof first.path === 'string' && first.path.endsWith('.md')) ok('条目带 .md 相对路径', first.path);
      else bad('条目 path 异常', String(first.path));
    } else {
      ok('记忆库暂时没有日志（跳过正文断言）');
    }
  }

  section('2/4 memory.mjs path 契约');
  const rootOut = await run(process.execPath, [MEMORY_CLI, 'path'], { timeoutMs: 20000 });
  const memoryRoot = (rootOut.out ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (memoryRoot && fs.existsSync(memoryRoot)) ok('path 返回存在的记忆库根目录', memoryRoot);
  else bad('path 没返回有效目录', memoryRoot || '(空)');

  section('3/4 已存在反思时快速跳过（不烧模型调用）');
  if (!memoryRoot) {
    bad('无法定位记忆库，跳过后续断言');
  } else {
    const reflectDir = path.join(memoryRoot, '50-反思');
    await fsp.mkdir(reflectDir, { recursive: true });
    const probeName = '反思 2000-W01.md';
    const probePath = path.join(reflectDir, probeName);
    const probeBody = '---\ntags: [反思]\n---\n\n# 探针\n\n这是测试用的反思笔记，测试结束后会删除。\n';
    // 用一个「过去周」的名字不会和真实笔记冲突；但 reflect.mjs 只认当前 ISO 周，
    // 所以这里直接验证「当前周笔记存在 → 快速跳过」。
    const now = new Date();
    const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
    const currentName = `反思 ${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}.md`;
    const currentPath = path.join(reflectDir, currentName);
    const existedBefore = fs.existsSync(currentPath);
    let backup = null;
    if (existedBefore) backup = await fsp.readFile(currentPath);

    await fsp.writeFile(currentPath, probeBody, 'utf8');
    const beforeStat = await fsp.stat(currentPath);
    await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    const skipRun = await run(process.execPath, [REFLECT, '--days', '3'], { timeoutMs: 45000 });
    const elapsed = Date.now() - started;

    if (skipRun.code === 0) ok('reflect.mjs 退出码 0');
    else bad('reflect.mjs 退出码非 0', (skipRun.err || skipRun.out).slice(0, 200));

    if (elapsed < 5000) ok('5 秒内就返回（没有调用 DSH）', `${elapsed}ms`);
    else bad('耗时过长，说明跳过逻辑挡不住模型调用', `${elapsed}ms`);

    if (/跳过/.test(skipRun.out)) ok('日志说明了跳过原因');
    else bad('日志没有「跳过」字样', skipRun.out.slice(0, 160));

    const afterStat = await fsp.stat(currentPath);
    if (afterStat.mtimeMs === beforeStat.mtimeMs) ok('已有笔记未被改写');
    else bad('跳过时仍然改写了笔记');

    // 还原现场
    if (existedBefore && backup) await fsp.writeFile(currentPath, backup);
    else await fsp.unlink(currentPath).catch(() => {});
    await fsp.unlink(probePath).catch(() => {});
    ok('测试临时文件已清理');
  }

  section('4/4 源码关键实现点');
  const src = await fsp.readFile(REFLECT, 'utf8');
  if (/parsed\?\.items|parsed\.items/.test(src)) ok('reflect.mjs 认 items 字段');
  else bad('reflect.mjs 没处理 items 字段');
  if (/resolveDshCommand/.test(src)) ok('reflect.mjs 会解析 dsh 的 js 入口（避开 .cmd ENOENT）');
  else bad('reflect.mjs 仍然直接 spawn dsh');
  if (/cwd:\s*WORKSPACE/.test(src)) ok('reflect.mjs 用 spawn 的 cwd 指定工作目录（dsh 没有 --cwd）');
  else bad('reflect.mjs 工作目录传递方式不对');
  if (!/['"]--cwd['"]/.test(src)) ok('没有误用 dsh --cwd 选项');
  else bad('仍在传 dsh --cwd');

  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(52));
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试异常：', err?.stack ?? err);
  process.exitCode = 1;
});
