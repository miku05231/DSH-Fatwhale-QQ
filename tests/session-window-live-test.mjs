// Opt-in real Electron Desktop and browser session-window verification.
// Only a fresh DSH_HOME, synthetic messages and a local model are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeCompanion, runCompanionDsh } from '../src/dsh-companion.js';
import { SessionStore } from '../src/sessions.js';
import { BrowserCdp, expandSessionGroups, sessionRows, openSessionRow } from './helpers/browser-cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'state', 'session-window-live');
const executable = process.env.QQ_TEST_DESKTOP_EXE;
if (!executable) {
  if (process.env.QQ_TEST_REQUIRE_DESKTOP === '1') throw new Error('Set QQ_TEST_DESKTOP_EXE to the installed Electron app.');
  console.log('通过：未设置 QQ_TEST_DESKTOP_EXE，跳过可选的真实 Desktop 窗口测试。');
  process.exit(0);
}
await fs.access(executable);
const report = { at: new Date().toISOString(), isolated: true, checks: [], screenshots: [], errors: [] };
await fs.mkdir(OUTPUT, { recursive: true });
await fs.writeFile(path.join(OUTPUT, 'intent.json'), `${JSON.stringify({
  at: report.at, command: 'node tests/session-window-live-test.mjs',
  scope: 'Separate Electron user-data and DSH home; local model; no QQ, credentials or user sessions.',
}, null, 2)}\n`);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-session-window-desktop-'));
const home = path.join(tmp, 'home');
const userData = path.join(tmp, 'electron');
const workspace = path.join(tmp, 'workspace');
const discoveryPath = path.join(home, 'test-companion.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (label, condition) => {
  assert.ok(condition, label);
  report.checks.push(label);
  console.log(`  PASS ${label}`);
};
let browser;
let cdp;
let model;
let closed;
let companionPid;
let output = '';

async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (browser?.exitCode !== null && browser?.exitCode !== undefined) throw new Error(`Desktop exited before ${label}`);
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) && !(error instanceof TypeError)) throw error;
    }
    await sleep(100);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function screenshot(name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUTPUT, name);
  await fs.writeFile(file, Buffer.from(image.data, 'base64'));
  report.screenshots.push(name);
}

async function launchDesktop(env) {
  await fs.rm(path.join(userData, 'DevToolsActivePort'), { force: true });
  await fs.rm(discoveryPath, { force: true });
  browser = spawn(executable, [
    `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--no-first-run',
    '--disable-gpu', '--disable-extensions', '--disable-background-networking',
  ], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout.on('data', (chunk) => { output += chunk.toString(); });
  browser.stderr.on('data', (chunk) => { output += chunk.toString(); });
  closed = new Promise((resolve, reject) => {
    browser.once('close', resolve);
    browser.once('error', reject);
  });
  closed.catch(() => {});
  const debugPort = await until(async () => {
    const content = await fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
    return Number(content.split('\n')[0]);
  }, 'isolated Electron DevTools');
  const page = await until(async () => (await targets(debugPort)).find((target) =>
    target.type === 'page' && /welcome|localhost|127\.0\.0\.1|dsh[-:]/.test(target.url)), 'Desktop page');
  cdp = await BrowserCdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await until(() => cdp.evaluate('document.readyState === "complete"'), 'Desktop document');
  const text = await until(async () => {
    const body = await cdp.evaluate('document.body.innerText');
    return body.trim().length > 100 && !/Loading plugins/.test(body) ? body : null;
  }, 'Desktop startup frontend');
  // The signed-out welcome screen has a supported one-launch skip command.
  if (/skip|暂不|跳过|稍后/i.test(text)) {
    const skipped = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        /skip|暂不|跳过|稍后/i.test(node.textContent));
      if (!button) return false;
      button.click(); return true;
    })()`);
    check('the isolated signed-out welcome screen can enter without real credentials', skipped);
  }
  return debugPort;
}

