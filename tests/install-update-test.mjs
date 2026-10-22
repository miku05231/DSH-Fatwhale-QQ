import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install-update.ps1');
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const VERSION = '0.2.0';
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "qq-update-中文 space's-"));
const TEMP_PARENT = fs.realpathSync.native(path.dirname(TEMP));
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex < 0 ? '' : String(process.argv[onlyIndex + 1] ?? '');
const groupIndex = process.argv.indexOf('--group');
const group = groupIndex < 0 ? '' : String(process.argv[groupIndex + 1] ?? '');
const GROUPS = {
  '1': { start: 1, end: 15 },
  '2': { start: 16, end: 30 },
  '3': { start: 31, end: 45 },
  '4': { start: 46, end: 60 },
};
if (group && !Object.hasOwn(GROUPS, group)) {
  console.error(`Unknown installer test group: ${group}`);
  process.exit(2);
}
let passed = 0;
let failed = 0;
let registered = 0;
let selected = 0;

function cleanupTempDirectory(root, expectedParent) {
  const entry = fs.lstatSync(root);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Cleanup root must be a real directory.');
  const canonical = fs.realpathSync.native(root);
  assert.equal(path.dirname(canonical), expectedParent, 'Cleanup must stay within the original temporary parent.');
  assert.equal(path.basename(canonical), path.basename(root), 'Cleanup directory name must match the original fixture.');
  assert.ok(path.basename(canonical).startsWith('qq-update-'), 'Cleanup requires the test fixture prefix.');
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(canonical, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(delay, 0, 0, (attempt + 1) * 100);
    }
  }
}

function fixtureProcessAlive(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try { process.kill(child.pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function startFixtureHolder(code, logPath) {
  const log = fs.openSync(logPath, 'a');
  try {
    const command = `$ErrorActionPreference = 'Stop'\n${code}`;
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')], {
      stdio: ['ignore', log, log], windowsHide: true,
    });
    child.on('error', (error) => {
      console.error(`Isolated holder could not start: ${error.stack ?? error}`);
    });
    return child;
  } finally { fs.closeSync(log); }
}

function holderDiagnostic(child, logPath) {
  return `PID ${child.pid ?? 'unavailable'}\n${fs.readFileSync(logPath, 'utf8')}`;
}

function waitForHolderReady(child, ready, logPath, timeoutMs = 60_000) {
  const started = Date.now();
  const delay = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - started < timeoutMs) {
    if (!fixtureProcessAlive(child)) {
      throw new Error(`Isolated holder exited before readiness:\n${holderDiagnostic(child, logPath)}`);
    }
    if (fs.existsSync(ready)) return;
    Atomics.wait(delay, 0, 0, 50);
  }
  throw new Error(`Isolated holder was not ready after ${timeoutMs}ms:\n${holderDiagnostic(child, logPath)}`);
}

