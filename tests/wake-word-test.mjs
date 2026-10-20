/**
 * wake-word-test.mjs —— 唤醒词的语义边界（回归用）。
 *
 * 起因：2026-10-20 12:54 用户群里 @ 了机器人说「给我写首藏头诗」，但配置里
 * behavior.wakeWord = "大肥鱼"，旧逻辑要求「去掉 @ 后的正文必须以唤醒词开头」，
 * 于是这条消息被静默丢弃 —— QQ 那头就是「完全没回」，日志里也只是 debug。
 *
 * 现在的语义：
 *   1. 私聊：直接说话就算，不需要唤醒词
 *   2. 群里 @ 了：算明确对话，不需要唤醒词（本次回归点）
 *   3. 群里没 @：才要求以唤醒词开头（被动搭话用）
 *   4. 被丢弃的原因写进 state/status.json 的 lastDrop，方便排查
 *
 * 用假 NapCat + 假 dsh，不联网、不碰真实账号。
 * 用法：node tests\wake-word-test.mjs
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
const GROUP = 200000001;
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

async function waitFor(predicate, { timeout = 20000, interval = 120, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

const FAKE_DSH = `process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-wake' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-wake-'));
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
        allowGroupMembers: false,
        allowGroupIds: [GROUP],
        rateLimitPerMinute: 0,
        maxChars: 4000,
      },
      behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, wakeWord: WAKE, groupContextCount: 5 },
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

  const callsSince = (from) => napcat.state.calls.slice(from);
  const privateReplies = (from) =>
    callsSince(from).filter(
      (c) => c.action === 'send_private_msg' && c.params?.user_id === OWNER && !String(c.params?.message ?? '').includes('还在处理'),
    );
  const groupReplies = (from) =>
    callsSince(from).filter(
      (c) => c.action === 'send_group_msg' && c.params?.group_id === GROUP && !String(c.params?.message ?? '').includes('还在处理'),
    );

  try {
    console.log('\n[1/4 私聊不需要唤醒词]');
    await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
    const p0 = napcat.state.calls.length;
    napcat.sendPrivateMessage({ userId: OWNER, text: '在吗', selfId: SELF_ID, messageId: 101 });
    const priv = await waitFor(() => (privateReplies(p0).length > 0 ? privateReplies(p0) : null), {
      timeout: 20000,
      label: '私聊回复',
    });
    if (String(priv[0].params.message).includes('收到')) ok('私聊直接说话就回');
    else bad('私聊回复内容异常', String(priv[0].params.message).slice(0, 60));

    console.log('\n[2/4 群里 @ 了就不该再被唤醒词挡住（本次回归）]');
    const g0 = napcat.state.calls.length;
    napcat.sendGroupMessage({
      groupId: GROUP,
      userId: OWNER,
      nickname: '主人',
      text: '@大肥鱼 给我写首藏头诗',
      selfId: SELF_ID,
      messageId: 102,
      atSelf: true,
    });
    const g1 = await waitFor(() => (groupReplies(g0).length > 0 ? groupReplies(g0) : null), {
      timeout: 20000,
      label: '群里 @ 的回复',
    });
    if (String(g1[0].params.message).includes('收到')) ok('群里 @ 我 → 正常回复');
    else bad('群里 @ 的回复内容异常', String(g1[0].params.message).slice(0, 60));

    console.log('\n[3/4 群里没 @ 也没唤醒词 → 不理，但记下原因]');
    const g2 = napcat.state.calls.length;
    napcat.sendGroupMessage({
      groupId: GROUP,
      userId: OWNER,
      nickname: '主人',
      text: '随便聊两句',
      selfId: SELF_ID,
      messageId: 103,
      atSelf: false,
    });
    await sleep(2500);
    if (groupReplies(g2).length === 0) ok('没 @ 也没唤醒词 → 不回');
    else bad('不该回却回了', String(groupReplies(g2)[0].params.message).slice(0, 60));
    const status = readStatus();
    if (String(status?.lastDrop ?? '').includes('唤醒词')) ok('status.json 记下了丢弃原因', status.lastDrop);
    else bad('status.json 没记丢弃原因', JSON.stringify(status?.lastDrop ?? null));

    console.log('\n[4/4 群里没 @ 但以唤醒词开头 → 回]');
    const g3 = napcat.state.calls.length;
    napcat.sendGroupMessage({
      groupId: GROUP,
      userId: OWNER,
      nickname: '主人',
      text: `${WAKE} 夸我一句`,
      selfId: SELF_ID,
      messageId: 104,
      atSelf: false,
    });
    const g4 = await waitFor(() => (groupReplies(g3).length > 0 ? groupReplies(g3) : null), {
      timeout: 20000,
      label: '唤醒词被动搭话的回复',
    });
    if (String(g4[0].params.message).includes('收到')) ok('唤醒词开头 → 正常回复');
    else bad('唤醒词回复内容异常', String(g4[0].params.message).slice(0, 60));
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
    const tail = childOut.join('').split('\n').slice(-20).join('\n');
    if (tail.trim()) console.log(`\n--- 桥接输出尾部 ---\n${tail}`);
  } finally {
    if (exitCode === null) await killTree(child.pid);
    await napcat.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
