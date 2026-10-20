import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUpdateManager, compareVersions } from '../src/updates.mjs';

const REPO = 'miku05231/DSH-Fatwhale-QQ';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ZIP = Buffer.from('PK mock portable application');
const HASH = createHash('sha256').update(ZIP).digest('hex');
const HELPER = '# Trusted installed helper fixture.\n';
const VERSION = '0.3.0';
const PACKAGE = `qq-bridge-${VERSION}-portable-win64.zip`;
const SUMS = `\uFEFF${HASH}  ${PACKAGE}\r\n`;
let assertions = 0;
let failures = 0;

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function truthy(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => error.code === code);
  assertions += 1;
}

async function until(action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for a mocked update operation.');
}

function release(version = VERSION, changes = {}) {
  const tag = `v${version}`;
  const packageName = `qq-bridge-${version}-portable-win64.zip`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: 'A stable update.\n<script>display this as text</script>',
    published_at: '2026-10-20T10:00:00Z',
    html_url: 'https://untrusted.example/ignored',
    assets: [
      { name: packageName, size: ZIP.length, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${packageName}` },
      { name: 'SHA256SUMS.txt', size: Buffer.byteLength(SUMS), browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt` },
    ],
    ...changes,
  };
}

function responses({ data = release(), manifest = SUMS, zip = ZIP, apiResponse = null, route = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (route) {
      const custom = await route(url, options, calls);
      if (custom) return custom;
    }
    if (url === API) return apiResponse?.() ?? new Response(JSON.stringify(data));
    if (url.endsWith('/SHA256SUMS.txt')) return new Response(manifest);
    if (url.endsWith('.zip')) return new Response(zip);
    throw new Error('Unexpected fixture URL.');
  };
  return { calls, fetchImpl };
}

async function fixture(options = {}, action) {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, 'qq update with space-'));
  const managers = [];
  try {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFile(path.join(root, 'qq-bridge.exe'), 'mock exe');
    await writeFile(path.join(root, 'scripts', 'install-update.ps1'), HELPER);
    const http = responses(options.http);
    const jobs = [];
    const factory = (overrides = {}) => {
      const manager = createUpdateManager({
        projectRoot: root,
        platform: 'win32',
        isDocker: false,
        fetchImpl: http.fetchImpl,
        launchInstaller: async (job) => { jobs.push(job); },
        ...options.manager,
        ...overrides,
      });
      managers.push(manager);
      return manager;
    };
    await action({ root, http, jobs, factory, manager: factory() });
  } finally {
    for (const manager of managers) manager.stop();
    const absolute = path.resolve(root);
    assert.ok(path.dirname(absolute) === temporary && path.basename(absolute).startsWith('qq update with space-'));
    await rm(absolute, { recursive: true, force: true });
  }
}

