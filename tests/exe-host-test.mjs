/**
 * Windows EXE integration tests. All children use isolated bootstrap/node/browser
 * fixtures; no project services, QQ instances or startup shortcuts are touched.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../src/dsh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CSC = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TEST_VERSION = '9.8.7-preview.1+fixture';
let passed = 0;

function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${label}`);
}

function run(exe, args, options = {}) {
  const { timeout = 30_000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error(`Command timed out after ${timeout}ms: ${path.basename(exe)}\n${stdout}\n${stderr}`);
        error.code = 'ETIMEDOUT';
        reject(error);
      } else {
        resolve({ status, signal, stdout, stderr });
      }
    });
  });
}

async function successful(exe, args, options = {}) {
  const result = await run(exe, args, options);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resources(buffer) {
  const pe = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.toString('ascii', pe, pe + 4), 'PE\0\0');
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const directories = optional + (buffer.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const resourceRva = buffer.readUInt32LE(directories + 16);
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return {
      virtual: buffer.readUInt32LE(at + 12),
      length: Math.max(buffer.readUInt32LE(at + 8), buffer.readUInt32LE(at + 16)),
      raw: buffer.readUInt32LE(at + 20),
    };
  });
  const offset = (rva) => {
    const section = sections.find((item) => rva >= item.virtual && rva < item.virtual + item.length);
    assert.ok(section, `RVA ${rva} belongs to a PE section`);
    return section.raw + rva - section.virtual;
  };
  const base = offset(resourceRva);
  const found = [];
  function walk(relative, ids = []) {
    const at = base + relative;
    const count = buffer.readUInt16LE(at + 12) + buffer.readUInt16LE(at + 14);
    for (let index = 0; index < count; index += 1) {
      const entry = at + 16 + index * 8;
      const id = buffer.readUInt32LE(entry);
      const target = buffer.readUInt32LE(entry + 4);
      if (target & 0x80000000) walk(target & 0x7fffffff, [...ids, id]);
      else {
        const data = base + target;
        const start = offset(buffer.readUInt32LE(data));
        const length = buffer.readUInt32LE(data + 4);
        found.push({ ids: [...ids, id], data: buffer.subarray(start, start + length) });
      }
    }
  }
  walk(0);
  return found;
}

async function captured(file) {
  return (await fs.readFile(file, 'utf8')).split('\n').map((line) => Buffer.from(line, 'base64').toString('utf8'));
}

async function waitForFile(file, { timeout = 10_000, errorFile, diagnostics } = {}) {
  async function fail(message) {
    let details = '';
    if (diagnostics) {
      try { details = await diagnostics(); }
      catch (error) { details = `Fixture diagnostics failed: ${error.stack ?? error}`; }
    }
    throw new Error(`${message}${details ? `\n${details}` : ''}`);
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (errorFile) {
      let fixtureError;
      try { fixtureError = await fs.readFile(errorFile, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (fixtureError !== undefined) return fail(`Fixture failed before writing ${file}:\n${fixtureError}`);
    }
    try {
      await fs.access(file);
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return fail(`Fixture did not write ${file} within ${timeout}ms`);
}

async function waitForFixtureProcesses(directory) {
  if (!(await fs.readdir(directory)).length) return;
  await successful(PS, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$fixtureFailures = @()
foreach ($fixtureFile in [IO.Directory]::GetFiles(${psQuote(directory)}, '*.txt')) {
  $fixtureId = [int][IO.Path]::GetFileNameWithoutExtension($fixtureFile)
  $fixtureStart = [long][IO.File]::ReadAllText($fixtureFile)
  try { $fixtureProcess = [Diagnostics.Process]::GetProcessById($fixtureId) }
  catch [ArgumentException] { continue }
  try {
    try { $actualStart = $fixtureProcess.StartTime.ToUniversalTime().Ticks }
    catch [InvalidOperationException] {
      if ($fixtureProcess.HasExited) { continue }
      throw
    }
    if ($actualStart -eq $fixtureStart -and -not $fixtureProcess.WaitForExit(10000)) {
      try { $fixtureProcess.Kill() }
      catch [InvalidOperationException] { if (-not $fixtureProcess.HasExited) { throw } }
      if (-not $fixtureProcess.WaitForExit(5000)) {
        $fixtureFailures += ('An isolated fixture process could not be stopped: ' + $fixtureId)
      } else {
        $fixtureFailures += ('An isolated fixture process did not exit and was stopped: ' + $fixtureId)
      }
    }
  } finally { $fixtureProcess.Dispose() }
}
if ($fixtureFailures.Count -gt 0) { throw ($fixtureFailures -join [Environment]::NewLine) }
exit 0
`]);
}

async function fixtureDiagnostics(files, directory, bootstrapResult) {
  const contents = await Promise.all(files.map(async (file) => {
    try { return `${file}:\n${await fs.readFile(file, 'utf8')}`; }
    catch (error) { return `${file}: ${error.code ?? error.message}`; }
  }));
  const processes = await Promise.all((await fs.readdir(directory)).map(async (name) => {
    const pid = Number(path.parse(name).name);
    let status = 'PID exists';
    try { process.kill(pid, 0); }
    catch (error) { status = error.code === 'ESRCH' ? 'PID has exited' : `PID query failed: ${error.code}`; }
    return `${name}: start ticks=${(await fs.readFile(path.join(directory, name), 'utf8')).trim()}, ${status}`;
  }));
  return [
    `Bootstrap stdout:\n${bootstrapResult.stdout}`,
    `Bootstrap stderr:\n${bootstrapResult.stderr}`,
    ...contents,
    `Registered fixture processes:\n${processes.join('\n') || '(none)'}`,
  ].join('\n');
}

async function main() {
  if (process.platform !== 'win32' || !(await fs.stat(CSC).then((s) => s.isFile()).catch(() => false))) {
    console.log('SKIP exe-host-test requires Windows and .NET Framework csc.exe.');
    return;
  }
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qq-exe-host-')));
  const app = path.join(temporary, "app space ' \u6d4b\u8bd5");
  const fixtureProcesses = path.join(temporary, 'fixture-processes');
  await fs.mkdir(fixtureProcesses);
  let failure;
  try {
    await fs.mkdir(path.join(app, 'tools'), { recursive: true });
    await fs.mkdir(path.join(app, 'launcher'), { recursive: true });
    await fs.mkdir(path.join(app, 'state'), { recursive: true });
    await fs.writeFile(path.join(app, 'tools', 'cli.mjs'), '// Isolated fixture; the fake node never evaluates this file.\n');

    const fakeSource = path.join(temporary, 'fake-host.cs');
    await fs.writeFile(fakeSource, `
using System;
using System.IO;
using System.Text;
class FixtureHost {
    static int Main(string[] args) {
        using (var process = System.Diagnostics.Process.GetCurrentProcess()) {
            File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("QQ_EXE_TEST_PROCESSES"),
                process.Id + ".txt"), process.StartTime.ToUniversalTime().Ticks.ToString());
        }
        string[] encoded = Array.ConvertAll(args, value => Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
        File.WriteAllText(Environment.GetEnvironmentVariable("QQ_EXE_TEST_CAPTURE"), string.Join("\\n", encoded));
        if (Environment.GetEnvironmentVariable("QQ_EXE_TEST_BROWSER") != "1") {
            Console.WriteLine("[fixture] stdout");
            Console.Error.WriteLine("[fixture] stderr");
        }
        int code;
        return int.TryParse(Environment.GetEnvironmentVariable("QQ_EXE_TEST_EXIT"), out code) ? code : 0;
    }
}
`, 'utf8');
    const fakeNode = path.join(temporary, 'fake-node.exe');
    await successful(CSC, ['/nologo', '/target:exe', `/out:${fakeNode}`, fakeSource]);
    const fakeProgramFiles = path.join(temporary, 'fake program files');
    const fakeEdge = path.join(fakeProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    await fs.mkdir(path.dirname(fakeEdge), { recursive: true });
    await successful(CSC, ['/nologo', '/target:winexe', `/out:${fakeEdge}`, fakeSource]);

    const exe = path.join(app, 'dist', 'qq-bridge.exe');
    await successful(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'build-exe.ps1'),
      '-OutputPath', exe, '-Version', TEST_VERSION]);
    check('The desktop/CLI EXE compiles with the built-in compiler', () => assert.ok(exe));

    const metadataResult = await successful(PS, ['-NoProfile', '-Command',
      `$v = [Diagnostics.FileVersionInfo]::GetVersionInfo(${psQuote(exe)}); $v | Select-Object ProductName,FileDescription,CompanyName,FileVersion,ProductVersion | ConvertTo-Json -Compress`]);
    const metadata = JSON.parse(metadataResult.stdout.replace(/^\uFEFF/, '').trim());
    check('Product, publisher and semantic version metadata are embedded', () => {
      assert.equal(metadata.ProductName, 'QQ-DSH (DSH Fatwhale QQ)');
      assert.equal(metadata.CompanyName, 'miku05231');
      assert.match(metadata.FileDescription, /QQ-DSH/);
      assert.equal(metadata.FileVersion, '9.8.7.0');
      assert.equal(metadata.ProductVersion, TEST_VERSION);
    });

    const peResources = resources(await fs.readFile(exe));
    const originalIcon = await fs.readFile(path.join(ROOT, 'assets', 'app-icon.ico'));
    check('The original app icon is embedded at every source resolution', () => {
      const count = originalIcon.readUInt16LE(4);
      const group = peResources.find((item) => item.ids[0] === 14)?.data;
      assert.ok(group, 'RT_GROUP_ICON exists');
      assert.equal(group.readUInt16LE(4), count);
      assert.equal(peResources.filter((item) => item.ids[0] === 3).length, count);
      for (let index = 0; index < count; index += 1) {
        assert.equal(group[6 + index * 14], originalIcon[6 + index * 16]);
        assert.equal(group[7 + index * 14], originalIcon[7 + index * 16]);
      }
    });
    check('The embedded Windows manifest requests normal privileges and DPI awareness', () => {
      const manifest = peResources.find((item) => item.ids[0] === 24)?.data.toString('utf8') ?? '';
      assert.match(manifest, /requestedExecutionLevel level="asInvoker"/);
      assert.match(manifest, /PerMonitorV2,PerMonitor/);
      assert.match(manifest, />true\/PM</);
    });

    const capture = path.join(temporary, 'argv.txt');
    const env = {
      ...process.env, QQ_NODE: fakeNode, QQ_EXE_TEST_CAPTURE: capture,
      QQ_EXE_TEST_EXIT: '0', QQ_EXE_TEST_PROCESSES: fixtureProcesses,
    };
    const cliArgs = [
      'logs', 'bridge', '--lines', '7', '', 'two words', 'literal"quote',
      'C:\\a path\\trailing\\', 'slashes\\\\\\"quote', '\\\\', '\u6d4b\u8bd5',
    ];
    const cli = await successful(exe, cliArgs, { cwd: temporary, env });
    const forwarded = await captured(capture);
    check('CLI arguments preserve spaces, quotes, backslashes, Unicode and empty values', () => {
      assert.deepEqual(forwarded, [path.join(app, 'tools', 'cli.mjs'), ...cliArgs]);
    });
    check('CLI stdout and stderr are inherited', () => {
      assert.match(cli.stdout, /\[fixture\] stdout/);
      assert.match(cli.stderr, /\[fixture\] stderr/);
    });
    const failedCli = await run(exe, ['status'], { env: { ...env, QQ_EXE_TEST_EXIT: '37' } });
    check('CLI child exit codes are preserved', () => assert.equal(failedCli.status, 37));

    const blockedFixture = path.join(temporary, 'blocked-tree.mjs');
    const blockedPid = path.join(temporary, 'blocked-child.pid');
    await fs.writeFile(blockedFixture, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'child') {
  writeFileSync(${JSON.stringify(blockedPid)}, String(process.pid));
  console.log('blocked descendant ready');
} else {
  const child = spawn(process.execPath, [${JSON.stringify(blockedFixture)}, 'child']);
  child.stdout.once('data', () => console.log('blocked tree ready'));
}
setInterval(() => {}, 1000);
`);
    await assert.rejects(run(process.execPath, [blockedFixture], { cwd: app, timeout: 5000 }),
      (error) => error.code === 'ETIMEDOUT' && error.message.includes('blocked tree ready'));
    const blockedChildId = Number(await fs.readFile(blockedPid, 'utf8'));
    const exitDeadline = Date.now() + 5000;
    let blockedChildExited = false;
    while (Date.now() < exitDeadline) {
      try { process.kill(blockedChildId, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        blockedChildExited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('A command timeout reports captured output and stops its isolated descendant', () => {
      assert.ok(blockedChildExited);
    });

    const bootstrap = path.join(app, 'launcher', 'bootstrap.ps1');
    const bootstrapCapture = path.join(temporary, 'bootstrap.json');
    await fs.writeFile(bootstrap, '\uFEFF' + `
$ErrorActionPreference = 'Stop'
$data = [pscustomobject]@{
  script = $PSCommandPath
  cwd = [Environment]::CurrentDirectory
  apartment = [Threading.Thread]::CurrentThread.ApartmentState.ToString()
  arguments = @($args)
}
[IO.File]::WriteAllText($env:QQ_EXE_TEST_BOOTSTRAP_CAPTURE, ($data | ConvertTo-Json -Compress))
Write-Output '[fixture] bootstrap stdout'
[Console]::Error.WriteLine('[fixture] bootstrap stderr')
[Console]::Error.WriteLine('\u4e2d\u6587\u542f\u52a8\u5931\u8d25')
exit ([int]$env:QQ_EXE_TEST_EXIT)
`, 'utf8');
    const desktopEnv = {
      ...env,
      'ProgramFiles(x86)': fakeProgramFiles,
      ProgramFiles: fakeProgramFiles,
      LOCALAPPDATA: path.join(temporary, 'fake appdata'),
      QQ_EXE_TEST_BOOTSTRAP_CAPTURE: bootstrapCapture,
      QQ_EXE_TEST_BROWSER: '1',
    };
    await fs.rm(capture);
    const failedDesktop = await run(exe, [], { env: { ...desktopEnv, QQ_EXE_TEST_EXIT: '37' } });
    const bootData = JSON.parse(await fs.readFile(bootstrapCapture, 'utf8'));
    check('Double-click runs the existing bootstrap with STA and the project as working directory', () => {
      assert.equal(bootData.script.toLowerCase(), bootstrap.toLowerCase());
      assert.equal(bootData.cwd.toLowerCase(), app.toLowerCase());
      assert.equal(bootData.apartment, 'STA');
      assert.deepEqual(bootData.arguments, []);
    });
    check('Bootstrap errors preserve the exit code and expose diagnostic output without a blocking redirected dialog', () => {
      assert.equal(failedDesktop.status, 37);
      assert.match(failedDesktop.stderr, /QQ-DSH/);
      assert.match(failedDesktop.stderr, /\[fixture\] bootstrap stderr/);
      assert.ok(failedDesktop.stderr.includes('\u4e2d\u6587\u542f\u52a8\u5931\u8d25'));
    });
    await assert.rejects(fs.access(capture));
    check('A failed bootstrap never launches the CLI or a browser', () => assert.equal(failedDesktop.stdout, ''));

    await fs.writeFile(path.join(app, 'state', 'webui-port.txt'), '5943\n');
    await successful(exe, [], { env: desktopEnv });
    await waitForFile(capture);
    await waitForFixtureProcesses(fixtureProcesses);
    const browserArgs = await captured(capture);
    check('Successful desktop startup opens an Edge app at the published console port', () => {
      assert.deepEqual(browserArgs, ['--app=http://127.0.0.1:5943/', '--window-size=1180,820']);
    });

    await fs.rm(capture);
    await fs.writeFile(path.join(app, 'state', 'webui-port.txt'), '999999\n');
    await successful(exe, [], { env: desktopEnv });
    await waitForFile(capture);
    await waitForFixtureProcesses(fixtureProcesses);
    const fallbackArgs = await captured(capture);
    check('An invalid console port falls back to 5830', () => {
      assert.deepEqual(fallbackArgs, ['--app=http://127.0.0.1:5830/', '--window-size=1180,820']);
    });

    await fs.rm(bootstrap);
    const missingBootstrap = await run(exe, [], { env: desktopEnv });
    check('Incomplete desktop packages fail with a useful diagnostic', () => {
      assert.equal(missingBootstrap.status, 2);
      assert.match(missingBootstrap.stderr, /bootstrap\.ps1/);
    });

    await fs.copyFile(path.join(ROOT, 'launcher', 'bootstrap.ps1'), bootstrap);
    await fs.mkdir(path.join(app, 'launcher', 'lib'), { recursive: true });
    await fs.writeFile(path.join(app, 'launcher', 'lib', 'ProcessControl.ps1'), `
function Get-NapCatProcess { return [pscustomobject]@{ Running = $true } }
function Get-BridgeProcess { return [pscustomobject]@{ Running = $true } }
function Start-NapCat { throw 'The isolated fixture must not start NapCat.' }
function Start-Bridge { throw 'The isolated fixture must not start the bridge.' }
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter, [int]$OperationTimeoutSec)
  if ($Filter -eq "Name='DeepSeek Harness.exe'") {
    return [pscustomobject]@{ ProcessId = 1 }
  }
  if ($Filter -eq "Name='node.exe'") {
    return [pscustomobject]@{ CommandLine = ('node.exe "' + (Join-Path $script:ProjectRoot 'src\\webui\\server.mjs') + '"') }
  }
  throw ('Unexpected process query: ' + $Filter)
}
function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [string[]]$ArgumentList, [string]$WindowStyle)
  $fixtureChild = Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters -PassThru
  try {
    $fixtureStart = $fixtureChild.StartTime.ToUniversalTime().Ticks.ToString()
    [IO.File]::WriteAllText((Join-Path $env:QQ_EXE_TEST_PROCESSES ($fixtureChild.Id.ToString() + '.txt')),
      $fixtureStart)
    $fixtureLaunch = [pscustomobject]@{ pid = $fixtureChild.Id; startTicks = $fixtureStart; file = $FilePath; arguments = $ArgumentList }
    [IO.File]::WriteAllText($env:QQ_EXE_TEST_TRAY_STARTED, ($fixtureLaunch | ConvertTo-Json -Compress))
  } finally { $fixtureChild.Dispose() }
}
`, 'utf8');
    const trayFixture = path.join(app, 'launcher', 'Launcher.ps1');
    const trayCapture = path.join(temporary, 'tray.json');
    const trayStarted = path.join(temporary, 'tray-started.json');
    const trayError = path.join(temporary, 'tray-error.txt');
    await fs.writeFile(trayFixture, `
$ErrorActionPreference = 'Stop'
try {
  $data = [pscustomobject]@{
    script = $PSCommandPath
    cwd = [Environment]::CurrentDirectory
    apartment = [Threading.Thread]::CurrentThread.ApartmentState.ToString()
    arguments = @($args)
  }
  $capture = $env:QQ_EXE_TEST_TRAY_CAPTURE
  [IO.File]::WriteAllText(($capture + '.tmp'), ($data | ConvertTo-Json -Compress))
  [IO.File]::Move(($capture + '.tmp'), $capture)
} catch {
  [IO.File]::WriteAllText($env:QQ_EXE_TEST_TRAY_ERROR, ($_ | Out-String))
  exit 1
}
`, 'utf8');
    const realBootstrap = await successful(exe, [], { env: {
      ...desktopEnv, QQ_EXE_TEST_TRAY_CAPTURE: trayCapture,
      QQ_EXE_TEST_TRAY_STARTED: trayStarted, QQ_EXE_TEST_TRAY_ERROR: trayError,
    } });
    await waitForFile(trayCapture, {
      timeout: 60_000,
      errorFile: trayError,
      diagnostics: () => fixtureDiagnostics([
        trayStarted, trayError, trayCapture, `${trayCapture}.tmp`, path.join(app, 'state', 'launcher.log'),
      ], fixtureProcesses, realBootstrap),
    });
    await waitForFixtureProcesses(fixtureProcesses);
    const trayData = JSON.parse(await fs.readFile(trayCapture, 'utf8'));
    check('The real bootstrap launches its tray script from a path with spaces, Unicode and an apostrophe', () => {
      assert.equal(trayData.script.toLowerCase(), trayFixture.toLowerCase());
      assert.equal(trayData.cwd.toLowerCase(), app.toLowerCase());
      assert.equal(trayData.apartment, 'STA');
      assert.deepEqual(trayData.arguments, []);
    });
    const bootstrapLog = await fs.readFile(path.join(app, 'state', 'launcher.log'), 'utf8');
    check('The isolated real bootstrap skips all existing services and completes startup', () => {
      for (const component of ['NapCat', '\u6865\u63a5', '\u63a7\u5236\u53f0', 'DSH']) {
        assert.match(bootstrapLog, new RegExp(`${component}\\s*\u5df2\u5728\u8fd0\u884c`));
      }
      assert.ok(bootstrapLog.includes('\u542f\u52a8\u6d41\u7a0b\u5b8c\u6210'));
    });

    const invalidBuild = await run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'scripts', 'build-exe.ps1'), '-OutputPath', path.join(temporary, 'invalid.exe'),
      '-Version', '1.2.3";[assembly:AssemblyCompany("injected")]']);
    check('Version overrides reject C# attribute injection', () => assert.notEqual(invalidBuild.status, 0));
    await assert.rejects(fs.access(path.join(temporary, 'invalid.exe')));

    const releaseScript = path.join(app, 'scripts', 'make-release.ps1');
    await fs.mkdir(path.dirname(releaseScript), { recursive: true });
    await fs.copyFile(path.join(ROOT, 'scripts', 'make-release.ps1'), releaseScript);
    await fs.writeFile(path.join(app, 'package.json'), '{"version":"1.2.3"}\n');
    const sourceDirectory = path.join(app, 'dist', 'qq-dsh-bridge-1.2.3');
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'Isolated release fixture.\n');
    await fs.writeFile(path.join(sourceDirectory, '.env.example'), 'FIXTURE=1\n');
    const sourceArchive = 'Isolated source archive fixture.\n';
    await fs.writeFile(`${sourceDirectory}.zip`, sourceArchive);
    await successful(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
      '-Version', TEST_VERSION, '-SkipBuild']);
    const releaseDirectory = path.join(app, 'dist', 'release');
    const releaseNames = await fs.readdir(releaseDirectory);
    check('A release Version override reads the actual package.json source artifact version', () => {
      assert.deepEqual(releaseNames.sort(), [
        `qq-bridge-${TEST_VERSION}-portable-win64.zip`,
        `qq-bridge-${TEST_VERSION}-source.zip`,
        `qq-bridge-launcher-${TEST_VERSION}.exe`,
        'SHA256SUMS.txt',
      ].sort());
    });
    assert.equal(await fs.readFile(path.join(releaseDirectory, `qq-bridge-${TEST_VERSION}-source.zip`), 'utf8'), sourceArchive);
    const checksumLines = (await fs.readFile(path.join(releaseDirectory, 'SHA256SUMS.txt'), 'utf8'))
      .replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    const actualHashes = await Promise.all(checksumLines.map(async (line) => {
      const [, expected, name] = /^([a-f0-9]{64})  (.+)$/.exec(line) ?? [];
      assert.ok(name);
      const actual = createHash('sha256').update(await fs.readFile(path.join(releaseDirectory, name))).digest('hex');
      return [expected, actual];
    }));
    check('All three release checksums match the actual artifacts', () => {
      assert.equal(actualHashes.length, 3);
      for (const [expected, actual] of actualHashes) assert.equal(actual, expected);
    });
    const zipEntries = await successful(PS, ['-NoProfile', '-Command',
      `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead(${psQuote(path.join(releaseDirectory, `qq-bridge-${TEST_VERSION}-portable-win64.zip`))}); try { @($zip.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $zip.Dispose() }`]);
    const entries = JSON.parse(zipEntries.stdout.trim()).map((name) => name.replace(/\\/g, '/'));
    check('The portable archive keeps dotfiles and includes the executable and quick start', () => {
      assert.ok(entries.some((name) => name.endsWith('/.env.example')));
      assert.ok(entries.some((name) => name.endsWith('/qq-bridge.exe')));
      assert.ok(entries.some((name) => name.endsWith('/\u5feb\u901f\u5f00\u59cb.txt')));
    });
    const stagedEntries = await fs.readdir(path.join(app, 'dist'));
    check('Release staging directories are cleaned after packaging', () => {
      assert.ok(stagedEntries.every((name) => !name.startsWith('_stage-')));
    });
    const staleVersion = await run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
      '-Version', '1.2.3', '-SkipBuild']);
    check('SkipBuild rejects an executable from another release version', () => {
      assert.notEqual(staleVersion.status, 0);
      assert.match(`${staleVersion.stdout}${staleVersion.stderr}`, /SkipBuild/);
    });
    assert.equal((await fs.readdir(releaseDirectory)).length, 4);

    for (const output of ['.', 'dist', 'dist\\..\\..', 'dist\\qq-dsh-bridge-1.2.3']) {
      const unsafe = await run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
        '-OutDir', output, '-SkipBuild']);
      assert.notEqual(unsafe.status, 0, `Unsafe release output was accepted: ${output}`);
    }
    check('Release cleanup rejects the workspace, dist root, traversal and source directory', () => {
      assert.ok(stagedEntries.includes('qq-dsh-bridge-1.2.3'));
    });
    const external = path.join(temporary, 'outside dist');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, 'keep.txt'), 'untouched\n');
    await fs.symlink(external, path.join(app, 'dist', 'junction'), 'junction');
    const linked = await run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
      '-OutDir', 'dist\\junction\\release', '-SkipBuild']);
    const untouched = await fs.readFile(path.join(external, 'keep.txt'), 'utf8');
    check('Release cleanup rejects junction paths and preserves the target', () => {
      assert.notEqual(linked.status, 0);
      assert.equal(untouched, 'untouched\n');
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await waitForFixtureProcesses(fixtureProcesses);
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (error) {
      if (!failure) throw error;
      console.error(`EXE fixture cleanup also failed:\n${error.stack ?? error}`);
    }
  }
}

try {
  await main();
  console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
} catch (error) {
  console.error(error.stack ?? String(error));
  console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 1 \u9879`);
  process.exitCode = 1;
}
