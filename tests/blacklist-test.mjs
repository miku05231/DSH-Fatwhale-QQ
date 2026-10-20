/**
 * blacklist-test.mjs —— 私聊 / 群聊黑白名单
 *
 * A. 纯函数（src/security.js）：黑名单优先级、privatePolicy=blacklist 放行、
 *    群黑名单压过群白名单、推进黑名单的群连 @ 都不受理
 * B. 真桥接（假 NapCat + 假 dsh）三段场景：
 *    1) 私聊策略 blacklist：黑名单里的人不回，别人照常回
 *    2) 群聊黑名单：群号同时在 allowGroupIds 与 denyGroupIds 里 → 不回、不写群记忆
 *    3) allowlist 模式下 denyFrom 依旧压过 allowFrom
 *
 * 用法：node tests\blacklist-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFakeNapCat } from './ws-harness.mjs';
import { isAllowed, isUserBlocked, isGroupBlocked, isGroupWatched, privatePolicyOf, checkGroupAllowed } from '../src/security.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
const ok = (name, detail = '') => {
  passed += 1;
  console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
};
const bad = (name, detail = '') => {
  failed += 1;
  console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
};
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else bad(name, `${a} ≠ ${e}`);
};
const section = (t) => console.log(`\n[${t}]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, label = '条件' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

const FAKE_DSH = `process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-blacklist' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

/** 起一个真桥接；返回句柄，用完必须 close() */
async function startBridge({ security, behavior = {}, allowGroups = true } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-blacklist-'));
  const stateDir = path.join(dir, 'state');
  const logDir = path.join(dir, 'logs');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  await fsp.writeFile(fakeDsh, FAKE_DSH, 'utf8');
  // 桥接默认会带 patches/headless-model.yml，缺了会整轮报错；这里放一个能解析的最小 patch
  await fsp.mkdir(path.join(dir, 'patches'), { recursive: true });
  const patchPath = path.join(dir, 'patches', 'headless-model.yml');
  await fsp.writeFile(patchPath, '- id: agent-default-model\n  config:\n    provider: fake\n    model: fake-model\n', 'utf8');

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);
  const configPath = path.join(dir, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
    dsh: { command: fakeDsh, profile: 'headless', patchPath, cwd: dir, timeoutMs: 30000 },
    security: { allowGroups, allowGroupMembers: true, rateLimitPerMinute: 0, maxChars: 4000, ...security },
    behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, wakeWord: '', ...behavior },
    logDir,
    stateDir,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  let exitCode = null;
  child.on('exit', (c) => {
    exitCode = c;
  });

  const statusPath = path.join(stateDir, 'status.json');
  const readStatus = () => {
    try {
      return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
      return null;
    }
  };
  await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
  await waitFor(() => readStatus()?.connected, { timeout: 20000, label: 'status.json 就绪' });

  const repliesSince = (before, kind) =>
    napcat.state.calls
      .slice(before)
      .filter((c) => c.action === `send_${kind}_msg`)
      .map((c) => String(c.params?.message ?? ''))
      .filter((m) => !m.includes('还在处理'));

  return {
    dir,
    stateDir,
    napcat,
    readStatus,
    repliesSince,
    async close() {
      if (exitCode === null) await killTree(child.pid);
      await napcat.close();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function main() {
  // ---------------------------------------------------------------- A 纯函数
  section('A. security.js 的名单判定');
  const base = { security: { allowFrom: [111], denyFrom: [], allowGroupIds: [], denyGroupIds: [], allowGroups: true } };

  eq(privatePolicyOf(base), 'allowlist', '默认私聊策略是 allowlist');
  ok('白名单内的号能私聊', JSON.stringify(isAllowed(111, base)));
  ok('不在白名单的号不能私聊', JSON.stringify(isAllowed(222, base)));

  const denied = { security: { ...base.security, denyFrom: [111] } };
  ok('denyFrom 命中即拒绝（白名单也救不了）', JSON.stringify(isAllowed(111, denied)));
  ok('isUserBlocked 单独可用', JSON.stringify(isUserBlocked(111, denied)));

  const blackMode = { security: { ...base.security, allowFrom: [], denyFrom: [111], privatePolicy: 'blacklist' } };
  eq(privatePolicyOf(blackMode), 'blacklist', '能读到 privatePolicy=blacklist');
  ok('blacklist 模式下名单外的人也能聊', JSON.stringify(isAllowed(222, blackMode)));
  ok('blacklist 模式下黑名单里的人仍被拒', JSON.stringify(isAllowed(111, blackMode)));

  eq(isGroupWatched(900, { security: { allowGroups: true, allowGroupIds: [900], denyGroupIds: [900] } }), false, '群黑名单压过群白名单');
  eq(isGroupBlocked(900, { security: { denyGroupIds: ['900'] } }), true, 'isGroupBlocked 兼容字符串群号');
  eq(isGroupWatched(901, { security: { allowGroups: true, denyGroupIds: [900] } }), true, '不在黑名单的群照常在场');
  eq(
    checkGroupAllowed({ messageType: 'group', groupId: 900, userId: 111, raw: { message: [{ type: 'at', data: { qq: '10000' } }] }, selfId: 10000 }, { security: { allowGroups: true, allowGroupIds: [900], denyGroupIds: [900] } }),
    false,
    'checkGroupAllowed 也被群黑名单拦住',
  );

  // ---------------------------------------------------------------- B 真桥接
  section('B1. 私聊 blacklist：黑名单不回，别人照常');
  {
    const app = await startBridge({
      security: { privatePolicy: 'blacklist', allowFrom: [], denyFrom: [333], allowGroups: false },
    });
    try {
      const before = app.napcat.state.calls.length;
      app.napcat.sendPrivateMessage({ userId: 333, text: '你好', messageId: 11 });
      const drop = await waitFor(() => {
        const s = app.readStatus();
        return s?.lastDrop?.includes('denyFrom') ? s.lastDrop : null;
      }, { label: '黑名单命中写进 lastDrop' });
      ok('黑名单用户的 lastDrop 写明原因', drop);
      await sleep(600);
      eq(app.repliesSince(before, 'private'), [], '黑名单里的人没有得到回复');

      const before2 = app.napcat.state.calls.length;
      app.napcat.sendPrivateMessage({ userId: 444, text: '你好', messageId: 12 });
      const replies = await waitFor(() => {
        const r = app.repliesSince(before2, 'private');
        return r.length ? r : null;
      }, { label: '名单外用户得到回复' });
      if (String(replies[0]).includes('收到')) ok('blacklist 模式下名单外用户能聊', replies[0].slice(0, 20));
      else bad('名单外用户虽然收到消息但不是正常回复', String(replies[0]).slice(0, 80));
    } finally {
      await app.close();
    }
  }

  section('B2. 群黑名单：同在白名单里也不回、不记群记忆');
  {
    const app = await startBridge({
      security: { allowGroupIds: [777], denyGroupIds: [777] },
      behavior: { wakeWord: '' },
    });
    try {
      const before = app.napcat.state.calls.length;
      app.napcat.sendGroupMessage({ groupId: 777, userId: 111, text: '在吗', atSelf: true, selfId: 10000, messageId: 13 });
      const drop = await waitFor(() => {
        const s = app.readStatus();
        return s?.lastDrop?.includes('denyGroupIds') ? s.lastDrop : null;
      }, { label: '群黑名单写进 lastDrop' });
      ok('群黑名单的 lastDrop 写明原因', drop);
      await sleep(600);
      eq(app.repliesSince(before, 'group'), [], '黑名单群里的 @ 没有得到回复');
      eq(fs.existsSync(path.join(app.stateDir, 'groupmem', '777.jsonl')), false, '黑名单群连群记忆都不写');
    } finally {
      await app.close();
    }
  }

  section('B3. allowlist 模式下 denyFrom 依旧压过 allowFrom');
  {
    const app = await startBridge({
      security: { privatePolicy: 'allowlist', allowFrom: [333, 444], denyFrom: [333], allowGroups: false },
    });
    try {
      const before = app.napcat.state.calls.length;
      app.napcat.sendPrivateMessage({ userId: 333, text: '你好', messageId: 14 });
      await waitFor(() => app.readStatus()?.lastDrop?.includes('denyFrom'), { label: '白名单里的黑名单用户被拒' });
      await sleep(600);
      eq(app.repliesSince(before, 'private'), [], '同时出现在 allowFrom 与 denyFrom 时按黑名单处理');

      const before2 = app.napcat.state.calls.length;
      app.napcat.sendPrivateMessage({ userId: 444, text: '你好', messageId: 15 });
      const replies = await waitFor(() => {
        const r = app.repliesSince(before2, 'private');
        return r.length ? r : null;
      }, { label: '纯白名单用户得到回复' });
      if (String(replies[0]).includes('收到')) ok('只有白名单、没有黑名单的用户照常聊', replies[0].slice(0, 20));
      else bad('白名单用户虽然收到消息但不是正常回复', String(replies[0]).slice(0, 80));
    } finally {
      await app.close();
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
