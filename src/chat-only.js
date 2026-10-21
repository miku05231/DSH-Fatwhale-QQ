// A separate DSH runtime for QQ users who may chat but may not use this PC.
// The child loads a fixed kernel; user patches supply model data only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveDshInstallRoot } from './dsh-desktop.js';
import { killProcessTree, resolvePatchChain } from './dsh.js';
import { redactSecrets } from './redact.js';

const HOST_SCRIPT = fileURLToPath(new URL('./chat-only-host.js', import.meta.url));
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
export const CHAT_ONLY_SESSION_PREFIX = 'qq-chat-';
export const CHAT_ONLY_DENIAL = 'Only configured QQ administrators may use computer tools.';

export const CHAT_ONLY_MODULES = Object.freeze({
  timer: '@deepseek-ai/cordis-plugin-timer',
  llm: '@deepseek-ai/dsh-llm',
  'deepseek-llm-api-extensions': '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  session: '@deepseek-ai/dsh-session',
  'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
  'session-projection': '@deepseek-ai/dsh-session-projection',
  agent: '@deepseek-ai/dsh-agent',
  'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
  authorization: '@deepseek-ai/dsh-authorization',
  credentials: '@deepseek-ai/dsh-credentials-local',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
  'llm-deepseek': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
  'session-persistence-jsonl': '@deepseek-ai/dsh-session-persistence-jsonl',
  tools: '@deepseek-ai/dsh-tools',
  'system-prompt': '@deepseek-ai/dsh-system-prompt',
  'agent-loop': '@deepseek-ai/dsh-agent-loop',
});

const MODEL_ENTRY_IDS = new Set([
  'agent-default-model', 'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function copyLiteral(value, stack = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || stack.has(value)) throw new Error('Chat-only model settings must be literal JSON values.');
  if (Object.hasOwn(value, '__qqChatExpression') || Object.hasOwn(value, '__jsExpr')) {
    throw new Error('Chat-only model settings cannot evaluate !!js expressions.');
  }
  if (!Array.isArray(value) && !plainObject(value)) throw new Error('Chat-only model settings must be literal JSON values.');
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => copyLiteral(item, stack));
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyLiteral(item, stack)]));
  }
  stack.delete(value);
  return result;
}

/** Pick config data, never module names, expressions, hooks, or plugin rows. */
export function selectChatOnlyModelConfig(layers) {
  const selected = {};
  const visit = (row) => {
    if (!plainObject(row)) return;
    if (Array.isArray(row.insert)) for (const inserted of row.insert) visit(inserted);
    if (!MODEL_ENTRY_IDS.has(row.id) || !Object.hasOwn(row, 'config')) return;
    // Validate the winning value after applying all layers; a later safe model
    // configuration may replace an earlier expression-based default.
    selected[row.id] = row.config;
  };
  for (const layer of layers) {
    if (!Array.isArray(layer)) throw new Error('Chat-only model patch must contain a top-level array.');
    for (const row of layer) visit(row);
  }
  return Object.fromEntries(Object.entries(selected).map(([id, config]) => {
    if (!plainObject(config)) throw new Error(`Chat-only model config "${id}" must be an object.`);
    return [id, copyLiteral(config)];
  }));
}

export function isChatOnlySessionId(value) {
  return typeof value === 'string'
    && /^qq-chat-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

/** The executable module list is closed even when a patch replaces a row name. */
export function buildChatOnlyEntries({ dataRoot, modelConfig = {} } = {}) {
  if (!path.isAbsolute(String(dataRoot ?? ''))) throw new Error('Chat-only dataRoot must be absolute.');
  const settings = selectChatOnlyModelConfig([Object.entries(modelConfig).map(([id, config]) => ({ id, config }))]);
  const configs = {
    'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-flash' },
    credentials: { watch: false },
    'deepseek-account': { desktopPlatform: null },
    'session-persistence-jsonl': { root: path.join(dataRoot, 'sessions'), compression: 'none' },
    tools: { mode: 'native' },
    'system-prompt': {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: 'You are a helpful chat assistant. Only configured QQ administrators may operate the computer. '
        + 'This conversation has no tools, local files, computer actions, or file attachments. '
        + 'For such requests, explain that administrator authorization is required.',
    },
    'agent-loop': { agents: [] },
    ...settings,
  };
  return Object.entries(CHAT_ONLY_MODULES).map(([id, name]) => ({
    id, name, ...(configs[id] ? { config: configs[id] } : {}),
  }));
}

