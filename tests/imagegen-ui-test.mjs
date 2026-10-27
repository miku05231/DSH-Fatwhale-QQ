import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { BrowserCdp } from './helpers/browser-cdp.mjs';
import { browserRuntimeEnv, createConsoleFixture } from './helpers/isolated-fixtures.mjs';
import { createImagegenFixture, waitUntil } from './helpers/imagegen-fixture.mjs';
import { killProcessTree } from '../src/dsh.js';

test('image generation browser journey, actual preview, responsive layouts and keyboard labels', { timeout: 90000 }, async () => {
  const f = await createImagegenFixture();
  f.config.plugins = { enabled: true, dir: path.resolve('src/plugins') }; f.save();
  const browserEnv = browserRuntimeEnv(f.root);
  const output = path.resolve('state/.imagegen-runtime/tests', `ui-${Date.now()}`);
  const report = { errors: [], networkErrors: [], layouts: [], screenshots: [], checks: [],
    visualRegression: 'INCONCLUSIVE: new feature has no committed visual baseline.',
    accessibility: 'Automated labels, image alternatives, tab keyboard navigation and geometry; full WCAG/manual screen reader audit not performed.' };
  let consoleFixture;
  let browser;
  let cdp;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-imagegen-browser-'));
  await fs.mkdir(output, { recursive: true });
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  try {
    let executable;
    for (const candidate of [process.env.SHOWCASE_BROWSER, process.env.BROWSER,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean)) {
      try { await fs.access(candidate); executable = candidate; break; } catch { /* Try the next browser. */ }
    }
    if (!executable) throw new Error('A Chromium browser is required for the image generation UI test');
    consoleFixture = await createConsoleFixture(f.root);
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--inprivate',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore', env: browserEnv });
    let spawnError;
    browser.on('error', (error) => { spawnError = error; });
    const debugPort = await waitUntil(async () => {
      if (spawnError) throw spawnError;
      try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return null; }
    }, 15000);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    cdp = await BrowserCdp.connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    cdp.ws.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data);
      if (event.method === 'Runtime.exceptionThrown') report.errors.push(event.params.exceptionDetails.text);
      if (event.method === 'Network.responseReceived' && event.params.response.status >= 400 && /\/api\/imagegen|\/imagegen\.js/.test(event.params.response.url)) {
        report.networkErrors.push({ status: event.params.response.status, path: new URL(event.params.response.url).pathname });
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__imagegenQa={cls:0,lcp:0};
new PerformanceObserver((list)=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__imagegenQa.cls+=entry.value;}).observe({type:'layout-shift',buffered:true});
new PerformanceObserver((list)=>{for(const entry of list.getEntries())window.__imagegenQa.lcp=entry.startTime;}).observe({type:'largest-contentful-paint',buffered:true});` });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const origin = consoleFixture.instance.url.replace(/\/$/, '');
    await cdp.send('Page.navigate', { url: `${origin}/#stickers` });
    await waitUntil(() => cdp.evaluate('document.readyState === "complete" && document.getElementById("stickerCount").textContent !== "—"'));
    const click = async (selector) => {
      const point = await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    await click('#imagegenTab');
    await waitUntil(() => cdp.evaluate('!document.getElementById("imagegenView").hidden && document.getElementById("imagegenEnabled").checked'));
    check('generation tab opens and service settings load', true);
    await cdp.evaluate('document.getElementById("imagegenForm").requestSubmit()');
    check('empty prompt is rejected before a request', f.state.posts.length === 0);
    // A previous job can be left "unknown" if the browser navigated while its
    // submission was in flight. It is a local fixture, so release it before
    // asserting a fresh generation; this keeps the UI flow deterministic.
    for (const job of await f.service.list()) {
      if (job.status === 'unknown') await f.service.release(job.id);
    }
    await click('#imagegenSettings summary');
    await click('#imagegenCheck');
    await waitUntil(() => cdp.evaluate('document.getElementById("imagegenConnection").textContent === "已连接"'));
    await click('#imagegenSettings summary');
    await cdp.evaluate(`document.getElementById('imagegenPrompt').value='一只快乐的机器人，清晰轮廓，白色背景';
document.getElementById('imagegenMode').value='sticker';document.getElementById('imagegenPreset').value='portrait';
document.getElementById('imagegenSeed').value='18446744073709551615';document.getElementById('imagegenTags').value='机器人,开心';`);
    await click('#imagegenGenerate');
    await waitUntil(() => cdp.evaluate(`!!document.querySelector('.imagegen-preview img')?.complete && document.querySelector('.imagegen-preview img').naturalWidth>0`), 20000);
    check('generation form produces a decoded image and sticker import', (await f.service.list())[0]?.sticker?.id);
    check('exact seed and portrait dimensions reach the API', /"seed":18446744073709551615/.test(f.state.posts[0].body) && JSON.parse(f.state.posts[0].body).height === 1344);
    check('preview is private Blob media without a token in its URL', await cdp.evaluate(`document.querySelector('.imagegen-preview img').src.startsWith('blob:')`));
    const pixels = await cdp.evaluate(`(()=>{const img=document.querySelector('.imagegen-preview img');const c=document.createElement('canvas');c.width=32;c.height=32;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,32,32);const p=ctx.getImageData(0,0,32,32).data;const colors=new Set();for(let i=0;i<p.length;i+=4)colors.add([p[i],p[i+1],p[i+2],p[i+3]].join(','));return colors.size;})()`);
    check('preview pixels contain a nonblank image', pixels > 8);
    check('all generation inputs have labels', await cdp.evaluate(`([...document.querySelectorAll('#imagegenView input,#imagegenView textarea,#imagegenView select')].every(e=>e.labels?.length>0))`));
    await cdp.evaluate(`document.getElementById('imagegenTab').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
    check('keyboard switches to library', await cdp.evaluate(`document.getElementById('imagegenView').hidden && document.activeElement.id==='stickerLibraryTab'`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    check('keyboard returns to generation', await cdp.evaluate(`!document.getElementById('imagegenView').hidden && document.activeElement.id==='imagegenTab'`));
    await click('#imagegenSettings summary');
    check('four image platforms and optional password field are available', await cdp.evaluate(`document.getElementById('imagegenProvider').options.length===4 && document.getElementById('imagegenApiKey').type==='password' && document.getElementById('imagegenNoKey').checked`));
    await cdp.evaluate(`document.getElementById('imagegenApiKey').value='browser-fixture-key';document.getElementById('imagegenApiKey').dispatchEvent(new Event('input',{bubbles:true}));`);
    await click('#imagegenSave');
    await waitUntil(() => f.service.readConfig().imagegen.apiKey === 'browser-fixture-key');
    await waitUntil(() => cdp.evaluate(`document.getElementById('imagegenApiKey').value==='' && !document.getElementById('imagegenNoKey').checked`));
    check('saved image key is hidden and an unchanged empty field preserves it', await cdp.evaluate(`document.getElementById('imagegenApiKey').placeholder.includes('已保存')`));
    await click('#imagegenSave');
    await waitUntil(() => cdp.evaluate(`!document.getElementById('imagegenSave').disabled`));
    check('blank unchanged image key preserves the saved value', f.service.readConfig().imagegen.apiKey === 'browser-fixture-key');
    await cdp.evaluate(`(()=>{const k=document.getElementById('imagegenApiKey');k.value='replacement';k.dispatchEvent(new Event('input',{bubbles:true}));k.value='';k.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    check('clearing an edited ComfyUI key selects anonymous authentication', await cdp.evaluate(`document.getElementById('imagegenNoKey').checked`));
    await click('#imagegenSave');
    await waitUntil(() => f.service.readConfig().imagegen.apiKey === '');
    check('saving a deliberately blank ComfyUI key clears image authentication', true);
    await cdp.evaluate(`document.getElementById('imagegenProvider').value='openai';document.getElementById('imagegenProvider').dispatchEvent(new Event('change',{bubbles:true}));`);
    check('OpenAI fills defaults, valid dimensions and hides unsupported samplers', await cdp.evaluate(`document.getElementById('imagegenBaseUrl').value==='https://api.openai.com/v1' && document.getElementById('imagegenModel').value==='gpt-image-1' && document.getElementById('imagegenSteps').disabled && getComputedStyle(document.getElementById('imagegenStepsField')).display==='none' && document.getElementById('imagegenPreset').options[2].textContent.includes('1024 × 1536')`));
    await cdp.evaluate(`document.getElementById('imagegenProvider').value='siliconflow';document.getElementById('imagegenProvider').dispatchEvent(new Event('change',{bubbles:true}));`);
    check('SiliconFlow has its own model and sampling controls', await cdp.evaluate(`document.getElementById('imagegenModel').value==='Kwai-Kolors/Kolors' && !document.getElementById('imagegenSteps').disabled`));
    await cdp.evaluate(`document.getElementById('imagegenProvider').value='openai-compatible';document.getElementById('imagegenProvider').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('imagegenBaseUrl').value=${JSON.stringify(`${f.baseUrl}/v1`)};document.getElementById('imagegenModel').value='fixture-model';`);
    await click('#imagegenSave');
    await waitUntil(() => f.service.readConfig().imagegen.provider === 'openai-compatible');
    f.state.mode = 'syncBase64';
    for (const job of await f.service.list()) {
      if (job.status === 'unknown') await f.service.release(job.id);
    }
    await click('#imagegenSettings summary');
    await cdp.evaluate(`document.getElementById('imagegenPrompt').value='compatible browser fixture';`);
    await click('#imagegenGenerate');
    await waitUntil(async () => (await f.service.list()).length === 2 && (await f.service.list())[0].status === 'completed');
    await waitUntil(() => cdp.evaluate(`document.querySelectorAll('.imagegen-preview img').length===2 && [...document.querySelectorAll('.imagegen-preview img')].every(i=>i.complete&&i.naturalWidth>0)`));
    check('browser can save and generate through a synchronous compatible service', f.state.posts.length === 2 && JSON.parse(f.state.posts[1].body).model === 'fixture-model');

    await cdp.evaluate(`location.hash='#plugins'`);
    await waitUntil(() => cdp.evaluate(`!!document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="provider"]')`));
    const ttsCard = '[data-plugin="reply-tts"]';
    const saveTts = async () => {
      await cdp.evaluate(`window.__ttsBeforeSave=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="speechLanguage"]')`);
      await click(`${ttsCard} [data-role="save-config"]`);
      await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="speechLanguage"]')!==window.__ttsBeforeSave`));
    };
    check('TTS starts with Edge controls and offers four platforms', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="provider"]').options.length===4 && !c.querySelector('[data-plugin-row="voice"]').hidden && c.querySelector('[data-plugin-row="baseUrl"]').hidden && c.querySelector('[data-plugin-row="responseFormat"]').hidden;})()`));
    check('speech language defaults to auto and translation fields stay hidden while disabled', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="speechLanguage"]').value==='auto' && !c.querySelector('[data-plugin-field="translationEnabled"]').checked && ['targetLanguage','translationPrompt','translationTimeoutMs'].every(k=>c.querySelector('[data-plugin-row="'+k+'"]').hidden);})()`));
    await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});const l=c.querySelector('[data-plugin-field="speechLanguage"]');l.value='ja';l.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check('selecting Japanese chooses an Edge Japanese voice without enabling translation', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="voice"]').value==='ja-JP-NanamiNeural' && !c.querySelector('[data-plugin-field="translationEnabled"]').checked;})()`));
    await cdp.evaluate(`(()=>{const e=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="provider"]');e.value='openai';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check('TTS platform change sets API model/voice and hides Edge-only fields', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="model"]').value==='gpt-4o-mini-tts' && c.querySelector('[data-plugin-field="apiVoice"]').value==='alloy' && c.querySelector('[data-plugin-row="voice"]').hidden && !c.querySelector('[data-plugin-row="apiKey"]').hidden;})()`));
    check('official API providers only offer automatic language and clear an unsupported selection', await cdp.evaluate(`(()=>{const l=document.querySelector(${JSON.stringify(ttsCard)}).querySelector('[data-plugin-field="speechLanguage"]');return l.value==='auto' && [...l.options].filter(o=>!o.disabled).every(o=>o.value==='auto');})()`));
    check('API speech exposes MP3 and WAV with the existing MP3 default', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});const f=c.querySelector('[data-plugin-field="responseFormat"]');return !c.querySelector('[data-plugin-row="responseFormat"]').hidden && f.value==='mp3' && [...f.options].map(o=>o.value).join(',')==='mp3,wav';})()`));
    await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});c.querySelector('[data-plugin-field="baseUrl"]').value=${JSON.stringify(f.baseUrl)};const k=c.querySelector('[data-plugin-field="apiKey"]');k.value='browser-tts-key';k.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(`${ttsCard} [data-role="save-config"]`);
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts']?.apiKey === 'browser-tts-key');
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]').placeholder.includes('已保存')`));
    check('TTS key is saved without echoing into the password field', await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]').value===''`));
    await cdp.evaluate(`window.__ttsSaveInput=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]')`);
    await click(`${ttsCard} [data-role="save-config"]`);
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]')!==window.__ttsSaveInput`));
    check('unchanged TTS key survives save', JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].apiKey === 'browser-tts-key');
    await cdp.evaluate(`(()=>{const c=document.querySelector('[data-plugin="reply-tts"]');const k=c.querySelector('[data-plugin-field="apiKey"]');k.value='replacement';k.dispatchEvent(new Event('input',{bubbles:true}));k.value='';k.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    check('clearing an edited TTS key selects anonymous authentication', await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-no-key="apiKey"]').checked`));
    await click(`${ttsCard} [data-role="save-config"]`);
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].apiKey === '');
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]').placeholder.includes('不鉴权')`));
    await cdp.evaluate(`(()=>{const k=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]');k.value='browser-tts-key';k.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(`${ttsCard} [data-role="save-config"]`);
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiKey"]').placeholder.includes('已保存')`));
    await click(`${ttsCard} [data-plugin-no-key="apiKey"]`);
    await click(`${ttsCard} [data-role="save-config"]`);
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].apiKey === '');
    check('TTS key can be explicitly cleared', true);
    await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});const p=c.querySelector('[data-plugin-field="provider"]');p.value='openai-compatible';p.dispatchEvent(new Event('change',{bubbles:true}));c.querySelector('[data-plugin-field="baseUrl"]').value=${JSON.stringify(f.baseUrl)};c.querySelector('[data-plugin-field="model"]').value='irodori-tts';c.querySelector('[data-plugin-field="responseFormat"]').value='wav';const l=c.querySelector('[data-plugin-field="speechLanguage"]');l.value='ja';l.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check('custom speech clears the previous platform voice', await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiVoice"]').value===''`));
    await saveTts();
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].speechLanguage === 'ja');
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="speechLanguage"]').value==='ja' && document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="responseFormat"]').value==='wav'`));
    check('Japanese speech saves and reloads with translation disabled', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="speechLanguage"]').value==='ja' && !c.querySelector('[data-plugin-field="translationEnabled"]').checked && c.querySelector('[data-plugin-row="targetLanguage"]').hidden;})()`));
    await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});const t=c.querySelector('[data-plugin-field="translationEnabled"]');t.checked=true;t.dispatchEvent(new Event('change',{bubbles:true}));c.querySelector('[data-plugin-field="targetLanguage"]').value='日语';c.querySelector('[data-plugin-field="translationPrompt"]').value='使用礼貌自然的口语。';})()`);
    check('translation can be enabled independently without resetting speech language', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-field="speechLanguage"]').value==='ja' && ['targetLanguage','translationPrompt','translationTimeoutMs'].every(k=>!c.querySelector('[data-plugin-row="'+k+'"]').hidden);})()`));
    await saveTts();
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].responseFormat === 'wav');
    await waitUntil(() => cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="provider"]').value==='openai-compatible' && document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="responseFormat"]').value==='wav'`));
    const savedSpeech = JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'];
    check('custom WAV speech saves and reloads with server default voice and no key', savedSpeech.provider === 'openai-compatible' && savedSpeech.model === 'irodori-tts' && savedSpeech.apiVoice === '' && savedSpeech.apiKey === '' && await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="apiVoice"]').value===''`));
    check('speech translation options save and reload in the browser', savedSpeech.translationEnabled === true && savedSpeech.targetLanguage === '日语' && savedSpeech.translationPrompt === '使用礼貌自然的口语。' && await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="translationEnabled"]').checked && document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="targetLanguage"]').value==='日语'`));
    check('TTS settings controls have associated labels', await cdp.evaluate(`([...document.querySelectorAll('[data-plugin="reply-tts"] input,[data-plugin="reply-tts"] select,[data-plugin="reply-tts"] textarea')].every(e=>e.labels?.length>0))`));
    await cdp.evaluate(`(()=>{const t=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="translationEnabled"]');t.checked=false;t.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await saveTts();
    await waitUntil(async () => JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].translationEnabled === false);
    await waitUntil(() => cdp.evaluate(`!document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="translationEnabled"]').checked && document.querySelector('[data-plugin="reply-tts"] [data-plugin-row="translationPrompt"]').hidden`));
    check('turning translation off retains its saved preferences and the independent language', JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].translationPrompt === '使用礼貌自然的口语。' && await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="speechLanguage"]').value==='ja'`));
    for (const width of [375, 1440]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, mobile: width < 600, deviceScaleFactor: 1 });
      await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"]').scrollIntoView({block:'start',behavior:'instant'})`);
      check(`custom TTS ${width}px: API controls fit without overflow`, await cdp.evaluate(`(()=>{const c=document.querySelector('[data-plugin="reply-tts"]');return document.documentElement.scrollWidth<=innerWidth+1 && [...c.querySelectorAll('[data-plugin-field]')].filter(e=>!e.closest('[data-plugin-row]').hidden).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1;});})()`));
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = `tts-custom-wav-${width}.png`;
      await fs.writeFile(path.join(output, file), Buffer.from(screenshot.data, 'base64'));
      report.screenshots.push(file);
    }
    await cdp.evaluate(`(()=>{const p=document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="provider"]');p.value='edge';p.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check('switching back to Edge hides API format and voice fields', await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});return c.querySelector('[data-plugin-row="responseFormat"]').hidden && c.querySelector('[data-plugin-row="apiVoice"]').hidden && !c.querySelector('[data-plugin-row="voice"]').hidden;})()`));
    await cdp.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(ttsCard)});c.querySelector('[data-plugin-field="voice"]').value='ja-JP-KeitaNeural';const p=c.querySelector('[data-plugin-field="provider"]');p.value='openai-compatible';p.dispatchEvent(new Event('change',{bubbles:true}));p.value='edge';p.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    check('returning to Edge preserves a custom voice in the selected language', await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="voice"]').value==='ja-JP-KeitaNeural'`));
    await saveTts();
    check('custom Edge language and voice persist together after saving', JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins['reply-tts'].voice === 'ja-JP-KeitaNeural' && await cdp.evaluate(`document.querySelector('[data-plugin="reply-tts"] [data-plugin-field="voice"]').value==='ja-JP-KeitaNeural'`));
    await cdp.evaluate(`location.hash='#stickers'`);
    await waitUntil(() => cdp.evaluate(`document.getElementById('page-stickers').classList.contains('is-active')`));
    await click('#imagegenSettings summary');
    for (const width of [375, 768, 1440]) for (const theme of ['light', 'dark']) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1000, mobile: width < 600, deviceScaleFactor: 1 });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await cdp.evaluate('window.scrollTo({top:0,behavior:"instant"})');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const layout = await cdp.evaluate(`(()=>{const v=document.getElementById('imagegenView').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+1,fields:[...document.querySelectorAll('#imagegenPrompt,#imagegenMode,#imagegenPreset,#imagegenGenerate,#imagegenProvider,#imagegenBaseUrl,#imagegenModel,#imagegenApiKey')].map(e=>{const r=e.getBoundingClientRect();return {id:e.id,left:r.left,right:r.right,width:r.width,inside:r.left>=v.left-1&&r.right<=v.right+1};})};})()`);
      report.layouts.push({ width, theme, ...layout });
      check(`${width}px ${theme}: no overflow and controls fit`, !layout.overflow && layout.fields.every((field) => field.width > 0 && field.inside));
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = `imagegen-${width}-${theme}.png`;
      await fs.writeFile(path.join(output, file), Buffer.from(screenshot.data, 'base64'));
      report.screenshots.push(file);
    }
    report.vitals = { ...await cdp.evaluate('window.__imagegenQa'), inp: 'Not measured by this controlled smoke test' };
    check('no unhandled JavaScript exceptions', report.errors.length === 0);
    check('image generation network requests succeeded', report.networkErrors.length === 0);
    report.passed = true;
    report.verdict = 'SHIP; visual regression INCONCLUSIVE without an existing baseline';
    console.log(`Browser checks: ${report.checks.length}; layouts: ${report.layouts.length}; errors: ${report.errors.length}; ${output}`);
  } finally {
    if (!report.passed && cdp) {
      report.failureState = await cdp.evaluate(`({hint:document.getElementById('imagegenHint')?.textContent,disabled:document.getElementById('imagegenGenerate')?.disabled,invalid:[...document.querySelectorAll('#imagegenForm input,#imagegenForm textarea,#imagegenForm select')].filter(e=>!e.validity.valid).map(e=>({id:e.id,message:e.validationMessage})),jobs:document.getElementById('imagegenJobs')?.textContent})`).catch(() => null);
      report.posts = f.state.posts.length;
      report.jobStates = (await f.service.list()).map((job) => ({ status: job.status, error: job.error }));
      const image = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (image) await fs.writeFile(path.join(output, 'failure.png'), Buffer.from(image.data, 'base64'));
      console.error(JSON.stringify({ failureState: report.failureState, posts: report.posts, jobs: report.jobStates }));
    }
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.ws.close(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise((resolve) => browser.once('close', resolve));
      killProcessTree(browser);
      await closed;
    }
    await consoleFixture?.close();
    assert.ok(path.resolve(profile).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(profile).startsWith('qq-imagegen-browser-'));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    await f.close();
  }
});
