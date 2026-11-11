/** Real CSP/iframe regression. For a plugin-capable checkout:
 * node tests/plugin-console-browser-test.mjs
 * QQ_TEST_SOURCE_ROOT may select an isolated v3.3 source without changing the installation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserCdp } from './helpers/browser-cdp.mjs';
import { browserRuntimeEnv, isolatedEnv, prepareIsolatedHome, freePort } from './helpers/isolated-fixtures.mjs';

const root = path.resolve(process.env.QQ_TEST_SOURCE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const artifacts = path.resolve(process.env.QQ_TEST_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), 'qq-console-browser-')));
await fs.mkdir(artifacts, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-console-fixture-'));
const browserEnv = browserRuntimeEnv(tmp);
const savedEnv = { ...process.env };
const responseDelayMs = Number(savedEnv.QQ_TEST_BROWSER_RESPONSE_DELAY_MS || 0);
const configFile = path.join(tmp, 'config.json');
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnv(tmp, { QQ_CONFIG: configFile }));
const report = { root, checks: [], errors: [], requests: [] };
let browser, cdp;
const servers = [], consoles = [], effects = [];
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await prepareIsolatedHome(tmp);
  const { DEFAULTS } = await import(pathToFileURL(path.join(root, 'src/config.js')));
  const { createWebUiServer } = await import(pathToFileURL(path.join(root, 'src/webui/server.mjs')));
  const { mountCompanionConsole } = await import(pathToFileURL(path.join(root, 'src/companion/lib/console-mount.js')));
  const config = structuredClone(DEFAULTS);
  config.onebot = { url: 'ws://127.0.0.1:9', accessToken: '' };
  config.dsh = { ...config.dsh, mode: 'headless', companion: false, cwd: tmp };
  config.chatSessionsPath = path.join(tmp, 'chat-sessions.json');
  config.memory = { ...config.memory, root: path.join(tmp, 'memory'), reflectDaily: false };
  config.persona.path = path.join(tmp, 'AGENTS.md');
  await fs.writeFile(configFile, JSON.stringify(config));
  let running = false;
  const bridge = {
    status: () => ({ running, pid: running ? 42 : 0 }),
    start() { running = true; return this.status(); },
    async stop() { running = false; return this.status(); },
  };
  const entries = [];
  for (const prefix of ['', '/qq-bridge']) {
    const consoleServer = createWebUiServer({
      configRoot: tmp, config, publicBase: prefix, bridgeControl: bridge,
      napcatHealth: { async check() { return { state: 'stopped', loggedIn: false, reachable: false }; }, close() {} },
      platformQrLogin: { async stop() {} },
      updateManager: { async start() {}, stop() {}, async status() { return { automatic: false, phase: 'idle' }; } },
    });
    consoles.push(consoleServer);
    let handler = (req, res) => consoleServer.handle(req, res);
    if (prefix) {
      await mountCompanionConsole({
        logger: { info() {}, warn() {} },
        get(name) {
          if (name === 'webServer') return { register(route) { handler = route.handler; return () => {}; } };
          if (name === 'connection') return { requestRejection() {} };
          throw new Error(name);
        },
        effect(fn) { effects.push(fn()); },
      }, { projectRoot: root, supervisor: bridge, serverFactory: () => consoleServer });
    } else await consoleServer.activate();
    const host = http.createServer(async (req, res) => {
      report.requests.push({ prefix, url: req.url });
      if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (prefix && req.url === '/embed') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><iframe src="/qq-bridge/" style="width:1200px;height:920px;border:0"></iframe>');
      }
      if (prefix && !req.url.startsWith(`${prefix}/`) && req.url !== prefix) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"No host API at this path"}');
      }
      try {
        if (responseDelayMs > 0 && req.url.endsWith('/api/overview')) await new Promise(resolve => setTimeout(resolve, responseDelayMs));
        await handler(req, res);
      } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
    servers.push(host);
    entries.push({ prefix, origin: `http://127.0.0.1:${host.address().port}` });
  }
  const port = await freePort();
  const executable = savedEnv.QQ_TEST_BROWSER_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--disable-background-networking', '--window-size=1280,1050', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmp, 'browser')}`, 'about:blank'], { env: browserEnv, windowsHide: true, stdio: 'ignore' });
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(row => row.type === 'page'); }
    catch { return null; }
  }, 'browser CDP', 30000);
  cdp = await BrowserCdp.connect(target.webSocketDebuggerUrl);
  cdp.ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') report.errors.push(message.params.entry);
  });
  for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.send(method);
  for (const { prefix, origin } of entries) {
    const label = prefix || 'standalone';
    const response = await fetch(`${origin}${prefix}/`);
    const html = await response.text();
    const policy = response.headers.get('content-security-policy');
    check(`${label}: strict script CSP retained`, /(?:^|;)\s*script-src\s+'self'\s*(?:;|$)/.test(policy || ''));
    check(`${label}: no executable inline BASE initializer`, !html.includes('globalThis.__QQ_BRIDGE_BASE__'));
    await cdp.send('Page.navigate', { url: `${origin}${prefix ? '/embed' : '/'}` });
    const context = prefix ? "document.querySelector('iframe')?.contentDocument" : 'document';
    await until(() => cdp.evaluate(`${context}?.querySelector('#serviceCards')?.children.length === 3`), `${label} rendered service cards`);
    const view = await cdp.evaluate(`(()=>{const doc=${context};return {base:doc.querySelector('meta[name="qq-bridge-base"]')?.content,text:doc.body.innerText,cards:doc.querySelector('#serviceCards')?.children.length||0}})()`);
    report[label] = view;
    check(`${label}: correct inert base metadata`, view.base === prefix, view);
    check(`${label}: overview renders three service cards`, view.cards === 3 && !view.text.includes('非 JSON'), view);
    const api = await cdp.evaluate(`(async()=>{const response=await fetch('${prefix}/api/overview');return {status:response.status,body:await response.json()}})()`);
    check(`${label}: overview API succeeds`, api.status === 200 && api.body.ok);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, prefix ? 'iframe.png' : 'standalone.png'), Buffer.from(screenshot.data, 'base64'));
  }
  check('iframe never requests the host root overview/log APIs', !report.requests.some(row => row.prefix && /^\/api\/(overview|logs)/.test(row.url)));
  check('browser reports no CSP or missing-resource errors', report.errors.length === 0, report.errors);
  assert(report.checks.every(row => row.pass), 'Plugin console browser regression failed');
} catch (error) {
  report.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.ws.close(); }
  if (browser?.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  for (const dispose of effects) if (typeof dispose === 'function') await dispose();
  for (const instance of consoles) await instance.stop();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`${report.checks.filter(row => row.pass).length}/${report.checks.length} checks passed`);
  assert.equal(path.dirname(tmp), os.tmpdir());
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
