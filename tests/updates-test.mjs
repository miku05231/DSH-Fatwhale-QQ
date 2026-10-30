import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
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
  const root = await mkdtemp(path.join(temporary, options.apostrophe ? "qq update with space-[path]'" : 'qq update with space-'));
  const managers = [];
  let actionError;
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
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    for (const manager of managers) manager.stop();
    const absolute = path.resolve(root);
    assert.ok(path.dirname(absolute) === temporary && path.basename(absolute).startsWith('qq update with space-'));
    try {
      await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupError) {
      if (actionError) throw new AggregateError([actionError, cleanupError], 'Update fixture failed and could not be removed', { cause: actionError });
      throw cleanupError;
    }
  }
}

async function test(name, action) {
  try {
    await action();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}:`, error);
  }
}

function windowsShortPath(value) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$filesystem = New-Object -ComObject Scripting.FileSystemObject
[Console]::Write($filesystem.GetFolder($env:QQ_UPDATE_TEST_PATH).ShortPath)
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

async function sourceFixture(options, action) {
  await fixture({ http: { data: release(VERSION, { assets: [] }) } }, async (f) => {
    await mkdir(path.join(f.root, '.git'));
    for (const relative of ['launcher/bootstrap.ps1', 'launcher/Launcher.ps1', 'src/index.js', 'src/webui/server.mjs']) {
      await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
      await writeFile(path.join(f.root, relative), '// source fixture');
    }
    const calls = [];
    let dirty = false;
    const runGit = async (args) => {
      calls.push(args);
      if (options?.fail === args[0]) throw new Error('Isolated Git failure.');
      if (args[0] === 'status') return dirty ? ' M src/index.js' : '';
      if (args[0] === 'symbolic-ref') return 'refs/heads/main';
      if (args[0] === 'show') return JSON.stringify({ name: 'qq-bridge', version: options?.version || VERSION });
      if (args[0] === 'rev-parse') {
        if (args.includes('--show-toplevel')) return f.root;
        return args.at(-1) === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40);
      }
      return '';
    };
    const manager = f.factory({ runGit, ...options?.manager });
    await action({ ...f, manager, calls, setDirty: () => { dirty = true; } });
  });
}

await test('the production Git runner recognizes a real source checkout and detects local edits', async () => {
  await fixture({}, async ({ root, factory }) => {
    const files = ['launcher/bootstrap.ps1', 'launcher/Launcher.ps1', 'src/index.js', 'src/webui/server.mjs'];
    for (const relative of files) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), '// source fixture');
    }
    for (const args of [
      ['init', '-b', 'main'],
      ['add', '--', 'package.json', 'scripts/install-update.ps1', ...files],
      ['-c', 'user.name=Updater Test', '-c', 'user.email=updater@example.invalid', 'commit', '-m', 'Installed version'],
    ]) {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      equal(result.status, 0, result.stderr || result.error?.message);
    }
    const clean = await factory().check();
    equal(clean.installMode, 'source');
    equal(clean.canInstall, true);
    await writeFile(path.join(root, 'src/index.js'), '// local edit');
    const dirty = await factory().check();
    equal(dirty.canInstall, false);
    truthy(dirty.installReason.includes('未提交'));
  });
});

await test('clean source checkout installs the exact release tag without requiring portable assets', async () => {
  await sourceFixture({}, async ({ manager, calls, jobs, http, root }) => {
    const state = await manager.check();
    equal(state.installMode, 'source');
    equal(state.canInstall, true);
    equal(state.installReason, null);
    equal((await manager.install({ version: VERSION })).phase, 'downloading');
    await until(() => jobs.length === 1);
    const { job } = jobs[0];
    equal(job.mode, 'source');
    equal(job.originalCommit, 'a'.repeat(40));
    equal(job.targetCommit, 'b'.repeat(40));
    equal(job.branch, 'refs/heads/main');
    equal(job.sourceRef, `refs/qq-bridge-updates/${job.jobId}`);
    equal(job.packagePath, undefined);
    equal(calls.find((args) => args[0] === 'fetch'), [
      'fetch', '--no-tags', '--no-recurse-submodules', `https://github.com/${REPO}.git`,
      `refs/tags/v${VERSION}:${job.sourceRef}`,
    ]);
    equal(http.calls.length, 1, 'Source installation only requests release metadata over HTTP.');
    equal(await readFile(jobs[0].scriptPath, 'utf8'), HELPER);
    truthy((await readFile(jobs[0].jobPath, 'utf8')).includes('"mode": "source"'));
    equal((await manager.status()).phase, 'installing');
    equal(JSON.parse(await readFile(path.join(root, 'state/updates/install.lock'), 'utf8')).jobId, job.jobId);
  });
});

