import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createPlatformScheduler, parseCron, cronMatches, nextCronRun, normalizeAutomationConfig,
  mergePlatformItems, parseCommentDecision, commentBudget, readBrowserCookies,
} from '../src/platform-scheduler.js';

const date = (day = 22, hour = 9, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);
const dynamic = (id = '100') => ({
  id, key: `dynamic:${id}`, kind: 'dynamic', source: 'dynamic', title: `entry ${id}`,
  text: 'test update', commentOid: `9${id}`, commentType: 17, url: `https://t.bilibili.com/${id}`,
});
const active = (extra = {}) => ({ enabled: true, cron: '0 9 * * *', keywords: ['robot'], targets: ['g:1'], ...extra });
const comments = (extra = {}) => active({
  upUsers: ['42'], keywords: [], commentEnabled: true, commentApproved: true, mentionUid: '77', ...extra,
});

async function fixture(t, config = {}, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-platform-test-'));
  const stateDir = path.join(root, 'state');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(stateDir);
  await fs.writeFile(configPath, JSON.stringify({ sentinel: 'preserved', automation: { bilibili: config } }));
  const calls = { search: [], dynamics: [], pushes: [], posts: [], models: [], logs: [] };
  const state = { time: date(), items: [dynamic()], searchItems: [], pushFailure: new Set() };
  let instance;
  const options = {
    configPath, stateDir, projectRoot: root, now: () => new Date(state.time),
    fetchImpl() { throw new Error('live network forbidden'); },
    cookieExtractor: async () => ({ cookies: { SESSDATA: 'fake-session-secret', bili_jct: 'fake-csrf-secret', ignored: 'discard-me' } }),
    log: { info: value => calls.logs.push(value), warn: value => calls.logs.push(value) },
    sendTarget: async (target, text) => {
      calls.pushes.push({ target, text });
      return !state.pushFailure.has(target);
    },
    generate: async request => {
      calls.models.push(request.kind);
      return request.kind === 'comment' ? { relevant: true, text: 'A useful update.' } : 'Synthetic summary';
    },
    adapterFactory: () => ({
      search: async keyword => { calls.search.push(keyword); return state.searchItems; },
      dynamics: async uid => { calls.dynamics.push(uid); return state.items; },
      validateLogin: async () => ({ uid: '99' }),
      publishComment: async (item, text, uid, { beforePublish } = {}) => {
        assert.equal(typeof beforePublish, 'function', 'a fresh permission check must guard publication');
        const message = `${text} @target `;
        if (!await beforePublish({ message })) return { published: false, cancelled: true, reason: 'bilibili_publication_cancelled' };
        calls.posts.push({ item, text, uid, at: new Date(state.time), message });
        return { published: true, rpid: `8${item.id}`, message };
      },
    }),
    ...overrides,
  };
  const create = extra => createPlatformScheduler({ ...options, ...extra });
  instance = create();
  t.after(async () => { instance.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    root, stateDir, configPath, calls, state, scheduler: instance, create,
    config: async value => fs.writeFile(configPath, JSON.stringify({ sentinel: 'preserved', automation: { bilibili: value } })),
    seed: async value => fs.writeFile(path.join(stateDir, 'bilibili-state.json'), JSON.stringify(value)),
    stored: async () => JSON.parse(await fs.readFile(path.join(stateDir, 'bilibili-state.json'), 'utf8')),
  };
}

test('five-field local cron and conventional day-of-month/day-of-week OR semantics', () => {
  for (const bad of ['', '@daily', '* * * * * *', '0 25 * * *', '0 9 32 * *', '*/0 * * * *']) assert.equal(parseCron(bad), null, bad);
  assert.ok(parseCron('*/15 8-18 * * 1-5'));
  assert.equal(cronMatches('0 9 * * *', date()), true);
  assert.equal(cronMatches('0 9 * * *', date(22, 9, 1)), false);
  assert.equal(cronMatches('0 9 1 * 1', new Date(2026, 9, 26, 9)), true, 'Monday matches even when not first');
  assert.equal(cronMatches('0 9 1 * 1', new Date(2026, 10, 1, 9)), true, 'first matches even when not Monday');
  assert.equal(cronMatches('0 9 1 * 1', new Date(2026, 9, 27, 9)), false);
  assert.equal(nextCronRun('0 9 * * *', date()).getTime(), date(23).getTime());
});

test('automation config rejects coercion, malformed arrays, unsafe IDs and unapproved comments', () => {
  const defaults = normalizeAutomationConfig();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.commentEnabled, false);
  assert.deepEqual(defaults.targets, []);
  const invalid = [
    null, [], { enabled: 'true' }, { keywords: 'robot' }, { keywords: [null] }, { keywords: [''] },
    { upUsers: [42] }, { upUsers: ['0'] }, { upUsers: ['9007199254740992'] },
    { targets: [123] }, { targets: ['g:0'] }, { targets: ['g:9007199254740992'] },
    { mentionUid: '9007199254740992' }, { cron: 'bad' }, { enabled: true },
    comments({ commentApproved: false }), comments({ mentionUid: '' }),
  ];
  for (const value of invalid) assert.throws(() => normalizeAutomationConfig(value), undefined, JSON.stringify(value));
  const accepted = normalizeAutomationConfig(active({ keywords: [' robot ', 'robot'], targets: ['g:1', '2', 'g:1'] }));
  assert.deepEqual(accepted.keywords, ['robot']);
  assert.deepEqual(accepted.targets, ['g:1', '2']);
});

