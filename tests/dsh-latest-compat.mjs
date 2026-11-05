import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAstrbotModelProvider } from '../src/astrbot-model.mjs';
import { dshSplitsToolExecutors } from '../src/dsh-version.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_ROOT = path.resolve(process.env.DSH_LATEST_ROOT || path.join(
  PROJECT_ROOT, '.tmp', 'dsh-latest-compat', 'node_modules', '@deepseek-ai', 'dsh',
));
function installedDshVersion() {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(DSH_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}
const EXPECTED_DSH_VERSION = process.env.QQ_TEST_DSH_VERSION || installedDshVersion();
const SPLIT_TOOLS = dshSplitsToolExecutors(EXPECTED_DSH_VERSION);
const ROUTE = 'compat-route';
const MODEL = 'compat-model';
const TEST_KEY_ENV = 'QQ_DSH_COMPAT_TEST_KEY';
const TEST_KEY = 'loopback-fixture-key';
const HEADLESS_TASK = 'Handle [headless-cli-plain-text] and return its response verbatim.';

function patchFor(baseURL) {
  return `- id: llm-pi-ai
  config:
    providers:
      ${ROUTE}:
        apiKeyEnv: ${TEST_KEY_ENV}
        api: openai-completions
        baseURL: ${baseURL}
        models:
          - id: ${MODEL}
            contextWindow: 8192
            maxTokens: 2048
            input: [text, image]
- id: agent-default-model
  config:
    provider: ${ROUTE}
    model: ${MODEL}
`;
}

function openAiChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-loopback-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function prepareCliEnvironment(root, label) {
  const prefix = path.join(root, label);
  const paths = {
    home: path.join(prefix, 'home'),
    dshHome: path.join(prefix, 'dsh-home'),
    temp: path.join(prefix, 'temp'),
    cwd: path.join(prefix, 'workspace'),
  };
  await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));

  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HOME = paths.home;
  env.USERPROFILE = paths.home;
  env.APPDATA = path.join(paths.home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(paths.home, 'AppData', 'Local');
  env.DSH_HOME = paths.dshHome;
  if (!SPLIT_TOOLS) env.DSH_TOOLS_MODE = 'native';
  env.DSH_TELEMETRY_DISABLED = '1';
  env.TMPDIR = paths.temp;
  env.TMP = paths.temp;
  env.TEMP = paths.temp;
  env[TEST_KEY_ENV] = TEST_KEY;
  if (process.env.NARB_DISABLE_NATIVE_CACHE !== undefined) {
    env.NARB_DISABLE_NATIVE_CACHE = process.env.NARB_DISABLE_NATIVE_CACHE;
  }
  return { ...paths, env };
}

function runCordisNativeProbe(cwd, env) {
  const requireFromCli = createRequire(path.join(DSH_ROOT, 'lib', 'bin.js'));
  const cordisLoaderEntry = requireFromCli.resolve('@deepseek-ai/cordis-plugin-loader');
  const nativeProbeScript = `
const { createRequire } = require('node:module');
try {
  const requireFromCordisLoader = createRequire(process.argv[1]);
  const addon = requireFromCordisLoader('node-addon-require-builtin');
  const binding = addon.getBindingInfo();
  const esmLoader = addon.requireBuiltin('internal/modules/esm/loader');
  const cascadedLoader = esmLoader?.getOrInitializeCascadedLoader?.();
  process.stdout.write(JSON.stringify({
    binding,
    internalEsmLoaderLoaded: Boolean(esmLoader),
    cascadedLoaderLoaded: Boolean(cascadedLoader),
    cascadedLoaderApi: cascadedLoader && {
      getOrCreateModuleJob: typeof cascadedLoader.getOrCreateModuleJob,
      getModuleJobForImport: typeof cascadedLoader.getModuleJobForImport,
    },
  }, null, 2));
} catch (error) {
  process.stderr.write(JSON.stringify({
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
    attempts: error?.attempts,
  }, null, 2));
  process.exitCode = 1;
}
`;
  const probe = spawnSync(process.execPath, ['-e', nativeProbeScript, cordisLoaderEntry], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return [
    `\nCordis-loader-origin native probe (exit ${probe.status ?? 'spawn-error'}):`,
    probe.error?.message,
    probe.stdout,
    probe.stderr,
  ].filter(Boolean).join('\n');
}

function spawnCaptured(command, args, options, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    try {
      child = spawn(command, args, options);
    } catch (error) {
      finish({ error, status: null, signal: null });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ error, status: null, signal: null }));
    child.once('close', (status, signal) => finish({
      error: timedOut ? new Error(`CLI timed out after ${timeoutMs}ms`) : undefined,
      status,
      signal,
    }));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

