/**
 * Desktop open requests with injected processes and an isolated HTTP root.
 * No real Explorer, browser, configuration, or QQ services are used.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { openLocalPath, openExternalUrl } from '../src/open-path.js';
import { reflectionPath } from '../src/reflect.js';
import { createWebUiServer } from '../src/webui/server.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

function fakeProcess(event = 'spawn', { stdout = '{"visible":true}', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, child });
    if (event) queueMicrotask(() => {
      child.emit(event, event === 'error' ? new Error('fixture launch failure') : undefined);
      if (event === 'spawn' && args.includes('-File')) {
        child.stdout.emit('data', stdout);
        child.stderr.emit('data', stderr);
        child.emit('close', code);
      }
    });
    return child;
  };
  return { calls, spawnImpl };
}

function openedTarget(call) {
  return call.args[call.args.indexOf('-Target') + 1];
}

const folder = "C:\\fixture \u8868\u60c5 & Bob's $images\\stickers";
const visible = fakeProcess();
await openLocalPath(folder, { platform: 'win32', spawnImpl: visible.spawnImpl });
check('Windows uses the installed PowerShell for explicit Shell visibility', visible.calls[0].command.endsWith('\\powershell.exe')
  && visible.calls[0].args.includes('-Sta'));
check('The static helper path is supplied through File', visible.calls[0].args[visible.calls[0].args.indexOf('-File') + 1]
  .endsWith(`${path.sep}open-path.ps1`));
check('Chinese, spaces, single quotes and dollar signs remain one literal path argument', openedTarget(visible.calls[0]) === folder);
check('Only the helper process is hidden without enabling shell interpolation', visible.calls[0].options.windowsHide === true
  && !visible.calls[0].options.shell);
check('The helper is observed until it confirms a visible window', !visible.calls[0].options.detached
  && !visible.calls[0].child.unreferenced && Array.isArray(visible.calls[0].options.stdio));

const selection = fakeProcess();
const note = `${folder}\\\u53cd\u601d.md`;
await openLocalPath(note, { select: true, platform: 'win32', spawnImpl: selection.spawnImpl });
check('Windows file selection passes its literal path and switch', openedTarget(selection.calls[0]) === note
  && selection.calls[0].args.includes('-SelectFile'));
check('A later child error remains handled', selection.calls[0].child.emit('error', new Error('late fixture error')));

const pending = fakeProcess(null);
let settled = false;
const pendingOpen = openLocalPath(folder, { platform: 'win32', spawnImpl: pending.spawnImpl })
  .then(() => { settled = true; });
await new Promise((resolve) => setImmediate(resolve));
check('The request waits before the helper starts', !settled);
pending.calls[0].child.emit('spawn');
await new Promise((resolve) => setImmediate(resolve));
check('Spawn alone cannot claim that Explorer is visible', !settled);
pending.calls[0].child.stdout.emit('data', '{"visible":true}');
pending.calls[0].child.emit('close', 0);
await pendingOpen;
check('A successful helper exit and visibility confirmation complete the request', settled);

const failure = fakeProcess('error');
await assert.rejects(openLocalPath(folder, { platform: 'win32', spawnImpl: failure.spawnImpl }), /fixture launch failure/);
check('An asynchronous launch error rejects rather than claiming success', !failure.calls[0].child.unreferenced);
await assert.rejects(openLocalPath(folder, {
  platform: 'win32', spawnImpl() { throw new Error('synchronous fixture failure'); },
}), /synchronous fixture failure/);
check('Synchronous launch errors are also returned', true);
for (const [fixture, expected, label] of [
  [fakeProcess('spawn', { code: 1, stderr: 'fixture Shell failure' }), /fixture Shell failure/, 'Nonzero Shell helper exit codes reject'],
  [fakeProcess('spawn', { stdout: '{"visible":false}' }), /not confirmed visible/, 'A hidden window cannot be reported as success'],
  [fakeProcess('spawn', { stdout: '' }), /not confirmed visible/, 'An empty helper response cannot be reported as success'],
  [fakeProcess('spawn', { stdout: 'invalid json' }), /not confirmed visible/, 'Invalid helper output cannot be reported as success'],
]) {
  await assert.rejects(openLocalPath(folder, { platform: 'win32', spawnImpl: fixture.spawnImpl }), expected);
  check(label, true);
}
const hung = fakeProcess(null);
await assert.rejects(openLocalPath(folder, { platform: 'win32', spawnImpl: hung.spawnImpl, timeoutMs: 10 }), /timed out/);
check('A hung visibility check fails and stops only its helper child', hung.calls[0].child.killed);
for (const target of ['', null, 'path\0suffix']) {
  await assert.rejects(openLocalPath(target, { spawnImpl: visible.spawnImpl }), /non-empty/);
}
check('Empty and NUL-containing targets are rejected before spawning', visible.calls.length === 1);

for (const [platform, command, args] of [
  ['darwin', 'open', ['-R', note]],
  ['linux', 'xdg-open', [path.dirname(note)]],
]) {
  const fixture = fakeProcess();
  await openLocalPath(note, { select: true, platform, spawnImpl: fixture.spawnImpl });
  check(`${platform} uses its file manager without a shell`, fixture.calls[0].command === command
    && JSON.stringify(fixture.calls[0].args) === JSON.stringify(args) && !fixture.calls[0].options.shell);
}
const urlOpen = fakeProcess();
await openExternalUrl('obsidian://open?path=fixture', { platform: 'win32', spawnImpl: urlOpen.spawnImpl });
check('Existing URL targets retain the hidden launcher and wait for spawn', urlOpen.calls[0].command === 'cmd.exe'
  && urlOpen.calls[0].options.windowsHide && urlOpen.calls[0].child.unreferenced
  && urlOpen.calls[0].args.at(-1) === 'obsidian://open?path=fixture');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function request(port, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/open', method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-open-path-'));
const memory = path.join(temporary, 'memory');
const workspace = path.join(temporary, 'workspace');
const persona = path.join(temporary, 'persona');
const stickerDir = path.join(temporary, 'custom stickers');
const launchCalls = [];
let launchError = false;
const spawnImpl = (command, args, options) => {
  const fixture = fakeProcess(launchError ? 'error' : 'spawn');
  const child = fixture.spawnImpl(command, args, options);
  launchCalls.push(fixture.calls[0]);
  return child;
};
const instance = createWebUiServer({
  configRoot: temporary,
  config: {
    stateDir: 'state', logDir: 'logs',
    stickers: { root: 'custom stickers' },
    memory: { root: 'memory' }, persona: { path: 'persona/fixture.md' },
    dsh: { cwd: 'workspace' }, napcat: { webuiToken: 'fixture-token' },
  },
  port: await freePort(),
  updateManager: { async start() {}, stop() {} },
  openPath: (target, options) => openLocalPath(target, { ...options, platform: 'win32', spawnImpl }),
  openUrl: (target) => openExternalUrl(target, { platform: 'win32', spawnImpl }),
});

try {
  await instance.start();
  let response = await request(instance.port, { target: 'stickers' });
  check('Opening the sticker library creates the configured folder', response.status === 200
    && response.body.ok && existsSync(stickerDir) && response.body.data.path === stickerDir);
  check('The HTTP handler waits for the explicit Shell visibility check', launchCalls.at(-1).command.endsWith('\\powershell.exe')
    && openedTarget(launchCalls.at(-1)) === stickerDir);

  launchError = true;
  response = await request(instance.port, { target: 'stickers' });
  check('Asynchronous Explorer failure becomes HTTP 500', response.status === 500
    && !response.body.ok && response.body.error.includes('fixture launch failure'));
  launchError = false;
  response = await request(instance.port, { target: 'memory' });
  check('Missing non-sticker directories retain their 404 response', response.status === 404);

  await Promise.all([memory, workspace, persona].map((dir) => mkdir(dir, { recursive: true })));
  for (const [target, expected] of [['memory', memory], ['workspace', workspace], ['persona', persona]]) {
    response = await request(instance.port, { target });
    check(`Existing ${target} folder opening still works`, response.status === 200
      && response.body.data.path === expected && openedTarget(launchCalls.at(-1)) === expected);
  }
  const reflection = reflectionPath(memory);
  await mkdir(path.dirname(reflection), { recursive: true });
  response = await request(instance.port, { target: 'reflection' });
  check('Reflection falls back to its folder before the note exists', response.status === 200
    && !response.body.data.selected && openedTarget(launchCalls.at(-1)) === path.dirname(reflection));
  await writeFile(reflection, '# Fixture\n');
  response = await request(instance.port, { target: 'reflection' });
  check('Reflection selects the existing note', response.status === 200
    && response.body.data.selected && openedTarget(launchCalls.at(-1)) === reflection
    && launchCalls.at(-1).args.includes('-SelectFile'));

  await writeFile(path.join(memory, '\u5927\u80a5\u9c7c.md'), '# Fixture\n');
  response = await request(instance.port, { target: 'memory-obsidian' });
  check('Obsidian opening retains its encoded note URL', response.status === 200
    && launchCalls.at(-1).args.at(-1).startsWith('obsidian://open?path='));
  response = await request(instance.port, { target: 'napcat-webui' });
  check('NapCat opening still carries its token without disclosing it in the response', response.status === 200
    && launchCalls.at(-1).args.at(-1).includes('token=fixture-token')
    && !JSON.stringify(response.body).includes('fixture-token'));
  launchError = true;
  response = await request(instance.port, { target: 'napcat-webui' });
  check('URL launcher errors also become HTTP 500', response.status === 500 && !response.body.ok);
  launchError = false;

  const previousCalls = launchCalls.length;
  response = await request(instance.port, { target: '../arbitrary' });
  check('Unknown targets cannot launch arbitrary paths', response.status === 400 && launchCalls.length === previousCalls);
  response = await request(instance.port, { target: 'stickers' }, 'GET');
  check('Opening still requires POST', response.status === 405 && launchCalls.length === previousCalls);
} finally {
  await instance.stop();
  await rm(temporary, { recursive: true, force: true });
}
console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