test('comment model decisions are structured, relevant, bounded and single-line', () => {
  assert.equal(parseCommentDecision('```json\n{"relevant":true,"text":" valid "}\n```'), 'valid');
  for (const value of ['bad', { relevant: 'true', text: 'bad' }, { relevant: false, text: 'bad' },
    { relevant: true, text: '' }, { relevant: true, text: 'x'.repeat(301) }, { relevant: true, text: 'two\nlines' }]) {
    assert.equal(parseCommentDecision(value), null);
  }
});

test('BVID merges duplicate search results with dynamic metadata in either order', () => {
  const video = { id: 'BV1xx411c7mD', bvid: 'BV1xx411c7mD', kind: 'video', source: 'video', title: 'video title' };
  const feed = { ...dynamic(), bvid: video.bvid, title: '', text: 'dynamic details' };
  for (const items of [[video, feed], [feed, video]]) {
    const merged = mergePlatformItems(items);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].key, `video:${video.bvid}`);
    assert.equal(merged[0].kind, 'dynamic');
    assert.equal(merged[0].id, feed.id);
    assert.equal(merged[0].commentOid, feed.commentOid);
    assert.equal(merged[0].title, video.title);
  }
});

test('budget counts failed/uncertain/pending attempts and applies cooldown across local midnight', () => {
  const audit = ['published', 'failed', 'uncertain'].map((status, i) => ({ status, at: date(22, 8, i * 30).toISOString() }));
  assert.deepEqual(commentBudget(audit, date(22, 12)), { todayComments: 3, allowed: false, reason: 'daily_limit' });
  const previous = [{ status: 'published', at: date(22, 23, 50).toISOString() }];
  assert.deepEqual(commentBudget(previous, date(23, 0, 10)), { todayComments: 0, allowed: false, reason: 'cooldown' });
  assert.equal(commentBudget(previous, date(23, 0, 20)).allowed, true);
  assert.equal(commentBudget([{ status: 'cancelled', at: date().toISOString() }], date()).todayComments, 0);
});

test('disabled scheduler has no work; forced inspection reads and pushes but never comments', async t => {
  const f = await fixture(t, comments({ enabled: false }));
  assert.deepEqual(await f.scheduler.tick(), { ok: false, reason: 'disabled' });
  assert.equal(f.calls.dynamics.length, 0);
  assert.equal((await f.scheduler.tick({ force: true })).ok, true);
  assert.equal(f.calls.dynamics.length, 1);
  assert.equal(f.calls.pushes.length, 1);
  assert.equal(f.calls.posts.length, 0);
  assert.equal((await f.scheduler.snapshot()).audit.length, 0);
});

