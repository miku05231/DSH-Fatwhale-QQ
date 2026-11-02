// Isolated, tool-free DSH kernel for the AstrBot model RPC boundary.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildChatOnlyEntries, selectChatOnlyModelConfig } from './chat-only.js';
import { killProcessTree } from './dsh.js';

const HOST_SCRIPT = fileURLToPath(import.meta.url);
const HOST_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const FIXED_MODULES = new Set([
  'timer',
  'llm',
  'deepseek-llm-api-extensions',
  'authorization',
  'credentials',
  'deepseek-account',
  'llm-deepseek',
  'llm-deepseek-account',
  'llm-pi-ai',
]);

function hostError(code) {
  return Object.assign(new Error(code), { code });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw hostError(`ASTRBOT_HOST_${label}_INVALID`);
  return path.resolve(value);
}

function parseDataImage(url) {
  if (typeof url !== 'string' || url.length > MAX_INPUT_BYTES * 2) throw hostError('ASTRBOT_HOST_IMAGE_INVALID');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) throw hostError('ASTRBOT_HOST_IMAGE_INVALID');
  const bytes = Buffer.from(match[2], 'base64');
  const canonical = bytes.toString('base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024
    || (canonical !== match[2] && canonical.replace(/=+$/, '') !== match[2].replace(/=+$/, ''))) {
    throw hostError('ASTRBOT_HOST_IMAGE_INVALID');
  }
  return { type: 'image', mediaType: match[1].toLowerCase(), data: canonical };
}

function userParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
  return content.map((part) => {
    if (!plainObject(part)) throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'image_url') return parseDataImage(part.image_url?.url);
    throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
  });
}

function textParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
  return content.map((part) => {
    if (!plainObject(part) || part.type !== 'text' || typeof part.text !== 'string') {
      throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
    }
    return { type: 'text', text: part.text };
  });
}

function assistantParts(message, selection) {
  const content = textParts(message.content);
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
    for (const call of message.tool_calls) {
      const fn = call?.function;
      if (!plainObject(call) || call.type !== 'function' || typeof call.id !== 'string'
        || !plainObject(fn) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
        throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
      }
      content.push({ type: 'tool-call', id: call.id, name: fn.name, arguments: fn.arguments });
    }
  }
  return { content, source: { provider: selection.provider, model: selection.model } };
}

async function buildMessages(request, selection, attachments, llmModule) {
  const {
    createSystemMessage,
    createDeveloperMessage,
    createUserMessage,
    createAssistantMessage,
    createToolResultMessage,
  } = llmModule;
  const result = [];
  for (const message of request.messages) {
    if (!plainObject(message)) throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
    if (message.role === 'system') {
      const parts = textParts(message.content);
      result.push(createSystemMessage(parts.map((part) => part.text).join('')));
    } else if (message.role === 'developer') {
      result.push(createDeveloperMessage({ content: textParts(message.content), source: { kind: 'system-prompt' } }));
    } else if (message.role === 'user') {
      const parts = userParts(message.content);
      const admitted = parts.some((part) => part.type === 'image')
        ? await attachments.admitPromptContent(parts)
        : parts;
      result.push(createUserMessage({ content: admitted, source: { kind: 'user' } }));
    } else if (message.role === 'assistant') {
      result.push(createAssistantMessage(assistantParts(message, selection)));
    } else if (message.role === 'tool') {
      const content = textParts(message.content);
      result.push(createToolResultMessage({ callId: message.tool_call_id, content, isError: message.is_error === true }));
    } else {
      throw hostError('ASTRBOT_HOST_MESSAGE_INVALID');
    }
  }
  return result;
}

function dshTools(request) {
  if (request.toolChoice === 'none') return undefined;
  if (!Array.isArray(request.tools) || request.tools.length === 0) return undefined;
  return request.tools.map((tool) => {
    const fn = tool?.function;
    if (!plainObject(tool) || tool.type !== 'function' || !plainObject(fn)
      || typeof fn.name !== 'string' || typeof fn.description !== 'string' || !plainObject(fn.parameters)) {
      throw hostError('ASTRBOT_HOST_TOOLS_INVALID');
    }
    return { name: fn.name, description: fn.description, parameters: fn.parameters };
  });
}

