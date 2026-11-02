import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createWebUiLogReader, logLineLimit } from '../src/webui/logs.mjs';
import { createLogView } from '../src/webui/public/logs.js';

async function files(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-log-reader-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('daily logs replace stale console, show appends and rotate without restart', () => files(async (root) => {
  await fs.writeFile(path.join(root, 'bridge-console.log'), 'old fake log\n');
  const file = path.join(root, 'bridge-2026-11-01.log');
  await fs.writeFile(file, '真实日志一\n');
  const read = createWebUiLogReader({ logDir: root, bridgeSource: 'daily' });
  assert.deepEqual((await read('bridge', 10)).lines, ['真实日志一']);
  await fs.appendFile(file, '真实日志二\n');
  assert.deepEqual((await read('bridge', 10)).lines, ['真实日志一', '真实日志二']);
  await fs.writeFile(path.join(root, 'bridge-2026-11-02.log'), 'rotated\n');
  assert.deepEqual((await read('bridge', 10)).lines, ['rotated']);
}));

test('container daily source reports missing instead of reviving fake console', () => files(async (root) => {
  await fs.writeFile(path.join(root, 'bridge-console.log'), 'stale\n');
  await fs.mkdir(path.join(root, 'bridge-9999-99-99.log'));
  const read = createWebUiLogReader({ logDir: root, bridgeSource: 'daily' });
  const result = await read('bridge');
  assert.equal(result.missing, true);
  assert.equal(result.source, 'bridge-daily');
  assert.deepEqual(result.lines, []);
  const compatible = createWebUiLogReader({ logDir: root });
  assert.deepEqual((await compatible('bridge')).lines, ['stale']);
}));

test('tail is bounded, reads UTF-8, honors limit and redacts both sources', () => files(async (root) => {
  await fs.writeFile(path.join(root, 'bridge-2026-11-02.log'), `${'x'.repeat(300_000)}\n一\nsecret=fixture\n三\n`);
  const redact = (line) => line.replace('secret=fixture', 'secret=***');
  const read = createWebUiLogReader({ logDir: root, redact,
    napcatSource: 'webui', readNapcat: async () => ({ lines: ['secret=fixture'], missing: false }) });
  const result = await read('bridge', 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.lines, ['secret=***', '三']);
  assert.deepEqual((await read('napcat', 2)).lines, ['secret=***']);
  assert.equal((await read('napcat')).source, 'napcat-webui');
}));

test('empty files and absent line limit are well-defined', () => files(async (root) => {
  await fs.writeFile(path.join(root, 'bridge-2026-11-02.log'), '');
  const read = createWebUiLogReader({ logDir: root });
  assert.deepEqual((await read('bridge')).lines, []);
  assert.equal(logLineLimit(null), 200);
  assert.equal(logLineLimit(undefined), 200);
  assert.equal(logLineLimit('not-a-number'), 200);
  assert.equal(logLineLimit('3.9'), 3);
  assert.equal(logLineLimit('9999'), 1000);
}));

function viewFixture(api) {
  const timers = new Map();
  const box = { textContent: '', scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
  const status = { textContent: '' };
  let next = 0;
  const state = { name: 'bridge', active: true };
  const view = createLogView({ api, getName: () => state.name, isActive: () => state.active,
    getBox: () => box, getStatus: () => status,
    setTimer: (fn, ms) => { assert.equal(ms, 3000); timers.set(++next, fn); return next; },
    clearTimer: (id) => timers.delete(id), now: () => new Date('2026-11-02T08:00:00Z'),
  });
  return { view, state, box, status, timers };
}

test('polls appended content with one timer and preserves history scroll', async () => {
  let count = 0;
  const fixture = viewFixture(async (_, options) => {
    assert.equal(options.cache, 'no-store');
    return { lines: [`line ${++count}`], source: 'bridge-daily' };
  });
  await fixture.view.refresh();
  assert.equal(fixture.box.textContent, 'line 1');
  assert.equal(fixture.timers.size, 1);
  fixture.box.scrollTop = 20;
  const callback = [...fixture.timers.values()][0];
  callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.box.textContent, 'line 2');
  assert.equal(fixture.box.scrollTop, 20);
  assert.equal(fixture.timers.size, 1);
  fixture.view.stop();
  assert.equal(fixture.timers.size, 0);
});

test('tab switch aborts pending request and ignores an out-of-order response', async () => {
  const pending = [];
  const fixture = viewFixture((url, options) => new Promise((resolve) => pending.push({ url, options, resolve })));
  const first = fixture.view.refresh();
  fixture.state.name = 'napcat';
  const second = fixture.view.refresh();
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ lines: ['new NapCat'] });
  await second;
  pending[0].resolve({ lines: ['old bridge'] });
  await first;
  assert.equal(fixture.box.textContent, 'new NapCat');
  assert.equal(fixture.timers.size, 1);
  fixture.view.stop();
});

