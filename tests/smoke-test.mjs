#!/usr/bin/env node
// scripts/smoke-test.js —— 离线冒烟测试（不连 QQ，不需要 NapCat）
//
// 覆盖：
//   A. SessionStore 的 get/set/remove/持久化/损坏重建
//   B. runDsh 真实调用 dsh CLI（用 patches/headless-model.yml）
//      - 新建会话：从首行 session 事件拿回 sessionId
//      - 第二轮用同一 sessionId 续传：能记住上一轮刚让它记的数字
//      - 报错路径：不存在的 session-id 必须被拒绝
//      - 中止路径：已 abort 的 AbortSignal 立即拒绝
//      - 超时路径：超时后用 taskkill 杀掉进程树并拒绝
//
// 用法（项目根目录下）：
//   node scripts/smoke-test.js
//
// 注意：每次真实 dsh 调用 5~60 秒，全部串行执行。

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { runDsh } from '../src/dsh.js';
import { SessionStore } from '../src/sessions.js';
import { createLocalDshFixture, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const SECRET = '7319';
let fixture;
let cfg;
let restoreEnv;

/* ------------------------------------------------------------------ */
/* 简陋的测试框架                                                      */
/* ------------------------------------------------------------------ */
const cases = [];
const record = (name, fn) => cases.push({ name, fn });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/** 取回答里所有数字，用于宽松比对 */
function digitsIn(text) {
  return (String(text).match(/\d+/g) || []).join(',');
}

/* ------------------------------------------------------------------ */
/* A. SessionStore                                                     */
/* ------------------------------------------------------------------ */
record('SessionStore：空状态目录初始化', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'empty-'));
  const store = new SessionStore(dir);
  assert(store.get('10001') === null, '空库里 get 应该返回 null');
  assert(store.size === 0, `新库 size 应为 0，实际为 ${store.size}`);
  assert(fs.existsSync(store.file) === false, '空的 SessionStore 不应凭空写文件');
});

record('SessionStore：set/get 并持久化到磁盘', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'persist-'));
  const store = new SessionStore(dir);
  store.set(10001, 'session-aaa');
  store.set('10002', 'session-bbb');
  assert(store.get(10001) === 'session-aaa', '数字 id 应能取回');
  assert(store.get('10002') === 'session-bbb', '字符串 id 应能取回');
  assert(store.get(99999) === null, '不存在的 id 应返回 null');

  // 新实例读盘：验证真的落盘了
  const again = new SessionStore(dir);
  assert(again.get(10001) === 'session-aaa', '重新加载后仍应取回 session-aaa');
  assert(again.get('10002') === 'session-bbb', '重新加载后仍应取回 session-bbb');
  assert(again.size === 2, `重新加载后应有 2 条，实际 ${again.size}`);

  const raw = JSON.parse(fs.readFileSync(again.file, 'utf8'));
  assert(raw['10001'].sessionId === 'session-aaa', '磁盘上的 JSON 内容不对');
  assert(raw['10002'].sessionId === 'session-bbb', '磁盘上的 JSON 内容不对（10002）');
  return `已写入 ${again.size} 条并重新加载验证`;
});

record('SessionStore：remove 生效且落盘', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'remove-'));
  const store = new SessionStore(dir);
  store.set(20001, 'session-ccc');
  store.set(20002, 'session-ddd');
  assert(store.remove(20001) === true, 'remove 已存在的键应返回 true');
  assert(store.remove(20001) === false, 'remove 不存在的键应返回 false');
  assert(store.get(20001) === null, 'remove 后 get 应为 null');
  assert(store.remove(undefined) === false, 'remove(undefined) 应安全返回 false');

  const again = new SessionStore(dir);
  assert(again.get(20001) === null, 'remove 应已落盘');
  assert(again.get(20002) === 'session-ddd', '未被删除的键应保留');
  return '删除后重新加载确认已落盘';
});

record('SessionStore：损坏的 sessions.json 重建并告警', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'corrupt-'));
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, '{这不是合法 JSON', 'utf8');

  const warnings = [];
  const store = new SessionStore(dir, { log: { warn: (m) => warnings.push(String(m)) } });
  assert(store.size === 0, '损坏文件应重建为空库');
  assert(warnings.length >= 1, '损坏时应至少 warn 一次');
  assert(/损坏/.test(warnings[0]), `告警内容应说明损坏，实际：${warnings[0]}`);
  const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(fixed && typeof fixed === 'object' && !Array.isArray(fixed), '重建后应是对象');

  store.set(30001, 'session-eee');
  const again = new SessionStore(dir);
  assert(again.get(30001) === 'session-eee', '重建后应能正常读写');
  return `告警：${warnings[0].slice(0, 40)}…`;
});