function cleanChunk(chunk) {
  if (!plainObject(chunk) || typeof chunk.type !== 'string') throw hostError('ASTRBOT_HOST_STREAM_INVALID');
  if (chunk.type === 'block-start') {
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || !['text', 'reasoning', 'tool-call'].includes(chunk.blockType)) throw hostError('ASTRBOT_HOST_STREAM_INVALID');
    return { type: 'block-start', index: chunk.index, blockType: chunk.blockType };
  }
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || typeof chunk.text !== 'string') throw hostError('ASTRBOT_HOST_STREAM_INVALID');
    return { type: chunk.type, index: chunk.index, text: chunk.text };
  }
  if (chunk.type === 'tool-call-delta') {
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || typeof chunk.id !== 'string' || typeof chunk.argumentsDelta !== 'string') throw hostError('ASTRBOT_HOST_STREAM_INVALID');
    return { type: chunk.type, index: chunk.index, id: chunk.id, ...(typeof chunk.name === 'string' ? { name: chunk.name } : {}), argumentsDelta: chunk.argumentsDelta };
  }
  if (chunk.type === 'block-end') {
    const block = chunk.block;
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || !plainObject(block)) throw hostError('ASTRBOT_HOST_STREAM_INVALID');
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'block-end', index: chunk.index, block: { type: 'text', text: block.text } };
    if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string') {
      return { type: 'block-end', index: chunk.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } };
    }
    if (['reasoning', 'image', 'file', 'tool-addition', 'tool-removal'].includes(block.type)) {
      return { type: 'block-end', index: chunk.index, block: { type: block.type } };
    }
    throw hostError('ASTRBOT_HOST_STREAM_INVALID');
  }
  if (chunk.type === 'usage' && plainObject(chunk.usage)) {
    const usage = {};
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      if (Number.isFinite(chunk.usage[key]) && chunk.usage[key] >= 0) usage[key] = Math.floor(chunk.usage[key]);
    }
    return { type: 'usage', usage };
  }
  if (chunk.type === 'finish' && plainObject(chunk.reason)
    && ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(chunk.reason.kind)) {
    return { type: 'finish', reason: { kind: chunk.reason.kind } };
  }
  throw hostError('ASTRBOT_HOST_STREAM_INVALID');
}

async function readLayers(input, yaml) {
  if (!Array.isArray(input.patchPaths) || input.patchPaths.length > 64) throw hostError('ASTRBOT_HOST_PATCHES_INVALID');
  const schema = yaml.JSON_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: () => ({ __qqChatExpression: true }),
  })]);
  const layers = [];
  for (const filename of input.patchPaths) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw hostError('ASTRBOT_HOST_PATCHES_INVALID');
    const source = await fs.readFile(filename, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_PATCH_BYTES) throw hostError('ASTRBOT_HOST_PATCH_TOO_LARGE');
    try {
      layers.push(yaml.load(source, { schema, filename }));
    } catch (error) {
      const line = Number.isInteger(error?.mark?.line) ? `_${error.mark.line + 1}` : '';
      throw hostError(`ASTRBOT_HOST_PATCH_INVALID_${path.basename(filename).replace(/[^A-Za-z0-9_.-]/g, '_')}${line}`);
    }
  }
  return selectChatOnlyModelConfig(layers);
}

