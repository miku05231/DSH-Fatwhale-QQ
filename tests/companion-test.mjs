// tests/companion-test.mjs —— 桌面端连伴插件 + 桥接客户端 + 安装器
//
// 不启动 DSH：用本机 HTTP 假服务验证 discovery/鉴权/超时/错误语义；
// 安装器在临时 DSH_HOME 上真实执行一遍安装+卸载，不碰真实 profile。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadConfig } from '../src/config.js';
import {
  probeCompanion,
  readCompanionDiscovery,
  resolveCompanionDiscoveryPath,
  runCompanionDsh,
  fetchCompanionModelCatalog,
} from '../src/dsh-companion.js';
import { runAgent } from '../src/agent-runner.js';
import { apply as applyCompanion } from '../src/companion/lib/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-companion-'));
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const HEALTH = { ok: true, pid: process.pid, permissionProtocol: 1, permissionModes: PERMISSION_MODES, modelProtocol: 1 };
let passed = 0;

function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function okAsync(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const discoveryPath = path.join(tmp, 'discovery.json');
const cfg = { dsh: { companionDiscovery: discoveryPath } };

function writeDiscovery(port, overrides = {}) {
  fs.writeFileSync(
    discoveryPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      token: TOKEN,
      startedAt: new Date().toISOString(),
      ...overrides,
    }),
  );
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function bounded(promise, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('测试等待超时')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function callPlugin(info, pathname, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(pathname === '/prompt' ? { permissionMode: 'workspace-write', ...body } : body);
    const req = http.request({
      host: '127.0.0.1',
      port: info.port,
      method: 'POST',
      path: pathname,
      headers: {
        authorization: `Bearer ${info.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      agent: false,
    }, async (res) => {
      try {
        resolve({ status: res.statusCode, body: JSON.parse(await readBody(res)) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function pluginFixture({
  cancel = () => ({ accepted: true }), promptTimeoutMs, idle = false, complete = false, permissionService,
  historicalSessions, sessionHeaders = {}, resolveModel, resolveSession,
  turnModels, turnEvents, catalog,
} = {}) {
  const pluginDiscovery = path.join(tmp, `plugin-${randomUUID()}.json`);
  const calls = {
    cancelled: 0, flushed: 0, prompted: 0, created: 0, permissions: [], warnings: [], attached: [], observed: [],
    modelSignals: [], selections: [], restored: [], admissions: 0,
  };
  let historyAttached;
  const historyFinished = new Promise((resolve) => { historyAttached = resolve; });
  const workspace = {
    id: 'fixture-workspace',
    path: tmp,
    sessionIds: [],
    attachSession: async (sessionId) => { calls.attached.push(sessionId); },
  };
  const sessionMapPath = `${pluginDiscovery}.sessions.json`;
  if (historicalSessions !== undefined) {
    fs.writeFileSync(sessionMapPath, JSON.stringify(historicalSessions));
  }
  let dispose;
  let started;
  const promptStarted = new Promise((resolve) => { started = resolve; });
  let flushed;
  const sessionFlushed = new Promise((resolve) => { flushed = resolve; });
  const events = [];
  const session = { seq: 0, eventAt: (seq) => events[seq] };
  const agent = { session, whenIdle: () => complete ? Promise.resolve() : new Promise(() => {}) };
  let selected;
  let effectivePermission = 'danger-full-access';
  const controller = {
    ...(catalog ? { modelCatalog: async () => catalog } : {}),
    ...(resolveSession ? { resolveAgent: async (sessionId) => {
      calls.restored.push(sessionId);
      return await resolveSession(sessionId, agent) ?? agent;
    } } : {}),
    create: async () => {
      calls.created += 1;
      return { sessionId: 'fixture-session' };
    },
    prompt: () => {
      calls.prompted += 1;
      started();
      if (idle || complete) {
        if (turnEvents) {
          events.push(...turnEvents({ turn: calls.prompted, selected }));
        } else {
          for (const model of turnModels ?? (selected ? [selected] : [])) {
            events.push({ type: 'request/header', data: { header: { config: model } } });
            events.push({ type: 'assistant/message', data: { message: {
              source: { kind: 'llm', provider: model.provider, model: model.model },
              content: [{ type: 'text', text: 'test reply' }],
            } } });
          }
        }
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'test reply' }] } },
        });
        session.seq = events.length;
        return Promise.resolve();
      }
      return new Promise(() => {});
    },
    cancel: () => {
      calls.cancelled += 1;
      return cancel();
    },
  };
  const services = {
    sessionController: controller,
    workspaceRegistry: { list: () => historicalSessions === undefined ? [] : [workspace] },
    sessionQuery: {
      observeSession: async (sessionId) => {
        calls.observed.push(sessionId);
        if (!Object.hasOwn(sessionHeaders, sessionId)) throw new Error('fixture session not found');
        return { header: sessionHeaders[sessionId] };
      },
    },
    agents: {
      get: () => agent,
      serializeImageAdmission: async (_agent, operation) => { calls.admissions += 1; return operation(); },
      selectForNextRequest: (_agent, model) => {
        calls.selections.push(model);
        selected = model;
        events.push({ type: 'model/selection', data: model });
        session.seq = events.length;
      },
    },
    llm: {
      resolveCallConfig: (model, signal) => {
        calls.modelSignals.push(signal);
        return resolveModel ? resolveModel(model, signal) : Promise.resolve(model);
      },
    },
    sessions: { flush: async () => { calls.flushed += 1; flushed(); } },
    permissionPresets: permissionService === undefined ? {
      names: PERMISSION_MODES,
      resolve: (mode) => {
        if (!PERMISSION_MODES.includes(mode)) throw new Error('unknown preset');
        return { sandbox: mode, approval: mode === 'danger-full-access' ? 'never' : 'ask' };
      },
      set: (targetSession, mode) => {
        assert.equal(targetSession, session);
        calls.permissions.push(mode);
        effectivePermission = mode;
      },
      current: (targetSession) => {
        assert.equal(targetSession, session);
        return effectivePermission;
      },
    } : permissionService,
  };
  controller.agents = {
    selectForNextRequest: services.agents.selectForNextRequest,
    serializeImageAdmission: services.agents.serializeImageAdmission,
  };
  delete services.agents.selectForNextRequest;
  delete services.agents.serializeImageAdmission;
  await applyCompanion({
    get: (name) => services[name],
    logger: {
      warn: (line) => calls.warnings.push(line),
      info: (line) => { if (line.includes('已把')) historyAttached(); },
    },
    effect: (register) => { dispose = register(); },
  }, {
    discoveryPath: pluginDiscovery,
    ...(promptTimeoutMs ? { promptTimeoutMs } : {}),
    ...(historicalSessions === undefined ? {} : { workspacePath: tmp, sessionMapPath }),
  });
  const info = JSON.parse(fs.readFileSync(pluginDiscovery, 'utf8'));
  return {
    info,
    cfg: { dsh: { companionDiscovery: pluginDiscovery } },
    calls,
    promptStarted,
    sessionFlushed,
    historyFinished,
    session,
    dispose,
  };
}

// ---------------------------------------------------------------- discovery
ok('discovery 默认路径 = $DSH_HOME/qq-bridge-companion.json', () => {
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmp, 'home');
  try {
    assert.equal(
      resolveCompanionDiscoveryPath({ dsh: {} }),
      path.join(tmp, 'home', 'qq-bridge-companion.json'),
    );
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});

ok('discovery 文件缺失/损坏返回 null', () => {
  assert.equal(readCompanionDiscovery(cfg), null);
  fs.writeFileSync(discoveryPath, '{oops');
  assert.equal(readCompanionDiscovery(cfg), null);
  writeDiscovery(1, { token: 'short' });
  assert.equal(readCompanionDiscovery(cfg), null);
});

await okAsync('probeCompanion：没有文件时不可用且给出原因', async () => {
  fs.rmSync(discoveryPath, { force: true });
  const result = await probeCompanion(cfg);
  assert.equal(result.available, false);
  assert.match(result.reason, /discovery/);
});
await okAsync('runCompanionDsh：discovery 缺失或进程过期明确标记请求尚未接收', async () => {
  for (const code of ['companion/missing', 'companion/stale']) {
    if (code === 'companion/missing') fs.rmSync(discoveryPath, { force: true });
    else writeDiscovery(1, { pid: 2_147_483_647 });
    await assert.rejects(
      () => runCompanionDsh('not submitted', { cfg, sessionId: 'old-session', cwd: tmp }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.companion, true);
        assert.equal(error.channelError, true);
        assert.equal(error.sessionAccepted, false);
        assert.equal(error.sessionId, undefined);
        return true;
      },
    );
  }
});
// ---------------------------------------------------------------- HTTP 协议
await okAsync('probeCompanion：health 校验 token 并返回 pid', async () => {
  const server = await listen((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...HEALTH, version: 1 }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    const result = await probeCompanion(cfg);
    assert.equal(result.available, true);
    assert.equal(result.info.port, port);
    assert.equal(result.health.pid, process.pid);
  } finally {
    await close(server);
  }
});

await okAsync('probeCompanion：旧插件或缺失目标权限能力不得接收对话', async () => {
  for (const health of [
    { ok: true, pid: process.pid },
    { ...HEALTH, permissionModes: ['danger-full-access'] },
  ]) {
    const server = await listen((_req, res) => res.end(JSON.stringify(health)));
    writeDiscovery(server.address().port);
    try {
      const result = await probeCompanion(cfg);
      assert.equal(result.available, false);
      assert.match(result.reason, /权限/);
    } finally {
      await close(server);
    }
  }
});

await okAsync('runCompanionDsh：发 text/workspace/model，返回 final 文本', async () => {
  let received = null;
  const server = await listen(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    received = JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        sessionId: 'session-test-1',
        text: 'pong',
        elapsedMs: 12,
        workspaceId: 'ws-test',
      }),
    );
  });
  const { port } = server.address();
  writeDiscovery(port);
  const logs = [];
  try {
    const result = await runCompanionDsh('ping', {
      cfg,
      cwd: 'C:/work/qq-workspace',
      model: { provider: 'relay-a', model: 'm1' },
      log: { info: (line) => logs.push(line), warn: () => {} },
    });
    assert.equal(result.sessionId, 'session-test-1');
    assert.equal(result.finalText, 'pong');
    assert.equal(result.workspaceId, 'ws-test');
    assert.equal(received.text, 'ping');
    assert.equal(received.workspacePath, 'C:/work/qq-workspace');
    assert.deepEqual(received.model, { provider: 'relay-a', model: 'm1' });
    assert.equal(received.permissionMode, 'workspace-write');
    assert.match(logs.join('\n'), /session-test-1/);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：超时优先使用本轮选项，其次使用配置值', async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.end(JSON.stringify({ ok: true, sessionId: 'timeout-priority', text: 'ok' }));
  });
  writeDiscovery(server.address().port);
  const timeoutCfg = { dsh: { ...cfg.dsh, timeoutMs: 12_345 } };
  try {
    await runCompanionDsh('config timeout', { cfg: timeoutCfg });
    await runCompanionDsh('request timeout', { cfg: timeoutCfg, timeoutMs: 23_456 });
    await runCompanionDsh('null uses config timeout', { cfg: timeoutCfg, timeoutMs: null });
    assert.deepEqual(received.map((body) => body.timeoutMs), [12_345, 23_456, 12_345]);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：HTTP 错误保留 sessionId，标记 sessionAccepted', async () => {
  const server = await listen((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'model failed', sessionId: 'session-test-2' }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    await assert.rejects(
      () => runCompanionDsh('boom', { cfg, cwd: tmp }),
      (error) => {
        assert.equal(error.sessionAccepted, true);
        assert.equal(error.sessionId, 'session-test-2');
        assert.match(error.message, /model failed/);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：连不上时 channelError 且可安全回退', async () => {
  const server = await listen((req, res) => res.end());
  const { port } = server.address();
  await close(server);
  writeDiscovery(port);
  await assert.rejects(
    () => runCompanionDsh('x', { cfg, cwd: tmp }),
    (error) => {
      assert.equal(error.channelError, true);
      assert.equal(error.sessionAccepted, false);
      return true;
    },
  );
});

await okAsync('runCompanionDsh：宿主收到请求后断开连接不得标记可回退', async () => {
  let received = 0;
  const server = await listen(async (req) => {
    await readBody(req);
    received += 1;
    req.socket.destroy();
  });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(
      () => bounded(runCompanionDsh('execute once', { cfg, cwd: tmp })),
      (error) => {
        assert.equal(error.channelError, undefined);
        assert.equal(error.sessionAccepted, true);
        return true;
      },
    );
    assert.equal(received, 1);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：响应截断及时失败且不得重跑', async () => {
  const server = await listen(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 200 });
    res.write('{"ok":true,');
    setImmediate(() => res.destroy());
  });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(
      () => bounded(runCompanionDsh('x', { cfg, cwd: tmp })),
      (error) => {
        assert.equal(error.channelError, undefined);
        assert.equal(error.sessionAccepted, true);
        assert.match(error.message, /中断|完整|aborted|reset/i);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：主动取消不得回退或留下未结算请求', async () => {
  const controller = new AbortController();
  let received = 0;
  const server = await listen(async (req) => {
    await readBody(req);
    received += 1;
    controller.abort();
  });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(
      () => bounded(runCompanionDsh('x', { cfg, cwd: tmp, signal: controller.signal })),
      (error) => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.channelError, undefined);
        assert.equal(error.sessionAccepted, true);
        return true;
      },
    );
    assert.equal(received, 1);
  } finally {
    await close(server);
  }
});

await okAsync('runCompanionDsh：响应超时不得误判连接失败并重跑', async () => {
  const server = await listen(async (req) => { await readBody(req); });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(
      () => bounded(runCompanionDsh('x', { cfg, cwd: tmp, timeoutMs: 1 }), 7_000),
      (error) => {
        assert.equal(error.channelError, undefined);
        assert.equal(error.sessionAccepted, true);
        assert.match(error.message, /超时/);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

await okAsync('runAgent：companion 可用时优先走 companion', async () => {
  const fakeDshDir = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh');
  const fakeBin = path.join(fakeDshDir, 'lib', 'bin.js');
  const fakeProfile = path.join(tmp, 'profiles', 'desktop');
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.mkdirSync(fakeProfile, { recursive: true });
  fs.writeFileSync(
    path.join(fakeDshDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }),
  );
  fs.writeFileSync(fakeBin, '// fake bin\n');
  fs.writeFileSync(path.join(fakeProfile, 'package.json'), '{"name":"fake-desktop"}\n');
  const server = await listen((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify(HEALTH));
      return;
    }
    res.end(JSON.stringify({ ok: true, sessionId: 'session-route', text: 'via-companion' }));
  });
  const { port } = server.address();
  writeDiscovery(port);
  try {
    const result = await runAgent('hi', {
      cfg: {
        security: { adminUserIds: [123456] },
        dsh: {
          mode: 'desktop',
          command: fakeBin,
          desktopProfile: fakeProfile,
          companionDiscovery: discoveryPath,
        },
      },
      requesterId: 123456,
      cwd: tmp,
      log: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.finalText, 'via-companion');
    assert.equal(result.sessionId, 'session-route');
  } finally {
    await close(server);
  }
});

await okAsync('runAgent：旧连伴未加载切模协议时明确报错，不提交或回退重跑', async () => {
  let prompts = 0;
  const server = await listen((_req, res) => {
    if (_req.url === '/prompt') prompts += 1;
    res.end(JSON.stringify({ ...HEALTH, modelProtocol: undefined }));
  });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(() => runAgent('do not execute with an old companion', {
      cfg: { security: { adminUserIds: [123456] }, dsh: {
        mode: 'desktop', companionDiscovery: discoveryPath,
      } }, requesterId: 123456, cwd: tmp,
      model: { provider: 'fixture', model: 'new-model' },
    }), (error) => error.code === 'companion/model-unavailable' && !error.channelError && /重启/.test(error.message));
    assert.equal(prompts, 0);
  } finally { await close(server); }
});

await okAsync('runAgent：探测成功后 discovery 消失或过期只安全回退执行一次', async () => {
  const fallbackBin = path.join(tmp, 'preflight-fallback.cjs');
  const marker = path.join(tmp, 'preflight-fallback-calls.jsonl');
  const patch = path.join(tmp, 'preflight-fallback.yml');
  fs.writeFileSync(patch, '[]\n');
  fs.writeFileSync(fallbackBin, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    'console.log(JSON.stringify({type:"session",sessionId:"session-safe-fallback"}));',
    'console.log(JSON.stringify({type:"final",text:"safe-fallback"}));',
  ].join('\n'));
  for (const stale of [false, true]) {
    fs.rmSync(marker, { force: true });
    let prompts = 0;
    const warnings = [];
    const server = await listen(async (req, res) => {
      if (req.url === '/health') {
        if (stale) writeDiscovery(server.address().port, { pid: 2_147_483_647 });
        else fs.rmSync(discoveryPath, { force: true });
        res.end(JSON.stringify(HEALTH));
        return;
      }
      await readBody(req);
      prompts += 1;
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: 'prompt must not be sent' }));
    });
    writeDiscovery(server.address().port);
    try {
      const result = await bounded(runAgent('execute once', {
        cfg: {
          security: { adminUserIds: [123456] },
          dsh: {
            mode: 'desktop',
            command: fallbackBin,
            companionDiscovery: discoveryPath,
            patchPath: patch,
            fallbackToHeadless: true,
            timeoutMs: 5_000,
          },
        },
        requesterId: 123456,
        cwd: tmp,
        log: { info: () => {}, warn: (line) => warnings.push(line) },
      }), 10_000);
      assert.equal(result.finalText, 'safe-fallback');
      assert.equal(result.sessionId, 'session-safe-fallback');
      assert.equal(prompts, 0);
      assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
      assert(warnings.some((line) => line.includes('连伴连接失败')));
    } finally {
      await close(server);
    }
  }
});

await okAsync('runAgent：已被 companion 接收的断线请求不回退独立宿主', async () => {
  let prompts = 0;
  const warnings = [];
  const server = await listen(async (req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify(HEALTH));
      return;
    }
    await readBody(req);
    prompts += 1;
    req.socket.destroy();
  });
  writeDiscovery(server.address().port);
  try {
    await assert.rejects(
      () => bounded(runAgent('execute once', {
        cfg: {
          security: { adminUserIds: [123456] },
          dsh: {
            mode: 'desktop',
            command: path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
            desktopProfile: path.join(tmp, 'profiles', 'desktop'),
            companionDiscovery: discoveryPath,
          },
        },
        requesterId: 123456,
        cwd: tmp,
        log: { info: () => {}, warn: (line) => warnings.push(line) },
      })),
      (error) => {
        assert.equal(error.companion, true);
        assert.equal(error.channelError, undefined);
        assert.equal(error.sessionAccepted, true);
        return true;
      },
    );
    assert.equal(prompts, 1);
    assert.deepEqual(warnings, []);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------- 真实插件 + 隔离宿主服务
await okAsync('真实插件：历史挂载仅包含已存在的桌面会话，不泄漏普通聊天', async () => {
  const fixture = await pluginFixture({
    historicalSessions: {
      chat: 'qq-chat-ordinary-private',
      groupChat: 'qq-chat-ordinary-group',
      missing: 'desktop-missing',
      noHeader: 'desktop-no-header',
      otherWorkspace: 'desktop-other-workspace',
      old: 'desktop-too-old',
      valid: 'desktop-valid',
      duplicate: 'desktop-valid',
      timed: { sessionId: 'desktop-timed', startedAt: Date.now() },
      timedDuplicate: { sessionId: 'desktop-timed', startedAt: Date.now() },
      timedChat: { sessionId: 'qq-chat-timed', startedAt: Date.now() },
    },
    sessionHeaders: {
      'qq-chat-ordinary-private': { cwd: tmp, createdAt: Date.now() },
      'qq-chat-ordinary-group': { cwd: tmp, createdAt: Date.now() },
      'desktop-no-header': undefined,
      'desktop-other-workspace': { cwd: path.join(tmp, 'other'), createdAt: Date.now() },
      'desktop-too-old': { cwd: tmp, createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
      'desktop-valid': { cwd: tmp, createdAt: Date.now() },
      'desktop-timed': { cwd: tmp, createdAt: Date.now() },
      'qq-chat-timed': { cwd: tmp, createdAt: Date.now() },
    },
  });
  try {
    await bounded(fixture.historyFinished);
    assert.deepEqual(fixture.calls.attached, ['desktop-valid', 'desktop-timed']);
    assert.equal(fixture.calls.observed.some((id) => id.startsWith('qq-chat-')), false);
    assert.equal(fixture.calls.created, 0);
    assert.equal(fixture.calls.prompted, 0);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：正常完成返回最终文本且不执行取消', async () => {
  const fixture = await pluginFixture({ complete: true });
  try {
    const result = await bounded(runCompanionDsh('complete', { cfg: fixture.cfg }));
    assert.equal(result.finalText, 'test reply');
    assert.equal(result.sessionId, 'fixture-session');
    assert.equal(fixture.calls.cancelled, 0);
    assert.equal(fixture.calls.flushed, 1);
    assert.deepEqual(fixture.calls.permissions, ['workspace-write']);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：非法模型组合不得继续用旧模型回答，修正后复用同一会话', async () => {
  const fixture = await pluginFixture({
    complete: true,
    resolveSession: (_id, agent) => agent,
    resolveModel: (model) => {
      if (model.reasoningEffort === 'low') throw new Error('UNSUPPORTED_REASONING_EFFORT: off, high, max');
      return model;
    },
  });
  try {
    await assert.rejects(() => runCompanionDsh('invalid selection', {
      cfg: fixture.cfg, sessionId: 'fixture-session',
      model: { provider: 'fixture', model: 'new-model', reasoningEffort: 'low' },
    }), (error) => {
      assert.equal(error.code, 'companion/model-unavailable');
      assert.equal(error.sessionAccepted, true);
      assert.equal(error.channelError, undefined);
      assert.equal(error.sessionId, 'fixture-session');
      return true;
    });
    assert.equal(fixture.calls.prompted, 0);
    assert.deepEqual(fixture.calls.selections, []);
    const result = await runCompanionDsh('valid retry', {
      cfg: fixture.cfg, sessionId: 'fixture-session',
      model: { provider: 'fixture', model: 'new-model', reasoningEffort: 'high' },
    });
    assert.equal(result.sessionId, 'fixture-session');
    assert.equal(fixture.calls.created, 0);
    assert.equal(fixture.calls.prompted, 1);
    assert.deepEqual(result.model, { provider: 'fixture', model: 'new-model', reasoningEffort: 'high' });
    assert.equal(fixture.calls.admissions, 2);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：切换 provider/model/effort 持久选择且保留同一会话', async () => {
  const fixture = await pluginFixture({ complete: true, resolveSession: (_id, agent) => agent });
  try {
    const models = [
      { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'low' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ];
    let sessionId;
    for (const model of models) {
      const result = await runCompanionDsh('switch', { cfg: fixture.cfg, sessionId, model });
      sessionId ??= result.sessionId;
      assert.equal(result.sessionId, sessionId);
      assert.deepEqual(result.model, model);
      assert.deepEqual(result.modelsUsed, [model]);
    }
    assert.equal(fixture.calls.created, 1);
    assert.deepEqual(fixture.calls.selections, models);
    const logged = Array.from({ length: fixture.session.seq }, (_, seq) => fixture.session.eventAt(seq));
    assert.deepEqual(logged.filter((event) => event.type === 'model/selection').map((event) => event.data), models);
  } finally { fixture.dispose(); }
});

await okAsync('真实插件：返回本轮实际路由及去重列表，不照抄目标或前一轮', async () => {
  const actual = [
    { provider: 'route-a', model: 'actual-a', reasoningEffort: 'high' },
    { provider: 'route-b', model: 'actual-b' },
  ];
  const fixture = await pluginFixture({ complete: true, turnModels: [...actual, actual[0]] });
  try {
    const result = await runCompanionDsh('routed', {
      cfg: fixture.cfg, model: { provider: 'requested', model: 'target' },
    });
    assert.deepEqual(result.model, actual[0]);
    assert.deepEqual(result.modelsUsed, actual);
  } finally { fixture.dispose(); }
});

await okAsync('真实插件：省略重复请求头时继承实际 effort，不照抄本轮请求目标', async () => {
  const actual = { provider: 'actual-route', model: 'actual-model', reasoningEffort: 'high' };
  const source = { provider: actual.provider, model: actual.model };
  const target = { ...source, reasoningEffort: 'max' };
  const fixture = await pluginFixture({
    complete: true,
    turnEvents: ({ turn }) => [
      ...(turn === 1 ? [{ type: 'request/header', data: { header: { config: actual } } }] : []),
      { type: 'assistant/message', data: { message: { source: { kind: 'llm', ...source } } } },
    ],
  });
  try {
    const first = await runCompanionDsh('actual header first round', { cfg: fixture.cfg, model: actual });
    assert.deepEqual(first.model, actual);
    const continued = await runCompanionDsh('same actual config without another header', {
      cfg: fixture.cfg, sessionId: first.sessionId, model: target,
    });
    assert.equal(continued.sessionId, first.sessionId);
    assert.deepEqual(fixture.calls.selections, [actual, target]);
    assert.deepEqual(continued.model, actual, 'the effective actual header remains authoritative instead of requested max');
    assert.deepEqual(continued.modelsUsed, [actual]);
  } finally { fixture.dispose(); }
});

await okAsync('真实插件：省略请求头时不同路由或模型不能继承前轮 effort', async () => {
  for (const source of [
    { provider: 'different-route', model: 'actual-model' },
    { provider: 'actual-route', model: 'different-model' },
  ]) {
    const previous = { provider: 'actual-route', model: 'actual-model', reasoningEffort: 'high' };
    const fixture = await pluginFixture({
      complete: true,
      turnEvents: ({ turn }) => turn === 1
        ? [{ type: 'request/header', data: { header: { config: previous } } },
          { type: 'assistant/message', data: { message: { source: { kind: 'llm', provider: previous.provider, model: previous.model } } } }]
        : [{ type: 'assistant/message', data: { message: { source: { kind: 'llm', ...source } } } }],
    });
    try {
      const first = await runCompanionDsh('previous actual route', { cfg: fixture.cfg, model: previous });
      const continued = await runCompanionDsh('different actual source without another header', {
        cfg: fixture.cfg, sessionId: first.sessionId, model: { ...source, reasoningEffort: 'max' },
      });
      assert.equal(continued.sessionId, first.sessionId);
      assert.deepEqual(continued.model, source);
      assert.deepEqual(continued.modelsUsed, [source]);
    } finally { fixture.dispose(); }
  }
});

await okAsync('真实插件：本轮新请求头无 effort 时清除同模型前轮 effort', async () => {
  const source = { provider: 'actual-route', model: 'actual-model' };
  const previous = { ...source, reasoningEffort: 'high' };
  const fixture = await pluginFixture({
    complete: true,
    turnEvents: ({ turn }) => [
      { type: 'request/header', data: { header: { config: turn === 1 ? previous : source } } },
      { type: 'assistant/message', data: { message: { source: { kind: 'llm', ...source } } } },
    ],
  });
  try {
    const first = await runCompanionDsh('explicit high actual header', { cfg: fixture.cfg, model: previous });
    assert.deepEqual(first.model, previous);
    const continued = await runCompanionDsh('new actual header clears effort', {
      cfg: fixture.cfg, sessionId: first.sessionId, model: { ...source, reasoningEffort: 'max' },
    });
    assert.equal(continued.sessionId, first.sessionId);
    assert.deepEqual(continued.model, source);
    assert.deepEqual(continued.modelsUsed, [source]);
  } finally { fixture.dispose(); }
});

await okAsync('真实插件：模型目录只包含公开能力，旧宿主返回 null', async () => {
  const fixture = await pluginFixture({ catalog: {
    default: { provider: 'private-default' },
    failures: [{ message: 'secret diagnostic' }],
    groups: [{ id: 'p', apiKey: 'private-key', models: [
      { id: 'reasoning', reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
      { id: 'plain' },
    ] }],
  } });
  const legacy = await pluginFixture();
  try {
    assert.equal((await probeCompanion(fixture.cfg)).health.modelProtocol, 1);
    assert.deepEqual(await fetchCompanionModelCatalog(fixture.cfg), { providers: [{ id: 'p', models: [
      { id: 'reasoning', reasoning: { status: 'known', efforts: ['off', 'high', 'max'], defaultEffort: 'high' } },
      { id: 'plain', reasoning: { status: 'none', efforts: [] } },
    ] }] });
    assert.equal(await fetchCompanionModelCatalog(legacy.cfg), null);
    assert.equal(fixture.calls.created, 0);
    assert.equal(fixture.calls.prompted, 0);
  } finally { fixture.dispose(); legacy.dispose(); }
});

await okAsync('真实插件：已有对话通过宿主恢复，不再调用 create 换 ID', async () => {
  for (const wrapped of [false, true]) {
    const fixture = await pluginFixture({
      complete: true, resolveSession: (_id, agent) => wrapped ? { agent } : agent,
    });
    try {
      const first = await runCompanionDsh('first', { cfg: fixture.cfg });
      const second = await runCompanionDsh('continue', { cfg: fixture.cfg, sessionId: first.sessionId });
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(fixture.calls.created, 1);
      assert.deepEqual(fixture.calls.restored, [first.sessionId]);
      assert.deepEqual(fixture.calls.permissions, ['workspace-write', 'workspace-write']);
      assert.equal(fixture.calls.prompted, 2);
    } finally {
      fixture.dispose();
    }
  }
});

await okAsync('真实插件：恢复失败保留宿主错误，不偷偷创建替代会话', async () => {
  for (const wrapped of [false, true]) {
    const fixture = await pluginFixture({
      complete: true, resolveSession: () => {
        const error = new Error('session/not-found');
        if (wrapped) return { error };
        throw error;
      },
    });
    try {
      await assert.rejects(
        () => runCompanionDsh('missing', { cfg: fixture.cfg, sessionId: 'missing-session' }),
        /session\/not-found/,
      );
      assert.equal(fixture.calls.created, 0);
      assert.equal(fixture.calls.prompted, 0);
    } finally {
      fixture.dispose();
    }
  }
});

await okAsync('真实插件：逐请求应用三种权限，不沿用旧会话的高权限', async () => {
  const fixture = await pluginFixture({ complete: true });
  try {
    const probe = await probeCompanion(fixture.cfg);
    assert.equal(probe.available, true);
    assert.deepEqual(probe.health.permissionModes, PERMISSION_MODES);
    for (const permissionMode of ['workspace-write', 'danger-full-access', 'read-only']) {
      const result = await runCompanionDsh('permissions', {
        cfg: { dsh: { ...fixture.cfg.dsh, permissionMode } },
        sessionId: 'fixture-session',
      });
      assert.equal(result.finalText, 'test reply');
    }
    assert.deepEqual(fixture.calls.permissions, ['workspace-write', 'danger-full-access', 'read-only']);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：缺少权限服务在创建或执行会话前拒绝', async () => {
  const fixture = await pluginFixture({ permissionService: null });
  try {
    assert.equal((await probeCompanion(fixture.cfg)).available, false);
    await assert.rejects(() => runCompanionDsh('denied', { cfg: fixture.cfg }), (error) => {
      assert.equal(error.code, 'companion/permission-unsupported');
      assert.equal(error.sessionAccepted, false);
      assert.equal(error.channelError, true);
      return true;
    });
    assert.equal(fixture.calls.created, 0);
    assert.equal(fixture.calls.prompted, 0);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：缺失或无效权限参数不会继承宿主权限', async () => {
  const fixture = await pluginFixture();
  try {
    for (const permissionMode of [undefined, '', 'custom']) {
      const result = await callPlugin(fixture.info, '/prompt', { text: 'denied', permissionMode });
      assert.equal(result.body.code, 'companion/permission-unsupported');
      assert.equal(result.body.sessionAccepted, false);
    }
    assert.equal(fixture.calls.created, 0);
    assert.equal(fixture.calls.prompted, 0);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：同名预设有高权限时不误信名称，选取匹配的安全预设', async () => {
  let current = 'workspace-write';
  const selected = [];
  const service = {
    names: ['workspace-write', 'safe-workspace'],
    resolve: (name) => {
      if (name === 'workspace-write') return { sandbox: 'danger-full-access', approval: 'never' };
      if (name === 'safe-workspace') return { sandbox: 'workspace-write', approval: 'ask' };
      throw new Error('unknown preset');
    },
    set: (_session, name) => { selected.push(name); current = name; },
    current: () => current,
  };
  const fixture = await pluginFixture({ permissionService: service, complete: true });
  try {
    assert.equal((await probeCompanion(fixture.cfg)).available, true);
    await runCompanionDsh('safe alias', { cfg: fixture.cfg });
    assert.deepEqual(selected, ['safe-workspace']);
    assert.equal(fixture.calls.prompted, 1);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：权限应用无效或抛错时不调用 prompt', async () => {
  for (const set of [() => {}, () => { throw new Error('cannot set'); }]) {
    const fixture = await pluginFixture({
      permissionService: {
        names: ['workspace-write', 'danger-full-access'],
        resolve: (mode) => ({
          sandbox: mode, approval: mode === 'danger-full-access' ? 'never' : 'ask',
        }),
        set,
        current: () => 'danger-full-access',
      },
    });
    try {
      await assert.rejects(() => runCompanionDsh('denied', { cfg: fixture.cfg }), (error) => {
        assert.equal(error.code, 'companion/permission-unsupported');
        assert.equal(error.sessionAccepted, false);
        return true;
      });
      assert.equal(fixture.calls.prompted, 0);
      assert.equal(fixture.calls.flushed, 1);
    } finally {
      fixture.dispose();
    }
  }
});

await okAsync('真实插件：权限应用期间断线不提交或取消其它宿主任务', async () => {
  let applying;
  const permissionStarted = new Promise((resolve) => { applying = resolve; });
  let release;
  const permissionReady = new Promise((resolve) => { release = resolve; });
  const fixture = await pluginFixture({
    permissionService: {
      names: ['workspace-write'],
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
      current: () => 'workspace-write',
      set: async () => { applying(); await permissionReady; },
    },
  });
  const controller = new AbortController();
  try {
    const pending = runCompanionDsh('abort before prompt', { cfg: fixture.cfg, signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
    await bounded(permissionStarted);
    controller.abort();
    await bounded(rejected);
    await bounded(fixture.sessionFlushed);
    release();
    assert.equal(fixture.calls.prompted, 0);
    assert.equal(fixture.calls.cancelled, 0);
  } finally {
    release();
    fixture.dispose();
  }
});

await okAsync('真实插件：模型查询挂起时断线及时清理，同一会话仍可继续', async () => {
  let resolving;
  const modelStarted = new Promise((resolve) => { resolving = resolve; });
  const fixture = await pluginFixture({
    complete: true,
    resolveModel: () => { resolving(); return new Promise(() => {}); },
  });
  const controller = new AbortController();
  try {
    const pending = runCompanionDsh('cancel model lookup', {
      cfg: fixture.cfg,
      model: { provider: 'fixture', model: 'pending-model' },
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
    await bounded(modelStarted);
    controller.abort();
    await bounded(rejected);
    await bounded(fixture.sessionFlushed);
    assert.equal(fixture.calls.modelSignals[0].aborted, true);
    assert.equal(fixture.calls.prompted, 0);
    assert.equal(fixture.calls.cancelled, 0);
    assert.deepEqual(fixture.calls.selections, []);
    const next = await bounded(runCompanionDsh('next message', { cfg: fixture.cfg }));
    assert.equal(next.finalText, 'test reply');
    assert.equal(fixture.calls.prompted, 1);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：模型查询挂起受请求超时限制，后续请求不被锁住', async () => {
  const fixture = await pluginFixture({
    complete: true,
    promptTimeoutMs: 30,
    resolveModel: () => new Promise(() => {}),
  });
  try {
    const result = await bounded(callPlugin(fixture.info, '/prompt', {
      text: 'timeout model lookup', model: { provider: 'fixture', model: 'pending-model' },
    }));
    assert.equal(result.status, 500);
    assert.match(result.body.error, /超时/);
    assert.equal(fixture.calls.modelSignals[0].aborted, true);
    assert.equal(fixture.calls.prompted, 0);
    assert.equal(fixture.calls.cancelled, 0);
    assert.deepEqual(fixture.calls.selections, []);
    const next = await bounded(callPlugin(fixture.info, '/prompt', { text: 'next message' }));
    assert.equal(next.status, 200);
    assert.equal(fixture.calls.prompted, 1);
  } finally {
    fixture.dispose();
  }
});

await okAsync('客户端：只有明确的权限拒绝码加未执行证明才允许回退', async () => {
  for (const body of [
    { ok: false, error: 'not executed', sessionAccepted: false },
    { ok: false, error: 'not executed', code: 'companion/permission-unsupported' },
  ]) {
    const server = await listen((_req, res) => {
      res.writeHead(500);
      res.end(JSON.stringify(body));
    });
    writeDiscovery(server.address().port);
    try {
      await assert.rejects(() => runCompanionDsh('x', { cfg }), (error) => {
        assert.equal(error.sessionAccepted, true);
        assert.equal(error.channelError, undefined);
        return true;
      });
    } finally {
      await close(server);
    }
  }
});

for (const [name, cancel] of [
  ['同步返回值', () => ({ accepted: true })],
  ['同步抛错', () => { throw new Error('fixture sync cancel failure'); }],
  ['Promise 拒绝', () => Promise.reject(new Error('fixture async cancel failure'))],
]) {
  await okAsync(`真实插件：/cancel 兼容 ${name}，宿主保持可用`, async () => {
    const fixture = await pluginFixture({ cancel });
    try {
      const pending = callPlugin(fixture.info, '/prompt', { text: 'pending' });
      await bounded(fixture.promptStarted);
      const cancelled = await callPlugin(fixture.info, '/cancel', { sessionId: 'fixture-session' });
      assert.equal(cancelled.body.cancelled, true);
      const result = await bounded(pending);
      assert.equal(result.status, 500);
      assert.equal(result.body.sessionId, 'fixture-session');
      assert.equal(fixture.calls.cancelled, 1);
      assert.equal(fixture.calls.flushed, 1);
      assert.equal((await probeCompanion(fixture.cfg)).available, true);
    } finally {
      fixture.dispose();
    }
  });
}

await okAsync('真实插件：客户端断开会取消宿主任务并落盘', async () => {
  const fixture = await pluginFixture();
  const controller = new AbortController();
  try {
    const pending = runCompanionDsh('disconnect', { cfg: fixture.cfg, signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
    await bounded(fixture.promptStarted);
    controller.abort();
    await bounded(rejected);
    await bounded(fixture.sessionFlushed);
    assert.equal(fixture.calls.cancelled, 1);
    assert.equal(fixture.calls.flushed, 1);
    assert.equal((await probeCompanion(fixture.cfg)).available, true);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：超时会取消同步宿主控制器且返回明确错误', async () => {
  const fixture = await pluginFixture({ promptTimeoutMs: 30 });
  try {
    const result = await bounded(callPlugin(fixture.info, '/prompt', { text: 'timeout' }));
    assert.equal(result.status, 500);
    assert.match(result.body.error, /超时/);
    assert.equal(fixture.calls.cancelled, 1);
    assert.equal(fixture.calls.flushed, 1);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：等待 Agent 空闲时也能取消', async () => {
  const fixture = await pluginFixture({ idle: true });
  try {
    const pending = callPlugin(fixture.info, '/prompt', { text: 'wait idle' });
    await bounded(fixture.promptStarted);
    const result = await callPlugin(fixture.info, '/cancel', { sessionId: 'fixture-session' });
    assert.equal(result.body.cancelled, true);
    assert.equal((await bounded(pending)).status, 500);
    assert.equal(fixture.calls.cancelled, 1);
    assert.equal(fixture.calls.flushed, 1);
  } finally {
    fixture.dispose();
  }
});

await okAsync('真实插件：卸载取消活动任务，不会抛出取消回调异常', async () => {
  const fixture = await pluginFixture({ cancel: () => { throw new Error('dispose cancel failure'); } });
  try {
    const pending = callPlugin(fixture.info, '/prompt', { text: 'dispose' });
    await bounded(fixture.promptStarted);
    fixture.dispose();
    assert.equal((await bounded(pending)).status, 500);
    assert.equal(fixture.calls.cancelled, 1);
    assert.equal(fixture.calls.flushed, 1);
  } finally {
    fixture.dispose();
  }
});

// ---------------------------------------------------------------- 配置
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), '{}\n');

ok('默认配置：companion 开启、discovery 为空', () => {
  const loaded = loadConfig(configDir, { createIfMissing: false });
  assert.equal(loaded.config.dsh.companion, true);
  assert.equal(loaded.config.dsh.companionDiscovery, '');
});

ok('配置校验：companion 必须是布尔、discovery 必须是字符串', () => {
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"dsh":{"companion":"yes"}}\n');
  assert.throws(
    () => loadConfig(configDir, { createIfMissing: false }),
    /dsh\.companion/,
  );
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"dsh":{"companionDiscovery":1}}\n');
  assert.throws(
    () => loadConfig(configDir, { createIfMissing: false }),
    /dsh\.companionDiscovery/,
  );
});

// ---------------------------------------------------------------- 安装器
const fakeHome = path.join(tmp, 'fake-home');
const profileDir = path.join(fakeHome, 'profiles', 'desktop');
fs.mkdirSync(profileDir, { recursive: true });
const patchPath = path.join(profileDir, 'cordis.patch.yml');
fs.writeFileSync(patchPath, '# existing\n');

function runInstaller(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools/install-companion.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: fakeHome },
  });
}

ok('安装器：dry-run 只打印、不改文件', () => {
  const before = fs.readFileSync(patchPath, 'utf8');
  const result = runInstaller(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qq-bridge-companion/);
  assert.equal(fs.readFileSync(patchPath, 'utf8'), before);
});

ok('安装器：安装后写入标记块，卸载后恢复原内容', () => {
  const install = runInstaller([]);
  assert.equal(install.status, 0, install.stderr);
  const installed = fs.readFileSync(patchPath, 'utf8');
  assert.match(installed, /# >>> qq-bridge companion/);
  assert.match(installed, /name: 'file:\/\/\/.*\/src\/companion\/lib\/index\.js'/);
  assert.match(installed, /workspacePath: '/);
  assert.match(installed, /sessionMapPath: '/);
  assert.match(installed, /# existing/);

  const remove = runInstaller(['--remove']);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.readFileSync(patchPath, 'utf8'), '# existing\n');
});

ok('安装器：重复安装不会重复写块', () => {
  assert.equal(runInstaller([]).status, 0);
  assert.equal(runInstaller([]).status, 0);
  const text = fs.readFileSync(patchPath, 'utf8');
  assert.equal(text.match(/# >>> qq-bridge companion/g)?.length, 1);
  assert.equal(runInstaller(['--remove']).status, 0);
});

// ---------------------------------------------------------------- 源码契约
const pluginSource = fs.readFileSync(path.join(ROOT, 'src/companion/lib/index.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(ROOT, 'src/dsh-companion.js'), 'utf8');

ok('插件：只依赖 node: 内置模块，导出 name/inject/apply', () => {
  assert.match(pluginSource, /export const name = 'qq-bridge-companion'/);
  assert.match(pluginSource, /export const inject = \[/);
  assert.match(pluginSource, /export async function apply\(ctx/);
  assert.doesNotMatch(pluginSource, /from '(?!node:)[^']+'/);
  assert.doesNotMatch(pluginSource, /require\(/);
});

ok('插件：只监听 loopback、token 常量时间校验、有 discovery', () => {
  assert.match(pluginSource, /127\.0\.0\.1/);
  assert.match(pluginSource, /timingSafeEqual/);
  assert.match(pluginSource, /qq-bridge-companion\.json/);
  assert.match(pluginSource, /renameSync/);
});

ok('插件：按 workspaceId 建会话、支持历史补挂和取消', () => {
  assert.match(pluginSource, /workspaceId/);
  assert.match(pluginSource, /attachSession/);
  assert.match(pluginSource, /attachKnownSessions/);
  assert.match(pluginSource, /\/cancel/);
  assert.match(pluginSource, /controller\.cancel/);
});

ok('客户端：channelError / sessionAccepted 语义完整', () => {
  assert.match(clientSource, /channelError/);
  assert.match(clientSource, /sessionAccepted/);
  assert.match(clientSource, /\/prompt/);
  assert.match(clientSource, /workspacePath/);
});

ok('新文件都能通过 node --check', () => {
  for (const file of [
    'src/dsh-companion.js',
    'src/agent-runner.js',
    'src/config.js',
    'src/companion/lib/index.js',
    'tools/install-companion.mjs',
  ]) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

console.log(`\n通过 ${passed} 项`);