async function test(name, action) {
  try {
    await action();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

function windowsShortPath(value) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class UpdateShortPath {
  [DllImport("kernel32.dll", EntryPoint = "GetShortPathNameW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetShortPathName(string path, StringBuilder output, uint size);
}
'@
$output = New-Object Text.StringBuilder 32768
$length = [UpdateShortPath]::GetShortPathName($env:QQ_UPDATE_TEST_PATH, $output, 32768)
if ($length -eq 0 -or $length -ge 32768) { throw 'GetShortPathNameW failed.' }
[Console]::Write($output.ToString())
`;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, QQ_UPDATE_TEST_PATH: value } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

await test('strict SemVer ordering and invalid versions', async () => {
  for (const [left, right, comparison] of [
    ['0.2.0', '0.3.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0', '1.0.0+build.2', 0],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-beta.1', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['999999999999999999.0.0', '999999999999999998.0.0', 1],
  ]) equal(compareVersions(left, right), comparison, `${left} vs ${right}`);
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '1.0.0-', '1.0.0\n', '1.0.0/../x', '', null]) {
    assert.throws(() => compareVersions(version, '1.0.0'), { code: 'UPDATE_BAD_VERSION' });
    assertions += 1;
  }
});

await test('status is local; stable release check is fixed and cached', async () => {
  await fixture({}, async ({ manager, http }) => {
    let state = await manager.status();
    equal(state.currentVersion, '0.2.0');
    equal(state.phase, 'idle');
    equal(state.automatic, true);
    equal(http.calls.length, 0);
    state = await manager.check();
    equal(state.phase, 'available');
    equal(state.latestVersion, VERSION);
    equal(state.canInstall, true);
    equal(state.installReason, null);
    equal(state.releaseUrl, `https://github.com/${REPO}/releases/tag/v${VERSION}`);
    equal(state.publishedAt, '2026-10-20T10:00:00.000Z');
    truthy(state.releaseNotes.includes('<script>'));
    truthy(state.checkedAt);
    equal(http.calls[0].url, API);
    equal(http.calls[0].options.redirect, 'manual');
    equal(http.calls[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
    truthy(!('Authorization' in http.calls[0].options.headers));
    await Promise.all([manager.status(), manager.check(), manager.check()]);
    equal(http.calls.length, 1);
  });
});

await test('concurrent checks use one network request', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  await fixture({ http: { route: async (url) => {
    if (url === API) {
      await gate;
      return new Response(JSON.stringify(release()));
    }
  } } }, async ({ manager, http }) => {
    const checks = [manager.check(), manager.check(), manager.check()];
    await until(() => http.calls.length === 1);
    equal((await manager.status()).phase, 'checking');
    equal(http.calls.length, 1);
    finish();
    const results = await Promise.all(checks);
    equal(results.map((item) => item.latestVersion), [VERSION, VERSION, VERSION]);
  });
});

await test('install waits for an active check and rejects a superseded version', async () => {
  let finish;
  let time = Date.parse('2026-10-20T00:00:00Z');
  let responseNumber = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  await fixture({
    http: { route: async (url) => {
      if (url !== API) return null;
      responseNumber += 1;
      if (responseNumber === 1) return new Response(JSON.stringify(release()));
      await gate;
      return new Response(JSON.stringify(release('0.4.0')));
    } },
    manager: { now: () => time },
  }, async ({ manager, jobs, http }) => {
    await manager.check();
    time += 60_001;
    const checking = manager.check();
    await until(() => http.calls.length === 2);
    const installing = manager.install({ version: VERSION });
    const rejected = rejectsCode(() => installing, 'UPDATE_NOT_AVAILABLE');
    equal((await manager.status()).phase, 'checking');
    finish();
    await checking;
    await rejected;
    equal((await manager.status()).phase, 'available');
    equal((await manager.status()).latestVersion, '0.4.0');
    equal(jobs.length, 0);
    equal(http.calls.length, 2);
  });
});

await test('unavailable releases and downgrades never install', async () => {
  await fixture({ http: { apiResponse: () => new Response('', { status: 404 }) } }, async ({ manager }) => {
    const state = await manager.check();
    equal(state.phase, 'current');
    equal(state.latestVersion, null);
    equal(state.canInstall, false);
    await rejectsCode(() => manager.install({ version: VERSION }), 'UPDATE_NOT_AVAILABLE');
  });
  for (const version of ['0.1.9', '0.2.0']) {
    await fixture({ http: { data: release(version) } }, async ({ manager }) => {
      const state = await manager.check();
      equal(state.phase, 'current');
      equal(state.canInstall, false);
      await rejectsCode(() => manager.install({ version }), 'UPDATE_NOT_AVAILABLE');
    });
  }
  for (const candidate of [
    release('0.3.0-rc.1'),
    release('0.3.0', { prerelease: true }),
    release('0.3.0', { draft: true }),
    release('01.3.0'),
  ]) {
    await fixture({ http: { data: candidate } }, async ({ manager }) => {
      const state = await manager.check();
      equal(state.phase, 'error');
      equal(state.canInstall, false);
    });
  }
});

await test('source, custom config/state, Docker and other platforms stay manual', async () => {
  for (const kind of ['source', 'missing-exe', 'missing-helper', 'platform', 'docker', 'state', 'config', 'invalid-version']) {
    await fixture({}, async ({ root, factory, jobs }) => {
      const overrides = {};
      if (kind === 'source') await writeFile(path.join(root, '.git'), 'gitdir: some-worktree');
      if (kind === 'missing-exe') await rm(path.join(root, 'qq-bridge.exe'));
      if (kind === 'missing-helper') await rm(path.join(root, 'scripts', 'install-update.ps1'));
      if (kind === 'platform') overrides.platform = 'linux';
      if (kind === 'docker') overrides.isDocker = true;
      if (kind === 'state') overrides.stateDir = path.join(root, 'custom-state');
      if (kind === 'config') overrides.configFile = path.join(root, 'custom-config.json');
      if (kind === 'invalid-version') await writeFile(path.join(root, 'package.json'), '{"version":"not-a-version"}');
      const manager = factory(overrides);
      const state = await manager.check();
      equal(state.canInstall, false, kind);
      truthy(state.installReason, kind);
      if (kind !== 'invalid-version') {
        equal(state.latestVersion, VERSION);
        await rejectsCode(() => manager.install({ version: VERSION }), 'UPDATE_MANUAL_ONLY');
      }
      equal(jobs.length, 0);
    });
  }
  await fixture({}, async ({ root, factory }) => {
    await mkdir(path.join(root, '.git'));
    const nested = path.join(root, 'nested-portable');
    await mkdir(path.join(nested, 'scripts'), { recursive: true });
    await writeFile(path.join(nested, 'package.json'), '{"version":"0.2.0"}');
    await writeFile(path.join(nested, 'qq-bridge.exe'), 'mock exe');
    await writeFile(path.join(nested, 'scripts', 'install-update.ps1'), HELPER);
    const state = await factory({ projectRoot: nested }).check();
    equal(state.canInstall, false);
    truthy(state.installReason.includes('git pull'));
  });
});

await test('Windows 8.3 aliases allow checks, settings and a verified mocked installation', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP native 8.3 alias regression requires Windows.');
    return;
  }
  await fixture({}, async ({ root, factory, jobs }) => {
    const canonical = await realpath(root);
    const short = windowsShortPath(canonical);
    equal((await realpath(short)).toLowerCase(), canonical.toLowerCase());
    if (short.toLowerCase() === canonical.toLowerCase()) {
      console.log('SKIP this volume does not provide an 8.3 alias for the fixture.');
      return;
    }
    truthy(/~\d/.test(short), 'GetShortPathNameW returned an actual 8.3 alias.');
    const manager = factory({
      projectRoot: short,
      stateDir: path.join(canonical, 'state'),
      configFile: path.join(canonical, 'config.json'),
    });
    equal((await manager.check()).canInstall, true);
    equal((await manager.setAutomatic(false)).automatic, false);
    await manager.install({ version: VERSION });
    await until(async () => (await manager.status()).phase === 'installing');
    equal(jobs.length, 1);
    equal(jobs[0].job.projectRoot, canonical);
    equal(path.dirname(jobs[0].job.packagePath), path.join(canonical, 'state', 'updates', jobs[0].job.jobId));
    equal(await readFile(jobs[0].job.packagePath), ZIP);
    equal(JSON.parse(await readFile(path.join(canonical, 'state', 'updates', 'settings.json'), 'utf8')).automatic, false);
    const restored = factory({ projectRoot: short });
    equal((await restored.status()).automatic, false);
    equal((await restored.status()).canInstall, false);
  });
});

