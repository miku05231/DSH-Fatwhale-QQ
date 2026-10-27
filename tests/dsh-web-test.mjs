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
import { probeCompanion, runCompanionDsh, fetchCompanionModelCatalog } from '../src/dsh-companion.js';
import { SessionStore } from '../src/sessions.js';
import { BrowserCdp, expandSessionGroups, sessionRows, openSessionRow } from './helpers/browser-cdp.mjs';
import { DSH_TEST_VERSION, createConsoleFixture, isolatedEnv as bridgeEnv } from './helpers/isolated-fixtures.mjs';
import { createFakeNapCat } from './ws-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_VERSION = DSH_TEST_VERSION;
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
let browser;
let browserDone;
let browserCdp;
let browserOutput = '';
let consoleFixture;
let releaseHeld;
let holdNextRequest = false;
let browserBaseline;
let browserDocument = 0;
const browserReport = {
  at: new Date().toISOString(), isolated: true, ok: false, checks: [], screenshots: [], liveSelections: [],
  acceptance: {},
};
const browserOutputPath = path.join(ROOT, 'state', 'session-window-live');

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
    const value = await test();
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

async function captureBrowser(name) {
  const result = await browserCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(browserOutputPath, name), Buffer.from(result.data, 'base64'));
  browserReport.screenshots.push(name);
}

async function openBrowserSession(sessionId, transcript, screenshot) {
  await browserCdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      /^(继续|Continue)$/.test(node.textContent.trim()));
    if (button) button.click();
  })()`);
  await until(() => browserCdp.evaluate('!document.body.innerText.includes("预览版说明")'),
    'Web preview notice dismissal');
  fs.writeFileSync(path.join(browserOutputPath, 'web-before-list.json'), JSON.stringify(await browserCdp.evaluate(`({
    body: document.body.innerText,
    links: [...document.querySelectorAll('a')].map((a) => ({text: a.textContent, href: a.getAttribute('href')})),
    buttons: [...document.querySelectorAll('button')].map((b) => ({text: b.textContent, title: b.title, label: b.getAttribute('aria-label')}))
  })`), null, 2));
  await until(async () => {
    await expandSessionGroups(browserCdp);
    return (await sessionRows(browserCdp)).some((row) => row.key.includes(sessionId));
  }, 'original Web session row');
  const marker = `web-live-document-${++browserDocument}`;
  await browserCdp.evaluate(`(() => {
    window.__qqWebLiveTest = { marker: ${JSON.stringify(marker)}, sessionRowClicks: 0 };
    document.addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest('[data-row-key]') : null;
      if (row?.getAttribute('data-row-key')?.startsWith('session:')) window.__qqWebLiveTest.sessionRowClicks += 1;
    }, true);
  })()`);
  assert(await openSessionRow(browserCdp, sessionId));
  await until(() => browserCdp.evaluate(`document.body.innerText.includes(${JSON.stringify(transcript)}) &&
    document.body.innerText.includes('web-companion-ok')`), 'opened original Web transcript');
  browserBaseline = await browserCdp.evaluate(`({
    marker: window.__qqWebLiveTest.marker, sessionRowClicks: window.__qqWebLiveTest.sessionRowClicks,
    timeOrigin: performance.timeOrigin, href: location.href,
    navigationEntries: performance.getEntriesByType('navigation').length
  })`);
  assert.equal(browserBaseline.sessionRowClicks, 1, 'the original session is selected exactly once');
  await captureBrowser(screenshot);
}

async function assertBrowserSelection(model, transcript, screenshot) {
  if (!browserCdp) return;
  const selector = await until(() => browserCdp.evaluate(`(() => {
    if (!document.body.innerText.includes(${JSON.stringify(transcript)})) return null;
    const button = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((node) =>
      /^(选择模型|Select model)/i.test(node.getAttribute('aria-label') || '') &&
      [...node.querySelectorAll('span')].some((span) => span.textContent === ${JSON.stringify(model.model)}) &&
      [...node.querySelectorAll('span')].some((span) =>
        span.textContent.toLowerCase() === ${JSON.stringify(model.reasoningEffort)}));
    if (!button) return null;
    return { text: button.textContent, title: button.title, label: button.getAttribute('aria-label') };
  })()`), `already-open Web selector ${model.model}/${model.reasoningEffort}`);
  const document = await browserCdp.evaluate(`window.__qqWebLiveTest && ({
    marker: window.__qqWebLiveTest.marker, sessionRowClicks: window.__qqWebLiveTest.sessionRowClicks,
    timeOrigin: performance.timeOrigin, href: location.href,
    navigationEntries: performance.getEntriesByType('navigation').length
  })`);
  assert.deepEqual(document, browserBaseline, 'live selection changes must not reload, navigate or reselect the session');
  browserReport.liveSelections.push({ model, transcript, selector, document });
  browserReport.checks.push(`already-open original session automatically shows ${model.model}/${model.reasoningEffort}`);
  await captureBrowser(screenshot);
}

async function startBrowser(launchUrl, sessionId) {
  const executable = process.env.QQ_TEST_BROWSER_EXE;
  if (!executable) {
    if (process.env.QQ_TEST_REQUIRE_BROWSER === '1') throw new Error('Set QQ_TEST_BROWSER_EXE for the real Web frontend test.');
    console.log('  SKIP optional real Web browser: QQ_TEST_BROWSER_EXE is not set');
    return;
  }
  const userData = path.join(tmp, 'browser');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(browserOutputPath, { recursive: true });
  browser = spawn(executable, [
    `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--headless=new',
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--inprivate', '--window-size=1440,1000', launchUrl,
  ], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout.on('data', (chunk) => { browserOutput += chunk; });
  browser.stderr.on('data', (chunk) => { browserOutput += chunk; });
  browserDone = new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.once('close', resolve);
  });
  browserDone.catch(() => {});
  const port = await until(() => {
    const file = path.join(userData, 'DevToolsActivePort');
    if (!fs.existsSync(file)) return null;
    return Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
  }, 'isolated Web browser DevTools');
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find((entry) => entry.type === 'page' && entry.url.startsWith(new URL(launchUrl).origin));
  }, 'real Web frontend target');
  browserCdp = await BrowserCdp.connect(target.webSocketDebuggerUrl);
  await browserCdp.send('Page.enable');
  await browserCdp.send('Runtime.enable');
  await until(() => browserCdp.evaluate('document.readyState === "complete" && document.body.innerText.length > 100'),
    'real Web frontend document');
  await captureBrowser('web-initial.png');
  await openBrowserSession(sessionId, 'web companion first round', 'web-original-old-model.png');
  await assertBrowserSelection({ provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' },
    'web companion first round', 'web-original-old-selection.png');
}

