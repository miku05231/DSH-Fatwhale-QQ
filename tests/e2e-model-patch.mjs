/**
 * e2e-model-patch.mjs —— 「模型跟随」在真实桥接链路上的证据。
 *
 * 和 model-follow-test.mjs（纯函数单测）互补：这里跑的是真 src/index.js，
 * 用假 NapCat 灌一条私聊消息，再让 dsh.command 指向一个「假 dsh」脚本，
 * 把桥接真正传给 dsh 的 argv 原样记下来，于是可以断言：
 *
 *   1. 跟随模式：argv 里有两条 --patch，第二条是 state/model/runtime-model.yml，
 *      且这个文件里写的是「假家目录」里那张桌面端补丁层的模型 → 真的跟上了
 *   2. 手动模式：改 state/model/model.json 后再发一条，runtime patch 换成手动模型
 *   3. 桌面端补丁层消失：只剩一条 --patch，桥接照样回消息（兜底不拖垮对话）
 *
 * 假家目录靠改 USERPROFILE 实现（Node 在 Windows 上用 USERPROFILE 算 os.homedir()），
 * 所以不会碰用户真实的 ~/.dsh/profiles/desktop/cordis.patch.yml。
 *
 * 用法：node tests\e2e-model-patch.mjs
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

async function waitFor(predicate, { timeout = 30000, interval = 150, label = '条件' } = {}) {
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

/** 假的桌面端补丁层：结构要和真实文件一致（llm-pi-ai 里套 providers，另一个条目放 agent-default-model） */
function desktopLayer(provider, model) {
  return `# 测试用的桌面端补丁层
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ${provider}:
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: ${model}
            name: ${model}
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ${provider}
    model: ${model}
    reasoningEffort: max
`;
}