await test('junctions at the root, ancestor or update directory remain forbidden', async () => {
  for (const location of ['root', 'ancestor', 'state', 'updates', 'helper-parent']) {
    await fixture({}, async ({ root, factory, jobs }) => {
      const target = path.join(root, 'unlinked-target');
      await mkdir(target);
      await writeFile(path.join(target, 'keep.txt'), 'untouched');
      const overrides = {};
      if (location === 'root' || location === 'ancestor') {
        const portable = location === 'root' ? target : path.join(target, 'app');
        await mkdir(path.join(portable, 'scripts'), { recursive: true });
        await writeFile(path.join(portable, 'package.json'), '{"version":"0.2.0"}');
        await writeFile(path.join(portable, 'qq-bridge.exe'), 'mock exe');
        await writeFile(path.join(portable, 'scripts', 'install-update.ps1'), HELPER);
        const alias = path.join(root, 'linked-root');
        await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
        overrides.projectRoot = location === 'root' ? alias : path.join(alias, 'app');
      } else if (location === 'state' || location === 'updates') {
        const link = path.join(root, 'state', ...(location === 'updates' ? ['updates'] : []));
        if (location === 'updates') await mkdir(path.dirname(link));
        await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await rm(path.join(root, 'scripts', 'install-update.ps1'));
        await rmdir(path.join(root, 'scripts'));
        await writeFile(path.join(target, 'install-update.ps1'), HELPER);
        await symlink(target, path.join(root, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      const manager = factory(overrides);
      const status = await manager.check();
      equal(status.canInstall, false, location);
      await rejectsCode(() => manager.install({ version: VERSION }), 'UPDATE_MANUAL_ONLY');
      if (location !== 'helper-parent') await rejectsCode(() => manager.setAutomatic(false), 'UPDATE_UNSAFE_PATH');
      equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'untouched', location);
      equal(jobs.length, 0, location);
      truthy(!(await readdir(target)).includes('settings.json'), location);
    });
  }
});

await test('release asset names and URLs are never accepted from arbitrary sources', async () => {
  for (const change of [
    (data) => { data.assets = []; },
    (data) => { data.assets.push({ ...data.assets[0] }); },
    (data) => { data.assets[0].browser_download_url = 'https://example.com/portable.zip'; },
    (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace(REPO, 'attacker/other'); },
    (data) => { data.assets[0].browser_download_url += '?redirect=other'; },
    (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('https:', 'http:'); },
    (data) => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('github.com/', 'github.com:444/'); },
    (data) => { data.assets[0].size = 251 * 1024 * 1024; },
  ]) {
    const data = release();
    change(data);
    await fixture({ http: { data } }, async ({ manager, http }) => {
      const state = await manager.check();
      equal(state.phase, 'available');
      equal(state.canInstall, false);
      await rejectsCode(() => manager.install({ version: VERSION }), 'UPDATE_MANUAL_ONLY');
      equal(http.calls.length, 1);
    });
  }
});

await test('verified download copies trusted helper and starts exactly one job', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  await fixture({ http: { route: async (url) => {
    if (url.endsWith('/SHA256SUMS.txt')) {
      await gate;
      return new Response(SUMS);
    }
  } } }, async ({ root, manager, jobs, http }) => {
    await manager.check();
    const state = await manager.install({ version: VERSION, url: 'https://attacker.example/', path: '../ignored' });
    equal(state.phase, 'downloading');
    equal(state.progress, 0);
    equal((await manager.install({ version: VERSION })).phase, 'downloading');
    await rejectsCode(() => manager.install({ version: '0.4.0' }), 'UPDATE_NOT_AVAILABLE');
    finish();
    await until(async () => (await manager.status()).phase === 'installing');
    equal(jobs.length, 1);
    const { scriptPath, jobPath, job, cwd } = jobs[0];
    const expectedDir = path.join(root, 'state', 'updates', job.jobId);
    equal(cwd, expectedDir);
    equal(path.dirname(scriptPath), expectedDir);
    equal(path.dirname(jobPath), expectedDir);
    equal(path.dirname(job.packagePath), expectedDir);
    equal(await readFile(scriptPath, 'utf8'), HELPER);
    equal(await readFile(job.packagePath), ZIP);
    equal(JSON.parse(await readFile(jobPath, 'utf8')), job);
    equal(job.schemaVersion, 1);
    equal(job.consolePid, process.pid);
    equal(job.projectRoot, root);
    equal(job.resultPath, path.join(root, 'state', 'updates', 'result.json'));
    equal(job.expectedSha256, HASH);
    equal(job.version, VERSION);
    equal(JSON.parse(await readFile(path.join(root, 'state', 'updates', 'install.lock'), 'utf8')).jobId, job.jobId);
    equal((await manager.status()).progress, 100);
    equal(http.calls.length, 3);
    await manager.check();
    equal(http.calls.length, 3);
  });
});

