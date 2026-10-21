// Real installed DSH Web/headless integration, with isolated homes and a local model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshInstallRoot } from '../src/dsh-desktop.js';
import { probeCompanion, runCompanionDsh } from '../src/dsh-companion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_VERSION = '0.2.0-rc.2';
const command = process.env.QQ_TEST_DSH_COMMAND || 'dsh';
let dshRoot;
try {
  dshRoot = resolveDshInstallRoot(command, ROOT);
} catch (error) {
  if (process.env.QQ_TEST_REQUIRE_DSH === '1' || process.env.QQ_TEST_DSH_COMMAND) throw error;
  console.log('通过：未安装 DSH，跳过可选的真实 Web 内核测试；发布检查须设 QQ_TEST_REQUIRE_DSH=1。');
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8')).version;
assert.equal(version, EXPECTED_VERSION, `Web compatibility is pinned to DSH ${EXPECTED_VERSION}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-real-web-'));
const home = path.join(tmp, 'home');
const workspace = path.join(tmp, 'workspace');
const discoveryPath = path.join(home, 'web-companion.json');
const children = new Set();
const requests = [];
let passed = 0;
let modelServer;

function cleanOutput(value) {
  return String(value)
    .replace(/([?&]token=)[^\s)]+/g, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .slice(-6000);
}

function isolatedEnv(extra = {}) {
  const env = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'),
    DSH_HOME: home,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    DSH_TELEMETRY_DISABLED: '1',
    QQ_WEB_TEST_API_KEY: 'local-web-test-key',
    ...extra,
  };
}

function startDsh(args, { ipc = false, env = {} } = {}) {
  const child = spawn(process.execPath, [path.join(dshRoot, 'lib', 'bin.js'), ...args], {
    cwd: workspace,
    env: isolatedEnv(env),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  children.add(child);
  const record = { child, stdout: '', stderr: '', messages: [], code: null, signal: null, closed: false };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record.stdout += chunk; });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  child.on('message', (message) => { record.messages.push(message); });
  record.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      record.code = code;
      record.signal = signal;
      record.closed = true;
      children.delete(child);
      resolve(record);
    });
  });
  // The polling owner reports any failed process with sanitized diagnostics.
  record.done.catch(() => {});
  return record;
}

async function until(test, label, record, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = test();
    if (value) return value;
    if (record?.closed) {
      throw new Error(`${label}: DSH exited (${record.code ?? record.signal})\n${cleanOutput(record.stderr + record.stdout)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out\n${cleanOutput((record?.stderr || '') + (record?.stdout || ''))}`);
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('local HTTP probe timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`  OK ${label}`);
}

async function askProbe(record, op, extra = {}) {
  const id = `${op}-${record.messages.length}`;
  record.child.send({ qqWebTest: true, id, op, ...extra });
  const message = await until(
    () => record.messages.find((value) => value?.qqWebTest === true && value.id === id),
    `Web kernel ${op}`, record,
  );
  assert.equal(message.error, undefined, message.error);
  return message;
}

const probeSource = `
import process from 'node:process';
export const name = 'qq-web-test-probe';
export const inject = ['sessionController', 'agents', 'sessions', 'permissionPresets', 'webServer', 'connection'];
export function apply(ctx) {
  const send = (value) => {
    if (process.connected) process.send({ qqWebTest: true, ...value });
  };
  const onMessage = async (message) => {
    if (message?.qqWebTest !== true) return;
    try {
      if (message.op === 'inspect') {
        const agent = ctx.get('agents').get(message.sessionId);
        const permissions = ctx.get('permissionPresets');
        const current = agent ? permissions.current(agent.session) : null;
        const spec = current ? permissions.resolve(current) : null;
        const rows = await ctx.get('sessionController').list({}, new AbortController().signal);
        send({ id: message.id, permission: spec, current, rows });
      } else if (message.op === 'stop') {
        await ctx.root.fiber.dispose();
        send({ id: message.id, stopped: true });
        process.disconnect();
        process.exit(0);
      }
    } catch (error) {
      send({ id: message.id, error: String(error?.message ?? error) });
    }
  };
  process.on('message', onMessage);
  ctx.effect(() => () => process.off('message', onMessage));
}
`;

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'probe.mjs'), probeSource);
  modelServer = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const user = JSON.stringify(body.messages.filter((message) => message.role === 'user'));
      const reply = user.includes('headless-parallel') ? 'headless-parallel-ok' : 'web-companion-ok';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: reply }, null], [{}, 'stop'],
      ]) {
        res.write(`data: ${JSON.stringify({
          id: 'local-web-test', object: 'chat.completion.chunk', created: 1, model: 'web-test',
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500);
      res.end(String(error.message));
    }
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const modelPatch = [
    { id: 'llm-pi-ai', config: { providers: { 'web-test-local': {
      api: 'openai-completions',
      baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`,
      apiKeyEnv: 'QQ_WEB_TEST_API_KEY',
      models: [{ id: 'web-test', input: ['text'], contextWindow: 32000 }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'web-test-local', model: 'web-test' } },
  ];
  const modelPatchPath = path.join(tmp, 'model.patch.json');
  const webPatchPath = path.join(tmp, 'web.patch.json');
  fs.writeFileSync(modelPatchPath, JSON.stringify(modelPatch));
  fs.writeFileSync(webPatchPath, JSON.stringify([
    ...modelPatch,
    { insert: [
      {
        id: 'qq-bridge-companion',
        name: pathToFileURL(path.join(ROOT, 'src', 'companion', 'lib', 'index.js')).href,
        config: { workspacePath: workspace, discoveryPath },
      },
      { id: 'qq-web-test-probe', name: pathToFileURL(path.join(tmp, 'probe.mjs')).href },
    ] },
  ]));

  const web = startDsh([
    '--profile', 'web', '--patch', webPatchPath,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { ipc: true });
  const launchUrl = await until(() => {
    const match = web.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+)/);
    return match?.[1];
  }, 'real Web profile startup', web);
  const base = new URL(launchUrl).origin;
  let cookie;

  await check(`real CLI boots the shipped Web profile on DSH ${version}`, async () => {
    assert.equal(new URL(launchUrl).hostname, '127.0.0.1');
    assert(fs.existsSync(path.join(home, 'profiles', 'web', 'package.json')));
    assert.equal((await request(`${base}/`)).status, 401);
    assert.equal((await request(`${base}/?token=invalid-test-token`)).status, 401);
  });
  await check('launch token exchanges for a protected cookie and real frontend assets', async () => {
    const exchange = await request(launchUrl);
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.location, './');
    const setCookie = exchange.headers['set-cookie']?.[0] || '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0];
    assert(cookie.startsWith('dsh-auth-'));
    const page = await request(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html[\s>]/i);
    assert.match(page.text, /__DSH_BOOT__/);
    const scripts = [...page.text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'));
    assert(scripts.some((script) => script.includes('/assets/')),
      'the installed frontend must provide a built JavaScript asset');
    await Promise.all(scripts.map(async (script) => {
      const asset = await request(new URL(script, base), { headers: { cookie } });
      assert.equal(asset.status, 200, `the served script must exist: ${script}`);
      assert(asset.text.length > 100);
    }));
  });
  await check('the live Web API enforces cookie, Host and Origin boundaries', async () => {
    assert.equal((await request(`${base}/api/qq-test-missing`)).status, 401);
    assert.equal((await request(`${base}/api/qq-test-missing`, { headers: { cookie } })).status, 404);
    assert.equal((await request(`${base}/api/qq-test-missing`, {
      headers: { cookie, host: 'untrusted.invalid' },
    })).status, 403);
    assert.equal((await request(`${base}/api/qq-test-missing`, {
      headers: { cookie, origin: 'http://untrusted.invalid' },
    })).status, 403);
  });

  const companionCfg = { dsh: {
    companionDiscovery: discoveryPath, permissionMode: 'danger-full-access', timeoutMs: 40000,
  } };
  await until(() => fs.existsSync(discoveryPath), 'Web companion discovery', web);
  await check('the actual companion plugin works inside the shipped Web kernel', async () => {
    const probe = await probeCompanion(companionCfg);
    assert.equal(probe.available, true, probe.reason);
    assert.equal(probe.health.permissionProtocol, 1);
    assert.deepEqual([...probe.health.permissionModes].sort(), [
      'danger-full-access', 'read-only', 'workspace-write',
    ]);
    const info = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    assert.equal((await request(`http://127.0.0.1:${info.port}/health`)).status, 401);
  });

  let sessionId;
  await check('a real Web companion prompt reaches only the isolated local model', async () => {
    const result = await runCompanionDsh('web companion first round', {
      cfg: companionCfg, cwd: workspace,
      model: { provider: 'web-test-local', model: 'web-test' },
    });
    assert.equal(result.finalText, 'web-companion-ok');
    sessionId = result.sessionId;
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.equal(state.permission.sandbox, 'danger-full-access');
    assert.equal(state.permission.approval, 'never');
    assert(JSON.stringify(state.rows).includes(sessionId), 'Web session listing must include the bridge session');
  });
  await check('resuming that real Web session lowers its previous full-access permission', async () => {
    const result = await runCompanionDsh('web companion restricted second round', {
      cfg: { dsh: { ...companionCfg.dsh, permissionMode: 'read-only' } },
      cwd: workspace, sessionId,
      model: { provider: 'web-test-local', model: 'web-test' },
    });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.finalText, 'web-companion-ok');
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.equal(state.permission.sandbox, 'read-only');
    assert.equal(state.permission.approval, 'ask');
  });
  await check('a real headless CLI can run alongside Web using the isolated DSH home', async () => {
    const headless = startDsh([
      '--profile', 'headless', '--patch', modelPatchPath, '--json', 'headless-parallel',
    ], { env: { DSH_PERMISSION_MODE: 'read-only' } });
    const result = await Promise.race([
      headless.done,
      until(() => headless.closed, 'parallel headless completion', headless).then(() => headless),
    ]);
    assert.equal(result.code, 0, cleanOutput(result.stderr));
    assert.match(result.stdout, /headless-parallel-ok/);
    assert.equal((await request(`${base}/`, { headers: { cookie } })).status, 200);
    assert.equal((await probeCompanion(companionCfg)).available, true);
    assert(requests.length >= 3);
    assert(requests.every((body) => body.model === 'web-test'));
  });
  await check('disposing the isolated Web kernel closes the companion and removes discovery', async () => {
    const result = await askProbe(web, 'stop');
    assert.equal(result.stopped, true);
    const stopped = await web.done;
    assert.equal(stopped.code, 0);
    assert.equal(fs.existsSync(discoveryPath), false);
  });
  console.log(`\n通过 ${passed} 项真实 DSH Web 兼容性检查（${process.platform} / ${version}）。`);
} finally {
  for (const child of children) child.kill();
  await Promise.allSettled([...children].map((child) => new Promise((resolve) => child.once('close', resolve))));
  if (modelServer) {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