test('scheduled run catches up within 24h once and skips old occurrences', async t => {
  const f = await fixture(t, active({ cron: '0 23 * * *' }));
  f.state.time = date(23, 0, 1);
  await f.seed({ lastScheduledAt: date(21, 23).getTime(), seen: [], audit: [] });
  assert.equal((await f.scheduler.tick()).ok, true);
  assert.equal((await f.scheduler.tick()).reason, 'not_due');
  assert.equal(f.calls.search.length, 1);
  await f.config(active({ cron: '0 9 1 * *' }));
  f.state.time = date(23, 9);
  assert.equal((await f.scheduler.tick()).reason, 'not_due');
  assert.equal(f.calls.search.length, 1);
});

test('scheduled reads retry the same occurrence after a transient failure and restart', async t => {
  const f = await fixture(t, active());
  let attempts = 0;
  const adapterFactory = () => ({
    async search() {
      attempts++;
      if (attempts === 1) throw new Error('bilibili_request_failed');
      return [{ id: 'video-100', kind: 'video', title: 'Recovered read' }];
    },
    dynamics: async () => [],
  });
  const first = await f.create({ adapterFactory }).tick();
  assert.deepEqual(first, { ok: false, reason: 'bilibili_request_failed' });
  const failed = await f.stored();
  assert.equal(failed.lastScheduledAt, undefined, 'a failed read must not acknowledge this schedule');
  assert.equal(failed.lastRun.status, 'error');
  assert.equal(f.calls.pushes.length, 0);
  f.state.time = date(22, 9, 1);
  const restarted = f.create({ adapterFactory });
  assert.equal((await restarted.tick()).ok, true, 'next normal tick should retry without a manual request');
  assert.equal(attempts, 2);
  assert.equal(f.calls.pushes.length, 1);
  assert.equal((await f.stored()).lastScheduledAt, date().getTime());
  assert.equal((await restarted.tick()).reason, 'not_due');
  assert.equal(attempts, 2, 'a completed read occurrence remains deduplicated');
});

test('read recovery preserves confirmed pushes and never replays persisted comment attempts', async t => {
  for (const status of ['published', 'uncertain', 'pending']) {
    const f = await fixture(t, comments({ targets: ['g:1', '2'] }));
    const attempted = { dynamicId: '100', targetUid: '77', text: 'Previously attempted.', at: date(21, 8).toISOString(), status };
    await f.seed({
      lastScheduledAt: date(21).getTime(), seen: ['dynamic:100'], audit: [attempted],
      pending: [{ item: { ...dynamic(), origins: ['up:42'] }, targets: ['g:1', '2'], sent: ['g:1'] }],
      ...(status === 'uncertain' ? { commentBlock: 'publication_uncertain' } : {}),
    });
    let reads = 0;
    const adapterFactory = () => ({
      search: async () => [],
      async dynamics() {
        reads++;
        if (reads === 1) throw new Error('bilibili_request_failed');
        return [dynamic()];
      },
      async publishComment() { assert.fail('recovery must never replay an earlier comment attempt'); },
    });
    assert.equal((await f.create({ adapterFactory }).tick()).ok, false);
    const failed = await f.stored();
    assert.equal(failed.lastScheduledAt, date(21).getTime());
    assert.deepEqual(failed.pending[0].sent, ['g:1']);
    assert.deepEqual(failed.audit, [attempted]);
    f.state.time = date(22, 9, 1);
    assert.equal((await f.create({ adapterFactory }).tick()).ok, true);
    assert.equal(reads, 2);
    assert.deepEqual(f.calls.pushes.map(entry => entry.target), ['2']);
    const recovered = await f.stored();
    assert.equal(recovered.pending.length, 0);
    assert.deepEqual(recovered.audit, [attempted]);
    assert.equal(recovered.lastScheduledAt, date().getTime());
    if (status === 'pending') assert.equal(recovered.commentBlock, 'previous_publication_uncertain');
    if (status === 'uncertain') assert.equal(recovered.commentBlock, 'publication_uncertain');
  }
});