async function checkBrowser(ids) {
  if (!browserCdp) return;
  await expandSessionGroups(browserCdp);
  const rows = await until(async () => {
    const rendered = await sessionRows(browserCdp);
    return ids.every((id) => rendered.some((row) => row.key.includes(id))) ? rendered : null;
  }, 'live Web session list');
  await captureBrowser('web-sessions.png');
  await until(() => browserCdp.evaluate(`document.body.innerText.includes('web companion restricted second round') &&
    document.body.innerText.includes('web-companion-ok')`), 'Web resumed transcript');
  await assertBrowserSelection({ provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'max' },
    'after-held', 'web-reused-session.png');
  assert(await openSessionRow(browserCdp, ids[1]));
  await until(() => browserCdp.evaluate(`document.body.innerText.includes('web companion next window') &&
    document.body.innerText.includes('web-companion-ok')`), 'Web new-window transcript');
  await captureBrowser('web-new-session.png');
  browserReport.rows = rows;
  browserReport.body = await browserCdp.evaluate('document.body.innerText');
  browserReport.checks.push('the real Web frontend shows both session IDs',
    'the original session contains the continued turn', 'the new-window session displays its local model reply');
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

async function saveConsoleModel(manual, mode = 'manual') {
  const response = await fetch(`http://127.0.0.1:${consoleFixture.port}/api/model`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, ...(manual ? { manual } : {}) }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

const probeSource = `
import process from 'node:process';
export const name = 'qq-web-test-probe';
export const inject = ['sessionController', 'agents', 'sessions', 'permissionPresets', 'webServer', 'connection', 'sessionProjections', 'agentDefaultModel'];
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
        const selection = agent ? ctx.get('sessionProjections').stateOf(agent.session, 'modelSelection') : null;
        const requestModels = agent ? Array.from({ length: agent.session.seq }, (_, seq) => agent.session.eventAt(seq))
          .filter((event) => event?.type === 'request/header')
          .map((event) => {
            const model = event.data.header.config;
            return { provider: model.provider, model: model.model,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) };
          }) : null;
        send({ id: message.id, permission: spec, current, rows, selection,
          requestModels, defaultModel: ctx.get('agentDefaultModel').currentSelection() });
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
      if (holdNextRequest || user.includes('hold-switch') && !user.includes('after-held')) {
        holdNextRequest = false;
        await new Promise((resolve) => { releaseHeld = resolve; });
      }
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
    // Keep auxiliary title completions out of the per-turn request counts.
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { 'web-test-local': {
      api: 'openai-completions',
      compat: { supportsReasoningEffort: true },
      baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`,
      apiKeyEnv: 'QQ_WEB_TEST_API_KEY',
      models: [{ id: 'web-test', input: ['text'], contextWindow: 32000, reasoningEfforts: { high: 'high' } }],
    }, 'web-switch-local': {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`,
      compat: { supportsReasoningEffort: true },
      apiKeyEnv: 'QQ_WEB_TEST_API_KEY', models: [{ id: 'web-switched', input: ['text'], contextWindow: 32000,
        reasoningEfforts: { off: null, high: 'high', max: 'max' } }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' } },
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

  const webArgs = [
    '--profile', 'web', '--patch', webPatchPath,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ];
  let web = startDsh(webArgs, { ipc: true });
  let launchUrl = await until(() => {
    const match = web.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+)/);
    return match?.[1];
  }, 'real Web profile startup', web);
  let base = new URL(launchUrl).origin;
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
  let nextWindowSessionId;
  const windowStart = Date.now();
  let windowStore = new SessionStore(path.join(tmp, 'bridge-state'));
  const windowKey = 'g:20001:u:10001:admin:danger-full-access:v1';
  await check('a real Web companion prompt reaches only the isolated local model', async () => {
    const result = await runCompanionDsh('web companion first round', {
      cfg: companionCfg, cwd: workspace,
      model: { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' },
    });
    assert.equal(result.finalText, 'web-companion-ok');
    assert.deepEqual(result.model, { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' });
    assert.equal(requests.at(-1).reasoning_effort, 'high');
    sessionId = result.sessionId;
    windowStore.set(windowKey, sessionId, { startedAt: windowStart });
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.equal(state.permission.sandbox, 'danger-full-access');
    assert.equal(state.permission.approval, 'never');
    assert(JSON.stringify(state.rows).includes(sessionId), 'Web session listing must include the bridge session');
  });
  if (process.env.QQ_TEST_BROWSER_EXE || process.env.QQ_TEST_REQUIRE_BROWSER === '1') {
    await check('the real Web frontend opens the original session before any model switch', async () => {
      await startBrowser(launchUrl, sessionId);
    });
  } else {
    console.log('  SKIP optional real Web browser: QQ_TEST_BROWSER_EXE is not set');
  }
  await check('resuming that real Web session lowers its previous full-access permission', async () => {
    windowStore = new SessionStore(path.join(tmp, 'bridge-state'));
    const savedSession = windowStore.get(windowKey, { windowMinutes: 180, now: windowStart + 179 * 60000 });
    assert.equal(savedSession, sessionId);
    const result = await runCompanionDsh('web companion restricted second round', {
      cfg: { dsh: { ...companionCfg.dsh, permissionMode: 'read-only' } },
      cwd: workspace, sessionId: savedSession,
      model: { provider: 'web-test-local', model: 'web-test' },
    });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.finalText, 'web-companion-ok');
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.equal(state.permission.sandbox, 'read-only');
    assert.equal(state.permission.approval, 'ask');
  });
  await check('the real console saves a supported selection and the same DSH session applies it', async () => {
    consoleFixture = await createConsoleFixture(path.join(tmp, 'console'), {
      // Health polling must not take the single-client message harness connection.
      napcatHealth: {
        async check() { return { state: 'unknown', loggedIn: false, known: false, reachable: false }; },
        close() {},
      },
    });
    consoleFixture.config.dsh.companion = true;
    consoleFixture.config.dsh.companionDiscovery = discoveryPath;
    const catalog = await fetchCompanionModelCatalog(companionCfg);
    assert.deepEqual(catalog.providers.find((item) => item.id === 'web-switch-local').models[0].reasoning.efforts,
      ['off', 'high', 'max']);
    const selected = { provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'high' };
    const snapshot = await saveConsoleModel(selected);
    assert.equal(snapshot.application, 'pending');
    const count = requests.length;
    const result = await runCompanionDsh('switch model in original window', {
      cfg: companionCfg, cwd: workspace, sessionId, model: snapshot.effective,
    });
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(result.model, selected);
    assert.deepEqual(result.modelsUsed, [selected]);
    assert.equal(requests.at(-1).model, 'web-switched');
    assert.equal(requests.at(-1).reasoning_effort, 'high');
    assert.equal(requests.length, count + 1);
    assert(JSON.stringify(requests.at(-1).messages).includes('web companion first round'));
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.deepEqual(state.selection.lastUsed, selected);
    assert.equal(state.selection.pending, null);
    assert.deepEqual(state.defaultModel, { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' });
    await assertBrowserSelection(selected, 'switch model in original window', 'web-live-model-switched.png');
  });
  await check('changing only effort applies; invalid effort never calls the model and valid retry keeps history', async () => {
    const model = { provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'max' };
    const snapshot = await saveConsoleModel(model);
    assert.equal(snapshot.application, 'pending');
    const before = requests.length;
    const result = await runCompanionDsh('effort only', {
      cfg: companionCfg, cwd: workspace, sessionId, model: snapshot.effective,
    });
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(result.model, model);
    assert.deepEqual(result.modelsUsed, [model]);
    assert.equal(requests.at(-1).model, model.model);
    assert.equal(requests.at(-1).reasoning_effort, 'max');
    assert.equal(requests.length, before + 1);
    assert(JSON.stringify(requests.at(-1).messages).includes('switch model in original window'));
    await assertBrowserSelection(model, 'effort only', 'web-live-effort-switched.png');
    const count = requests.length;
    const invalid = { ...model, reasoningEffort: 'low' };
    const response = await fetch(`http://127.0.0.1:${consoleFixture.port}/api/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'manual', manual: invalid }),
    });
    assert.equal(response.status, 400);
    for (const rejected of [invalid, { ...model, provider: 'missing-provider' }, { ...model, model: 'missing-model' }]) {
      await assert.rejects(() => runCompanionDsh('invalid model selection', {
        cfg: companionCfg, cwd: workspace, sessionId, model: rejected,
      }), (error) => error.code === 'companion/model-unavailable' && error.sessionAccepted === true && !error.channelError);
    }
    assert.equal(requests.length, count);
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.deepEqual(state.selection.lastUsed, model);
    const retry = await runCompanionDsh('valid retry', { cfg: companionCfg, cwd: workspace, sessionId,
      model: { ...model, reasoningEffort: 'high' } });
    assert.equal(retry.sessionId, sessionId);
    assert.equal(requests.length, count + 1);
  });
  await check('saving during an in-flight turn keeps that request unchanged and switches the next turn once', async () => {
    const old = { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' };
    const next = { provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'max' };
    const count = requests.length;
    const pending = runCompanionDsh('hold-switch', { cfg: companionCfg, cwd: workspace, sessionId, model: old });
    await until(() => releaseHeld, 'blocked local model request', web);
    const save = await fetch(`http://127.0.0.1:${consoleFixture.port}/api/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'manual', manual: next }),
    });
    assert.equal(save.status, 200);
    const target = (await save.json()).data.effective;
    releaseHeld(); releaseHeld = null;
    assert.deepEqual((await pending).model, old);
    const result = await runCompanionDsh('after-held', { cfg: companionCfg, cwd: workspace, sessionId, model: target });
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(result.model, next);
    assert.equal(requests.length, count + 2);
    const follow = await fetch(`http://127.0.0.1:${consoleFixture.port}/api/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'follow' }),
    });
    assert.equal(follow.status, 200);
  });
  await check('the real bridge persists applied/error status and retries in its original QQ window', async () => {
    const napcat = createFakeNapCat();
    const port = await napcat.listen(0);
    const root = path.dirname(consoleFixture.configPath);
    const userId = 123456789;
    const cfg = consoleFixture.config;
    cfg.onebot = { url: `ws://127.0.0.1:${port}`, accessToken: '' };
    cfg.security = { ...cfg.security, allowFrom: [userId], adminUserIds: [userId], rateLimitPerMinute: 60 };
    cfg.dsh = { ...cfg.dsh, mode: 'desktop', command: path.join(dshRoot, 'lib', 'bin.js'),
      desktopProfile: path.join(home, 'profiles', 'web'), cwd: workspace, timeoutMs: 40000 };
    fs.writeFileSync(consoleFixture.configPath, JSON.stringify(cfg));
    const desktopLayerPath = path.join(root, 'home', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    // The offline copy knows the model ID, but not the live host's effort limits.
    const desktopLayer = `- id: llm-pi-ai
  config:
    providers:
      web-test-local:
        api: openai-completions
        baseURL: http://127.0.0.1:${modelServer.address().port}/v1
        apiKeyEnv: QQ_WEB_TEST_API_KEY
        models:
          - id: web-test
            reasoningEfforts: {high: high}
      web-switch-local:
        api: openai-completions
        baseURL: http://127.0.0.1:${modelServer.address().port}/v1
        apiKeyEnv: QQ_WEB_TEST_API_KEY
        models:
          - id: web-switched
- id: agent-default-model
  config:
    provider: web-test-local
    model: web-test
    reasoningEffort: high
`;
    fs.writeFileSync(desktopLayerPath, desktopLayer);
    const api = `http://127.0.0.1:${consoleFixture.port}/api/model`;
    const target = { provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'high' };
    const save = async (manual) => {
      const response = await fetch(api, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'manual', manual }) });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    await save(target);
    const startBridge = () => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--config', consoleFixture.configPath], {
        cwd: ROOT, env: bridgeEnv(root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const record = { child, stdout: '', stderr: '', closed: false, code: null };
      children.add(child);
      child.stdout.on('data', (chunk) => { record.stdout += chunk; });
      child.stderr.on('data', (chunk) => { record.stderr += chunk; });
      child.on('error', (error) => { record.stderr += error.message; });
      record.done = new Promise((resolve) => child.once('close', (code) => {
        record.closed = true; record.code = code; children.delete(child); resolve();
      }));
      return record;
    };
    let record = startBridge();
    const stopBridge = async () => {
      if (!record.closed) record.child.kill();
      await until(() => record.closed, 'isolated bridge shutdown', undefined, 10000);
      await record.done;
    };
    const statusFile = path.join(root, 'state', 'status.json');
    const status = () => {
      try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return {}; }
    };
    const send = async (text, messageId) => {
      const before = napcat.state.calls.length;
      napcat.sendPrivateMessage({ userId, text, messageId });
      return until(() => napcat.state.calls.slice(before).find((call) => call.action === 'send_private_msg'),
        'synthetic QQ reply', record);
    };
    try {
      await until(() => napcat.state.connections > 0, 'bridge mock OneBot connection', record);
      assert.match(String((await send('bridge first model', 9001)).params.message), /web-companion-ok/);
      await until(() => status().modelApplied?.model === target.model, 'bridge applied status', record);
      const first = status().modelApplied;
      assert.equal(first.reasoningEffort, 'high');
      assert.deepEqual(first.modelsUsed, [target]);
      assert.equal((await save({ ...target, reasoningEffort: 'max' })).application, 'pending');
      await send('bridge effort changed', 9002);
      await until(() => status().modelApplied?.reasoningEffort === 'max', 'bridge effort applied', record);
      assert.equal(status().modelApplied.sessionId, first.sessionId);
      const beforeInvalid = requests.length;
      fs.writeFileSync(path.join(root, 'state', 'model', 'model.json'), JSON.stringify({
        mode: 'manual', manual: { ...target, reasoningEffort: 'low' }, updatedAt: new Date().toISOString(),
      }));
      assert.match(String((await send('bridge invalid saved effort', 9003)).params.message), /不可用|不支持/);
      await until(() => status().modelApplicationError?.requested?.reasoningEffort === 'low', 'bridge application error', record);
      assert.equal(requests.length, beforeInvalid);
      assert.equal(status().modelApplied.sessionId, first.sessionId);
      await save(target);
      await send('bridge valid retry', 9004);
      await until(() => status().modelApplied?.reasoningEffort === 'high' && !status().modelApplicationError,
        'bridge corrected model status', record);
      assert.equal(status().modelApplied.sessionId, first.sessionId);
      assert.equal(requests.length, beforeInvalid + 1);
      assert.equal((await (await fetch(api)).json()).data.application, 'applied');

      await check('an offline unknown capability is rejected by the real host without fallback and exposes a recoverable error', async () => {
        const savedDiscovery = cfg.dsh.companionDiscovery;
        const rejected = { ...target, reasoningEffort: 'low' };
        const before = requests.length;
        const previous = await askProbe(web, 'inspect', { sessionId: first.sessionId });
        // Only the console's catalog lookup is unavailable; the bridge keeps its saved real discovery path.
        cfg.dsh.companionDiscovery = path.join(tmp, 'unavailable-catalog.json');
        try {
          const saved = await save(rejected);
          assert.equal(saved.catalogSource, 'desktop-config');
          assert.equal(saved.validation.status, 'pending');
          assert.equal(saved.application, 'pending');
          assert.deepEqual(saved.manual, rejected);
          const reply = await send('bridge unknown capability rejected by host', 9005);
          assert.match(String(reply.params.message), /不可用|不支持/);
          await until(() => status().modelApplicationError?.requested?.reasoningEffort === 'low',
            'unknown capability host rejection', record);
          const snapshot = (await (await fetch(api)).json()).data;
          assert.equal(snapshot.validation.status, 'pending');
          assert.equal(snapshot.application, 'error');
          assert.match(snapshot.applicationError.message, /不可用|不支持/);
          assert.equal(snapshot.applicationError.requested.reasoningEffort, 'low');
          assert.equal(snapshot.applied.sessionId, first.sessionId);
          assert.equal(snapshot.applied.reasoningEffort, 'high');
          assert.equal(requests.length, before);
          const after = await askProbe(web, 'inspect', { sessionId: first.sessionId });
          assert.deepEqual(after.requestModels, previous.requestModels);
          assert.deepEqual(after.selection, previous.selection);
          assert.doesNotMatch(record.stdout + record.stderr, /改用独立宿主|回退 headless/);
          await save(target);
          assert.match(String((await send('bridge unknown capability corrected', 9006)).params.message), /web-companion-ok/);
          await until(() => !status().modelApplicationError && status().modelApplied?.reasoningEffort === 'high',
            'unknown capability corrected in original session', record);
          assert.equal(status().modelApplied.sessionId, first.sessionId);
          assert.equal(requests.length, before + 1);
          assert.equal(requests.at(-1).model, target.model);
          assert.equal(requests.at(-1).reasoning_effort, target.reasoningEffort);
          assert.equal((await (await fetch(api)).json()).data.application, 'applied');
          browserReport.acceptance.unknownCapability = {
            validation: saved.validation.status, application: snapshot.application,
            hostExecutionDelta: after.requestModels.length - previous.requestModels.length,
            rejectedModelRequestDelta: 0, correctedModelRequestDelta: requests.length - before,
            sessionId: first.sessionId,
          };
        } finally { cfg.dsh.companionDiscovery = savedDiscovery; }
      });

      await check('a second real bridge message queues behind a blocked turn and applies the newly saved model exactly once', async () => {
        const old = { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' };
        const next = { ...target, reasoningEffort: 'max' };
        await save(old);
        const before = requests.length;
        const callsBefore = napcat.state.calls.length;
        holdNextRequest = true;
        napcat.sendPrivateMessage({ userId, text: 'bridge-held-first', messageId: 9010 });
        await until(() => releaseHeld && requests.length === before + 1, 'first bridge turn blocked at the local model', record);
        napcat.sendPrivateMessage({ userId, text: 'bridge-queued-second', messageId: 9011 });
        await until(() => status().inFlight === 1 && status().queueDepth === 1,
          'second bridge message admitted to the real queue', record, 15000);
        assert(napcat.state.calls.slice(callsBefore).some((call) => call.action === 'send_private_msg' &&
          String(call.params.message).includes('正在处理')));
        assert.equal(requests.length, before + 1, 'the queued second turn cannot call the model before the first is released');
        assert.equal((await save(next)).application, 'pending');
        assert.equal(requests.length, before + 1, 'saving must not replay the blocked turn');
        releaseHeld(); releaseHeld = null;
        await until(() => napcat.state.calls.slice(callsBefore).filter((call) => call.action === 'send_private_msg' &&
          String(call.params.message).includes('web-companion-ok')).length === 2,
        'both queued bridge replies', record);
        await until(() => status().inFlight === 0 && status().queueDepth === 0 &&
          status().modelApplied?.reasoningEffort === 'max', 'bridge queue drained with new model applied', record);
        assert.equal(requests.length, before + 2);
        assert.deepEqual(requests.slice(before).map((body) => ({ model: body.model, reasoningEffort: body.reasoning_effort })),
          [old, next].map(({ model, reasoningEffort }) => ({ model, reasoningEffort })));
        assert(JSON.stringify(requests[before].messages).includes('bridge-held-first'));
        assert(!JSON.stringify(requests[before].messages).includes('bridge-queued-second'));
        assert(JSON.stringify(requests[before + 1].messages).includes('bridge-queued-second'));
        assert.equal(status().modelApplied.sessionId, first.sessionId);
        const state = await askProbe(web, 'inspect', { sessionId: first.sessionId });
        assert.deepEqual(state.requestModels.slice(-2), [old, next]);
        assert.deepEqual(state.selection.lastUsed, next);
        assert.equal(state.selection.pending, null);
        browserReport.acceptance.queuedSwitch = {
          sessionId: first.sessionId, queuedBeforeSave: true, modelRequests: state.requestModels.slice(-2),
          modelRequestDelta: requests.length - before, successfulReplies: 2,
        };
      });

      await check('a restarted real bridge applies follow-manual-follow in the restored session without changing the desktop default', async () => {
        const oldBridgePid = record.child.pid;
        await stopBridge();
        record = startBridge();
        await until(() => status().pid === record.child.pid && status().connected === true,
          'restarted bridge and persisted session store', record);
        assert.notEqual(record.child.pid, oldBridgePid);
        const desktopDefault = { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' };
        const modes = [
          { mode: 'follow', model: desktopDefault },
          { mode: 'manual', model: { ...target, reasoningEffort: 'max' } },
          { mode: 'follow', model: desktopDefault },
        ];
        const observed = [];
        for (const [index, step] of modes.entries()) {
          const saved = await saveConsoleModel(step.mode === 'manual' ? step.model : undefined, step.mode);
          assert.equal(saved.mode, step.mode);
          const { source, ...effective } = saved.effective;
          assert.equal(source, step.mode);
          assert.deepEqual(effective, step.model);
          const before = requests.length;
          const marker = `bridge restored ${step.mode} round ${index}`;
          assert.match(String((await send(marker, 9020 + index)).params.message), /web-companion-ok/);
          await until(() => status().modelApplied?.sessionId === first.sessionId && status().modelMode === step.mode,
            `restored bridge ${step.mode} model receipt`, record);
          assert.equal(requests.length, before + 1);
          assert.equal(requests.at(-1).model, step.model.model);
          assert.equal(requests.at(-1).reasoning_effort, step.model.reasoningEffort);
          assert(JSON.stringify(requests.at(-1).messages).includes('bridge first model'));
          assert(JSON.stringify(requests.at(-1).messages).includes(marker));
          assert.deepEqual(status().modelApplied.modelsUsed, [step.model]);
          const state = await askProbe(web, 'inspect', { sessionId: first.sessionId });
          assert.deepEqual(state.selection.lastUsed, step.model);
          assert.equal(state.selection.pending, null);
          assert.deepEqual(state.defaultModel, desktopDefault);
          assert.equal((await (await fetch(api)).json()).data.application, 'applied');
          observed.push({ mode: step.mode, actual: state.requestModels.at(-1), defaultModel: state.defaultModel });
        }
        assert.equal(fs.readFileSync(desktopLayerPath, 'utf8'), desktopLayer,
          'QQ model changes cannot rewrite the desktop profile default');
        browserReport.acceptance.restoredModeRoundTrip = { sessionId: first.sessionId, steps: observed };
      });
    } finally {
      releaseHeld?.(); releaseHeld = null;
      try { await stopBridge(); }
      finally { await napcat.close(); }
    }
  });
  await check('the fixed window creates a different real Web session at exactly 180 minutes', async () => {
    const expiredSession = windowStore.get(windowKey, { windowMinutes: 180, now: windowStart + 180 * 60000 });
    assert.equal(expiredSession, null);
    const result = await runCompanionDsh('web companion next window', {
      cfg: companionCfg, cwd: workspace, sessionId: expiredSession,
      model: { provider: 'web-test-local', model: 'web-test' },
    });
    assert.equal(result.finalText, 'web-companion-ok');
    assert.notEqual(result.sessionId, sessionId);
    nextWindowSessionId = result.sessionId;
    windowStore.set(windowKey, result.sessionId, { startedAt: windowStart + 180 * 60000 });
    const state = await askProbe(web, 'inspect', { sessionId: result.sessionId });
    assert(JSON.stringify(state.rows).includes(sessionId));
    assert(JSON.stringify(state.rows).includes(result.sessionId));
    assert.equal(windowStore.get(windowKey, {
      windowMinutes: 0, now: windowStart + 365 * 24 * 60 * 60000,
    }), result.sessionId);
    assert(requests.length >= 3);
  });
  if (browserCdp) {
    await check('the isolated real browser renders the Web sessions and transcripts', async () => {
      await checkBrowser([sessionId, nextWindowSessionId]);
    });
  }
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
    assert(requests.every((body) => ['web-test', 'web-switched'].includes(body.model)));
  });
  await check('a real Web host restart restores the original session and history before another model switch', async () => {
    assert.equal((await askProbe(web, 'stop')).stopped, true);
    assert.equal((await web.done).code, 0);
    assert.equal(fs.existsSync(discoveryPath), false);
    web = startDsh(webArgs, { ipc: true });
    launchUrl = await until(() => {
      const match = web.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+)/);
      return match?.[1];
    }, 'restarted real Web profile startup', web);
    base = new URL(launchUrl).origin;
    await until(async () => (await probeCompanion(companionCfg)).available,
      'restarted Web companion discovery', web);
    const restored = await askProbe(web, 'inspect', { sessionId });
    assert(JSON.stringify(restored.rows).includes(sessionId), 'the restarted host lists the persisted original session');
    if (browserCdp) {
      const navigation = await browserCdp.send('Page.navigate', { url: launchUrl });
      assert.equal(navigation.errorText, undefined);
      await until(async () => {
        const { frameTree } = await browserCdp.send('Page.getFrameTree');
        return frameTree.frame.loaderId === navigation.loaderId &&
          await browserCdp.evaluate('document.readyState === "complete" && !!document.querySelector("[data-row-key]")');
      },
        'restarted real Web frontend document');
      await openBrowserSession(sessionId, 'web companion restricted second round', 'web-restarted-history.png');
      await assertBrowserSelection({ provider: 'web-switch-local', model: 'web-switched', reasoningEffort: 'max' },
        'after-held', 'web-restarted-selection.png');
    }
    const model = { provider: 'web-test-local', model: 'web-test', reasoningEffort: 'high' };
    const snapshot = await saveConsoleModel(model);
    const count = requests.length;
    const result = await runCompanionDsh('web host restarted switch original session', {
      cfg: companionCfg, cwd: workspace, sessionId, model: snapshot.effective,
    });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.finalText, 'web-companion-ok');
    assert.deepEqual(result.model, model);
    assert.deepEqual(result.modelsUsed, [model]);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).model, model.model);
    assert.equal(requests.at(-1).reasoning_effort, model.reasoningEffort);
    const history = JSON.stringify(requests.at(-1).messages);
    for (const prompt of ['web companion first round', 'web companion restricted second round',
      'switch model in original window', 'effort only', 'after-held']) {
      assert(history.includes(prompt), `the restarted model request preserves history: ${prompt}`);
    }
    await assertBrowserSelection(model, 'web host restarted switch original session', 'web-restarted-model-switched.png');
    const state = await askProbe(web, 'inspect', { sessionId });
    assert.deepEqual(state.selection.lastUsed, model);
    assert.equal(state.selection.pending, null);
    browserReport.checks.push('a real Web host restart preserves the original session, transcript and model selection');
  });
  await check('disposing the isolated Web kernel closes the companion and removes discovery', async () => {
    const result = await askProbe(web, 'stop');
    assert.equal(result.stopped, true);
    const stopped = await web.done;
    assert.equal(stopped.code, 0);
    assert.equal(fs.existsSync(discoveryPath), false);
  });
  if (browserCdp) {
    browserReport.ok = true;
  }
  console.log(`\n通过 ${passed} 项真实 DSH Web 兼容性检查（${process.platform} / ${version}）。`);
} finally {
  releaseHeld?.();
  if (consoleFixture) await consoleFixture.close();
  if (browserCdp && process.platform !== 'win32') {
    await browserCdp.send('Browser.close').catch(() => {});
  }
  if (browser && browser.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        killer.on('close', resolve);
        killer.on('error', resolve);
      });
    } else browser.kill('SIGKILL');
  }
  if (browserDone) await browserDone.catch(() => {});
  if (browserCdp) browserCdp.ws.close();
  if (browser) {
    fs.writeFileSync(path.join(ROOT, 'state', 'session-window-live', 'web-browser.log'), cleanOutput(browserOutput));
    fs.writeFileSync(path.join(browserOutputPath, 'web-results.json'), JSON.stringify({
      ...browserReport, completedAt: new Date().toISOString(), passed,
    }, null, 2));
  }
  for (const child of children) child.kill();
  await Promise.allSettled([...children].map((child) => new Promise((resolve) => child.once('close', resolve))));
  if (modelServer) {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
  }
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  assert(path.basename(tmp).startsWith('qq-bridge-real-web-'));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
