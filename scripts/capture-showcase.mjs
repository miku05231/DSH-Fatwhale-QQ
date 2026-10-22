/**
 * Capture the unchanged console with isolated, fictional demo API responses.
 * Usage: node scripts/capture-showcase.mjs
 * Requires Node 22+ and Microsoft Edge; no npm packages or running bot needed.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meta as replyTtsMeta } from '../src/plugins/reply-tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES_ONLY = process.argv.includes('--features-only');
if (process.argv.slice(2).some((arg) => arg !== '--features-only')) throw new Error('Only --features-only is supported.');
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC = path.join(ROOT, 'src', 'webui', 'public');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const REPORT = path.join(ROOT, 'state', FEATURES_ONLY ? 'features-showcase-validation.json' : 'showcase-validation.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = new Date();
const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
const date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai' });
const logs = [
  `[${date} ${time}] [bridge] OneBot 已连接，消息桥接就绪`,
  `[${date} ${time}] [persona] 已载入人格：大肥鱼`,
  `[${date} ${time}] [memory] 记忆索引已更新：128 篇 Markdown`,
  `[${date} ${time}] [queue] 群聊消息处理完成，回复已发送`,
  `[${date} ${time}] [bridge] 心跳正常 · 队列 0 · 活跃会话 6`,
];
const memory = {
  root: 'D:\\Fatwhale\\memory',
  files: 128,
  totalBytes: 394240,
  lastUpdated: ago(8),
  byDir: { 群聊: 48, 用户: 36, 日志: 32, 反思: 12 },
};
const personaBody = `# 大肥鱼

## 说话风格
自然、简短，有自己的想法。认真回答问题，也接得住日常闲聊。
用清楚的中文表达，不堆砌术语；需要解释时，先说结论，再补例子。

## 人设与相处
你是群里熟悉的朋友，昵称叫大肥鱼。
记得大家分享过的偏好和约定，尊重每个会话的边界。
遇到不知道的事情坦率说明，查证后再回答。

## 记忆
把值得记住的共同经历整理成 Markdown 笔记。
定期回顾、合并重复信息，保持记忆清晰。
`;
const model = {
  mode: 'manual',
  effective: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  desktop: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  manual: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  providers: [
    { id: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'openai', models: ['gpt-4.1', 'gpt-4.1-mini'] },
  ],
  efforts: ['off', 'high', 'max'],
  generatedAt: ago(12),
  updatedAt: ago(12),
};
const notes = [
  {
    path: '群聊/周末计划.md',
    title: '周末计划',
    score: 0.96,
    snippet: '群聊里约好周六下午一起看电影，随后分享各自喜欢的配乐。',
  },
  {
    path: '群聊/共同约定.md',
    title: '共同约定',
    score: 0.89,
    snippet: '群聊中的问题先讲重点，需要展开时再补充。重要日程确认后再记入笔记。',
  },
];

function demoData(url) {
  switch (url.pathname) {
    case '/api/overview':
      return {
        version: VERSION,
        now: now.toISOString(),
        uptimeSeconds: 9440,
        ports: { onebot: 3001, napcatWebui: 6099, webui: 5830 },
        napcat: { running: true, portOpen: true, qqRunning: true },
        bridge: {
          running: true, connected: true, pid: 12048, sessions: 6,
          queueDepth: 0, inFlight: 0, lastMessageAt: ago(1), lastError: '',
        },
        dsh: { running: true, processName: 'DeepSeek-Harmony.exe' },
        today: { messages: 246 },
        memory: { ok: true, data: memory },
        runtime: {
          node: process.version, platform: 'win32 x64',
          memoryRoot: memory.root, configPath: 'D:\\Fatwhale\\config.json',
        },
      };
    case '/api/logs':
      return { missing: false, file: 'state/bridge.log', lines: logs };
    case '/api/memory/stats':
      return memory;
    case '/api/memory/search':
      return { count: notes.length, items: notes };
    case '/api/memory/note':
      return { body: '# 周末计划\n\n周六下午一起看电影。\n之后分享各自喜欢的配乐，整理一份群聊歌单。' };
    case '/api/reflect':
      return {
        running: false, settings: { daily: true, time: '04:00', backup: true },
        reflection: { name: '本周反思.md', exists: true, bytes: 2460 },
        lastRunAt: ago(130), lastOk: true, lastBackup: 'state/reflection-backup/',
        nextAt: new Date(now.getTime() + 10 * 3600_000).toISOString(),
        lines: ['[反思] 已整理本周对话，合并重复记忆', '[完成] 新增 3 条记忆，更新 2 篇笔记；旧稿已备份'],
      };
    case '/api/personas':
      return {
        dir: 'state/personas', active: '大肥鱼', chats: { 'group:200000001': '学习搭子' },
        items: [
          { name: '大肥鱼', active: true, preview: '自然、有趣，也认真记得每一次对话。', size: Buffer.byteLength(personaBody) },
          { name: '学习搭子', active: false, preview: '把复杂问题讲清楚，一起拆解和复盘。', size: 1286 },
          { name: '安静陪伴', active: false, preview: '温和、耐心，给日常留一点慢下来的空间。', size: 1084 },
        ],
      };
    case '/api/persona':
      return {
        mode: 'library', name: '大肥鱼', path: 'state/personas/大肥鱼.md',
        body: personaBody, size: Buffer.byteLength(personaBody), updatedAt: ago(28),
      };
    case '/api/model':
      return model;
    case '/api/sessions':
      return {
        items: Array.from({ length: 6 }, (_, i) => ({
          qq: String(200000001 + i), kind: i < 4 ? 'group' : 'private',
          sessionId: `demo-session-${String(i + 1).padStart(2, '0')}`, sources: ['QQ'],
        })),
      };
    case '/api/plugins':
      return {
        failures: [],
        plugins: [
          {
            ...replyTtsMeta, enabled: false, hooks: ['afterReply'],
            config: Object.fromEntries(replyTtsMeta.configSchema.map((field) => [field.key, field.default])),
          },
          {
            name: 'hello', displayName: '问候', version: '1.0.0',
            description: '用简单的问候开始一段对话', enabled: true, hooks: ['onMessage'],
            config: {}, configSchema: [],
          },
          {
            name: 'cooldown', displayName: '消息冷却', version: '1.0.0',
            description: '忙碌时让群聊回复保持从容', enabled: true, hooks: ['beforeMessage'],
            config: { seconds: 3 }, configSchema: [{ key: 'seconds', label: '冷却秒数', type: 'int' }],
          },
        ],
      };
    case '/api/stickers':
      return {
        root: 'state/stickers', rootExists: true, count: 0, total: 0, animated: 0, bytes: 0,
        items: [], tags: [],
        settings: { root: 'state/stickers', autoCollect: true, autoTag: true, perMinute: 20, maxPerMessage: 3 },
      };
    case '/api/settings':
      return {
        behavior: { showErrors: false, groupContextCount: 20, wakeWord: '', wakeWordMatch: 'prefix', sessionWindowMinutes: 180 },
        dsh: { cwd: 'qq-workspace' },
        jev: { baseUrl: 'https://api.example.com/v1', model: 'jev-chat', hasToken: true, timeoutMs: 8000, contextMessages: 12 },
        security: {
          adminUserIds: [100000001],
          allowGroupMembers: true, allowGroups: true, privatePolicy: 'allowlist',
          allowFrom: [100000001], denyFrom: [], allowGroupIds: [200000001], denyGroupIds: [],
        },
      };
    case '/api/automation/bilibili':
      return {
        config: {
          enabled: false, cron: '0 9,18 * * *', keywords: ['人工智能', '开源项目'],
          upUsers: ['100000001'], targets: ['g:200000001'], mentionUid: '100000002',
          commentEnabled: false, commentApproved: false,
        },
        cookieAvailable: true, nextRunAt: null, busy: false, blockedReason: '', todayComments: 0,
        commentPublicationAvailable: true, commentPublicationStatus: '自动评论已关闭', audit: [],
        lastRun: { status: 'ok', at: ago(20), found: 12, published: 0 },
        automationToken: '0'.repeat(64),
      };
    case '/api/updates':
      return {
        currentVersion: VERSION, latestVersion: VERSION, phase: 'idle', automatic: false,
        checkedAt: ago(5), available: false, releaseUrl: '', releaseNotes: '',
        canInstall: false, installReason: '', progress: null, error: '',
      };
    case '/api/autostart':
      return { available: true, enabled: false };
    case '/api/paths':
      return {
        persona: { raw: 'qq-workspace/AGENTS.md', resolved: 'D:\\Fatwhale\\qq-workspace\\AGENTS.md', exists: true, isFile: true, bytes: 1280 },
        memory: { raw: 'state/memory', resolved: memory.root, exists: true, isDir: true },
        workspace: { raw: 'qq-workspace', resolved: 'D:\\Fatwhale\\qq-workspace', exists: true, isDir: true },
      };
    default:
      return undefined;
  }
}

async function startDemoServer() {
  const files = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
    ['/app-icon.png', 'app-icon.png', 'image/png'],
  ].map(async ([url, file, type]) => [url, { bytes: await readFile(path.join(PUBLIC, file)), type }])));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'The showcase API is read-only.' }));
      return;
    }
    const file = files.get(url.pathname);
    if (file) {
      res.writeHead(200, { 'Content-Type': file.type });
      res.end(file.bytes);
      return;
    }
    const data = demoData(url);
    res.writeHead(data === undefined ? 404 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data === undefined ? { ok: false, error: 'Unknown demo endpoint' } : { ok: true, data }));
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
    this.events = new Map();
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else {
        for (const handler of this.events.get(msg.method) || []) handler(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
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

  on(method, handler) {
    const handlers = this.events.get(method) || [];
    handlers.push(handler);
    this.events.set(method, handlers);
  }
}

async function findEdge() {
  for (const candidate of [
    process.env.SHOWCASE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('Microsoft Edge not found. Set SHOWCASE_BROWSER to its executable path.');
}

async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function removeOwnedProfile(profile) {
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('fatwhale-showcase-')) {
    throw new Error('Refusing to remove a profile outside the owned temporary directory.');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function main() {
  const edge = await findEdge();
  await mkdir(SHOTS, { recursive: true });
  const { server, origin } = await startDemoServer();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'fatwhale-showcase-'));
  let browser;
  let cdp;
  let exited;
  const result = {
    demoData: true,
    unchangedFrontend: ['src/webui/public/index.html', 'src/webui/public/app.css', 'src/webui/public/app.js'],
    screenshots: [], layouts: [], errors: [], failedRequests: [],
  };
  try {
    browser = spawn(edge, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    let spawnError;
    browser.once('error', (error) => { spawnError = error; });
    exited = new Promise((resolve) => browser.once('exit', resolve));
    const debugPort = await waitFor(async () => {
      if (spawnError) throw spawnError;
      return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    }, 'Edge DevTools');
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find((item) => item.type === 'page');
    if (!target) throw new Error('No browser page available');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => result.errors.push(exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') result.errors.push(args.map((arg) => arg.value || arg.description).join(' '));
    });
    cdp.on('Network.responseReceived', ({ response }) => {
      if (response.status >= 400) result.failedRequests.push(`${response.status} ${new URL(response.url).pathname}`);
    });
    const pending = new Set();
    cdp.on('Network.requestWillBeSent', ({ requestId }) => pending.add(requestId));
    cdp.on('Network.loadingFinished', ({ requestId }) => pending.delete(requestId));
    cdp.on('Network.loadingFailed', ({ requestId, errorText }) => {
      pending.delete(requestId);
      result.failedRequests.push(errorText);
    });
    const evaluate = async (expression) => {
      const value = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
      return value.result.value;
    };
    const settled = async () => {
      await waitFor(async () => pending.size === 0
        && await evaluate('document.readyState === "complete" && document.fonts.status === "loaded"'), 'page resources');
      await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      await sleep(100);
    };
    const viewport = async (width, height, scheme = 'light') => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: scheme },
          { name: 'prefers-reduced-motion', value: 'reduce' },
        ],
      });
      await settled();
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error("Missing click target");
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await settled();
    };
    const readyChecks = {
      overview: 'document.querySelectorAll("#serviceCards .svc").length === 3 && document.querySelector("#statMemory").textContent === "128"',
      memory: 'document.querySelectorAll("#memoryStats .stat").length === 5 && document.querySelector("#reflectLog").textContent.includes("完成")',
      stickers: 'document.querySelectorAll("#stickerStats .stat").length === 4',
      persona: 'document.querySelectorAll("#personaList .persona-row").length === 3 && document.querySelector("#personaBody").value.length > 100',
      sessions: 'document.querySelectorAll("#sessionList .session").length === 6',
      model: 'document.querySelector("#modelCurrent").textContent === "deepseek/deepseek-chat"',
      plugins: 'document.querySelectorAll("#pluginsList .plugin-card").length === 3',
      automation: 'document.querySelector("#biliCron").value === "0 9,18 * * *"',
      system: 'document.querySelectorAll("#systemInfo dt").length >= 13 && document.querySelector("#setWorkspaceCwd").value.length > 0',
    };
    const navigate = async (page) => {
      await click(`.nav-item[data-page="${page}"]`);
      await waitFor(async () => await evaluate(readyChecks[page]), `${page} data`);
      await settled();
    };
    const layout = async (page, width) => {
      const geometry = await evaluate(`(() => {
        const overflow = [...document.querySelectorAll(".page.is-active *, .nav-bar, .nav-item, .nav-item__pill")]
          .filter(node => {
            if (node.closest("[hidden]") || !node.getClientRects().length) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && (rect.right > innerWidth + 1.5 || rect.left < -1.5);
          }).map(node => node.id || node.className || node.tagName);
        const fab = document.querySelector("#fab").getBoundingClientRect();
        const nav = document.querySelector(".nav-bar").getBoundingClientRect();
        const overlap = (selector) => {
          const boxes = [...document.querySelectorAll(selector)].map(node => node.getBoundingClientRect());
          return boxes.slice(1).some((box, i) => box.left < boxes[i].right - 1);
        };
        return {
          scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth,
          overflow, navScrollWidth: document.querySelector(".nav-bar").scrollWidth,
          fabAboveNav: fab.bottom <= nav.top + 1,
          navIconsOverlap: overlap(".nav-item .icon"),
          navLabelsOverlap: overlap(".nav-item__label"),
        };
      })()`);
      result.layouts.push({ page, width, ...geometry });
    };
    const screenshot = async (name) => {
      await settled();
      const capture = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false, fromSurface: true,
      });
      const file = path.join(SHOTS, `${name}.png`);
      const bytes = Buffer.from(capture.data, 'base64');
      await writeFile(file, bytes);
      result.screenshots.push({
        path: path.relative(ROOT, file).replaceAll('\\', '/'),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length,
      });
    };

    await cdp.send('Page.navigate', { url: `${origin}/#overview` });
    await waitFor(async () => await evaluate(readyChecks.overview), 'overview data');
    if (!FEATURES_ONLY) {
      await viewport(1280, 900);
      await screenshot('console-overview-light');
      await viewport(1280, 900, 'dark');
      await screenshot('console-overview-dark');
      await viewport(1280, 1360);
      await navigate('memory');
      await click('#memoryQuick [data-q="群聊"]');
      await waitFor(async () => await evaluate('document.querySelectorAll("#memoryResults .hit").length === 2'), 'memory search results');
      await screenshot('console-memory');
      await viewport(1280, 1100);
      await navigate('persona');
      await screenshot('console-personas');
      await viewport(1280, 900);
      await navigate('model');
      await screenshot('console-model');
      await viewport(390, 844);
      await navigate('overview');
      await screenshot('console-mobile');
    }

    await viewport(1280, 1100);
    await navigate('system');
    await evaluate('document.querySelector("#jevBaseUrl").closest(".card").scrollIntoView(); window.scrollBy(0, -100)');
    await screenshot('console-jev-settings');
    await navigate('plugins');
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('console-reply-tts');
    await navigate('automation');
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('console-bilibili-automation');
    await evaluate('document.querySelector("#biliMentionUid").scrollIntoView({ block: "center" })');
    await screenshot('console-bilibili-safeguards');

    for (const width of FEATURES_ONLY ? [375, 768, 1440] : [375, 390, 768, 1440]) {
      await viewport(width, width < 600 ? 844 : 900);
      for (const page of FEATURES_ONLY ? ['system', 'plugins', 'automation'] : Object.keys(readyChecks)) {
        await navigate(page);
        await layout(page, width);
      }
    }
    await mkdir(path.dirname(REPORT), { recursive: true });
    result.layoutIssues = result.layouts.filter((item) => item.scrollWidth > item.viewport + 1
      || item.overflow.length > 0 || item.navScrollWidth > item.viewport + 1 || !item.fabAboveNav
      || item.navIconsOverlap || item.navLabelsOverlap);
    result.passed = !result.errors.length && !result.failedRequests.length && !result.layoutIssues.length;
    await writeFile(REPORT, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Captured ${result.screenshots.length} screenshots: docs/screenshots/console-*.png`);
    console.log(`Checked ${result.layouts.length} page/viewport layouts; JS errors ${result.errors.length}; failed requests ${result.failedRequests.length}; layout issues ${result.layoutIssues.length}.`);
    console.log(`Validation: ${path.relative(ROOT, REPORT).replaceAll('\\', '/')}`);
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.ws.close();
    }
    if (browser && browser.exitCode === null) {
      await Promise.race([exited, sleep(3000)]);
      if (browser.exitCode === null) {
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('exit', resolve);
          killer.once('error', resolve);
        });
        await Promise.race([exited, sleep(3000)]);
      }
    }
    await new Promise((resolve) => server.close(resolve));
    await removeOwnedProfile(profile);
  }
}

main().catch((error) => {
  console.error(`Showcase capture failed: ${error.message}`);
  process.exitCode = 1;
});
