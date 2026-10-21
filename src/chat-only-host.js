// One-shot, tool-free DSH kernel. Never boot a user profile or user plugins.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildChatOnlyEntries, installChatOnlyPolicy, isChatOnlySessionId, selectChatOnlyModelConfig } from './chat-only.js';
import { redactSecrets } from './redact.js';

const rawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
const send = (event) => rawWrite(`${JSON.stringify(event)}\n`);
let ctx;
let handle;
let tempRoot;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 8 * 1024 * 1024) throw new Error('Chat-only request is too large.');
  }
  const request = JSON.parse(input);
  if (!path.isAbsolute(request.dshRoot || '') || !path.isAbsolute(request.dataRoot || '') || !path.isAbsolute(request.cwd || '')) {
    throw new Error('Chat-only runtime paths must be absolute.');
  }
  if (typeof request.text !== 'string' || !request.text.trim()) throw new Error('Chat-only task text cannot be empty.');
  if (request.sessionId && !isChatOnlySessionId(request.sessionId)) throw new Error('Chat-only runtime refuses a computer-agent session.');
  const requireDsh = createRequire(path.join(request.dshRoot, 'package.json'));
  const importDsh = (id) => import(pathToFileURL(requireDsh.resolve(id)).href);
  const yaml = requireDsh('js-yaml');
  // Parse model settings structurally. User JavaScript expressions are data,
  // never evaluated or mounted as plugin configuration.
  const schema = yaml.JSON_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: () => ({ __qqChatExpression: true }),
  })]);
  const layers = [];
  for (const filename of request.patchPaths || []) {
    const source = await fs.readFile(filename, 'utf8');
    if (source.length > 4 * 1024 * 1024) throw new Error('Chat-only model settings are too large.');
    try {
      layers.push(yaml.load(source, { schema, filename }));
    } catch (error) {
      // YAML parser diagnostics include source snippets, which can contain
      // provider secrets. Report only a location to QQ.
      const line = Number.isInteger(error?.mark?.line) ? `, line ${error.mark.line + 1}` : '';
      throw new Error(`Chat-only model settings are invalid (${path.basename(filename)}${line}).`);
    }
  }
  const modelConfig = selectChatOnlyModelConfig(layers);
  if (request.model) {
    const { provider, model, reasoningEffort } = request.model;
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
      throw new Error('Chat-only model selection is invalid.');
    }
    modelConfig['agent-default-model'] = {
      provider, model, ...(typeof reasoningEffort === 'string' && reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  const entries = buildChatOnlyEntries({ dataRoot: request.dataRoot, modelConfig });
  // Use absolute, installation-owned entry points. A workspace node_modules
  // directory cannot substitute a plugin for one of the fixed kernel modules.
  for (const entry of entries) entry.name = pathToFileURL(requireDsh.resolve(entry.name)).href;
  await fs.mkdir(request.dataRoot, { recursive: true });
  tempRoot = await fs.mkdtemp(path.join(request.dataRoot, '.runtime-'));
  const configPath = path.join(tempRoot, 'cordis.json');
  await fs.writeFile(configPath, JSON.stringify(entries), { mode: 0o600 });
  const boot = await importDsh('@deepseek-ai/dsh-app-boot');
  const { DSH_LAUNCH_ENVIRONMENT_KEY } = await importDsh('@deepseek-ai/dsh-launch-environment');
  const environment = boot.loadLayeredEnv('qq-chat-only', request.cwd);
  ctx = await boot.boot('qq-chat-only', configPath, [], (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  });
  await ctx.get('loader')?.await();
  const setup = installChatOnlyPolicy(ctx);
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const selection = ctx.get('agentDefaultModel')?.currentSelection();
  const { createUserMessage, installModelSelection } = {
    ...(await importDsh('@deepseek-ai/dsh-llm')),
    ...(await importDsh('@deepseek-ai/dsh-agent')),
  };
  if (!agents || !sessions || !selection?.provider || !selection?.model
    || typeof createUserMessage !== 'function' || typeof installModelSelection !== 'function') {
    throw new Error('This DSH version cannot start a chat-only session.');
  }
  const compose = (agentCtx) => {
    setup(agentCtx);
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
  };
  const agentOptions = { provider: selection.provider, model: selection.model };
  const sessionId = request.sessionId || `qq-chat-${randomUUID()}`;
  handle = request.sessionId
    ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: compose })
    : await agents.create({ sessionId, meta: { cwd: request.cwd }, agentOptions, setup: compose });
  const agent = handle.agent;
  if (!agent || agent.session?.id !== sessionId || agent.session.header?.cwd !== request.cwd) {
    throw new Error('Chat-only session ownership or working directory does not match.');
  }
  if (ctx.get('tools').schemas(agent).length !== 0) throw new Error('Chat-only agent unexpectedly inherited tools.');
  send({ type: 'session', sessionId });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({ content: [{ type: 'text', text: request.text }], source: { kind: 'user' } }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  let text = '';
  let end;
  for (let seq = firstSeq; seq < agent.session.seq; seq += 1) {
    const event = agent.session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      const value = (event.data?.message?.content || [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('');
      if (value.trim()) text = value;
    }
    if (event?.type === 'turn/end') end = event.data?.reason;
  }
  if (end?.kind !== 'completed') {
    const detail = end?.error?.message || end?.error?.code || end?.kind || 'unknown';
    throw new Error(`Chat-only turn failed: ${detail}`);
  }
  if (!text.trim()) throw new Error('Chat-only model returned no chat text.');
  send({ type: 'final', text });
}

try {
  await main();
} catch (error) {
  send({ type: 'error', message: redactSecrets(error?.message || String(error)) });
  process.exitCode = 1;
} finally {
  try { await handle?.dispose?.(); } catch { process.exitCode = 1; }
  try { await ctx?.fiber?.dispose?.(); } catch { process.exitCode = 1; }
  if (tempRoot) {
    try { await fs.rm(tempRoot, { recursive: true, force: true }); } catch {}
  }
}
