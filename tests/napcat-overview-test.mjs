import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../src/dsh.js';
import { createConsoleFixture, freePort, isolatedEnv } from './helpers/isolated-fixtures.mjs';

async function bounded(promise, label, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function currentOverview(instance) {
  const response = await fetch(`${instance.url}api/overview`, { signal: AbortSignal.timeout(7000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body.data;
}

for (const scenario of [
  { name: 'online', state: 'online', status: { isLogin: true, isOffline: false, loginPhase: 'ready' } },
  { name: 'offline', state: 'offline', status: { isLogin: false, isOffline: true, loginPhase: 'offline' } },
  { name: 'login required', state: 'login-required', status: { isLogin: false, loginPhase: 'waiting_qrcode' } },
  { name: 'auth rejected', state: 'unknown', rejectAuth: true },
]) {
  test(`cold console detector reauthenticates and appends its journal: online to ${scenario.name}`,
    { timeout: 25000 }, async () => {
      const tempRoot = path.resolve(os.tmpdir());
      const root = await fs.mkdtemp(path.join(tempRoot, 'qq-napcat-console-cold-'));
      const token = 'synthetic-cold-console-webui-secret';
      const hash = createHash('sha256').update(`${token}.napcat`).digest('hex');
      const account = '876543210';
      const nickname = 'private-cold-console-nickname';
      const qrUrl = 'https://qr.invalid/private-cold-console-code';
      const mock = {
        logins: 0, closes: 0, calls: [], credentials: [], rejectAuth: false,
        status: { isLogin: true, isOffline: false, loginPhase: 'ready' },
      };
      let fixture;
      let restarted;
      let serverError;
      const napcat = http.createServer(async (req, res) => {
        const reply = (data, code = 0, message = '') => res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ code, data, message }));
        try {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const call = { url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(raw) };
          mock.calls.push(call);
          if (req.url === '/api/auth/login') {
            mock.logins += 1;
            if (mock.rejectAuth || call.body.hash !== hash) return reply(null, -1, `Unauthorized ${token}`);
            const credential = `synthetic-cold-console-credential-${mock.logins}`;
            mock.credentials.push(credential);
            return reply({ Credential: credential });
          }
          if (req.headers.authorization !== `Bearer ${mock.credentials.at(-1)}`) return reply(null, -1, 'Unauthorized');
          if (req.url === '/api/QQLogin/CheckLoginStatus') return reply({ ...mock.status, qrcodeurl: qrUrl });
          if (req.url === '/api/QQLogin/GetQQLoginInfo') return reply({ uin: account, nick: nickname, online: true });
          res.writeHead(404).end();
        } catch (error) {
          serverError = error;
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      });
      napcat.on('close', () => { mock.closes += 1; });
      try {
        await bounded(new Promise((resolve, reject) => {
          napcat.once('error', reject);
          napcat.listen(0, '127.0.0.1', resolve);
        }), 'mock NapCat startup');
        const napcatPort = napcat.address().port;
        const configDir = path.join(root, 'napcat', 'napcat', 'config');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(configDir, 'webui.json'), JSON.stringify({
          host: '127.0.0.1', port: napcatPort, token,
        }));
        // No injected health probe: each console owns the production detector and journal.
        fixture = await bounded(createConsoleFixture(root), 'initial isolated console startup');
        const first = await currentOverview(fixture.instance);
        assert.equal(first.napcat.state, 'online');
        assert.equal(first.napcat.loggedIn, true);
        assert.equal(first.napcat.known, true);
        assert.equal(first.napcat.source, 'webui');
        assert.equal(first.napcat.account, account);
        assert.equal(mock.logins, 1);
        assert.equal(mock.calls[0].url, '/api/auth/login');
        assert.equal(mock.calls[0].body.hash, hash);
        assert.equal(mock.calls[0].authorization, undefined);

        const journalFile = path.join(root, 'logs', 'napcat-health.jsonl');
        const originalJournal = await fs.readFile(journalFile, 'utf8');
        const originalRows = originalJournal.trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(originalRows.at(-1).state, 'online');
        assert.equal(originalRows.at(-1).at, first.napcat.checkedAt);
        const originalConfig = await fs.readFile(fixture.configPath, 'utf8');
        await bounded(fixture.instance.stop(), 'initial console stop');
        assert.equal(fixture.instance.listening, false);
        assert.equal(await fs.readFile(journalFile, 'utf8'), originalJournal);
        assert.equal(napcat.listening, true, 'the mock NapCat stays running while only the console stops');
        assert.equal(mock.closes, 0);

        mock.rejectAuth = Boolean(scenario.rejectAuth);
        if (scenario.status) mock.status = scenario.status;
        const callsBeforeRestart = mock.calls.length;
        const loginsBeforeRestart = mock.logins;
        const { createWebUiServer } = await import('../src/webui/server.mjs');
        restarted = createWebUiServer({
          config: fixture.config, configRoot: root, port: fixture.port,
          updateManager: { async start() {}, stop() {} },
        });
        await bounded(restarted.start(), 'replacement isolated console startup');
        const current = await currentOverview(restarted);
        assert.equal(current.napcat.state, scenario.state);
        assert.equal(current.napcat.loggedIn, scenario.state === 'online');
        assert.equal(current.napcat.known, scenario.state !== 'unknown');
        assert.equal(current.napcat.reachable, true);
        assert.equal(current.napcat.running, true, 'a live NapCat does not prove QQ is online');
        assert.equal(current.napcat.source, scenario.rejectAuth ? '' : 'webui');
        if (scenario.state !== 'online') assert.equal(current.napcat.account, '', 'a prior online identity is not reused');
        if (scenario.rejectAuth) assert.equal(current.napcat.errorCode, 'webui-unauthorized');
        assert.equal(mock.logins, loginsBeforeRestart + 1, 'the cold detector authenticates again');
        const restartedCalls = mock.calls.slice(callsBeforeRestart);
        assert.equal(restartedCalls[0].url, '/api/auth/login', 'the new detector must not try the old credential first');
        assert.equal(restartedCalls[0].body.hash, hash);
        assert.equal(restartedCalls[0].authorization, undefined);
        assert.ok(mock.calls.every((call) => call.method === 'POST'));
        if (scenario.rejectAuth) {
          assert.equal(restartedCalls.length, 1, 'rejected auth cannot request QQ status or reuse an old session');
        } else {
          assert.equal(restartedCalls[1].url, '/api/QQLogin/CheckLoginStatus');
          assert.equal(restartedCalls[1].authorization, `Bearer ${mock.credentials.at(-1)}`);
          assert.equal(mock.credentials.length, 2);
        }
        assert.equal(napcat.listening, true);
        assert.equal(napcat.address().port, napcatPort);
        assert.equal(mock.closes, 0, 'the same mock NapCat server was never restarted');
        assert.equal(serverError, undefined);
        assert.equal(await fs.readFile(fixture.configPath, 'utf8'), originalConfig, 'rebuilding the console preserves its configuration');

        const continuedJournal = await fs.readFile(journalFile, 'utf8');
        assert.ok(continuedJournal.startsWith(originalJournal), 'all prior health JSONL bytes survive console replacement');
        const appendedRows = continuedJournal.slice(originalJournal.length).trim().split('\n').map((line) => JSON.parse(line));
        assert.ok(appendedRows.length >= 1, 'a cold journal records fresh evidence even when the state stays online');
        assert.ok(appendedRows.every((entry) => entry.state === scenario.state));
        assert.equal(appendedRows.at(-1).at, current.napcat.checkedAt);
        assert.equal(appendedRows.at(-1).loggedIn, scenario.state === 'online');
        assert.equal(appendedRows.at(-1).errorCode, scenario.rejectAuth ? 'webui-unauthorized' : '');
        for (const secret of [token, hash, ...mock.credentials, account, nickname, qrUrl]) {
          assert.ok(!continuedJournal.includes(secret), 'health history excludes credentials, identities and QR data');
        }
      } finally {
        try { await bounded(Promise.resolve(restarted?.stop()), 'replacement console cleanup'); }
        finally {
          try { await bounded(Promise.resolve(fixture?.close()), 'initial console cleanup'); }
          finally {
            napcat.closeAllConnections();
            await bounded(new Promise((resolve) => napcat.close(resolve)), 'mock NapCat cleanup');
            assert.equal(path.dirname(root), tempRoot);
            assert.ok(path.basename(root).startsWith('qq-napcat-console-cold-'));
            await bounded(fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 'isolated console directory cleanup');
          }
        }
      }
    });
}

test('real isolated console Node processes reauthenticate after exit and preserve prior health evidence',
  { timeout: 45000 }, async (t) => {
    const tempRoot = path.resolve(os.tmpdir());
    const root = await fs.mkdtemp(path.join(tempRoot, 'qq-napcat-console-process-'));
    const token = 'synthetic-process-console-webui-secret';
    const hash = createHash('sha256').update(`${token}.napcat`).digest('hex');
    const account = '876543219';
    const nickname = 'private-process-console-nickname';
    const credential = 'synthetic-process-console-credential';
    const qrUrl = 'https://qr.invalid/private-process-console-code';
    const mock = {
      logins: 0, closes: 0, calls: [],
      status: { isLogin: true, isOffline: false, loginPhase: 'ready' },
    };
    const hosts = [];
    let fixture;
    let fixtureClosed = false;
    let serverError;
    const napcat = http.createServer(async (req, res) => {
      const reply = (data, code = 0) => res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code, data }));
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const call = { url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(raw) };
        mock.calls.push(call);
        if (req.url === '/api/auth/login') {
          mock.logins += 1;
          if (call.body.hash !== hash) return reply(null, -1);
          return reply({ Credential: credential });
        }
        if (req.headers.authorization !== `Bearer ${credential}`) return reply(null, -1);
        if (req.url === '/api/QQLogin/CheckLoginStatus') return reply({ ...mock.status, qrcodeurl: qrUrl });
        if (req.url === '/api/QQLogin/GetQQLoginInfo') return reply({ uin: account, nick: nickname, online: true });
        res.writeHead(404).end();
      } catch (error) {
        serverError = error;
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    napcat.on('close', () => { mock.closes += 1; });

    const alive = (pid) => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const launch = async () => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('./fixtures/napcat-console-host.mjs', import.meta.url)), root, String(await freePort()),
      ], {
        cwd: root, windowsHide: true, env: isolatedEnv(root, { QQ_CONFIG: path.join(root, 'config.json') }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const record = { child, closed: false, exited: false, messages: [], output: '', timedOut: false };
      hosts.push(record);
      child.stdout.on('data', (chunk) => { record.output += chunk; });
      child.stderr.on('data', (chunk) => { record.output += chunk; });
      record.ready = new Promise((resolve, reject) => {
        child.on('message', (message) => {
          record.messages.push(message);
          if (message?.type === 'ready') resolve(message);
          if (message?.type === 'failed') reject(new Error(message.code));
        });
        child.once('close', () => reject(new Error('isolated console closed before readiness')));
      });
      record.ready.catch(() => {});
      child.once('error', (error) => { record.spawnError = error; });
      child.once('exit', () => { record.exited = true; });
      const timeout = setTimeout(() => {
        record.timedOut = true;
        killProcessTree(child);
      }, 15000);
      record.done = new Promise((resolve) => child.once('close', (code, signal) => {
        clearTimeout(timeout);
        record.closed = true;
        record.code = code;
        record.signal = signal;
        resolve(record);
      }));
      return record;
    };
    const stopHost = async (record) => {
      assert.equal(record.child.connected, true);
      await bounded(new Promise((resolve, reject) => record.child.send({ type: 'stop' }, (error) => error ? reject(error) : resolve())),
        'console process stop IPC', 2000);
      // A timeout fails into cleanup; only the actual close event proves exit.
      await bounded(record.done, 'console process graceful close', 8000);
      assert.equal(record.spawnError, undefined);
      assert.equal(record.timedOut, false, 'graceful console stop must finish before the process deadline');
      assert.equal(record.code, 0);
      assert.equal(record.signal, null);
      assert.equal(record.exited, true);
      assert.equal(record.closed, true);
      assert.ok(record.messages.some((message) => message.type === 'stopped'));
      assert.equal(alive(record.child.pid), false, 'the console PID has exited before the next process starts');
    };

    try {
      await bounded(new Promise((resolve, reject) => {
        napcat.once('error', reject);
        napcat.listen(0, '127.0.0.1', resolve);
      }), 'process fixture NapCat startup');
      const napcatPort = napcat.address().port;
      fixture = await createConsoleFixture(root, { napcatHealth: {
        async check() { return { state: 'unknown', loggedIn: false, known: false, reachable: false }; }, close() {},
      } });
      await fixture.close();
      fixtureClosed = true;
      assert.equal(mock.logins, 0, 'preparing fixture files does not authenticate to NapCat');
      const configDir = path.join(root, 'napcat', 'napcat', 'config');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'webui.json'), JSON.stringify({ host: '127.0.0.1', port: napcatPort, token }));
      await fs.writeFile(path.join(root, 'state', 'sessions.json'), JSON.stringify({ fixture: 'preserved-process-session-state' }));
      const preservedFiles = [
        'config.json', 'workspace/AGENTS.md', 'model.yml', 'home/.dsh/profiles/desktop/cordis.patch.yml',
        'napcat/napcat/config/webui.json', 'memory/20-群聊/fixture.md', 'state/sessions.json',
        'logs/bridge-console.log', 'logs/napcat-console.log',
      ];
      const snapshots = await Promise.all(preservedFiles.map((file) => fs.readFile(path.join(root, file))));

      const firstHost = await launch();
      const firstReady = await bounded(firstHost.ready, 'first console process readiness', 16000);
      assert.equal(firstReady.pid, firstHost.child.pid);
      const first = await currentOverview(firstReady);
      assert.equal(first.napcat.state, 'online');
      assert.equal(first.napcat.loggedIn, true);
      assert.equal(first.napcat.source, 'webui');
      assert.equal(first.napcat.account, account);
      assert.equal(mock.logins, 1);
      const journalFile = path.join(root, 'logs', 'napcat-health.jsonl');
      const originalJournal = await fs.readFile(journalFile);
      assert.equal(JSON.parse(originalJournal.toString('utf8').trim().split('\n').at(-1)).state, 'online');
      await stopHost(firstHost);
      assert.deepEqual(await fs.readFile(journalFile), originalJournal);
      assert.equal(napcat.listening, true);
      assert.equal(mock.closes, 0);

      mock.status = { isLogin: false, isOffline: true, loginPhase: 'waiting_qrcode' };
      const callsBeforeRestart = mock.calls.length;
      const secondHost = await launch();
      const secondReady = await bounded(secondHost.ready, 'second console process readiness', 16000);
      assert.notEqual(secondHost.child.pid, firstHost.child.pid, 'replacement console runs in a new OS process');
      assert.equal(secondReady.pid, secondHost.child.pid);
      const current = await currentOverview(secondReady);
      assert.equal(current.napcat.state, 'login-required');
      assert.equal(current.napcat.loggedIn, false);
      assert.equal(current.napcat.known, true);
      assert.equal(current.napcat.account, '');
      assert.equal(current.napcat.source, 'webui');
      assert.equal(current.napcat.reachable, true);
      assert.equal(mock.logins, 2, 'a new Node process cannot reuse the previous in-memory credential');
      const newCalls = mock.calls.slice(callsBeforeRestart);
      assert.equal(newCalls[0].url, '/api/auth/login');
      assert.equal(newCalls[0].authorization, undefined);
      assert.equal(newCalls[0].body.hash, hash);
      assert.equal(newCalls[1].url, '/api/QQLogin/CheckLoginStatus');
      assert.equal(newCalls[1].authorization, `Bearer ${credential}`);
      assert.ok(!newCalls.some((call) => call.url === '/api/QQLogin/GetQQLoginInfo'));
      assert.ok(mock.calls.every((call) => call.method === 'POST'));
      assert.equal(serverError, undefined);
      await stopHost(secondHost);

      const continuedJournal = await fs.readFile(journalFile);
      assert.deepEqual(continuedJournal.subarray(0, originalJournal.length), originalJournal, 'old health JSONL bytes survive a real process exit/start');
      const appended = continuedJournal.subarray(originalJournal.length).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(appended.length >= 1);
      assert.ok(appended.every((entry) => entry.state === 'login-required' && entry.loggedIn === false));
      assert.equal(appended.at(-1).at, current.napcat.checkedAt);
      for (const [index, file] of preservedFiles.entries()) {
        assert.deepEqual(await fs.readFile(path.join(root, file)), snapshots[index], `process restarts preserve ${file}`);
      }
      for (const secret of [token, hash, credential, account, nickname, qrUrl]) {
        assert.ok(!continuedJournal.includes(Buffer.from(secret)), 'process health history excludes secrets and identities');
        assert.ok(hosts.every((record) => !JSON.stringify(record.messages).includes(secret) && !record.output.includes(secret)));
      }
      assert.equal(napcat.listening, true);
      assert.equal(napcat.address().port, napcatPort);
      assert.equal(mock.closes, 0, 'the mock NapCat is not restarted with the console processes');
      t.diagnostic(`isolated console PIDs ${firstHost.child.pid} and ${secondHost.child.pid} both exited; fresh authentications: ${mock.logins}`);
    } finally {
      let processesClosed = true;
      try {
        for (const record of hosts) {
          if (!record.closed) {
            killProcessTree(record.child);
            try { await bounded(record.done, 'console process tree cleanup'); }
            catch { processesClosed = false; }
          }
          try { if (!record.closed || alive(record.child.pid)) processesClosed = false; }
          catch { processesClosed = false; }
        }
        if (fixture && !fixtureClosed) await bounded(fixture.close(), 'process fixture console cleanup');
      } finally {
        napcat.closeAllConnections();
        await bounded(new Promise((resolve) => napcat.close(resolve)), 'process fixture NapCat cleanup');
        assert.equal(path.dirname(root), tempRoot);
        assert.ok(path.basename(root).startsWith('qq-napcat-console-process-'));
        if (processesClosed) {
          await bounded(fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 'process fixture directory cleanup');
        } else {
          throw new Error(`Console process cleanup was not proven; isolated files retained at ${root}`);
        }
      }
    }
  });

