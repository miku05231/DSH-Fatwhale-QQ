/**
 * model-follow-test.mjs —— 模型跟随模块的纯函数 + 文件读写测试。
 *
 * 不碰真实 state/ 目录，也不改用户的桌面端配置：全部在临时目录里用假的家目录跑，
 * 只有最后一组「真实桌面端补丁层」是只读解析。
 *
 * 输出约定（run-all.mjs 靠字样判定）：结尾打印「通过 N 项，失败 M 项」，
 * 全过时退出码 0。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MODEL_MODES,
  buildRuntimePatch,
  describeModelState,
  desktopProfileLayerPath,
  modelPaths,
  parseDesktopLayer,
  readModelState,
  resolveModelPlan,
  writeModelState,
} from '../src/model-follow.js';
import { resolvePatchChain } from '../src/dsh.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, name, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  通过  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  失败  ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbridge-${prefix}-`));
}

function writeFileDeep(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** 假的家目录 + 假的桌面端补丁层 */
function makeHome(layerText) {
  const home = tmpDir('home');
  if (layerText !== null) {
    writeFileDeep(desktopProfileLayerPath(home), layerText);
  }
  return home;
}

/** 一份贴近真实结构的补丁层样例（含注释、引号、多个模型） */
const LAYER_SAMPLE = `# DSH 桌面端用户补丁层
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      relay-a:
        baseURL: https://www.api.example.com/v1
        apiKeyEnv: XIANAPI_DS_API_KEY
        api: openai-completions
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 131072
          - id: deepseek-v4.1-pro
            name: DeepSeek V4.1 Pro
      deepseek-official:
        baseURL: https://api.deepseek.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: deepseek-chat
            name: DeepSeek Chat
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: relay-a
    model: deepseek-v4.1-pro
    reasoningEffort: high
- id: something-else
  config:
    providers:
      wrong: {}
    provider: nope
    model: nope
`;

console.log('大肥鱼 QQ 桥接 —— 模型跟随测试');
console.log('='.repeat(64));

/* ---------------------------------------------------------------- 1. 解析 */
console.log('\n[1] 解析桌面端补丁层');
{
  const parsed = parseDesktopLayer(LAYER_SAMPLE);
  ok(parsed.ok, '解析成功', parsed.reason);
  eq(parsed.providers.length, 2, '解析出 2 个供应商');
  const ids = parsed.providers.map((p) => p.id);
  ok(ids.includes('relay-a'), '包含 relay-a');
  ok(ids.includes('deepseek-official'), '包含 deepseek-official');
  const xian = parsed.providers.find((p) => p.id === 'relay-a');
  eq(xian?.models.length, 2, 'relay-a 有 2 个模型');
  ok(xian?.models.includes('deepseek-v4.1-flash'), '模型列表含 deepseek-v4.1-flash');
  eq(parsed.model?.provider, 'relay-a', '当前模型 provider 正确');
  eq(parsed.model?.model, 'deepseek-v4.1-pro', '当前模型 model 正确');
  eq(parsed.model?.reasoningEffort, 'high', '当前模型 effort 正确');
  ok(parsed.providersBlock.length > 0, 'providers 原文块非空');
  ok(parsed.modelBlock.length === 3, 'model 原文块是 3 行');
  // 不能把后面那个同名 config 段算进来
  ok(!parsed.providersBlock.some((line) => line.includes('wrong:')), '不串入其它条目的 providers');
}

