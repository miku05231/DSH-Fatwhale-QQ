// Raw OpenAI-compatible model boundary for AstrBot. Python supplies messages
// and tool declarations only; trusted DSH state supplies provider routing.
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_MESSAGES = 2000;
const MAX_TOOLS = 128;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(message, code = 'ASTRBOT_MODEL_INVALID_REQUEST') {
  return Object.assign(new Error(message), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function boundedString(value, label, max = 2 * 1024 * 1024) {
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} is invalid or too large.`);
  return value;
}

function copyJson(value, label, depth = 0, seen = new Set(), counter = { nodes: 0 }) {
  counter.nodes += 1;
  if (counter.nodes > 100_000 || depth > 32) throw fail(`${label} is too complex.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw fail(`${label} must contain JSON values only.`);
  if (!Array.isArray(value) && !object(value)) throw fail(`${label} must contain JSON values only.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => copyJson(item, label, depth + 1, seen, counter));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', '__jsExpr', '__qqChatExpression'].includes(key)) {
        throw fail(`${label} contains a reserved key.`);
      }
      result[key] = copyJson(item, label, depth + 1, seen, counter);
    }
  }
  seen.delete(value);
  return result;
}

function imageUrlPart(part) {
  const url = part?.image_url?.url;
  if (typeof url !== 'string' || url.length > MAX_IMAGE_BYTES * 2) {
    throw fail('Only bounded inline image data URLs are supported.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) throw fail('Only PNG, JPEG, WebP, and GIF data URLs are supported.');
  const encoded = match[2];
  const data = Buffer.from(encoded, 'base64');
  const canonical = data.toString('base64');
  if ((canonical !== encoded && canonical.replace(/=+$/, '') !== encoded.replace(/=+$/, ''))
    || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw fail('Inline image data is invalid or too large.');
  }
  const mediaType = match[1].toLowerCase();
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data.toString('base64')}` } };
}

function normalizeContent(content, label, { allowImages = false } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content == null) return '';
    throw fail(`${label} must be text or an array of content parts.`);
  }
  if (content.length > 4096) throw fail(`${label} has too many content parts.`);
  return content.map((part) => {
    if (!object(part)) throw fail(`${label} contains an invalid content part.`);
    if (part.type === 'text') return { type: 'text', text: boundedString(part.text, `${label} text`) };
    if (part.type === 'image_url' && allowImages) return imageUrlPart(part);
    throw fail(`${label} contains an unsupported content part.`);
  });
}

function normalizeToolCalls(calls, label) {
  if (!Array.isArray(calls) || calls.length > MAX_TOOLS) throw fail(`${label} is invalid.`);
  return calls.map((call) => {
    const fn = call?.function;
    if (!object(call) || call.type !== 'function' || !object(fn)) throw fail(`${label} contains an invalid function call.`);
    const id = boundedString(call.id, 'Tool call id', 256);
    const name = boundedString(fn.name, 'Tool call name', 128);
    const args = boundedString(fn.arguments, 'Tool call arguments', 1024 * 1024);
    if (!id || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(name)) throw fail(`${label} contains an invalid function call.`);
    return { id, type: 'function', function: { name, arguments: args } };
  });
}

function normalizeTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) throw fail('Tools must be an array of function declarations.');
  const names = new Set();
  return tools.map((tool) => {
    const fn = tool?.function;
    if (!object(tool) || tool.type !== 'function' || !object(fn)) throw fail('Tool schema is invalid.');
    const name = boundedString(fn.name, 'Tool name', 128);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || names.has(name)) throw fail('Tool name is invalid or duplicated.');
    names.add(name);
    const description = fn.description === undefined ? '' : boundedString(fn.description, 'Tool description', 16_384);
    const parameters = fn.parameters === undefined
      ? { type: 'object', properties: {} }
      : copyJson(fn.parameters, 'Tool parameters');
    if (!object(parameters) || (parameters.type !== undefined && parameters.type !== 'object')) {
      throw fail('Function parameters must be a JSON object schema.');
    }
    return { type: 'function', function: { name, description, parameters } };
  });
}

