// 群聊闭环测试：用假 NapCat 驱动真实的 src/index.js，验证
//   1. 群里**没** @ 机器人的发言 → 不回复，但要进群记忆
//   2. @ 了机器人但在别的群 → 不回复、不记录
//   3. 白名单成员在允许的群里 @ 机器人 → 回复，并且喂给 DSH 的 prompt 里带着上文
//   4. 记忆落盘在 state/groupmem/<群号>.jsonl，格式正确
//
// 用法：node tests/e2e-group.mjs
//       固定真实 DSH + 本机合成模型，不读取真实账号、模型补丁或工作区。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFakeNapCat } from './ws-harness.mjs';
import { createLocalDshFixture } from './helpers/isolated-fixtures.mjs';
import { killProcessTree } from '../src/dsh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const BOT = 10000;
const OWNER = 1000000002;
const OTHER_MEMBER = 555666777;
const TARGET_GROUP = 200000001;
const WRONG_GROUP = 888999000;

let passed = 0;
let failed = 0;
const ok = (n, d = '') => {
  passed += 1;
  console.log(`  ✔ ${n}${d ? `  — ${d}` : ''}`);
};
const bad = (n, d = '') => {
  failed += 1;
  console.log(`  ✘ ${n}${d ? `  — ${d}` : ''}`);
};
const section = (t) => console.log(`\n[${t}]`);
const MODEL_REPLY = '晚饭吃面，来自隔离群聊模型。';
const requestText = (body) => JSON.stringify(body.messages ?? []);
const isClassification = (body) => requestText(body).includes('should_reply') && requestText(body).includes('current_message');
const isSessionTitle = (body) => requestText(body).includes('Generate the session title from this JSON array of human messages:');
const messageText = (message) => typeof message === 'string' ? message
  : (Array.isArray(message) ? message.filter(item => item.type === 'text').map(item => item.data?.text ?? '').join('') : '');

async function waitFor(predicate, { timeout = 120000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

const fixture = await createLocalDshFixture({
  prefix: 'qqbridge-group-',
  reply: body => isClassification(body) ? '{"should_reply":false}' : isSessionTitle(body) ? '隔离群聊晚饭' : MODEL_REPLY,
});
const tmpRoot = fixture.root;
const stateDir = path.join(tmpRoot, 'state');
const logDir = path.join(tmpRoot, 'logs');
await fsp.mkdir(stateDir, { recursive: true });
await fsp.mkdir(logDir, { recursive: true });

const config = {
  onebot: { url: '', accessToken: '' },
  dsh: {
    command: fixture.command,
    mode: 'headless',
    companion: false,
    profile: 'headless',
    patchPath: fixture.patchPath,
    cwd: fixture.workspace,
    timeoutMs: 300000,
    permissionMode: 'danger-full-access',
  },
  security: {
    allowFrom: [OWNER],
    adminUserIds: [OWNER],
    allowGroups: true,
    allowGroupIds: [TARGET_GROUP],
    allowGroupMembers: false,
    rateLimitPerMinute: 30,
    maxChars: 4000,
  },
  groupMemory: { limit: 300 },
  behavior: {
    queuedNotice: '',
    maxReplyChunk: 1200,
    showErrors: false,
    wakeWord: '',
    groupContextCount: 40,
  },
  persona: { enabled: false },
  memory: { enabled: false },
  stickers: { enabled: false },
  jev: { timeoutMs: 30000 },
  logDir: 'logs',
  stateDir: 'state',
};

// token: null = 不校验 Authorization。传空串会要求 “Bearer ”，桥接不带该头必然 401。
const napcat = createFakeNapCat({ token: null });
const port = await napcat.listen(0);
config.onebot.url = `ws://127.0.0.1:${port}`;
const configPath = path.join(tmpRoot, 'config.json');
await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

let bridge = null;
function startBridge() {
  bridge = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: fixture.env,
  });
  bridge.stderr.setEncoding('utf8');
  bridge.stderr.on('data', (c) => process.stderr.write(c));
}

