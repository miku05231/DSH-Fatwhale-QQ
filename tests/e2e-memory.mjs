// 端到端测试：长期记忆（Obsidian 记忆库）在真实消息流里的落盘与检索。
//
// 与 e2e-fake-napcat.mjs 的区别：那个测「回不回」，这个专门测「记不记得」。
//
// 验证内容：
//   1. 桥接启动后会 ensure() 记忆库目录结构
//   2. 私聊一轮对话后，30-日志/<今天>.md 里出现「谁说了什么」和「我回了什么」
//   3. 10-人物/<QQ号>.md 被建立/更新
//   4. 用 tools/memory.mjs search 能检索到刚说的话（证明写入格式可被检索）
//   5. 记忆库损坏/不可写时桥接不崩（用只读根目录模拟）
//
// 用法：node tests/e2e-memory.mjs
//       需要本机 dsh 可用；单条问答 5-30 秒。

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

const ALLOWED_USER = 987654321;
const NICKNAME = '记忆测试员';

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
const section = (title) => console.log(`\n[${title}]`);

async function waitFor(predicate, { timeout = 120000, interval = 250, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, interval));
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

/**
 * 桥接在 DSH 跑超过 45 秒时会插一条「还在处理…（已 N 秒）」的心跳，
 * 那不是真正的回答。测试必须把这类中途提示过滤掉，否则会误判成回复已完成。
 */
function isInterim(text) {
  return /还在处理|慢一点，我还在处理|读到，正在处理|收到，正在处理/.test(String(text ?? ''));
}

/** 在 calls 里找第一条「真正的回复」（非中途提示） */
function findRealReply(calls, userId) {
  return calls.find(
    (c) =>
      c.action === 'send_private_msg' &&
      c.params?.user_id === userId &&
      String(c.params?.message ?? '').trim() !== '' &&
      !isInterim(c.params.message),
  );
}

const dateStamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 跑一条命令，收集输出 */
function run(file, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err?.message ?? err) });
    });
  });
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-memory-e2e-'));
  const vault = path.join(tmpRoot, '记忆库');
  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);
  console.log(`假 NapCat 监听 127.0.0.1:${port}`);
  console.log(`临时记忆库 ${vault}`);

  const configPath = path.join(tmpRoot, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
    dsh: {
      command: 'dsh',
      profile: 'headless',
      patchPath: path.join(PROJECT_ROOT, 'patches', 'headless-model.yml'),
      cwd: path.join(PROJECT_ROOT, 'qq-workspace'),
      timeoutMs: 240000,
    },
    security: {
      allowFrom: [ALLOWED_USER],
      allowGroups: false,
      rateLimitPerMinute: 60,
      maxChars: 4000,
    },
    behavior: {
      queuedNotice: '',
      maxReplyChunk: 1200,
      showErrors: true,
      wakeWord: '',
      groupContextCount: 20,
    },
    memory: {
      enabled: true,
      root: vault,
      inject: true,
      capture: true,
      maxInjectChars: 800,
      reflectEvery: 0, // 关掉自动反思，避免测试里额外起 dsh 子进程
    },
    groupMemory: { limit: 100 },
    logDir,
    stateDir,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childOut = [];
  child.stdout.on('data', (c) => childOut.push(c.toString()));
  child.stderr.on('data', (c) => childOut.push(c.toString()));

  try {
    section('1/5 启动与记忆库初始化');
    await waitFor(() => napcat.state.connections >= 1, { timeout: 25000, label: '桥接连上假 NapCat' });
    ok('桥接已连接');

    const dailyDir = path.join(vault, '30-日志');
    const personDir = path.join(vault, '10-人物');
    await waitFor(() => fs.existsSync(dailyDir) && fs.existsSync(personDir), {
      timeout: 15000,
      label: '记忆库目录建立',
    });
    ok('记忆库目录已建立', '30-日志 / 10-人物');

    const indexExists = fs.existsSync(path.join(vault, '大肥鱼.md'));
    if (indexExists) ok('索引页 大肥鱼.md 已生成');
    else bad('索引页没生成');

    section('2/5 一轮私聊 → 落盘');
    const before = napcat.state.calls.length;
    const said = '我晚上想吃红烧肉配白米饭';
    napcat.sendPrivateMessage({ userId: ALLOWED_USER, text: said, messageId: 201, nickname: NICKNAME });

    const replyCall = await waitFor(() => findRealReply(napcat.state.calls.slice(before), ALLOWED_USER), {
      timeout: 300000,
      label: '收到真正的回复',
    });
    const replyText = String(replyCall.params.message ?? '');
    if (replyText.trim()) ok('收到私聊回复', `「${replyText.slice(0, 50)}」`);
    else bad('回复为空');

    section('3/5 日志与人物页内容');
    const dailyFile = path.join(dailyDir, `${dateStamp()}.md`);
    const dailyText = await waitFor(
      async () => {
        try {
          const t = await fsp.readFile(dailyFile, 'utf8');
          return t.includes('红烧肉') ? t : null;
        } catch {
          return null;
        }
      },
      { timeout: 20000, label: '日志文件写入红烧肉' },
    ).catch((err) => {
      bad('当日日志没写入内容', err.message);
      return '';
    });
    if (dailyText) {
      ok('当日日志包含用户原话', `30-日志/${dateStamp()}.md`);
      if (dailyText.includes('我：')) ok('当日日志记录了回复');
      else bad('当日日志缺少「我：」回复行');
      if (dailyText.includes('[私聊]')) ok('私聊来源标注正确');
      else bad('私聊来源标注缺失');
    }

    const personFile = path.join(personDir, `${ALLOWED_USER}.md`);
    const personText = await waitFor(
      async () => {
        try {
          return await fsp.readFile(personFile, 'utf8');
        } catch {
          return null;
        }
      },
      { timeout: 20000, label: '人物页生成' },
    ).catch((err) => {
      bad('人物页没生成', err.message);
      return '';
    });
    if (personText) ok('人物页已建立', `10-人物/${ALLOWED_USER}.md`);
    if (personText && personText.includes(String(ALLOWED_USER))) ok('人物页记录了 QQ 号');
    else if (personText) bad('人物页缺少 QQ 号');

    section('4/5 检索可命中（tools/memory.mjs）');
    const search = await run(path.join('tools', 'memory.mjs'), ['search', '红烧肉', '--root', vault, '--json'], {
      timeoutMs: 60000,
    });
    if (search.code === 0) {
      let parsed = null;
      try {
        parsed = JSON.parse(search.out.trim());
      } catch {
        /* 输出里可能混了日志行 */
      }
      const count = Array.isArray(parsed) ? parsed.length : Number(parsed?.count ?? 0);
      if (count > 0) ok('检索命中刚说的话', `${count} 条`);
      else bad('检索没命中', search.out.slice(0, 160));
    } else {
      bad('memory.mjs search 执行失败', search.out.slice(0, 160));
    }

    const stats = await run(path.join('tools', 'memory.mjs'), ['stats', '--root', vault, '--json'], { timeoutMs: 30000 });
    if (stats.code === 0 && /files/.test(stats.out)) ok('stats 可读');
    else bad('stats 读取失败', stats.out.slice(0, 120));
  } finally {
    await killTree(child.pid);
    await napcat.close?.();
  }

  // ------------------------------------------------------------------
  // 5) 记忆库不可写时，桥接必须照常回话（不能因为记忆坏了就哑巴）
  // ------------------------------------------------------------------
  section('5/5 记忆库故障降级');
  {
    // 用一个「父路径是文件」的根目录，让 mkdir 必定失败，模拟记忆库不可写
    const blocker = path.join(tmpRoot, 'blocker');
    await fsp.writeFile(blocker, 'not a directory\n', 'utf8');
    const badRoot = path.join(blocker, '记忆库');

    const napcat2 = createFakeNapCat();
    const port2 = await napcat2.listen(0);
    // 注意：--config 要么给目录，要么给以 config.json 结尾的路径；
    // 这里用独立目录模拟「第二个安装位置」。
    const badDir = path.join(tmpRoot, 'bad-instance');
    await fsp.mkdir(badDir, { recursive: true });
    const badConfigPath = path.join(badDir, 'config.json');
    const badConfig = {
      ...config,
      onebot: { url: `ws://127.0.0.1:${port2}`, accessToken: '' },
      memory: { ...config.memory, root: badRoot },
    };
    await fsp.writeFile(badConfigPath, `${JSON.stringify(badConfig, null, 2)}\n`, 'utf8');

    const child2 = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', badConfigPath], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out2 = [];
    child2.stdout.on('data', (c) => out2.push(c.toString()));
    child2.stderr.on('data', (c) => out2.push(c.toString()));

    try {
      await waitFor(() => napcat2.state.connections >= 1, { timeout: 25000, label: '降级实例连上' }).catch((err) => {
        bad(`记忆库不可用时桥接没能启动：${err.message}`);
        console.log(out2.join('').split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));
        return null;
      });
      if (napcat2.state.connections >= 1) ok('记忆库不可用时桥接仍能启动');

      const before2 = napcat2.state.calls.length;
      napcat2.sendPrivateMessage({ userId: ALLOWED_USER, text: '只回复两个字：还在', messageId: 301, nickname: NICKNAME });
      const reply2 = await waitFor(() => findRealReply(napcat2.state.calls.slice(before2), ALLOWED_USER), {
        timeout: 300000,
        label: '降级实例回复',
      }).catch(() => null);

      if (reply2 && String(reply2.params.message ?? '').trim()) ok('记忆坏了也照常回复');
      else bad('记忆库故障导致不回复');

      const joined = out2.join('');
      if (/长期记忆不可用|记忆库未就绪/.test(joined)) ok('日志里给出了降级警告');
      else bad('日志缺少降级警告', joined.slice(0, 200));
    } finally {
      await killTree(child2.pid);
      await napcat2.close?.();
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(56));
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`测试崩溃：${err?.stack ?? err}`);
  process.exit(1);
});
