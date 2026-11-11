/** Real browser coverage of the compact HUD, full console and local handoff. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserCdp } from './helpers/browser-cdp.mjs';
import { browserRuntimeEnv, isolatedEnv, prepareIsolatedHome, freePort, modelLayer } from './helpers/isolated-fixtures.mjs';

const root = path.resolve(process.env.QQ_TEST_SOURCE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const artifacts = path.resolve(process.env.QQ_TEST_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), 'qq-hud-artifacts-')));
await fs.mkdir(artifacts, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-hud-browser-'));
const browserEnv = browserRuntimeEnv(tmp);
const savedEnv = { ...process.env };
const responseDelayMs = Number(savedEnv.QQ_TEST_BROWSER_RESPONSE_DELAY_MS || 0);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnv(tmp, { QQ_CONFIG: path.join(tmp, 'config.json'), QQ_FIXTURE_API_KEY: 'synthetic-fixture-key' }));
const report = { checks: [], errors: [], requests: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
let browser, cdp, host, consoleServer;
const effects = [], opened = [];
let running = false, starts = 0, stops = 0, factoryCalls = 0, failPersona = false;
try {
  await prepareIsolatedHome(tmp);
  const { DEFAULTS } = await import(pathToFileURL(path.join(root, 'src/config.js')));
  const { createWebUiServer } = await import(pathToFileURL(path.join(root, 'src/webui/server.mjs')));
  const { mountCompanionConsole } = await import(pathToFileURL(path.join(root, 'src/companion/lib/console-mount.js')));
  const config = structuredClone(DEFAULTS);
  config.onebot = { url: 'ws://127.0.0.1:9', accessToken: '' };
  config.dsh = { ...config.dsh, mode: 'headless', companion: false, cwd: tmp, patchPath: 'model.yml' };
  config.persona.path = 'AGENTS.md';
  config.chatSessionsPath = path.join(tmp, 'state/sessions.json');
  config.memory = { ...config.memory, root: 'memory', reflectDaily: false };
  config.stickers = { ...config.stickers, enabled: true, autoCollect: true, sendProbability: 0.125 };
  for (const dir of ['logs', 'state', 'home/.dsh/profiles/desktop']) await fs.mkdir(path.join(tmp, dir), { recursive: true });
  await fs.writeFile(path.join(tmp, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# Isolated HUD fixture\n');
  const layer = modelLayer('http://127.0.0.1:1/v1');
  await fs.writeFile(path.join(tmp, 'model.yml'), layer);
  await fs.writeFile(path.join(tmp, 'home/.dsh/profiles/desktop/cordis.patch.yml'), layer);
  const logFile = path.join(tmp, 'logs/bridge-2026-11-10.log');
  await fs.writeFile(logFile, 'HUD old log A\nHUD old log B\n');
  let handler;
  const bridge = {
    status: () => ({ running, connected: running, pid: running ? 42 : 0, mode: 'standalone' }),
    async start() { starts += 1; await delay(50); running = true; return this.status(); },
    async stop() { stops += 1; running = false; return this.status(); },
  };
  await mountCompanionConsole({
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'webServer') return { register(route) { handler = route.handler; return () => {}; } };
      if (name === 'connection') return { requestRejection() {} };
      throw new Error(name);
    },
    effect(fn) { effects.push(fn()); },
  }, {
    projectRoot: root, configFile: path.join(tmp, 'config.json'), supervisor: bridge,
    openBrowser: async url => { opened.push(url); },
    serverFactory(options) {
      factoryCalls += 1;
      consoleServer = createWebUiServer({ ...options, config,
        napcatHealth: { async check() { return { state: 'online', loggedIn: true, reachable: true }; }, close() {} },
        platformQrLogin: { async stop() {} },
        updateManager: { async start() {}, stop() {}, async status() { return { automatic: false, phase: 'idle' }; } },
      });
      return consoleServer;
    },
  });
  host = http.createServer(async (req, res) => {
    report.requests.push({ method: req.method, path: req.url.split('?')[0] });
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.url.startsWith('/embed')) {
      const mode = req.url === '/embed-full' ? '?mode=full' : req.url === '/embed-auto' ? '' : '?mode=embed';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><style>body{margin:0}iframe{display:block;width:100%;height:560px;border:0}</style><iframe src="/qq-bridge/${mode}"></iframe>`);
    }
    if (failPersona && req.url === '/qq-bridge/api/personas/active' && req.method === 'PUT') {
      res.writeHead(409, { 'content-type': 'application/json' });
      return res.end('{"ok":false,"error":"Fixture persona save rejected"}');
    }
    if (!req.url.startsWith('/qq-bridge')) { res.writeHead(404); return res.end(); }
    try {
      if (responseDelayMs > 0 && req.url === '/qq-bridge/api/model' && req.method === 'PUT') await delay(responseDelayMs);
      await handler(req, res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${host.address().port}`;
  for (const name of ['HUD One', 'HUD Two']) {
    const made = await fetch(`${origin}/qq-bridge/api/personas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(made.status, 200);
  }
  const port = await freePort();
  browser = spawn(savedEnv.QQ_TEST_BROWSER_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'browser')}`, 'about:blank',
  ], { env: browserEnv, windowsHide: true, stdio: 'ignore' });
  let target;
  await until(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); return target; } catch { return false; } }, 'browser', 30000);
  cdp = await BrowserCdp.connect(target.webSocketDebuggerUrl);
  cdp.ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && /Content Security Policy/.test(message.params.entry.text)) report.errors.push(message.params.entry.text);
  });
  for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.send(method);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  const inFrame = expression => cdp.evaluate(`(()=>{const doc=document.querySelector('iframe')?.contentDocument;if(!doc)return false;const win=doc.defaultView;return (${expression});})()`);
  const click = id => inFrame(`doc.querySelector('#${id}').click()`);
  const set = (id, value) => inFrame(`(()=>{const el=doc.querySelector('#${id}');el.value=${JSON.stringify(value)};el.dispatchEvent(new win.Event('change',{bubbles:true}));return el.value;})()`);
  const shot = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, name), Buffer.from(image.data, 'base64'));
  };
  await cdp.send('Page.navigate', { url: `${origin}/embed` });
  await until(() => inFrame("Boolean(doc.querySelector('#hudPersona')?.options.length>1 && doc.querySelector('#serviceCards')?.children.length===3)"), 'HUD data');
  const layout = await inFrame(`(()=>{const ids=['hudHeader','serviceCards','hudQuickControls','overviewLogToolbar','overviewLog'];return {width:doc.documentElement.clientWidth,scrollWidth:doc.documentElement.scrollWidth,boxes:ids.map(id=>{const r=doc.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,width:r.width};}),navVisible:[...doc.querySelectorAll('nav')].some(n=>win.getComputedStyle(n).display!=='none'),serviceButtons:doc.querySelector('#serviceCards').querySelectorAll('button').length};})()`);
  check('900x560 HUD has no horizontal overflow', layout.scrollWidth <= 900, layout);
  check('HUD primary controls and log fit the viewport', layout.boxes.every(b => b.top >= 0 && b.bottom <= 560 && b.width > 0), layout);
  check('embedded service cards have no process-control buttons', layout.serviceButtons === 0);
  await shot('embed-900x560.png');
  await until(() => inFrame("!doc.querySelector('#hudStickerApply').disabled"), 'sticker controls ready');
  const exactPercent = await inFrame("doc.querySelector('#hudStickerProbability').value");
  await click('hudStickerApply');
  await until(() => inFrame("!doc.querySelector('#hudStickerApply').disabled"), 'unchanged sticker save');
  check('unchanged fractional sticker frequency retains its exact value', exactPercent === '12.5' && JSON.parse(await fs.readFile(path.join(tmp, 'config.json'), 'utf8')).stickers.sendProbability === 0.125);
  const pendingLocked = await inFrame("(()=>{const start=doc.querySelector('#hudBridgeStart');start.click();const locked=start.disabled;start.click();return locked;})()");
  check('HUD locks repeated bridge actions while pending', pendingLocked);
  await until(async () => running && await inFrame("!doc.querySelector('#hudBridgeRestart').disabled"), 'bridge start and HUD ready');
  check('HUD starts the shared bridge through its controller', starts === 1 && running);
  await click('hudBridgeRestart');
  await until(() => starts === 2 && running, 'bridge restart');
  check('HUD restart stops before starting without replacing the console', stops === 1 && factoryCalls === 1);
  await set('hudPersona', 'HUD One');
  await until(async () => (await (await fetch(`${origin}/qq-bridge/api/personas`)).json()).data.active === 'HUD One', 'persona save');
  check('quick persona saves the global default', true);
  failPersona = true;
  await set('hudPersona', 'HUD Two');
  await until(() => inFrame("doc.body.innerText.includes('Fixture persona save rejected')"), 'persona error');
  check('persona save failure retains the previous backend selection', (await (await fetch(`${origin}/qq-bridge/api/personas`)).json()).data.active === 'HUD One');
  failPersona = false;
  await set('hudStickerProbability', '0');
  await click('hudStickerApply');
  await until(async () => JSON.parse(await fs.readFile(path.join(tmp, 'config.json'), 'utf8')).stickers.sendProbability === 0, 'sticker save');
  const afterSticker = JSON.parse(await fs.readFile(path.join(tmp, 'config.json'), 'utf8')).stickers;
  check('zero sticker frequency preserves the library and collection', afterSticker.enabled === true && afterSticker.autoCollect === true);
  await set('hudModelMode', 'manual');
  await set('hudModelProvider', 'test-local');
  await set('hudModelModel', 'test-chat');
  await set('hudModelEffort', 'high');
  await until(() => inFrame("!doc.querySelector('#hudModelApply').disabled"), 'model apply ready');
  await click('hudModelApply');
  let savedModel;
  await until(async () => {
    savedModel = (await (await fetch(`${origin}/qq-bridge/api/model`)).json()).data;
    return savedModel.mode === 'manual' && savedModel.manual?.provider === 'test-local' && savedModel.manual?.model === 'test-chat' && savedModel.manual?.reasoningEffort === 'high';
  }, 'manual model persisted');
  await until(() => inFrame("!doc.querySelector('#hudModelApply').disabled && doc.querySelector('#hudModelStatus').textContent.includes('test-local/test-chat') && !doc.querySelector('#hudModelStatus').textContent.includes('尚未应用')"), 'saved model feedback');
  check('manual model target saves through the existing API', savedModel.mode === 'manual' && JSON.stringify(savedModel).includes('test-chat'));
  check('model feedback distinguishes saved target and actual use', await inFrame("Boolean(doc.querySelector('#hudModelApplied').textContent.trim())"));
  await click('overviewLogClear');
  await until(() => inFrame("doc.querySelector('#overviewLog').textContent === ''"), 'clear log');
  await click('overviewLogRefresh');
  await delay(150);
  check('cleared old log lines stay hidden on refresh', await inFrame("doc.querySelector('#overviewLog').textContent === ''"));
  await fs.appendFile(logFile, 'HUD NEW AFTER CLEAR\n');
  await click('overviewLogRefresh');
  await until(() => inFrame("doc.querySelector('#overviewLog').textContent.includes('HUD NEW AFTER CLEAR')"), 'new log');
  check('new logs append without restoring cleared history', await inFrame("!doc.querySelector('#overviewLog').textContent.includes('HUD old')"));
  await inFrame("doc.querySelector('#hudPersona').focus()");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  check('HUD quick controls support keyboard navigation', await inFrame("doc.activeElement.id !== 'hudPersona' && doc.activeElement.matches('button,input,select')"));
  const lightSurface = await inFrame("win.getComputedStyle(doc.querySelector('#hudQuickControls')).backgroundColor");
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await until(() => inFrame(`win.matchMedia('(prefers-color-scheme: dark)').matches && win.getComputedStyle(doc.querySelector('#hudQuickControls')).backgroundColor !== ${JSON.stringify(lightSurface)}`), 'dark surface transition');
  check('HUD follows the dark color scheme', true, { lightSurface, darkSurface: await inFrame("win.getComputedStyle(doc.querySelector('#hudQuickControls')).backgroundColor") });
  await shot('embed-dark.png');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  check('narrow HUD has no horizontal overflow', await inFrame('doc.documentElement.scrollWidth <= doc.documentElement.clientWidth'));
  await shot('embed-390.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${origin}/embed-full` });
  await until(() => inFrame("doc.body?.classList.contains('mode-full')"), 'explicit full iframe');
  check('explicit full mode overrides iframe detection', await inFrame("[...doc.querySelectorAll('nav')].some(n=>win.getComputedStyle(n).display!=='none')"));
  await cdp.send('Page.navigate', { url: `${origin}/embed-auto` });
  await until(() => inFrame("doc.body?.classList.contains('mode-embed') && doc.querySelector('#hudPersona')?.options.length>1"), 'implicit embedded mode');
  check('framing selects embed mode when no mode is specified', true);
  await click('hudOpenFull');
  await until(() => opened.length === 1, 'browser handoff');
  const handoffUrl = new URL(opened[0]);
  check('handoff is a dynamically allocated loopback URL', handoffUrl.hostname === '127.0.0.1' && handoffUrl.origin !== origin && handoffUrl.hash.startsWith('#grant='));
  await cdp.send('Page.navigate', { url: opened[0] });
  await until(() => cdp.evaluate("Boolean(document.querySelector('#page-overview')?.classList.contains('is-active')) && location.search.includes('mode=full') && !location.hash.includes('grant=')"), 'authenticated full console');
  check('browser auth removes its grant and opens full mode', true);
  const routes = ['overview','memory','stickers','persona','sessions','model','plugins','automation','system'];
  for (const page of routes) {
    await cdp.evaluate(`location.hash=${JSON.stringify(page)}`);
    await until(() => cdp.evaluate(`document.querySelector('#page-${page}')?.classList.contains('is-active')`), `full route ${page}`);
  }
  check('all nine full-console deep links remain usable', true);
  await cdp.evaluate("location.hash='memes'");
  await until(() => cdp.evaluate("document.querySelector('#page-stickers')?.classList.contains('is-active')"), 'memes alias');
  check('legacy memes hash resolves to the sticker library', true);
  const cookies = (await cdp.send('Network.getCookies', { urls: [`${handoffUrl.origin}/qq-bridge/`] })).cookies;
  check('external console uses its own HttpOnly Strict cookie', cookies.some(c => c.httpOnly && c.sameSite === 'Strict'));
  await shot('full-console.png');
  check('external view reuses the original console and bridge', factoryCalls === 1 && starts === 2 && running);
  check('browser has no uncaught exceptions or CSP violations', report.errors.length === 0, report.errors);
  assert(report.checks.every(c => c.pass), 'Dual-mode browser checks failed');
} catch (error) {
  report.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.ws.close(); }
  if (browser?.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); }
  for (const effect of effects) if (typeof effect === 'function') await effect();
  await consoleServer?.stop();
  if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`${report.checks.filter(c => c.pass).length}/${report.checks.length} HUD checks passed`);
  assert.equal(path.dirname(tmp), os.tmpdir());
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
