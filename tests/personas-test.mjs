/**
 * personas-test.mjs —— 多套人格系统（src/personas.js + PersonaLoader + 控制台人格库接口）。
 *
 * 分三部分：
 *   1) 纯模块：名字清洗、建/读/写/删、全局与按会话选择、解析顺序、坏状态自愈、导入；
 *   2) PersonaLoader：热切换（改 active.json 后不用重建实例）、按会话覆盖、DSH 自动加载跳过；
 *   3) 真实 HTTP：临时目录起一个控制台实例，打 /api/personas 全套端点。
 *
 * 全在临时目录里跑，结束删干净；不碰真实的 config.json 与人格库。
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function truthy(value, label, detail = '') {
  if (value) ok(label, detail);
  else bad(label, detail);
}

function section(title) {
  console.log(`\n[${title}]`);
}

/** 断言某次调用抛出指定 code 的错误 */
async function throwsCode(code, label, fn) {
  try {
    await fn();
    bad(label, `没有抛错（期望 ${code}）`);
  } catch (err) {
    if (err?.code === code) ok(label, err.message);
    else bad(label, `抛的是 ${err?.code ?? err?.message}，期望 ${code}`);
  }
}

/* ------------------------------------------------------- 1) 纯模块 */

async function moduleTests(tmpRoot) {
  const personas = await import('../src/personas.js');
  const {
    ACTIVE_FILE,
    PERSONA_BODY_MAX,
    activeFilePath,
    buildPersonaListText,
    createPersona,
    defaultPersonaTemplate,
    matchPersonaName,
    parsePersonaCommand,
    defaultNameFromFile,
    deletePersona,
    listPersonas,
    personaDir,
    personaFile,
    readPersona,
    readState,
    resolvePersonaFor,
    sanitizePersonaName,
    seedFromFile,
    setActivePersona,
    setChatPersona,
    writePersona,
    writeState,
  } = personas;

  const dir = path.join(tmpRoot, 'lib');

  section('1/4 名字清洗');
  eq(sanitizePersonaName('  大肥鱼  '), '大肥鱼', '去掉首尾空格');
  eq(sanitizePersonaName('客服  小助手'), '客服 小助手', '连续空白压成一个');
  await throwsCode('PERSONA_BAD_NAME', '空名字被拒', () => sanitizePersonaName('   '));
  await throwsCode('PERSONA_BAD_NAME', '带斜杠的名字被拒', () => sanitizePersonaName('a/b'));
  await throwsCode('PERSONA_BAD_NAME', '带冒号的名字被拒', () => sanitizePersonaName('a:b'));
  await throwsCode('PERSONA_BAD_NAME', '只有点的名字被拒', () => sanitizePersonaName('...'));
  await throwsCode('PERSONA_BAD_NAME', '超长名字被拒', () => sanitizePersonaName('字'.repeat(41)));

  section('1/4 /人格 指令解析');
  eq(parsePersonaCommand('今天吃什么'), null, '不是指令返回 null');
  eq(parsePersonaCommand('/人格'), { action: 'list', name: '' }, '/人格 单发是列清单');
  eq(parsePersonaCommand('  /人格  '), { action: 'list', name: '' }, '两边空白不影响');
  eq(parsePersonaCommand('/人格 大肥鱼'), { action: 'set-chat', name: '大肥鱼' }, '带名字是切本会话');
  eq(parsePersonaCommand('/人格 全局 大肥鱼'), { action: 'set-global', name: '大肥鱼' }, '全局前缀切所有会话');
  eq(parsePersonaCommand('/人格 全局 重置'), { action: 'reset-global', name: '' }, '全局重置');
  eq(parsePersonaCommand('/人格 重置'), { action: 'reset-chat', name: '' }, '本会话重置');
  eq(parsePersonaCommand('/人格 默认'), { action: 'reset-chat', name: '' }, '「默认」也算重置');
  eq(parsePersonaCommand('/人格 新建 客服小助手'), { action: 'create', name: '客服小助手' }, '新建指令');
  eq(parsePersonaCommand('/人格x'), null, '前缀相同但不是指令');

  const items = [{ name: '大肥鱼' }, { name: '客服小助手' }, { name: 'Kefu Pro' }];
  eq(matchPersonaName(items, '大肥鱼'), '大肥鱼', '名字精确匹配');
  eq(matchPersonaName(items, 'kefu pro'), 'Kefu Pro', '忽略大小写匹配');
  eq(matchPersonaName(items, '客服'), '客服小助手', '唯一前缀也能匹配');
  eq(matchPersonaName([{ name: '客服A' }, { name: '客服B' }], '客服'), '', '前缀不唯一时返回空（让用户写全）');
  eq(matchPersonaName(items, '不存在'), '', '找不到返回空');

  const listText = buildPersonaListText({
    items,
    state: { active: '大肥鱼', chats: { 'g:1': '客服小助手' } },
    chatKey: 'g:1',
    activeName: '大肥鱼',
  });
  truthy(listText.includes('当前人格：客服小助手（本会话指定）'), '清单第一行是本会话当前人格');
  truthy(listText.includes('← 本会话'), '会话指定的那套有标记');
  truthy(listText.includes('← 全局'), '全局那套有标记');
  truthy(listText.includes('可用人格（3）'), '报数量');
  const emptyText = buildPersonaListText({ items: [], state: { chats: {} }, chatKey: 'p:1', activeName: '' });
  truthy(emptyText.includes('人格库还是空的'), '空库提示怎么建');

  const tpl = defaultPersonaTemplate('测试人格');
  truthy(tpl.includes('你叫 测试人格'), '模板带上名字');
  truthy(tpl.includes('## 说话风格') && tpl.includes('## 人设'), '模板分说话风格与人设两段');

  section('1/4 目录与文件');
  eq(
    personaDir({ configRoot: tmpRoot, config: { persona: {} } }),
    path.join(tmpRoot, 'state', 'personas'),
    '默认目录是 state/personas',
  );
  eq(
    personaDir({ configRoot: tmpRoot, config: { persona: { dir: 'data/people' } } }),
    path.join(tmpRoot, 'data', 'people'),
    'config.persona.dir 可以改目录',
  );
  eq(activeFilePath(dir), path.join(dir, ACTIVE_FILE), 'active.json 路径');
  eq(personaFile(dir, '大肥鱼'), path.join(dir, '大肥鱼.md'), '每套人格是一个 .md');

  section('1/4 建 / 读 / 写 / 列');
  const emptyState = await readState(dir);
  eq(emptyState, { active: '', chats: {} }, '目录不存在时状态是空的');
  eq((await listPersonas(dir)).length, 0, '空库 list 返回 []');

  const created = await createPersona(dir, { name: '大肥鱼', body: '# 大肥鱼\n\n说话像个老朋友，爱吃鱼。' });
  eq(created.name, '大肥鱼', 'createPersona 返回名字');
  truthy(existsSync(personaFile(dir, '大肥鱼')), '文件真的落盘了');
  await throwsCode('PERSONA_EXISTS', '重名不让建', () => createPersona(dir, { name: '大肥鱼' }));

  const listed = await listPersonas(dir);
  eq(listed.length, 1, '列表里有一项');
  eq(listed[0].preview, '说话像个老朋友，爱吃鱼。', '预览跳过 # 标题取第一行正文');
  truthy(listed[0].size > 0, '带字节数');
  truthy(typeof listed[0].updatedAt === 'string', '带修改时间');

  const read = await readPersona(dir, '大肥鱼');
  truthy(read.body.includes('爱吃鱼'), 'readPersona 读回正文');
  await throwsCode('PERSONA_NOT_FOUND', '读不存在的会抛 NOT_FOUND', () => readPersona(dir, '没这套'));

  await writePersona(dir, '大肥鱼', '第二版内容');
  eq((await readPersona(dir, '大肥鱼')).body, '第二版内容', 'writePersona 覆盖');
  await throwsCode('PERSONA_BAD_BODY', '超过 2MB 的正文被拒', () =>
    writePersona(dir, '大肥鱼', 'x'.repeat(PERSONA_BODY_MAX + 1)),
  );
  await throwsCode('PERSONA_BAD_BODY', '非字符串正文被拒', () => writePersona(dir, '大肥鱼', 42));

  await createPersona(dir, { name: '客服小助手', body: '请用简体中文回答，别用感叹号。' });
  const sorted = (await listPersonas(dir)).map((item) => item.name);
  eq(sorted.length, 2, '两套人格');
  truthy(sorted.includes('客服小助手') && sorted.includes('大肥鱼'), '两种名字都在', sorted.join(' / '));

  section('1/4 选择与解析');
  const afterActive = await setActivePersona(dir, '大肥鱼');
  eq(afterActive.active, '大肥鱼', 'setActivePersona 写进状态');
  eq(JSON.parse(await readFile(activeFilePath(dir), 'utf8')).active, '大肥鱼', 'active.json 里的确是这个');
  await throwsCode('PERSONA_NOT_FOUND', '切到不存在的人格会抛 NOT_FOUND', () => setActivePersona(dir, '幽灵'));
  await throwsCode('PERSONA_BAD_NAME', '切到非法名字会抛 BAD_NAME', () => setActivePersona(dir, '../x'));

  const chatSet = await setChatPersona(dir, 'g:200000001', '客服小助手');
  eq(chatSet.chatKey, 'g:200000001', '会话键原样返回');
  eq(chatSet.name, '客服小助手', '会话人格名返回');
  await throwsCode('PERSONA_BAD_CHAT', '会话键格式不对被拒', () => setChatPersona(dir, '群707', '大肥鱼'));
  await throwsCode('PERSONA_NOT_FOUND', '会话指定不存在的人格被拒', () =>
    setChatPersona(dir, 'p:10001', '幽灵'),
  );

  const state = await readState(dir);
  eq(state.chats['g:200000001'], '客服小助手', '按会话覆盖记在 chats 里');

  const config = { persona: { path: 'AGENTS.md' } };
  const byChat = resolvePersonaFor({ configRoot: tmpRoot, config, dir, state, chatKey: 'g:200000001' });
  eq(byChat.source, 'chat', '会话覆盖优先（source=chat）');
  eq(byChat.name, '客服小助手', '用的是会话那套');
  const byGlobal = resolvePersonaFor({ configRoot: tmpRoot, config, dir, state, chatKey: 'g:1' });
  eq(byGlobal.source, 'global', '没覆盖的会话用全局（source=global）');
  eq(byGlobal.name, '大肥鱼', '全局是当前那套');

  const noState = await setActivePersona(dir, '');
  eq(noState.active, '', '传空串取消全局选择');
  const fallback = resolvePersonaFor({ configRoot: tmpRoot, config, dir, state: noState, chatKey: 'p:1' });
  eq(fallback.source, 'config', '都没有时回退到单文件（source=config）');
  eq(fallback.file, path.resolve(tmpRoot, 'AGENTS.md'), '回退到 config.persona.path');
  const configActive = resolvePersonaFor({
    configRoot: tmpRoot,
    config: { persona: { active: '客服小助手' } },
    dir,
    state: { active: '', chats: {} },
  });
  eq(configActive.name, '客服小助手', 'active.json 空时用 config.persona.active 兜底');

  section('1/4 删除与引用清理');
  await setActivePersona(dir, '客服小助手');
  await setChatPersona(dir, 'g:200000001', '客服小助手');
  const removed = await deletePersona(dir, '客服小助手');
  eq(removed.name, '客服小助手', '删掉返回名字');
  eq(removed.wasActive, true, '它当时是全局当前');
  eq(removed.clearedChats, ['g:200000001'], '顺带清掉会话引用');
  truthy(!existsSync(personaFile(dir, '客服小助手')), '文件没了');
  const afterDelete = await readState(dir);
  eq(afterDelete.active, '', '全局选择被清空');
  eq(Object.keys(afterDelete.chats).length, 0, '会话覆盖被清空');
  await throwsCode('PERSONA_NOT_FOUND', '删不存在的会抛 NOT_FOUND', () => deletePersona(dir, '幽灵'));
  eq((await listPersonas(dir)).map((item) => item.name), ['大肥鱼'], '只剩一套');

  section('1/4 坏状态自愈与导入');
  await writeFile(activeFilePath(dir), '{ 这不是 JSON', 'utf8');
  const healed = await readState(dir);
  eq(healed, { active: '', chats: {} }, '坏 active.json 当空状态');
  const badFiles = (await readdir(dir)).filter((name) => name.includes('.bad-'));
  truthy(badFiles.length > 0, '坏文件改名留档', badFiles.join(','));

  const seedDir = path.join(tmpRoot, 'seeded');
  const sourceFile = path.join(tmpRoot, 'AGENTS.md');
  await writeFile(sourceFile, '# 老人格\n\n以前用的是单文件。', 'utf8');
  eq(defaultNameFromFile(sourceFile), 'AGENTS', '导入时默认用人格文件名');
  const seeded = await seedFromFile({ dir: seedDir, fromFile: sourceFile, name: '默认人格' });
  eq(seeded.created, true, '首次导入会建一套');
  eq((await readPersona(seedDir, '默认人格')).body, '# 老人格\n\n以前用的是单文件。', '正文原样复制过来');
  eq((await readState(seedDir)).active, '默认人格', '导入后自动设为当前');
  const again = await seedFromFile({ dir: seedDir, fromFile: sourceFile, name: '再导入一次' });
  eq(again.created, false, '库非空时再导入什么都不做');
  eq(again.name, '默认人格', '返回已有的那套');
  eq((await listPersonas(seedDir)).length, 1, '没有多出人格');

  // 写状态本身也是原子的：tmp 文件不残留
  await writeState(dir, { active: '大肥鱼', chats: { 'g:1': '大肥鱼' } });
  eq((await readdir(dir)).filter((name) => name.includes('.tmp-')).length, 0, '原子写没有留下 .tmp 文件');

  return { dir, config, sourceFile };
}