/* ------------------------------------------------------------------ */
/* B. runDsh 真实调用                                                  */
/* ------------------------------------------------------------------ */
let sharedSessionId = null;

record('runDsh：新建会话并取回 sessionId', async () => {
  const r = await runDsh(`请记住这个数字：${SECRET}。只回复「已记住」四个字，不要输出其它内容。`, {
    cfg,
    log: quietLog,
  });
  assert(typeof r.sessionId === 'string' && r.sessionId.length > 0, '没有拿到 sessionId');
  assert(r.sessionId.startsWith('session-'), `sessionId 格式不对：${r.sessionId}`);
  assert(typeof r.finalText === 'string' && r.finalText.trim() !== '', 'finalText 为空');
  assert(Array.isArray(r.events) && r.events.length > 0, 'events 为空');
  assert(r.events[0].type === 'session', `首行事件应为 session，实际 ${r.events[0].type}`);
  assert(r.events.some((e) => e.type === 'final'), '事件流里没有 final 事件');
  sharedSessionId = r.sessionId;
  return `sessionId=${r.sessionId}，回答「${r.finalText.trim().slice(0, 20)}」，共 ${r.events.length} 个事件`;
});

record('runDsh：同一 sessionId 续传能记住上一轮内容', async () => {
  assert(sharedSessionId, '上一项没有拿到 sessionId，无法续传');
  const before = fixture.requests.length;
  const r = await runDsh('我刚才让你记住的数字是多少？只回答数字本身。', {
    sessionId: sharedSessionId,
    cfg,
    log: quietLog,
  });
  assert(r.sessionId === sharedSessionId, `续传应沿用原会话，返回了 ${r.sessionId}`);
  assert(
    r.finalText.includes(SECRET),
    `回答里没有记住的数字 ${SECRET}，实际回答：「${r.finalText.slice(0, 80)}」（含数字：${digitsIn(r.finalText)}）`,
  );
  const turnEnd = r.events.filter((e) => e.type === 'status' && e.phase === 'turn_end').pop();
  assert(turnEnd && turnEnd.turn >= 2, `第二轮 turn 应 >= 2，实际 ${turnEnd ? turnEnd.turn : '无 turn_end'}`);
  const wire = JSON.stringify(fixture.requests.slice(before));
  assert(wire.includes(`请记住这个数字：${SECRET}`) && wire.includes('已记住'),
    '续传请求必须包含第一轮用户输入和模型回复');
  return `第 ${turnEnd.turn} 轮回答「${r.finalText.trim().slice(0, 20)}」`;
});

record('runDsh：不存在的 sessionId 被明确拒绝', async () => {
  let rejected = null;
  try {
    await runDsh('你好', { sessionId: 'session-smoke-does-not-exist-0000', cfg, log: quietLog });
  } catch (err) {
    rejected = err;
  }
  assert(rejected, '不存在的 sessionId 本应失败，却成功了');
  assert(
    /does not exist|不存在/.test(rejected.message),
    `错误信息应说明会话不存在，实际：${rejected.message.slice(0, 120)}`,
  );
  return `已拒绝：${rejected.message.slice(0, 60)}…`;
});

record('runDsh：已 abort 的 signal 立即拒绝', async () => {
  const ac = new AbortController();
  ac.abort();
  const started = performance.now();
  let rejected = null;
  try {
    await runDsh('这条不该被执行', { cfg, log: quietLog, signal: ac.signal });
  } catch (err) {
    rejected = err;
  }
  const elapsed = performance.now() - started;
  assert(rejected, '已 abort 的调用本应失败');
  assert(/取消/.test(rejected.message), `错误信息应说明已取消，实际：${rejected.message}`);
  assert(elapsed < 2000, `应立刻返回，实际耗时 ${fmtMs(elapsed)}`);
  return `立即拒绝（${fmtMs(elapsed)}）`;
});