function validateHostRequest(input) {
  if (!plainObject(input) || !plainObject(input.selection) || !plainObject(input.request)) throw hostError('ASTRBOT_HOST_REQUEST_INVALID');
  const dshRoot = assertAbsolute(input.dshRoot, 'DSH_ROOT');
  const cwd = assertAbsolute(input.cwd, 'CWD');
  const dataRoot = assertAbsolute(input.dataRoot, 'DATA_ROOT');
  if (!Array.isArray(input.patchPaths) || input.patchPaths.length > 64) throw hostError('ASTRBOT_HOST_PATCHES_INVALID');
  const patchPaths = input.patchPaths.map((filename) => assertAbsolute(filename, 'PATCH_PATH'));
  const provider = input.selection.provider;
  const model = input.selection.model;
  if (typeof provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider)
    || typeof model !== 'string' || !model.trim() || model.length > 256) throw hostError('ASTRBOT_HOST_SELECTION_INVALID');
  if (!Array.isArray(input.request.messages) || input.request.messages.length === 0 || input.request.messages.length > 2000) {
    throw hostError('ASTRBOT_HOST_MESSAGES_INVALID');
  }
  if (!Array.isArray(input.request.tools) || !['auto', 'none'].includes(input.request.toolChoice)) throw hostError('ASTRBOT_HOST_TOOLS_INVALID');
  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  return { dshRoot, cwd, dataRoot, patchPaths, selection: { provider, model, ...(typeof input.selection.reasoningEffort === 'string' ? { reasoningEffort: input.selection.reasoningEffort } : {}) }, request: input.request, timeoutMs };
}