test('failed target retries without replaying already successful deliveries, including reload', async t => {
  const f = await fixture(t, active({ upUsers: ['42'], targets: ['g:1', '2'] }));
  f.state.pushFailure.add('2');
  const first = await f.scheduler.tick({ force: true });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'push_failed');
  assert.deepEqual(f.calls.pushes.map(x => x.target), ['g:1', '2']);
  f.state.pushFailure.clear();
  f.state.time = date(22, 9, 1);
  const restarted = f.create();
  assert.equal((await restarted.tick({ force: true })).ok, true);
  assert.deepEqual(f.calls.pushes.map(x => x.target), ['g:1', '2', '2']);
  assert.equal((await f.stored()).pending.length, 0);
  assert.equal((await f.scheduler.tick({ force: true })).found, 0);
  assert.equal(f.calls.pushes.length, 3);
});

test('same dynamic is commented once and limit is three attempts per local day across reload', async t => {
  const f = await fixture(t, comments());
  for (let i = 0; i < 4; i++) {
    f.state.time = date(22, 9, i * 30);
    f.state.items = [dynamic(String(100 + i))];
    assert.equal((await f.create().tick({ force: true })).ok, true);
  }
  assert.equal(f.calls.posts.length, 3);
  const snapshot = await f.scheduler.snapshot();
  assert.equal(snapshot.todayComments, 3);
  assert.equal(snapshot.audit.length, 3);
  assert.ok(snapshot.audit.every(entry => entry.status === 'published' && entry.text.endsWith(' @target ')));
  f.state.time = date(23, 9);
  f.state.items = [dynamic('100')];
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 3, 'same dynamic must remain reserved across days');
});

test('midnight resets daily count while persisted cooldown still crosses the date boundary', async t => {
  const f = await fixture(t, comments());
  f.state.time = date(22, 23, 50);
  await f.scheduler.tick({ force: true });
  f.state.items = [dynamic('101')];
  f.state.time = date(23, 0, 10);
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 1);
  f.state.time = date(23, 0, 20);
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 2);
  assert.equal((await f.scheduler.snapshot()).todayComments, 1);
});

test('failed and uncertain attempts persist blocks and are never retried', async t => {
  for (const uncertain of [false, true]) {
    const sub = await fixture(t, comments());
    let attempts = 0;
    const adapterFactory = () => ({
      search: async () => [], dynamics: async () => sub.state.items,
      validateLogin: async () => ({ uid: '99' }),
      async publishComment(item, text, uid, { beforePublish }) {
        assert.equal(await beforePublish({ message: `${text} @target ` }), true);
        attempts++;
        return { published: false, uncertain, reason: uncertain ? 'publication_uncertain' : 'platform_refused' };
      },
    });
    await sub.create({ adapterFactory }).tick({ force: true });
    sub.state.time = date(22, 10);
    await sub.create({ adapterFactory }).tick({ force: true });
    const snapshot = await sub.scheduler.snapshot();
    assert.equal(attempts, 1);
    assert.equal(snapshot.audit.length, 1);
    assert.equal(snapshot.audit[0].status, uncertain ? 'uncertain' : 'failed');
    assert.equal(snapshot.audit[0].dynamicId, '100');
    assert.equal(snapshot.audit[0].targetUid, '77');
    assert.equal(snapshot.audit[0].at, date().toISOString());
    assert.ok(snapshot.audit[0].text.endsWith(' @target '));
    assert.ok(snapshot.blockedReason);
    await sub.scheduler.extractBrowserCookie('edge');
    sub.state.time = date(22, 11);
    await sub.create({ adapterFactory }).tick({ force: true });
    assert.equal(attempts, 1, 'credential refresh must not replay this dynamic');
  }
});

test('pending publication recovered after a crash blocks further publication', async t => {
  const f = await fixture(t, comments());
  await f.seed({ audit: [{ dynamicId: '100', targetUid: '77', text: 'reserved', at: date(22, 8).toISOString(), status: 'pending' }] });
  await f.scheduler.tick({ force: true });
  assert.equal(f.calls.posts.length, 0);
  assert.equal((await f.scheduler.snapshot()).blockedReason, 'previous_publication_uncertain');
});