record('runDsh：模型请求进行中可以中止', async () => {
  const controller = new AbortController();
  const running = runDsh('smoke-wait-for-cancel', { cfg, log: quietLog, signal: controller.signal });
  const result = running.then(() => null, (error) => error);
  const end = Date.now() + 15000;
  try {
    while (!fixture.requests.some((request) => JSON.stringify(request.messages).includes('smoke-wait-for-cancel'))) {
      if (Date.now() > end) throw new Error('真实内核未发出待中止的本地模型请求');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  } finally {
    controller.abort();
    await result;
  }
  const error = await result;
  assert(error?.aborted && /取消/.test(error.message), '中途取消必须结束真实内核并明确拒绝');
});

record('runDsh：超时会杀掉进程树并拒绝', async () => {
  const timeoutMs = 6000;
  const timeoutCfg = { dsh: { ...cfg.dsh, timeoutMs } };
  const started = performance.now();
  let rejected = null;
  try {
    await runDsh('请写一篇约 3000 字的文章，讲一讲计算机的发展史。', {
      cfg: timeoutCfg,
      log: quietLog,
    });
  } catch (err) {
    rejected = err;
  }
  const elapsed = performance.now() - started;
  assert(rejected, '超时的调用本应失败，却成功了');
  assert(/超时/.test(rejected.message), `错误信息应说明超时，实际：${rejected.message}`);
  assert(rejected.timedOut === true, 'err.timedOut 应为 true');
  assert(fixture.requests.some((request) => JSON.stringify(request.messages).includes('3000')),
    '超时必须发生在真实内核访问合成模型之后');
  assert(elapsed < 30_000, `超时后应尽快返回，实际耗时 ${fmtMs(elapsed)}`);
  return `${fmtMs(elapsed)} 后拒绝：${rejected.message.slice(0, 60)}…`;
});

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const quietLog = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

let tmpRoot = '';
let failures = 0;

function hr() {
  return '-'.repeat(72);
}

async function main() {
  fixture = await createLocalDshFixture({
    prefix: 'qq-bridge-smoke-',
    reply(body) {
      const prompt = JSON.stringify(body.messages.filter((message) => message.role === 'user'));
      if (prompt.includes('3000') || prompt.includes('smoke-wait-for-cancel')) return null;
      if (prompt.includes('数字是多少')) return SECRET;
      return '已记住';
    },
  });
  tmpRoot = fixture.root;
  restoreEnv = useIsolatedEnv(tmpRoot, { QQ_FIXTURE_API_KEY: 'synthetic-local-key' });
  cfg = { dsh: {
    command: fixture.command, mode: 'headless', companion: false, profile: 'headless',
    patchPath: fixture.patchPath, cwd: fixture.workspace, permissionMode: 'read-only', timeoutMs: 45000,
  } };

  console.log(hr());
  console.log('QQ↔DSH 桥接 · 冒烟测试');
  console.log(`项目根   ：${PROJECT_ROOT}`);
  console.log('模型     ：固定真实内核 + 本地合成 SSE，无在线服务');
  console.log(`Node     ：${process.version}（${process.platform}）`);
  console.log(`临时目录 ：${tmpRoot}`);
  console.log(hr());
  console.log('');

  const allStarted = performance.now();
  for (let i = 0; i < cases.length; i += 1) {
    const { name, fn } = cases[i];
    const tag = `[${String(i + 1).padStart(2)}/${cases.length}] ${name}`;
    process.stdout.write(`${tag} … `);
    const started = performance.now();
    try {
      const detail = await fn();
      const elapsed = performance.now() - started;
      console.log(`通过（${fmtMs(elapsed)}）${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      failures += 1;
      const elapsed = performance.now() - started;
      console.log(`失败（${fmtMs(elapsed)}）`);
      console.log(`        原因：${err && err.message ? err.message : String(err)}`);
    }
  }

  const total = performance.now() - allStarted;
  console.log('');
  console.log(hr());
  if (failures === 0) {
    console.log(`全部通过：${cases.length} 项（耗时 ${fmtMs(total)}）`);
  } else {
    console.log(`有失败：${cases.length - failures} 项通过，${failures} 项失败（耗时 ${fmtMs(total)}）`);
    process.exitCode = 1;
  }
  console.log(hr());
}

try {
  await main();
} finally {
  restoreEnv?.();
  await fixture?.close();
}
