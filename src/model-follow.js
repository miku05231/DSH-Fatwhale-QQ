/**
 * 模型跟随（model-follow）
 *
 * 目标：让 QQ 机器人的模型「跟着 DSH 桌面端当前选的模型走」，并且能在控制台里切换。
 *
 * 背景事实（实测）：
 *   - DSH 桌面端把「当前默认模型」写在
 *       %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
 *     的 `- id: agent-default-model` 条目里，同一份文件里还有完整的
 *     `- id: llm-pi-ai` 供应商清单（provider / baseURL / apiKeyEnv / models）。
 *     用户在界面里换模型，这个文件就被改写 —— 所以它是「当前模型」的权威来源。
 *   - 桥接跑的是 headless profile，它的 dsh 进程默认读
 *       patches/headless-model.yml（固定 relay-a/deepseek-v4.1-flash）。
 *   - headless 侧只要在基础 patch 之后再叠一个 `--patch`，里面的
 *     `agent-default-model` 会覆盖基础 patch 的值（补丁按顺序叠加）。
 *
 * 于是本模块做三件事：
 *   1. 从桌面端 patch 层里「文本级」抠出 providers 块与 agent-default-model 块
 *      （不引第三方 YAML 库，保持零依赖；块内原样搬运，注释/引号风格都不动）。
 *   2. 按「跟随 / 手动」两种模式生成 state/model/runtime-model.yml，
 *      内容 = 桌面端的 providers + 选中的模型。桥接每条消息前调用一次，
 *      于是换模型后**下一条 QQ 消息**就生效，不需要重启任何进程。
 *   3. 给控制台提供读取/写入接口用的数据结构（模式、可选供应商、当前生效模型）。
 *
 * 容错原则：任何环节出问题都退回「不加 runtime patch」，让基础 patch 继续兜底，
 * 绝不能让机器人因为读不到桌面端配置而失联。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 支持的两种模式 */
export const MODEL_MODES = ['follow', 'manual'];

/** 手动模式下没给 reasoningEffort 时的默认值 */
const DEFAULT_REASONING_EFFORT = 'max';

/** 常见的 reasoning effort 档位（供应商可能只支持其中几档，这里只用于下拉框候选） */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 桌面端 profile 的补丁层路径 */
export function desktopProfileLayerPath(homedir = os.homedir()) {
  return path.join(homedir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

/** 把 stateDir 下与模型相关的路径收拢到一处 */
export function modelPaths(stateDir) {
  const dir = path.join(stateDir, 'model');
  return {
    dir,
    stateFile: path.join(dir, 'model.json'),
    runtimePatch: path.join(dir, 'runtime-model.yml'),
    metaFile: path.join(dir, 'meta.json'),
  };
}

/** 读手动模式的状态文件；坏文件当作默认值 */
export function readModelState(stateDir) {
  const { stateFile } = modelPaths(stateDir);
  const fallback = { mode: 'follow', manual: null, updatedAt: null };
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return fallback;
    const mode = MODEL_MODES.includes(data.mode) ? data.mode : 'follow';
    const manual = normalizeManual(data.manual);
    return { mode, manual, updatedAt: text(data.updatedAt) || null };
  } catch {
    return fallback;
  }
}

/** 写入模式状态（原子替换），返回读回来的状态 */
export async function writeModelState(stateDir, next) {
  const { dir, stateFile } = modelPaths(stateDir);
  const payload = {
    mode: MODEL_MODES.includes(next?.mode) ? next.mode : 'follow',
    manual: normalizeManual(next?.manual),
    updatedAt: new Date().toISOString(),
  };
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, stateFile);
  return payload;
}

function normalizeManual(manual) {
  if (!manual || typeof manual !== 'object') return null;
  const provider = text(manual.provider);
  const model = text(manual.model);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    reasoningEffort: text(manual.reasoningEffort) || DEFAULT_REASONING_EFFORT,
  };
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 把桌面端补丁层切成「顶层条目块」。顶层条目以 `- ` 开头（行首无缩进），
 * 之后的缩进行都算这个块的内容。
 *
 * @param {string} source
 * @returns {Array<{head: string, lines: string[]}>}
 */