test('actual publication time, rather than initial tick time, anchors the next cooldown', async t => {
  const f = await fixture(t, comments());
  const scheduler = f.create({ generate: async request => {
    if (request.kind === 'comment') { f.state.time = date(22, 9, 45); return { relevant: true, text: 'Late result.' }; }
    return 'summary';
  } });
  await scheduler.tick({ force: true });
  assert.equal((await f.stored()).audit[0].at, date(22, 9, 45).toISOString());
  f.state.items = [dynamic('101')];
  f.state.time = date(22, 10);
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 1);
  f.state.time = date(22, 10, 15);
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 2);
});

test('revocation during remote preflight cancels posting and releases the pending reservation', async t => {
  const f = await fixture(t, comments());
  let actualPosts = 0;
  const scheduler = f.create({ adapterFactory: () => ({
    search: async () => [], dynamics: async () => [dynamic()],
    async publishComment(item, text, uid, { beforePublish }) {
      await f.config(comments({ commentEnabled: false }));
      if (!await beforePublish({ message: `${text} @target ` })) return { published: false, cancelled: true, reason: 'bilibili_publication_cancelled' };
      actualPosts++;
      return { published: true };
    },
  }) });
  await scheduler.tick({ force: true });
  assert.equal(actualPosts, 0);
  const stored = await f.stored();
  assert.equal(stored.audit[0].status, 'cancelled');
  assert.equal(commentBudget(stored.audit, f.state.time).todayComments, 0);
});

test('remote preflight crossing midnight records the actual publication date', async t => {
  const f = await fixture(t, comments());
  f.state.time = date(22, 23, 50);
  let published = 0;
  const scheduler = f.create({ adapterFactory: () => ({
    search: async () => [], dynamics: async () => [dynamic()],
    async publishComment(item, text, uid, { beforePublish }) {
      f.state.time = date(23, 0, 5);
      assert.equal(await beforePublish({ message: `${text} @target ` }), true);
      published++;
      return { published: true, message: `${text} @target ` };
    },
  }) });
  await scheduler.tick({ force: true });
  const snapshot = await scheduler.snapshot();
  assert.equal(published, 1);
  assert.equal(snapshot.audit[0].at, date(23, 0, 5).toISOString());
  assert.equal(snapshot.todayComments, 1);
  f.state.time = date(23, 0, 20);
  f.state.items = [dynamic('101')];
  await f.create().tick({ force: true });
  assert.equal(f.calls.posts.length, 0, 'the next publication must still observe cooldown');
});

test('browser Cookie import validates and stores locally without exposing values', async t => {
  const f = await fixture(t, active());
  assert.deepEqual(await f.scheduler.extractBrowserCookie('chrome'), { imported: true, browser: 'chrome' });
  const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, 'bilibili-cookie.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.cookies).sort(), ['SESSDATA', 'bili_jct']);
  const snapshot = await f.scheduler.snapshot();
  assert.equal(snapshot.cookieAvailable, true);
  assert.doesNotMatch(JSON.stringify({ snapshot, logs: f.calls.logs }), /fake-session-secret|fake-csrf-secret|discard-me/);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).sentinel, 'preserved');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.stateDir, 'bilibili-cookie.json'))).mode & 0o777, 0o600);
});

test('QR login uses validated credential storage without changing automation or publication settings', async t => {
  const f = await fixture(t, active());
  const before = await fs.readFile(f.configPath, 'utf8');
  await f.seed({ audit: [{ dynamicId: '100', targetUid: '77', text: 'Earlier attempt', at: date().toISOString(), status: 'pending' }], commentBlock: 'previous_publication_uncertain' });
  assert.deepEqual(await f.scheduler.importLoginCookies({
    SESSDATA: 'synthetic-qr-session', bili_jct: 'synthetic-qr-csrf', buvid3: 'synthetic-buvid', ignored: 'do-not-store',
  }), { imported: true });
  const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, 'bilibili-cookie.json'), 'utf8'));
  assert.equal(saved.browser, 'qrcode');
  assert.deepEqual(Object.keys(saved.cookies).sort(), ['SESSDATA', 'bili_jct', 'buvid3']);
  assert.equal((await f.stored()).audit[0].status, 'uncertain');
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify({ snapshot: await f.scheduler.snapshot(), logs: f.calls.logs }), /synthetic-qr|synthetic-buvid|do-not-store/);
  assert.equal(f.calls.posts.length, 0);
});