test('console uses current QQ evidence independently of old bridge state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-napcat-overview-'));
  let fixture;
  let state = 'login-required';
  try {
    fixture = await createConsoleFixture(root, { napcatHealth: {
      async check() { return { state, loggedIn: state === 'online', known: state !== 'unknown', reachable: true, detail: 'fixture', source: 'webui' }; },
      close() {},
    } });
    const statusFile = path.join(root, 'state', 'status.json');
    await fs.writeFile(statusFile, JSON.stringify({ pid: process.pid, connected: true, updatedAt: '2026-01-01T00:00:00Z' }));
    const get = async () => (await (await fetch(`${fixture.instance.url}api/overview`)).json()).data;
    let overview = await get();
    assert.equal(overview.napcat.loggedIn, false);
    assert.equal(overview.napcat.state, 'login-required');
    assert.equal(overview.bridge.connected, false);
    assert.equal(overview.bridge.statusFresh, false);
    assert.equal(overview.ports.napcatWebuiToken, false);
    const configDir = path.join(root, 'napcat', 'napcat', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'webui.json'), '\uFEFF' + JSON.stringify({ port: 12345, token: 'synthetic-nested-token' }));
    state = 'online';
    overview = await get();
    assert.equal(overview.napcat.loggedIn, true, 'QQ online does not require a bridge connection');
    assert.equal(overview.ports.napcatWebuiToken, true, 'the console reads a BOM-prefixed nested WebUI config');
    assert.equal(overview.bridge.connected, false);
    state = 'unknown';
    overview = await get();
    assert.equal(overview.napcat.loggedIn, false);
    assert.equal(overview.napcat.known, false);
  } finally {
    await fixture?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overview UI cannot turn green from an open port or an ordinary QQ process', async () => {
  const source = await fs.readFile(new URL('../src/webui/public/app.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function statusTone('), source.indexOf('function serviceCard('));
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  const overview = {
    napcat: { running: true, portOpen: true, qqRunning: true, loggedIn: false, state: 'unknown' },
    bridge: { running: true, connected: true }, dsh: { running: true },
  };
  assert.equal(context.statusTone(overview).state, 'warn');
  assert.equal(context.napcatBadge(overview.napcat), '登录状态待确认');
  overview.napcat.state = 'login-required';
  assert.equal(context.napcatBadge(overview.napcat), 'QQ 需重新登录');
  overview.napcat.loggedIn = true;
  assert.equal(context.statusTone(overview).state, 'ok');
});

