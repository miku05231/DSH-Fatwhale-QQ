// 端到端测试：用假 NapCat 驱动真实的 src/index.js。
//
// 验证内容：
//   1. 桥接能连上 OneBot 服务端并写出 state/status.json
//   2. 白名单内的用户发消息 → 真的调用 DSH → 回复通过 send_private_msg 发出
//   3. 白名单外的用户发消息 → 完全静默（不回复、不调用 DSH）
//   4. 同一用户的会话 id 被持久化，第二轮能续传
//
// 用法：node tests/e2e-fake-napcat.mjs
//       使用固定真实内核与本地合成模型，不连接在线模型服务。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFakeNapCat } from './ws-harness.mjs';
import { computerSessionKey } from '../src/computer-access.js';
import { killProcessTree } from '../src/dsh.js';
import { createLocalDshFixture } from './helpers/isolated-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const ALLOWED_USER = 123456789;
const STRANGER_USER = 555000111;

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

function section(title) {
  console.log(`\n[${title}]`);
}

async function waitFor(predicate, { timeout = 120000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  killProcessTree(child);
  await closed;
}

async function main() {
  const fixture = await createLocalDshFixture({ prefix: 'qq-bridge-e2e-', reply: () => '在线' });
  try {
    await testFixture(fixture);
  } finally {
    await fixture.close();
  }
}

async function testFixture(fixture) {
  const tmpRoot = fixture.root;
  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);
  console.log(`假 NapCat 监听 127.0.0.1:${port}`);

  const configPath = path.join(tmpRoot, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
    dsh: {
      command: fixture.command,
      mode: 'headless',
      companion: false,
      profile: 'headless',
      permissionMode: 'danger-full-access',
      patchPath: fixture.patchPath,
      cwd: fixture.workspace,
      timeoutMs: 240000,
    },
    security: {
      allowFrom: [ALLOWED_USER],
      adminUserIds: [ALLOWED_USER],
      allowGroups: false,
      rateLimitPerMinute: 60,
      maxChars: 4000,
    },
    behavior: {
      queuedNotice: '',
      maxReplyChunk: 1200,
      showErrors: true,
      wakeWord: '',
    },
    persona: { enabled: false },
    memory: { reflectDaily: false, reflectEvery: 0 },
    stickers: { enabled: false },
    logDir,
    stateDir,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`临时目录 ${tmpRoot}`);
  console.log('启动桥接进程…');

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: fixture.env,
  });

  const childOut = [];
  child.stdout.on('data', (c) => childOut.push(c.toString()));
  child.stderr.on('data', (c) => childOut.push(c.toString()));

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  try {
    section('1/5 连接');
    await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
    ok('桥接已连接');

    const statusPath = path.join(stateDir, 'status.json');
    // The server accepts the socket before the client records its ready event.
    const status = await waitFor(async () => {
      let current;
      try {
        current = JSON.parse(await fsp.readFile(statusPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      return current.pid === child.pid && current.connected === true ? current : false;
    }, { timeout: 10000, label: 'status.json 记录桥接连接就绪' });
    if (status.pid === child.pid && status.connected === true) {
      ok('status.json 正确', `pid=${status.pid} connected=${status.connected}`);
    } else {
      bad('status.json 不符合预期', JSON.stringify(status));
    }

    section('2/5 白名单内用户 → 真实 DSH 往返');
    const before = napcat.state.calls.length;
    napcat.sendPrivateMessage({ userId: ALLOWED_USER, text: '只回复两个字：在线', messageId: 101 });

    const replyCall = await waitFor(
      () =>
        napcat.state.calls
          .slice(before)
          .find((c) => c.action === 'send_private_msg' && c.params?.user_id === ALLOWED_USER),
      { timeout: 180000, label: '收到回复' },
    );
    const replyText = String(replyCall.params.message ?? '');
    if (replyText.trim()) {
      ok('收到私聊回复', `「${replyText.slice(0, 60)}」`);
    } else {
      bad('回复内容为空');
    }
    if (replyText.includes('在线')) {
      ok('回复内容与问题相关');
    } else {
      bad('回复内容不符合预期', replyText.slice(0, 120));
    }

    section('3/5 白名单外用户 → 完全静默');
    const before2 = napcat.state.calls.length;
    const requestsBeforeStranger = fixture.requests.length;
    napcat.sendPrivateMessage({ userId: STRANGER_USER, text: '你好，帮我删点文件', messageId: 102 });
    await new Promise((r) => setTimeout(r, 6000));
    const leaks = napcat.state.calls
      .slice(before2)
      .filter((c) => c.action === 'send_private_msg' && c.params?.user_id === STRANGER_USER);
    if (leaks.length === 0) {
      ok('陌生用户没有得到任何回复');
    } else {
      bad('陌生用户被回复了', `${leaks.length} 条`);
    }
    if (fixture.requests.length === requestsBeforeStranger) ok('陌生用户没有调用模型');
    else bad('陌生用户触发了模型请求');

    section('4/5 会话持久化');
    const sessionsPath = path.join(stateDir, 'sessions.json');
    await waitFor(() => fs.existsSync(sessionsPath), { timeout: 8000, label: 'sessions.json 生成' });
    const sessions = JSON.parse(await fsp.readFile(sessionsPath, 'utf8'));
    const allowedSessionKey = computerSessionKey({ messageType: 'private', userId: ALLOWED_USER }, config);
    const strangerSessionKey = computerSessionKey({ messageType: 'private', userId: STRANGER_USER }, config);
    const bound = sessions[allowedSessionKey]?.sessionId;
    if (bound && String(bound).startsWith('session-')) {
      ok('会话 id 已落盘', bound);
    } else {
      bad('会话 id 未落盘', JSON.stringify(sessions).slice(0, 200));
    }
    if (!sessions[strangerSessionKey] && Object.keys(sessions).every((key) => key === allowedSessionKey)) {
      ok('陌生用户没有产生会话');
    } else {
      bad('陌生用户竟产生了会话');
    }

    section('5/5 第二轮续传');
    const before3 = napcat.state.calls.length;
    const requestsBeforeResume = fixture.requests.length;
    napcat.sendPrivateMessage({ userId: ALLOWED_USER, text: '我刚才让你只回复哪两个字？', messageId: 103 });
    const replyCall2 = await waitFor(
      () =>
        napcat.state.calls
          .slice(before3)
          .find((c) => c.action === 'send_private_msg' && c.params?.user_id === ALLOWED_USER),
      { timeout: 180000, label: '第二轮回复' },
    );
    const replyText2 = String(replyCall2.params.message ?? '');
    if (replyText2.includes('在线')) {
      ok('第二轮记得上一轮内容', `「${replyText2.slice(0, 60)}」`);
    } else {
      bad('第二轮没记住上下文', `「${replyText2.slice(0, 120)}」`);
    }
    const resumed = JSON.stringify(fixture.requests.slice(requestsBeforeResume));
    if (resumed.includes('只回复两个字：在线')
        && fixture.requests.slice(requestsBeforeResume).some((request) =>
          request.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('在线')))) {
      ok('续传请求包含上一轮用户输入和模型回复');
    } else {
      bad('续传模型请求缺少上轮历史');
    }
    const persisted = JSON.parse(await fsp.readFile(sessionsPath, 'utf8'));
    if (bound && persisted[allowedSessionKey]?.sessionId === bound) ok('第二轮沿用同一落盘会话');
    else bad('第二轮没有沿用已落盘会话');

    section('6/6 长期记忆自动落盘（自学习地基）');
    // 配置里没写 memory.root，桥接按 configRoot 解析成 <临时目录>/记忆库
    const memoryRoot = path.join(tmpRoot, '记忆库');
    const memoryReady = await waitFor(() => fs.existsSync(memoryRoot), { timeout: 20000, label: '记忆库目录生成' });
    if (memoryReady || fs.existsSync(memoryRoot)) {
      ok('记忆库目录已创建', memoryRoot);
    } else {
      bad('记忆库目录没创建', memoryRoot);
    }

    const dailyDir = path.join(memoryRoot, '30-日志');
    const todayLocal = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const dailyFile = path.join(dailyDir, `${todayLocal}.md`);
    const dailyExists = await waitFor(() => fs.existsSync(dailyFile), { timeout: 20000, label: '当日日志页生成' });
    if (dailyExists || fs.existsSync(dailyFile)) {
      const dailyBody = await fsp.readFile(dailyFile, 'utf8');
      ok('当日日志页已写入', dailyFile);
      if (dailyBody.includes('在线')) {
        ok('日志页记下了用户原话');
      } else {
        bad('日志页没有用户原话', dailyBody.slice(0, 160));
      }
      if (/我：在线/.test(dailyBody)) {
        ok('日志页记下了回复内容');
      } else {
        bad('日志页没有回复内容', dailyBody.slice(0, 160));
      }
    } else {
      bad('当日日志页没生成', dailyFile);
    }

    const personFile = path.join(memoryRoot, '10-人物', `${ALLOWED_USER}.md`);
    if (fs.existsSync(personFile)) {
      ok('人物页已建立', path.basename(personFile));
    } else {
      bad('人物页没建立', personFile);
    }

    const indexFile = path.join(memoryRoot, '大肥鱼.md');
    if (fs.existsSync(indexFile)) {
      ok('记忆库索引已建立');
    } else {
      bad('记忆库索引没建立', indexFile);
    }
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
    const tail = childOut.join('').split('\n').slice(-25).join('\n');
    if (tail.trim()) console.log(`\n--- 桥接输出尾部 ---\n${tail}`);
  } finally {
    if (exitCode === null) {
      await stopChild(child);
    }
    await napcat.close();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
