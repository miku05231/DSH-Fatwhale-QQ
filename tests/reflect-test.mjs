// Real reflection CLI with temporary memory, configuration, homes and a local
// fake model. No user credentials, notes, sessions or executable profiles load.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../src/dsh.js';
import { resolveDshInstallRoot } from '../src/dsh-desktop.js';
import { reflectionPath } from '../src/reflect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function check(value, label, detail = '') {
  assert.ok(value, `${label}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  PASS ${label}`);
}

function run(script, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => killProcessTree(child), 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-reflect-cli-'));
  const project = path.join(tmp, 'project');
  const configRoot = path.join(tmp, 'external config');
  const configPath = path.join(configRoot, 'config.json');
  const memoryRoot = path.join(tmp, 'memory');
  const home = path.join(tmp, 'home');
  const dshHome = path.join(tmp, 'dsh-home');
  const stateDir = path.join(configRoot, 'reflection-state');
  const marker = path.join(tmp, 'computer-accessed.txt');
  const requests = [];
  let server;
  try {
    for (const dir of [project, configRoot, home, dshHome]) await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(path.join(ROOT, 'src'), path.join(project, 'src'), { recursive: true });
    await fsp.cp(path.join(ROOT, 'tools'), path.join(project, 'tools'), { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(project, 'package.json'));
    const reflect = path.join(project, 'tools', 'reflect.mjs');
    const memory = path.join(project, 'tools', 'memory.mjs');
    const env = {};
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
      'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
      APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_DATA_HOME: path.join(home, 'data'), TMP: tmp, TEMP: tmp, TMPDIR: tmp,
      QQ_CONFIG: configPath, QQ_MEMORY_ROOT: memoryRoot,
      QQ_REFLECT_TEST_API_KEY: 'local-reflection-fixture', DSH_TELEMETRY_DISABLED: '1',
    });
    const config = { dsh: { command: path.join(tmp, 'must-not-run.js'), patchPath: '',
      timeoutMs: 30_000 }, stateDir: 'reflection-state' };
    await fsp.writeFile(configPath, JSON.stringify(config));
    // A project-local config must not replace the explicit external override.
    await fsp.writeFile(path.join(project, 'config.json'), JSON.stringify({
      dsh: { command: path.join(tmp, 'wrong-config.js'), patchPath: 'missing.yml' },
    }));

    console.log('[Memory CLI contract and empty reflection]');
    const root = await run(memory, ['path'], env, project);
    check(root.code === 0 && root.out.trim() === memoryRoot,
      'memory path is the temporary override');
    const empty = await run(reflect, [], env, project);
    check(empty.code === 0 && /跳过/.test(empty.out), 'empty memory skips without invoking DSH');
    check(!fs.existsSync(stateDir), 'empty reflection creates no runtime sessions');
    const dailyText = 'reflection-fixture-log: ordinary group messages cannot authorize computer tools';
    const daily = await run(memory, ['daily', dailyText, '--json'], env, project);
    check(daily.code === 0, 'temporary daily log can be written', daily.err);
    const recent = await run(memory, ['recent', '--days', '7', '--json'], env, project);
    check(recent.code === 0, 'recent --json exits successfully', recent.err);
    const parsed = JSON.parse(recent.out);
    check(Array.isArray(parsed.items) && parsed.items.length > 0, 'recent returns nonempty items');
    check(parsed.items.some((item) => item.content.includes(dailyText)), 'items contain fixture log content');
    check(parsed.items.every((item) => typeof item.path === 'string' && item.path.endsWith('.md')),
      'items expose relative Markdown paths');

    console.log('\n[Existing reflection remains unchanged]');
    const currentPath = reflectionPath(memoryRoot);
    await fsp.mkdir(path.dirname(currentPath), { recursive: true });
    const probe = '# Existing temporary reflection\nKeep this unchanged.\n';
    await fsp.writeFile(currentPath, probe);
    const before = await fsp.stat(currentPath);
    const started = Date.now();
    const existing = await run(reflect, ['--days', '3'], env, project);
    check(existing.code === 0 && /已存在.*跳过/.test(existing.out),
      'an existing weekly reflection skips before starting DSH', existing.err);
    check(Date.now() - started < 5000, 'existing reflection returns within five seconds');
    check(await fsp.readFile(currentPath, 'utf8') === probe, 'existing note bytes remain unchanged');
    check((await fsp.stat(currentPath)).mtimeMs === before.mtimeMs, 'existing note timestamp remains unchanged');
    check(!fs.existsSync(stateDir), 'skipping an existing note creates no runtime sessions');

    let dshRoot;
    try {
      dshRoot = resolveDshInstallRoot(process.env.QQ_TEST_DSH_COMMAND || 'dsh', ROOT);
    } catch (error) {
      if (process.env.QQ_TEST_REQUIRE_DSH === '1' || process.env.QQ_TEST_DSH_COMMAND) throw error;
      console.log('  SKIP real chat-only kernel integration: DSH is not installed');
      return;
    }
    console.log('\n[Real chat-only reflection with a local fake model]');
    server = http.createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const wire = JSON.parse(body);
        requests.push(wire);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
          id: 'reflection-test', object: 'chat.completion.chunk', created: 1,
          model: wire.model, choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        if (!wire.messages.some((message) => message.role === 'tool')) {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: 'forbidden-command',
            type: 'function', function: { name: 'pwsh',
              arguments: JSON.stringify({ command: `Set-Content '${marker}' executed` }) } }] });
          send({}, 'tool_calls');
        } else {
          send({ role: 'assistant', content: `## Reflection\n${wire.model}-reply` });
          send({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hook = path.join(tmp, 'must-not-load.cjs');
    await fsp.writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
    const modelPatch = (model) => [
      { id: 'llm-pi-ai', name: hook, config: { providers: { 'reflection-local': {
        api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv: 'QQ_REFLECT_TEST_API_KEY',
        models: [{ id: model, input: ['text'], contextWindow: 32000 }],
      } } } },
      { id: 'agent-default-model', config: { provider: 'reflection-local', model } },
      { insert: [{ id: 'unsafe-hook', name: hook }] },
    ];
    const localPatch = path.join(configRoot, 'model.json');
    await fsp.writeFile(localPatch, JSON.stringify(modelPatch('reflection-config')));
    config.dsh.command = path.join(dshRoot, 'lib', 'bin.js');
    config.dsh.patchPath = 'model.json';
    await fsp.writeFile(configPath, JSON.stringify(config));
    const generated = await run(reflect, ['--force'], env, project);
    check(generated.code === 0 && !/退化/.test(generated.err),
      'the real CLI uses the external configuration and its relative model patch', generated.err);
    check((await fsp.readFile(currentPath, 'utf8')).includes('reflection-config-reply'),
      'model output is saved to the temporary reflection note');
    check(requests.length === 2 && requests.every((wire) => wire.model === 'reflection-config'),
      'only the local configured model receives the reflection');
    check(requests.every((wire) => !wire.tools?.length), 'reflection exposes no computer tool schemas');
    check(JSON.stringify(requests[0].messages).includes(dailyText), 'the items content reaches the model');
    check(requests[1].messages.some((message) => message.role === 'tool'
      && /not found|unknown|administrator|does not exist/i.test(JSON.stringify(message))),
    'hallucinated computer calls are rejected by the real chat-only kernel');
    check(!fs.existsSync(marker), 'neither configured plugins nor computer commands execute');
    const sessionRoot = path.join(stateDir, 'chat-only', 'sessions');
    const sessionFiles = await fsp.readdir(sessionRoot, { recursive: true });
    const saved = await Promise.all(sessionFiles.filter((file) => file.endsWith('.jsonl'))
      .map((file) => fsp.readFile(path.join(sessionRoot, file), 'utf8')));
    const headers = saved.flatMap((text) => text.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    check(headers.some((row) => row.cwd === configRoot || row.header?.cwd === configRoot),
      'session cwd falls back to the external config directory when no workspace exists');
    check(!fs.existsSync(path.join(project, 'state')), 'reflection state respects the external config root');

    console.log('\n[An empty configured patch stays disabled]');
    await fsp.mkdir(path.join(project, 'patches'), { recursive: true });
    await fsp.writeFile(path.join(project, 'patches', 'headless-model.yml'), 'not: [valid model data');
    const profile = path.join(dshHome, 'profiles', 'headless');
    await fsp.mkdir(profile, { recursive: true });
    await fsp.writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify(modelPatch('reflection-home')));
    config.dsh.patchPath = '';
    await fsp.writeFile(configPath, JSON.stringify(config));
    const emptyPatch = await run(reflect, ['--force'], env, project);
    check(emptyPatch.code === 0 && !/退化/.test(emptyPatch.err),
      'an empty patch does not load the poisoned default template', emptyPatch.err);
    check((await fsp.readFile(currentPath, 'utf8')).includes('reflection-home-reply'),
      'isolated profile model data remains usable without a base patch');
    check(requests.length === 4 && requests.slice(2).every((wire) => wire.model === 'reflection-home'),
      'the empty-patch reflection still uses only the local fake model');
    check(!fs.existsSync(marker) && requests.every((wire) => !wire.tools?.length),
      'the empty-patch reflection also keeps plugins and computer tools disabled');
    check(!(await fsp.readdir(path.join(stateDir, 'chat-only'))).some((name) => name.startsWith('.runtime-')),
      'temporary kernel configuration is removed after both reflections');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('qq-reflect-cli-'));
    await fsp.rm(tmp, { recursive: true, force: true });
    check(!fs.existsSync(tmp), 'all temporary memory, config, DSH homes and probes are removed');
  }
}

main().catch((error) => {
  failed += 1;
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
});