function splitTopLevelBlocks(source) {
  const lines = String(source || '').split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^-\s/.test(line)) {
      current = { head: line, lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

/** 找 `- id: xxx` 条目块；传入的块数组必须来自 splitTopLevelBlocks */
function findBlockByEntryId(blocks, id) {
  const pattern = new RegExp(`^-\\s+id:\\s*["']?${escapeRe(id)}["']?\\s*(?:#.*)?$`);
  return blocks.find((block) => pattern.test(block.head)) ?? null;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从块里抠出 `  config:` 之后、缩进更深的所有行（保留原缩进） */
function extractConfigLines(blockLines) {
  const start = blockLines.findIndex((line) => /^\s{2,}config:\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const configIndent = indentOf(blockLines[start]);
  const out = [];
  for (let i = start + 1; i < blockLines.length; i += 1) {
    const line = blockLines[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= configIndent) break;
    out.push(line);
  }
  // 去掉尾部的空行，避免生成块里堆空行
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

/**
 * 解析桌面端补丁层，抠出供应商清单与当前默认模型。
 *
 * @param {string} source 补丁层全文
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   providersBlock: string[],
 *   modelBlock: string[],
 *   model: {provider: string, model: string, reasoningEffort: string} | null,
 *   providers: Array<{id: string, models: string[]}>,
 * }}
 */
export function parseDesktopLayer(source) {
  const empty = {
    ok: false,
    reason: '',
    providersBlock: [],
    modelBlock: [],
    model: null,
    providers: [],
  };

  const blocks = splitTopLevelBlocks(source);
  const llmBlock = findBlockByEntryId(blocks, 'llm-pi-ai');
  const modelBlockEntry = findBlockByEntryId(blocks, 'agent-default-model');

  if (!llmBlock) return { ...empty, reason: '桌面端补丁层里找不到 llm-pi-ai 条目' };

  // providers: 在 llm-pi-ai 块里找 `    providers:`（缩进 2 以上即可），取其后更深缩进的行
  const provIdx = llmBlock.lines.findIndex((line) => /^\s{2,}providers:\s*(?:#.*)?$/.test(line));
  if (provIdx < 0) return { ...empty, reason: 'llm-pi-ai 里找不到 providers 段' };
  const provIndent = indentOf(llmBlock.lines[provIdx]);
  const providersBlock = [];
  for (let i = provIdx + 1; i < llmBlock.lines.length; i += 1) {
    const line = llmBlock.lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) <= provIndent) break;
    providersBlock.push(line);
  }
  if (providersBlock.length === 0) return { ...empty, reason: 'providers 段是空的' };

  const providers = parseProviders(providersBlock);

  let model = null;
  let modelBlock = [];
  if (modelBlockEntry) {
    modelBlock = extractConfigLines(modelBlockEntry.lines);
    model = parseModelConfig(modelBlock);
  }

  return {
    ok: true,
    reason: model ? '' : '桌面端补丁层里没有可解析的 agent-default-model，按基础 patch 兜底',
    providersBlock,
    modelBlock,
    model,
    providers,
  };
}

/** 从 providers 段里抓出 {provider: [model...]}，只用于控制台下拉框 */
function parseProviders(lines) {
  const providers = [];
  let current = null;
  // providers 段的直接子行缩进 = 第一行非空行的缩进；只有这个缩进才算「供应商名」
  // （下一层的 models: / apiKeyEnv: / reasoningEfforts: 等同缩进可能更深，必须排除）
  const firstNonBlank = lines.find((line) => line.trim() !== '');
  if (!firstNonBlank) return providers;
  const providerIndent = indentOf(firstNonBlank);

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);

    if (indent === providerIndent) {
      const providerMatch = /^([A-Za-z0-9_.\-@/]+):\s*(?:#.*)?$/.exec(line.slice(indent));
      if (providerMatch) {
        current = { id: providerMatch[1], models: [] };
        providers.push(current);
      }
      continue;
    }

    // 更深缩进：只认 `- id: xxx` 这种模型条目
    if (indent > providerIndent && current) {
      const modelMatch = /^-\s+id:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line.slice(indent));
      if (modelMatch) current.models.push(modelMatch[1]);
    }
  }
  return providers.filter((p) => p.models.length > 0);
}

/** 解析 `config:` 里的 provider / model / reasoningEffort 三个标量 */
function parseModelConfig(lines) {
  const out = { provider: '', model: '', reasoningEffort: '' };
  for (const line of lines) {
    const match = /^\s{2,}(provider|model|reasoningEffort):\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2];
  }
  if (!out.provider || !out.model) return null;
  if (!out.reasoningEffort) out.reasoningEffort = DEFAULT_REASONING_EFFORT;
  return out;
}

/* ------------------------------------------------------------------ 生成 */

/**
 * 生成 runtime patch 文本。
 *
 * @param {{providersBlock: string[], modelLines: string[]}} input
 * @returns {string}
 */
export function buildRuntimePatch({ providersBlock, modelLines }) {
  const lines = [
    '# 由 src/model-follow.js 自动生成，请勿手改（每次消息前按需重建）。',
    '# 作用：把桌面端 DSH 的供应商清单与当前模型叠加到 headless profile 之上。',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    ...providersBlock,
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    ...modelLines,
    '',
  ];
  return lines.join('\n');
}

/**
 * 计算本次消息要用的模型配置：按需（重新）生成 runtime patch。
 *
 * @param {{stateDir: string, basePatchPath?: string, homedir?: string, log?: object, force?: boolean}} opts
 * @returns {{
 *   patchPaths: string[],
 *   info: {
 *     mode: 'follow'|'manual',
 *     effective: {provider: string, model: string, reasoningEffort: string, source: 'follow'|'manual'|'base'} | null,
 *     desktop: {provider: string, model: string, reasoningEffort: string} | null,
 *     providers: Array<{id: string, models: string[]}>,
 *     runtimePatch: string | null,
 *     generatedAt: string | null,
 *     reason: string,
 *   },
 * }}
 */
export function resolveModelPlan({ stateDir, basePatchPath = '', homedir = os.homedir(), log, force = false } = {}) {
  const paths = modelPaths(stateDir);
  const store = readModelState(stateDir);
  const info = {
    mode: store.mode,
    effective: null,
    desktop: null,
    providers: [],
    runtimePatch: null,
    generatedAt: null,
    reason: '',
    basePatchPath,
  };

  let layerText = '';
  const layerPath = desktopProfileLayerPath(homedir);
  try {
    layerText = fs.readFileSync(layerPath, 'utf8');
  } catch (err) {
    info.reason = `读不到桌面端补丁层（${err?.message ?? err}），继续用基础 patch`;
    return { patchPaths: [], info };
  }

  let parsed = parseDesktopLayer(layerText);
  // 桌面端换模型的瞬间这个文件可能正在被重写，读到半截会解析失败。
  // 这里再读一次：两次内容不同就按新的算，多数情况下这一下就拿到完整文件了。
  // 仍然失败就退回基础 patch（机器人照常说话，只是这一轮模型不跟随）。
  if (!parsed.ok) {
    try {
      const again = fs.readFileSync(layerPath, 'utf8');
      if (again !== layerText) {
        layerText = again;
        parsed = parseDesktopLayer(layerText);
      }
    } catch {
      // 第二次也读不到就用第一次的结果走兜底
    }
  }
  info.providers = parsed.providers;
  info.desktop = parsed.model;
  if (!parsed.ok) {
    info.reason = parsed.reason;
    log?.warn?.(`模型跟随：${parsed.reason}，继续用基础 patch`);
    return { patchPaths: [], info };
  }

  // 手动模式优先；手动值不在供应商清单里也照用（用户可能知道自己在干什么），但记一条警告
  const manual = store.mode === 'manual' ? normalizeManual(store.manual) : null;
  const chosen = manual
    ? { ...manual, source: 'manual' }
    : parsed.model
      ? { ...parsed.model, source: 'follow' }
      : null;

  if (!chosen) {
    info.reason = '没有可用的目标模型（桌面端没有 agent-default-model，也没有手动指定）';
    return { patchPaths: [], info };
  }

  if (manual && !providerHasModel(parsed.providers, manual.provider, manual.model)) {
    log?.warn?.(`模型跟随：手动指定的 ${manual.provider}/${manual.model} 不在桌面端供应商清单里，已按原样写入`);
  }

  info.effective = chosen;

  // 生成模型块（手动模式用自己拼的三行；跟随模式原样搬运桌面端块）
  const modelLines = manual
    ? [
        `    provider: ${manual.provider}`,
        `    model: ${manual.model}`,
        `    reasoningEffort: ${manual.reasoningEffort}`,
      ]
    : parsed.modelBlock;

  const content = buildRuntimePatch({ providersBlock: parsed.providersBlock, modelLines });
  const fingerprint = crypto
    .createHash('sha1')
    .update(content)
    .digest('hex')
    .slice(0, 12);

  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    let upToDate = false;
    if (!force && fs.existsSync(paths.runtimePatch) && fs.existsSync(paths.metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(paths.metaFile, 'utf8'));
        upToDate = meta?.fingerprint === fingerprint && fs.statSync(paths.runtimePatch).size === Buffer.byteLength(content);
      } catch {
        upToDate = false;
      }
    }
    if (!upToDate) {
      const tmp = `${paths.runtimePatch}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, paths.runtimePatch);
      const meta = {
        fingerprint,
        generatedAt: new Date().toISOString(),
        mode: info.mode,
        effective: chosen,
        source: layerPath,
      };
      fs.writeFileSync(paths.metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
      log?.info?.(
        `模型配置已更新：${chosen.provider}/${chosen.model}（${info.mode === 'manual' ? '手动' : '跟随 DSH'}，effort=${chosen.reasoningEffort}）`,
      );
      info.generatedAt = meta.generatedAt;
    } else {
      try {
        info.generatedAt = JSON.parse(fs.readFileSync(paths.metaFile, 'utf8'))?.generatedAt ?? null;
      } catch {
        info.generatedAt = null;
      }
    }
    info.runtimePatch = paths.runtimePatch;
    return { patchPaths: [paths.runtimePatch], info };
  } catch (err) {
    info.reason = `写 runtime patch 失败（${err?.message ?? err}），继续用基础 patch`;
    log?.warn?.(`模型跟随：${info.reason}`);
    return { patchPaths: [], info };
  }
}

function providerHasModel(providers, providerId, modelId) {
  const provider = providers.find((p) => p.id === providerId);
  return Boolean(provider && provider.models.includes(modelId));
}

/**
 * 控制台用的完整快照：当前模式、手动值、桌面端模型、可选供应商、生效模型。
 * 会调用 resolveModelPlan（顺带按需重建 runtime patch）。
 */
export function describeModelState({ stateDir, basePatchPath = '', homedir = os.homedir(), log } = {}) {
  const store = readModelState(stateDir);
  const plan = resolveModelPlan({ stateDir, basePatchPath, homedir, log });
  return {
    mode: store.mode,
    manual: store.manual,
    updatedAt: store.updatedAt,
    desktop: plan.info.desktop,
    providers: plan.info.providers,
    effective: plan.info.effective,
    runtimePatch: plan.info.runtimePatch,
    generatedAt: plan.info.generatedAt,
    reason: plan.info.reason,
    desktopLayer: desktopProfileLayerPath(homedir),
  };
}
