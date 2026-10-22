import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { classifyGroupMessage, createDefaultGroupClassifier, normalizeJevEndpoint, parseJevDecision } from '../src/jev-classifier.js';
import { createLocalDshFixture, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

assert.equal(normalizeJevEndpoint('https://jev.example/v1/'), 'https://jev.example/v1/chat/completions');
assert.equal(normalizeJevEndpoint('http://127.0.0.1:9000/v1/chat/completions'), 'http://127.0.0.1:9000/v1/chat/completions');
assert.equal(parseJevDecision('{"should_reply":true}'), true);
assert.equal(parseJevDecision('{"should_reply":false}'), false);
assert.equal(parseJevDecision('not-json true'), false);

let request;
const accepted = await classifyGroupMessage({
  baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini',
  history: [{ role: 'assistant', text: '我刚才说过答案。' }, { role: 'user', text: '嗯。' }],
  message: '那第二个呢？',
  fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"should_reply":true}' } }] }), { status: 200 });
  },
});
assert.deepEqual(accepted, { eligible: true, reason: 'model_eligible' });
assert.equal(request.url, 'https://jev.example/v1/chat/completions');
assert.equal(request.options.headers.authorization, 'Bearer synthetic-secret');
assert.match(request.options.body, /我刚才说过答案/);
assert.match(request.options.body, /那第二个呢/);

const rejected = await classifyGroupMessage({
  baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini', message: '今天天气不错',
  fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"should_reply":false}' } }] }), { status: 200 }),
});
assert.equal(rejected.eligible, false);

const failClosed = await classifyGroupMessage({
  baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini', message: '继续',
  fetchImpl: async () => { throw new Error('secret-bearing provider error'); },
});
assert.deepEqual(failClosed, { eligible: false, reason: 'provider_error' });

const httpFail = await classifyGroupMessage({
  baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini', message: '继续',
  fetchImpl: async () => new Response('sensitive body', { status: 401 }),
});
assert.deepEqual(httpFail, { eligible: false, reason: 'provider_http_error' });
assert.deepEqual(await classifyGroupMessage({ baseUrl: 'file:///tmp/x', token: 'synthetic-secret', model: 'x', message: 'hello' }), {
  eligible: false, reason: 'invalid_endpoint',
});

let boundedHistory;
await classifyGroupMessage({
  baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini', message: '继续',
  history: Array.from({ length: 110 }, (_, i) => ({ role: 'user', text: `${i}:` + 'x'.repeat(2000) })),
  fetchImpl: async (_url, options) => {
    boundedHistory = JSON.parse(JSON.parse(options.body).messages.at(-1).content).history;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"should_reply":false}' } }] }));
  },
});
assert.equal(boundedHistory.length, 100, 'support the full configured context range');
assert.ok(boundedHistory[0].text.startsWith('10:'));
assert.ok(boundedHistory.at(-1).text.startsWith('109:'));
assert.ok(boundedHistory.every(entry => entry.text.length === 1200));

test('no or partial JEV credentials use the default model with the same bounded prompt', async () => {
  for (const config of [
    {}, { baseUrl: 'https://jev.example/v1' }, { token: 'synthetic-secret' },
    { baseUrl: ' ', token: 'synthetic-secret' }, { baseUrl: 'https://jev.example/v1', token: '\t' },
  ]) {
    let call;
    const result = await classifyGroupMessage({
      ...config, message: 'x'.repeat(2000), history: Array.from({ length: 110 }, () => ({ role: 'assistant', text: 'y'.repeat(2000) })),
      fetchImpl: async () => { throw new Error('independent endpoint must not run'); },
      runDefaultModel: async args => { call = args; return '{"should_reply":true}'; },
    });
    assert.deepEqual(result, { eligible: true, reason: 'model_eligible' });
    assert.equal(call.messages[0].content, JSON.parse(request.options.body).messages[0].content);
    const payload = JSON.parse(call.messages[1].content);
    assert.equal(payload.current_message.length, 1200);
    assert.equal(payload.history.length, 100);
    assert.ok(payload.history.every(entry => entry.role === 'assistant' && entry.text.length === 1200));
    assert.equal(call.timeoutMs, 8000);
    assert.equal(call.signal.aborted, false);
  }
});

test('complete JEV configuration uses only the independent endpoint and never falls back after failure', async () => {
  let defaults = 0;
  const options = {
    baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini', message: 'continue',
    runDefaultModel: async () => { defaults += 1; return '{"should_reply":true}'; },
  };
  for (const fetchImpl of [
    async () => new Response('secret response', { status: 503 }),
    async () => { throw new Error('secret exception'); },
  ]) assert.equal((await classifyGroupMessage({ ...options, fetchImpl })).eligible, false);
  assert.deepEqual(await classifyGroupMessage({ ...options, model: '' }), { eligible: false, reason: 'invalid_request' });
  assert.equal(defaults, 0);
});