test('cancelled QR validation or rejected credentials never replace an existing login', async t => {
  const f = await fixture(t, active());
  await f.scheduler.extractBrowserCookie('edge');
  const file = path.join(f.stateDir, 'bilibili-cookie.json');
  const before = await fs.readFile(file, 'utf8');
  let current = true;
  const cancelled = f.create({ adapterFactory: () => ({ async validateLogin() { current = false; } }) });
  const credentials = { SESSDATA: 'synthetic-new-session', bili_jct: 'synthetic-new-csrf' };
  await assert.rejects(cancelled.importLoginCookies(credentials, { canSave: () => current }), /qrcode_session_invalid/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const rejected = f.create({ adapterFactory: () => ({ async validateLogin() { throw new Error('bilibili_login_required'); } }) });
  await assert.rejects(rejected.importLoginCookies(credentials), /bilibili_login_required/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(f.scheduler.importLoginCookies({ SESSDATA: 'bad\0value', bili_jct: 'csrf' }), /cookie_extractor_invalid_output/);
  await assert.rejects(fs.access(path.join(f.stateDir, 'bilibili-scheduler.lock')), { code: 'ENOENT' });
});

test('QR commit callback runs after validation and can still prevent credential replacement', async t => {
  const f = await fixture(t, active());
  await f.scheduler.extractBrowserCookie('edge');
  const file = path.join(f.stateDir, 'bilibili-cookie.json');
  const before = await fs.readFile(file, 'utf8');
  let commits = 0;
  const credentials = { SESSDATA: 'synthetic-new-session', bili_jct: 'synthetic-new-csrf' };
  await assert.rejects(f.scheduler.importLoginCookies(credentials, {
    onCommit() { commits++; throw new Error('qrcode_session_invalid'); },
  }), /qrcode_session_invalid/);
  assert.equal(commits, 1);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(f.scheduler.importLoginCookies(credentials, { onCommit: 'invalid' }), /qrcode_session_invalid/);
  assert.deepEqual(await f.scheduler.importLoginCookies(credentials, { onCommit() { commits++; } }), { imported: true });
  assert.equal(commits, 2);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).cookies.SESSDATA, credentials.SESSDATA);
});

test('audit persistence failure after credential commit reports saved login and retains the publication block', async t => {
  const f = await fixture(t, active());
  await f.seed({ audit: [], commentBlock: 'bilibili_login_required' });
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === path.join(f.stateDir, 'bilibili-state.json')) throw new Error('synthetic-private-write-failure');
    return rename(source, target);
  });
  try {
    assert.deepEqual(await f.scheduler.importLoginCookies({
      SESSDATA: 'synthetic-saved-session', bili_jct: 'synthetic-saved-csrf',
    }), { imported: true });
  } finally { mocked.mock.restore(); }
  const saved = JSON.parse(await fs.readFile(path.join(f.stateDir, 'bilibili-cookie.json'), 'utf8'));
  assert.equal(saved.cookies.SESSDATA, 'synthetic-saved-session');
  assert.equal((await f.scheduler.snapshot()).blockedReason, 'bilibili_login_required');
  assert.ok(f.calls.logs.some(value => value.includes('B站登录态已保存')));
  assert.doesNotMatch(f.calls.logs.join('\n'), /synthetic-saved|synthetic-private/);
  await assert.rejects(fs.access(path.join(f.stateDir, 'bilibili-scheduler.lock')), { code: 'ENOENT' });
});