await test('multiple consoles share a lock and stalled installers cannot restart', async () => {
  let time = Date.parse('2026-10-20T00:00:00Z');
  await fixture({ manager: { now: () => time, installationTimeoutMs: 1000 } }, async ({ manager, factory, jobs }) => {
    const second = factory();
    await Promise.all([manager.check(), second.check()]);
    await Promise.all([manager.install({ version: VERSION }), second.install({ version: VERSION })]);
    await until(async () => {
      const states = await Promise.all([manager.status(), second.status()]);
      return states.some((state) => state.phase === 'installing') && states.some((state) => state.phase === 'error');
    });
    equal(jobs.length, 1);
    const managers = [manager, second];
    const successful = (await manager.status()).phase === 'installing' ? manager : second;
    const locked = managers.find((item) => item !== successful);
    equal((await locked.status()).canInstall, false);
    await rejectsCode(() => locked.install({ version: VERSION }), 'UPDATE_LOCKED');
    time += 1001;
    const stalled = await successful.status();
    equal(stalled.phase, 'error');
    equal(stalled.canInstall, false);
    truthy(stalled.error.includes('尚未报告'));
    await rejectsCode(() => successful.install({ version: VERSION }), 'UPDATE_LOCKED');
    equal(jobs.length, 1);
  });
});