test('DSH card reflects an on-demand runtime instead of a Windows-only process name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-napcat-dsh-runtime-'));
  let fixture;
  try {
    fixture = await createConsoleFixture(root, {
      napcatHealth: { async check() { return { state: 'online', loggedIn: true, reachable: true }; }, close() {} },
    });
    const dshRoot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
    const bin = path.join(dshRoot, 'lib', 'bin.js');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(path.join(dshRoot, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }));
    await fs.writeFile(bin, '// fixture\n');
    fixture.config.dsh.command = bin;
    const overview = await currentOverview(fixture.instance);
    assert.equal(overview.dsh.running, true);
    assert.equal(overview.dsh.kind, 'on-demand');
    assert.equal(overview.dsh.version, '9.9.9-test');
    assert.equal(
      overview.dsh.controlsAvailable,
      process.platform === 'win32' && await fs.stat(path.join(root, 'launcher', 'lib', 'ProcessControl.ps1'))
        .then(() => true).catch(() => false),
    );
  } finally {
    await fixture?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overview remains valid while shutdown and a refresh overlap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-napcat-shutdown-'));
  let fixture;
  let releaseStop;
  let stopping;
  let stopStarted;
  let stopped = false;
  const entered = new Promise((resolve) => { stopStarted = resolve; });
  try {
    fixture = await createConsoleFixture(root, {
      napcatHealth: { async check() { return { state: 'online', loggedIn: true, reachable: true }; }, close() {} },
      platformQrLogin: { async stop() {
        if (stopped) return;
        stopped = true;
        stopStarted();
        await new Promise((resolve) => { releaseStop = resolve; });
      } },
    });
    stopping = fixture.instance.stop();
    await entered;
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/overview`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.napcat.state, 'unknown');
    assert.equal(body.data.napcat.loggedIn, false);
  } finally {
    releaseStop?.();
    await stopping;
    await fixture?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