await test('source changes before checking or after confirmation prevent installation', async () => {
  for (const beforeCheck of [true, false]) {
    await sourceFixture({}, async ({ manager, setDirty, jobs, calls }) => {
      if (beforeCheck) setDirty();
      const state = await manager.check();
      equal(state.canInstall, !beforeCheck);
      if (beforeCheck) {
        truthy(state.installReason.includes('未提交'));
        await rejectsCode(() => manager.install({ version: VERSION }), 'UPDATE_MANUAL_ONLY');
      } else {
        setDirty();
        await manager.install({ version: VERSION });
        const failed = await until(async () => {
          const value = await manager.status();
          return value.phase === 'error' && value;
        });
        truthy(failed.error.includes('未提交'));
      }
      equal(jobs.length, 0);
      equal(calls.filter((args) => args[0] === 'fetch').length, 0);
    });
  }
});

await test('source fetch, divergent history, mismatched versions and installer launch failures release the lock', async () => {
  for (const options of [
    { fail: 'fetch' }, { fail: 'merge-base' }, { version: '9.9.9' },
    { manager: { launchInstaller: async () => { throw new Error('Cannot launch.'); } } },
  ]) {
    await sourceFixture(options, async ({ manager, root, jobs, calls }) => {
      await manager.check();
      await manager.install({ version: VERSION });
      const failed = await until(async () => {
        const value = await manager.status();
        return value.phase === 'error' && value.canInstall && value;
      });
      truthy(failed.error);
      await until(async () => !(await readdir(path.join(root, 'state/updates'))).includes('install.lock'));
      equal(jobs.length, 0);
      truthy(calls.some((args) => args[0] === 'update-ref' && args[1] === '-d'));
    });
  }
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
    truthy(/~\d/.test(short), 'Windows returned an actual 8.3 alias.');
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

await test('a stale installer lock from a dead process is recovered, while a live or in-progress lock is retained', async () => {
  await fixture({}, async ({ root, factory }) => {
    const updates = path.join(root, 'state', 'updates');
    await mkdir(updates, { recursive: true });
    const jobId = 'stale-lock-1234';
    await writeFile(path.join(updates, 'install.lock'), JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', projectRoot: root, consolePid: 999999999,
    }));
    await writeFile(path.join(updates, 'result.json'), JSON.stringify({
      schemaVersion: 1, jobId, version: '0.2.0', phase: 'error', error: 'previous attempt failed',
    }));
    const stale = factory();
    const staleStatus = await stale.status();
    equal(staleStatus.canInstall, false);
    equal(await readdir(updates).then((names) => names.includes('install.lock')), false);

    const liveJob = 'live-lock-1234';
    await writeFile(path.join(updates, 'install.lock'), JSON.stringify({
      schemaVersion: 1, jobId: liveJob, version: '0.2.0', projectRoot: root, consolePid: process.pid,
    }));
    const live = factory();
    await live.status();
    equal(await readdir(updates).then((names) => names.includes('install.lock')), true);
    await rm(path.join(updates, 'install.lock'), { force: true });

    const activeJob = 'active-lock-1234';
    await writeFile(path.join(updates, 'install.lock'), JSON.stringify({
      schemaVersion: 1, jobId: activeJob, version: '0.2.0', projectRoot: root, consolePid: 999999999,
    }));
    await mkdir(path.join(updates, activeJob), { recursive: true });
    await writeFile(path.join(updates, activeJob, 'result.json'), JSON.stringify({
      schemaVersion: 1, jobId: activeJob, version: '0.2.0', phase: 'installing',
    }));
    const active = factory();
    await active.status();
    equal(await readdir(updates).then((names) => names.includes('install.lock')), true);
  });
});

