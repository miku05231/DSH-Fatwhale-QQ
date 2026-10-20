/**
 * Real browser update journeys against an isolated, in-memory fixture API.
 * Usage: node tests/updates-ui.mjs (Node 22+ and Microsoft Edge).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'state', 'updates-ui');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseStatus = () => ({
  currentVersion: '0.2.0', latestVersion: '0.3.0', phase: 'available', automatic: true,
  checkedAt: new Date().toISOString(),
  releaseUrl: 'https://github.com/miku05231/DSH-Fatwhale-QQ/releases/tag/v0.3.0',
  releaseNotes: '保留配置、人格与记忆。\n<img src=x onerror="window.releaseInjection=true">',
  publishedAt: new Date().toISOString(), canInstall: true, installReason: '', progress: null, error: '',
});
const fixture = { status: baseStatus(), offline: false, missing: false, writes: [], token: 0, reads: 0 };
const report = { at: new Date().toISOString(), isolated: true, checks: [], screenshots: [], layouts: [], errors: [] };
function check(name, condition) {
  assert.ok(condition, name);
  report.checks.push(name);
}

async function startServer() {
  const files = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'application/javascript'],
    ['/app.css', 'app.css', 'text/css'], ['/app-icon.png', 'app-icon.png', 'image/png'],
  ].map(async ([url, name, type]) => [url, {
    bytes: await readFile(path.join(ROOT, 'src', 'webui', 'public', name)), type,
  }])));
  const overview = {
    version: '0.2.0', now: new Date().toISOString(), uptimeSeconds: 3600,
    napcat: { running: true, portOpen: true, qqRunning: true },
    bridge: { running: true, connected: true, sessions: 0, inFlight: 0, queueDepth: 0 },
    dsh: { running: true }, today: { messages: 0 }, memory: { ok: true, data: { files: 0 } },
    ports: { onebot: 3001, napcatWebui: 6099, webui: 5830 },
    runtime: { node: process.version, platform: 'win32 x64', memoryRoot: 'state/memory', configPath: 'config.json' },
  };
  const fixed = new Map([
    ['/api/overview', overview],
    ['/api/logs', { lines: ['[demo] 隔离测试，不连接真实账号'] }],
    ['/api/settings', { behavior: {}, security: {} }],
    ['/api/autostart', { available: false, enabled: false }],
    ['/api/paths', {
      persona: { raw: 'qq-workspace/AGENTS.md', resolved: 'demo/persona.md', exists: true },
      memory: { raw: 'state/memory', resolved: 'demo/memory', exists: true },
      workspace: { raw: 'qq-workspace', resolved: 'demo/workspace', exists: true },
    }],
  ]);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }));
    };
    if (pathname.startsWith('/api/updates')) {
      if (req.method === 'GET' && pathname === '/api/updates') fixture.reads += 1;
      if (fixture.offline) return res.destroy();
      if (fixture.missing) return json(404, 'Unknown endpoint');
      if (req.method === 'GET' && pathname === '/api/updates') {
        fixture.token += 1;
        return json(200, { ...fixture.status, updateToken: `fixture-${fixture.token}` });
      }
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw || '{}');
      const validToken = req.headers['x-qq-update-token'] === `fixture-${fixture.token}`;
      fixture.writes.push({
        path: pathname, method: req.method, body, validToken,
        contentType: req.headers['content-type'],
      });
      if (!validToken) return json(403, 'Invalid update token');
      if (pathname === '/api/updates/settings') fixture.status.automatic = body.automatic;
      if (pathname === '/api/updates/install') fixture.status = { ...fixture.status, phase: 'downloading', progress: 42 };
      return json(200, { ...fixture.status, updateToken: `fixture-${fixture.token}` });
    }
    const file = files.get(pathname);
    if (file) {
      res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      return res.end(file.bytes);
    }
    if (fixed.has(pathname)) return json(200, fixed.get(pathname));
    return json(404, 'Unknown fixture endpoint');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else for (const fn of this.handlers.get(message.method) || []) fn(message.params);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(name, handler) {
    const list = this.handlers.get(name) || [];
    list.push(handler);
    this.handlers.set(name, list);
  }
}

async function waitFor(condition, name, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await condition().catch(() => false)) return;
    await sleep(60);
  }
  throw new Error(`Timeout waiting for ${name}`);
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  // Record intent before driving the browser; no real configuration is read.
  await writeFile(path.join(OUTPUT, 'intent.json'), `${JSON.stringify({
    at: report.at, command: 'node tests/updates-ui.mjs',
    scope: 'Isolated fixture API, update confirmation/retry/restart and responsive layouts.',
  }, null, 2)}\n`);
  let edge;
  for (const candidate of [
    process.env.SHOWCASE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)) {
    try { await access(candidate); edge = candidate; break; } catch { /* Try the next installation. */ }
  }
  if (!edge) throw new Error('Microsoft Edge required; set SHOWCASE_BROWSER to its executable.');
  const { server, origin } = await startServer();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'fatwhale-updates-ui-'));
  let browser;
  let cdp;
  let exited;
  let navigations = 0;
  try {
    browser = spawn(edge, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    let spawnError;
    browser.once('error', (error) => { spawnError = error; });
    exited = new Promise((resolve) => browser.once('exit', resolve));
    let debugPort;
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      debugPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      return debugPort > 0;
    }, 'browser');
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    cdp = await Cdp.connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    cdp.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) navigations += 1; });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => report.errors.push(exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') report.errors.push(args.map((arg) => arg.value || arg.description).join(' '));
    });
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        node.scrollIntoView({block:"center"});
        const r = node.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await sleep(80);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const waitText = async (selector, includes) => waitFor(async () => (await text(selector)).includes(includes), includes);
    const ready = () => waitFor(async () => await evaluate('document.readyState==="complete" && document.fonts.status==="loaded"'), 'document');
    const refresh = async () => {
      const reads = fixture.reads;
      await click('.nav-item[data-page="system"]');
      await waitFor(async () => fixture.reads > reads, 'fresh update status');
      await sleep(80);
    };
    const screenshot = async (name) => {
      await evaluate('window.scrollTo({top:0,behavior:"instant"})');
      await sleep(80);
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      const filename = path.join(OUTPUT, `${name}.png`);
      await writeFile(filename, Buffer.from(image.data, 'base64'));
      report.screenshots.push(path.relative(ROOT, filename).replaceAll('\\', '/'));
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: `${origin}/#overview` });
    await ready();
    await waitText('#snackbarText', '发现新版本 0.3.0');
    check('All eight navigation pages remain present', await evaluate('document.querySelectorAll(".nav-item").length===8'));
    check('Opening a page does not perform a release check or install', fixture.writes.length === 0);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 844, mobile: true, deviceScaleFactor: 1 });
    await screenshot('updates-notification-375');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
    await click('#snackbarAction');
    await waitFor(async () => await evaluate('document.querySelector("#page-system").classList.contains("is-active")'), 'system navigation');
    await waitText('#updatesStatus', '发现新版本');
    check('Release notes are plain text with no injected elements', await evaluate('!window.releaseInjection && !document.querySelector("#updatesReleaseNotes img") && document.querySelector("#updatesReleaseNotes").textContent.includes("<img")'));
    check('Release link uses safe external-link attributes', await evaluate('document.querySelector("#updatesRelease").target==="_blank" && document.querySelector("#updatesRelease").rel.includes("noopener")'));

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await refresh();
    check('The same version is not announced again', await evaluate('!document.querySelector("#snackbar").classList.contains("is-visible")'));
    await click('#updatesAutomatic');
    await waitFor(async () => fixture.writes.some((write) => write.path.endsWith('/settings')), 'settings save');
    await waitFor(async () => await evaluate('!document.querySelector("#updatesAutomatic").disabled'), 'settings restored');
    check('Automatic checking preference saves without any install request', fixture.status.automatic === false && fixture.writes.at(-1).body.automatic === false);
    await click('#updatesCheck');
    await waitFor(async () => fixture.writes.some((write) => write.path.endsWith('/check')), 'manual check');
    await waitFor(async () => await evaluate('!document.querySelector("#updatesCheck").disabled'), 'check finished');
    check('Manual check sends POST exactly once', fixture.writes.filter((write) => write.path.endsWith('/check')).length === 1);

    const installCount = () => fixture.writes.filter((write) => write.path.endsWith('/install')).length;
    const writesBeforeCancel = fixture.writes.length;
    await click('#updatesInstall');
    await waitFor(async () => await evaluate('!document.querySelector("#dialogScrim").hidden'), 'install confirmation');
    check('Confirmation describes retained data and restart impact', await evaluate('["配置","人格","记忆","桥接","托盘","DSH 保持运行"].every(text=>document.querySelector("#dialogBody").textContent.includes(text))'));
    check('Cancel receives initial keyboard focus', await evaluate('document.activeElement.id==="dialogCancel"'));
    await screenshot('updates-confirmation');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await waitFor(async () => await evaluate('document.querySelector("#dialogScrim").hidden'), 'keyboard cancellation');
    check('Cancellation sends no mutating request', installCount() === 0 && fixture.writes.length === writesBeforeCancel);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    for (const width of [375, 768, 1440]) {
      for (const scheme of ['light', 'dark']) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1000, mobile: width < 600, deviceScaleFactor: 1 });
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        const layout = await evaluate(`(() => {
          const card=document.querySelector(".updates-card");
          const overflow=[...card.querySelectorAll("*"),card].filter(node=>{
            if(node.matches(".ripple__wave")||node.closest("[hidden]")||!node.getClientRects().length)return false;
            const r=node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth+1;
          }).map(node=>node.id||node.tagName);
          const visibleButtons=[...card.querySelectorAll(".btn")].filter(node=>!node.hidden);
          const textOverflow=visibleButtons.filter(node=>{
            const label=[...node.children].find(child=>child.tagName==="SPAN"&&!child.matches(".ripple__wave"));
            if(!label)return false;
            const outer=node.getBoundingClientRect(),inner=label.getBoundingClientRect();
            return inner.left<outer.left-1||inner.right>outer.right+1;
          }).map(node=>node.id);
          return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow,textOverflow};
        })()`);
        report.layouts.push({ scheme, ...layout });
        check(`Update controls fit ${width}px ${scheme}`, layout.scrollWidth <= width + 1 && layout.overflow.length === 0 && layout.textOverflow.length === 0);
        await screenshot(`updates-${width}-${scheme}`);
      }
    }

    await click('#updatesInstall');
    await click('#dialogOk');
    await waitText('#updatesStatus', '正在下载');
    check('Install submits only the confirmed version', installCount() === 1 && fixture.writes.at(-1).body.version === '0.3.0');
    check('All mutation requests use the latest CSRF token and JSON', fixture.writes.every((write) => write.validToken && write.contentType === 'application/json'));
    check('Download shows numeric progress and disables duplicate install', await evaluate('document.querySelector("#updatesProgress").value===42 && document.querySelector("#updatesInstall").disabled'));
    await click('#updatesInstall');
    check('Disabled install cannot submit again', installCount() === 1);
    fixture.status = { ...fixture.status, phase: 'error', progress: null, error: '下载暂时失败，可重试' };
    await waitText('#updatesStatus', '下载暂时失败');
    check('An installation failure offers a retry', await evaluate('!document.querySelector("#updatesInstall").disabled && document.querySelector("#updatesInstallLabel").textContent.includes("重试")'));

    fixture.status = { ...fixture.status, phase: 'available', error: '' };
    await refresh();
    await click('#updatesInstall');
    await click('#dialogOk');
    await waitText('#updatesStatus', '正在下载');
    fixture.offline = true;
    await waitText('#updatesStatus', '等待重新连接');
    check('Restart disconnect keeps install locked', await evaluate('document.querySelector("#updatesInstall").disabled'));
    const beforeRecovery = navigations;
    fixture.offline = false;
    fixture.status = { ...fixture.status, phase: 'complete', progress: null };
    await waitText('#updatesStatus', '正在安装并重启');
    await sleep(2200);
    check('Complete from the old server does not reload too early', navigations === beforeRecovery);
    fixture.status = { ...fixture.status, currentVersion: '0.3.0', phase: 'current' };
    await waitFor(async () => navigations > beforeRecovery, 'reload after upgraded server returns');
    await ready();
    await waitText('#updatesStatus', '已是最新版本');
    check('Recovered page hides installation for the installed version', await evaluate('document.querySelector("#updatesInstall").hidden'));
    fixture.status = { ...fixture.status, canInstall: false, installReason: '尚未发现可安装的新版。' };
    await refresh();
    check('An up-to-date portable installation is not described as manual-only', !(await text('#updatesHint')).includes('Docker'));

    fixture.status = { ...baseStatus(), latestVersion: '0.4.0', canInstall: false, installReason: '源码运行，请手动更新。', releaseUrl: 'javascript:alert(1)' };
    await refresh();
    check('Source and Docker instructions retain manual-update route', (await text('#updatesHint')).includes('Docker') && (await text('#updatesHint')).includes('源码'));
    check('Unsafe release URLs and unsupported automatic install stay hidden', await evaluate('document.querySelector("#updatesRelease").hidden && !document.querySelector("#updatesRelease").hasAttribute("href") && document.querySelector("#updatesInstall").hidden'));
    fixture.status = { ...fixture.status, phase: 'current', latestVersion: '', releaseNotes: '' };
    await refresh();
    await waitText('#updatesStatus', '没有正式发布版本');
    check('A repository with no release has a clear empty state', true);
    fixture.status = { ...fixture.status, phase: 'error', error: '无法连接 GitHub，请稍后重试' };
    await refresh();
    check('Offline release checks show a retryable error', (await text('#updatesStatus')).includes('无法连接 GitHub') && await evaluate('!document.querySelector("#updatesCheck").disabled'));
    fixture.missing = true;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await refresh();
    await waitText('#updatesStatus', '旧版本控制台');
    check('Old-server 404 leaves ordinary system information working', await evaluate('document.querySelectorAll("#systemInfo dt").length>=10 && !document.querySelector("#updatesCheck").disabled'));
    await refresh();
    check('Repeated failed status reads do not produce failure toasts', await evaluate('!document.querySelector("#snackbar").classList.contains("is-visible")'));
    check('Background reads never trigger a release check', fixture.writes.filter((write) => write.path.endsWith('/check')).length === 1);
    check('Browser has no unhandled JavaScript errors', report.errors.length === 0);
    report.passed = true;
    report.visualRegression = 'INCONCLUSIVE: no baseline for the new region; six screenshots and geometry checks recorded.';
    await writeFile(path.join(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`通过 ${report.checks.length} 项；失败 0 项；布局 ${report.layouts.length} 个；JS 错误 ${report.errors.length} 个。`);
    console.log('截图与报告：state/updates-ui/');
  } finally {
    if (!report.passed) {
      if (cdp) {
        const image = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (image) await writeFile(path.join(OUTPUT, 'failure.png'), Buffer.from(image.data, 'base64'));
      }
      await writeFile(path.join(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.ws.close();
    }
    if (browser && browser.exitCode === null) {
      await Promise.race([exited, sleep(2500)]);
      if (browser.exitCode === null) {
        const killer = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await new Promise((resolve) => { killer.once('exit', resolve); killer.once('error', resolve); });
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
      && path.basename(resolved).startsWith('fatwhale-updates-ui-'), 'Owned temporary profile only');
    await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