/** 假 dsh：把 argv 追加到文件，然后吐一行 session + 一行 final */
const FAKE_DSH = `import fs from 'node:fs';
const out = process.env.FAKE_DSH_ARGV;
const argv = process.argv.slice(2);
if (out) fs.appendFileSync(out, JSON.stringify(argv) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-fake-model' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

function readArgvLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 从 argv 里数出 --patch 指向的文件，并按顺序返回 */
function patchArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--patch' && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-model-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const stateDir = path.join(tmpRoot, 'state');
  const logDir = path.join(tmpRoot, 'logs');
  const patchesDir = path.join(tmpRoot, 'patches');
  const argvFile = path.join(tmpRoot, 'dsh-argv.jsonl');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.mkdir(patchesDir, { recursive: true });

  // 假家目录 + 桌面端补丁层
  const layerPath = path.join(tmpHome, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  await fsp.mkdir(path.dirname(layerPath), { recursive: true });
  await fsp.writeFile(layerPath, desktopLayer('fake-provider', 'fake-model'), 'utf8');

  // 基础 patch + 假 dsh
  const basePatch = path.join(patchesDir, 'headless-model.yml');
  await fsp.writeFile(basePatch, '- id: agent-default-model\n  config:\n    provider: base-provider\n    model: base-model\n', 'utf8');
  const fakeDsh = path.join(tmpRoot, 'fake-dsh.mjs');
  await fsp.writeFile(fakeDsh, FAKE_DSH, 'utf8');

  const napcat = createFakeNapCat();
  const port = await napcat.listen(0);

  const configPath = path.join(tmpRoot, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
    dsh: {
      command: fakeDsh,
      mode: 'headless',
      companion: false,
      profile: 'headless',
      patchPath: basePatch,
      cwd: tmpRoot,
      timeoutMs: 60000,
    },
    security: { allowFrom: [ALLOWED_USER], adminUserIds: [ALLOWED_USER], allowGroups: false, rateLimitPerMinute: 60, maxChars: 4000 },
    behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, wakeWord: '' },
    logDir,
    stateDir,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome, FAKE_DSH_ARGV: argvFile },
  });

  const childOut = [];
  child.stdout.on('data', (c) => childOut.push(c.toString()));
  child.stderr.on('data', (c) => childOut.push(c.toString()));

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  const statusPath = path.join(stateDir, 'status.json');
  const runtimePatch = path.join(stateDir, 'model', 'runtime-model.yml');

  const readStatus = () => {
    try {
      return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
      return null;
    }
  };

  /** 发一条消息，等到「不是心跳」的回复，返回回复文本 */
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
      { timeout: 40000, label: `第 ${messageId} 条消息的回复` },
    );
    return String(call.params.message ?? '');
  }

  try {
    section('1/5 启动与跟随模式');
    await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
    ok('桥接已连接假 NapCat');

    await waitFor(() => fs.existsSync(statusPath), { timeout: 10000, label: 'status.json 生成' });
    const status = await waitFor(() => (readStatus()?.model ? readStatus() : null), {
      timeout: 15000,
      label: 'status.json 带出模型',
    });
    if (status.model === 'fake-provider/fake-model' && status.modelMode === 'follow') {
      ok('启动时就跟上了假桌面端模型', `${status.model} / ${status.modelMode}`);
    } else {
      bad('启动时模型不对', JSON.stringify({ model: status.model, mode: status.modelMode }));
    }
    if (fs.existsSync(runtimePatch)) ok('runtime patch 已生成', runtimePatch);
    else bad('runtime patch 没生成');

    section('2/5 跟随模式的消息真的带上了 runtime patch');
    const reply1 = await sendAndWait('第一条：只回复收到', 201);
    if (reply1.includes('收到')) ok('假 dsh 的回复送达 QQ', `「${reply1.slice(0, 40)}」`);
    else bad('回复内容异常', reply1.slice(0, 80));

    const invocations = await waitFor(() => (readArgvLines(argvFile).length >= 1 ? readArgvLines(argvFile) : null), {
      timeout: 15000,
      label: '假 dsh 被调用',
    });
    const argv1 = invocations[0];
    const patches1 = patchArgs(argv1);
    if (patches1.length === 2) ok('argv 里是两条 --patch（基础 + runtime）', `2 条`);
    else bad('argv 里 --patch 数量不对', JSON.stringify(patches1));
    if (path.resolve(patches1[0] ?? '') === path.resolve(basePatch)) ok('第一条是基础 patch');
    else bad('第一条不是基础 patch', patches1[0]);
    if (patches1[1] && path.resolve(patches1[1]) === path.resolve(runtimePatch)) ok('第二条是 runtime patch');
    else bad('第二条不是 runtime patch', String(patches1[1]));

    const patchBody1 = fs.readFileSync(runtimePatch, 'utf8');
    if (patchBody1.includes('provider: fake-provider') && patchBody1.includes('model: fake-model')) {
      ok('runtime patch 里是桌面端的模型');
    } else {
      bad('runtime patch 里不是桌面端模型', patchBody1.slice(0, 160));
    }
    if (argv1.includes('--json') && argv1.includes('--profile') && argv1.includes('headless')) {
      ok('argv 里的 profile / --json 正常');
    } else {
      bad('argv 结构异常', JSON.stringify(argv1.slice(0, 6)));
    }

    section('3/5 手动模式优先于桌面端');
    await fsp.mkdir(path.join(stateDir, 'model'), { recursive: true });
    await fsp.writeFile(
      path.join(stateDir, 'model', 'model.json'),
      `${JSON.stringify({
        mode: 'manual',
        manual: { provider: 'manual-provider', model: 'manual-model', reasoningEffort: 'high' },
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );

    const reply2 = await sendAndWait('第二条：还是只回复收到', 202);
    if (reply2.includes('收到')) ok('手动模式下照常回复');
    else bad('手动模式下回复异常', reply2.slice(0, 80));

    const invocations2 = await waitFor(() => (readArgvLines(argvFile).length >= 2 ? readArgvLines(argvFile) : null), {
      timeout: 15000,
      label: '第二次调用假 dsh',
    });
    const argv2 = invocations2[1];
    const body2 = fs.readFileSync(runtimePatch, 'utf8');
    if (body2.includes('provider: manual-provider') && body2.includes('model: manual-model') && body2.includes('reasoningEffort: high')) {
      ok('runtime patch 换成了手动模型');
    } else {
      bad('runtime patch 没换手动模型', body2.slice(0, 200));
    }
    if (patchArgs(argv2).length === 2) ok('手动模式仍是两条 --patch');
    else bad('手动模式 --patch 数量异常', JSON.stringify(patchArgs(argv2)));
    const status2 = await waitFor(() => (readStatus()?.model === 'manual-provider/manual-model' ? readStatus() : null), {
      timeout: 10000,
      label: 'status.json 更新为手动模型',
    });
    ok('status.json 同步成手动模型', `${status2.model} / ${status2.modelMode}`);

    section('4/5 切回跟随 + 桌面端换模型 → 下一条消息立刻跟上（不用重启）');
    await fsp.writeFile(
      path.join(stateDir, 'model', 'model.json'),
      `${JSON.stringify({ mode: 'follow', manual: null, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    // 模拟用户在桌面端把模型换成了另一个：改的就是那张补丁层
    await fsp.writeFile(layerPath, desktopLayer('next-provider', 'next-model'), 'utf8');

    const reply4 = await sendAndWait('第四条：桌面端换模型后只回复收到', 204);
    if (reply4.includes('收到')) ok('换模型后照常回复');
    else bad('换模型后回复异常', reply4.slice(0, 80));

    const invocations4 = await waitFor(() => (readArgvLines(argvFile).length >= 3 ? readArgvLines(argvFile) : null), {
      timeout: 15000,
      label: '第四次调用假 dsh',
    });
    const body4 = fs.readFileSync(runtimePatch, 'utf8');
    if (body4.includes('provider: next-provider') && body4.includes('model: next-model')) {
      ok('runtime patch 自动跟上了新模型', 'next-provider/next-model');
    } else {
      bad('runtime patch 没跟上新模型', body4.slice(-200));
    }
    if (patchArgs(invocations4[2]).length === 2) ok('跟随新模型时仍是两条 --patch');
    else bad('跟随新模型时 --patch 数量异常', JSON.stringify(patchArgs(invocations4[2])));
    const status3 = await waitFor(() => (readStatus()?.model === 'next-provider/next-model' ? readStatus() : null), {
      timeout: 10000,
      label: 'status.json 跟上新模型',
    });
    ok('status.json 也更新了', `${status3.model} / ${status3.modelMode}`);

    section('5/5 桌面端补丁层消失 → 兜底但不影响回消息');
    await fsp.rm(layerPath, { force: true });
    const reply3 = await sendAndWait('第五条：补丁层没了也要回复', 203);
    if (reply3.includes('收到')) ok('没有桌面端补丁层也能正常回复');
    else bad('没有补丁层时回复异常', reply3.slice(0, 80));

    const invocations3 = await waitFor(() => (readArgvLines(argvFile).length >= 4 ? readArgvLines(argvFile) : null), {
      timeout: 15000,
      label: '第三次调用假 dsh',
    });
    const patches3 = patchArgs(invocations3[3]);
    if (patches3.length === 1) ok('兜底时只剩基础 patch', `1 条`);
    else bad('兜底时 --patch 数量不对', JSON.stringify(patches3));
    if (patchArgs(invocations3[3])[0] && path.resolve(patchArgs(invocations3[3])[0]) === path.resolve(basePatch)) {
      ok('兜底用的是基础 patch');
    } else {
      bad('兜底时第一条不是基础 patch');
    }
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
    const tail = childOut.join('').split('\n').slice(-25).join('\n');
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