function stopFixtureProcess(child, release) {
  if (release) fs.writeFileSync(release, 'release');
  else if (fixtureProcessAlive(child)) child.kill();
  const delay = new Int32Array(new SharedArrayBuffer(4));
  let deadline = Date.now() + 5000;
  while (fixtureProcessAlive(child) && Date.now() < deadline) Atomics.wait(delay, 0, 0, 50);
  if (fixtureProcessAlive(child)) {
    child.kill();
    deadline = Date.now() + 5000;
    while (fixtureProcessAlive(child) && Date.now() < deadline) Atomics.wait(delay, 0, 0, 50);
  }
  assert.equal(fixtureProcessAlive(child), false, `Isolated fixture process ${child.pid} did not exit.`);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP entries make unsafe names and Unix link attributes reproducible without npm.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const data = Buffer.from(item.body ?? '');
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(item.compressedLength ?? data.length, 18);
    header.writeUInt32LE(item.length ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(item.compressedLength ?? data.length, 20);
    directory.writeUInt32LE(item.length ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(item.attrs ?? 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function write(root, rel, body) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function shortPath(target) {
  const code = [
    `Add-Type -Namespace QQUpdateTest -Name NativePath -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint="GetShortPathNameW", CharSet=System.Runtime.InteropServices.CharSet.Unicode, ExactSpelling=true, SetLastError=true)] public static extern uint GetShortPathName(string path, System.Text.StringBuilder result, uint length);'`,
    '$buffer = New-Object Text.StringBuilder 32768',
    `$length = [QQUpdateTest.NativePath]::GetShortPathName('${target.replaceAll("'", "''")}', $buffer, 32768)`,
    "if ($length -eq 0 -or $length -ge 32768) { throw 'Cannot obtain short path for the regression fixture.' }",
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($buffer.ToString())))',
  ].join('\r\n');
  const result = spawnSync(PS, ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.error?.stack ?? ''}`);
  return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
}

const application = {
  'package.json': JSON.stringify({ name: 'qq-bridge', version: VERSION }),
  'qq-bridge.exe': 'new launcher',
  'launcher/bootstrap.ps1': '# new bootstrap',
  'launcher/Launcher.ps1': '# new tray',
  'src/index.js': '// new bridge',
  'src/webui/server.mjs': '// new console',
  'README.md': 'new readme',
};

function fixture(name, { config = {}, entries = [], alter = (items) => items, patchJob = {} } = {}) {
  const root = path.join(TEMP, name);
  for (const [rel, body] of Object.entries(application)) write(root, rel, `old ${body}`);
  write(root, 'package.json', JSON.stringify({ name: 'qq-bridge', version: '0.1.0' }));
  write(root, 'config.json', JSON.stringify(config));
  for (const rel of ['state/personas/active.json', 'state/stickers/image.png', 'logs/test.log', 'qq-workspace/AGENTS.md', '记忆库/note.md', 'napcat/config/account.json', 'src/user-added.js']) {
    write(root, rel, `keep ${rel}`);
  }
  const jobId = randomUUID();
  const jobDir = path.join(root, 'state', 'updates', jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const packagePath = path.join(jobDir, 'portable.zip');
  const items = Object.entries(application).map(([rel, body]) => ({ name: `qq-bridge-${VERSION}/${rel}`, body }));
  const data = zip(alter([...items, ...entries]));
  fs.writeFileSync(packagePath, data);
  fs.copyFileSync(SCRIPT, path.join(jobDir, 'install-update.ps1'));
  const resultPath = path.join(root, 'state', 'updates', 'result.json');
  const job = {
    schemaVersion: 1, jobId, projectRoot: root, packagePath,
    expectedSha256: createHash('sha256').update(data).digest('hex'),
    version: VERSION, consolePid: 0, resultPath, ...patchJob,
  };
  const jobPath = path.join(jobDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify(job));
  write(root, 'state/updates/install.lock', JSON.stringify({ jobId }));
  return { root, job, jobDir, jobPath, resultPath };
}

function run(f, extra = [], { skipProcesses = true, skipRestart = true } = {}) {
  const result = spawnSync(PS, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.executionJobDir ?? f.jobDir, 'install-update.ps1'),
    '-JobPath', f.executionJobPath ?? f.jobPath, ...(skipProcesses ? ['-SkipProcessActions'] : []), ...(skipRestart ? ['-SkipRestart'] : []), ...extra,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 90_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ASK_YESNO: 'false' },
  });
  if (result.error) throw result.error;
  let state;
  if (fs.existsSync(f.resultPath)) state = JSON.parse(fs.readFileSync(f.resultPath, 'utf8').replace(/^\uFEFF/, ''));
  const stateDiagnostic = state ? `\nUpdate result: ${JSON.stringify(state)}` : '\nNo update result was written.';
  return { code: result.status, state, output: `${result.stdout}${result.stderr}${stateDiagnostic}` };
}

function sourceGit(f, ...args) {
  const result = spawnSync('git', ['-C', f.root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function sourceFixture(name, { config = {}, installedFiles = {}, targetFiles = {} } = {}) {
  const f = fixture(name, { config });
  for (const [rel, body] of Object.entries(installedFiles)) write(f.root, rel, body);
  sourceGit(f, 'init', '-b', 'main');
  sourceGit(f, 'config', 'user.name', 'Updater Test');
  sourceGit(f, 'config', 'user.email', 'updater@example.invalid');
  sourceGit(f, 'config', 'core.autocrlf', 'false');
  write(f.root, '.gitignore', 'state/\nconfig.json\nlogs/\nqq-workspace/\nnapcat/\n记忆库/\n');
  const managed = ['.gitignore', ...Object.keys(application).filter((rel) => rel !== 'qq-bridge.exe')];
  sourceGit(f, 'add', '--', ...managed);
  sourceGit(f, 'commit', '-m', 'Installed application');
  const originalCommit = sourceGit(f, 'rev-parse', 'HEAD');
  for (const [rel, body] of Object.entries({ ...application, ...targetFiles })) write(f.root, rel, body);
  sourceGit(f, 'add', '--', ...managed, ...Object.keys(targetFiles));
  sourceGit(f, 'commit', '-m', 'Release update');
  const targetCommit = sourceGit(f, 'rev-parse', 'HEAD');
  const sourceRef = `refs/qq-bridge-updates/${f.job.jobId}`;
  sourceGit(f, 'update-ref', sourceRef, targetCommit);
  sourceGit(f, 'reset', '--keep', originalCommit);
  f.job = { ...f.job, mode: 'source', originalCommit, targetCommit, branch: 'refs/heads/main', sourceRef };
  fs.writeFileSync(f.jobPath, JSON.stringify(f.job));
  return f;
}

function unchanged(f) {
  assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), 'old // new bridge');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8')).version, '0.1.0');
}

function test(name, callback) {
  if (only && !name.includes(only)) return;
  registered += 1;
  if (group && (registered < GROUPS[group].start || registered > GROUPS[group].end)) return;
  selected += 1;
  try { callback(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack ?? error}`); }
}