test('default failures are closed and return no model or credential details', async () => {
  for (const [runDefaultModel, reason] of [
    [async () => { throw new Error('synthetic-secret from DSH'); }, 'provider_error'],
    [async () => undefined, 'invalid_provider_response'],
    [async () => 'not JSON synthetic-secret', 'model_not_eligible'],
    [async () => '{"should_reply":false}', 'model_not_eligible'],
  ]) {
    assert.deepEqual(await classifyGroupMessage({ message: 'continue', runDefaultModel }), { eligible: false, reason });
  }
  assert.deepEqual(await classifyGroupMessage({ message: 'continue' }), { eligible: false, reason: 'default_model_unavailable' });
});

test('both provider paths enforce the deadline even when a provider ignores its abort signal', async () => {
  for (const remote of [true, false]) {
    let signal;
    const never = new Promise(() => {});
    const options = remote ? {
      baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'jev-mini',
      fetchImpl: async (_url, args) => { signal = args.signal; return never; },
    } : { runDefaultModel: async args => { signal = args.signal; return never; } };
    assert.deepEqual(await classifyGroupMessage({ ...options, message: 'continue', timeoutMs: 25 }), { eligible: false, reason: 'timeout' });
    assert.equal(signal.aborted, true);
  }
});

test('a never-ending HTTP error stream is cancelled without reading its contents', async t => {
  let closeResponse;
  const closed = new Promise(resolve => { closeResponse = resolve; });
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume only the local test request. */ }
    res.once('close', closeResponse);
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.write('synthetic-secret-error-stream');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  assert.deepEqual(await classifyGroupMessage({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token: 'synthetic-secret', model: 'fixture',
    message: 'continue', timeoutMs: 1000,
  }), { eligible: false, reason: 'provider_http_error' });
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP error stream was not cancelled')), 1000);
    timer.unref();
  })]);
});

test('HTTP error body cancellation remains bounded by the classification deadline', async () => {
  let bodyCancelled = false;
  let signal;
  const stream = new ReadableStream({ cancel() { bodyCancelled = true; return new Promise(() => {}); } });
  assert.deepEqual(await classifyGroupMessage({
    baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'fixture', message: 'continue', timeoutMs: 25,
    fetchImpl: async (_url, args) => { signal = args.signal; return new Response(stream, { status: 503 }); },
  }), { eligible: false, reason: 'timeout' });
  assert.equal(bodyCancelled, true);
  assert.equal(signal.aborted, true);
});

test('already-cancelled requests never start either provider', async () => {
  for (const remote of [true, false]) {
    const abort = new AbortController();
    abort.abort(new Error('synthetic-secret shutdown reason'));
    let calls = 0;
    const options = remote ? {
      baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'fixture',
      fetchImpl: async () => { calls += 1; },
    } : { runDefaultModel: async () => { calls += 1; } };
    assert.deepEqual(await classifyGroupMessage({ ...options, message: 'continue', signal: abort.signal }), {
      eligible: false, reason: 'cancelled',
    });
    assert.equal(calls, 0);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  }
});

test('mid-request shutdown cancels both providers and removes abort listeners', async () => {
  for (const remote of [true, false]) {
    const abort = new AbortController();
    let providerSignal;
    let started;
    let resolveProvider;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { resolveProvider = resolve; });
    const options = remote ? {
      baseUrl: 'https://jev.example/v1', token: 'synthetic-secret', model: 'fixture',
      fetchImpl: async (_url, args) => { providerSignal = args.signal; started(); return pending; },
    } : { runDefaultModel: async args => { providerSignal = args.signal; started(); return pending; } };
    const result = classifyGroupMessage({ ...options, message: 'continue', signal: abort.signal, timeoutMs: 1000 });
    await startedPromise;
    abort.abort(new Error('synthetic-secret shutdown reason'));
    assert.deepEqual(await result, { eligible: false, reason: 'cancelled' });
    assert.equal(providerSignal.aborted, true);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    resolveProvider(remote ? new Response(JSON.stringify({ choices: [{ message: { content: '{"should_reply":true}' } }] })) : '{"should_reply":true}');
  }
});

test('successful requests detach the shutdown listener and clear their deadline', async () => {
  const abort = new AbortController();
  let providerSignal;
  assert.equal((await classifyGroupMessage({
    message: 'continue', timeoutMs: 1000, signal: abort.signal,
    runDefaultModel: async args => { providerSignal = args.signal; return '{"should_reply":true}'; },
  })).eligible, true);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  abort.abort();
  assert.equal(providerSignal.aborted, false);
});

