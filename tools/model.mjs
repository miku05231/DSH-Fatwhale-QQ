#!/usr/bin/env node
/**
 * model.mjs —— 模型跟随时用的命令行小工具。
 *
 * 用法：
 *   node tools\model.mjs                  # 同 show
 *   node tools\model.mjs show [--json]    # 当前模式、生效模型、桌面端模型、供应商清单
 *   node tools\model.mjs follow           # 切回「跟随 DSH 桌面端」
 *   node tools\model.mjs manual <供应商> <模型> [思考强度]
 *   node tools\model.mjs providers        # 列出桌面端配置里的供应商与模型
 *   node tools\model.mjs path             # 打印 runtime patch 路径
 *
 * 零第三方依赖。参数全部是数组直传，不拼 shell。
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  MODEL_MODES,
  REASONING_EFFORTS,
  describeModelState,
  modelPaths,
  readModelState,
  resolveModelPlan,
  writeModelState,
} from '../src/model-follow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const BASE_PATCH = path.join(PROJECT_ROOT, 'patches', 'headless-model.yml');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const command = (args[0] || 'show').toLowerCase();

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function pad(text, width) {
  const s = String(text ?? '');
  let visible = 0;
  for (const ch of s) visible += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - visible));
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function show() {
  const snap = describeModelState({ stateDir: STATE_DIR, basePatchPath: BASE_PATCH });
  if (asJson) {
    printJson({ ok: true, ...snap, runtimePatch: snap.runtimePatch, stateDir: STATE_DIR });
    return;
  }

  const effective = snap.effective;
  console.log('大肥鱼 —— 模型状态');
  console.log('='.repeat(56));
  console.log(`${pad('模式', 12)}${snap.mode === 'manual' ? '手动指定' : '跟随 DSH 桌面端'}`);
  console.log(
    `${pad('生效模型', 12)}${effective ? `${effective.provider}/${effective.model}` : '已回落到基础 patch'}`,
  );
  console.log(`${pad('思考强度', 12)}${effective?.reasoningEffort ?? '—'}`);
  console.log(
    `${pad('桌面端模型', 12)}${snap.desktop ? `${snap.desktop.provider}/${snap.desktop.model}` : '—（读不到）'}`,
  );
  console.log(`${pad('runtime', 12)}${snap.runtimePatch || '本次没生成（用基础 patch）'}`);
  console.log(`${pad('生成时间', 12)}${snap.generatedAt ? new Date(snap.generatedAt).toLocaleString('zh-CN') : '—'}`);
  if (snap.updatedAt) {
    console.log(`${pad('手动设置于', 12)}${new Date(snap.updatedAt).toLocaleString('zh-CN')}`);
  }
  if (snap.reason) console.log(`${pad('说明', 12)}${snap.reason}`);
  console.log(`${pad('供应商', 12)}${snap.providers.length} 个`);
  for (const p of snap.providers) {
    const mark = effective && effective.provider === p.id ? '*' : ' ';
    console.log(`  ${mark} ${pad(p.id, 22)}${p.models.join('、') || '（无模型）'}`);
  }
}

function setFollow() {
  return writeModelState(STATE_DIR, { mode: 'follow', manual: readModelState(STATE_DIR).manual }).then(() => {
    const plan = resolveModelPlan({ stateDir: STATE_DIR, basePatchPath: BASE_PATCH, force: true });
    if (asJson) {
      printJson({ ok: true, mode: 'follow', effective: plan.info.effective, reason: plan.info.reason });
      return;
    }
    console.log('已切回跟随模式，下一条 QQ 消息生效。');
    console.log(
      `生效模型：${plan.info.effective ? `${plan.info.effective.provider}/${plan.info.effective.model}` : '基础 patch'}`,
    );
  });
}

function setManual(provider, model, effort) {
  if (!provider || !model) fail('用法：node tools\\model.mjs manual <供应商> <模型> [思考强度]');
  const useEffort = effort || 'max';
  if (!REASONING_EFFORTS.includes(useEffort)) {
    fail(`思考强度只能是：${REASONING_EFFORTS.join(' / ')}`);
  }

  return writeModelState(STATE_DIR, {
    mode: 'manual',
    manual: { provider, model, reasoningEffort: useEffort },
  }).then(() => {
    const plan = resolveModelPlan({ stateDir: STATE_DIR, basePatchPath: BASE_PATCH, force: true });

    if (asJson) {
      printJson({
        ok: true,
        mode: 'manual',
        manual: { provider, model, reasoningEffort: useEffort },
        effective: plan.info.effective,
      });
      return;
    }
    console.log(`已切到手动模式：${provider}/${model}（${useEffort}），下一条 QQ 消息生效。`);
    if (plan.info.desktop) {
      console.log(`桌面端当前是 ${plan.info.desktop.provider}/${plan.info.desktop.model}，手动模式不再跟它走。`);
    }
  });
}

function printProviders() {
  const snap = describeModelState({ stateDir: STATE_DIR, basePatchPath: BASE_PATCH });
  if (asJson) {
    printJson({ ok: true, providers: snap.providers, desktop: snap.desktop });
    return;
  }
  if (snap.providers.length === 0) {
    console.log('桌面端配置里没读到供应商清单。');
    if (snap.reason) console.log(`原因：${snap.reason}`);
    return;
  }
  console.log('DSH 桌面端配置里的供应商：');
  for (const p of snap.providers) {
    console.log(`- ${p.id}`);
    for (const m of p.models) console.log(`    ${m}`);
  }
}

function printPath() {
  const paths = modelPaths(STATE_DIR);
  if (asJson) {
    printJson({ ok: true, ...paths });
    return;
  }
  console.log(`state 目录：${STATE_DIR}`);
  console.log(`runtime patch：${paths.runtimePatch}`);
  console.log(`元数据：${paths.metaFile}`);
}

function main() {
  switch (command) {
    case 'show':
    case 'status':
      return show();
    case 'follow':
      return setFollow();
    case 'manual':
      return setManual(args[1], args[2], args[3]);
    case 'providers':
      return printProviders();
    case 'path':
      return printPath();
    case 'help':
    case '--help':
    case '-h':
      console.log('用法：node tools\\model.mjs [show|follow|manual <供应商> <模型> [思考强度]|providers|path] [--json]');
      console.log(`模式：${MODEL_MODES.join(' / ')}`);
      return undefined;
    default:
      return fail(`不认识的子命令「${command}」，试试 show / follow / manual / providers / path`);
  }
}

try {
  await main();
} catch (err) {
  fail(err?.message ?? String(err));
}
