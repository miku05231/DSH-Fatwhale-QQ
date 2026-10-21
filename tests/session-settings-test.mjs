// Session duration settings through the real HTTP server and existing UI controls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { DEFAULT_SESSION_WINDOW_MINUTES, isValidSessionWindowMinutes } from '../src/sessions.js';
import { createWebUiServer } from '../src/webui/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60000);
const VALID = [0, 1, 45, 180, MAX_MINUTES];
const INVALID = [null, false, true, '', '180', [], {}, -1, 0.5, MAX_MINUTES + 1];
let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  console.log(`  PASS ${label}`);
  passed += 1;
};

async function request(port, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function httpTests(root) {
  const file = path.join(root, 'config.json');
  const config = {
    security: { allowFrom: [10001] },
    stateDir: 'state', chatSessionsPath: 'state/legacy-sessions.json',
  };
  await fs.writeFile(file, JSON.stringify(config));
  check('The shared default is three hours',
    DEFAULT_SESSION_WINDOW_MINUTES === 180 && DEFAULTS.behavior.sessionWindowMinutes === 180);
  check('Older startup configs gain the default duration',
    loadConfig(root, { configFile: file, createIfMissing: false }).config.behavior.sessionWindowMinutes === 180);
  for (const value of [...INVALID, NaN, Infinity, -Infinity]) {
    check(`Strict validation rejects ${String(value)}`, !isValidSessionWindowMinutes(value));
  }
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const previous = process.env.QQ_CONFIG;
  process.env.QQ_CONFIG = file;
  let server;
  try {
    server = createWebUiServer({
      configRoot: root, config, port,
      updateManager: { async start() {}, stop() {} },
    });
  } finally {
    if (previous === undefined) delete process.env.QQ_CONFIG;
    else process.env.QQ_CONFIG = previous;
  }
  try {
    await server.start();
    let response = await request(server.port, '/api/settings');
    check('GET supplies 180 even when the server receives a legacy raw config',
      response.body.data.behavior.sessionWindowMinutes === 180);
    for (const value of VALID) {
      response = await request(server.port, '/api/settings', 'PUT', { behavior: { sessionWindowMinutes: value } });
      check(`HTTP saves the exact numeric duration ${value}`,
        response.status === 200 && response.body.data.settings.behavior.sessionWindowMinutes === value);
      check(`Startup reload preserves duration ${value}`,
        loadConfig(root, { configFile: file, createIfMissing: false }).config.behavior.sessionWindowMinutes === value);
    }
    const diskBefore = await fs.readFile(file, 'utf8');
    const memoryBefore = JSON.stringify(config);
    for (const value of INVALID) {
      response = await request(server.port, '/api/settings', 'PUT', {
        behavior: { sessionWindowMinutes: value, showErrors: false },
      });
      check(`HTTP rejects ${JSON.stringify(value)} before changing any settings`,
        response.status === 400 && await fs.readFile(file, 'utf8') === diskBefore &&
        JSON.stringify(config) === memoryBefore);
    }
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    const groupKey = 'g:20001:u:10001:admin:danger-full-access:v1';
    await fs.writeFile(path.join(root, 'state', 'sessions.json'), JSON.stringify({
      [groupKey]: { sessionId: 'session-group', startedAt: 1000 },
      'p:10002:u:10002:chat:v1': 'session-legacy',
    }));
    response = await request(server.port, '/api/sessions');
    const items = response.body.data.items;
    const group = items.find((item) => item.qq === groupKey);
    check('Structured group mappings retain their string ID and group label',
      group?.sessionId === 'session-group' && group.kind === 'group');
    check('Legacy string session mappings still render',
      items.some((item) => item.sessionId === 'session-legacy'));
    response = await request(server.port, `/api/sessions/${encodeURIComponent(groupKey)}`, 'DELETE');
    check('Structured group mappings can still be manually cleared', response.status === 200);
    response = await request(server.port, '/api/sessions');
    check('Clearing the group leaves other mappings intact',
      response.body.data.items.length === 1 && response.body.data.items[0].sessionId === 'session-legacy');
  } finally {
    await server.stop();
  }
}

async function uiTests() {
  const elements = new Map();
  const events = new Map();
  for (const id of [
    'settingsSave', 'setSessionWindowMinutes', 'setAdminUserIds', 'setShowErrors',
    'setGroupContext', 'setWakeWord', 'setWakeAnywhere', 'setAllowGroupMembers',
    'setAllowGroups', 'setPrivatePolicy', 'setAllowFrom', 'setDenyFrom',
    'setAllowGroupIds', 'setDenyGroupIds',
  ]) {
    elements.set(`#${id}`, {
      value: '', checked: false, disabled: false, textContent: '',
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      addEventListener(type, callback) { events.set(`${id}:${type}`, callback); },
    });
  }
  const calls = [];
  let stored = 180;
  const document = {
    readyState: 'loading', activeElement: null,
    querySelector: (selector) => elements.get(selector) ?? null,
    querySelectorAll: () => [], addEventListener() {},
  };
  const context = vm.createContext({
    document, console, URLSearchParams,
    window: { addEventListener() {} },
    fetch: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      if (options.method === 'PUT') stored = JSON.parse(options.body).behavior.sessionWindowMinutes;
      return { status: 200, async json() {
        return { ok: true, data: {
          behavior: { sessionWindowMinutes: stored }, security: {},
          applied: { 'behavior.sessionWindowMinutes': stored },
        } };
      } };
    },
  });
  vm.runInContext(await fs.readFile(path.join(ROOT, 'src/webui/public/app.js'), 'utf8'), context);
  context.initEvents();
  check('The existing settings save button is wired', typeof events.get('settingsSave:click') === 'function');
  const control = elements.get('#setSessionWindowMinutes');
  for (const value of VALID) {
    stored = value;
    await context.loadSettings();
    check(`UI loads duration ${value} without replacing zero`, control.valueAsNumber === value);
    await events.get('settingsSave:click')();
    const last = calls.filter((call) => call.options.method === 'PUT').at(-1);
    check(`UI sends duration ${value} as a number`,
      JSON.parse(last.options.body).behavior.sessionWindowMinutes === value);
  }
  control.value = '45';
  document.activeElement = control;
  stored = 180;
  await context.loadSettings();
  check('Refreshing preserves the duration currently being edited', control.value === '45');
  document.activeElement = null;
  for (const value of ['', '-1', '0.5', 'Infinity', String(MAX_MINUTES + 1)]) {
    control.value = value;
    const count = calls.length;
    await events.get('settingsSave:click')();
    check(`UI refuses invalid duration ${JSON.stringify(value)} before HTTP`, calls.length === count);
  }
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-session-settings-'));
try {
  await httpTests(temporary);
  await uiTests();
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-session-settings-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`\nPassed ${passed} session settings checks.`);