await test('download rejects bad checksum, duplicate checksum and truncated files', async () => {
  for (const kind of ['hash', 'duplicate', 'missing', 'truncated', 'stream-overflow', 'declared-overflow', 'launch']) {
    const http = {};
    const managerOptions = {};
    if (kind === 'hash') http.zip = Buffer.alloc(ZIP.length, 0x61);
    if (kind === 'duplicate') http.manifest = SUMS + SUMS.replace(/^\uFEFF/, '');
    if (kind === 'missing') http.manifest = `${HASH}  different.zip`;
    if (kind === 'truncated') http.zip = ZIP.subarray(0, 4);
    if (kind === 'stream-overflow') http.zip = Buffer.concat([ZIP, Buffer.from('extra')]);
    if (kind === 'declared-overflow') http.route = async (url) => url.endsWith('.zip')
      ? new Response(ZIP, { headers: { 'content-length': String(1024 * 1024 * 1024) } }) : null;
    if (kind === 'launch') managerOptions.launchInstaller = async () => { throw new Error('mock spawn failed at private path'); };
    await fixture({ http, manager: managerOptions }, async ({ root, manager, jobs }) => {
      await manager.check();
      await manager.install({ version: VERSION });
      const state = await until(async () => {
        const result = await manager.status();
        return result.phase === 'error' && result;
      });
      truthy(state.error, kind);
      truthy(!state.error.includes('private path'), kind);
      equal(jobs.length, 0, kind);
      await until(async () => {
        const entries = await readdir(path.join(root, 'state', 'updates'));
        return entries.length === 0;
      });
      equal(await readdir(path.join(root, 'state', 'updates')), [], kind);
    });
  }
});

