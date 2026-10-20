/**
 * plugins-test.mjs —— 插件宿主（src/plugins.js）的单元测试。
 *
 * 不联网、不碰真实 state：每次在一个临时目录里现写几个插件文件，
 * 然后验证「加载/校验/开关/配置/钩子串联/出错不影响别人」这些行为。
 *
 * 用法：node tests\plugins-test.mjs
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  PluginHost,
  PLUGIN_HOOKS,
  SCHEMA_TYPES,
  mergeConfig,
  coerceValue,
  normalizeMeta,
} from '../src/plugins.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;

function ok(cond, name, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

const FIXTURES = {
  'alpha.js': `export const meta = {
  name: 'alpha',
  displayName: 'Alpha',
  version: '1.2.3',
  description: '改文本 + 加尾巴',
  configSchema: [
    { key: 'suffix', type: 'string', label: '尾巴', default: 'A' },
    { key: 'loud', type: 'bool', label: '大声', default: false },
  ],
};
export async function onMessage(ctx) {
  return { text: ctx.text + '-alpha' };
}
export async function afterReply(ctx) {
  return { text: ctx.text + '[' + ctx.config.suffix + ']' };
}
`,
  'beta.js': `export const meta = { name: 'beta', displayName: 'Beta', version: '0.0.2', description: '拦截 stop' };
export async function onMessage(ctx) {
  // 注意：它拿到的是前面插件改过之后的文本（stop → stop-alpha），所以用前缀匹配
  return ctx.text.startsWith('stop') ? { handled: true } : undefined;
}
export async function afterReply(ctx) {
  return { text: ctx.text + '[B]' };
}
`,
  'gamma.js': `export const meta = { name: 'gamma', displayName: 'Gamma', version: '1.0.0', description: '默认关闭，钩子会抛错', defaultEnabled: false };
export async function onMessage() {
  throw new Error('gamma 故意抛错');
}
`,
  'badname.js': `export const meta = { name: 'not-badname', displayName: '坏名字' };
export async function onMessage() {}
`,
  'nohook.js': `export const meta = { name: 'nohook', displayName: '没钩子' };
`,
  'badschema.js': `export const meta = { name: 'badschema', displayName: '坏 schema', configSchema: [{ key: 'x', type: 'weird' }] };
export async function onMessage() {}
`,
  '_private.js': `export const meta = { name: '_private' };
export async function onMessage() {}
`,
  'notes.txt': '这不是插件\n',
};

async function writePlugins(dir) {
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    await fsp.writeFile(path.join(dir, name), body, 'utf8');
  }
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-plugins-'));
  const dir = path.join(tmpRoot, 'plugins');
  const stateDir = path.join(tmpRoot, 'state');
  await writePlugins(dir);
  await fsp.mkdir(stateDir, { recursive: true });

  const config = { plugins: { alpha: { suffix: '尾巴' } } };
  const host = new PluginHost({ dir, stateDir, config });
  await host.load();

  try {
    section('1 导出与常量');
    eq(PLUGIN_HOOKS, ['onMessage', 'beforeReply', 'afterReply'], '钩子清单');
    eq(SCHEMA_TYPES, ['string', 'text', 'bool', 'int', 'select'], '配置类型清单');

    section('2 加载与元数据校验');
    const names = [...host.registry.keys()].sort();
    eq(names, ['alpha', 'beta', 'gamma'], '只加载合法插件（跳过 _ 前缀与 .txt）');
    eq(host.failures.length, 3, '三个坏插件被记进 failures');
    const failFiles = host.failures.map((f) => f.file).sort();
    eq(failFiles, ['badname.js', 'badschema.js', 'nohook.js'], '失败清单');
    ok(host.failures.some((f) => f.message.includes('不一致')), '名字与文件名不一致会被拒');
    ok(host.failures.some((f) => f.message.includes('type')), '非法 schema 类型会被拒');
    ok(host.failures.some((f) => f.message.includes('钩子')), '没有钩子会被拒');

    section('3 list() 形状（控制台就吃这个）');
    const alphaSummary = host.list().find((p) => p.name === 'alpha');
    eq(alphaSummary.displayName, 'Alpha', 'displayName');
    eq(alphaSummary.version, '1.2.3', 'version');
    eq(alphaSummary.hooks, ['onMessage', 'afterReply'], 'hooks');
    eq(alphaSummary.enabled, true, '默认启用');
    eq(alphaSummary.config, { suffix: '尾巴', loud: false }, '配置已合并默认值与文件值');
    ok(JSON.stringify(alphaSummary).indexOf('function') === -1, 'list() 不含函数，可以 JSON 化');

    section('4 defaultEnabled=false 与开关持久化');
    eq(host.isEnabled('gamma'), false, 'gamma 默认关闭');
    eq(await host.setEnabled('gamma', true), true, '打开 gamma');
    const stateFile = path.join(stateDir, 'plugins.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    eq(saved.gamma.enabled, true, '开关写进了 state/plugins.json');
    const host2 = new PluginHost({ dir, stateDir, config });
    await host2.load();
    eq(host2.isEnabled('gamma'), true, '重新加载后开关还在');
    await host2.setEnabled('gamma', false);
    eq(host2.isEnabled('gamma'), false, '可以再关掉');

    section('5 配置合并与类型收敛');
    eq(mergeConfig([{ key: 'a', type: 'string', default: 'x' }], { a: 5 }), { a: '5' }, 'string 收敛');
    eq(mergeConfig([{ key: 'b', type: 'bool', default: true }], { b: 'false' }), { b: false }, 'bool 认 "false" 字符串');
    eq(mergeConfig([{ key: 'c', type: 'int', default: 3 }], { c: '7.9' }), { c: 7 }, 'int 取整');
    eq(mergeConfig([], { keep: 1 }), { keep: 1 }, 'schema 之外的键也保留');
    eq(coerceValue('int', 'abc', 9), 9, '非法 int 回落默认值');
    ok(normalizeMeta({ name: 'OK' }).error, '大写名字被拒');
    ok(normalizeMeta(null).error, '没有 meta 被拒');

    section('6 onMessage：改写与接管');
    const ctx = { text: 'hello', userId: 1, isGroup: false, reply: async () => {} };
    const rewritten = await host.runMessageHook('onMessage', ctx);
    eq(rewritten.handled, false, '普通消息不接管');
    eq(rewritten.text, 'hello-alpha', 'alpha 改写了文本');

    const stopped = await host.runMessageHook('onMessage', { ...ctx, text: 'stop' });
    eq(stopped.handled, true, 'beta 接管 stop（alpha 之后仍然生效）');

    section('7 关闭的插件不执行、抛错不外溢');
    const ctx2 = { text: 'x' };
    const before = (await host.runMessageHook('onMessage', ctx2)).text;
    eq(before, 'x-alpha', 'gamma 关着，抛错不会发生');
    await host.setEnabled('gamma', true);
    const after = await host.runMessageHook('onMessage', { text: 'x' });
    eq(after.text, 'x-alpha', 'gamma 抛错被吞掉，alpha 的改写仍在');
    await host.setEnabled('gamma', false);

    section('8 afterReply：链式修饰');
    const out = await host.runAfterReply({ text: 'hi' });
    eq(out, 'hi[尾巴][B]', '两个插件按加载顺序串起来');

    section('9 目录不存在也不炸');
    const empty = new PluginHost({ dir: path.join(tmpRoot, 'nope'), stateDir: path.join(tmpRoot, 'state2') });
    await empty.load();
    eq(empty.registry.size, 0, '没有目录时 0 个插件');
    eq(empty.failures, [], '没有目录不算失败');
    eq(await empty.runAfterReply({ text: 'z' }), 'z', '没有插件时原样返回');

    section('10 真实插件目录能被加载');
    const real = new PluginHost({ dir: path.join(PROJECT_ROOT, 'src', 'plugins'), stateDir: path.join(tmpRoot, 'state3'), config: {} });
    await real.load();
    eq(real.failures, [], '项目自带插件没有加载失败');
    ok(real.registry.has('ping'), 'ping 插件在');
    const pingMeta = real.list().find((p) => p.name === 'ping');
    eq(pingMeta.hooks, ['onMessage'], 'ping 只挂 onMessage');
    eq(pingMeta.config, { reply: 'pong 🐟' }, 'ping 的默认回复');
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

await main();