const memFile = path.join(stateDir, 'groupmem', `${TARGET_GROUP}.jsonl`);
const readMem = () => {
  if (!fs.existsSync(memFile)) return [];
  return fs
    .readFileSync(memFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};
const replyCount = () => napcat.state.calls.filter((c) => String(c.action).includes('send_')).length;

try {
  startBridge();

  section('0/4 桥接起来');
  await waitFor(() => napcat.state.connections > 0, { timeout: 60000, label: 'NapCat 连接' });
  ok('桥接已连接');

  section('1/4 群里没 @ → 只记忆不回复');
  const before1 = replyCount();
  napcat.sendGroupMessage({
    groupId: TARGET_GROUP,
    userId: OTHER_MEMBER,
    text: '今天晚饭吃什么',
    selfId: BOT,
    messageId: 201,
    nickname: '路人甲',
  });
  await waitFor(() => readMem().some((r) => r.text?.includes('晚饭')), { timeout: 15000, label: '群记忆落盘' });
  ok('陌生人发言进了记忆');
  await new Promise((r) => setTimeout(r, 1500));
  if (replyCount() === before1) ok('没有回复（未 @ 机器人）');
  else bad('竟然回复了', `${replyCount() - before1} 条`);
  if (fixture.requests.length === 0) ok('非准入群成员未调用分类或回复模型');
  else bad('非准入群成员触发了模型请求');

  napcat.sendGroupMessage({
    groupId: TARGET_GROUP, userId: OWNER, text: '今天晚饭吃什么', selfId: BOT,
    messageId: 204, nickname: '主人',
  });
  await waitFor(() => fixture.requests.some(isClassification), { timeout: 30000, label: '当前 DSH 模型完成普通群聊分类' });
  const statusPath = path.join(stateDir, 'status.json');
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')).lastDrop?.includes('model_not_eligible'); }
    catch { return false; }
  }, { timeout: 15000, label: '普通群聊分类拒答结果' });
  const classifications = fixture.requests.filter(isClassification);
  if (classifications.length === 1 && fixture.requests.length === 1 && replyCount() === before1) ok('准入成员普通聊天仅分类一次并保持静默');
  else bad('普通群聊分类次数或静默行为不正确');
  if (classifications[0]?.model === 'test-chat' && !(classifications[0]?.tools?.length)) ok('默认分类使用当前模型且未提供工具');
  else bad('默认分类模型或工具边界不正确');

  section('2/4 别的群 @ 机器人 → 完全不理会');
  const before2 = replyCount();
  napcat.sendGroupMessage({
    groupId: WRONG_GROUP,
    userId: OWNER,
    text: '在吗',
    selfId: BOT,
    messageId: 202,
    nickname: '主人',
    atSelf: true,
  });
  await new Promise((r) => setTimeout(r, 2500));
  if (replyCount() === before2) ok('别的群没有任何回复');
  else bad('别的群被回复了', `${replyCount() - before2} 条`);
  if (!fs.existsSync(memFile.replace(String(TARGET_GROUP), String(WRONG_GROUP)))) ok('别的群没有被记录');
  else bad('别的群竟然被记录了');
  if (fixture.requests.length === 1) ok('未准入群不会调用分类或回复模型');
  else bad('未准入群触发了模型请求');

  section('3/4 白名单成员在目标群 @ 机器人 → 回复');
  const msgsBefore = readMem().length;
  napcat.sendGroupMessage({
    groupId: TARGET_GROUP,
    userId: OWNER,
    text: '刚才大家说晚饭吃啥来着？一句话答完',
    selfId: BOT,
    messageId: 203,
    nickname: '主人',
    atSelf: true,
  });
  await waitFor(() => napcat.state.calls.some(c => c.action === 'send_group_msg' && messageText(c.params?.message) === MODEL_REPLY), { timeout: 60000, label: '群聊本机模型确定回复' });
  const reply = napcat.state.calls.filter((c) => String(c.action).includes('send_')).at(-1);
  if (messageText(reply?.params?.message) === MODEL_REPLY) ok('收到了本机真实 DSH 模型的确定回复');
  else bad('群聊回复并非预期模型文本');
  await waitFor(() => fixture.requests.some(isSessionTitle), { timeout: 15000, label: 'DSH 内核生成会话标题' });
  const conversations = fixture.requests.filter(body => !isClassification(body) && !isSessionTitle(body));
  const titles = fixture.requests.filter(isSessionTitle);
  if (conversations.length === 1 && fixture.requests.filter(isClassification).length === 1
      && titles.length === 1 && fixture.requests.length === 3) ok('明确 @ 绕过分类，仅调用一次回复和一次内核标题模型');
  else bad('明确 @ 的模型调用类型或次数不正确', JSON.stringify(fixture.requests.map(body => ({
    model: body.model, classification: isClassification(body), title: isSessionTitle(body), tools: body.tools?.length ?? 0,
    roles: body.messages?.map(message => message.role),
    lastMessage: JSON.stringify(body.messages?.at(-1)).slice(0, 500),
  }))));
  if (conversations[0]?.model === 'test-chat' && requestText(conversations[0]).includes('今天晚饭吃什么')) ok('真实回复模型收到前面的群聊上下文');
  else bad('真实回复模型没有收到群聊上下文');

  section('4/4 记忆格式与内容');
  await waitFor(() => readMem().length >= msgsBefore + 1, { timeout: 15000, label: '记忆追加' });
  const mem = readMem();
  const memDir = path.join(stateDir, 'groupmem');
  console.log('  记忆目录：', fs.existsSync(memDir) ? fs.readdirSync(memDir).join(', ') : '(不存在)');
  for (const r of mem) console.log('  ·', JSON.stringify(r));
  ok('记忆文件按行 JSONL 落盘', `${mem.length} 条`);
  const rec = mem.find((r) => r.text?.includes('晚饭'));
  if (rec && String(rec.userId) === String(OTHER_MEMBER) && rec.nickname === '路人甲') {
    ok('字段正确', JSON.stringify(rec).slice(0, 120));
  } else {
    bad('字段不对', JSON.stringify(rec));
  }
  const ownerRec = mem.find((r) => String(r.userId) === String(OWNER) && r.text?.includes('刚才大家说晚饭'));
  if (ownerRec) ok('@ 的那条也记下了', JSON.stringify(ownerRec).slice(0, 100));
  else bad('@ 的那条没记下');
} catch (err) {
  bad('异常', String(err?.message ?? err));
} finally {
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
    const closed = new Promise(resolve => bridge.once('close', resolve));
    killProcessTree(bridge);
    await closed;
  }
  await napcat.close();
  await fixture.close();
}

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