function normalizeToolChoice(choice) {
  if (choice === undefined || choice === null || choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  throw fail('DSH supports only tool_choice "auto" or "none".', 'ASTRBOT_TOOL_CHOICE_UNSUPPORTED');
}

/** Validate and copy only the OpenAI request fields accepted by this bridge. */
export function normalizeAstrbotRequest(request) {
  if (!object(request) || !Array.isArray(request.messages) || request.messages.length === 0
    || request.messages.length > MAX_MESSAGES) throw fail('Request messages are invalid.');
  const messages = request.messages.map((message) => {
    if (!object(message)) throw fail('Request contains an invalid message.');
    const role = message.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) throw fail('Request contains an unsupported message role.');
    const normalized = { role };
    normalized.content = normalizeContent(message.content, `${role} content`, { allowImages: role === 'user' });
    if (role === 'assistant' && message.tool_calls !== undefined) normalized.tool_calls = normalizeToolCalls(message.tool_calls, 'Assistant tool calls');
    if (role === 'tool') {
      normalized.tool_call_id = boundedString(message.tool_call_id, 'Tool result id', 256);
      normalized.is_error = message.is_error === true;
      if (!normalized.tool_call_id) throw fail('Tool result id is required.');
    }
    return normalized;
  });
  const tools = normalizeTools(request.tools);
  const toolChoice = normalizeToolChoice(request.tool_choice);
  let temperature;
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
      throw fail('Temperature must be a number from 0 to 2.');
    }
    temperature = request.temperature;
  }
  let maxTokens;
  if (request.max_tokens !== undefined) {
    if (!Number.isInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > 1_000_000) {
      throw fail('max_tokens must be a positive integer.');
    }
    maxTokens = request.max_tokens;
  }
  const result = { messages, tools, toolChoice };
  if (temperature !== undefined) result.temperature = temperature;
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REQUEST_BYTES) throw fail('Request is too large.');
  return result;
}

function trustedSelection(plan) {
  const selected = plan?.model;
  const provider = selected?.provider;
  const model = selected?.model;
  if (typeof provider !== 'string' || !ROUTE_ID.test(provider)
    || typeof model !== 'string' || !model.trim() || model.length > 256) {
    throw fail('No valid current DSH model is selected.', 'ASTRBOT_MODEL_NOT_CONFIGURED');
  }
  const result = { provider, model };
  if (typeof selected.reasoningEffort === 'string' && selected.reasoningEffort.length <= 64) {
    result.reasoningEffort = selected.reasoningEffort;
  }
  return result;
}

function usageToOpenAI(usage) {
  if (!object(usage)) return undefined;
  const count = (key) => Number.isFinite(usage[key]) && usage[key] >= 0 ? Math.floor(usage[key]) : 0;
  const promptTokens = count('inputTokens') + count('cacheReadTokens') + count('cacheWriteTokens');
  const completionTokens = count('outputTokens');
  const totalTokens = Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0
    ? Math.floor(usage.totalTokens) : promptTokens + completionTokens;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
}

/** Convert native DSH typed chunks without parsing model text or tool arguments. */
export function convertDshChunks(chunks, model) {
  if (!Array.isArray(chunks)) throw fail('DSH returned an invalid stream.', 'ASTRBOT_MODEL_STREAM_INVALID');
  const blocks = new Map();
  let usage;
  let finish;
  let finished = false;
  for (const chunk of chunks) {
    if (!object(chunk) || typeof chunk.type !== 'string') throw fail('DSH returned an invalid stream chunk.', 'ASTRBOT_MODEL_STREAM_INVALID');
    if (finished) throw fail('DSH returned data after stream finish.', 'ASTRBOT_MODEL_STREAM_INVALID');
    if (chunk.type === 'usage') {
      usage = chunk.usage;
      continue;
    }
    if (chunk.type === 'finish') {
      finish = chunk.reason?.kind;
      finished = true;
      continue;
    }
    if (chunk.type === 'block-start') {
      if (!Number.isInteger(chunk.index) || chunk.index < 0 || !['text', 'reasoning', 'tool-call'].includes(chunk.blockType)) {
        throw fail('DSH returned an invalid block.', 'ASTRBOT_MODEL_STREAM_INVALID');
      }
      const block = blocks.get(chunk.index) || { index: chunk.index, text: '', args: '', type: chunk.blockType };
      block.type = chunk.blockType;
      blocks.set(chunk.index, block);
      continue;
    }
    if (!Number.isInteger(chunk.index) || chunk.index < 0) throw fail('DSH returned an invalid block index.', 'ASTRBOT_MODEL_STREAM_INVALID');
    const block = blocks.get(chunk.index) || { index: chunk.index, text: '', args: '', type: null };
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      block.type = 'text';
      block.text += chunk.text;
    } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      block.type = 'reasoning';
    } else if (chunk.type === 'tool-call-delta' && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string') {
      block.type = 'tool-call';
      block.id = chunk.id;
      if (typeof chunk.name === 'string' && chunk.name) block.name = chunk.name;
      block.args += chunk.argumentsDelta;
    } else if (chunk.type === 'block-end' && object(chunk.block)) {
      block.complete = chunk.block;
      block.type = chunk.block.type;
    } else {
      throw fail('DSH returned an unsupported stream chunk.', 'ASTRBOT_MODEL_STREAM_INVALID');
    }
    blocks.set(chunk.index, block);
  }
  if (!finished) throw fail('DSH stream did not finish.', 'ASTRBOT_MODEL_STREAM_INVALID');
  if (finish === 'aborted') throw fail('DSH model request was cancelled.', 'ASTRBOT_MODEL_ABORTED');
  if (finish === 'error') throw fail('DSH model request failed.', 'ASTRBOT_MODEL_FAILED');
  if (!['stop', 'tool-calls', 'max-tokens'].includes(finish)) throw fail('DSH returned an unknown finish reason.', 'ASTRBOT_MODEL_STREAM_INVALID');

  let content = '';
  const toolCalls = [];
  for (const block of [...blocks.values()].sort((a, b) => a.index - b.index)) {
    const complete = block.complete;
    if (block.type === 'text') {
      const text = complete?.type === 'text' && typeof complete.text === 'string' ? complete.text : block.text;
      content += text;
    } else if (block.type === 'tool-call') {
      const id = complete?.type === 'tool-call' ? complete.id : block.id;
      const name = complete?.type === 'tool-call' ? complete.name : block.name;
      const args = complete?.type === 'tool-call' ? complete.arguments : block.args;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
        throw fail('DSH returned an incomplete tool call.', 'ASTRBOT_MODEL_STREAM_INVALID');
      }
      toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
    }
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_BYTES || Buffer.byteLength(JSON.stringify(toolCalls), 'utf8') > MAX_RESPONSE_BYTES) {
    throw fail('DSH response is too large.', 'ASTRBOT_MODEL_STREAM_INVALID');
  }
  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const result = {
    id: `dsh-${Date.now().toString(36)}`,
    choices: [{ message, finish_reason: finish === 'tool-calls' ? 'tool_calls' : finish === 'max-tokens' ? 'length' : 'stop' }],
  };
  const convertedUsage = usageToOpenAI(usage);
  if (convertedUsage) result.usage = convertedUsage;
  if (typeof model === 'string' && model) result.model = model;
  return result;
}

