/**
 * webui-test.mjs —— 控制台（src/webui/server.mjs）的接口与安全测试。
 *
 * 分两部分：
 *   1) 纯函数单测（redactSecrets / resolveNotePath）—— 直接 import，不起服务；
 *   2) 真实 HTTP 集成 —— 用临时 stateDir 起一个控制台实例，打全部端点。
 *
 * 不碰真实数据：只写临时目录，人格/记忆只读。
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsoleFixture } from './helpers/isolated-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;

function ok(label, detail = '') {
  passed += 1;
  console.log(`  ✔ ${label}${detail ? `  — ${detail}` : ''}`);
}

function bad(label, detail = '') {
  failed += 1;
  console.log(`  ✘ ${label}${detail ? `  — ${detail}` : ''}`);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label, String(actual));
  else bad(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

/* ------------------------------------------------------------------ 单测 */

async function unitTests() {
  const mod = await import('../src/webui/server.mjs');
  const { redactSecrets, resolveNotePath, normalizeNapcatWebUi, withWebuiToken, maskTokenUrl } = mod;

  section('1/4 脱敏 redactSecrets');
  // token / access_token / password 三种常见形态都要被吃掉
  const cases = [
    ['token=change-me', 'token 等号'],
    ['"accessToken":"secret-value-123"', 'JSON accessToken'],
    ['Authorization: Bearer abcdefg123456', 'Bearer'],
    ['password: hunter2hunter2', 'password'],
  ];
  for (const [input, label] of cases) {
    const output = String(redactSecrets(input));
    if (/\*{3}|redacted|hidden/i.test(output)) ok(`脱敏生效：${label}`);
    else bad(`脱敏失效：${label}`, output.slice(0, 80));
  }
  // 普通文本不能被误伤
  const plain = '今天群里聊了红烧肉和白米饭';
  eq(redactSecrets(plain), plain, '普通中文文本不被脱敏');
  // JSON 结构不能被吃坏：引号必须还在
  const jsonish = String(redactSecrets('{"accessToken":"secret-value-123","name":"x"}'));
  if (jsonish.includes('"name"') && jsonish.includes('"accessToken"')) ok('脱敏不吃坏 JSON 结构', jsonish.slice(0, 60));
  else bad('脱敏把 JSON 结构吃坏了', jsonish.slice(0, 80));

  section('2/5 NapCat WebUI 地址归一化');
  eq(normalizeNapcatWebUi(''), 'http://127.0.0.1:6099/webui/', '空值回退默认地址');
  eq(normalizeNapcatWebUi('http://127.0.0.1:6099'), 'http://127.0.0.1:6099/webui/', '只有端口时补 /webui/');
  eq(normalizeNapcatWebUi('http://127.0.0.1:6099/webui'), 'http://127.0.0.1:6099/webui/', '缺尾斜杠时补齐');
  eq(normalizeNapcatWebUi('file:///c:/windows'), 'http://127.0.0.1:6099/webui/', '非 http(s) 协议回退默认');
  eq(normalizeNapcatWebUi('127.0.0.1:6099'), 'http://127.0.0.1:6099/webui/', '非法 URL 回退默认');

  section('2b/5 WebUI token 拼接与打码');
  // NapCat 前端在未登录时会读 ?token= 并跳到 /web_login?token=…，所以拼上就能自动登录
  eq(
    withWebuiToken('http://127.0.0.1:6099', 'abc123'),
    'http://127.0.0.1:6099/webui/?token=abc123',
    '裸端口地址会先归一化再拼 token',
  );
  eq(
    withWebuiToken('http://127.0.0.1:6099/webui/', 'a b&c'),
    'http://127.0.0.1:6099/webui/?token=a%20b%26c',
    'token 会被 URL 编码',
  );
  eq(withWebuiToken('http://127.0.0.1:6099/webui/', ''), 'http://127.0.0.1:6099/webui/', '没有 token 时地址不变');
  eq(
    withWebuiToken('http://127.0.0.1:6099/webui/?x=1', 't0k'),
    'http://127.0.0.1:6099/webui/?x=1&token=t0k',
    '地址已有其它参数时用 & 接',
  );
  eq(
    maskTokenUrl('http://127.0.0.1:6099/webui/?token=secret-value&a=1'),
    'http://127.0.0.1:6099/webui/?token=***&a=1',
    '回传地址里 token 被打码',
  );
  eq(maskTokenUrl('http://127.0.0.1:6099/webui/'), 'http://127.0.0.1:6099/webui/', '没有 token 时打码不动地址');
  if (!maskTokenUrl('http://x/?token=abc').includes('abc')) ok('打码后原始 token 不出现');
  else bad('打码失效');

  section('3/5 路径穿越防护 resolveNotePath');
  const root = path.join(PROJECT_ROOT, 'state');
  const good = resolveNotePath(root, 'sub/note.md');
  if (good.ok && good.abs.startsWith(root)) ok('正常相对路径放行', good.rel ?? '');
  else bad('正常相对路径被拒', JSON.stringify(good));

  for (const evil of ['../../../Windows/win.ini', '..\\..\\secret.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/../../b.md']) {
    const got = resolveNotePath(root, evil);
    if (!got.ok) ok(`穿越被拒：${evil}`);
    else bad(`穿越没被拒：${evil}`, got.abs);
  }
  const empty = resolveNotePath(root, '');
  if (!empty.ok) ok('空路径被拒');
  else bad('空路径没被拒', JSON.stringify(empty));
}

