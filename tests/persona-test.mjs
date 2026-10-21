/**
 * persona-test.mjs —— 自定义人格 / 记忆库 / 工作区路径（回归用）。
 *
 * 三件事一起验：
 *   1. 纯函数：`~`、`%VAR%`、相对/绝对路径的解析
 *   2. PersonaLoader：读文件、按 mtime 缓存、缺失/停用/截断、以及「人格就是工作区
 *      AGENTS.md 时不重复注入」（DSH 自己会读那个文件）
 *   3. 真桥接 + 假 dsh：配置里把三条路径全指到临时目录，断言 prompt 里有
 *      `[人格设定]`、dsh 的 cwd 真是配置的工作区、记忆库落在配置的根目录
 *
 * 用法：node tests\persona-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFakeNapCat } from './ws-harness.mjs';
import {
  DEFAULT_PERSONA_PATH,
  PersonaLoader,
  expandPath,
  resolveMemoryRoot,
  resolvePersonaPath,
  resolveWorkspace,
} from '../src/persona.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const OWNER = 1000000002;

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

function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(name, String(actual));
  else bad(name, `期望 ${b}，实际 ${a}`);
}

function section(title) {
  console.log(`\n[${title}]`);
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

function killTree(pid) {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

const FAKE_DSH = `import fs from 'node:fs';
const out = process.env.FAKE_DSH_OUT;
if (out) fs.appendFileSync(out, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-persona' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到' }) + '\\n');
`;

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-persona-'));
  const home = path.join(tmpRoot, 'home');
  const ws = path.join(tmpRoot, 'my-workspace');
  const memoryRoot = path.join(tmpRoot, 'my-memory');
  const personaDir = path.join(tmpRoot, 'persona');
  const personaFile = path.join(personaDir, 'custom-persona.md');
  await fsp.mkdir(ws, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(personaDir, { recursive: true });

  try {
    section('1/3 路径解析（~ / %VAR% / 相对 / 绝对）');
    process.env.QQBRIDGE_TEST_HOME = 'D:\\fake-home';
    eq(expandPath('~', { homedir: 'C:\\Users\\u' }), 'C:\\Users\\u', '~ 展开成主目录');
    eq(expandPath('~\\docs\\a.md', { homedir: 'C:\\Users\\u' }), 'C:\\Users\\u\\docs\\a.md', '~\\ 开头的路径');
    eq(expandPath('%QQBRIDGE_TEST_HOME%\\x.md'), 'D:\\fake-home\\x.md', '%VAR% 展开');
    delete process.env.QQBRIDGE_TEST_HOME;

    eq(
      resolvePersonaPath({ configRoot: 'C:\\proj', config: {} }),
      path.resolve('C:\\proj', DEFAULT_PERSONA_PATH),
      '人格默认 qq-workspace\\AGENTS.md',
    );
    eq(
      resolvePersonaPath({ configRoot: 'C:\\proj', config: { persona: { path: 'D:\\p\\a.md' } } }),
      'D:\\p\\a.md',
      '人格绝对路径原样',
    );
    eq(
      resolvePersonaPath({ configRoot: 'C:\\proj', config: { persona: { path: 'persona\\a.md' } } }),
      path.resolve('C:\\proj', 'persona\\a.md'),
      '人格相对路径按项目根',
    );
    eq(resolveMemoryRoot({ configRoot: 'C:\\proj', config: {} }), path.resolve('C:\\proj', '记忆库'), '记忆库默认 记忆库');
    eq(
      resolveMemoryRoot({ configRoot: 'C:\\proj', config: { memory: { root: 'E:\\mem' } } }),
      'E:\\mem',
      '记忆库绝对路径',
    );
    eq(resolveWorkspace({ configRoot: 'C:\\proj', config: {} }), path.resolve('C:\\proj'), '工作区默认项目根');

    section('2/3 PersonaLoader 行为');
    await fsp.writeFile(personaFile, '\uFEFF你是测试人格，说话要短。\n', 'utf8');
    const loader = new PersonaLoader({
      configRoot: tmpRoot,
      config: { persona: { path: personaFile, maxChars: 100 }, dsh: { cwd: ws } },
      dshCwd: ws,
    });
    const first = await loader.load();
    if (first.text.includes('[人格设定]') && first.text.includes('说话要短')) ok('自定义人格被读出来并包装');
    else bad('自定义人格读取失败', first.text.slice(0, 80));
    eq(first.truncated, false, '未超长不截断');
    eq(first.body.startsWith('\uFEFF'), false, 'BOM 被去掉');

    const again = await loader.load();
    if (again.updatedAt === first.updatedAt && again.bytes === first.bytes) ok('文件没变时命中缓存');
    else bad('缓存未命中');

    await fsp.writeFile(personaFile, '\uFEFF换了一份人格：只回一个字。\n', 'utf8');
    const changed = await loader.load();
    if (changed.body.includes('只回一个字')) ok('文件变了会重新读');
    else bad('文件变更未生效', changed.body);

    const short = new PersonaLoader({
      configRoot: tmpRoot,
      config: { persona: { path: personaFile, maxChars: 5 } },
      dshCwd: ws,
    });
    const cut = await short.load();
    if (cut.truncated && cut.body.includes('已截断')) ok('超过 maxChars 会截断并标注');
    else bad('截断未生效', cut.body);

    const missing = await new PersonaLoader({
      configRoot: tmpRoot,
      config: { persona: { path: path.join(tmpRoot, 'nope.md') } },
      dshCwd: ws,
    }).load();
    if (missing.missing && missing.text === '') ok('文件不存在时安全退化为空');
    else bad('缺失文件处理异常', JSON.stringify(missing));

    const disabled = await new PersonaLoader({
      configRoot: tmpRoot,
      config: { persona: { enabled: false, path: personaFile } },
      dshCwd: ws,
    }).load();
    if (disabled.skipped === 'disabled' && disabled.text === '') ok('persona.enabled=false 时跳过');
    else bad('停用未生效', JSON.stringify(disabled));

    await fsp.writeFile(path.join(ws, 'AGENTS.md'), '工作区说明', 'utf8');
    const auto = await new PersonaLoader({
      configRoot: tmpRoot,
      config: { persona: { path: path.join(ws, 'AGENTS.md') } },
      dshCwd: ws,
    }).load();
    if (auto.skipped === 'dsh-auto' && auto.text === '') ok('人格就是工作区 AGENTS.md 时不重复注入');
    else bad('重复注入没有被拦住', JSON.stringify(auto));

    section('3/3 真桥接：自定义人格 + 记忆库 + 工作区');
    const stateDir = path.join(tmpRoot, 'state');
    const logDir = path.join(tmpRoot, 'logs');
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    const outFile = path.join(tmpRoot, 'dsh-calls.jsonl');

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
        dsh: { command: fakeDsh, mode: 'headless', companion: false, profile: 'headless', patchPath: basePatch, cwd: ws, timeoutMs: 60000 },
        persona: { enabled: true, path: personaFile, maxChars: 8000 },
        memory: { enabled: true, root: memoryRoot },
        security: { allowFrom: [OWNER], adminUserIds: [OWNER], allowGroups: false, rateLimitPerMinute: 0, maxChars: 4000 },
        behavior: { queuedNotice: '', maxReplyChunk: 1200, showErrors: true, wakeWord: '' },
        logDir,
        stateDir,
      }, null, 2)}\n`,
      'utf8',
    );

    // 换成固定内容，避免上面截断测试留下的短文本
    await fsp.writeFile(personaFile, '你是测试人格：回答只用一个字。\n', 'utf8');

    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), '--config', configPath], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_DSH_OUT: outFile },
    });
    const childOut = [];
    child.stdout.on('data', (c) => childOut.push(c.toString()));
    child.stderr.on('data', (c) => childOut.push(c.toString()));

    try {
      await waitFor(() => napcat.state.connections >= 1, { timeout: 20000, label: '桥接连上假 NapCat' });
      ok('桥接已连接假 NapCat');

      await waitFor(() => fs.existsSync(path.join(memoryRoot, '大肥鱼.md')), {
        timeout: 20000,
        label: '记忆库在自定义根目录建好',
      });
      ok('记忆库落在配置的根目录', memoryRoot);

      napcat.sendPrivateMessage({ userId: OWNER, text: '在吗', messageId: 901 });
      const call = await waitFor(
        () =>
          napcat.state.calls.find(
            (c) => c.action === 'send_private_msg' && String(c.params?.message ?? '').includes('收到'),
          ),
        { timeout: 30000, label: '收到回复' },
      );
      ok('自定义路径下能正常回复', String(call.params.message).slice(0, 20));

      const records = await waitFor(() => {
        try {
          const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
          return lines.length ? lines.map((l) => JSON.parse(l)) : null;
        } catch {
          return null;
        }
      }, { timeout: 15000, label: '假 dsh 记录调用' });
      const record = records[0];
      eq(path.resolve(record.cwd).toLowerCase(), path.resolve(ws).toLowerCase(), 'dsh 的 cwd 是配置的工作区');
      const prompt = String(record.argv[record.argv.length - 1] ?? '');
      if (prompt.includes('[人格设定]') && prompt.includes('回答只用一个字')) ok('prompt 里注入了自定义人格');
      else bad('prompt 缺少人格块', prompt.slice(0, 120));
      if (prompt.includes('在吗')) ok('原消息还在 prompt 里');
      else bad('prompt 丢了用户消息');
    } finally {
      await killTree(child.pid);
      await napcat.close();
    }
  } catch (err) {
    failed += 1;
    console.log(`\n  ✘ 测试中断：${err?.message ?? err}`);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