test('an already stopped default factory never reads config or starts a model', async () => {
  const abort = new AbortController();
  abort.abort();
  const runner = createDefaultGroupClassifier({
    signal: abort.signal,
    readConfig: () => { throw new Error('must not read'); },
    runModel: async () => { throw new Error('must not start'); },
  });
  assert.deepEqual(await classifyGroupMessage({ message: 'continue', runDefaultModel: runner }), {
    eligible: false, reason: 'cancelled',
  });
});

test('default runner rereads current config and model while isolating sessions and privileges', async () => {
  const calls = [];
  let selected = 'first';
  let config = { dsh: { command: 'fixture' }, security: { adminUserIds: [123] } };
  const abort = new AbortController();
  const runner = createDefaultGroupClassifier({
    readConfig: () => config,
    modelPlan: () => ({ model: { provider: 'fixture', model: selected }, extraPatchPaths: [selected] }),
    cwd: 'fixture-cwd', projectRoot: 'fixture-root', stateDir: 'fixture-state', patchPath: 'fixture-patch', signal: abort.signal,
    runModel: async (prompt, options) => { calls.push({ prompt, options }); return { finalText: '{"should_reply":true}' }; },
  });
  assert.equal((await classifyGroupMessage({ message: 'first only', runDefaultModel: runner, timeoutMs: 1200 })).eligible, true);
  selected = 'second';
  config = { ...config, marker: 'current-config' };
  await classifyGroupMessage({ message: 'second only', runDefaultModel: runner });
  assert.equal(calls[0].options.model.model, 'first');
  assert.equal(calls[1].options.model.model, 'second');
  assert.equal(calls[1].options.cfg.marker, 'current-config');
  assert.deepEqual(calls[1].options.extraPatchPaths, ['second']);
  assert.equal(calls[0].options.sessionId, null);
  assert.equal(calls[0].options.requesterId, undefined);
  assert.equal(calls[0].options.timeoutMs, 1200);
  assert.equal(calls[0].options.cwd, 'fixture-cwd');
  assert.equal(calls[0].options.projectRoot, 'fixture-root');
  assert.equal(calls[0].options.stateDir, 'fixture-state');
  assert.equal(calls[0].options.patchPath, 'fixture-patch');
  assert.equal(calls[1].prompt.includes('first only'), false);
  abort.abort();
  assert.equal(calls[0].options.signal.aborted, true);
});

test('real DSH default classifier follows the selected model without tools or previous group context', { timeout: 60000 }, async () => {
  const fixture = await createLocalDshFixture({ prefix: 'qq-classifier-real-model-', reply: () => '{"should_reply":true}' });
  const restore = useIsolatedEnv(fixture.root, { QQ_FIXTURE_API_KEY: 'synthetic-local-key' });
  try {
    const secondPatch = path.join(fixture.root, 'second-model.yml');
    await fs.writeFile(secondPatch, fixture.layer.replaceAll('test-chat', 'test-current-second'));
    const cfg = { dsh: { command: fixture.command, cwd: fixture.workspace, patchPath: fixture.patchPath, mode: 'headless' } };
    let model = { provider: 'test-local', model: 'test-chat', reasoningEffort: 'high' };
    let extraPatchPaths = [];
    const stateDir = path.join(fixture.root, 'state');
    const runner = createDefaultGroupClassifier({
      readConfig: () => cfg, modelPlan: () => ({ model, extraPatchPaths }),
      cwd: fixture.workspace, projectRoot: fixture.root, stateDir, patchPath: fixture.patchPath,
    });
    for (const [message, history] of [
      ['group-A-unique-1373', [{ role: 'assistant', text: 'group-A-answer-1534' }]],
      ['group-B-unique-2192', []],
    ]) {
      assert.deepEqual(await classifyGroupMessage({ message, history, timeoutMs: 45000, runDefaultModel: runner }), {
        eligible: true, reason: 'model_eligible',
      });
      model = { ...model, model: 'test-current-second' };
      extraPatchPaths = [secondPatch];
    }
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].model, 'test-chat');
    assert.equal(fixture.requests[1].model, 'test-current-second');
    for (const request of fixture.requests) {
      assert.equal(request.tools?.length ?? 0, 0);
      assert.equal(request.messages.some(entry => entry.role === 'tool'), false);
      assert.equal(request.messages.filter(entry => entry.role === 'user').length, 1);
    }
    assert.equal(JSON.stringify(fixture.requests[1].messages).includes('group-A-'), false);
    const sessionsRoot = path.join(stateDir, 'chat-only', 'sessions');
    const sessions = (await fs.readdir(sessionsRoot, { recursive: true })).filter(name => /^session\.v\d+\.jsonl$/.test(path.basename(name)));
    assert.equal(new Set(sessions.map(name => path.dirname(name))).size, 2);
  } finally {
    restore();
    await fixture.close();
  }
});
