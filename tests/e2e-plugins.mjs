/**
 * e2e-plugins.mjs —— 插件在真实桥接链路里生效的证据（假 NapCat + 假 dsh）。
 *
 * 验证三件事：
 *   1. 指令类插件（onMessage 返回 handled）能直接回复，且**完全不调用 dsh**
 *   2. 普通消息照常走 dsh
 *   3. afterReply 能把最终回复修饰掉（发出去的是修饰后的文本）
 *
 * 插件目录用 config.plugins.dir 指到临时目录，不碰项目自带的 src/plugins。
 *
 * 用法：node tests\e2e-plugins.mjs
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
const ALLOWED_USER = 123456789;

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

async function waitFor(predicate, { timeout = 30000, interval = 120, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
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

const CMD_PLUGIN = `export const meta = {
  name: 'cmd',
  displayName: '测试指令',
  version: '1.0.0',
  description: '收到 /ping 直接回 pong，不经过 dsh',
  configSchema: [{ key: 'reply', type: 'string', label: '回复', default: 'pong' }],
};
export async function onMessage(ctx) {
  if (!ctx.text.startsWith('/ping')) return undefined;
  await ctx.reply(ctx.config.reply);
  return { handled: true };
}
`;

const TAIL_PLUGIN = `export const meta = {
  name: 'tail',
  displayName: '测试尾巴',
  version: '1.0.0',
  description: '给 dsh 的回复加个尾巴',
};
export async function afterReply(ctx) {
  return { text: ctx.text + ' [尾巴]' };
}
`;

/** 假 dsh：每次调用往 FAKE_DSH_CALLS 追加一行 JSON，然后回「收到」 */
const FAKE_DSH = `import fs from 'node:fs';
const out = process.env.FAKE_DSH_CALLS;
const argv = process.argv.slice(2);
if (out) fs.appendFileSync(out, JSON.stringify({ argv }) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-fake-plugins' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-plugins-e2e-'));
  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  const pluginDir = path.join(tmpRoot, 'plugins');
  const callsFile = path.join(tmpRoot, 'dsh-calls.jsonl');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'cmd.js'), CMD_PLUGIN, 'utf8');
  await fsp.writeFile(path.join(pluginDir, 'tail.js'), TAIL_PLUGIN, 'utf8');

  const fakeDsh = path.join(tmpRoot, 'fake-dsh.mjs');
  await fsp.writeFile(fakeDsh, FAKE_DSH, 'utf8');
  // 桥接会先找 dsh.patchPath，缺文件就不干活，所以给个占位补丁
  const patchesDir = path.join(tmpRoot, 'patches');
  await fsp.mkdir(patchesDir, { recursive: true });
  await fsp.writeFile(
    path.join(patchesDir, 'headless-model.yml'),
    '- id: agent-default-model\n  config:\n    provider: fake\n    model: fake\n',
    'utf8',
  );

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);

  const configPath = path.join(tmpRoot, 'config.json');
  await fsp.writeFile(
    configPath,
    `${JSON.stringify(
      {
        onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
        dsh: { command: fakeDsh, profile: 'headless', cwd: tmpRoot, timeoutMs: 60000 },
        security: { allowFrom: [ALLOWED_USER], allowGroups: false, rateLimitPerMinute: 60, maxChars: 4000 },
        behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, wakeWord: '' },
        plugins: { enabled: true, dir: pluginDir },
        logDir,
        stateDir,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_DSH_CALLS: callsFile },
  });

  const output = [];
  child.stdout.on('data', (c) => output.push(c.toString()));
  child.stderr.on('data', (c) => output.push(c.toString()));
  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  const readCalls = () => {
    try {
      return fs
        .readFileSync(callsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  async function sendAndWait(text, messageId) {
    const before = napcat.state.calls.length;
    napcat.sendPrivateMessage({ userId: ALLOWED_USER, text, messageId });
    const call = await waitFor(
      () =>
        napcat.state.calls
          .slice(before)
          .find(
            (c) =>
              c.action === 'send_private_msg' &&
              c.params?.user_id === ALLOWED_USER &&
              !String(c.params?.message ?? '').includes('还在处理'),
          ),
      { timeout: 40000, label: `消息「${text}」的回复` },
    );
    return String(call.params.message ?? '');
  }

  try {
    section('1/3 启动与插件加载');
    await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
    ok('桥接已连接假 NapCat');

    const status = await waitFor(() => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
        return typeof s.plugins === 'number' ? s : null;
      } catch {
        return null;
      }
    }, { timeout: 15000, label: 'status.json 带出插件数' });
    if (status.plugins === 2) ok('两个插件都加载了', `plugins=${status.plugins}`);
    else bad('插件数不对', JSON.stringify({ plugins: status.plugins, failed: status.pluginsFailed }));
    if (status.pluginsFailed === 0) ok('没有插件加载失败');
    else bad('有插件加载失败', String(status.pluginsFailed));

    section('2/3 指令类插件接管，且不调用 dsh');
    const pong = await sendAndWait('/ping', 301);
    if (pong.trim() === 'pong') ok('指令插件直接回复「pong」', pong);
    else bad('指令插件回复异常', JSON.stringify(pong));
    await new Promise((r) => setTimeout(r, 400));
    if (readCalls().length === 0) ok('这条消息没有调用 dsh');
    else bad('指令被接管了却仍调用了 dsh', `调用 ${readCalls().length} 次`);

    section('3/3 普通消息走 dsh，afterReply 修饰最终文本');
    const reply = await sendAndWait('你好，随便聊聊', 302);
    if (reply.trim() === '收到 [尾巴]') ok('dsh 回复被 afterReply 加了尾巴', reply);
    else bad('afterReply 没生效', JSON.stringify(reply));
    const calls = await waitFor(() => (readCalls().length >= 1 ? readCalls() : null), {
      timeout: 15000,
      label: '假 dsh 被调用',
    });
    const prompt = String(calls[0]?.argv?.at(-1) ?? '');
    if (prompt.includes('你好，随便聊聊')) ok('prompt 里带着原话');
    else bad('prompt 里没有原话', prompt.slice(0, 120));
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
    const tail = output.join('').split('\n').slice(-25).join('\n');
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