/* --------------------------------------------- 2) PersonaLoader 热切换 */

async function loaderTests(tmpRoot) {
  const { PersonaLoader } = await import('../src/persona.js');
  const { createPersona, setActivePersona, setChatPersona } = await import('../src/personas.js');

  const dir = path.join(tmpRoot, 'loader-lib');
  const ws = path.join(tmpRoot, 'ws');
  await mkdir(ws, { recursive: true });
  await createPersona(dir, { name: '甲', body: '我是甲人格。' });
  await createPersona(dir, { name: '乙', body: '我是乙人格。' });
  await setActivePersona(dir, '甲');

  const config = { persona: { enabled: true, dir: 'loader-lib', path: 'AGENTS.md', maxChars: 8000 } };
  const loader = new PersonaLoader({ configRoot: tmpRoot, config, dshCwd: ws });

  section('2/4 人格加载器');
  const first = await loader.load();
  eq(first.name, '甲', '默认读全局当前那套');
  eq(first.source, 'global', '来源是 global');
  truthy(first.text.startsWith('[人格设定]'), 'prompt 片段带 [人格设定] 前缀');
  truthy(first.text.includes('我是甲人格。'), '正文拼进 prompt');
  eq(await loader.loadBlock(), first.text, 'loadBlock 与 load().text 一致');

  await setActivePersona(dir, '乙');
  const second = await loader.load();
  eq(second.name, '乙', 'active.json 改了以后同一个实例立刻换（不用重启）');
  truthy(second.text.includes('我是乙人格。'), '拿到的是新内容');

  await setChatPersona(dir, 'p:10001', '甲');
  const chat = await loader.load({ chatKey: 'p:10001' });
  eq(chat.source, 'chat', '会话覆盖在这个会话里生效');
  eq(chat.name, '甲', '群/私聊可以单独指定');

  const other = await loader.load({ chatKey: 'p:10002' });
  eq(other.name, '乙', '别的会话还是全局那套');

  await setChatPersona(dir, 'p:10001', '');
  eq((await loader.load({ chatKey: 'p:10001' })).source, 'global', '清掉会话覆盖后回到全局');

  section('2/4 边界情况');
  const autoLoader = new PersonaLoader({
    configRoot: tmpRoot,
    config: { persona: { enabled: true, dir: '空人格库', path: 'ws/AGENTS.md' } },
    dshCwd: ws,
  });
  const auto = await autoLoader.load();
  eq(auto.skipped, 'dsh-auto', '正好是 DSH 自己会读的 AGENTS.md 时不重复注入');

  const offLoader = new PersonaLoader({
    configRoot: tmpRoot,
    config: { persona: { enabled: false, dir: 'loader-lib', path: 'AGENTS.md' } },
    dshCwd: ws,
  });
  eq((await offLoader.load()).skipped, 'disabled', 'enabled:false 时直接跳过');

  const ghostLoader = new PersonaLoader({
    configRoot: tmpRoot,
    config: { persona: { enabled: true, dir: 'ghost-lib', path: 'ghost/AGENTS.md' } },
    dshCwd: ws,
  });
  const ghost = await ghostLoader.load();
  eq(ghost.missing, true, '人格文件不存在时标记 missing');
  eq(ghost.text, '', '读不到就给空串，不影响回话');
}