/* ------------------------------------------------------- 2. 跟随模式生成 */
console.log('\n[2] 跟随模式（mode=follow）');
const followHome = makeHome(LAYER_SAMPLE);
const followState = tmpDir('state');
{
  const plan = resolveModelPlan({ stateDir: followState, homedir: followHome });
  eq(plan.patchPaths.length, 1, '生成了 1 个 runtime patch');
  const patch = plan.patchPaths[0];
  ok(fs.existsSync(patch), 'runtime patch 文件存在');
  const text = fs.readFileSync(patch, 'utf8');
  ok(text.includes('- id: llm-pi-ai'), 'patch 含 llm-pi-ai 条目');
  ok(text.includes('- id: agent-default-model'), 'patch 含 agent-default-model 条目');
  ok(text.includes('deepseek-v4.1-pro'), 'patch 含当前模型');
  ok(text.includes('providers:'), 'patch 含 providers 段');
  ok(!text.includes('wrong:'), 'patch 不含其它条目的垃圾');
  eq(plan.info.mode, 'follow', 'info.mode=follow');
  eq(plan.info.effective?.source, 'follow', '生效来源是 follow');
  eq(plan.info.effective?.model, 'deepseek-v4.1-pro', '生效模型正确');
  eq(plan.info.providers.length, 2, 'info 里带供应商清单');
  ok(plan.info.generatedAt, 'info 带生成时间');
  ok(text.startsWith('#'), 'patch 顶部有注释头');
}

/* ----------------------------------------------------- 3. 幂等（不重写） */
console.log('\n[3] 幂等：内容不变时不重写文件');
{
  const patch = path.join(followState, 'model', 'runtime-model.yml');
  const before = fs.statSync(patch).mtimeMs;
  const plan = resolveModelPlan({ stateDir: followState, homedir: followHome });
  const after = fs.statSync(patch).mtimeMs;
  eq(plan.patchPaths.length, 1, '仍然返回 patch 路径');
  ok(before === after, '文件未被重写', `mtime ${before} → ${after}`);
  ok(plan.info.generatedAt, '沿用已有生成时间');
}

/* ------------------------------------------------- 4. 桌面端换模型→跟随 */
console.log('\n[4] 桌面端换模型后自动跟随');
{
  const nextLayer = LAYER_SAMPLE.replace('model: deepseek-v4.1-pro', 'model: deepseek-chat').replace(
    'provider: relay-a',
    'provider: deepseek-official',
  );
  writeFileDeep(desktopProfileLayerPath(followHome), nextLayer);
  const plan = resolveModelPlan({ stateDir: followState, homedir: followHome });
  eq(plan.info.effective?.provider, 'deepseek-official', 'provider 跟随成 deepseek-official');
  eq(plan.info.effective?.model, 'deepseek-chat', 'model 跟随成 deepseek-chat');
  const text = fs.readFileSync(plan.patchPaths[0], 'utf8');
  ok(text.includes('deepseek-chat'), 'runtime patch 已更新');
}