/** Boot the actual installed DSH kernel and return its native typed stream. */
export async function executeAstrbotModelHost(rawInput, { signal, createMockAdapter } = {}) {
  const input = validateHostRequest(rawInput);
  if (signal?.aborted) throw hostError('ASTRBOT_HOST_ABORTED');
  const requireDsh = createRequire(path.join(input.dshRoot, 'package.json'));
  const importDsh = (id) => import(pathToFileURL(requireDsh.resolve(id)).href);
  const yaml = requireDsh('js-yaml');
  const modelConfig = await readLayers(input, yaml);
  let entries = buildChatOnlyEntries({ dataRoot: input.dataRoot, modelConfig })
    .filter((entry) => FIXED_MODULES.has(entry.id));
  entries.push({ id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: input.dataRoot } });
  for (const entry of entries) entry.name = pathToFileURL(requireDsh.resolve(entry.name)).href;

  await fs.mkdir(input.dataRoot, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(input.dataRoot, '.runtime-'));
  let ctx;
  try {
    const configPath = path.join(tempRoot, 'cordis.json');
    await fs.writeFile(configPath, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
    const boot = await importDsh('@deepseek-ai/dsh-app-boot');
    const { DSH_LAUNCH_ENVIRONMENT_KEY } = await importDsh('@deepseek-ai/dsh-launch-environment');
    const environment = boot.loadLayeredEnv('qq-astrbot-model', input.cwd);
    ctx = await boot.boot('qq-astrbot-model', configPath, [], (hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    });
    await ctx.get('loader')?.await();
    const llm = ctx.get('llm');
    const attachments = ctx.get('attachments');
    if (!llm || typeof llm.stream !== 'function' || !attachments
      || typeof attachments.admitPromptContent !== 'function') throw hostError('ASTRBOT_HOST_CAPABILITY_MISSING');

    if (createMockAdapter) {
      const module = await importDsh('@deepseek-ai/dsh-llm');
      const adapter = await createMockAdapter({ ctx, llm, LlmAdapter: module.LlmAdapter, input });
      if (!adapter || typeof adapter.stream !== 'function') throw hostError('ASTRBOT_HOST_TEST_ADAPTER_INVALID');
      llm.registerAdapter([input.selection.provider], adapter);
    }

    const messages = await buildMessages(input.request, input.selection, attachments, await importDsh('@deepseek-ai/dsh-llm'));
    const options = {
      provider: input.selection.provider,
      model: input.selection.model,
      messages,
      ...(input.selection.reasoningEffort ? { reasoningEffort: input.selection.reasoningEffort } : {}),
      ...(input.request.tools.length && input.request.toolChoice !== 'none' ? { tools: dshTools(input.request) } : {}),
      ...(Number.isFinite(input.request.temperature) ? { temperature: input.request.temperature } : {}),
      ...(Number.isInteger(input.request.maxTokens) ? { maxTokens: input.request.maxTokens } : {}),
      ...(signal ? { signal } : {}),
      purpose: 'astrbot',
    };
    const chunks = [];
    for await (const chunk of llm.stream(options)) {
      if (signal?.aborted) throw hostError('ASTRBOT_HOST_ABORTED');
      chunks.push(cleanChunk(chunk));
      if (chunks.length > 100_000 || Buffer.byteLength(JSON.stringify(chunks), 'utf8') > MAX_OUTPUT_BYTES) {
        throw hostError('ASTRBOT_HOST_OUTPUT_TOO_LARGE');
      }
      if (chunk.type === 'finish') break;
    }
    return chunks;
  } finally {
    try { await ctx?.fiber?.dispose?.(); } catch { /* best-effort shutdown */ }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runAstrbotDshHost(input, { signal, log } = {}) {
  if (signal?.aborted) throw hostError('ASTRBOT_MODEL_ABORTED');
  const timeoutMs = Number.isInteger(input?.timeoutMs) && input.timeoutMs > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  let payload;
  try { payload = JSON.stringify(input); } catch { throw hostError('ASTRBOT_MODEL_REQUEST_INVALID'); }
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) throw hostError('ASTRBOT_MODEL_REQUEST_TOO_LARGE');
  return new Promise((resolve, reject) => {
    let settled = false;
    let result;
    let protocolError;
    let buffer = '';
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = spawn(process.execPath, [HOST_SCRIPT], { cwd: input.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(hostError('ASTRBOT_MODEL_HOST_START_FAILED'));
      return;
    }
    let timer;
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clean();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => {
      killProcessTree(child, log);
      finish(hostError('ASTRBOT_MODEL_ABORTED'));
    };
    timer = setTimeout(() => {
      killProcessTree(child, log);
      finish(hostError('ASTRBOT_MODEL_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part) => {
      buffer += part;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_OUTPUT_BYTES + 1024) {
        protocolError = 'ASTRBOT_MODEL_PROTOCOL_INVALID';
        killProcessTree(child, log);
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (result !== undefined || protocolError) {
          protocolError = 'ASTRBOT_MODEL_PROTOCOL_INVALID';
          continue;
        }
        let message;
        try { message = JSON.parse(line); } catch { protocolError = 'ASTRBOT_MODEL_PROTOCOL_INVALID'; continue; }
        if (message?.ok === true && Array.isArray(message.chunks)) result = message.chunks;
        else if (message?.ok === false && typeof message.code === 'string' && /^ASTRBOT_/.test(message.code)) protocolError = message.code;
        else protocolError = 'ASTRBOT_MODEL_PROTOCOL_INVALID';
      }
    });
    child.stderr.resume();
    child.on('error', () => finish(hostError('ASTRBOT_MODEL_HOST_START_FAILED')));
    child.on('close', (code) => {
      if (protocolError) finish(hostError(protocolError));
      else if (code !== 0 || result === undefined) finish(hostError('ASTRBOT_MODEL_HOST_FAILED'));
      else finish();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function main() {
  process.stdout.write = () => true;
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk.toString('utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) throw hostError('ASTRBOT_HOST_INPUT_TOO_LARGE');
  }
  let chunks;
  try {
    chunks = await executeAstrbotModelHost(JSON.parse(source));
  } catch (error) {
    const code = /^ASTRBOT_/.test(String(error?.code || '')) ? error.code : 'ASTRBOT_HOST_FAILED';
    HOST_STDOUT_WRITE(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
    return;
  }
  HOST_STDOUT_WRITE(`${JSON.stringify({ ok: true, chunks })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === HOST_SCRIPT) {
  main().catch(() => {
    HOST_STDOUT_WRITE(`${JSON.stringify({ ok: false, code: 'ASTRBOT_HOST_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
