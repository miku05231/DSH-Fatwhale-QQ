/**
 * Decimal sticker settings through startup, normalization, HTTP, and UI controls.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, loadConfig } from '../src/config.js';
import { STICKER_DEFAULTS, normalizeStickerSettings } from '../src/stickers.js';
import { createWebUiServer } from '../src/webui/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALUES = [0, 0.35, 1];
const INVALID_VALUES = [null, false, true, '', '0.35', '1', [], {}, -0.01, 1.01];
let passed = 0;

function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, pathname, { method = 'GET', body, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
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
    req.once('error', reject);
    req.end(data);
  });
}

async function writeConfig(file, stickers) {
  await fsp.writeFile(file, `${JSON.stringify({
    security: { allowFrom: [123456789] },
    memory: { enabled: false, reflectDaily: false },
    stickers,
  }, null, 2)}\n`);
}

function serverFixture(root, config, options = {}) {
  const previous = process.env.QQ_CONFIG;
  process.env.QQ_CONFIG = path.join(root, 'config.json');
  try {
    return createWebUiServer({
      configRoot: root, config,
      updateManager: { async start() {}, stop() {} },
      ...options,
    });
  } finally {
    if (previous === undefined) delete process.env.QQ_CONFIG;
    else process.env.QQ_CONFIG = previous;
  }
}

async function configurationTests(root) {
  console.log('\n[Default and strict decimal validation]');
  const configPath = path.join(root, 'config.json');
  check('Both configuration defaults preserve the original sticker frequency',
    DEFAULTS.stickers.sendProbability === 1 && STICKER_DEFAULTS.sendProbability === 1);
  for (const raw of [undefined, null, [], {}]) {
    check(`Missing sticker settings default to one: ${JSON.stringify(raw)}`,
      normalizeStickerSettings(raw).sendProbability === 1);
  }
  await writeConfig(configPath, {});
  check('Older config files without the new field keep probability one',
    loadConfig(root, { configFile: configPath, createIfMissing: false }).config.stickers.sendProbability === 1);
  for (const value of [...VALUES, 0.125]) {
    check(`Normalization preserves the exact numeric probability ${value}`,
      normalizeStickerSettings({ sendProbability: value }).sendProbability === value);
    await writeConfig(configPath, { sendProbability: value });
    check(`Startup accepts probability ${value} without integer conversion`,
      loadConfig(root, { configFile: configPath, createIfMissing: false }).config.stickers.sendProbability === value);
  }
  for (const value of [...INVALID_VALUES, NaN, Infinity, -Infinity]) {
    check(`Normalization does not coerce invalid probability ${String(value)}`,
      normalizeStickerSettings({ sendProbability: value }).sendProbability === 1);
  }
  for (const value of INVALID_VALUES) {
    await writeConfig(configPath, { sendProbability: value });
    assert.throws(() => loadConfig(root, {
      configFile: configPath, createIfMissing: false,
    }), /stickers\.sendProbability/);
    check(`Startup rejects invalid probability ${JSON.stringify(value)}`, true);
  }
  await fsp.writeFile(configPath, '{"security":{"allowFrom":[123456789]},"stickers":{"sendProbability":1e400}}\n');
  assert.throws(() => loadConfig(root, {
    configFile: configPath, createIfMissing: false,
  }), /stickers\.sendProbability/);
  check('Startup also rejects a JSON numeric overflow', true);
}

async function httpTests(root) {
  console.log('\n[Real GET/PUT settings and immediate sticker snapshots]');
  const configPath = path.join(root, 'config.json');
  await writeConfig(configPath, { root: path.join(root, 'stickers') });
  const config = loadConfig(root, { configFile: configPath, createIfMissing: false }).config;
  const server = serverFixture(root, config, { port: await freePort() });
  try {
    await server.start();
    let response = await request(server.port, '/api/settings');
    check('GET exposes probability one for an older configuration',
      response.status === 200 && response.body.data.stickers.sendProbability === 1);
    check('The editable schema identifies a probability rather than an integer',
      response.body.data.editable.stickers.sendProbability === 'probability');
    response = await request(server.port, '/api/stickers');
    check('The sticker snapshot includes the normalized default probability',
      response.status === 200 && response.body.data.settings.sendProbability === 1);
    for (const value of VALUES) {
      response = await request(server.port, '/api/settings', {
        method: 'PUT', body: { stickers: { sendProbability: value } },
      });
      check(`PUT accepts and returns the numeric probability ${value}`,
        response.status === 200 &&
        response.body.data.applied['stickers.sendProbability'] === value &&
        response.body.data.settings.stickers.sendProbability === value);
      const disk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      check(`The saved probability ${value} roundtrips without truncation`,
        disk.stickers.sendProbability === value &&
        loadConfig(root, { configFile: configPath, createIfMissing: false }).config.stickers.sendProbability === value);
      response = await request(server.port, '/api/settings');
      check(`GET sees the updated probability ${value} without restarting the console`,
        response.body.data.stickers.sendProbability === value);
      response = await request(server.port, '/api/stickers');
      check(`The sticker page sees the updated probability ${value} immediately`,
        response.body.data.settings.sendProbability === value);
    }
    const before = await fsp.readFile(configPath, 'utf8');
    const inMemory = JSON.stringify(config);
    for (const value of INVALID_VALUES) {
      response = await request(server.port, '/api/settings', {
        method: 'PUT', body: { stickers: { sendProbability: value }, behavior: { showErrors: false } },
      });
      check(`Invalid probability is rejected before any setting changes: ${JSON.stringify(value)}`,
        response.status === 400 && await fsp.readFile(configPath, 'utf8') === before &&
        JSON.stringify(config) === inMemory);
    }
    response = await request(server.port, '/api/settings', {
      method: 'PUT', rawBody: '{"stickers":{"sendProbability":1e400},"behavior":{"showErrors":false}}',
    });
    check('A nonfinite JSON number is rejected atomically',
      response.status === 400 && await fsp.readFile(configPath, 'utf8') === before &&
      JSON.stringify(config) === inMemory);
    response = await request(server.port, '/api/settings', {
      method: 'PUT', body: { stickers: { autoTag: false } },
    });
    check('Saving another sticker field preserves the existing probability',
      response.status === 200 && response.body.data.settings.stickers.sendProbability === 1);
  } finally {
    await server.stop();
  }
}

async function uiTests() {
  console.log('\n[Existing UI control behavior]');
  const elements = new Map();
  const events = new Map();
  for (const id of [
    'stickerRoot', 'stickerAutoCollect', 'stickerAutoTag', 'stickerPerMinute',
    'stickerMaxPerMessage', 'stickerSendProbability', 'stickerSendProbabilityValue', 'stickerSave',
  ]) {
    elements.set(`#${id}`, {
      value: '', checked: true, textContent: '', disabled: false,
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      addEventListener(name, callback) { events.set(`${id}:${name}`, callback); },
    });
  }
  const calls = [];
  let storedProbability = 1;
  const document = {
    readyState: 'loading', activeElement: null,
    querySelector: (selector) => elements.get(selector) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = vm.createContext({
    document, console, URLSearchParams,
    window: { addEventListener() {} },
    fetch: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      if (options.method === 'PUT') storedProbability = JSON.parse(options.body).stickers.sendProbability;
      return {
        status: 200,
        async json() {
          return { ok: true, data: {
            settings: { root: 'fixture-stickers', sendProbability: storedProbability, perMinute: 20, maxPerMessage: 3 },
            items: [],
          } };
        },
      };
    },
  });
  const script = await fsp.readFile(path.join(PROJECT_ROOT, 'src', 'webui', 'public', 'app.js'), 'utf8');
  vm.runInContext(script, context);
  context.initEvents();
  const range = elements.get('#stickerSendProbability');
  const output = elements.get('#stickerSendProbabilityValue');
  check('The range input is wired to live numeric feedback', typeof events.get('stickerSendProbability:input') === 'function');
  check('The existing save button handles sticker settings', typeof events.get('stickerSave:click') === 'function');
  for (const value of VALUES) {
    context.fillStickerSettings({ settings: { root: 'fixture-stickers', sendProbability: value } });
    check(`The loaded probability ${value} is visible beside the slider`,
      range.valueAsNumber === value && output.textContent === value.toFixed(2));
    range.value = String(value);
    events.get('stickerSendProbability:input')();
    check(`Moving the slider to ${value} updates its visible numeric value`,
      output.textContent === value.toFixed(2));
    await events.get('stickerSave:click')();
    const sent = calls.filter((call) => call.options.method === 'PUT').at(-1);
    const payload = JSON.parse(sent.options.body);
    check(`Saving the slider sends probability ${value} as a JSON number`,
      typeof payload.stickers.sendProbability === 'number' && payload.stickers.sendProbability === value);
  }
  range.value = '0.35';
  document.activeElement = range;
  context.fillStickerSettings({ settings: { sendProbability: 1 } });
  check('Background rendering preserves a probability while it is being edited',
    range.value === '0.35' && output.textContent === '0.35');
  document.activeElement = null;
  const requestsBefore = calls.length;
  range.value = '';
  await events.get('stickerSave:click')();
  check('An invalid numeric control value is not sent to the API', calls.length === requestsBefore);
}

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-probability-'));
try {
  await configurationTests(temporary);
  await httpTests(temporary);
  await uiTests();
} finally {
  assert.ok(path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  assert.ok(path.basename(temporary).startsWith('qq-sticker-probability-'));
  await fsp.rm(temporary, { recursive: true, force: true });
}
console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