/* ---------------------------------------------------------- 5. 手动模式 */
console.log('\n[5] 手动模式（mode=manual）');
const manualHome = makeHome(LAYER_SAMPLE);
const manualState = tmpDir('state');
{
  await writeModelState(manualState, {
    mode: 'manual',
    manual: { provider: 'relay-a', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  });
  const store = readModelState(manualState);
  eq(store.mode, 'manual', '状态文件记录 manual');
  eq(store.manual?.model, 'deepseek-v4.1-flash', '状态文件记录手动模型');

  const plan = resolveModelPlan({ stateDir: manualState, homedir: manualHome });
  eq(plan.info.effective?.source, 'manual', '生效来源是 manual');
  eq(plan.info.effective?.model, 'deepseek-v4.1-flash', '手动模型生效');
  eq(plan.info.effective?.reasoningEffort, 'max', '手动 effort 生效');
  const text = fs.readFileSync(plan.patchPaths[0], 'utf8');
  ok(text.includes('deepseek-v4.1-flash'), 'patch 用手动模型');
  ok(!text.includes('model: deepseek-v4.1-pro'), 'patch 不再用桌面端模型');

  // 切回跟随
  await writeModelState(manualState, { mode: 'follow', manual: null });
  const back = resolveModelPlan({ stateDir: manualState, homedir: manualHome });
  eq(back.info.effective?.source, 'follow', '切回 follow 生效');
  eq(readModelState(manualState).mode, 'follow', '状态文件已切回 follow');
}

/* -------------------------------------------- 6. 兜底：拿不到桌面端配置 */
console.log('\n[6] 兜底路径（不该抛异常，应返回空 patch 列表）');
{
  const emptyHome = makeHome(null); // 家目录里没有补丁层
  const state = tmpDir('state');
  const plan = resolveModelPlan({ stateDir: state, homedir: emptyHome });
  eq(plan.patchPaths.length, 0, '缺补丁层 → 不加 patch');
  ok(plan.info.reason.length > 0, '给出原因');
  ok(/读不到/.test(plan.info.reason), '原因是读不到补丁层', plan.info.reason);

  const brokenHome = makeHome('- id: something\n  config: {}\n');
  const plan2 = resolveModelPlan({ stateDir: state, homedir: brokenHome });
  eq(plan2.patchPaths.length, 0, '补丁层结构不对 → 不加 patch');
  ok(/找不到/.test(plan2.info.reason), '原因是找不到条目', plan2.info.reason);
}

/* --------------------------------------------------------- 7. 状态容错 */
console.log('\n[7] 状态文件容错');
{
  const state = tmpDir('state');
  const paths = modelPaths(state);
  eq(readModelState(state).mode, 'follow', '没有状态文件时默认 follow');

  writeFileDeep(paths.stateFile, '{ 这不是 JSON');
  eq(readModelState(state).mode, 'follow', '坏 JSON 回退 follow');

  writeFileDeep(paths.stateFile, JSON.stringify({ mode: '乱写', manual: { provider: 'a', model: 'b' } }));
  const s = readModelState(state);
  eq(s.mode, 'follow', '非法 mode 回退 follow');
  eq(s.manual?.reasoningEffort, 'max', 'manual 缺 effort 时补 max');

  await writeModelState(state, { mode: 'manual', manual: { provider: '', model: '' } });
  eq(readModelState(state).manual, null, '空的 manual 归为 null');
  ok(MODEL_MODES.includes('manual') && MODEL_MODES.includes('follow'), 'MODEL_MODES 常量正确');
}

/* ----------------------------------------------------- 8. patch 文本结构 */
console.log('\n[8] buildRuntimePatch 文本结构');
{
  const text = buildRuntimePatch({
    providersBlock: ['      p1:', '        models:', '          - id: m1'],
    modelLines: ['    provider: p1', '    model: m1', '    reasoningEffort: off'],
  });
  const lines = text.split('\n');
  ok(lines[0].startsWith('#'), '第一行是注释');
  ok(text.includes('\n  config:\n    providers:\n      p1:'), 'providers 层级缩进正确');
  ok(text.includes('    provider: p1'), 'model 层级缩进正确');
  ok(text.endsWith('\n'), '文件以换行结尾');
}

/* ------------------------------------------------- 9. describeModelState */
console.log('\n[9] describeModelState 快照');
{
  const home = makeHome(LAYER_SAMPLE);
  const state = tmpDir('state');
  const snap = describeModelState({ stateDir: state, homedir: home });
  eq(snap.mode, 'follow', '快照 mode');
  eq(snap.desktop?.model, 'deepseek-v4.1-pro', '快照桌面端模型');
  eq(snap.providers.length, 2, '快照供应商');
  eq(snap.effective?.model, 'deepseek-v4.1-pro', '快照生效模型');
  ok(snap.runtimePatch, '快照带 runtime patch 路径');
  eq(snap.desktopLayer, desktopProfileLayerPath(home), '快照带补丁层路径');
}

/* ------------------------------------------- 10. 真实桌面端补丁层（只读） */
console.log('\n[10] 真实桌面端补丁层（只读解析）');
{
  const realPath = desktopProfileLayerPath();
  if (!fs.existsSync(realPath)) {
    console.log(`  跳过  本机没有 ${realPath}`);
  } else {
    const text = fs.readFileSync(realPath, 'utf8');
    const parsed = parseDesktopLayer(text);
    ok(parsed.ok, '真实补丁层可解析', parsed.reason);
    ok(parsed.providers.length > 0, `真实补丁层解析出供应商（${parsed.providers.length} 个）`);
    if (parsed.model) {
      ok(Boolean(parsed.model.provider && parsed.model.model), `真实当前模型：${parsed.model.provider}/${parsed.model.model}`);
    } else {
      console.log('  跳过  真实补丁层没有 agent-default-model（桥接会退回基础 patch）');
    }
    console.log(`  信息  供应商：${parsed.providers.map((p) => `${p.id}(${p.models.length})`).join('、')}`);
  }
}

/* ------------------------------------------- 11. dsh 的 patch 链拼装 */
console.log('\n[11] dsh 的 --patch 链拼装（resolvePatchChain）');
{
  const root = tmpDir('chain');
  const baseDir = path.join(root, 'patches');
  writeFileDeep(path.join(baseDir, 'headless-model.yml'), 'x: 1\n');
  const runtimeDir = path.join(root, 'state', 'model');
  writeFileDeep(path.join(runtimeDir, 'runtime-model.yml'), 'y: 2\n');

  // 相对路径按 projectRoot 解析，而不是按 workDir
  const otherWorkDir = tmpDir('othercwd');
  const chain = resolvePatchChain({
    dshCfg: { patchPath: 'patches/headless-model.yml' },
    projectRoot: root,
    workDir: otherWorkDir,
    extraPatchPaths: ['state/model/runtime-model.yml'],
  });
  ok(chain.ok, '相对 patch 能解析', chain.ok ? '' : chain.error);
  ok(chain.ok && chain.patchPath === path.join(baseDir, 'headless-model.yml'), '基础 patch 按项目根解析为绝对路径');
  ok(chain.ok && chain.patches.length === 2, '基础 + 额外共两条 patch');
  eq(chain.ok ? chain.patches[0] : null, path.join(baseDir, 'headless-model.yml'), '顺序：基础 patch 在前');
  eq(chain.ok ? chain.patches[1] : null, path.join(runtimeDir, 'runtime-model.yml'), '顺序：runtime patch 在后（覆盖式叠加）');

  // 缺失的额外 patch：跳过而不是报错（跟随失败不能拖垮对话）
  const skipped = resolvePatchChain({
    dshCfg: { patchPath: 'patches/headless-model.yml' },
    projectRoot: root,
    extraPatchPaths: ['state/model/nope.yml', '', null, 42],
  });
  ok(skipped.ok && skipped.patches.length === 1, '缺失/非法的额外 patch 被跳过');
  eq(skipped.ok ? skipped.skipped.length : -1, 1, '跳过的条目记录在 skipped 里');

  // 绝对路径原样保留
  const absExtra = path.join(runtimeDir, 'runtime-model.yml');
  const absChain = resolvePatchChain({
    patchPath: path.join(baseDir, 'headless-model.yml'),
    dshCfg: {},
    extraPatchPaths: [absExtra],
  });
  ok(absChain.ok && absChain.patches[1] === absExtra, '绝对路径的额外 patch 原样使用');

  // 基础 patch 缺失 / 配置为空：明确报错
  const missing = resolvePatchChain({ dshCfg: { patchPath: 'patches/none.yml' }, projectRoot: root });
  ok(missing.ok === false, '基础 patch 不存在时报错');
  ok(missing.ok === false && missing.error.includes('找不到 patch 文件'), '报错文案点明缺文件');

  // patchPath 是可选配置：留空 = 不套补丁（dsh 用它自己的模型配置），不算错误
  const empty = resolvePatchChain({ dshCfg: {} });
  ok(empty.ok === true && empty.disabled === true && empty.patches.length === 0, '没配置 patchPath 时按不套补丁运行');

  for (const dir of [root, otherWorkDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------- 清理临时目录 */
for (const dir of [followHome, manualHome, followState, manualState]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log(`失败项：${failures.join(' / ')}`);
}
process.exit(failed === 0 ? 0 : 1);

