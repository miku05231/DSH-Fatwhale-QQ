import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { convertDshChunks, createAstrbotModelProvider, normalizeAstrbotRequest } from '../src/astrbot-model.mjs';
import { executeAstrbotModelHost } from '../src/astrbot-model-host.mjs';
import { resolveDshInstallRoot } from '../src/dsh-desktop.js';

const DSH_ROOT = resolveDshInstallRoot(process.env.QQ_TEST_DSH_COMMAND || 'dsh', process.cwd());
const DSH_COMMAND = path.join(DSH_ROOT, 'lib', 'bin.js');
const SECRET = 'astrbot-runtime-secret-sentinel';
const requireAttachment = createRequire(path.join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'package.json'));

async function withTempDir(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-astrbot-model-'));
  try { return await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function chunksForText(text = 'offline reply') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

test('typed DSH chunks become OpenAI choices while tool arguments remain opaque', () => {
  const rawArguments = '{"value":';
  const result = convertDshChunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'lookup', argumentsDelta: rawArguments },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: rawArguments } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], 'offline-model');
  assert.equal(result.choices[0].message.content, 'answer');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, rawArguments);
  assert.equal(result.model, 'offline-model');
});

test('provider uses current DSH model plan and keeps credentials out of the RPC payload', async () => {
  await withTempDir(async (root) => {
    const previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = path.join(root, 'dsh-home');
    let rpcInput;
    try {
      const provider = createAstrbotModelProvider({
        readConfig: async () => ({
          dsh: { command: DSH_COMMAND, cwd: root, timeoutMs: 12_000 },
          astrbot: { apiKey: SECRET, password: SECRET },
        }),
        modelPlan: () => ({
          extraPatchPaths: [],
          model: { provider: 'trusted-route', model: 'trusted-model', apiKey: SECRET, baseURL: SECRET },
          credential: SECRET,
        }),
        cwd: root,
        projectRoot: root,
        stateDir: path.join(root, 'state'),
        runModel: async (input) => { rpcInput = input; return chunksForText(); },
      });
      const response = await provider({
        model: 'attacker-model', provider: 'attacker-route', base_url: SECRET, api_key: SECRET,
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(response.choices[0].message.content, 'offline reply');
      assert.deepEqual(rpcInput.selection, { provider: 'trusted-route', model: 'trusted-model' });
      const serialized = JSON.stringify(rpcInput);
      assert.equal(serialized.includes(SECRET), false);
      assert.equal(serialized.includes('attacker-model'), false);
      assert.equal(serialized.includes('attacker-route'), false);
      assert.deepEqual(Object.keys(rpcInput.request).sort(), ['messages', 'toolChoice', 'tools']);
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
    }
  });
});

test('factory construction is lazy and has no DSH or filesystem side effects', async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, 'never-created');
    let readCount = 0;
    createAstrbotModelProvider({
      readConfig: async () => { readCount += 1; return {}; },
      cwd: root,
      stateDir,
    });
    assert.equal(readCount, 0);
    await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  });
});

test('cancellation rejects a pending model call promptly', async () => {
  const controller = new AbortController();
  const provider = createAstrbotModelProvider({
    readConfig: async () => ({}),
    modelPlan: () => ({ model: { provider: 'route', model: 'model' } }),
    runModel: () => new Promise(() => {}),
  });
  const pending = provider({ messages: [{ role: 'user', content: 'wait' }] }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ASTRBOT_MODEL_ABORTED' });
});

test('invalid tool schema is rejected before invoking the DSH runner', async () => {
  let called = false;
  const provider = createAstrbotModelProvider({
    readConfig: async () => ({}),
    modelPlan: () => ({ model: { provider: 'route', model: 'model' } }),
    runModel: async () => { called = true; return chunksForText(); },
  });
  await assert.rejects(provider({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'bad', parameters: [] } }],
  }));
  assert.equal(called, false);
  assert.throws(() => normalizeAstrbotRequest({ messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'function' } }), {
    code: 'ASTRBOT_TOOL_CHOICE_UNSUPPORTED',
  });
});

test('!!js model patches are rejected as data before DSH boot', async () => {
  await withTempDir(async (root) => {
    const patch = path.join(root, 'expression.patch.yml');
    await fs.writeFile(patch, '- id: agent-default-model\n  config:\n    provider: !!js "process.exit(9)"\n    model: offline-model\n', { flag: 'wx' });
    await assert.rejects(executeAstrbotModelHost({
      dshRoot: DSH_ROOT,
      cwd: root,
      dataRoot: path.join(root, 'state'),
      patchPaths: [patch],
      selection: { provider: 'offline-route', model: 'offline-model' },
      request: { messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' },
    }), /cannot evaluate !!js expressions/);
    await assert.rejects(fs.stat(path.join(root, 'state')), { code: 'ENOENT' });
  });
});

test('installed DSH boots offline and streams structured text, image, tools, and routing', async () => {
  await withTempDir(async (root) => {
    const PNG = (await requireAttachment('sharp')({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()).toString('base64');
    const previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = path.join(root, 'isolated-dsh-home');
    let observed;
    try {
      const request = normalizeAstrbotRequest({
        messages: [
          { role: 'system', content: 'Answer briefly.' },
          { role: 'developer', content: 'Use the declared function when helpful.' },
          { role: 'user', content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          ] },
        ],
        tools: [{ type: 'function', function: {
          name: 'lookup', description: 'Look up an item',
          parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
        } }],
        temperature: 0.25,
        max_tokens: 91,
      });
      const chunks = await executeAstrbotModelHost({
        dshRoot: DSH_ROOT,
        cwd: root,
        dataRoot: path.join(root, 'isolated-state'),
        patchPaths: [],
        selection: { provider: 'offline-route', model: 'offline-model' },
        request,
        timeoutMs: 30_000,
      }, {
        createMockAdapter: async ({ LlmAdapter }) => new (class OfflineAdapter extends LlmAdapter {
          async *stream(options) {
            observed = options;
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: 'offline image reply' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline image reply' } };
            yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        })(),
      });
      const result = convertDshChunks(chunks, 'offline-model');
      assert.equal(result.choices[0].finish_reason, 'stop');
      assert.equal(result.choices[0].message.content, 'offline image reply');
      assert.equal(observed.provider, 'offline-route');
      assert.equal(observed.model, 'offline-model');
      assert.equal(observed.temperature, 0.25);
      assert.equal(observed.maxTokens, 91);
      assert.deepEqual(observed.tools[0], {
        name: 'lookup', description: 'Look up an item',
        parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
      });
      const user = observed.messages.find((message) => message.role === 'user');
      assert.equal(user.content[0].text, 'Describe this image.');
      assert.equal(user.content[1].type, 'image');
      assert.ok(user.content[1].attachment);
      assert.ok((await fs.readdir(path.join(root, 'isolated-state', 'attachments', 'v1'), { recursive: true })).length > 0);
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
    }
  });
});