async function collectChunks(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of result) {
      chunks.push(chunk);
      if (chunks.length > 100_000) throw fail('DSH stream has too many chunks.', 'ASTRBOT_MODEL_STREAM_INVALID');
    }
    return chunks;
  }
  throw fail('DSH model runner returned an invalid stream.', 'ASTRBOT_MODEL_STREAM_INVALID');
}

function abortError() {
  return fail('DSH model request was cancelled.', 'ASTRBOT_MODEL_ABORTED');
}

async function runAbortable(runModel, input, options) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError();
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => runModel(input, { signal, log: options.log }));
    return await (aborted ? Promise.race([pending, aborted]) : pending);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Build an OpenAI-compatible provider backed by DSH's structured LLM stream.
 * `modelPlan` is the only routing authority; request.model/provider/url/key fields
 * are deliberately ignored.
 */
export function createAstrbotModelProvider({
  readConfig,
  modelPlan = () => ({}),
  cwd,
  projectRoot,
  stateDir,
  patchPath,
  log,
  runModel,
} = {}) {
  if (typeof readConfig !== 'function') throw new TypeError('createAstrbotModelProvider requires readConfig().');
  if (typeof modelPlan !== 'function' || (runModel !== undefined && typeof runModel !== 'function')) throw new TypeError('modelPlan and runModel must be functions.');

  return async (request, { signal } = {}) => {
    if (signal?.aborted) throw abortError();
    const normalized = normalizeAstrbotRequest(request);
    const cfg = await readConfig();
    const plan = modelPlan() || {};
    const selection = trustedSelection(plan);
    const workDir = path.resolve(cwd || cfg?.dsh?.cwd || process.cwd());
    const root = path.resolve(projectRoot || workDir);
    const dataDir = path.resolve(stateDir || path.join(root, 'state'), 'astrbot-model');
    let dshRoot;
    let patchPaths;
    try {
      const [{ resolveDshInstallRoot }, { chatOnlyModelPatchPaths }] = await Promise.all([
        import('./dsh-desktop.js'), import('./chat-only.js'),
      ]);
      dshRoot = resolveDshInstallRoot(String(cfg?.dsh?.command || 'dsh'), workDir);
      patchPaths = chatOnlyModelPatchPaths({
        cfg,
        cwd: workDir,
        projectRoot: root,
        patchPath,
        extraPatchPaths: plan.extraPatchPaths,
      });
    } catch {
      throw fail('Unable to prepare the current DSH model configuration.', 'ASTRBOT_MODEL_CONFIG_UNAVAILABLE');
    }
    const configuredTimeout = Number(cfg?.dsh?.timeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(configuredTimeout))) : DEFAULT_TIMEOUT_MS;
    const input = {
      dshRoot,
      cwd: workDir,
      dataRoot: dataDir,
      patchPaths,
      selection,
      request: normalized,
      timeoutMs,
    };
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_REQUEST_BYTES) throw fail('Request is too large.');
    const runner = runModel || (await import('./astrbot-model-host.mjs')).runAstrbotDshHost;
    const chunks = await runAbortable(runner, input, { signal, log });
    if (signal?.aborted) throw abortError();
    return convertDshChunks(await collectChunks(chunks), selection.model);
  };
}