test('failures clear old text, missing source explains state, inactive page stops', async () => {
  let error = false;
  const fixture = viewFixture(async () => {
    if (error) throw new Error('synthetic failure');
    return { lines: [], missing: true, message: '等待实时日志' };
  });
  await fixture.view.refresh();
  assert.equal(fixture.box.textContent, '等待实时日志');
  error = true;
  await fixture.view.refresh();
  assert.match(fixture.box.textContent, /synthetic failure/);
  assert.doesNotMatch(fixture.box.textContent, /等待/);
  assert.equal(fixture.timers.size, 1);
  fixture.state.active = false;
  await fixture.view.refresh();
  assert.equal(fixture.timers.size, 0);
});

test('leaving the page discards in-flight content and prevents rescheduling', async () => {
  let complete;
  const fixture = viewFixture(() => new Promise((resolve) => { complete = resolve; }));
  const pending = fixture.view.refresh();
  fixture.state.active = false;
  fixture.view.stop();
  complete({ lines: ['must not render'] });
  await pending;
  assert.doesNotMatch(fixture.box.textContent, /must not render/);
  assert.equal(fixture.timers.size, 0);
});

test('overview uses the shared live bridge log view and keeps its 12-line preview', async () => {
  const app = await fs.readFile(new URL('../src/webui/public/app.js', import.meta.url), 'utf8');
  const overviewStart = app.indexOf('async function loadOverview()');
  const overviewEnd = app.indexOf('/* ---------------------------------------------------------------- 记忆 */', overviewStart);
  assert.ok(overviewStart >= 0 && overviewEnd > overviewStart);
  assert.doesNotMatch(app.slice(overviewStart, overviewEnd), /\/api\/logs/,
    'overview state loading has no separate log fetch');

  const requestStart = app.indexOf('function requestLogs(');
  const requestEnd = app.indexOf('\n}', requestStart) + 2;
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const calls = [];
  const options = { cache: 'no-store' };
  const context = vm.createContext({
    URL,
    STATE: { page: 'overview' },
    window: { location: { href: 'http://127.0.0.1/' } },
    api: (...args) => { calls.push(args); return Promise.resolve({ lines: [] }); },
    options,
  });
  const helper = app.slice(requestStart, requestEnd);
  await vm.runInContext(`${helper}\nrequestLogs('/api/logs?name=bridge&lines=240', options);`, context);
  context.STATE.page = 'system';
  await vm.runInContext(`${helper}\nrequestLogs('/api/logs?name=napcat&lines=240', options);`, context);
  assert.deepEqual(calls.map(([url]) => url), [
    '/api/logs?name=bridge&lines=12',
    '/api/logs?name=napcat&lines=240',
  ]);
  assert.equal(calls[0][1], options, 'the shared view keeps its no-cache and abort options');

  const viewStart = app.indexOf('const logView = createLogView({');
  const viewEnd = app.indexOf('\n});', viewStart) + 4;
  const viewSource = app.slice(viewStart, viewEnd);
  assert.match(viewSource, /STATE\.page === 'overview' \? 'bridge' : STATE\.logName/);
  assert.match(viewSource, /\['overview', 'system'\]\.includes\(STATE\.page\)/);
  assert.match(viewSource, /getBox: \(\) => STATE\.page === 'overview' \? \$\('#overviewLog'\) : \$\('#logBox'\)/);

  const pageStart = app.indexOf('function setPage(');
  const pageEnd = app.indexOf('\nfunction currentPage()', pageStart);
  assert.match(app.slice(pageStart, pageEnd), /if \(name === 'overview'\) void logView\.refresh\(\)/);
  assert.match(app.slice(pageStart, pageEnd), /name !== 'overview' && name !== 'system'\) logView\.stop\(\)/);
  const initStart = app.indexOf('function init()');
  assert.match(app.slice(initStart), /STATE\.page === 'overview' && document\.visibilityState === 'visible'\) void logView\.refresh\(\)/);
  assert.match(app.slice(initStart), /window\.addEventListener\('pagehide', \(\) => logView\.stop\(\)\)/);
});
