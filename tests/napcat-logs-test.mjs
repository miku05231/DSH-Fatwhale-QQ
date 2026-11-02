import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createNapcatLogReader } from '../src/webui/napcat-logs.mjs';

const encoder = new TextEncoder();
const TEST_SECRET = 'reader-test-secret-8ac19';
const TEST_SESSION_KEY = createHash('sha256').update(`http://napcat.invalid\0${TEST_SECRET}`).digest('hex');

function makeProbe({ credential = 'session-secret-old', onForce, key = TEST_SESSION_KEY } = {}) {
  let current = credential;
  const calls = { check: 0, force: 0 };
  return {
    calls,
    check: async ({ force = false } = {}) => {
      calls.check += 1;
      if (force) {
        calls.force += 1;
        current = onForce ? onForce(current) : 'session-secret-new';
      }
      return {};
    },
    exportSession: () => ({ key, credential: current, expiresAt: Date.now() + 60_000 }),
  };
}

function makeStreamResponse() {
  let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; } });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  return { response, streamController };
}

function makeReader({ fetchImpl, healthProbe = makeProbe(), ...options } = {}) {
  return createNapcatLogReader({
    root: 'isolated-napcat-logs-test-root',
    config: {},
    healthProbe,
    readSettings: () => ({
      baseUrl: 'http://napcat.invalid',
      webuiEnabled: true,
      token: TEST_SECRET,
    }),
    fetchImpl,
    authTimeoutMs: 500,
    ...options,
  });
}

function wait(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: time + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const target = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        time = timer.at;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      time = target;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function event(level, message) {
  return `data: ${JSON.stringify({ level, message })}\n\n`;
}

test('opens on demand, returns before SSE ends, reuses the stream and reads new events', async (t) => {
  let fetchCount = 0;
  let stream;
  const reader = makeReader({
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      assert.equal(url, 'http://napcat.invalid/api/Log/GetLogRealTime');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, 'Bearer session-secret-old');
      stream = makeStreamResponse();
      return stream.response;
    },
  });
  t.after(() => reader.close());

  assert.equal(fetchCount, 0, 'reader connects lazily');
  const first = await reader.read(20);
  assert.equal(fetchCount, 1);
  assert.equal(first.missing, false);
  assert.match(first.message, /等待 NapCat 实时日志连接或新事件/);

  const second = await reader.read(20);
  assert.equal(second.missing, false);
  assert.equal(fetchCount, 1, 'polls reuse one live connection');

  stream.streamController.enqueue(encoder.encode(event('info', 'reader-test-event')));
  let latest = second;
  for (let attempt = 0; attempt < 30 && !latest.lines.length; attempt += 1) {
    await wait();
    latest = await reader.read(20);
  }
  assert.deepEqual(latest.lines, ['[info] reader-test-event']);
  assert.ok(latest.updatedAt);
  await reader.close();
});

test('keeps one pending opening request when the server delays SSE headers', async (t) => {
  let fetchCount = 0;
  let signal;
  let resolveHeaders;
  const clock = makeFakeClock();
  const responsePromise = new Promise((resolve) => { resolveHeaders = resolve; });
  const reader = makeReader({
    readWaitMs: 100,
    idleTtlMs: 30_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      signal = init.signal;
      return responsePromise;
    },
  });
  t.after(() => reader.close());

  const poll = async () => {
    const pending = reader.read(10);
    await clock.advance(100);
    return pending;
  };

  const first = await poll();
  assert.equal(first.missing, false);
  assert.deepEqual(first.lines, []);
  assert.equal(first.updatedAt, null);
  assert.match(first.message, /等待 NapCat 实时日志连接/);
  assert.equal(signal.aborted, false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clock.advance(9_000);
    const pending = await poll();
    assert.equal(pending.missing, false);
    assert.deepEqual(pending.lines, []);
    assert.equal(fetchCount, 1, 'polls across more than 30 simulated seconds reuse the opening request');
    assert.equal(signal.aborted, false);
  }
  assert.ok(clock.now() > 30_000);

  const stream = makeStreamResponse();
  resolveHeaders(stream.response);
  await wait();
  const connected = await poll();
  assert.equal(connected.missing, false);
  stream.streamController.enqueue(encoder.encode(event('info', 'after-delayed-headers')));
  let latest = connected;
  for (let attempt = 0; attempt < 30 && !latest.lines.length; attempt += 1) {
    await wait();
    latest = await reader.read(10);
  }
  assert.deepEqual(latest.lines, ['[info] after-delayed-headers']);
  assert.equal(fetchCount, 1);
});