/** Fail closed if a DSH version does not expose the monotonic tool boundary. */
export function installChatOnlyPolicy(ctx) {
  const tools = ctx?.get?.('tools');
  if (!tools || typeof tools.guard !== 'function' || typeof tools.schemas !== 'function') {
    throw new Error('This DSH version cannot enforce the chat-only tool policy.');
  }
  if (tools.schemas().length !== 0) throw new Error('Chat-only runtime unexpectedly registered tools.');
  tools.guard(() => CHAT_ONLY_DENIAL);
  return (agentCtx) => {
    const scoped = agentCtx.get('tools');
    if (!scoped || typeof scoped.presentAs !== 'function' || typeof scoped.restrict !== 'function') {
      throw new Error('This DSH version cannot enforce the scoped chat-only tool policy.');
    }
    scoped.presentAs('native');
    scoped.restrict({ allow: [] });
    scoped.guard(() => CHAT_ONLY_DENIAL);
  };
}

export function chatOnlyModelPatchPaths({ cfg, cwd, projectRoot, patchPath, extraPatchPaths } = {}) {
  const workDir = path.resolve(cwd || cfg?.dsh?.cwd || process.cwd());
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
  const profile = String(cfg?.dsh?.profile || 'headless');
  const sources = [];
  const profileLayer = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  if (fs.existsSync(profileLayer)) sources.push(profileLayer);
  const homeLayer = path.join(home, 'cordis.patch.yml');
  if (fs.existsSync(homeLayer)) sources.push(homeLayer);
  const chain = resolvePatchChain({ patchPath, dshCfg: cfg?.dsh, projectRoot, workDir, extraPatchPaths });
  if (!chain.ok) throw new Error(chain.error);
  sources.push(...chain.patches);
  return [...new Set(sources)];
}

/** No fallback: a failure here must never hand an unprivileged task to an agent. */
export async function runChatOnlyDsh(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Chat-only task text cannot be empty.');
  if (!options.cfg?.dsh) throw new Error('Chat-only runtime requires cfg.dsh.');
  if (options.signal?.aborted) throw new Error('DSH 调用已取消');
  if (options.sessionId && !isChatOnlySessionId(options.sessionId)) {
    throw new Error('Chat-only runtime refuses a computer-agent session.');
  }
  const cwd = path.resolve(options.cwd || options.cfg.dsh.cwd || process.cwd());
  const stateDir = path.resolve(options.stateDir || path.join(options.projectRoot || cwd, 'state'));
  const dshRoot = resolveDshInstallRoot(options.cfg.dsh.command || 'dsh', cwd);
  const patchPaths = chatOnlyModelPatchPaths({ ...options, cwd });
  const timeoutMs = Number(options.timeoutMs || options.cfg.dsh.timeoutMs) > 0
    ? Number(options.timeoutMs || options.cfg.dsh.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const request = {
    dshRoot, cwd, dataRoot: path.join(stateDir, 'chat-only'), patchPaths,
    text, sessionId: options.sessionId || null, model: options.model || null,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionId = request.sessionId;
    let finalText = null;
    let stderr = '';
    let protocolError = '';
    const events = [];
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, [HOST_SCRIPT], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        error.sessionId = sessionId;
        error.chatOnly = true;
        reject(error);
      } else resolve({ sessionId, finalText, events });
    };
    const onAbort = () => {
      killProcessTree(child, options.log);
      finish(Object.assign(new Error('DSH 调用已取消'), { aborted: true }));
    };
    timer = setTimeout(() => {
      killProcessTree(child, options.log);
      finish(Object.assign(new Error(`DSH 普通聊天超时（${timeoutMs}ms）`), { timedOut: true }));
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > MAX_LINE_CHARS) {
        protocolError = 'Chat-only runtime returned an oversized event.';
        killProcessTree(child, options.log);
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'session' && isChatOnlySessionId(event.sessionId)) {
        sessionId = event.sessionId;
        events.push(event);
      } else if (event.type === 'final' && typeof event.text === 'string') {
        finalText = event.text;
        events.push(event);
      } else if (event.type === 'error') {
        protocolError = redactSecrets(String(event.message || 'Chat-only runtime failed.'));
      }
    });
    child.on('error', (error) => finish(new Error(`DSH 普通聊天无法启动：${redactSecrets(error.message)}`)));
    child.on('close', (code) => {
      if (protocolError || code !== 0 || finalText === null || !isChatOnlySessionId(sessionId)) {
        finish(new Error(protocolError || `DSH 普通聊天失败：${redactSecrets(stderr.trim()).slice(-500) || `exit ${code}`}`));
      } else finish();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    options.log?.info?.('DSH 普通聊天：独立会话，电脑工具已禁用');
  });
}