/* ------------------------------------------------------------------ 集成 */

async function httpTests(tmpRoot) {
  const fixture = await createConsoleFixture(tmpRoot);
  const { port } = fixture;
  if (port > 0) ok('控制台已启动', `127.0.0.1:${port}`);
  else {
    bad('控制台没起来');
    return;
  }

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body, res };
  };

  try {
    section('4/5 读接口');
    const overview = await get('/api/overview');
    if (overview.body?.ok === true && overview.body.data?.ports?.onebot) ok('概览返回正常');
    else bad('概览返回异常', JSON.stringify(overview.body).slice(0, 160));

    const stats = await get('/api/memory/stats');
    if (stats.body?.ok === true || stats.body?.ok === false) ok('记忆统计有响应', `ok=${stats.body?.ok}`);
    else bad('记忆统计无响应');

    const persona = await get('/api/persona');
    if (persona.body?.ok === true && typeof persona.body.data?.body === 'string') ok('人格可读', `${persona.body.data.body.length} 字符`);
    else bad('人格读取失败');

    const sessions = await get('/api/sessions');
    if (sessions.body?.ok === true && Array.isArray(sessions.body.data?.items)) ok('会话列表可读', `${sessions.body.data.items.length} 条`);
    else bad('会话列表读取失败');

    const settings = await get('/api/settings');
    if (settings.body?.ok === true && settings.body.data?.editable) ok('设置可读且带字段描述');
    else bad('设置读取失败');

    // 黑白名单：字段存在 + policy 类型校验 + 临时配置回写。
    const sec = settings.body?.data?.security ?? {};
    if (Array.isArray(sec.denyFrom) || sec.denyFrom === null) ok('设置里有 denyFrom 字段');
    else bad('设置里缺 denyFrom', JSON.stringify(sec.denyFrom));
    if (Array.isArray(sec.denyGroupIds) || sec.denyGroupIds === null) ok('设置里有 denyGroupIds 字段');
    else bad('设置里缺 denyGroupIds', JSON.stringify(sec.denyGroupIds));
    eq(settings.body?.data?.editable?.security?.privatePolicy, 'policy', 'privatePolicy 用 policy 类型校验');
    eq(settings.body?.data?.editable?.security?.denyFrom, 'intArray', 'denyFrom 用 intArray 类型');

    const putSettings = async (payload) => {
      const res = await fetch(base + '/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    };

    const badPolicy = await putSettings({ security: { privatePolicy: 'whatever' } });
    eq(badPolicy.status, 400, '非法 privatePolicy 被拒（不落盘）');

    const roundTrip = await putSettings({ security: { allowFrom: sec.allowFrom ?? [] } });
    if (roundTrip.body?.ok === true && 'security.allowFrom' in (roundTrip.body.data?.applied ?? {})) {
      ok('名单数组能原样回写', JSON.stringify(sec.allowFrom ?? []));
    } else {
      bad('名单数组回写失败', JSON.stringify(roundTrip.body).slice(0, 160));
    }

    const jevToken = 'synthetic-jev-secret-that-must-never-return';
    const jevSave = await putSettings({ jev: {
      baseUrl: 'https://jev.example/v1', model: 'jev-fixture', token: jevToken,
      timeoutMs: 4000, contextMessages: 8,
    } });
    if (jevSave.status === 200 && !JSON.stringify(jevSave.body).includes(jevToken)) ok('JEV 配置保存成功且 Token 不回传');
    else bad('JEV Token 保存或回传脱敏异常', JSON.stringify(jevSave.body).slice(0, 240));
    const savedJevConfig = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    eq(savedJevConfig.jev.token, jevToken, 'JEV Token 已写入隔离配置');
    const jevRead = await get('/api/settings');
    eq(jevRead.body?.data?.jev?.hasToken, true, 'JEV 设置只回传 Token 是否存在');
    eq(Object.hasOwn(jevRead.body?.data?.jev ?? {}, 'token'), false, 'JEV 设置响应完全不包含 Token 字段');
    eq(jevRead.body?.data?.jev?.model, 'jev-fixture', 'JEV 模型设置可读取');
    const rotatedToken = 'synthetic-jev-rotated-secret-that-must-never-return';
    const tokenOnlySave = await putSettings({ jev: { token: rotatedToken } });
    eq(tokenOnlySave.status, 200, 'JEV 只更新 Token 也能成功保存');
    eq(JSON.parse(await readFile(fixture.configPath, 'utf8')).jev.token, rotatedToken, '单字段 Token 更新已落盘');
    eq(JSON.stringify(tokenOnlySave.body).includes(rotatedToken), false, '单字段 Token 更新不回传凭据');
    eq(Object.hasOwn(tokenOnlySave.body?.data?.applied ?? {}, 'jev.token'), false, '更新字段回执不包含 Token 值');
    const blankTokenSave = await putSettings({ jev: { token: '   ', model: 'jev-fixture' } });
    eq(blankTokenSave.status, 200, 'Token 留空时其他设置仍可保存');
    eq(JSON.parse(await readFile(fixture.configPath, 'utf8')).jev.token, rotatedToken, '空白 Token 保留已保存的凭据');
    const invalidJev = await putSettings({ jev: { baseUrl: 'https://user:pass@jev.example/v1' } });
    eq(invalidJev.status, 400, '含内嵌凭据的 JEV Base URL 被拒绝');
    const invalidJevContext = await putSettings({ jev: { contextMessages: 101 } });
    eq(invalidJevContext.status, 400, '超范围的 JEV 上下文条数被拒绝');

    const logs = await get('/api/logs?name=bridge&lines=5');
    if (logs.body?.ok === true && Array.isArray(logs.body.data?.lines)) ok('日志可读', `${logs.body.data.lines.length} 行`);
    else bad('日志读取失败');

    const model = await get('/api/model');
    if (model.body?.ok === true && Array.isArray(model.body.data?.providers)) {
      ok('模型快照可读', `${model.body.data.providers.length} 个供应商，mode=${model.body.data.mode}`);
    } else {
      bad('模型快照读取失败', JSON.stringify(model.body).slice(0, 160));
    }
    if (model.body?.data?.efforts?.length > 0) ok('模型快照带思考强度选项');
    else bad('模型快照缺 efforts');

    section('5/5 错误处理与安全');
    const badLog = await get('/api/logs?name=/etc/passwd');
    eq(badLog.status, 400, '非法日志名被拒');

    const noQuery = await get('/api/memory/search');
    eq(noQuery.status, 400, '记忆检索缺少 q 被拒');

    const traversal = await get('/api/memory/note?path=' + encodeURIComponent('../../config.json'));
    if (traversal.status === 403 || traversal.status === 400) ok('笔记接口拒绝穿越', `HTTP ${traversal.status}`);
    else bad('笔记接口没拦穿越', `HTTP ${traversal.status} ${JSON.stringify(traversal.body).slice(0, 100)}`);

    const unknown = await get('/api/definitely-not-here');
    eq(unknown.status, 404, '未知接口返回 404');

    const wrongMethod = await fetch(base + '/api/persona', { method: 'DELETE' });
    eq(wrongMethod.status, 405, '错误方法返回 405');

    // 人格接口不能接受空 body 之外的脏数据
    const badPersona = await fetch(base + '/api/persona', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 12345 }),
    });
    eq(badPersona.status, 400, '人格非字符串被拒');

    // 模型接口：非法 mode / 缺字段 / 正常切换
    const putJson = (p, payload, method = 'PUT') =>
      fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const badMode = await putJson('/api/model', { mode: 'whatever' });
    eq(badMode.status, 400, '非法 model mode 被拒');

    const badManual = await putJson('/api/model', { mode: 'manual', manual: { provider: '', model: 'x' } });
    eq(badManual.status, 400, '手动模式缺供应商被拒');

    const setManual = await putJson('/api/model', {
      mode: 'manual',
      manual: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' },
    });
    const manualBody = setManual.status === 200 ? await setManual.json() : null;
    if (manualBody?.data?.mode === 'manual' && manualBody.data.effective?.provider === 'test-provider') {
      ok('能切到手动模型并回显生效值');
    } else {
      bad('手动模式切换失败', `HTTP ${setManual.status} ${JSON.stringify(manualBody).slice(0, 160)}`);
    }

    const setFollow = await putJson('/api/model', { mode: 'follow' });
    const followBody = setFollow.status === 200 ? await setFollow.json() : null;
    if (followBody?.data?.mode === 'follow') ok('能切回跟随模式');
    else bad('切回跟随失败', `HTTP ${setFollow.status}`);

    // 开机自启 + 打开本地资源：只验只读形状与参数校验，绝不在这里真去改用户的快捷方式
    const auto = await fetch(base + '/api/autostart');
    const autoBody = auto.status === 200 ? await auto.json() : null;
    if (autoBody?.ok && typeof autoBody.data?.enabled === 'boolean' && typeof autoBody.data.shortcutPath === 'string') {
      ok('开机自启状态可读', `enabled=${autoBody.data.enabled}`);
    } else {
      bad('开机自启状态读取失败', `HTTP ${auto.status} ${JSON.stringify(autoBody).slice(0, 160)}`);
    }

    const badAuto = await putJson('/api/autostart', { enabled: 'yes' });
    eq(badAuto.status, 400, '非法 autostart 参数被拒');

    const overviewWebui = await fetch(base + '/api/overview');
    const overviewWebuiBody = await overviewWebui.json();
    const webuiUrl = overviewWebuiBody?.data?.ports?.napcatWebui;
    if (/^https?:\/\/127\.0\.0\.1:\d+\/webui\/$/.test(String(webuiUrl))) ok('概览里的 NapCat WebUI 是完整地址', webuiUrl);
    else bad('NapCat WebUI 地址不是完整 URL', String(webuiUrl));

    // token 只在服务端用于拼启动地址，概览里只给「有没有拿到」的布尔值
    const tokenReady = overviewWebuiBody?.data?.ports?.napcatWebuiToken;
    if (typeof tokenReady === 'boolean') ok('概览给出 token 是否就绪', String(tokenReady));
    else bad('概览缺少 napcatWebuiToken 布尔值', String(tokenReady));
    if (!String(webuiUrl).includes('token=')) ok('概览地址里没有 token');
    else bad('概览地址里泄露了 token');

    const badOpen = await putJson('/api/open', { target: 'nope' }, 'POST');
    eq(badOpen.status, 400, '非法 open target 被拒');

    // 静态资源
    const index = await fetch(base + '/');
    const html = await index.text();
    if (index.status === 200 && html.includes('大肥鱼控制台')) ok('首页静态资源可访问');
    else bad('首页访问异常', `HTTP ${index.status}`);

    const css = await fetch(base + '/app.css');
    const cssText = await css.text();
    if (css.status === 200 && cssText.includes('.nav-bar')) ok('样式表可访问');
    else bad('样式表异常', `HTTP ${css.status}`);

    const js = await fetch(base + '/app.js');
    const jsText = await js.text();
    if (js.status === 200 && jsText.includes('/api/overview')) ok('前端脚本可访问');
    else bad('前端脚本异常', `HTTP ${js.status}`);

    const traversalStatic = await fetch(base + '/..%2f..%2fconfig.json');
    if (traversalStatic.status === 404 || traversalStatic.status === 403) ok('静态资源拒绝穿越', `HTTP ${traversalStatic.status}`);
    else bad('静态资源穿越没被拦', `HTTP ${traversalStatic.status}`);

    // 日志脱敏：整份响应里不该出现配置中的明文 token
    const rawCfg = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    const token = String(rawCfg?.onebot?.accessToken ?? '');
    if (token.length > 6) {
      const overviewRaw = await (await fetch(base + '/api/overview')).text();
      if (!overviewRaw.includes(token)) ok('响应里没有明文 accessToken');
      else bad('响应泄露 accessToken');
    } else {
      bad('fixture 必须包含合成 token 才能验证脱敏');
    }

    // 自定义路径：人格 / 记忆库 / 工作区
    const pathsRes = await get('/api/paths');
    eq(pathsRes.status, 200, 'GET /api/paths 可用');
    const pathsData = pathsRes.body?.data ?? {};
    if (String(pathsData.persona?.resolved ?? '').endsWith('AGENTS.md')) ok('人格路径解析成 AGENTS.md', pathsData.persona.resolved);
    else bad('人格路径解析异常', JSON.stringify(pathsData.persona));
    if (typeof pathsData.memory?.resolved === 'string' && pathsData.memory.resolved.length > 0) ok('记忆库路径可读', pathsData.memory.resolved);
    else bad('记忆库路径缺失');
    if (typeof pathsData.workspace?.resolved === 'string' && pathsData.workspace.resolved.length > 0) ok('工作区路径可读', pathsData.workspace.resolved);
    else bad('工作区路径缺失');

    const checkRes = await fetch(base + '/api/paths/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '~' }),
    });
    eq(checkRes.status, 200, 'POST /api/paths/check 可用');
    const checkData = await checkRes.json();
    if (checkData?.data?.resolved && checkData.data.exists) ok('~ 解析成真实存在的目录', checkData.data.resolved);
    else bad('~ 解析失败', JSON.stringify(checkData).slice(0, 120));

    const emptyPath = await putJson('/api/settings', { memory: { root: '   ' } });
    eq(emptyPath.status, 400, '空路径被拒绝');

    const savedPaths = await putJson('/api/settings', {
      persona: { path: 'persona/custom.md' },
      memory: { root: 'memory-custom' },
      dsh: { cwd: 'workspace-custom' },
    });
    eq(savedPaths.status, 200, '三条自定义路径可保存');
    const savedJson = await savedPaths.json();
    const savedSettings = savedJson?.data?.settings ?? {};
    eq(savedSettings.persona?.path, 'persona/custom.md', '人格路径原样回写');
    eq(savedSettings.memory?.root, 'memory-custom', '记忆库路径回写');
    eq(savedSettings.dsh?.cwd, 'workspace-custom', '工作区路径回写');

    const pathsAgain = await get('/api/paths');
    const againData = pathsAgain.body?.data ?? {};
    if (String(againData.workspace?.resolved ?? '').endsWith('workspace-custom')) ok('工作区解析到保存的目录');
    else bad('工作区解析不对', JSON.stringify(againData.workspace));

    const putCustomPersona = await putJson('/api/persona', { body: '# 自定义人格\n说话短一点。' });
    eq(putCustomPersona.status, 200, '人格页写入自定义路径');
    const customPersonaJson = await putCustomPersona.json();
    if (String(customPersonaJson?.data?.path ?? '').includes('custom.md')) ok('人格文件用的是配置里那个');
    else bad('人格文件还是写死的路径', customPersonaJson?.data?.path);
    const customPersona = await get('/api/persona');
    if (String(customPersona.body?.data?.body ?? '').includes('说话短一点')) ok('人格页读回自定义内容');
    else bad('人格读回失败');
    const diskConfig = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    eq(diskConfig.persona.path, 'persona/custom.md', '路径变更只落盘到临时配置');
    const customText = await readFile(path.join(tmpRoot, 'persona', 'custom.md'), 'utf8');
    if (customText.includes('说话短一点')) ok('人格写入临时目录');
    else bad('临时人格文件内容不符');
  } finally {
    await fixture.close();
    const still = path.join(tmpRoot, 'state', 'webui-port.txt');
    if (!existsSync(still)) ok('停止后端口文件已清理');
    else bad('停止后端口文件残留', still);
  }
}

async function main() {
  console.log('控制台接口测试');
  console.log('='.repeat(60));

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-webui-test-'));
  try {
    await unitTests();
    await httpTests(tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