async function stopDesktop() {
  if (cdp) {
    cdp.ws.close();
    cdp = undefined;
  }
  if (browser && browser.exitCode === null) {
    if (process.platform === 'win32') {
      const killed = await new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        killer.once('close', resolve);
        killer.once('error', reject);
      });
      assert(killed === 0 || browser.exitCode !== null, 'the isolated Desktop process tree must terminate');
    } else browser.kill('SIGKILL');
  }
  if (closed) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout stopping the isolated Desktop process')), 10000);
      closed.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
  if (companionPid) {
    const alive = () => {
      try { process.kill(companionPid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const deadline = Date.now() + 10000;
    while (alive() && Date.now() < deadline) await sleep(100);
    assert.equal(alive(), false, 'the previous isolated companion must exit before reusing its home');
  }
  browser = undefined;
  closed = undefined;
  companionPid = undefined;
}

async function connectMainFrontend(debugPort) {
  cdp?.ws.close();
  const mainPage = await until(async () => (await targets(debugPort)).find((target) =>
    target.type === 'page' && !/welcome|mandatory/i.test(target.url)), 'Desktop main frontend');
  cdp = await BrowserCdp.connect(mainPage.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await until(() => cdp.evaluate('document.readyState === "complete" && document.body.innerText.length > 100'),
    'Desktop main document');
}

async function watchOpenSession(sessionId) {
  await expandSessionGroups(cdp);
  await until(async () => (await sessionRows(cdp)).some((row) => row.key.includes(sessionId)),
    'Desktop original session row');
  assert(await openSessionRow(cdp, sessionId));
  await until(() => cdp.evaluate(`document.body.innerText.includes('desktop second fixed window') &&
    document.body.innerText.includes('session-window-local-ok')`), 'Desktop original open conversation');
  const marker = `desktop-live-${Date.now()}`;
  await cdp.evaluate(`(() => {
    window.__qqModelSyncDocument = ${JSON.stringify(marker)};
    window.__qqModelSyncSessionClicks = 0;
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-row-key^="session:"]')) window.__qqModelSyncSessionClicks++;
    }, true);
  })()`);
  return marker;
}

async function expectOpenSelection(modelName, effort, marker, label) {
  await until(() => cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    return buttons.some((node) => node.textContent.replace(/\\s+/g, '').toLowerCase() ===
      ${JSON.stringify(modelName + effort)}.toLowerCase());
  })()`), label);
  const observed = await cdp.evaluate(`({
    sameDocument: window.__qqModelSyncDocument === ${JSON.stringify(marker)},
    sessionRowClicks: window.__qqModelSyncSessionClicks,
    originalTranscript: document.body.innerText.includes('desktop second fixed window'),
    selectors: [...document.querySelectorAll('button')]
      .map((node) => node.textContent.trim())
      .filter((text) => text.includes(${JSON.stringify(modelName)}))
  })`);
  assert.equal(observed.sameDocument, true, 'the open Desktop document must not reload');
  assert.equal(observed.sessionRowClicks, 0, 'the open Desktop conversation must not be reselected');
  assert.equal(observed.originalTranscript, true);
  (report.liveSelections ??= []).push({ label, ...observed });
  check(label, true);
}

try {
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  const profile = path.join(home, 'profiles', 'desktop');
  await fs.mkdir(profile, { recursive: true });
  const requests = [];
  model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      id: 'local-window-test', object: 'chat.completion.chunk', model: 'window-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'session-window-local-ok' }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'local-window-test', object: 'chat.completion.chunk', model: 'window-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }));
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n');
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'window-test-local': {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`,
      compat: { supportsReasoningEffort: true },
      apiKeyEnv: 'QQ_WINDOW_TEST_KEY', models: [{ id: 'window-test', input: ['text'], contextWindow: 32000,
        reasoningEfforts: { high: 'high' } }],
    }, 'window-switch-local': {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`,
      compat: { supportsReasoningEffort: true }, apiKeyEnv: 'QQ_WINDOW_TEST_KEY',
      models: [{ id: 'window-switched', input: ['text'], contextWindow: 32000,
        reasoningEfforts: { off: null, high: 'high', max: 'max' } }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'window-test-local', model: 'window-test' } },
    { insert: [{
      id: 'qq-bridge-companion', name: pathToFileURL(path.join(ROOT, 'src', 'companion', 'lib', 'index.js')).href,
      config: { workspacePath: workspace, discoveryPath },
    }] },
  ]));
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, DSH_HOME: home,
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    TMP: tmp, TEMP: tmp, TMPDIR: tmp, DSH_TELEMETRY_DISABLED: '1',
    QQ_WINDOW_TEST_KEY: 'synthetic-local-model-key',
  });
  let debugPort = await launchDesktop(env);
  check('a separate Electron app started with a fresh user-data directory', debugPort > 0);
  await screenshot('desktop-initial.png');
  const cfg = { dsh: { companionDiscovery: discoveryPath, permissionMode: 'read-only', timeoutMs: 40000 } };
  const companion = await until(async () => {
    const result = await probeCompanion(cfg);
    return result.available ? result : null;
  }, 'Desktop companion');
  report.companionPid = companion.info.pid;
  companionPid = companion.info.pid;
  check('the actual companion runs in the isolated Electron Desktop host', true);
  const start = Date.now();
  const key = 'g:20001:u:10001:admin:read-only:v1';
  let store = new SessionStore(path.join(tmp, 'bridge-state'));
  const ask = (sessionId, text, selection = { provider: 'window-test-local', model: 'window-test', reasoningEffort: 'high' }) => runCompanionDsh(text, {
    cfg, sessionId, cwd: workspace, model: selection,
  });
  const first = await ask(null, 'desktop first fixed window');
  assert.equal(first.finalText, 'session-window-local-ok');
  report.syntheticSessions = [first.sessionId];
  store.set(key, first.sessionId, { startedAt: start });
  check('the first Desktop turn creates a real session using only the local model', Boolean(first.sessionId));
  store = new SessionStore(path.join(tmp, 'bridge-state'));
  const resumed = store.get(key, { windowMinutes: 7, now: start + 6 * 60000 });
  assert.equal(resumed, first.sessionId, 'the bridge store returns the first Desktop session');
  const second = await ask(resumed,
    'desktop second fixed window');
  report.syntheticSessions.push(second.sessionId);
  assert.equal(second.sessionId, first.sessionId, 'Desktop must resume the requested session');
  check('Desktop reuses the same session after a bridge-store restart within a custom seven-minute window', true);
  await connectMainFrontend(debugPort);
  const liveMarker = await watchOpenSession(first.sessionId);
  await expectOpenSelection('window-test', 'high', liveMarker,
    'the Desktop conversation is already open with the original model before switching');
  const selected = { provider: 'window-switch-local', model: 'window-switched', reasoningEffort: 'high' };
  const switched = await ask(resumed, 'desktop switch same conversation', selected);
  assert.equal(switched.sessionId, first.sessionId);
  assert.deepEqual(switched.model, selected);
  assert.equal(requests.at(-1).model, 'window-switched');
  assert.equal(requests.at(-1).reasoning_effort, 'high');
  check('the installed Desktop applies provider/model/effort in the original session', true);
  await expectOpenSelection('window-switched', 'high', liveMarker,
    'the already-open Desktop selector follows a model switch without reload or session reselection');
  await screenshot('desktop-live-model.png');
  const stronger = await ask(resumed, 'desktop effort only', { ...selected, reasoningEffort: 'max' });
  assert.equal(stronger.model.reasoningEffort, 'max');
  assert.equal(requests.at(-1).reasoning_effort, 'max');
  check('the installed Desktop applies an effort-only change', true);
  await expectOpenSelection('window-switched', 'max', liveMarker,
    'the already-open Desktop effort label follows an effort-only switch');
  await screenshot('desktop-live-effort.png');
  const beforeInvalid = requests.length;
  await assert.rejects(() => ask(resumed, 'desktop invalid low', { ...selected, reasoningEffort: 'low' }),
    (error) => error.code === 'companion/model-unavailable' && error.sessionAccepted && !error.channelError);
  assert.equal(requests.length, beforeInvalid);
  const retry = await ask(resumed, 'desktop valid retry same conversation', selected);
  assert.equal(retry.sessionId, first.sessionId);
  assert.deepEqual(retry.model, selected);
  assert.equal(requests.length, beforeInvalid + 1);
  check('invalid effort makes no Desktop model call and a corrected retry keeps the same session', true);
  await expectOpenSelection('window-switched', 'high', liveMarker,
    'the already-open Desktop selector recovers after an invalid model selection');
  const previousCompanionPid = companion.info.pid;
  await stopDesktop();
  debugPort = await launchDesktop(env);
  const restartedCompanion = await until(async () => {
    const result = await probeCompanion(cfg);
    return result.available && result.info.pid !== previousCompanionPid ? result : null;
  }, 'restarted isolated Desktop companion');
  report.restartedCompanionPid = restartedCompanion.info.pid;
  companionPid = restartedCompanion.info.pid;
  check('the real isolated Desktop host and companion restart with the same persisted home', true);
  await connectMainFrontend(debugPort);
  const restartedMarker = await watchOpenSession(first.sessionId);
  await expectOpenSelection('window-switched', 'high', restartedMarker,
    'the restarted Desktop restores the persisted original model selection and transcript');
  store = new SessionStore(path.join(tmp, 'bridge-state'));
  const restoredSession = store.get(key, { windowMinutes: 7, now: start + 6 * 60000 });
  assert.equal(restoredSession, first.sessionId);
  const restored = await ask(restoredSession, 'desktop after real host restart', {
    ...selected, reasoningEffort: 'max',
  });
  assert.equal(restored.sessionId, first.sessionId);
  assert.deepEqual(restored.model, { ...selected, reasoningEffort: 'max' });
  assert.equal(requests.at(-1).model, 'window-switched');
  assert.equal(requests.at(-1).reasoning_effort, 'max');
  const restoredHistory = JSON.stringify(requests.at(-1).messages);
  assert(restoredHistory.includes('desktop first fixed window'));
  assert(restoredHistory.includes('desktop second fixed window'));
  check('the restarted Desktop continues the original session and history using the newly selected model', true);
  await expectOpenSelection('window-switched', 'max', restartedMarker,
    'the restored already-open Desktop conversation follows the next model selection');
  await screenshot('desktop-after-restart.png');
  const expired = store.get(key, { windowMinutes: 7, now: start + 7 * 60000 });
  assert.equal(expired, null);
  const third = await ask(expired, 'desktop next fixed window');
  report.syntheticSessions.push(third.sessionId);
  check('Desktop starts another real session at exactly the configured deadline',
    third.sessionId !== first.sessionId);
  store.set(key, third.sessionId, { startedAt: start + 7 * 60000 });
  const defaultStart = start + 7 * 60000;
  const defaultContinued = await ask(store.get(key, {
    windowMinutes: 180, now: defaultStart + 179 * 60000,
  }), 'desktop default window continued');
  check('Desktop also keeps the session at minute 179 of the default window',
    defaultContinued.sessionId === third.sessionId);
  const defaultExpired = store.get(key, { windowMinutes: 180, now: defaultStart + 180 * 60000 });
  assert.equal(defaultExpired, null);
  const defaultNext = await ask(defaultExpired, 'desktop default next window');
  report.syntheticSessions.push(defaultNext.sessionId);
  check('Desktop opens a new session at exactly minute 180 of the default window',
    defaultNext.sessionId !== third.sessionId);
  store.set(key, defaultNext.sessionId, { startedAt: defaultStart + 180 * 60000 });
  check('zero disables automatic session rollover',
    store.get(key, { windowMinutes: 0, now: start + 1000 * 24 * 60 * 60000 }) === defaultNext.sessionId);
  check('all Desktop model requests use the isolated synthetic provider',
    requests.length >= 8 && requests.every((body) => ['window-test', 'window-switched'].includes(body.model)));
  await fs.writeFile(path.join(OUTPUT, 'desktop-before-list.json'), JSON.stringify(await cdp.evaluate(`({
    body: document.body.innerText,
    links: [...document.querySelectorAll('a')].map((a) => ({text: a.textContent, href: a.getAttribute('href')})),
    buttons: [...document.querySelectorAll('button')].map((b) => ({text: b.textContent, title: b.title, label: b.getAttribute('aria-label')}))
  })`), null, 2));
  await expandSessionGroups(cdp);
  report.rows = await until(async () => {
    const rows = await sessionRows(cdp);
    return [first.sessionId, third.sessionId, defaultNext.sessionId].every((id) =>
      rows.some((row) => row.key.includes(id))) ? rows : null;
  }, 'live Desktop session list');
  await screenshot('desktop-sessions.png');
  check('the real Desktop frontend renders the original and both rolled-over session IDs', true);
  assert(await openSessionRow(cdp, first.sessionId));
  await until(() => cdp.evaluate(`document.body.innerText.includes('desktop second fixed window') &&
    document.body.innerText.includes('session-window-local-ok')`), 'Desktop resumed transcript');
  await until(() => cdp.evaluate(`([...document.querySelectorAll('button')].some((node) =>
    node.textContent.includes('window-switched')))`), 'Desktop model selector');
  check('the Desktop conversation selector automatically shows the newly applied model', true);
  await screenshot('desktop-reused-session.png');
  check('the Desktop UI shows the continued second turn in the original session', true);
  assert(await openSessionRow(cdp, defaultNext.sessionId));
  await until(() => cdp.evaluate(`document.body.innerText.includes('desktop default next window') &&
    document.body.innerText.includes('session-window-local-ok')`), 'Desktop new-window transcript');
  await screenshot('desktop-new-session.png');
  check('the Desktop UI opens the new-window session and local model reply', true);
  report.frontendText = await cdp.evaluate('document.body.innerText');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.errors.push(error.message);
  if (cdp) {
    report.frontendText = await cdp.evaluate('document.body.innerText').catch(() => '');
    await screenshot('desktop-failure.png').catch(() => {});
  }
  throw error;
} finally {
  let cleanupError;
  try { await stopDesktop(); }
  catch (error) {
    cleanupError = error;
    report.ok = false;
    report.errors.push(error.message);
    report.retainedFixture = tmp;
  }
  if (model) {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  }
  await fs.writeFile(path.join(OUTPUT, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT, 'desktop-output.log'), output
    .replace(/([?&]token=)[^\s)]+/g, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]'));
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  assert(path.basename(tmp).startsWith('qq-session-window-desktop-'));
  if (!cleanupError) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (cleanupError) throw cleanupError;
}
console.log(`通过 ${report.checks.length} 项真实 Desktop 会话窗口检查，失败 0 项。`);
