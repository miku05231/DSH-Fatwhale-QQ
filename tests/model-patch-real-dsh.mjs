/**
 * model-patch-real-dsh.mjs —— 用**真的 dsh 二进制**验证「runtime patch 真的盖住了基础 patch」。
 *
 * 前面的 e2e 只证明桥接把两条 --patch 传给了子进程；这个测试回答更硬的问题：
 * dsh 自己合并完这两层之后，agent-default-model 到底是谁的？
 *
 * 做法（全程只读桌面端配置，不碰真实 state）：
 *   1. 用真的 ~/.dsh/profiles/desktop/cordis.patch.yml 生成一份临时 runtime patch；
 *   2. 跑 `node <dsh bin> --profile headless --patch 基础 --patch 临时runtime --dump-config`；
 *   3. 从 dump 出来的配置里抓 agent-default-model，必须等于桌面端当前模型
 *      （也就是基础 patch 里的模型被盖掉了）。
 *
 * 用法：node tests\model-patch-real-dsh.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseDesktopLayer,
  desktopProfileLayerPath,
  resolveModelPlan,
} from '../src/model-follow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE_PATCH = path.join(ROOT, 'patches', 'headless-model.yml');

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

/** dsh 是批处理，不能直接 spawn('dsh')；找到它真正的 bin.js 用当前 node 跑 */
function resolveDshBin() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ...String(process.env.DSH_HOME || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function runDumpConfig(bin, patches) {
  return new Promise((resolve) => {
    const args = [bin, '--profile', 'headless'];
    for (const p of patches) args.push('--patch', p);
    args.push('--dump-config');
    const child = spawn(process.execPath, args, { windowsHide: true, cwd: ROOT });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: -1, out: String(err?.message ?? err) }));
  });
}

/** 从 dump 出来的 YAML 里截出 agent-default-model 这一段 */
function sliceModelSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*agent-default-model\s*$/.test(l));
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^\s*#\s*==/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

async function main() {
  const bin = resolveDshBin();
  if (!bin) {
    console.log('  ! 找不到 dsh 的 bin.js，跳过本测试');
    console.log('\n通过 1 项（跳过）');
    return;
  }
  ok('找到 dsh 入口', bin);

  // 桌面端补丁层不存在时（比如从没开过 GUI）不算失败
  const layerPath = desktopProfileLayerPath();
  if (!fs.existsSync(layerPath)) {
    console.log(`  ! 桌面端补丁层不存在（${layerPath}），跳过`);
    console.log('\n通过 1 项（跳过）');
    return;
  }

  const desktop = parseDesktopLayer(await fsp.readFile(layerPath, 'utf8'));
  if (!desktop.ok || !desktop.model) {
    bad('桌面端补丁层解析失败', desktop.reason ?? '');
  } else {
    ok('解析出桌面端当前模型', `${desktop.model.provider}/${desktop.model.model}（effort=${desktop.model.reasoningEffort}）`);
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-model-real-'));
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  try {
    const plan = await resolveModelPlan({
      stateDir: path.join(tmpRoot, 'state'),
      basePatchPath: BASE_PATCH,
      log,
    });

    if (plan.patchPaths.length === 1) ok('生成了 1 条 runtime patch（基础 patch 由 dsh.js 放在它前面）', plan.patchPaths[0]);
    else bad('runtime patch 数量不对', JSON.stringify(plan.patchPaths));

    // 真实链路里基础 patch 是 dsh.js 拼在最前面的，这里照同样的顺序来
    const realDsh = await runDumpConfig(bin, [BASE_PATCH, ...plan.patchPaths]);
    if (realDsh.code === 0) ok('真 dsh --dump-config 跑通', `exit=${realDsh.code}`);
    else bad('真 dsh --dump-config 失败', realDsh.out.split('\n').slice(-3).join(' / '));

    const section = sliceModelSection(realDsh.out);
    if (section) ok('dump 里有 agent-default-model 段');
    else bad('dump 里没有 agent-default-model 段', realDsh.out.slice(0, 200));

    if (desktop.ok && desktop.model) {
      const wantProvider = new RegExp(`^\\s*provider:\\s*${desktop.model.provider}\\s*$`, 'm');
      const wantModel = new RegExp(`^\\s*model:\\s*${desktop.model.model}\\s*$`, 'm');
      if (wantProvider.test(section)) ok('生效 provider 是桌面端的', desktop.model.provider);
      else bad('生效 provider 不是桌面端的', section.split('\n').slice(0, 6).join(' / '));
      if (wantModel.test(section)) ok('生效 model 是桌面端的', desktop.model.model);
      else bad('生效 model 不是桌面端的', section.split('\n').slice(0, 6).join(' / '));
    }

    // 基础 patch 里写的是 relay-a / deepseek-v4.1-flash，被盖掉才说明顺序对
    const baseText = fs.readFileSync(BASE_PATCH, 'utf8');
    const baseProvider = baseText.match(/provider:\s*([A-Za-z0-9_.-]+)/)?.[1];
    if (baseProvider && section.includes(`provider: ${baseProvider}`) && baseProvider !== desktop.model?.provider) {
      bad('基础 patch 的 provider 没有被盖掉', baseProvider);
    } else {
      ok('基础 patch 的 provider 已被覆盖', `基础=${baseProvider ?? '?'}`);
    }

    const effort = desktop.model?.reasoningEffort ?? '';
    if (effort && new RegExp(`^\\s*reasoningEffort:\\s*${effort}\\s*$`, 'm').test(section)) {
      ok('reasoningEffort 跟随桌面端', effort);
    } else if (!effort) {
      ok('桌面端没写 reasoningEffort，跳过该项');
    } else {
      bad('reasoningEffort 没跟随', section.split('\n').slice(0, 6).join(' / '));
    }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