await test('only a finite GitHub asset redirect chain is followed', async () => {
  for (const destination of [
    'http://release-assets.githubusercontent.com/file.zip',
    'https://release-assets.githubusercontent.com.evil.example/file.zip',
    'https://user:password@release-assets.githubusercontent.com/file.zip',
    'https://127.0.0.1/file.zip',
    `https://github.com/attacker/other/releases/download/v1/file.zip`,
  ]) {
    await fixture({ http: { route: async (url) => url.endsWith('.zip')
      ? new Response(null, { status: 302, headers: { location: destination } }) : null } }, async ({ manager, jobs, http }) => {
      await manager.check();
      await manager.install({ version: VERSION });
      const state = await until(async () => {
        const value = await manager.status();
        return value.phase === 'error' && value;
      });
      truthy(state.error.includes('不受信任'));
      equal(jobs.length, 0);
      equal(http.calls.length, 3);
    });
  }
  const destination = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sig=mock';
  await fixture({ http: { route: async (url) => {
    if (url.endsWith('.zip')) return new Response(null, { status: 302, headers: { location: destination } });
    if (url === destination) return new Response(ZIP);
  } } }, async ({ manager, jobs, http }) => {
    await manager.check();
    await manager.install({ version: VERSION });
    await until(async () => (await manager.status()).phase === 'installing');
    equal(jobs.length, 1);
    equal(http.calls.at(-1).url, destination);
    truthy(!('Authorization' in http.calls.at(-1).options.headers));
  });
  await fixture({ http: { route: async (url) => {
    if (url.endsWith('.zip') || url === destination) return new Response(null, { status: 302, headers: { location: destination } });
  } } }, async ({ manager, http }) => {
    await manager.check();
    await manager.install({ version: VERSION });
    await until(async () => (await manager.status()).phase === 'error');
    equal(http.calls.length, 6);
  });
});

await test('HTTP errors, oversized API JSON and timeout are isolated and cached', async () => {
  for (const kind of ['403', '429', 'redirect', 'invalid-json', 'oversized', 'timeout']) {
    let apiResponse;
    let route;
    if (kind === '403' || kind === '429') apiResponse = () => new Response('', { status: Number(kind) });
    if (kind === 'redirect') apiResponse = () => new Response(null, { status: 302, headers: { location: API } });
    if (kind === 'invalid-json') apiResponse = () => new Response('{');
    if (kind === 'oversized') apiResponse = () => new Response('x'.repeat(1024 * 1024 + 1));
    if (kind === 'timeout') route = async (url) => url === API ? new Promise(() => {}) : null;
    await fixture({ http: { apiResponse, route }, manager: { requestTimeoutMs: 30, log: () => { throw new Error('logger failed'); } } }, async ({ manager, http }) => {
      const state = await manager.check();
      equal(state.phase, 'error', kind);
      truthy(state.error, kind);
      equal(state.canInstall, false, kind);
      await manager.check();
      equal(http.calls.length, 1, kind);
    });
  }
});

await test('logger objects receive update failures without interrupting checks', async () => {
  const messages = [];
  await fixture({
    http: { apiResponse: () => new Response('', { status: 403 }) },
    manager: { log: { info: (message) => messages.push(message) } },
  }, async ({ manager }) => {
    equal((await manager.check()).phase, 'error');
    truthy(messages.some((message) => message.includes('GitHub')));
  });
});