test('Cookie extractor preserves only recognized safe diagnostics from failed subprocesses', async () => {
  function fakeProcess(output, exitCode = 1) {
    return (_command, args, options) => {
      assert.deepEqual(args, ['synthetic-script.py', 'edge', '--json']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => { child.stdout.end(output); child.emit('close', exitCode); });
      return child;
    };
  }
  for (const code of ['cookie_database_locked', 'cookie_app_bound_unsupported', 'bilibili_login_not_found',
    'cookie_crypto_unavailable', 'cookie_decryption_failed', 'browser_profile_not_found', 'cookie_database_unreadable']) {
    await assert.rejects(readBrowserCookies('synthetic-script.py', 'edge', {
      spawnImpl: fakeProcess(JSON.stringify({ error: code, detail: 'synthetic-private-cookie' })),
    }), error => error.message === code);
  }
  for (const output of ['traceback synthetic-private-cookie', '{invalid', JSON.stringify({ error: 'SESSDATA=synthetic-private-cookie' })]) {
    await assert.rejects(readBrowserCookies('synthetic-script.py', 'edge', { spawnImpl: fakeProcess(output) }),
      error => error.message === 'cookie_extractor_failed');
  }
  await assert.rejects(readBrowserCookies('synthetic-script.py', 'edge', {
    spawnImpl() { throw new Error('synthetic-private-path'); },
  }), error => error.message === 'cookie_extractor_unavailable');
  assert.deepEqual(await readBrowserCookies('synthetic-script.py', 'edge', {
    spawnImpl: fakeProcess('{"cookies":{"SESSDATA":"synthetic-session"}}', 0),
  }), { cookies: { SESSDATA: 'synthetic-session' } });
});

test('invalid Cookie and browser inputs do not save credentials or retain the lock', async t => {
  const f = await fixture(t, active(), { cookieExtractor: async () => ({ cookies: { SESSDATA: 'bad\nvalue', bili_jct: 'csrf' } }) });
  await assert.rejects(f.scheduler.extractBrowserCookie('firefox'), /browser_invalid/);
  await assert.rejects(f.scheduler.extractBrowserCookie('edge'), /cookie_extractor_invalid_output/);
  await assert.rejects(fs.access(path.join(f.stateDir, 'bilibili-cookie.json')), { code: 'ENOENT' });
  assert.equal((await f.scheduler.tick({ force: true })).ok, true);
});

test('Cookie rejected by platform login does not overwrite stored credentials', async t => {
  const f = await fixture(t, active());
  await f.scheduler.extractBrowserCookie('edge');
  const file = path.join(f.stateDir, 'bilibili-cookie.json');
  const original = await fs.readFile(file, 'utf8');
  const rejected = f.create({
    cookieExtractor: async () => ({ cookies: { SESSDATA: 'rejected-session', bili_jct: 'rejected-csrf' } }),
    adapterFactory: () => ({ async validateLogin() { throw new Error('bilibili_login_required'); } }),
  });
  await assert.rejects(rejected.extractBrowserCookie('chrome'), /bilibili_login_required/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await assert.rejects(fs.access(path.join(f.stateDir, 'bilibili-scheduler.lock')), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(await f.scheduler.snapshot()), /rejected-session|rejected-csrf|fake-session-secret/);
});

test('concurrent scheduler instances respect the process lock', async t => {
  const f = await fixture(t, active());
  let unlockSearch;
  let enteredSearch;
  const entered = new Promise(resolve => { enteredSearch = resolve; });
  const first = f.create({ adapterFactory: () => ({
    async search() { enteredSearch(); return new Promise(resolve => { unlockSearch = () => resolve([]); }); },
    dynamics: async () => [],
  }) });
  const running = first.tick({ force: true });
  await entered;
  try { assert.deepEqual(await f.scheduler.tick({ force: true }), { ok: false, reason: 'busy' }); }
  finally { unlockSearch(); }
  assert.equal((await running).ok, true);
  assert.equal((await f.scheduler.tick({ force: true })).ok, true);
});

test('invalid configuration releases both in-memory and on-disk locks', async t => {
  const f = await fixture(t, active({ cron: 'invalid' }));
  assert.equal((await f.scheduler.tick({ force: true })).ok, false);
  await f.config(active());
  assert.equal((await f.scheduler.tick({ force: true })).ok, true);
  await assert.rejects(fs.access(path.join(f.stateDir, 'bilibili-scheduler.lock')), { code: 'ENOENT' });
});