if (process.platform !== 'win32') {
  console.log('SKIP portable installer integration requires Windows PowerShell 5.1.');
} else {
  try {
    test('PowerShell source keeps its UTF-8 BOM', () => {
      assert.equal(fs.readFileSync(SCRIPT).subarray(0, 3).toString('hex'), 'efbbbf');
    });
    test('source update fast-forwards and preserves ignored and untracked user files', () => {
      const f = sourceFixture('source-success');
      fs.rmSync(path.join(f.root, 'qq-bridge.exe'));
      const result = run(f);
      assert.equal(result.code, 0, result.output);
      assert.equal(result.state.phase, 'complete');
      assert.equal(sourceGit(f, 'rev-parse', 'HEAD'), f.job.targetCommit);
      assert.equal(sourceGit(f, 'symbolic-ref', 'HEAD'), f.job.branch);
      assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), application['src/index.js']);
      for (const rel of ['state/personas/active.json', 'src/user-added.js', '记忆库/note.md']) {
        assert.equal(fs.readFileSync(path.join(f.root, rel), 'utf8'), `keep ${rel}`);
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.jobDir, 'source-backup.json'))).commit, f.job.originalCommit);
      assert.ok(!fs.existsSync(path.join(f.root, 'state/updates/install.lock')));
    });
    test('source update refuses uncommitted tracked files', () => {
      const f = sourceFixture('source-dirty');
      write(f.root, 'src/index.js', '// keep local edit');
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /uncommitted/);
      assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), '// keep local edit');
      assert.equal(sourceGit(f, 'rev-parse', 'HEAD'), f.job.originalCommit);
    });
    test('source failure restores the original branch and code', () => {
      const f = sourceFixture('source-rollback');
      const result = run(f, ['-TestFailAfterFiles', '0']);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /Previous source commit was restored/);
      assert.equal(sourceGit(f, 'rev-parse', 'HEAD'), f.job.originalCommit);
      assert.equal(sourceGit(f, 'symbolic-ref', 'HEAD'), f.job.branch);
      unchanged(f);
    });
    test('source update refuses a branch changed after confirmation', () => {
      const f = sourceFixture('source-changed');
      sourceGit(f, 'switch', '-c', 'local-work');
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /branch changed/);
      unchanged(f);
    });
    test('source update never overwrites untracked files even when ignored', () => {
      const f = sourceFixture('source-untracked', { targetFiles: { 'src/new-file.js': '// release code' } });
      sourceGit(f, 'config', 'core.excludesFile', path.join(f.root, 'local-ignore.txt'));
      write(f.root, 'local-ignore.txt', 'src/new-file.js\n');
      write(f.root, 'src/new-file.js', '// private local file');
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.equal(sourceGit(f, 'rev-parse', 'HEAD'), f.job.originalCommit);
      assert.equal(fs.readFileSync(path.join(f.root, 'src/new-file.js'), 'utf8'), '// private local file');
      unchanged(f);
    });
    test('source merge with locked files preserves partial state for manual recovery without restarting', () => {
      const restartMarker = 'state/restart-attempted';
      const bootstrap = `[IO.File]::WriteAllText((Join-Path $PSScriptRoot '..\\${restartMarker.replaceAll('/', '\\')}'), 'unexpected restart'); exit 23`;
      const f = sourceFixture('source-partial-checkout', {
        installedFiles: { 'launcher/bootstrap.ps1': bootstrap, 'src/index.js': 'setInterval(() => {}, 1000);' },
        targetFiles: { 'launcher/bootstrap.ps1': bootstrap },
      });
      const bridge = spawn(process.execPath, [path.join(f.root, 'src/index.js')], { stdio: 'ignore', windowsHide: true });
      const ready = path.join(f.jobDir, 'lock-ready');
      const release = path.join(f.jobDir, 'lock-release');
      const holderLog = path.join(f.jobDir, 'lock-holder.log');
      const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
      const code = [
        `$file = [IO.File]::Open(${psQuote(path.join(f.root, 'src/webui/server.mjs'))}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`,
        'try {',
        `  [IO.File]::WriteAllText(${psQuote(ready)}, 'ready')`,
        '  $deadline = [DateTime]::UtcNow.AddSeconds(180)',
        `  while (-not [IO.File]::Exists(${psQuote(release)})) {`,
        "    if ([DateTime]::UtcNow -ge $deadline) { throw 'Isolated file holder exceeded its lifetime.' }",
        '    Start-Sleep -Milliseconds 100',
        '  }',
        '} finally { $file.Dispose() }',
      ].join('\n');
      const holder = startFixtureHolder(code, holderLog);
      let failure;
      try {
        assert.ok(bridge.pid && holder.pid);
        waitForHolderReady(holder, ready, holderLog);
        const result = run(f, [], { skipProcesses: false, skipRestart: false });
        assert.equal(result.code, 1, result.output);
        assert.match(result.state.message, /manual recovery; application services were not restarted/);
        assert.equal(sourceGit(f, 'rev-parse', 'HEAD'), f.job.originalCommit);
        assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), application['src/index.js']);
        assert.equal(fs.readFileSync(path.join(f.root, 'src/webui/server.mjs'), 'utf8'), 'old // new console');
        assert.ok(sourceGit(f, 'status', '--porcelain', '--untracked-files=no'));
        assert.ok(!fs.existsSync(path.join(f.root, restartMarker)));
        assert.throws(() => process.kill(bridge.pid, 0));
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          try { stopFixtureProcess(holder, release); }
          finally { stopFixtureProcess(bridge); }
        } catch (error) {
          if (!failure) throw error;
          console.error(`Isolated source fixture cleanup also failed:\n${error.stack ?? error}`);
        }
      }
    });
    test('source update refuses releases that change a configured data path', () => {
      const f = sourceFixture('source-protected', {
        config: { persona: { path: 'README.md' } },
      });
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /configured data path/);
      unchanged(f);
    });
    test('valid ZIP overlays app files and preserves local data in Chinese, spaced and apostrophe paths', () => {
      const f = fixture('success', { config: { dsh: { cwd: '.' }, persona: { path: 'qq-workspace/AGENTS.md', dir: 'state/personas' } } });
      const oldConfig = fs.readFileSync(path.join(f.root, 'config.json'));
      const result = run(f);
      assert.equal(result.code, 0, result.output);
      assert.equal(result.state.phase, 'complete');
      assert.equal(result.state.jobId, f.job.jobId);
      assert.equal(result.state.version, VERSION);
      assert.ok(Number.isFinite(Date.parse(result.state.completedAt)));
      assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), application['src/index.js']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8')).version, VERSION);
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), oldConfig);
      for (const rel of ['state/personas/active.json', 'state/stickers/image.png', 'logs/test.log', 'qq-workspace/AGENTS.md', '记忆库/note.md', 'napcat/config/account.json', 'src/user-added.js']) {
        assert.equal(fs.readFileSync(path.join(f.root, rel), 'utf8'), `keep ${rel}`);
      }
      assert.equal(fs.readFileSync(path.join(f.jobDir, 'backup', 'src/index.js'), 'utf8'), 'old // new bridge');
      assert.ok(fs.existsSync(f.job.packagePath));
      assert.ok(fs.existsSync(path.join(f.jobDir, 'backup-manifest.json')));
      assert.ok(!fs.existsSync(path.join(f.root, 'state/updates/install.lock')));
    });
    test('SHA256 mismatch refuses changes', () => {
      const f = fixture('hash', { patchJob: { expectedSha256: 'a'.repeat(64) } });
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.state.message, /SHA256/);
      unchanged(f);
      assert.ok(!fs.existsSync(path.join(f.jobDir, 'backup')));
      assert.ok(!fs.existsSync(path.join(f.root, 'state/updates/install.lock')));
    });
    for (const installedVersion of ['0.2.0', '0.2.0+build.1', '0.3.0', '1.0.0', '0.2.1-rc.1']) {
      test(`equal or older update is refused against ${installedVersion}`, () => {
        const f = fixture(`older-${installedVersion}`);
        write(f.root, 'package.json', JSON.stringify({ name: 'qq-bridge', version: installedVersion }));
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.state.message, /must be newer/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, installedVersion);
        assert.equal(fs.readFileSync(path.join(f.root, 'src/index.js'), 'utf8'), 'old // new bridge');
        assert.ok(!fs.existsSync(path.join(f.jobDir, 'staging')));
      });
    }
    test('a stable version can update the preceding prerelease', () => {
      const f = fixture('prerelease');
      write(f.root, 'package.json', JSON.stringify({ name: 'qq-bridge', version: '0.2.0-rc.10' }));
      const result = run(f);
      assert.equal(result.code, 0, result.output);
      assert.equal(result.state.phase, 'complete');
    });
    for (const [label, unsafe] of [
      ['traversal', `qq-bridge-${VERSION}/src/../../escape.txt`],
      ['absolute', 'C:/escape.txt'],
      ['alternate-stream', `qq-bridge-${VERSION}/src/index.js:payload`],
      ['reserved-device', `qq-bridge-${VERSION}/src/CON.txt`],
      ['trailing-dot', `qq-bridge-${VERSION}/src/name.`],
      ['trailing-space', `qq-bridge-${VERSION}/src/name `],
      ['wrong-root', 'qq-bridge-9.9.9/src/payload.js'],
      ['private-config', `qq-bridge-${VERSION}/config.json`],
      ['private-state', `qq-bridge-${VERSION}/state/personas/stolen.md`],
      ['private-local-patch', `qq-bridge-${VERSION}/patches/model.local.yml`],
      ['unmanaged-root', `qq-bridge-${VERSION}/payload.exe`],
    ]) {
      test(`unsafe ZIP rejects ${label}`, () => {
        const f = fixture(label, { entries: [{ name: unsafe, body: 'bad' }] });
        const result = run(f);
        assert.equal(result.code, 1, result.output);
        assert.equal(result.state.phase, 'error');
        unchanged(f);
        assert.ok(!fs.existsSync(path.join(f.jobDir, 'backup')));
      });
    }
    test('ZIP Unix symbolic link is refused', () => {
      const f = fixture('zip-link', { entries: [{ name: `qq-bridge-${VERSION}/src/link.js`, body: '../config.json', attrs: 0xa1ff0000 }] });
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /link|special/);
      unchanged(f);
    });
    for (const [name, metadata] of [
      ['entry-size', { length: 134217729 }],
      ['compression-ratio', { length: 2097152 }],
    ]) {
      test(`ZIP bomb ${name} is refused before extraction`, () => {
        const f = fixture(name, { entries: [{ name: `qq-bridge-${VERSION}/src/bomb.js`, body: 'x', ...metadata }] });
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.state.message, /size|compression ratio/);
        unchanged(f);
        assert.ok(!fs.existsSync(path.join(f.jobDir, 'staging')));
      });
    }
    test('case-insensitive duplicate paths are refused', () => {
      const f = fixture('duplicate', { entries: [{ name: `qq-bridge-${VERSION}/SRC/INDEX.JS`, body: 'bad' }] });
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.state.message, /Duplicate/);
      unchanged(f);
    });
    test('file/directory archive collisions are refused', () => {
      const f = fixture('collision', { entries: [
        { name: `qq-bridge-${VERSION}/src/collision`, body: 'file' },
        { name: `qq-bridge-${VERSION}/src/collision/child.js`, body: 'child' },
      ] });
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.state.message, /collision/);
      unchanged(f);
    });
    test('package.json version mismatch is refused before backup and stop', () => {
      const f = fixture('version', { alter: (items) => items.map((item) =>
        item.name.endsWith('/package.json') ? { ...item, body: JSON.stringify({ name: 'qq-bridge', version: '9.0.0' }) } : item) });
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.state.message, /version/);
      unchanged(f);
      assert.ok(!fs.existsSync(path.join(f.jobDir, 'backup', 'package.json')));
    });
    for (const [name, config] of [
      ['persona-path', { persona: { path: 'src/index.js' } }],
      ['persona-library', { persona: { dir: 'src' } }],
      ['memory-root', { memory: { root: 'src' } }],
      ['stickers-root', { stickers: { root: 'src' } }],
      ['custom-workspace', { dsh: { cwd: 'src' } }],
      ['custom-model-patch', { dsh: { patchPath: 'src/index.js' } }],
      ['custom-state', { stateDir: 'src' }],
      ['custom-logs', { logDir: 'src' }],
      ['custom-plugins', { plugins: { dir: 'src' } }],
    ]) {
      test(`configured ${name} conflict preserves data`, () => {
        const f = fixture(name, { config });
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.state.message, /configured data path/);
        unchanged(f);
      });
    }
    test('custom environment-expanded persona path is protected', () => {
      const f = fixture('environment-path');
      process.env.QQ_UPDATE_TEST_DATA = f.root;
      write(f.root, 'config.json', JSON.stringify({ persona: { path: '$QQ_UPDATE_TEST_DATA/src/index.js' } }));
      try {
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.state.message, /configured data path/);
        unchanged(f);
      } finally { delete process.env.QQ_UPDATE_TEST_DATA; }
    });
    test('Git checkout is refused', () => {
      const f = fixture('git');
      fs.mkdirSync(path.join(f.root, '.git'));
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.output, /Git checkout/);
      unchanged(f);
    });
    test('installation root junction is refused', () => {
      const f = fixture('junction-root-target');
      const alias = path.join(TEMP, 'junction-root-alias');
      fs.symlinkSync(f.root, alias, 'junction');
      const job = { ...f.job, projectRoot: alias };
      fs.writeFileSync(f.jobPath, JSON.stringify(job));
      try {
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.output, /junction/);
        unchanged(f);
      } finally { fs.unlinkSync(alias); }
    });
    test('destination junction is refused without changing external files', () => {
      const f = fixture('junction');
      const external = path.join(TEMP, 'external');
      fs.mkdirSync(external);
      write(external, 'extra.js', 'external safe');
      fs.symlinkSync(external, path.join(f.root, 'src', 'linked'), 'junction');
      const original = fs.readFileSync(f.job.packagePath);
      const malicious = zip([
        ...Object.entries(application).map(([rel, body]) => ({ name: `qq-bridge-${VERSION}/${rel}`, body })),
        { name: `qq-bridge-${VERSION}/src/linked/extra.js`, body: 'bad' },
      ]);
      fs.writeFileSync(f.job.packagePath, malicious);
      f.job.expectedSha256 = createHash('sha256').update(malicious).digest('hex');
      fs.writeFileSync(f.jobPath, JSON.stringify(f.job));
      assert.ok(original.length > 0);
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.state.message, /junction/);
      unchanged(f);
      assert.equal(fs.readFileSync(path.join(external, 'extra.js'), 'utf8'), 'external safe');
      fs.unlinkSync(path.join(f.root, 'src', 'linked'));
    });
    test('partial overlay failure restores every original and removes introduced files', () => {
      const f = fixture('rollback', { alter: (items) => [
        { name: `qq-bridge-${VERSION}/src/new-file.js`, body: 'new file' },
        ...items,
      ] });
      const result = run(f, ['-TestFailAfterFiles', '3']);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /restored/);
      unchanged(f);
      assert.equal(fs.readFileSync(path.join(f.root, 'qq-bridge.exe'), 'utf8'), 'old new launcher');
      assert.ok(!fs.existsSync(path.join(f.root, 'src/new-file.js')));
      assert.ok(fs.existsSync(path.join(f.jobDir, 'backup', 'qq-bridge.exe')));
    });
    test('filesystem failure after partial overlay rolls back cleanly', () => {
      const f = fixture('readonly-rollback');
      const readOnly = path.join(f.root, 'README.md');
      fs.chmodSync(readOnly, 0o444);
      try {
        const result = run(f);
        assert.equal(result.code, 1, result.output);
        assert.match(result.state.message, /restored/);
        assert.doesNotMatch(result.state.message, /manual recovery from the backup/);
        unchanged(f);
        assert.equal(fs.readFileSync(readOnly, 'utf8'), 'old new readme');
      } finally { fs.chmodSync(readOnly, 0o666); }
    });
    for (const [name, bootstrap, expected] of [
      ['bootstrap-error', 'exit 7', /bootstrap failed with exit code 7/],
      ['bootstrap-no-services', 'exit 0', /bridge or console version did not recover/],
      ['bootstrap-partial-start', [
        "$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))",
        "$bridge = Join-Path $root 'src\\index.js'",
        `Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList ('"' + $bridge + '"') -WorkingDirectory $root -WindowStyle Hidden`,
        'Start-Sleep -Milliseconds 500',
        'exit 7',
      ].join('\r\n'), /bootstrap failed with exit code 7/],
    ]) {
      test(`${name} rolls back and attempts the previous bootstrap`, () => {
        const f = fixture(name, {
          alter: (items) => items.map((item) => {
            if (item.name.endsWith('/launcher/bootstrap.ps1')) return { ...item, body: bootstrap };
            if (name === 'bootstrap-partial-start' && item.name.endsWith('/src/index.js')) {
              return { ...item, body: [
                "const fs = require('node:fs'); const path = require('node:path');",
                "fs.writeFileSync(path.resolve(__dirname, '../state/partial-start.pid'), String(process.pid));",
                'setInterval(() => {}, 1000);',
              ].join('\n') };
            }
            return item;
          }),
        });
        const oldBootstrap = [
          "$marker = Join-Path $PSScriptRoot '..\\state\\restored-bootstrap.txt'",
          "[IO.File]::WriteAllText($marker, 'old bootstrap attempted')",
          'exit 19',
        ].join('\r\n');
        write(f.root, 'launcher/bootstrap.ps1', oldBootstrap);
        const result = run(f, [], { skipProcesses: false, skipRestart: false });
        assert.equal(result.code, 1, result.output);
        assert.match(result.state.message, expected);
        assert.match(result.state.message, /restored/);
        unchanged(f);
        assert.equal(fs.readFileSync(path.join(f.root, 'launcher/bootstrap.ps1'), 'utf8'), oldBootstrap);
        assert.equal(fs.readFileSync(path.join(f.root, 'state/restored-bootstrap.txt'), 'utf8'), 'old bootstrap attempted');
        assert.equal(result.state.phase, 'error');
        if (name === 'bootstrap-partial-start') {
          const childPid = Number(fs.readFileSync(path.join(f.root, 'state/partial-start.pid'), 'utf8'));
          assert.throws(() => process.kill(childPid, 0), 'new bridge should be stopped before restoring old files');
        }
      });
    }
    test('successful restart verifies its own processes and the console version before completion', () => {
      const nodePath = process.execPath.replaceAll("'", "''");
      const bootstrap = [
        "$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))",
        "$bridge = Join-Path $root 'src\\index.js'",
        "$console = Join-Path $root 'src\\webui\\server.mjs'",
        `Start-Process -FilePath '${nodePath}' -ArgumentList ('"' + $bridge + '"') -WorkingDirectory $root -WindowStyle Hidden`,
        `Start-Process -FilePath '${nodePath}' -ArgumentList ('"' + $console + '"') -WorkingDirectory $root -WindowStyle Hidden`,
        'exit 0',
      ].join('\r\n');
      const bridge = [
        "const fs = require('node:fs'); const path = require('node:path');",
        "fs.writeFileSync(path.resolve(__dirname, '../state/restarted-bridge.pid'), String(process.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const console = [
        "import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';",
        "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');",
        "fs.writeFileSync(path.join(root, 'state/restarted-console.pid'), String(process.pid));",
        `const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok:true, data:{currentVersion:'${VERSION}'}})); });`,
        "server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'state/webui-port.txt'), String(server.address().port)));",
      ].join('\n');
      const f = fixture('restart-success', {
        alter: (items) => items.map((item) => {
          if (item.name.endsWith('/launcher/bootstrap.ps1')) return { ...item, body: bootstrap };
          if (item.name.endsWith('/src/index.js')) return { ...item, body: bridge };
          if (item.name.endsWith('/src/webui/server.mjs')) return { ...item, body: console };
          return item;
        }),
      });
      try {
        const result = run(f, [], { skipProcesses: false, skipRestart: false });
        assert.equal(result.code, 0, result.output);
        assert.equal(result.state.phase, 'complete');
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, VERSION);
        assert.ok(fs.existsSync(path.join(f.root, 'state/restarted-bridge.pid')));
        assert.ok(fs.existsSync(path.join(f.root, 'state/restarted-console.pid')));
      } finally {
        for (const rel of ['state/restarted-bridge.pid', 'state/restarted-console.pid']) {
          if (fs.existsSync(path.join(f.root, rel))) {
            try { process.kill(Number(fs.readFileSync(path.join(f.root, rel), 'utf8'))); } catch {}
          }
        }
      }
    });
    test('result path outside the fixed updates directory is refused', () => {
      const f = fixture('result-path', { patchJob: { resultPath: path.join(TEMP, 'outside.json') } });
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(result.output, /expected state directory/);
      assert.ok(!fs.existsSync(path.join(TEMP, 'outside.json')));
      unchanged(f);
    });
    test('a different job lock is never removed', () => {
      const f = fixture('other-lock');
      const otherJobId = randomUUID();
      write(f.root, 'state/updates/install.lock', JSON.stringify({ jobId: otherJobId }));
      const result = run(f);
      assert.equal(result.code, 1, result.output);
      assert.match(result.state.message, /different job/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'state/updates/install.lock'))).jobId, otherJobId);
      unchanged(f);
    });
    test('another installation mutex rejects the job without overwriting its result or lock', () => {
      const f = fixture('mutex');
      const mutexName = `Local\\QQBridgeUpdater-${createHash('sha256').update(fs.realpathSync.native(f.root).toLowerCase()).digest('hex').toUpperCase()}`;
      const ready = path.join(f.jobDir, 'mutex-ready');
      const release = path.join(f.jobDir, 'mutex-release');
      const holderLog = path.join(f.jobDir, 'mutex-holder.log');
      const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
      const code = [
        `$mutex = New-Object Threading.Mutex($false, ${psQuote(mutexName)})`,
        'if (-not $mutex.WaitOne(0)) { exit 2 }',
        'try {',
        `  [IO.File]::WriteAllText(${psQuote(ready)}, 'ready')`,
        '  $deadline = [DateTime]::UtcNow.AddSeconds(180)',
        `  while (-not [IO.File]::Exists(${psQuote(release)})) {`,
        "    if ([DateTime]::UtcNow -ge $deadline) { throw 'Isolated mutex holder exceeded its lifetime.' }",
        '    Start-Sleep -Milliseconds 100',
        '  }',
        '} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }',
      ].join('\n');
      const holder = startFixtureHolder(code, holderLog);
      let failure;
      try {
        waitForHolderReady(holder, ready, holderLog);
        write(f.root, 'state/updates/result.json', JSON.stringify({ phase: 'existing-result' }));
        const result = run(f);
        assert.equal(result.code, 1);
        assert.match(result.output, /Another updater/);
        assert.equal(result.state.phase, 'existing-result');
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'state/updates/install.lock'))).jobId, f.job.jobId);
        unchanged(f);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try { stopFixtureProcess(holder, release); }
        catch (error) {
          if (!failure) throw error;
          console.error(`Isolated mutex fixture cleanup also failed:\n${error.stack ?? error}`);
        }
      }
    });
    test('installation only stops its isolated bridge and console; NapCat and another project remain alive', () => {
      const f = fixture('process-scope');
      const children = [];
      const launch = (file) => {
        write(path.dirname(file), path.basename(file), 'setInterval(() => {}, 1000);');
        const child = spawn(process.execPath, [file], { stdio: 'ignore', windowsHide: true });
        children.push(child);
        assert.ok(child.pid);
        return child.pid;
      };
      const alive = (pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      try {
        const bridgePid = launch(path.join(f.root, 'src/index.js'));
        const consolePid = launch(path.join(f.root, 'src/webui/server.mjs'));
        const napcatPid = launch(path.join(f.root, 'napcat/keepalive.mjs'));
        const otherPid = launch(path.join(TEMP, 'other-project/src/index.js'));
        f.job.consolePid = consolePid;
        fs.writeFileSync(f.jobPath, JSON.stringify(f.job));
        const result = run(f, [], { skipProcesses: false });
        assert.equal(result.code, 0, result.output);
        assert.equal(result.state.phase, 'complete');
        assert.equal(alive(bridgePid), false);
        assert.equal(alive(consolePid), false);
        assert.equal(alive(napcatPid), true);
        assert.equal(alive(otherPid), true);
      } finally {
        for (const child of children) child.kill();
      }
    });
    test('8.3 installer arguments and process paths resolve to the same verified installation', () => {
      const f = fixture('short-path-alias');
      const canonicalRoot = fs.realpathSync.native(f.root);
      const aliasRoot = shortPath(canonicalRoot);
      const children = [];
      const launch = (file) => {
        write(path.dirname(file), path.basename(file), 'setInterval(() => {}, 1000);');
        const child = spawn(process.execPath, [file], { stdio: 'ignore', windowsHide: true });
        children.push(child);
        assert.ok(child.pid);
        return child.pid;
      };
      try {
        const bridgePid = launch(path.join(aliasRoot, 'src/index.js'));
        const consolePid = launch(path.join(aliasRoot, 'src/webui/server.mjs'));
        const otherPid = launch(path.join(TEMP, 'alias-other-project/src/index.js'));
        Object.assign(f.job, {
          projectRoot: canonicalRoot,
          packagePath: fs.realpathSync.native(f.job.packagePath),
          resultPath: path.join(canonicalRoot, 'state/updates/result.json'),
          consolePid,
        });
        fs.writeFileSync(f.jobPath, JSON.stringify(f.job));
        f.executionJobDir = path.join(aliasRoot, 'state/updates', f.job.jobId);
        f.executionJobPath = path.join(f.executionJobDir, 'job.json');
        const result = run(f, [], { skipProcesses: false });
        assert.equal(result.code, 0, result.output);
        assert.equal(result.state.phase, 'complete');
        assert.throws(() => process.kill(bridgePid, 0));
        assert.throws(() => process.kill(consolePid, 0));
        assert.doesNotThrow(() => process.kill(otherPid, 0));
      } finally {
        for (const child of children) child.kill();
      }
    });
    test('another application mentioning this installation in a data argument is not stopped', () => {
      const f = fixture('argument-owner');
      const otherScript = path.join(TEMP, 'argument-other-project/worker.js');
      write(path.dirname(otherScript), path.basename(otherScript), 'setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [otherScript, '--data', path.join(f.root, 'src/index.js')], {
        stdio: 'ignore', windowsHide: true,
      });
      assert.ok(child.pid);
      try {
        const result = run(f, [], { skipProcesses: false });
        assert.equal(result.code, 0, result.output);
        assert.equal(result.state.phase, 'complete');
        assert.doesNotThrow(() => process.kill(child.pid, 0));
      } finally { child.kill(); }
    });
    test('an unverified console PID is refused without killing that process', () => {
      const f = fixture('process-owner', { patchJob: { consolePid: process.pid } });
      const result = run(f, [], { skipProcesses: false });
      assert.equal(result.code, 1);
      assert.match(result.state.message, /Cannot verify/);
      unchanged(f);
    });
    test('failure hook is unavailable unless both isolated-test switches are present', () => {
      const f = fixture('hook');
      const result = spawnSync(PS, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.jobDir, 'install-update.ps1'),
        '-JobPath', f.jobPath, '-TestFailAfterFiles', '1',
      ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.error?.stack ?? ''}`);
      assert.match(`${result.stdout}${result.stderr}`, /isolated-test switches/);
      unchanged(f);
    });
  } finally {
    cleanupTempDirectory(TEMP, TEMP_PARENT);
  }
}

if (group && selected !== GROUPS[group].end - GROUPS[group].start + 1) {
  console.error(`Installer test group ${group} selected ${selected} cases, expected ${GROUPS[group].end - GROUPS[group].start + 1}.`);
  failed += 1;
}
if (!group && !only && registered !== 60) {
  console.error(`Installer suite registered ${registered} cases, expected 60.`);
  failed += 1;
}
console.log(`\nPortable installer: ${passed} passed, ${failed} failed.`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) process.exitCode = 1;