await test('Windows installer executes after its launching console exits', async () => {
  if (process.platform !== 'win32') return;
  await fixture({ apostrophe: true }, async ({ root }) => {
    const marker = path.join(root, 'installer-ran.txt');
    await writeFile(path.join(root, 'scripts', 'install-update.ps1'), `
param([string]$JobPath)
$ErrorActionPreference = 'Stop'
$consolePid = (Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json).consolePid
$console = [Diagnostics.Process]::GetProcessById($consolePid)
[IO.File]::WriteAllText((Join-Path (Split-Path (Split-Path (Split-Path (Split-Path $JobPath)))) 'installer-started.txt'), [string]$PID)
try {
  if (-not $console.WaitForExit(65000)) { throw 'The launching console did not exit.' }
} finally { $console.Dispose() }
[IO.File]::WriteAllText((Join-Path (Split-Path (Split-Path (Split-Path (Split-Path $JobPath)))) 'installer-ran.txt'), 'executed')
Start-Sleep -Milliseconds 1000
`);
    const childCode = `
import { createUpdateManager } from ${JSON.stringify(new URL('../src/updates.mjs', import.meta.url).href)};
import { existsSync, readFileSync, readdirSync } from 'node:fs';
const manager = createUpdateManager({
  projectRoot: ${JSON.stringify(root)}, platform: 'win32', isDocker: false,
  fetchImpl: async url => new Response(url.endsWith('/latest') ? ${JSON.stringify(JSON.stringify(release()))} : url.endsWith('.zip') ? Buffer.from(${JSON.stringify([...ZIP])}) : ${JSON.stringify(SUMS)}),
});
await manager.check();
await manager.install({ version: ${JSON.stringify(VERSION)} });
const launchDeadline = Date.now() + 60_000;
while (Date.now() < launchDeadline) {
  const status = await manager.status();
  if (status.phase === 'installing' && existsSync(${JSON.stringify(path.join(root, 'installer-started.txt'))})) process.exit(0);
  if (status.phase === 'error') throw new Error(status.error);
  await new Promise(resolve => setTimeout(resolve, 25));
}
const updates = ${JSON.stringify(path.join(root, 'state', 'updates'))};
const diagnostics = readdirSync(updates, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
  try { return readFileSync(updates + '/' + entry.name + '/installer.stderr.log', 'utf8').slice(-4096); }
  catch { return 'Installer stderr unavailable'; }
});
throw new Error('Installer did not launch within 60 seconds: ' + JSON.stringify({ status: await manager.status(), diagnostics }));
`;
    // A detached installer must not keep spawnSync's capture pipes open after
    // the console exits. Capture diagnostics in files instead of inherited pipes.
    const stdoutPath = path.join(root, 'console.stdout.log');
    const stderrPath = path.join(root, 'console.stderr.log');
    const stdout = await open(stdoutPath, 'w');
    const stderr = await open(stderrPath, 'w');
    let child;
    try {
      child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
        stdio: ['ignore', stdout.fd, stderr.fd], windowsHide: true, timeout: 75_000,
      });
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
    const diagnostics = await readFile(stderrPath, 'utf8');
    equal(child.error, undefined, diagnostics || child.error?.message);
    equal(child.status, 0, diagnostics);
    try {
      await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'executed', 30_000);
    } catch (error) {
      const updates = path.join(root, 'state', 'updates');
      for (const entry of await readdir(updates, { withFileTypes: true })) {
        if (entry.isDirectory()) console.error(await readFile(path.join(updates, entry.name, 'installer.stderr.log'), 'utf8').catch(() => 'No installer output'));
      }
      throw error;
    }
    equal(await readFile(marker, 'utf8'), 'executed');
    // Writing the completion marker can precede PowerShell releasing its cwd
    // and redirected log handles. Wait for this fixture's helper before removal.
    const helperPid = Number(await readFile(path.join(root, 'installer-started.txt'), 'utf8'));
    truthy(Number.isSafeInteger(helperPid) && helperPid > 0);
    await until(() => {
      try { process.kill(helperPid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, 60_000);
  });
});

console.log(`\n通过 ${assertions} 项断言，失败 ${failures} 项。`);
if (failures) process.exitCode = 1;