test('aborts a pending headers fetch at idle TTL and reconnects on the next read', async (t) => {
  const clock = makeFakeClock();
  let fetchCount = 0;
  let firstSignal;
  let stream;
  const reader = makeReader({
    readWaitMs: 100,
    idleTtlMs: 3_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        firstSignal = init.signal;
        return new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        });
      }
      stream = makeStreamResponse();
      return stream.response;
    },
  });
  t.after(() => reader.close());
  const poll = async () => {
    const pending = reader.read(10);
    await clock.advance(100);
    return pending;
  };

  await poll();
  assert.equal(fetchCount, 1);
  assert.equal(firstSignal.aborted, false);
  await clock.advance(2_000);
  assert.equal(firstSignal.aborted, false);
  await poll();
  await clock.advance(2_999);
  assert.equal(firstSignal.aborted, false, 'each poll extends the idle TTL');
  await clock.advance(1);
  assert.equal(firstSignal.aborted, true, 'the pending request is aborted when the extended idle TTL expires');
  await wait();

  const reconnected = await poll();
  assert.equal(fetchCount, 2);
  assert.equal(reconnected.missing, false);
  assert.ok(stream);
});

test('bounds the ring and redacts credentials from live messages', async (t) => {
  const stream = makeStreamResponse();
  const reader = makeReader({
    maxLines: 2,
    fetchImpl: async () => stream.response,
  });
  t.after(() => reader.close());

  await reader.read(20);
  stream.streamController.enqueue(encoder.encode([
    event('info', 'first'),
    event('warn', `credential=${TEST_SECRET}`),
    event('error', 'last'),
  ].join('')));

  let latest;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait();
    latest = await reader.read(20);
    if (latest.lines.at(-1) === '[error] last') break;
  }
  assert.deepEqual(latest.lines, [`[warn] credential=${'***'}`, '[error] last']);
  assert.equal(JSON.stringify(latest).includes(TEST_SECRET), false);
  await reader.close();
});

test('parses CRLF split across chunks and accepts plain string SSE data', async (t) => {
  const stream = makeStreamResponse();
  const reader = makeReader({ fetchImpl: async () => stream.response });
  t.after(() => reader.close());

  await reader.read(10);
  stream.streamController.enqueue(encoder.encode('data: {"level":"info",\r'));
  stream.streamController.enqueue(encoder.encode('\ndata: "message":"crlf-across-chunks"}\r'));
  stream.streamController.enqueue(encoder.encode('\n\r\n'));
  stream.streamController.enqueue(encoder.encode('data: plain string log event\n\n'));

  let latest;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait();
    latest = await reader.read(10);
    if (latest.lines.at(-1) === 'plain string log event') break;
  }
  assert.deepEqual(latest.lines, ['[info] crlf-across-chunks', 'plain string log event']);
});

test('refreshes a rejected credential once and retries the SSE request once', async (t) => {
  const healthProbe = makeProbe({ onForce: () => 'session-secret-refreshed' });
  const streams = [];
  const authHeaders = [];
  let fetchCount = 0;
  const reader = makeReader({
    healthProbe,
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      authHeaders.push(init.headers.Authorization);
      if (fetchCount === 1) return new Response('', { status: 401 });
      const stream = makeStreamResponse();
      streams.push(stream);
      return stream.response;
    },
  });
  t.after(() => reader.close());

  const result = await reader.read(10);
  assert.equal(result.missing, false);
  assert.equal(fetchCount, 2);
  assert.deepEqual(authHeaders, ['Bearer session-secret-old', 'Bearer session-secret-refreshed']);
  assert.equal(healthProbe.calls.force, 1);
  assert.equal(JSON.stringify(result).includes('session-secret-refreshed'), false);
  await reader.close();
});

