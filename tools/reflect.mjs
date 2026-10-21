// 记忆反思：把最近几天的对话日志，沉淀成一篇「反思笔记」。
//
// 用法：
//   node tools\reflect.mjs            # 今天没反思过就跑一次
//   node tools\reflect.mjs --force    # 强制再跑一次
//   node tools\reflect.mjs --days 5   # 看最近 5 天（默认 3）
//
// 设计要点：
// - 不 import src/memory.js，改用 tools/memory.mjs 的命令行，避免和记忆模块耦合；
// - 调用 dsh --profile headless 生成总结，失败就退化成「结构化摘要」而不是报错；
// - 同一天只写一次（除非 --force），防止桥接每 20 轮触发一次把笔记刷爆。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { killProcessTree } from '../src/dsh.js';
import { runChatOnlyDsh } from '../src/chat-only.js';
import { resolveModelPlan } from '../src/model-follow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MEMORY_CLI = path.join(ROOT, 'tools', 'memory.mjs');
const PATCH = path.join(ROOT, 'patches', 'headless-model.yml');
const WORKSPACE = path.join(ROOT, 'qq-workspace');

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const FORCE = process.argv.includes('--force');
const DAYS = Math.max(1, Math.min(30, Number(argOf('--days', 3)) || 3));

/** 跑一个命令，收集 stdout；超时杀掉整棵进程树。 */
function run(cmd, args, { timeoutMs = 180000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
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

const today = () => {  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const isoWeek = () => {
  const d = new Date();
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

async function main() {
  console.log(`[反思] 记忆库 CLI：${MEMORY_CLI}`);

  // 1) 取最近几天的日志
  const recent = await run(process.execPath, [MEMORY_CLI, 'recent', '--days', String(DAYS), '--json'], {
    timeoutMs: 30000,
  });
  if (recent.code !== 0) {
    console.error('[反思] 读日志失败：', (recent.err || recent.out).slice(0, 500));
    process.exitCode = 2;
    return;
  }

  let entries = [];
  try {
    const parsed = JSON.parse(recent.out);
    if (Array.isArray(parsed)) entries = parsed;
    else if (Array.isArray(parsed?.items)) entries = parsed.items; // memory.mjs recent --json 的真实形状
    else if (Array.isArray(parsed?.data)) entries = parsed.data;
    else if (Array.isArray(parsed?.entries)) entries = parsed.entries;
    else entries = [];
  } catch {
    // 退化：把原始输出当文本用
    entries = [{ title: '最近日志原文', body: recent.out.slice(0, 6000) }];
  }

  const material = entries
    .map((e) => {
      const title = e.title ?? e.date ?? e.path ?? '(未命名)';
      const body = String(e.body ?? e.text ?? e.content ?? '').slice(0, 4000);
      return `## ${title}\n${body}`;
    })
    .join('\n\n')
    .slice(0, 12000);

  if (!material.trim()) {
    console.log('[反思] 最近没有对话日志，跳过。');
    return;
  }

  // 1.5) 同一天只反思一次：先看目标笔记是否已存在（memory.mjs 不支持 --skip-if-exists，
  //      必须自己在调用 DSH 之前判定，否则白白烧一次模型调用）
  const title = `反思 ${isoWeek()}`;
  const relFile = path.join('50-反思', `${title}.md`);
  const rootOut = await run(process.execPath, [MEMORY_CLI, 'path'], { timeoutMs: 20000 });
  const memoryRoot = (rootOut.out ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  const targetPath = memoryRoot ? path.join(memoryRoot, relFile) : '';
  if (targetPath && fs.existsSync(targetPath) && !FORCE) {
    console.log(`[反思] 已存在（${relFile}），跳过。要重写加 --force。`);
    return;
  }

  // 2) 让 DSH 读一遍，写成反思
  const prompt = [
    '你在给自己的长期记忆做一次复盘。下面是我最近几天的 QQ 对话日志。',
    '',
    material,
    '',
    '[任务] 写一份简短的中文复盘，严格用这个 Markdown 结构，不要额外解释：',
    '## 这段时间聊了什么',
    '（3-6 条要点）',
    '## 我做得不好的地方',
    '（1-3 条，要具体，别写空话）',
    '## 下次要注意',
    '（1-3 条可执行的规则）',
    '## 值得记住的事实',
    '（关于主人/群友/群的稳定信息，每条一行，格式：- 谁：什么）',
    '',
    '整篇不超过 500 字。',
  ].join('\n');

  console.log('[反思] 调 DSH 生成复盘…');
  let dsh;
  try {
    const loaded = loadConfig(ROOT, {
      createIfMissing: false,
      ...(process.env.QQ_CONFIG ? { configFile: process.env.QQ_CONFIG } : {}),
    });
    const configRoot = path.dirname(loaded.path);
    const stateDir = path.resolve(configRoot, loaded.config.stateDir || 'state');
    const configuredPatch = loaded.config.dsh.patchPath ?? PATCH;
    const patchPath = configuredPatch ? path.resolve(configRoot, configuredPatch) : '';
    const modelPlan = resolveModelPlan({ stateDir, basePatchPath: patchPath });
    // 对话日志包含普通群成员的输入；总结时一律禁用电脑工具。
    const result = await runChatOnlyDsh(prompt, {
      cfg: loaded.config,
      cwd: fs.existsSync(WORKSPACE) ? WORKSPACE : configRoot,
      projectRoot: configRoot,
      stateDir,
      patchPath,
      extraPatchPaths: modelPlan.patchPaths,
      model: modelPlan.info?.effective,
    });
    dsh = { code: 0, out: result.finalText, err: '' };
  } catch (error) {
    dsh = { code: 1, out: '', err: String(error?.message || error) };
  }

  let body = (dsh.out ?? '').trim();
  if (dsh.code !== 0 || !body) {
    console.warn('[反思] DSH 调用失败，退化为结构化摘要：', (dsh.err || '').slice(0, 300));
    body = [
      '## 这段时间聊了什么',
      `自动摘要失败，以下是原始日志片段（共 ${entries.length} 条）：`,
      material.slice(0, 1500),
    ].join('\n');
  }

  // 3) 写进 50-反思
  const args = [MEMORY_CLI, 'note', '--title', title, '--dir', '50-反思', '--tag', '反思', '--body', body];

  const write = await run(process.execPath, args, { timeoutMs: 30000 });
  if (write.code === 0) {
    console.log(`[反思] 已写入 ${relFile}`);
  } else {
    console.error('[反思] 写入失败：', (write.err || write.out).slice(0, 400));
    process.exitCode = 2;
  }
  console.log(`[反思] 完成于 ${today()}`);
}

main().catch((err) => {
  console.error('[反思] 异常：', err?.stack ?? err);
  process.exitCode = 1;
});
