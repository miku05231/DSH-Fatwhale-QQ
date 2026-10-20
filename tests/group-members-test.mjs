/**
 * group-members-test.mjs —— 群里「别人」喊它，到底能不能得到回应。
 *
 * 起因（2026-10-20 13:36 现场）：群友 328615614（镜花水月）发了
 * 「大肥鱼我不想上班，好累啊」，桥接一条都没回。查 status.json 的 lastDrop
 * 与代码路径，根因是 security.allowGroupMembers=false + 她不在 allowFrom，
 * 于是唤醒词已经命中了，却在「谁能指挥我」这一关卡被丢掉。
 *
 * 本测试把两类配置各跑一个真桥接（假 NapCat + 假 dsh，不联网）：
 *   A) allowGroupMembers=false：群友 @ 我 / 喊我都回不了，lastDrop 说明原因
 *   B) allowGroupMembers=true + wakeWordMatch=contains：
 *        - 群友「为什么大肥鱼不理我」也回（contains 命中）
 *        - 群友「大肥鱼我不想上班」回（前缀自然也命中）
 *        - 群友「今天天气不错」不回（没喊、没 @）
 *        - 群里的 @ 我 也回
 *        - 不在 allowGroupIds 的群，@ 了也不回
 *
 * 用法：node tests\group-members-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFakeNapCat } from './ws-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const SELF_ID = 10000;
const OWNER = 1000000002;
const MEMBER = 328615614; // 镜花水月
const GROUP = 200000001;
const OTHER_GROUP = 123456789;
const WAKE = '大肥鱼';

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  failed += 1;
  console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 20000, interval = 120, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

const FAKE_DSH = `process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-member' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

/** 起一个真桥接（假 NapCat），返回操作句柄 */
async function startBridge({ allowGroupMembers, wakeWordMatch }) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-members-'));
  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const fakeDsh = path.join(tmpRoot, 'fake-dsh.mjs');
  await fsp.writeFile(fakeDsh, FAKE_DSH, 'utf8');
  const basePatch = path.join(tmpRoot, 'base.yml');
  await fsp.writeFile(basePatch, '- id: agent-default-model\n  config:\n    provider: p\n    model: m\n', 'utf8');

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);

  const configPath = path.join(tmpRoot, 'config.json');
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
      dsh: { command: fakeDsh, profile: 'headless', patchPath: basePatch, cwd: tmpRoot, timeoutMs: 60000 },
      security: {
        allowFrom: [OWNER],
        allowGroups: true,
        allowGroupMembers,
        allowGroupIds: [GROUP],
        rateLimitPerMinute: 0,
        maxChars: 4000,
      },
      behavior: {
        queuedNotice: '',
        maxReplyChunk: 1200,
        showErrors: true,
        wakeWord: WAKE,
        wakeWordMatch,
        groupContextCount: 5,
      },
      logDir,
      stateDir,
      memory: { enabled: false },
    }, null, 2)}\n`,
    'utf8',
  );

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childOut = [];
  child.stdout.on('data', (c) => childOut.push(c.toString()));
  child.stderr.on('data', (c) => childOut.push(c.toString()));
  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
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

  return {
    napcat,
    readStatus,
    /** 发一条群消息，返回这一批新产生的群回复（过滤心跳） */
    async sendGroup({ groupId = GROUP, userId, text, atSelf = false, messageId }) {
      const from = napcat.state.calls.length;
      napcat.sendGroupMessage({ groupId, userId, nickname: `u${userId}`, text, selfId: SELF_ID, messageId, atSelf });
      await sleep(2200);
      return napcat.state.calls
        .slice(from)
        .filter(
          (c) =>
            c.action === 'send_group_msg' &&
            c.params?.group_id === groupId &&
            !String(c.params?.message ?? '').includes('还在处理'),
        );
    },
    async stop() {
      if (exitCode === null) await killTree(child.pid);
      await napcat.close();
      const tail = childOut.join('');
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      return tail;
    },
  };
}

async function main() {
  console.log('\n[1/2 allowGroupMembers=false：群友喊破喉咙也回不了，但原因可查]');
  let bridge = await startBridge({ allowGroupMembers: false, wakeWordMatch: 'prefix' });
  try {
    let replies = await bridge.sendGroup({ userId: MEMBER, text: `${WAKE} 我不想上班，好累啊`, messageId: 201 });
    if (replies.length === 0) ok('群友喊唤醒词 → 不回（符合旧配置语义）');
    else bad('旧配置下不该回却回了', String(replies[0].params.message).slice(0, 60));
    let status = bridge.readStatus();
    if (String(status?.lastDrop ?? '').includes('allowGroupMembers')) {
      ok('lastDrop 指出了真正的关卡', status.lastDrop);
    } else {
      bad('lastDrop 没指出 allowGroupMembers', JSON.stringify(status?.lastDrop ?? null));
    }

    replies = await bridge.sendGroup({ userId: MEMBER, text: '在吗', atSelf: true, messageId: 202 });
    if (replies.length === 0) ok('群友 @ 我 → 不回（旧配置下白名单优先）');
    else bad('旧配置下 @ 也不该回', String(replies[0].params.message).slice(0, 60));
  } finally {
    await bridge.stop();
  }

  console.log('\n[2/2 allowGroupMembers=true + contains：群友喊它就有回应]');
  bridge = await startBridge({ allowGroupMembers: true, wakeWordMatch: 'contains' });
  try {
    let replies = await bridge.sendGroup({ userId: MEMBER, text: '为什么大肥鱼不理我', messageId: 301 });
    if (replies.length > 0 && String(replies[0].params.message).includes('收到')) {
      ok('唤醒词出现在句中（contains）→ 回');
    } else {
      bad('句中唤醒词没触发回复', `回复数 ${replies.length}`);
    }

    replies = await bridge.sendGroup({ userId: MEMBER, text: `${WAKE} 我不想上班，好累啊`, messageId: 302 });
    if (replies.length > 0) ok('群友以唤醒词开头 → 回');
    else bad('群友以唤醒词开头也没回');

    replies = await bridge.sendGroup({ userId: MEMBER, text: '今天天气不错', messageId: 303 });
    if (replies.length === 0) ok('没喊也没 @，只是闲聊 → 不回（不刷屏）');
    else bad('闲聊被搭话了', String(replies[0].params.message).slice(0, 60));
    const status = bridge.readStatus();
    if (String(status?.lastDrop ?? '').includes('唤醒词')) ok('闲聊被忽略的原因可查', status.lastDrop);
    else bad('闲聊忽略原因不对', JSON.stringify(status?.lastDrop ?? null));

    replies = await bridge.sendGroup({ userId: MEMBER, text: '在吗', atSelf: true, messageId: 304 });
    if (replies.length > 0) ok('群友 @ 我 → 回');
    else bad('群友 @ 我没回');

    replies = await bridge.sendGroup({ userId: MEMBER, text: '在吗', atSelf: true, groupId: OTHER_GROUP, messageId: 305 });
    if (replies.length === 0) ok('不在 allowGroupIds 的群 → @ 了也不回');
    else bad('未授权群竟然回了');
  } finally {
    const tail = await bridge.stop();
    if (failed > 0 && tail.trim()) console.log(`\n--- 桥接输出尾部 ---\n${tail.split('\n').slice(-15).join('\n')}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