test('reports a fixed sanitized error after the single auth retry fails', async (t) => {
  const healthProbe = makeProbe({ onForce: () => 'second-secret' });
  let fetchCount = 0;
  const reader = makeReader({
    healthProbe,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response('', { status: fetchCount === 1 ? 403 : 401 });
    },
  });
  t.after(() => reader.close());

  const result = await reader.read(10);
  assert.equal(fetchCount, 2);
  assert.equal(healthProbe.calls.force, 1);
  assert.equal(result.missing, true);
  assert.equal(result.message, 'NapCat WebUI 认证失败，实时日志暂不可用');
  assert.equal(JSON.stringify(result).includes('http://napcat.invalid'), false);
  assert.equal(JSON.stringify(result).includes('second-secret'), false);
  await reader.close();
});

test('does not expose an oversized SSE event or a fetch error', async (t) => {
  const largeStream = makeStreamResponse();
  let fetchCount = 0;
  const reader = makeReader({
    maxEventBytes: 256,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return largeStream.response;
      throw new Error('https://napcat.invalid/api?token=network-secret');
    },
  });
  t.after(() => reader.close());

  await reader.read(10);
  largeStream.streamController.enqueue(encoder.encode(event('info', 'x'.repeat(1_000))));
  let result;
  for (let attempt = 0; attempt < 50 && fetchCount < 2; attempt += 1) {
    await wait();
    result = await reader.read(10);
  }
  assert.equal(fetchCount, 2);
  assert.equal(result.missing, true);
  assert.equal(result.message, 'NapCat 实时日志暂不可用');
  assert.equal(JSON.stringify(result).includes('network-secret'), false);
  assert.equal(JSON.stringify(result).includes('napcat.invalid'), false);
  await reader.close();
});

test('closes after the idle TTL and reconnects on the next read', async (t) => {
  const streams = [];
  const signals = [];
  const reader = makeReader({
    idleTtlMs: 25,
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      const stream = makeStreamResponse();
      streams.push(stream);
      return stream.response;
    },
  });
  t.after(() => reader.close());

  await reader.read(5);
  await wait(60);
  assert.equal(signals[0].aborted, true);
  await reader.read(5);
  assert.equal(signals.length, 2);
  await reader.close();
  assert.equal(signals[1].aborted, true);
});

test('missing credentials fail clearly without attempting network access', async (t) => {
  const healthProbe = {
    check: async () => ({}),
    exportSession: () => ({ credential: '', expiresAt: 0 }),
  };
  let fetchCount = 0;
  const reader = makeReader({
    healthProbe,
    fetchImpl: async () => { fetchCount += 1; throw new Error('should not be called'); },
  });
  t.after(() => reader.close());

  const result = await reader.read(5);
  assert.equal(result.missing, true);
  assert.equal(result.message, 'NapCat WebUI 认证不可用，实时日志暂不可用');
  assert.deepEqual(result.lines, []);
  assert.equal(fetchCount, 0);
  await reader.close();
});

test('does not send a credential when the health session key belongs to another origin', async (t) => {
  const healthProbe = makeProbe({
    key: createHash('sha256').update(`http://old-napcat.invalid\0${TEST_SECRET}`).digest('hex'),
  });
  let fetchCount = 0;
  const reader = makeReader({
    healthProbe,
    readSettings: () => ({
      baseUrl: 'http://new-napcat.invalid',
      webuiEnabled: true,
      token: TEST_SECRET,
    }),
    fetchImpl: async () => { fetchCount += 1; throw new Error('must not send stale credential'); },
  });
  t.after(() => reader.close());

  const result = await reader.read(5);
  assert.equal(result.missing, true);
  assert.equal(result.message, 'NapCat WebUI 认证不可用，实时日志暂不可用');
  assert.equal(fetchCount, 0);
  assert.equal(JSON.stringify(result).includes('new-napcat.invalid'), false);
});