test('installed DSH keeps boot and bundle-list entry points', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(DSH_ROOT, 'package.json'), 'utf8'));
  const requireDsh = createRequire(path.join(DSH_ROOT, 'package.json'));
  const boot = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href);
  assert.equal(typeof boot.boot, 'function');
  assert.equal(typeof boot.loadLayeredEnv, 'function');
  if (dshSplitsToolExecutors(manifest.version)) {
    assert.match(String(manifest.engines?.node ?? ''), /24\.9/);
    assert.equal(boot.OFFICIAL_ON_DEMAND_CATALOG, undefined);
    const official = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-official-bundles')).href);
    assert.ok(official.DEFAULT_PROFILE_BUNDLES);
    assert.equal(typeof (await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-executor-native')).href)).apply, 'function');
  } else {
    assert.ok(boot.DEFAULT_PROFILE_BUNDLES || boot.OFFICIAL_ON_DEMAND_CATALOG);
  }
});

test(`DSH ${EXPECTED_DSH_VERSION || 'installed'} serves real AstrBot requests through a loopback OpenAI fixture`, async (t) => {
  const manifest = JSON.parse(await fs.readFile(path.join(DSH_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  assert.equal(manifest.version, EXPECTED_DSH_VERSION,
    `Expected isolated ${EXPECTED_DSH_VERSION}; found ${manifest.version} at ${DSH_ROOT}`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-dsh-latest-compat-'));
  const previousDshHome = process.env.DSH_HOME;
  const previousTestKey = process.env[TEST_KEY_ENV];
  const dshHome = path.join(root, 'dsh-home');
  const profileDir = path.join(dshHome, 'profiles', 'headless');
  await fs.mkdir(profileDir, { recursive: true });

  const requests = [];
  let resolveCancelStarted;
  let resolveCancelClosed;
  const cancelStarted = new Promise((resolve) => { resolveCancelStarted = resolve; });
  const cancelClosed = new Promise((resolve) => { resolveCancelClosed = resolve; });
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const recordedRequest = { path: request.url, authorization: request.headers.authorization, body };
      requests.push(recordedRequest);
      if (request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${TEST_KEY}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture rejected route or credential' } }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userText = messages.flatMap((message) => {
        if (typeof message.content === 'string') return [message.content];
        return Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'text').map((part) => part.text)
          : [];
      }).join('\n');

      if (userText.includes('[headless-cli-plain-text]')) {
        recordedRequest.fixtureReply = 'headless-cli-plain-text';
        sendSse(response, [
          openAiChunk({ role: 'assistant', content: 'headless CLI fixture answer: DSH_LOOPBACK_OK' }),
          openAiChunk({}, 'stop'),
        ]);
        return;
      }
      if (userText.includes('[cancel-now]')) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.flushHeaders();
        response.on('close', resolveCancelClosed);
        resolveCancelStarted();
        return;
      }
      if (messages.some((message) => message.role === 'tool')) {
        sendSse(response, [
          openAiChunk({ role: 'assistant', content: 'tool result accepted' }),
          openAiChunk({}, 'stop'),
        ]);
        return;
      }
      if (userText.includes('call lookup')) {
        sendSse(response, [
          openAiChunk({ role: 'assistant', tool_calls: [{
            index: 0,
            id: 'call_compat_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"item":' },
          }] }),
          openAiChunk({ tool_calls: [{ index: 0, function: { arguments: '"book"}' } }] }),
          openAiChunk({}, 'tool_calls'),
        ]);
        return;
      }
      sendSse(response, [
        openAiChunk({ role: 'assistant', content: 'loopback streamed ' }),
        openAiChunk({ content: userText.includes('Describe this image') ? 'image reply' : 'text response' }),
        openAiChunk({}, 'stop'),
      ]);
    } catch {
      if (!response.destroyed) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture could not parse request' } }));
      }
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const profilePatch = path.join(profileDir, 'cordis.patch.yml');
    await fs.writeFile(profilePatch, patchFor(baseURL), { mode: 0o600, flag: 'wx' });

    process.env.DSH_HOME = dshHome;
    process.env[TEST_KEY_ENV] = TEST_KEY;
    await t.test('latest DSH exposes package version', () => {
      assert.equal(manifest.version, EXPECTED_DSH_VERSION);
    });

    await t.test('real host completes five isolated loopback scenarios', async () => {
      const provider = createAstrbotModelProvider({
        readConfig: async () => ({
          dsh: { command: path.join(DSH_ROOT, 'lib', 'bin.js'), cwd: root, profile: 'headless', timeoutMs: 30_000 },
        }),
        modelPlan: () => ({ model: { provider: ROUTE, model: MODEL }, extraPatchPaths: [] }),
        cwd: root,
        projectRoot: root,
        stateDir: path.join(root, 'isolated-state'),
      });
      const tool = {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a book',
          parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
        },
      };

      const textReply = await provider({
        model: 'request-model-is-ignored',
        messages: [{ role: 'user', content: 'Return the compatibility response.' }],
      });
      assert.equal(textReply.choices[0].message.content, 'loopback streamed text response');
      assert.equal(requests.at(-1).body.model, MODEL, 'DSH routing must use the trusted model plan');
      assert.equal(requests.at(-1).body.stream, true);
      assert.equal(requests.at(-1).authorization, `Bearer ${TEST_KEY}`);

      const toolReply = await provider({
        messages: [{ role: 'user', content: 'Please call lookup on book.' }],
        tools: [tool],
      });
      const toolCall = toolReply.choices[0].message.tool_calls?.[0];
      assert.deepEqual(toolCall, {
        id: 'call_compat_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"item":"book"}' },
      });
      assert.equal(toolReply.choices[0].finish_reason, 'tool_calls');

      const toolResultReply = await provider({
        messages: [
          { role: 'user', content: 'Please call lookup on book.' },
          { role: 'assistant', content: '', tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: 'call_compat_1', content: 'FOUND: book' },
        ],
        tools: [tool],
      });
      assert.equal(toolResultReply.choices[0].message.content, 'tool result accepted');
      const toolLoopRequest = requests.at(-1).body;
      assert.ok(toolLoopRequest.messages.some((message) => message.role === 'assistant'
        && message.tool_calls?.[0]?.id === 'call_compat_1'));
      assert.ok(toolLoopRequest.messages.some((message) => message.role === 'tool'
        && message.tool_call_id === 'call_compat_1' && message.content === 'FOUND: book'));

      const attachmentPackage = path.join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'package.json');
      const requireAttachment = createRequire(attachmentPackage);
      const png = await requireAttachment('sharp')({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      }).png().toBuffer();
      const imageReply = await provider({
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ] }],
      });
      assert.equal(imageReply.choices[0].message.content, 'loopback streamed image reply');
      const imageMessage = requests.at(-1).body.messages.find((message) => message.role === 'user');
      const imagePart = imageMessage.content.find((part) => part.type === 'image_url');
      assert.match(imagePart.image_url.url, /^data:image\/(?:png|jpeg|webp);base64,/i);
      assert.ok(Buffer.from(imagePart.image_url.url.split(',')[1], 'base64').length > 0);

      const controller = new AbortController();
      const pending = provider({
        messages: [{ role: 'user', content: '[cancel-now]' }],
      }, { signal: controller.signal });
      await withTimeout(cancelStarted, 20_000, 'loopback cancellation request');
      controller.abort();
      await assert.rejects(pending, { code: 'ASTRBOT_MODEL_ABORTED' });
      await withTimeout(cancelClosed, 20_000, 'loopback client disconnect');

      assert.equal(requests.length, 5, 'the host scenarios should make exactly five loopback calls');
      assert.ok(requests.every((request) => request.path === '/v1/chat/completions'
        && request.authorization === `Bearer ${TEST_KEY}`));
    });

    await t.test('isolated CLI parses bridge flags through --help', async () => {
      const isolated = await prepareCliEnvironment(root, 'isolated-cli-help');
      const cli = spawnSync(process.execPath, [
        path.join(DSH_ROOT, 'lib', 'bin.js'),
        '--profile', 'headless',
        '--patch', profilePatch,
        '--json',
        '--session-id', 'isolated-compat-session',
        '--help',
      ], {
        cwd: isolated.cwd,
        env: isolated.env,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      let nativeProbeOutput = '';
      if (cli.error || cli.status !== 0) {
        nativeProbeOutput = runCordisNativeProbe(isolated.cwd, isolated.env);
      }
      assert.equal(cli.error, undefined, `${cli.error?.message || ''}${nativeProbeOutput}`);
      assert.equal(cli.status, 0, `DSH CLI help failed: ${cli.stderr || cli.stdout}${nativeProbeOutput}`);
      assert.match(`${cli.stdout}\n${cli.stderr}`, /--json/);
      assert.match(`${cli.stdout}\n${cli.stderr}`, /--session-id/);
      assert.equal(requests.length, 5, 'CLI help must not send a model request');
    });

    await t.test('headless CLI completes one plain-text loopback turn with JSON output', async () => {
      const isolated = await prepareCliEnvironment(root, 'isolated-headless-cli');
      const requestCountBefore = requests.length;
      const cli = await spawnCaptured(process.execPath, [
        path.join(DSH_ROOT, 'lib', 'bin.js'),
        '--profile', 'headless',
        '--patch', profilePatch,
        '--json',
        HEADLESS_TASK,
      ], {
        cwd: isolated.cwd,
        env: isolated.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, 120_000);
      let nativeProbeOutput = '';
      if (cli.error || cli.status !== 0) {
        nativeProbeOutput = runCordisNativeProbe(isolated.cwd, isolated.env);
      }
      assert.equal(cli.error, undefined,
        `Headless DSH CLI could not complete: ${cli.error?.message || ''}\n${cli.stderr}\n${cli.stdout}${nativeProbeOutput}`);
      assert.equal(cli.status, 0,
        `Headless DSH CLI exited ${cli.status} (${cli.signal || 'no signal'}):\n${cli.stderr}\n${cli.stdout}${nativeProbeOutput}`);

      const eventLines = cli.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.ok(eventLines.length >= 2, `Expected JSON event stream, got: ${cli.stdout}`);
      const events = eventLines.map((line) => JSON.parse(line));
      assert.equal(events[0].type, 'session');
      assert.equal(events.at(-1).type, 'final');
      assert.equal(events.at(-1).text, 'headless CLI fixture answer: DSH_LOOPBACK_OK');
      assert.equal(events.some((event) => event.type === 'tool_call' || event.type === 'tool_result'), false,
        'The plain-text fixture response must not execute or report a tool call');
      assert.equal(cli.stderr.trim(), '', `The plain-text headless run should not emit diagnostics: ${cli.stderr}`);

      const headlessRequests = requests.slice(requestCountBefore);
      const requestSummary = headlessRequests.map((entry) => ({
        fixtureReply: entry.fixtureReply,
        model: entry.body.model,
        messages: entry.body.messages.map((message) => ({
          role: message.role,
          content: message.role === 'system' ? undefined : message.content,
          toolCalls: message.tool_calls?.map((call) => call.id),
        })),
      }));
      assert.equal(headlessRequests.length, 2,
        `The headless run should make one task request and one session-title request: ${JSON.stringify(requestSummary)}`);
      assert.ok(headlessRequests.some((entry) => entry.body.messages.some((message) => message.content === HEADLESS_TASK)),
        'The headless runner must submit the positional task');
      assert.ok(headlessRequests.some((entry) => entry.body.messages.some((message) =>
        typeof message.content === 'string' && message.content.includes('Generate the session title'))),
      'The run may generate its session title through the same loopback fixture');
      assert.ok(headlessRequests.every((entry) => entry.fixtureReply === 'headless-cli-plain-text'
        && entry.path === '/v1/chat/completions'
        && entry.authorization === `Bearer ${TEST_KEY}`
        && entry.body.stream === true
        && entry.body.model === MODEL
        && !entry.body.messages.some((message) => message.role === 'tool')),
      'Both CLI requests must use the synthetic loopback route and contain no tool result');
    });
  } finally {
    restoreEnv('DSH_HOME', previousDshHome);
    restoreEnv(TEST_KEY_ENV, previousTestKey);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
