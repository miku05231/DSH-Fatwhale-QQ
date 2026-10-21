/**
 * Permission boundaries through units, real HTTP, and the real bridge source.
 * All bridge state, models, plugins, QQ services, and uploaded files are fixtures.
 * Chat-only model responses are fixtures; persona reads have a controlled delay.
 * All persona writes and administrator-side QQ actions use the production code.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULTS, loadConfig } from '../src/config.js';
import { computerSessionKey, qqReplyParams, readComputerAccessConfig } from '../src/computer-access.js';
import { isAdministrator, isAllowed } from '../src/security.js';
import { createWebUiServer } from '../src/webui/server.mjs';
import { createFakeNapCat } from './ws-harness.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 123456789;
const MEMBER = 234567891;
const OTHER_ADMIN = 345678912;
const GROUP = 456789123;
const SELF = 10000;
let passed = 0;

function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function writeJson(file, value) {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function request(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function messageText(call) {
  const message = call?.params?.message;
  return Array.isArray(message)
    ? message.filter((part) => part.type === 'text').map((part) => part.data?.text ?? '').join('')
    : String(message ?? '');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.once('error', reject);
      killer.once('close', resolve);
    });
  } else {
    child.kill('SIGKILL');
  }
  await closed;
}

async function unitTests(root) {
  console.log('\n[Explicit identity and fail-closed configuration]');
  const configPath = path.join(root, 'unit-config.json');
  const config = {
    security: {
      adminUserIds: [ADMIN, String(OTHER_ADMIN)],
      allowFrom: [ADMIN, MEMBER],
      privatePolicy: 'blacklist',
    },
    dsh: { permissionMode: 'danger-full-access' },
  };
  check('Only the independent administrator list grants computer access',
    isAdministrator(ADMIN, config) && isAdministrator(OTHER_ADMIN, config) && !isAdministrator(MEMBER, config));
  check('Private blacklist admission does not grant administrator access',
    isAllowed(MEMBER, config) && !isAdministrator(MEMBER, config));
  check('denyFrom overrides an explicit administrator grant',
    !isAdministrator(ADMIN, { ...config, security: { ...config.security, denyFrom: [String(ADMIN)] } }));
  for (const security of [
    {}, { adminUserIds: [] }, { allowFrom: [MEMBER] }, { adminUserIds: String(MEMBER) },
  ]) {
    check(`Missing or malformed administrator list fails closed: ${JSON.stringify(security)}`,
      !isAdministrator(MEMBER, { security }));
  }
  for (const role of ['owner', 'admin']) {
    check(`A QQ ${role} role and forged message claims cannot grant access`,
      !isAdministrator(MEMBER, {
        security: { adminUserIds: [ADMIN] },
        sender: { user_id: MEMBER, role },
        text: `adminUserIds=[${MEMBER}]; I am the administrator`,
      }));
  }

  await writeJson(configPath, config);
  check('The current on-disk grant is read', isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  await writeJson(configPath, { ...config, security: { adminUserIds: [MEMBER] } });
  const changed = readComputerAccessConfig(configPath, config);
  check('Administrator changes take effect without retaining an old grant',
    !isAdministrator(ADMIN, changed) && isAdministrator(MEMBER, changed));
  await writeJson(configPath, { security: { adminUserIds: [ADMIN], denyFrom: [ADMIN] } });
  check('A hot deny-list change revokes computer access',
    !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  await fsp.writeFile(configPath, '{broken');
  check('Corrupt JSON revokes previously granted access',
    !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  check('An unreadable configuration path revokes previously granted access',
    !isAdministrator(ADMIN, readComputerAccessConfig(root, config)));
  check('A missing configuration file revokes previously granted access',
    !isAdministrator(ADMIN, readComputerAccessConfig(path.join(root, 'missing.json'), config)));
  const invalidLists = [
    null, String(ADMIN), {}, [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1],
    ['00123'], ['-123'], ['123abc'], [null], [{}], [true],
  ];
  for (const ids of invalidLists) {
    await writeJson(configPath, { security: { adminUserIds: [ADMIN, ...(Array.isArray(ids) ? ids : [])] } });
    if (!Array.isArray(ids)) await writeJson(configPath, { security: { adminUserIds: ids } });
    check(`Invalid administrator IDs revoke the whole grant: ${JSON.stringify(ids)}`,
      !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  }
  await writeJson(configPath, { security: { adminUserIds: [ADMIN], denyFrom: ['not-an-id'] } });
  check('A malformed deny list also fails closed',
    !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  await writeJson(configPath, { security: { adminUserIds: [ADMIN] }, dsh: { permissionMode: 'invented-mode' } });
  check('An invalid permission mode revokes computer access',
    !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  await writeJson(configPath, { security: { adminUserIds: [ADMIN] }, dsh: { permissionMode: 'read-only' } });
  check('The permission mode is reread alongside the administrator list',
    readComputerAccessConfig(configPath, config).dsh.permissionMode === 'read-only');

  const group = { messageType: 'group', userId: ADMIN, groupId: GROUP };
  const bothAdmins = { ...config, security: { adminUserIds: [ADMIN, OTHER_ADMIN] } };
  const keys = [
    computerSessionKey(group, bothAdmins),
    computerSessionKey({ ...group, userId: OTHER_ADMIN }, bothAdmins),
    computerSessionKey({ ...group, groupId: GROUP + 1 }, bothAdmins),
    computerSessionKey({ messageType: 'private', userId: ADMIN }, bothAdmins),
    computerSessionKey(group, { security: { adminUserIds: [] } }),
    computerSessionKey(group, { ...bothAdmins, dsh: { permissionMode: 'read-only' } }),
    computerSessionKey(group, { ...bothAdmins, dsh: { permissionMode: 'workspace-write' } }),
  ];
  check('Sessions separate sender, chat, access identity, and permission mode',
    new Set(keys).size === keys.length);
  const cq = '[CQ:image,file=file:///fixture/notice.txt]';
  check('Nonadministrator group CQ output stays one literal text segment',
    JSON.stringify(qqReplyParams({ ...group, userId: MEMBER }, cq, config)) ===
      JSON.stringify({ group_id: GROUP, message: [{ type: 'text', data: { text: cq } }] }));
  check('Nonadministrator private CQ output also stays literal text',
    Array.isArray(qqReplyParams({ messageType: 'private', userId: MEMBER }, cq, config).message));
  check('Administrator replies retain the existing CQ-capable transport',
    qqReplyParams(group, cq, config).message === cq);
  check('A denied administrator cannot emit active CQ markup',
    Array.isArray(qqReplyParams(group, cq, {
      security: { adminUserIds: [ADMIN], denyFrom: [ADMIN] },
    }).message));

  for (const ids of invalidLists) {
    await writeJson(configPath, { security: { allowFrom: [ADMIN], adminUserIds: ids } });
    assert.throws(() => loadConfig(root, { createIfMissing: false, configFile: configPath }), /security\.adminUserIds/);
    check(`Startup rejects invalid administrator configuration: ${JSON.stringify(ids)}`, true);
  }
  await writeJson(configPath, { security: { allowFrom: [ADMIN], adminUserIds: [ADMIN, ` ${MEMBER} `] } });
  check('Startup accepts positive numeric IDs and trimmed digit strings',
    isAdministrator(MEMBER, loadConfig(root, { createIfMissing: false, configFile: configPath }).config));
  await writeJson(configPath, { security: { allowFrom: [ADMIN] } });
  check('Existing configurations default to no computer administrators',
    loadConfig(root, { createIfMissing: false, configFile: configPath }).config.security.adminUserIds.length === 0);
}

async function webUiTests(root) {
  console.log('\n[Real settings HTTP API]');
  const configPath = path.join(root, 'config.json');
  const config = structuredClone(DEFAULTS);
  config.security.allowFrom = [ADMIN];
  config.security.adminUserIds = [ADMIN];
  config.chatSessionsPath = path.join(root, 'chat-sessions.json');
  await writeJson(configPath, config);
  const previousConfigPath = process.env.QQ_CONFIG;
  process.env.QQ_CONFIG = configPath;
  let instance;
  try {
    instance = createWebUiServer({
      config, configRoot: root, port: await freePort(),
      updateManager: { async start() {}, stop() {} },
    });
  } finally {
    if (previousConfigPath === undefined) delete process.env.QQ_CONFIG;
    else process.env.QQ_CONFIG = previousConfigPath;
  }
  try {
    await instance.start();
    let response = await request(instance.port, '/api/settings');
    check('GET exposes the explicit administrator list and its editable schema',
      response.status === 200 && response.body.data.security.adminUserIds[0] === ADMIN &&
      response.body.data.editable.security.adminUserIds === 'qqIdArray');
    response = await request(instance.port, '/api/settings', {
      method: 'PUT', body: { security: { adminUserIds: [ADMIN, String(MEMBER), ` ${MEMBER} `] } },
    });
    const expected = [String(ADMIN), String(MEMBER)];
    check('PUT normalizes and deduplicates IDs in its response',
      response.status === 200 &&
      JSON.stringify(response.body.data.settings.security.adminUserIds) === JSON.stringify(expected));
    check('The administrator list roundtrips to the actual configuration file',
      JSON.stringify(JSON.parse(await fsp.readFile(configPath, 'utf8')).security.adminUserIds) === JSON.stringify(expected));
    response = await request(instance.port, '/api/settings');
    check('GET reflects the saved administrator list',
      JSON.stringify(response.body.data.security.adminUserIds) === JSON.stringify(expected));
    const beforeInvalid = await fsp.readFile(configPath, 'utf8');
    for (const ids of [null, String(ADMIN), [0], [-1], [1.2], ['123x'], ['00123'], [null], Array(1001).fill(ADMIN)]) {
      response = await request(instance.port, '/api/settings', {
        method: 'PUT', body: { security: { adminUserIds: ids }, behavior: { showErrors: false } },
      });
      check(`Invalid settings input is refused atomically: ${Array.isArray(ids) && ids.length > 1000 ? 'oversized list' : JSON.stringify(ids)}`,
        response.status === 400 && await fsp.readFile(configPath, 'utf8') === beforeInvalid);
    }
    response = await request(instance.port, '/api/settings', {
      method: 'PUT', body: { security: { adminUserIds: [] } },
    });
    check('Saving an empty list intentionally revokes every administrator',
      response.status === 200 && !isAdministrator(ADMIN, readComputerAccessConfig(configPath, config)));
  } finally {
    await instance.stop();
  }
}

const CHAT_ONLY_FIXTURE = `import fs from 'node:fs';
export async function runChatOnlyDsh(text, options = {}) {
  const marker = /CASE:([A-Z_]+)/.exec(text)?.[1] ?? 'UNKNOWN';
  fs.appendFileSync(process.env.ACCESS_CHAT_CALLS, JSON.stringify({
    marker, text, requesterId: options.requesterId, sessionId: options.sessionId,
  }) + '\\n');
  if (marker === 'QUEUE_HOLD') {
    await new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        if (fs.existsSync(process.env.ACCESS_QUEUE_RELEASE)) {
          clearInterval(tick);
          resolve();
        }
      }, 30);
      options.signal?.addEventListener('abort', () => {
        clearInterval(tick);
        reject(new Error('Fixture cancelled'));
      }, { once: true });
    });
  }
  return {
    sessionId: 'chat-' + marker,
    finalText: '[CQ:image,file=' + process.env.ACCESS_NOTICE + '] chat-only:' + marker,
    events: [],
  };
}
`;

const ADMIN_CLI_FIXTURE = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const text = argv.at(-1);
const marker = /CASE:([A-Z_]+)/.exec(text)?.[1] ?? 'UNKNOWN';
const record = (data) => fs.appendFileSync(process.env.ACCESS_ADMIN_CALLS,
  JSON.stringify({ marker, pid: process.pid, ...data }) + '\\n');
record({ phase: 'start', argv, permissionMode: process.env.DSH_PERMISSION_MODE });
if (marker === 'ADMIN_UPLOAD') {
  const contents = fs.readFileSync(process.env.ACCESS_NOTICE, 'utf8');
  const params = {
    group_id: Number(process.env.ACCESS_GROUP),
    file: process.env.ACCESS_NOTICE,
    name: path.basename(process.env.ACCESS_NOTICE),
  };
  const child = spawn(process.execPath, [
    process.env.ACCESS_QQ_TOOL, '--config', process.env.QQ_CONFIG,
    'upload_group_file', JSON.stringify(params),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error('Fixture QQ upload failed: ' + output);
  record({ phase: 'uploaded', contents, output });
}
if (marker === 'RUN_REVOKE' || marker === 'RUN_DOWNGRADE') {
  await new Promise((resolve) => setTimeout(resolve, 12000));
  fs.writeFileSync(path.join(process.env.ACCESS_FIXTURE_ROOT, 'finished-' + marker), 'completed');
}
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'admin-' + marker }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: 'admin-result:' + marker }) + '\\n');
`;

const PLUGIN_FIXTURE = `import fs from 'node:fs';
export const meta = { name: 'access', defaultEnabled: true };
function record(hook, ctx) {
  const marker = /CASE:([A-Z_]+)/.exec(ctx.text)?.[1] ?? 'UNKNOWN';
  fs.appendFileSync(process.env.ACCESS_PLUGIN_CALLS, JSON.stringify({
    hook, marker, userId: ctx.userId, canUseComputer: ctx.canUseComputer,
  }) + '\\n');
}
export async function onMessage(ctx) {
  record('onMessage', ctx);
  if (ctx.text.includes('CASE:PLUGIN_ONLY')) {
    await ctx.reply('plugin-only-result');
    return { handled: true };
  }
}
export async function beforeReply(ctx) { record('beforeReply', ctx); }
export async function afterReply(ctx) { record('afterReply', ctx); }
`;

function personaReadBarrier(originalUrl) {
  return `import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { listPersonas as realListPersonas } from ${JSON.stringify(originalUrl)};
export * from ${JSON.stringify(originalUrl)};
export async function listPersonas(...args) {
  const items = await realListPersonas(...args);
  let token;
  try { token = fs.readFileSync(process.env.ACCESS_PERSONA_GATE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return items;
    throw error;
  }
  fs.writeFileSync(process.env.ACCESS_PERSONA_ENTERED, token);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(process.env.ACCESS_PERSONA_RELEASE, 'utf8') === token) return items;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('Persona read barrier timed out');
}
`;
}

async function bridgeTests(root) {
  console.log('\n[Actual bridge routing with temporary QQ and desktop fixtures]');
  const bridgeRoot = path.join(root, 'bridge');
  await fsp.mkdir(bridgeRoot);
  // A byte-for-byte source snapshot keeps even the boot logger in the fixture.
  await fsp.cp(path.join(PROJECT_ROOT, 'src'), path.join(bridgeRoot, 'src'), { recursive: true });
  await writeJson(path.join(bridgeRoot, 'package.json'), { type: 'module' });
  const fixtureHome = path.join(bridgeRoot, 'home');
  const noticePath = path.join(fixtureHome, 'Desktop', 'notice.txt');
  await fsp.mkdir(path.dirname(noticePath), { recursive: true });
  await fsp.writeFile(noticePath, 'Temporary desktop notice: permission fixture only.');
  const adminCalls = path.join(bridgeRoot, 'admin-calls.jsonl');
  const chatCalls = path.join(bridgeRoot, 'chat-calls.jsonl');
  const pluginCalls = path.join(bridgeRoot, 'plugin-calls.jsonl');
  const releasePath = path.join(bridgeRoot, 'queue-release');
  const fakeDsh = path.join(bridgeRoot, 'fake-admin-cli.mjs');
  const fakeChat = path.join(bridgeRoot, 'fake-chat-only.mjs');
  const loaderPath = path.join(bridgeRoot, 'chat-loader.mjs');
  const personaBarrierPath = path.join(bridgeRoot, 'persona-read-barrier.mjs');
  const personaGate = path.join(bridgeRoot, 'persona-gate');
  const personaEntered = path.join(bridgeRoot, 'persona-entered');
  const personaRelease = path.join(bridgeRoot, 'persona-release');
  const personaModuleUrl = pathToFileURL(path.join(bridgeRoot, 'src', 'personas.js')).href;
  const pluginDir = path.join(bridgeRoot, 'plugins');
  const patchPath = path.join(bridgeRoot, 'base.yml');
  await fsp.mkdir(pluginDir);
  await fsp.writeFile(fakeDsh, ADMIN_CLI_FIXTURE);
  await fsp.writeFile(fakeChat, CHAT_ONLY_FIXTURE);
  await fsp.writeFile(personaBarrierPath, personaReadBarrier(personaModuleUrl));
  await fsp.writeFile(path.join(pluginDir, 'access.js'), PLUGIN_FIXTURE);
  await fsp.writeFile(patchPath, '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture\n');
  await fsp.writeFile(loaderPath, `const original = ${JSON.stringify(pathToFileURL(path.join(bridgeRoot, 'src', 'chat-only.js')).href)};
const replacement = ${JSON.stringify(pathToFileURL(fakeChat).href)};
const entry = ${JSON.stringify(pathToFileURL(path.join(bridgeRoot, 'src', 'index.js')).href)};
const personas = ${JSON.stringify(personaModuleUrl)};
const personaBarrier = ${JSON.stringify(pathToFileURL(personaBarrierPath).href)};
export async function resolve(specifier, context, nextResolve) {
  const requested = context.parentURL ? new URL(specifier, context.parentURL).href : '';
  if (requested === original) {
    return { url: replacement, shortCircuit: true };
  }
  if (context.parentURL === entry && requested === personas) {
    return { url: personaBarrier, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  const napcat = createFakeNapCat({
    onCall(call) { call.reply(call.action === 'upload_group_file' ? { file_id: 'fixture-upload' } : null); },
  });
  const port = await napcat.listen();
  const configPath = path.join(bridgeRoot, 'config.json');
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}`, accessToken: '' },
    dsh: {
      command: fakeDsh, mode: 'headless', companion: false, profile: 'headless',
      cwd: bridgeRoot, patchPath, timeoutMs: 30000, permissionMode: 'danger-full-access',
    },
    security: {
      adminUserIds: [ADMIN], allowFrom: [ADMIN], privatePolicy: 'blacklist',
      allowGroups: true, allowGroupIds: [GROUP], allowGroupMembers: true,
      rateLimitPerMinute: 0, maxChars: 4000,
    },
    behavior: { queuedNotice: 'fixture-queued', maxReplyChunk: 1200, showErrors: true, groupContextCount: 0 },
    plugins: { enabled: true, dir: pluginDir },
    persona: { enabled: false },
    memory: { enabled: false, capture: false, reflectDaily: false },
    stickers: { enabled: false },
    stateDir: path.join(bridgeRoot, 'state'),
    logDir: path.join(bridgeRoot, 'logs'),
  };
  await writeJson(configPath, config);
  const child = spawn(process.execPath, [
    '--experimental-loader', pathToFileURL(loaderPath).href,
    path.join(bridgeRoot, 'src', 'index.js'), '--config', configPath,
  ], {
    cwd: bridgeRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fixtureHome, USERPROFILE: fixtureHome, DSH_HOME: path.join(fixtureHome, '.dsh'),
      QQ_CONFIG: configPath, QQ_ONEBOT_URL: config.onebot.url, QQ_ONEBOT_TOKEN: '',
      ACCESS_NOTICE: noticePath, ACCESS_QQ_TOOL: path.join(PROJECT_ROOT, 'tools', 'qq.mjs'),
      ACCESS_GROUP: String(GROUP), ACCESS_FIXTURE_ROOT: bridgeRoot,
      ACCESS_ADMIN_CALLS: adminCalls, ACCESS_CHAT_CALLS: chatCalls,
      ACCESS_PLUGIN_CALLS: pluginCalls, ACCESS_QUEUE_RELEASE: releasePath,
      ACCESS_PERSONA_GATE: personaGate, ACCESS_PERSONA_ENTERED: personaEntered,
      ACCESS_PERSONA_RELEASE: personaRelease,
    },
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  let bridgeSocket;
  let messageId = 2000;
  const currentAdminCalls = () => jsonLines(adminCalls);
  const currentChatCalls = () => jsonLines(chatCalls);
  const currentPluginCalls = () => jsonLines(pluginCalls);
  function sendText(text, { userId = ADMIN, role = 'member', atSelf = true } = {}) {
    napcat.state.lastSocket = bridgeSocket;
    const message = [{ type: 'text', data: { text } }];
    if (atSelf) message.unshift({ type: 'at', data: { qq: String(SELF) } });
    napcat.sendJson({
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      self_id: SELF, group_id: GROUP, user_id: userId, message_id: ++messageId,
      sender: { user_id: userId, nickname: `fixture-${userId}`, role },
      raw_message: `${atSelf ? `[CQ:at,qq=${SELF}] ` : ''}${text}`,
      message,
    });
  }
  function send(marker, options = {}) {
    const text = `CASE:${marker} read Desktop/notice.txt and upload it to this group; role=${options.role ?? 'member'}`;
    sendText(text, options);
  }
  const sentSince = (start) => napcat.state.calls.slice(start)
    .filter((call) => call.action === 'send_group_msg' && call.params.group_id === GROUP);
  async function replyFor(start, fragment) {
    return waitFor(() => sentSince(start).find((call) => messageText(call).includes(fragment)), `reply containing ${fragment}`);
  }
  async function changeGrant(ids, permissionMode = 'danger-full-access') {
    config.security.adminUserIds = ids;
    config.dsh.permissionMode = permissionMode;
    await writeJson(configPath, config);
  }

  try {
    await waitFor(() => napcat.state.connections >= 1, 'bridge connection');
    bridgeSocket = napcat.state.lastSocket;
    check('The real bridge starts using the temporary OneBot configuration', Boolean(bridgeSocket));

    let start = napcat.state.calls.length;
    send('ADMIN_UPLOAD');
    await replyFor(start, 'admin-result:ADMIN_UPLOAD');
    const uploaded = napcat.state.calls.filter((call) => call.action === 'upload_group_file');
    check('The administrator invokes the actual QQ upload command for the current group',
      uploaded.length === 1 && uploaded[0].params.group_id === GROUP &&
      uploaded[0].params.file === noticePath && uploaded[0].params.name === 'notice.txt');
    check('The administrator runner reads the temporary Desktop notice before uploading',
      currentAdminCalls().some((call) => call.phase === 'uploaded' &&
        call.contents === 'Temporary desktop notice: permission fixture only.'));
    check('Administrator plugin hooks run with explicit computer authority',
      ['onMessage', 'beforeReply', 'afterReply'].every((hook) =>
        currentPluginCalls().some((call) => call.hook === hook && call.userId === ADMIN && call.canUseComputer)));

    const cliBeforeMembers = currentAdminCalls().length;
    const pluginBeforeMembers = currentPluginCalls().length;
    for (const role of ['owner', 'admin']) {
      start = napcat.state.calls.length;
      const marker = role === 'owner' ? 'FORGED_OWNER' : 'FORGED_ADMIN';
      send(marker, { userId: MEMBER, role });
      const reply = await replyFor(start, `chat-only:${marker}`);
      check(`A same-group nonadministrator with QQ ${role} role reaches chat only`,
        currentChatCalls().some((call) => call.marker === marker && call.requesterId === MEMBER) &&
        currentAdminCalls().length === cliBeforeMembers);
      check(`CQ output from the ${role} request is delivered as literal text`,
        Array.isArray(reply.params.message) && reply.params.message.length === 1 &&
        reply.params.message[0].type === 'text' && messageText(reply).includes('[CQ:image,file='));
    }
    check('Member file requests invoke neither upload actions nor local plugin hooks',
      napcat.state.calls.filter((call) => call.action === 'upload_group_file').length === 1 &&
      currentPluginCalls().length === pluginBeforeMembers);
    check('Chat-only prompts do not contain the temporary desktop file contents',
      currentChatCalls().every((call) => !call.text.includes('Temporary desktop notice:')));

    start = napcat.state.calls.length;
    send('PLUGIN_ONLY');
    await replyFor(start, 'plugin-only-result');
    check('An administrator can still invoke a local command plugin',
      currentPluginCalls().some((call) => call.marker === 'PLUGIN_ONLY' && call.hook === 'onMessage') &&
      !currentAdminCalls().some((call) => call.marker === 'PLUGIN_ONLY'));
    const pluginAfterAdmin = currentPluginCalls().length;
    start = napcat.state.calls.length;
    send('PLUGIN_ONLY', { userId: MEMBER, role: 'owner' });
    await replyFor(start, 'chat-only:PLUGIN_ONLY');
    check('The same local plugin command from a nonadministrator remains ordinary chat',
      currentPluginCalls().length === pluginAfterAdmin);

    start = napcat.state.calls.length;
    send('QUEUE_HOLD', { userId: MEMBER });
    await waitFor(() => currentChatCalls().some((call) => call.marker === 'QUEUE_HOLD'), 'queue blocker start');
    send('QUEUED_REVOKE');
    await replyFor(start, 'fixture-queued');
    await changeGrant([]);
    await fsp.writeFile(releasePath, 'release');
    const queuedReply = await replyFor(start, 'chat-only:QUEUED_REVOKE');
    check('A request queued as administrator is reclassified after revocation',
      currentChatCalls().some((call) => call.marker === 'QUEUED_REVOKE' && call.requesterId === ADMIN) &&
      !currentAdminCalls().some((call) => call.marker === 'QUEUED_REVOKE'));
    check('A revoked queued request cannot invoke plugins or active CQ output',
      !currentPluginCalls().some((call) => call.marker === 'QUEUED_REVOKE') &&
      Array.isArray(queuedReply.params.message));

    for (const [marker, ids, permissionMode] of [
      ['RUN_REVOKE', [], 'danger-full-access'],
      ['RUN_DOWNGRADE', [ADMIN], 'read-only'],
    ]) {
      await changeGrant([ADMIN]);
      start = napcat.state.calls.length;
      send(marker);
      const running = await waitFor(() => currentAdminCalls().find((call) =>
        call.marker === marker && call.phase === 'start'), `${marker} subprocess start`);
      await changeGrant(ids, permissionMode);
      const cancelled = await replyFor(start, '\u7ba1\u7406\u5458\u6743\u9650\u6216\u64cd\u4f5c\u8303\u56f4\u5df2\u53d8\u66f4');
      await waitFor(() => !isAlive(running.pid), `${marker} subprocess termination`);
      check(`${marker}: a running request is terminated after the grant changes`,
        !fs.existsSync(path.join(bridgeRoot, `finished-${marker}`)));
      check(`${marker}: cancellation is text only and suppresses the stale result`,
        Array.isArray(cancelled.params.message) &&
        !sentSince(start).some((call) => messageText(call).includes(`admin-result:${marker}`)));
    }
    start = napcat.state.calls.length;
    send('RESTRICTED_FOLLOWUP');
    await replyFor(start, 'admin-result:RESTRICTED_FOLLOWUP');
    const restricted = currentAdminCalls().find((call) => call.marker === 'RESTRICTED_FOLLOWUP');
    check('The next administrator request uses the freshly downgraded permission mode',
      restricted?.permissionMode === 'read-only' && !restricted.argv.includes('--session-id'));
    const sessionPath = path.join(config.stateDir, 'sessions.json');
    await waitFor(() => fs.existsSync(sessionPath), 'session persistence');
    const sessions = JSON.parse(await fsp.readFile(sessionPath, 'utf8'));
    const adminKey = computerSessionKey({ messageType: 'group', userId: ADMIN, groupId: GROUP }, {
      security: { adminUserIds: [ADMIN] }, dsh: { permissionMode: 'danger-full-access' },
    });
    const memberKey = computerSessionKey({ messageType: 'group', userId: MEMBER, groupId: GROUP }, config);
    const revokedKey = computerSessionKey({ messageType: 'group', userId: ADMIN, groupId: GROUP }, {
      security: { adminUserIds: [] },
    });
    check('Persisted sessions do not mix administrator and ordinary group conversations',
      sessions[adminKey] === 'admin-ADMIN_UPLOAD' && sessions[memberKey]?.startsWith('chat-') &&
      sessions[revokedKey] === 'chat-QUEUED_REVOKE');

    const personaDir = path.join(config.stateDir, 'personas');
    await fsp.mkdir(personaDir, { recursive: true });
    await fsp.writeFile(path.join(personaDir, 'Original.md'), 'Original persona fixture.');
    await fsp.writeFile(path.join(personaDir, 'Candidate.md'), 'Candidate persona fixture.');
    await writeJson(path.join(personaDir, 'active.json'), {
      active: 'Original', chats: { [`g:${GROUP}`]: 'Original' },
    });
    async function personaSnapshot() {
      const files = (await fsp.readdir(personaDir)).sort();
      return JSON.stringify(await Promise.all(files.map(async (name) =>
        [name, (await fsp.readFile(path.join(personaDir, name))).toString('base64')])));
    }
    for (const [action, command] of [
      ['create', '/\u4eba\u683c \u65b0\u5efa Unwanted'],
      ['set-chat', '/\u4eba\u683c Candidate'],
      ['set-global', '/\u4eba\u683c \u5168\u5c40 Candidate'],
      ['reset-chat', '/\u4eba\u683c \u91cd\u7f6e'],
      ['reset-global', '/\u4eba\u683c \u5168\u5c40 \u91cd\u7f6e'],
    ]) {
      await changeGrant([ADMIN]);
      await fsp.writeFile(personaGate, action);
      const before = await personaSnapshot();
      start = napcat.state.calls.length;
      sendText(command, { atSelf: false });
      await waitFor(() => {
        try { return fs.readFileSync(personaEntered, 'utf8') === action; }
        catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      }, `${action} persona read barrier`);
      await changeGrant([]);
      await fsp.writeFile(personaRelease, action);
      const denied = await replyFor(start, '');
      check(`${action}: revocation during persona reads cancels the pending modification`,
        Array.isArray(denied.params.message) &&
        messageText(denied).includes('\u7ba1\u7406\u5458\u6743\u9650\u5df2\u53d8\u66f4'));
      check(`${action}: the actual persona directory remains byte-for-byte unchanged`,
        await personaSnapshot() === before);
    }
    await fsp.rm(personaGate);
    await changeGrant([ADMIN]);
    const currentPersonaState = () => JSON.parse(fs.readFileSync(path.join(personaDir, 'active.json'), 'utf8'));
    for (const [action, command, changed] of [
      ['create', '/\u4eba\u683c \u65b0\u5efa Created',
        () => fs.existsSync(path.join(personaDir, 'Created.md'))],
      ['set-chat', '/\u4eba\u683c Candidate',
        () => currentPersonaState().chats[`g:${GROUP}`] === 'Candidate'],
      ['set-global', '/\u4eba\u683c \u5168\u5c40 Candidate',
        () => currentPersonaState().active === 'Candidate'],
      ['reset-chat', '/\u4eba\u683c \u91cd\u7f6e',
        () => !Object.hasOwn(currentPersonaState().chats, `g:${GROUP}`)],
      ['reset-global', '/\u4eba\u683c \u5168\u5c40 \u91cd\u7f6e',
        () => currentPersonaState().active === ''],
    ]) {
      start = napcat.state.calls.length;
      sendText(command, { atSelf: false });
      await replyFor(start, '');
      check(`${action}: an administrator with an unchanged grant can still modify personas`, changed());
    }
  } catch (error) {
    error.message += `\nBridge output:\n${output.join('').split(/\r?\n/).slice(-35).join('\n')}`;
    throw error;
  } finally {
    await stopTree(child);
    await napcat.close();
  }
}

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-admin-access-'));
try {
  const unitsRoot = path.join(temporary, 'units');
  const webRoot = path.join(temporary, 'web');
  await fsp.mkdir(unitsRoot);
  await fsp.mkdir(webRoot);
  await unitTests(unitsRoot);
  await webUiTests(webRoot);
  await bridgeTests(temporary);
} finally {
  assert.ok(path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  assert.ok(path.basename(temporary).startsWith('qq-admin-access-'));
  await fsp.rm(temporary, { recursive: true, force: true });
}
console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
