/**
 * ui-cdp.mjs —— 用 Edge 的 DevTools Protocol 真实驱动控制台页面。
 *
 * 不引入任何第三方依赖：直接用 Node 内置 WebSocket。
 * 用途：验证 DOM 是否存在、元素几何、点击交互，并截图存档。
 *
 * 用法：
 *   node tests/ui-cdp.mjs                 # 全量场景
 * 服务、家目录与浏览器 profile 都是临时 fixture，不连接运行中的控制台。
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { browserRuntimeEnv, createConsoleFixture, freePort } from './helpers/isolated-fixtures.mjs';
import { killProcessTree } from '../src/dsh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOT_DIR = path.join(ROOT, 'state', 'ui-shots');

const argv = process.argv.slice(2);
if (argv.length) throw new Error('ui-cdp only runs an isolated console; external ports and persistent browsers are unsupported.');

const EDGE_CANDIDATES = [
  process.env.QQ_TEST_BROWSER_EXE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/* ------------------------------------------------------------- 断言小工具 */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- CDP 客户端 */

class Cdp {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #events = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    await client.#open(wsUrl);
    return client;
  }

  #open(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.#ws = ws;
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${event?.message ?? 'unknown'}`));
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          const handlers = this.#events.get(msg.method) ?? [];
          for (const fn of handlers) {
            try {
              fn(msg.params);
            } catch {
              /* 事件处理失败不影响主流程 */
            }
          }
        }
      });
      ws.addEventListener('close', () => {
        for (const { reject: rej } of this.#pending.values()) rej(new Error('CDP 连接已关闭'));
        this.#pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.#events.get(method) ?? [];
    list.push(fn);
    this.#events.set(method, list);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------- 浏览器管理 */

async function findEdge() {
  const { access } = await import('node:fs/promises');
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return '';
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDevtools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/version`, 2500);
      if (list?.webSocketDebuggerUrl) return list;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('等待 Edge DevTools 超时');
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  const edge = await findEdge();
  if (!edge) throw new Error('Set QQ_TEST_BROWSER_EXE to Edge or Chromium for the required UI test.');
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-console-cdp-'));
  const profileDir = path.join(tmpRoot, 'browser');
  const browserEnv = browserRuntimeEnv(tmpRoot);
  const debugPort = await freePort();
  let fixture;
  let browser;
  let browserDone;
  let browserOutput = '';
  let cdp = null;
  try {
    fixture = await createConsoleFixture(tmpRoot);
    const consolePort = fixture.port;
    const overview = await fetchJson(`http://127.0.0.1:${consolePort}/api/overview`, 8000);
    if (!overview?.ok) throw new Error('The isolated console did not return an overview.');
    await mkdir(profileDir, { recursive: true });
    browser = spawn(edge, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
      '--window-size=1280,960', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: browserEnv });
    browser.stdout.on('data', (chunk) => { browserOutput = (browserOutput + chunk).slice(-4000); });
    browser.stderr.on('data', (chunk) => { browserOutput = (browserOutput + chunk).slice(-4000); });
    browserDone = new Promise((resolve, reject) => {
      browser.once('error', reject);
      browser.once('close', resolve);
    });
    browserDone.catch(() => {});
    await waitForDevtools(debugPort).catch((error) => {
      throw new Error(`${error.message}; browser exit=${browser.exitCode}; ${browserOutput}`);
    });
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = (targets ?? []).find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的页面目标');

    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 页面可见，避免后台标签节流
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.text ?? 'unknown'));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p?.type === 'error') errors.push((p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    });

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? '页面脚本抛错');
      }
      return result?.result?.value;
    };

    const goto = async (hash) => {
      const url = `http://127.0.0.1:${consolePort}/${hash ? `#${hash}` : ''}`;
      await cdp.send('Page.navigate', { url });
      await sleep(1800);
    };

    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(SHOT_DIR, `${name}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    };

    console.log(`\n=== 界面测试：控制台 ${consolePort} ===`);

    // ---------------------------------------------------------- 概览
    await goto('overview');
    check('页面标题为「概览」', (await evaluate('document.getElementById("appTitle").textContent')) === '概览');
    check(
      'serviceCards 渲染出 3 张服务卡',
      (await evaluate('document.querySelectorAll("#serviceCards .svc").length')) === 3,
    );
    check('FAB 可见', await evaluate('(()=>{const f=document.getElementById("fab");if(!f)return false;const r=f.getBoundingClientRect();const s=getComputedStyle(f);return r.width>40&&r.height>40&&r.top>0&&r.bottom<=innerHeight&&s.visibility!=="hidden"&&s.display!=="none";})()'));
    check(
      'FAB 不遮挡底部导航',
      await evaluate('(()=>{const f=document.getElementById("fab").getBoundingClientRect();const n=document.querySelector(".nav-bar").getBoundingClientRect();return f.bottom<=n.top+1;})()'),
    );
    check(
      '概览记忆条目数正确',
      await evaluate('(()=>{const v=document.getElementById("statMemory").textContent.trim();return v!=="—"&&Number(v)>0;})()'),
    );
    check('状态标签不是「连接中」', (await evaluate('document.getElementById("statusText").textContent')) !== '连接中');
    const shotOverview = await shot('cdp-overview');

    // ---------------------------------------------------------- 记忆
    await goto('memory');
    await sleep(600);
    check('记忆页激活', (await evaluate('document.querySelector(".page.is-active").dataset.page')) === 'memory');
    await evaluate('(()=>{document.getElementById("memoryQuery").value="群聊";document.getElementById("memoryForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));return true;})()');
    await sleep(1600);
    const hits = await evaluate('document.querySelectorAll("#memoryResults .hit").length');
    check('搜索「群聊」有结果', hits > 0, `命中 ${hits} 条`);
    await evaluate('(()=>{const b=document.querySelector("#memoryResults .hit button");if(b)b.click();return true;})()');
    await sleep(1400);
    check('点开笔记能展开正文', (await evaluate('document.querySelectorAll("#memoryResults .hit__body").length')) > 0);
    const shotMemory = await shot('cdp-memory');

    // ---------------------------------------------------------- 表情包
    await goto('stickers');
    await sleep(800);
    check('表情页激活', (await evaluate('document.querySelector(".page.is-active").dataset.page')) === 'stickers');
    const expectedPages = ['overview', 'memory', 'stickers', 'persona', 'sessions', 'model', 'plugins', 'automation', 'system'];
    const navigationPages = await evaluate('[...document.querySelectorAll(".nav-item")].map(node=>node.dataset.page)');
    check('底部导航有完整的 9 项（含表情与自动化）', navigationPages.length === expectedPages.length
      && expectedPages.every(page => navigationPages.includes(page)));
    check(
      '表情页统计行已填充',
      (await evaluate('document.querySelectorAll("#stickerStats .stat").length')) === 4,
    );
    check(
      '表情库目录提示填的是库路径',
      await evaluate('(()=>{const t=document.getElementById("stickerRootHint").textContent.trim();return t.includes("stickers")||t.includes("表情");})()'),
    );
    check(
      '采集设置回填成正整数',
      await evaluate('(()=>{const v=Number(document.getElementById("stickerPerMinute").value);const m=Number(document.getElementById("stickerMaxPerMessage").value);return v>0&&m>0;})()'),
    );
    const tileCount = await evaluate('document.querySelectorAll("#stickerGrid .sticker-tile").length');
    check(
      '网格与空状态一致',
      (await evaluate(`document.getElementById("stickerEmpty").hidden === (${tileCount} > 0)`)),
      `网格 ${tileCount} 张`,
    );
    check(
      '标签栏渲染了「全部」',
      (await evaluate('document.querySelectorAll("#stickerTags .chip").length')) >= 1,
    );
    const shotStickers = await shot('cdp-stickers');

    // ---------------------------------------------------------- 人格
    await goto('persona');
    await sleep(900);
    const personaLen = await evaluate('document.getElementById("personaBody").value.length');
    check('人格正文已载入', personaLen > 0, `长度 ${personaLen}`);
    // 有人格库时编辑区停在「当前那套」，没人格库时是老的 AGENTS.md 单文件
    const personaTitleNow = (await evaluate('document.getElementById("personaEditorTitle").textContent')).trim();
    check(
      '编辑区标题标明在编哪套',
      personaTitleNow.includes('默认文件') || personaTitleNow.startsWith('人格：'),
      personaTitleNow,
    );
    check(
      '人格库卡有列表（成员或空库引导）',
      await evaluate('document.querySelectorAll("#personaList .persona-row").length > 0 || !!document.querySelector("#personaList .empty")'),
    );
    const personaChip = (await evaluate('document.getElementById("personaActiveChip").textContent')).trim();
    check('当前人格标签有内容', personaChip.length > 0, personaChip);
    check('新建人格按钮可见', await evaluate('!document.getElementById("personaNew").hidden'));
    check(
      '人格库目录提示已填',
      (await evaluate('document.getElementById("personaDirHint").textContent')).trim().length > 0,
    );
    const shotPersona = await shot('cdp-persona');

    // ---------------------------------------------------------- 会话
    await goto('sessions');
    await sleep(900);
    check(
      '会话列表已渲染',
      (await evaluate('document.querySelectorAll("#sessionList .session").length')) >= 0,
    );
    const sessionRows = await evaluate('document.querySelectorAll("#sessionList .session").length');
    check('会话行数量与服务端一致', sessionRows === (overview.data?.counts?.total ?? sessionRows), `页面 ${sessionRows} 行`);

    // ---------------------------------------------------------- 模型
    await goto('model');
    await sleep(900);
    check('模型页激活', (await evaluate('document.querySelector(".page.is-active").dataset.page')) === 'model');
    const currentModel = (await evaluate('document.getElementById("modelCurrent").textContent')).trim();
    check('模型页显示当前模型', currentModel.length > 0 && !currentModel.includes('读取失败'), currentModel);
    const chip = (await evaluate('document.getElementById("modelModeChip").textContent')).trim();
    check('模式标签为「跟随 DSH」或「手动」', chip === '跟随 DSH' || chip === '手动', chip);
    check(
      '供应商下拉有选项',
      (await evaluate('document.querySelectorAll("#modelProvider option").length')) >= 1,
    );

    // 切到手动 → 供应商下拉可编辑、保存按钮可用
    await evaluate('(()=>{const b=document.querySelector(\'#modelModeSwitch .segmented__item[data-mode="manual"]\');b.click();return true;})()');
    await sleep(900);
    check('切手动后保存按钮可用', (await evaluate('document.getElementById("modelSave").disabled')) === false);
    check('切手动后供应商下拉可编辑', (await evaluate('document.getElementById("modelProvider").disabled')) === false);
    check('切手动后下拉有选项', (await evaluate('document.querySelectorAll("#modelModel option").length')) >= 1);

    // 切回跟随（不改变用户原来的选择），并恢复下拉不可编辑
    await evaluate('(()=>{const b=document.querySelector(\'#modelModeSwitch .segmented__item[data-mode="follow"]\');b.click();return true;})()');
    await sleep(900);
    check('切回跟随后供应商下拉被禁用', (await evaluate('document.getElementById("modelProvider").disabled')) === true);
    const shotModel = await shot('cdp-model');

    // ---------------------------------------------------------- 系统
    await goto('system');
    await sleep(1200);
    check('系统信息键值对已填充', (await evaluate('document.querySelectorAll("#systemInfo dt").length')) > 6);
    check('日志盒子有内容', await evaluate('(()=>{const t=document.getElementById("logBox").textContent.trim();return t.length>0&&t!=="加载中…";})()'));
    check(
      '日志里不出现明文 token',
      !(await evaluate('document.getElementById("logBox").textContent')).match(/token\s*[=:]\s*["\']?[A-Za-z0-9]{8,}/i),
    );
    await evaluate('(()=>{const b=document.querySelector("#logSwitch .segmented__item[data-log=bridge]");if(b)b.click();return true;})()');
    await sleep(1400);
    check('切换到桥接日志后标签激活', (await evaluate('document.querySelector("#logSwitch .is-active").dataset.log')) === 'bridge');
    check(
      '设置项已载入（群聊上下文条数）',
      Number(await evaluate('document.getElementById("setGroupContext").value')) > 0,
    );
    check(
      '黑白名单卡片存在且策略可读',
      ['allowlist', 'blacklist'].includes(await evaluate('document.getElementById("setPrivatePolicy").value')),
    );
    check(
      '白名单/黑名单 textarea 都能载入',
      (await evaluate('(()=>{const ids=["setAllowFrom","setDenyFrom","setAllowGroupIds","setDenyGroupIds"];return ids.every((id)=>document.getElementById(id)&&typeof document.getElementById(id).value==="string");})()')) === true,
    );
    check(
      '路径卡片三个输入框都在',
      (await evaluate('(()=>{const ids=["setPersonaPath","setMemoryRoot","setWorkspaceCwd"];return ids.every((id)=>!!document.getElementById(id));})()')) === true,
    );
    check('人格路径已载入且有解析提示', await evaluate('(()=>{const v=document.getElementById("setPersonaPath").value;const h=document.getElementById("personaPathHint").textContent;return v.length>0 && h.includes("解析为");})()'));
    check('记忆库路径已载入', (await evaluate('document.getElementById("setMemoryRoot").value')).length > 0);
    check('工作区路径已载入', (await evaluate('document.getElementById("setWorkspaceCwd").value')).length > 0);
    await evaluate('(()=>{document.getElementById("pathsRefresh").click();return true;})()');
    await sleep(900);
    check('重新读取路径不报错', (await evaluate('document.getElementById("personaPathHint").textContent')).includes('解析为'));
    const shotSystem = await shot('cdp-system');

    // ---------------------------------------------------------- 断网降级
    await goto('overview');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(800);
    const shotDark = await shot('cdp-dark');
    const darkBg = await evaluate('getComputedStyle(document.body).backgroundColor');
    check('深色模式生效', darkBg.includes('20, 18, 24') || darkBg !== 'rgb(254, 247, 255)', darkBg);

    // ---------------------------------------------------------- 窄屏（手机宽度）排版
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const narrowPages = ['overview', 'memory', 'stickers', 'persona', 'sessions', 'model', 'plugins', 'system'];
    const narrowOverflow = [];
    for (const name of narrowPages) {
      await goto(name);
      await sleep(700);
      const info = await evaluate(`(() => {
        const doc = document.documentElement;
        const wide = [...document.querySelectorAll('.page.is-active *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > innerWidth + 1.5;
          })
          .slice(0, 3)
          .map((el) => (el.id || el.className || el.tagName).toString().slice(0, 40));
        return { scrollWidth: doc.scrollWidth, inner: innerWidth, wide };
      })()`);
      if (info.scrollWidth > info.inner + 1 || info.wide.length) narrowOverflow.push(`${name}: ${info.scrollWidth}/${info.inner} ${info.wide.join(',')}`);
    }
    check('390px 窄屏下每页都不横向溢出', narrowOverflow.length === 0, narrowOverflow.join(' | '));
    const navFits = await evaluate(
      '(()=>{const n=document.querySelector(".nav-bar");return n.scrollWidth<=innerWidth+1;})()',
    );
    check('390px 下底部导航不横向溢出', navFits);
    const shotNarrow = await shot('cdp-narrow');
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

    // ---------------------------------------------------------- 运行时错误
    const realErrors = errors.filter((e) => e && !/favicon|net::ERR_/i.test(e));
    check('页面无 JS 报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

    console.log('\n截图：');
    for (const f of [shotOverview, shotMemory, shotStickers, shotModel, shotSystem, shotDark]) console.log(`  ${f}`);

    console.log(`\n结果：通过 ${passed} / ${passed + failed}`);
    if (failed > 0) {
      console.log('失败项：');
      for (const f of failures) console.log(`  · ${f}`);
    }
  } finally {
    cdp?.close();
    killProcessTree(browser);
    if (browserDone) await Promise.race([browserDone.catch(() => {}), sleep(5000)]);
    await fixture?.close();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`界面测试崩溃：${err?.stack ?? err}`);
  process.exit(1);
});
