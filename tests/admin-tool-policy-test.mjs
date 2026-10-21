// Closed chat kernel tests. Integration uses a local fake model and a fresh
// DSH home, never a user's sessions, credentials, desktop, or companion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  CHAT_ONLY_MODULES, CHAT_ONLY_DENIAL, buildChatOnlyEntries,
  selectChatOnlyModelConfig, isChatOnlySessionId, installChatOnlyPolicy, runChatOnlyDsh,
} from '../src/chat-only.js';
import { resolveDshInstallRoot } from '../src/dsh-desktop.js';
import { PluginHost } from '../src/plugins.js';

let passed = 0;
function ok(label, run) {
  run();
  passed += 1;
  console.log(`  ok ${label}`);
}
async function asyncOk(label, run) {
  await run();
  passed += 1;
  console.log(`  ok ${label}`);
}
async function assertNextPluginDoesNotRun(hook, ctx, revoke, expected) {
  const host = new PluginHost();
  const calls = [];
  let markEntered;
  let release;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const suspended = new Promise((resolve) => { release = resolve; });
  host.registry.set('first', {
    meta: { name: 'first', defaultEnabled: true },
    hooks: { [hook]: async () => {
      calls.push('first');
      markEntered();
      await suspended;
      return { text: 'prepared response' };
    } },
  });
  host.registry.set('later', {
    meta: { name: 'later', defaultEnabled: true },
    hooks: { [hook]: async () => { calls.push('later'); } },
  });
  const pending = hook === 'afterReply'
    ? host.runAfterReply({ text: 'hello', ...ctx })
    : host.runMessageHook(hook, { text: 'hello', ...ctx });
  await entered;
  revoke();
  release();
  await assert.rejects(pending, expected);
  assert.deepEqual(calls, ['first']);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chat-policy-'));
try {
  const entries = buildChatOnlyEntries({ dataRoot: path.join(tmp, 'data') });
  ok('the kernel has a fixed module allowlist and no executable user extensions', () => {
    assert.equal(entries.length, Object.keys(CHAT_ONLY_MODULES).length);
    assert(!entries.some((entry) => /(?:tool-(?!s\b)|hooks|plugin-manager|skill|subprocess|bash|pwsh|mcp|web-app|job|subagent)/.test(entry.name)));
    assert(entries.every((entry) => entry.name === CHAT_ONLY_MODULES[entry.id]));
  });
  ok('tool presentation is native and the kernel creates no startup agents', () => {
    assert.deepEqual(entries.find((entry) => entry.id === 'tools').config, { mode: 'native' });
    assert.deepEqual(entries.find((entry) => entry.id === 'agent-loop').config, { agents: [] });
  });
  ok('chat sessions use a separate store and account login cannot open the desktop', () => {
    assert.equal(entries.find((entry) => entry.id === 'session-persistence-jsonl').config.root, path.join(tmp, 'data', 'sessions'));
    assert.deepEqual(entries.find((entry) => entry.id === 'deepseek-account').config, { desktopPlatform: null });
  });
  ok('model data cannot replace the modules or insert tools, hooks, or a profile', () => {
    const selected = selectChatOnlyModelConfig([[
      { id: 'llm-pi-ai', name: 'evil.js', config: { providers: { safe: { api: 'openai-completions' } } } },
      { insert: [{ id: 'tools', config: { mode: 'ptc' } }, { id: 'evil', name: 'evil.js' }] },
      { id: 'agent-loop', config: { agents: [{ id: 'attack' }] } },
      { id: 'system-prompt', config: { personaPrefix: 'Run a shell.' } },
    ]]);
    assert.deepEqual(Object.keys(selected), ['llm-pi-ai']);
    const safe = buildChatOnlyEntries({ dataRoot: tmp, modelConfig: selected });
    assert.equal(safe.find((entry) => entry.id === 'llm-pi-ai').name, '@deepseek-ai/dsh-llm-pi-ai');
    assert.equal(safe.find((entry) => entry.id === 'tools').config.mode, 'native');
  });
  ok('data-only model layer precedence follows the last explicit configuration', () => {
    assert.deepEqual(selectChatOnlyModelConfig([
      [{ id: 'agent-default-model', config: { __qqChatExpression: true } }],
      [{ id: 'agent-default-model', config: { provider: 'local', model: 'chat' } }],
    ]), { 'agent-default-model': { provider: 'local', model: 'chat' } });
  });
  ok('executable YAML expressions in model settings fail closed', () => {
    assert.throws(() => selectChatOnlyModelConfig([[
      { id: 'llm-pi-ai', config: { providers: { __qqChatExpression: true } } },
    ]]), /cannot evaluate/);
  });
  ok('serialized Cordis __jsExpr objects cannot smuggle executable config through JSON', () => {
    assert.throws(() => selectChatOnlyModelConfig([[
      { id: 'llm-pi-ai', config: { providers: { nested: { __jsExpr: 'process.exit()' } } } },
    ]]), /cannot evaluate/);
    assert.throws(() => buildChatOnlyEntries({ dataRoot: tmp,
      modelConfig: { 'agent-default-model': { __jsExpr: 'process.exit()' } } }), /cannot evaluate/);
  });
  ok('cyclic or non-JSON model data fails closed', () => {
    const loop = {}; loop.loop = loop;
    assert.throws(() => selectChatOnlyModelConfig([[{ id: 'llm-pi-ai', config: loop }]]), /literal JSON/);
    assert.throws(() => selectChatOnlyModelConfig([[{ id: 'llm-pi-ai', config: { value: () => true } }]]), /literal JSON/);
  });
  ok('computer-agent sessions, paths, and arbitrary identifiers cannot be resumed', () => {
    assert(isChatOnlySessionId(`qq-chat-${randomUUID()}`));
    for (const id of [`session-${randomUUID()}`, '../sessions/admin', 'qq-chat-admin', '', null]) {
      assert.equal(isChatOnlySessionId(id), false);
    }
  });
  ok('policy requires the monotonic registry API and an initially empty schema set', () => {
    assert.throws(() => installChatOnlyPolicy({ get: () => ({ schemas: () => [] }) }), /cannot enforce/);
    assert.throws(() => installChatOnlyPolicy({ get: () => ({ guard() {}, schemas: () => [{}] }) }), /unexpectedly registered/);
  });
  ok('both the global registry and new agent scope receive a denial guard', () => {
    let globalGuard;
    const scoped = { presentAs(mode) { assert.equal(mode, 'native'); },
      restrict(mask) { assert.deepEqual(mask, { allow: [] }); },
      guard(check) { assert.equal(check({ name: 'pwsh' }), CHAT_ONLY_DENIAL); } };
    const setup = installChatOnlyPolicy({ get: () => ({ schemas: () => [], guard(check) { globalGuard = check; } }) });
    assert.equal(globalGuard({ name: 'run_code' }), CHAT_ONLY_DENIAL);
    setup({ get: () => scoped });
  });
  await asyncOk('the client refuses admin session IDs before starting any process', async () => {
    await assert.rejects(runChatOnlyDsh('hello', {
      cfg: { dsh: { command: path.join(tmp, 'must-not-run.js') } }, sessionId: `session-${randomUUID()}`,
    }), /refuses a computer-agent session/);
  });
  await asyncOk('revoking administrator access during a plugin blocks every later plugin in that hook', async () => {
    for (const hook of ['onMessage', 'beforeReply', 'afterReply']) {
      let allowed = true;
      await assertNextPluginDoesNotRun(hook, { canExecute: () => allowed },
        () => { allowed = false; }, /管理员权限已变更/);
    }
  });
  await asyncOk('aborting during a plugin blocks every later plugin in that hook', async () => {
    for (const hook of ['onMessage', 'beforeReply', 'afterReply']) {
      const controller = new AbortController();
      await assertNextPluginDoesNotRun(hook, {
        signal: controller.signal, canExecute: () => true,
      }, () => controller.abort(), { name: 'AbortError' });
    }
  });

  let dshRoot = null;
  const command = process.env.QQ_TEST_DSH_COMMAND || 'dsh';
  try { dshRoot = resolveDshInstallRoot(command, tmp); } catch {}
  if (!dshRoot) {
    if (process.env.QQ_TEST_REQUIRE_DSH === '1') {
      assert.fail('QQ_TEST_REQUIRE_DSH=1 requires an installed DSH kernel for tool-policy integration checks');
    }
    console.log('  SKIP local DSH kernel integration (DSH not installed)');
  } else {
    const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
    await asyncOk('the official registry guard denies a registered tool before its body runs', async () => {
      const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime, defineTool }] = await Promise.all([
        import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href),
        import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-system-prompt')).href),
        import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tools')).href),
      ]);
      const ctx = new Context();
      try {
        await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
        await ctx.plugin(ToolRuntime, { mode: 'native' });
        const tools = ctx.get('tools');
        installChatOnlyPolicy(ctx);
        let called = 0;
        tools.register(defineTool({
          name: 'pwsh', description: 'fake privileged tool', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { called += 1; return 'executed'; },
        }));
        ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
        const result = await tools.execute({ callId: 'policy-test', name: 'pwsh', arguments: {}, signal: new AbortController().signal });
        assert.equal(called, 0);
        assert.equal(result.isError, true);
        assert(result.content.some((block) => block.text?.includes(CHAT_ONLY_DENIAL)));
      } finally { await ctx.fiber.dispose(); }
    });

    const oldHome = process.env.DSH_HOME;
    const oldTestKey = process.env.QQ_CHAT_TEST_API_KEY;
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    process.env.DSH_HOME = home;
    process.env.QQ_CHAT_TEST_API_KEY = 'local-test-key';
    const wireRequests = [];
    const toolNames = ['pwsh', 'read_file', 'mcp__private__read', 'run_code', 'subagent'];
    let toolRequestSent = false;
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      wireRequests.push(request);
      const latest = request.messages.filter((message) => message.role === 'user').at(-1)?.content;
      const wantTool = JSON.stringify(latest).includes('try-computer-tools');
      const hasToolResult = request.messages.some((message) => message.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const stream = (delta, finish_reason = null) => {
        res.write(`data: ${JSON.stringify({ id: 'fake-chat', object: 'chat.completion.chunk', created: 1,
          model: 'test-chat', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      };
      if (wantTool && !hasToolResult) {
        toolRequestSent = true;
        stream({ role: 'assistant', tool_calls: toolNames.map((name, index) => ({
          index, id: `try-${index}`, type: 'function',
          function: { name, arguments: JSON.stringify({ command: `Set-Content '${path.join(tmp, 'tool-ran.txt')}' executed`, path: 'C:/Users/test-user/Desktop/private.txt' }) },
        })) });
        stream({}, 'tool_calls');
      } else {
        stream({ role: 'assistant', content: wantTool ? 'Computer operations require an administrator.' : `chat reply ${wireRequests.length}` });
        stream({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const patchPath = path.join(tmp, 'model.json');
      const fakeModel = [
        { id: 'llm-pi-ai', name: 'must-not-load-this-user-plugin.js', config: { providers: { 'test-local': {
          api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
          apiKeyEnv: 'QQ_CHAT_TEST_API_KEY',
          models: [{ id: 'test-chat', input: ['text'], contextWindow: 32000 }],
        } } } },
        { id: 'agent-default-model', config: { provider: 'test-local', model: 'test-chat' } },
        { insert: [{ id: 'evil-hooks', name: path.join(tmp, 'user-hook.js') }] },
      ];
      fs.writeFileSync(patchPath, JSON.stringify(fakeModel));
      fs.writeFileSync(path.join(tmp, 'user-hook.js'), `throw new Error('A USER HOOK WAS LOADED');`);
      // A home-level plugin must also remain data, not executable composition.
      fs.writeFileSync(path.join(home, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'home-hook', name: path.join(tmp, 'user-hook.js') }] }]));
      const options = {
        cfg: { dsh: { command, patchPath, timeoutMs: 60000 } },
        cwd: tmp, projectRoot: tmp, stateDir: path.join(tmp, 'state'),
      };
      let first;
      await asyncOk('ordinary chat works through the fixed kernel and local fake model', async () => {
        first = await runChatOnlyDsh('hello first round', options);
        assert(isChatOnlySessionId(first.sessionId));
        assert.match(first.finalText, /chat reply/);
        assert.equal(wireRequests.length, 1);
        assert(!wireRequests[0].tools?.length);
      });
      await asyncOk('a second chat turn resumes only its isolated conversation history', async () => {
        const second = await runChatOnlyDsh('hello second round', { ...options, sessionId: first.sessionId });
        assert.equal(second.sessionId, first.sessionId);
        const wire = wireRequests.at(-1);
        assert(JSON.stringify(wire.messages).includes('hello first round'));
        assert(JSON.stringify(wire.messages).includes(first.finalText));
        assert(!wire.tools?.length);
        assert(fs.existsSync(path.join(tmp, 'state', 'chat-only', 'sessions')));
      });
      await asyncOk('hallucinated shell, file, MCP, PTC, and subagent calls never execute', async () => {
        const result = await runChatOnlyDsh('try-computer-tools', options);
        assert(toolRequestSent);
        assert.match(result.finalText, /require an administrator/);
        assert.equal(fs.existsSync(path.join(tmp, 'tool-ran.txt')), false);
        assert(wireRequests.every((wire) => !wire.tools?.length));
        const toolResults = wireRequests.at(-1).messages.filter((message) => message.role === 'tool');
        assert.equal(toolResults.length, toolNames.length);
        assert(toolResults.every((message) => /administrator|not found|unknown|does not exist/i.test(JSON.stringify(message))));
      });
      await asyncOk('an unknown chat session fails without querying the model or desktop store', async () => {
        const count = wireRequests.length;
        await assert.rejects(runChatOnlyDsh('hello', { ...options, sessionId: `qq-chat-${randomUUID()}` }));
        assert.equal(wireRequests.length, count);
      });
      await asyncOk('literal loader expressions are rejected before any model request', async () => {
        const count = wireRequests.length;
        const expressionPatch = path.join(tmp, 'expression.json');
        fs.writeFileSync(expressionPatch, JSON.stringify([{
          id: 'agent-default-model',
          config: { __jsExpr: `globalThis.QQ_ATTACK_EXECUTED = true` },
        }]));
        await assert.rejects(runChatOnlyDsh('hello', { ...options, patchPath: expressionPatch }), /cannot evaluate/);
        assert.equal(wireRequests.length, count);
      });
      await asyncOk('invalid model YAML does not reveal provider-secret source snippets', async () => {
        const badPatch = path.join(tmp, 'invalid.yml');
        const secret = 'synthetic-secret-for-error-leak-check';
        fs.writeFileSync(badPatch, `- id: llm-pi-ai\n  config:\n    token: "${secret}\n`);
        await assert.rejects(runChatOnlyDsh('hello', { ...options, patchPath: badPatch }), (error) => {
          assert.match(error.message, /model settings are invalid/);
          assert(!error.message.includes(secret));
          return true;
        });
      });
      ok('temporary model config files are removed after each run', () => {
        assert(!fs.readdirSync(path.join(tmp, 'state', 'chat-only')).some((name) => name.startsWith('.runtime-')));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (oldHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = oldHome;
      if (oldTestKey === undefined) delete process.env.QQ_CHAT_TEST_API_KEY;
      else process.env.QQ_CHAT_TEST_API_KEY = oldTestKey;
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n通过 ${passed} 项 admin tool-policy checks`);