await test('automatic setting persists and background checks use bounded timers', async () => {
  const timers = new Set();
  const setTimeoutImpl = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.add(timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => { timers.delete(timer); };
  await fixture({ manager: { setTimeoutImpl, clearTimeoutImpl } }, async ({ root, manager, http, factory }) => {
    await manager.start();
    await manager.start();
    equal(timers.size, 1);
    equal([...timers][0].delay, 20_000);
    equal(http.calls.length, 0);
    const first = [...timers][0];
    timers.delete(first);
    await first.callback();
    equal(http.calls.length, 1);
    equal(timers.size, 1);
    equal([...timers][0].delay, 6 * 60 * 60 * 1000);
    equal((await manager.setAutomatic(false)).automatic, false);
    equal(timers.size, 0);
    equal(JSON.parse(await readFile(path.join(root, 'state', 'updates', 'settings.json'), 'utf8')).automatic, false);
    const restored = factory();
    equal((await restored.status()).automatic, false);
    await restored.start();
    equal(timers.size, 0);
    await manager.setAutomatic(true);
    equal(timers.size, 1);
    await rejectsCode(() => manager.setAutomatic('false'), 'UPDATE_BAD_SETTINGS');
    manager.stop();
    equal(timers.size, 0);
  });
});

await test('cache expires, corrupt settings recover and installer results remain local', async () => {
  let time = Date.parse('2026-10-20T00:00:00Z');
  await fixture({ manager: { now: () => time } }, async ({ manager, http }) => {
    await manager.check();
    time += 59_000;
    await manager.check();
    equal(http.calls.length, 1);
    time += 1001;
    await manager.check();
    equal(http.calls.length, 2);
    equal((await manager.status()).checkedAt, new Date(time).toISOString());
  });
  for (const kind of ['complete', 'error', 'wrong-version']) {
    await fixture({}, async ({ root, factory, http }) => {
      await mkdir(path.join(root, 'state', 'updates'), { recursive: true });
      await writeFile(path.join(root, 'state', 'updates', 'settings.json'), '{bad json');
      await writeFile(path.join(root, 'state', 'updates', 'result.json'), JSON.stringify({
        schemaVersion: 1, jobId: 'fixture-job-1234', version: kind === 'wrong-version' ? '0.3.0' : '0.2.0',
        phase: kind === 'error' ? 'error' : 'complete',
        completedAt: '2026-10-20T00:00:00Z', error: kind === 'error' ? '安装失败，已恢复原版本。' : undefined,
      }));
      const manager = factory();
      const state = await manager.status();
      equal(state.phase, kind === 'complete' ? 'complete' : kind === 'error' ? 'error' : 'idle');
      equal(state.automatic, true);
      equal(http.calls.length, 0);
      if (kind === 'error') truthy(state.error);
    });
  }
});

await test('restarted console receives its late completion after the health request', async () => {
  await fixture({}, async ({ root, factory, http }) => {
    const updates = path.join(root, 'state', 'updates');
    const jobId = 'late-completion-1234';
    await mkdir(updates, { recursive: true });
    await writeFile(path.join(updates, 'install.lock'), JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', projectRoot: root,
    }));
    const manager = factory();
    equal((await manager.status()).phase, 'idle');
    await writeFile(path.join(updates, 'result.json'), JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', phase: 'complete',
      completedAt: '2026-10-20T00:00:01Z',
    }));
    await rm(path.join(updates, 'install.lock'));
    equal((await manager.status()).phase, 'complete');
    equal((await manager.status()).progress, 100);
    equal((await manager.status()).error, null);
    equal(http.calls.length, 0);
  });
});

await test('late results cannot replace an active check or a newer available release', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  await fixture({ http: { route: async (url) => {
    if (url === API) {
      await gate;
      return new Response(JSON.stringify(release()));
    }
  } } }, async ({ root, factory, http }) => {
    const updates = path.join(root, 'state', 'updates');
    const jobId = 'late-result-1234';
    await mkdir(updates, { recursive: true });
    await writeFile(path.join(updates, 'install.lock'), JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', projectRoot: root,
    }));
    const manager = factory();
    equal((await manager.status()).phase, 'idle');
    const resultFile = path.join(updates, 'result.json');
    await writeFile(resultFile, JSON.stringify({
      schemaVersion: 1, jobId: 'unrelated-job-1234', version: '0.2.0', phase: 'error', error: 'stale unrelated failure',
    }));
    equal((await manager.status()).phase, 'idle');
    await writeFile(resultFile, JSON.stringify({
      schemaVersion: 1, jobId, version: '0.1.0', phase: 'complete',
    }));
    equal((await manager.status()).phase, 'idle');
    const checking = manager.check();
    await until(() => http.calls.length === 1);
    await writeFile(resultFile, JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', phase: 'complete',
    }));
    equal((await manager.status()).phase, 'checking');
    finish();
    equal((await checking).phase, 'available');
    equal((await manager.status()).phase, 'available');
    await writeFile(resultFile, JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', phase: 'error', error: 'late old failure',
    }));
    const state = await manager.status();
    equal(state.phase, 'available');
    equal(state.latestVersion, VERSION);
    equal(state.error, null);
  });
});

console.log(`\n通过 ${assertions} 项断言，失败 ${failures} 项。`);
if (failures) process.exitCode = 1;