/* ------------------------------------------------------------ 3) HTTP */

async function httpTests(tmpRoot) {
  const { createWebUiServer } = await import('../src/webui/server.mjs');
  const { DEFAULTS } = await import('../src/config.js');
  const { freePort, useIsolatedEnv } = await import('./helpers/isolated-fixtures.mjs');

  const stateDir = path.join(tmpRoot, 'http-state');
  const logDir = path.join(tmpRoot, 'http-logs');
  const libDir = path.join(tmpRoot, 'http-personas');
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const config = structuredClone(DEFAULTS);
  const tempConfig = {
    ...config,
    stateDir,
    logDir,
    persona: { ...config.persona, enabled: true, dir: libDir, path: path.join(tmpRoot, 'AGENTS.md') },
  };
  await writeFile(path.join(tmpRoot, 'config.json'), `${JSON.stringify(tempConfig, null, 2)}\n`, 'utf8');

  const restoreEnv = useIsolatedEnv(tmpRoot, { QQ_CONFIG: path.join(tmpRoot, 'config.json') });
  const instance = createWebUiServer({
    config: tempConfig, configRoot: tmpRoot, port: await freePort(),
    updateManager: { async start() {}, stop() {} },
  });
  const { port } = await instance.start();
  if (port <= 0) {
    bad('控制台没起来');
    return;
  }
  ok('控制台已启动（临时目录）', `127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  const call = async (p, options = {}) => {
    const res = await fetch(base + p, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body };
  };
  const put = (p, payload) =>
    call(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const post = (p, payload) =>
    call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  try {
    section('3/3 HTTP 空库与新建');
    const empty = await call('/api/personas');
    eq(empty.status, 200, 'GET /api/personas 通了');
    eq(empty.body?.data?.mode, 'single', '没建过人格时是单文件模式');
    eq(empty.body?.data?.items?.length, 0, '空库 items=[]');
    eq(empty.body?.data?.dir, libDir, '返回人格库目录');

    const made = await post('/api/personas', { name: '客服小助手' });
    eq(made.status, 200, 'POST 新建成功');
    eq(made.body?.data?.name, '客服小助手', '返回名字');
    truthy(made.body?.data?.file?.endsWith('客服小助手.md'), '返回文件路径');

    const dup = await post('/api/personas', { name: '客服小助手' });
    eq(dup.status, 409, '重名返回 409');
    const badName = await post('/api/personas', { name: 'a/b' });
    eq(badName.status, 400, '非法名字返回 400');

    const listed = await call('/api/personas');
    eq(listed.body?.data?.mode, 'library', '有成员后切成库模式');
    eq(listed.body?.data?.items?.length, 1, '列出 1 套');

    section('3/3 HTTP 选择与编辑');
    const activated = await put('/api/personas/active', { name: '客服小助手' });
    eq(activated.status, 200, 'PUT active 成功');
    eq(activated.body?.data?.active, '客服小助手', '状态记下了当前人格');
    eq((await put('/api/personas/active', { name: '幽灵' })).status, 404, '切不存在的人格返回 404');

    const chat = await put('/api/personas/chat', { chatKey: 'g:200000001', name: '客服小助手' });
    eq(chat.status, 200, 'PUT chat 成功');
    eq(chat.body?.data?.chatKey, 'g:200000001', '会话键回显');
    eq((await put('/api/personas/chat', { chatKey: '群707', name: '客服小助手' })).status, 400, '坏会话键返回 400');

    const snap = await call('/api/personas');
    eq(snap.body?.data?.chats?.['g:200000001'], '客服小助手', '快照里能看到会话覆盖');
    eq(snap.body?.data?.resolution?.source, 'global', '全局解析结果跟在快照里');

    const one = await call('/api/persona?name=客服小助手');
    eq(one.status, 200, 'GET /api/persona?name= 通');
    eq(one.body?.data?.mode, 'library', '返回库模式');
    eq(one.body?.data?.name, '客服小助手', '返回的是这套');
    eq((await call('/api/persona?name=幽灵')).status, 404, '取不存在的人格返回 404');

    const firstSave = await put('/api/persona', { name: '客服小助手', body: '# 客服\n\n回答简短一点。' });
    eq(firstSave.status, 200, 'PUT /api/persona 保存成功');
    truthy(firstSave.body?.data?.bytes > 0, '返回字节数');
    eq(firstSave.body?.data?.backup, null, '第一次保存（原来内容为空）没有备份可做');

    const saved = await put('/api/persona', { name: '客服小助手', body: '# 客服\n\n回答再短一点。' });
    eq(saved.status, 200, '再存一次也成功');
    truthy(saved.body?.data?.backup, '第二次保存返回旧版本备份路径', String(saved.body?.data?.backup));
    const backupAbs = path.join(tmpRoot, String(saved.body?.data?.backup).replace(/\//g, path.sep));
    truthy(existsSync(backupAbs), '备份文件真的存在');
    eq((await readFile(backupAbs, 'utf8')), '# 客服\n\n回答简短一点。', '备份里是上一版内容');
    eq((await call('/api/persona?name=客服小助手')).body?.data?.body, '# 客服\n\n回答再短一点。', '再读是新内容');

    // 不传 name 时写「当前生效的那套」；取消当前选择后才落到单文件（旧模式的兼容路径）
    eq((await put('/api/personas/active', { name: '' })).status, 200, '取消全局选择');
    const singleBody = await put('/api/persona', { body: '单文件人格内容' });
    eq(singleBody.status, 200, '没有当前人格时不传 name 写单文件');
    eq((await readFile(path.join(tmpRoot, 'AGENTS.md'), 'utf8')), '单文件人格内容', '单文件内容落盘');
    await put('/api/personas/active', { name: '客服小助手' });

    section('3/3 HTTP 导入、删除与兜底');
    const seeded = await post('/api/personas/seed', {});
    eq(seeded.status, 200, 'POST seed 通');
    eq(seeded.body?.data?.created, false, '库非空时导入什么都不做');

    const removed = await call('/api/personas?name=客服小助手', { method: 'DELETE' });
    eq(removed.status, 200, 'DELETE 成功');
    eq(removed.body?.data?.wasActive, true, '删掉的正是当前人格');
    eq(removed.body?.data?.clearedChats, ['g:200000001'], '会话覆盖也被清掉');
    const afterRemove = await call('/api/personas');
    eq(afterRemove.body?.data?.items?.length, 0, '删完库空了');
    eq(afterRemove.body?.data?.mode, 'single', '库空了回到单文件模式');
    eq(afterRemove.body?.data?.active, '', '当前人格清空');
    eq((await call('/api/personas?name=客服小助手', { method: 'DELETE' })).status, 404, '删不存在的人格返回 404');
    eq((await call('/api/personas/bogus')).status, 404, '未知子路径返回 404');
  } finally {
    await instance.stop();
    restoreEnv();
  }
}

/* ------------------------------------------------------------ 主流程 */

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-personas-'));

try {
  console.log('多套人格系统测试');
  console.log(`临时目录：${tmpRoot}`);
  await moduleTests(tmpRoot);
  await loaderTests(tmpRoot);
  await httpTests(tmpRoot);
} catch (err) {
  bad('测试主流程抛错', err?.stack ?? String(err));
} finally {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
