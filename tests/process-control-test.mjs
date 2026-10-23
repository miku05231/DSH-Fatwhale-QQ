import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isolatedEnv, prepareIsolatedHome } from './helpers/isolated-fixtures.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const READY = 'qq-process-control:ready';

async function powershell(code, root, executable = PS, { executionTimeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const modulePath = path.join(path.dirname(executable), 'Modules');
    let readyAt;
    let phase = 'startup';
    let timedOut = false;
    let timer;
    const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PSModulePath = ${quote(modulePath)}
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility -ErrorAction Stop
[Console]::Error.WriteLine('${READY}')
try {
${code}
} finally {
  foreach ($fixtureError in $Error) {
    [Console]::Error.WriteLine(('fixture error: ' + $fixtureError.ToString() + ' [' + $fixtureError.FullyQualifiedErrorId + ']'))
  }
}`;
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')],
    { windowsHide: true, env: isolatedEnv(root, { PSModulePath: modulePath }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const armTimeout = (timeoutMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    };
    // Load only this runtime's built-in modules before the fixture execution budget starts.
    armTimeout(60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (phase === 'startup' && stderr.includes(READY)) {
        readyAt = Date.now();
        phase = 'execution';
        armTimeout(executionTimeoutMs);
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const diagnostic = stderr.replaceAll(READY, '').trim();
      if (process.env.CI) console.log(`PowerShell ${path.basename(executable)}: startup=${readyAt === undefined ? 'not ready' : `${readyAt - startedAt}ms`}, total=${Date.now() - startedAt}ms`);
      if (process.env.CI && diagnostic) console.log(`PowerShell fixture diagnostics: ${diagnostic}`);
      if (timedOut) reject(new Error(`PowerShell ${phase} timed out after ${phase === 'startup' ? 60_000 : executionTimeoutMs}ms (total=${Date.now() - startedAt}ms, signal=${signal ?? 'none'}): ${diagnostic}`));
      else if (code !== 0) reject(new Error(`PowerShell exited ${code} during ${phase} (signal=${signal ?? 'none'}): ${diagnostic}`));
      else {
        try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`Invalid fixture output: ${stdout}\n${stderr}`)); }
      }
    });
  });
}

async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qq-process-health-')));
  try {
    await prepareIsolatedHome(root);
    await run(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('a fixture command remains bounded after PowerShell startup', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  await assert.rejects(powershell('Start-Sleep -Seconds 5; "{}"', root, PS, { executionTimeoutMs: 100 }),
    /PowerShell execution timed out after 100ms/);
}));

test('isolated PowerShell loads built-in commands and retains fixture functions', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const result = await powershell(`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine(('probe runtime: ' + $PSHOME + '; modules: ' + $env:PSModulePath))
[Console]::Error.WriteLine('probe before command discovery')
$joinCommand = Get-Command Join-Path -ErrorAction Stop
[Console]::Error.WriteLine(('probe after command discovery: ' + $joinCommand.ModuleName))
$joined = Join-Path ${quote(root)} 'fixture'
[Console]::Error.WriteLine('probe after Join-Path')
function Get-CimInstance { [pscustomobject]@{ ProcessId = 202 } }
$mockCommand = Get-Command Get-CimInstance -ErrorAction Stop
[Console]::Error.WriteLine(('probe mock command: ' + $mockCommand.CommandType))
$process = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 3 -ErrorAction Stop
[Console]::Error.WriteLine('probe after fixture function')
@{ joined = $joined; processId = $process.ProcessId; commandType = [string]$mockCommand.CommandType; modulePath = $env:PSModulePath; canonicalRoot = [IO.Path]::GetFullPath(${quote(root)}) } | ConvertTo-Json -Compress
[Console]::Error.WriteLine('probe after JSON')
`, root);
  assert.equal(result.joined, path.join(root, 'fixture'));
  assert.equal(result.processId, 202);
  assert.equal(result.commandType, 'Function');
  assert.equal(result.modulePath, path.join(path.dirname(PS), 'Modules'));
  assert.equal(result.canonicalRoot, root);
}));

test('a listening port and saved account never establish QQ login', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const result = await powershell(`
[Console]::Error.WriteLine('login fixture before dot-source')
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
[Console]::Error.WriteLine('login fixture after dot-source')
$fixtureRoot = ${quote(root)}
function Get-ProcessControlConfig { @{ Root = $fixtureRoot; NapCatDir = $fixtureRoot; WebUiBase = 'invalid://fixture'; WebUiToken = ''; HttpTimeoutMs = 300; OneBotPort = 1 } }
function Get-NapCatProcess { [pscustomobject]@{ Running = $true } }
function Test-TcpEndPoint { $true }
function Get-NapCatAccountFromConfig { '12345678' }
function Get-NapCatNicknameFromLog { 'fixture' }
[Console]::Error.WriteLine('login fixture before state query')
Get-NapCatLoginState | ConvertTo-Json -Compress
[Console]::Error.WriteLine('login fixture after state query')
`, root);
  assert.equal(result.LoggedIn, false);
  assert.equal(result.State, 'unknown');
}));

test('process ownership includes this installation wrapper and excludes other installations', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const result = await powershell(`
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
$fixtureNapcat = ${quote(path.join(root, 'napcat'))}
function Get-ProcessControlConfig { @{ NapCatDir = $fixtureNapcat; NapCatNode = (Join-Path $fixtureNapcat 'node.exe'); NapCatProcess = 'node.exe'; NapCatMarker = 'apcat.mjs' } }
function Get-CimInstance {
  [pscustomobject]@{ ProcessId = 101; CreationDate = [datetime]'2026-01-01'; ExecutablePath = 'C:\\other\\node.exe'; CommandLine = 'node C:\\other\\napcat\\napcat.mjs' }
  [pscustomobject]@{ ProcessId = 202; CreationDate = [datetime]'2026-01-02'; ExecutablePath = (Join-Path $fixtureNapcat 'node.exe'); CommandLine = ('node "' + (Join-Path $fixtureNapcat 'index.js') + '" -q 12345678') }
}
$owned = Get-NapCatProcess
function Get-CimInstance { [pscustomobject]@{ ProcessId = 303; CreationDate = [datetime]'2026-01-01'; ExecutablePath = ($fixtureNapcat + '-other\\node.exe'); CommandLine = 'node index.js' } }
$other = Get-NapCatProcess
@{ owned = $owned; other = $other } | ConvertTo-Json -Depth 4 -Compress
`, root);
  assert.equal(result.owned.ProcessId, 202);
  assert.equal(result.owned.Running, true);
  assert.equal(result.other.Running, false);
}));

test('bootstrap verifies the console entry and the owner of its listening port', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await powershell(`
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(path.join(ROOT, 'launcher/bootstrap.ps1'))}, [ref]$tokens, [ref]$parseErrors)
$functions = @('Test-WebUiProcessRunning', 'Test-WebUiPortOpen')
foreach ($definition in $ast.FindAll({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -in $functions }, $false)) { Invoke-Expression $definition.Extent.Text }
$script:ProjectRoot = ${quote(path.join(root, "fixture app's install"))}
$entry = Join-Path $script:ProjectRoot 'src\\webui\\server.mjs'
$script:fixtureCommandLine = ''
function Get-CimInstance { [pscustomobject]@{ CommandLine = $script:fixtureCommandLine } }
$matches = @()
foreach ($candidate in @(
  ('node "' + $entry + '"'),
  ('node "' + $entry.Replace('\\', '/').ToUpperInvariant() + '" --fixture'),
  ('"C:\\Program Files\\nodejs\\node.exe" "' + $entry + '"'),
  ('node "' + $entry + '.old"'),
  ('node "' + $script:ProjectRoot + '-other\\src\\webui\\server.mjs"'),
  'node src\\webui\\server.mjs',
  ('node C:\\other\\watcher.mjs "' + $entry + '"'),
  ('node --check "' + $entry + '"'),
  ('node --eval "' + $entry + '"')
)) {
  $script:fixtureCommandLine = $candidate
  $matches += [bool](Test-WebUiProcessRunning)
}
$script:fixtureOwner = 7777
function Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = $script:fixtureOwner } }
$wrongOwner = Test-WebUiPortOpen -Port ${server.address().port} -ExpectedProcessId 4242
$script:fixtureOwner = 4242
$ownedPort = Test-WebUiPortOpen -Port ${server.address().port} -ExpectedProcessId 4242
function Get-NetTCPConnection { throw 'fixture query unavailable' }
$unknownOwner = Test-WebUiPortOpen -Port ${server.address().port} -ExpectedProcessId 4242
@{ matches = $matches; wrongOwner = $wrongOwner; ownedPort = $ownedPort; unknownOwner = $unknownOwner } | ConvertTo-Json -Compress
`, root);
    assert.deepEqual(result.matches, [true, true, true, false, false, false, false, false, false]);
    assert.equal(result.wrongOwner, false);
    assert.equal(result.ownedPort, true);
    assert.equal(result.unknownOwner, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('bootstrap starts this console when another installation and an occupied saved port exist', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const servers = [http.createServer(), http.createServer()];
  try {
    for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const occupiedPort = servers[0].address().port;
    const readyPort = servers[1].address().port;
    const install = path.join(root, "fixture app's install");
    for (const relative of ['launcher/lib', 'state', 'src/webui']) await fs.mkdir(path.join(install, relative), { recursive: true });
    await fs.copyFile(path.join(ROOT, 'launcher/bootstrap.ps1'), path.join(install, 'launcher/bootstrap.ps1'));
    await fs.writeFile(path.join(install, 'launcher/Launcher.ps1'), '# fixture tray');
    await fs.writeFile(path.join(install, 'src/webui/server.mjs'), '// fixture console');
    await fs.writeFile(path.join(install, 'state/webui-port.txt'), String(occupiedPort));
    await fs.writeFile(path.join(install, 'launcher/lib/ProcessControl.ps1'), `
function Get-NapCatProcess { @{ Running = $true } }
function Get-BridgeProcess { @{ Running = $true } }
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction, $OperationTimeoutSec)
  if ($Filter -eq "Name='DeepSeek Harness.exe'") { return [pscustomobject]@{ ProcessId = 1 } }
  [pscustomobject]@{ CommandLine = 'node "C:\\other\\src\\webui\\server.mjs"' }
}
function Resolve-NodeExe { ${quote(process.execPath)} }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  [pscustomobject]@{ OwningProcess = $(if ($LocalPort -eq ${readyPort}) { 4242 } else { 7777 }) }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru, $ErrorAction)
  if ($ArgumentList -eq ('"' + (Join-Path $script:ProjectRoot 'src\\webui\\server.mjs') + '"')) {
    if ($WindowStyle -ne 'Hidden') { throw 'Console must remain hidden.' }
    [IO.File]::WriteAllText((Join-Path $script:StateDir 'console-started.txt'), 'started')
    [IO.File]::WriteAllText((Join-Path $script:StateDir 'webui-port.txt'), '${readyPort}')
    return [pscustomobject]@{ Id = 4242; HasExited = $false }
  }
}
`, 'utf8');
    const result = await powershell(`
& ${quote(path.join(install, 'launcher/bootstrap.ps1'))} *> $null
@{ started = [IO.File]::Exists(${quote(path.join(install, 'state/console-started.txt'))}); log = [IO.File]::ReadAllText(${quote(path.join(install, 'state/launcher.log'))}) } | ConvertTo-Json -Compress
`, root);
    assert.equal(result.started, true, 'neither another install nor a stale occupied port can suppress startup');
    assert.ok(result.log.includes(`http://127.0.0.1:${readyPort}/`), 'readiness uses the newly published owned port');
    assert.ok(!result.log.includes(`http://127.0.0.1:${occupiedPort}/`));
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
}));

test('saved auto-login choice wins over newest account file', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const configDir = path.join(root, 'napcat', 'config');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'webui.json'), JSON.stringify({ autoLoginAccount: '12345678' }));
  await fs.writeFile(path.join(configDir, 'napcat_87654321.json'), '{}');
  const result = await powershell(`
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
@{ account = (Get-NapCatAccountFromConfig -Config @{ NapCatDir = ${quote(root)} }) } | ConvertTo-Json -Compress
`, root);
  assert.equal(result.account, '12345678');
}));

test('NapCat startup archives both existing streams before redirecting', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const result = await powershell(`
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
$fixtureRoot = ${quote(root)}
$fixtureNapcat = Join-Path $fixtureRoot 'napcat'
$fixtureLogs = Join-Path $fixtureRoot 'logs'
$null = [IO.Directory]::CreateDirectory($fixtureNapcat)
$null = [IO.Directory]::CreateDirectory($fixtureLogs)
[IO.File]::WriteAllText((Join-Path $fixtureNapcat 'index.js'), '')
[IO.File]::WriteAllText((Join-Path $fixtureNapcat 'node.exe'), '')
[IO.File]::WriteAllText((Join-Path $fixtureLogs 'napcat-console.log'), 'previous stdout')
[IO.File]::WriteAllText((Join-Path $fixtureLogs 'napcat-console.err.log'), 'previous stderr')
function Get-ProcessControlConfig { @{ Root = $fixtureRoot; NapCatDir = $fixtureNapcat; NapCatNode = (Join-Path $fixtureNapcat 'node.exe'); LogDirs = @($fixtureLogs) } }
function Get-NapCatProcess { [pscustomobject]@{ Running = $false } }
function Get-NapCatAccountFromConfig { '' }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru, $ErrorAction)
  [IO.File]::WriteAllText($RedirectStandardOutput, 'new stdout')
  [IO.File]::WriteAllText($RedirectStandardError, 'new stderr')
}
$started = Start-NapCat
$saved = @(Get-ChildItem -LiteralPath (Join-Path $fixtureLogs 'archive\\napcat') -File -ErrorAction SilentlyContinue | ForEach-Object { [IO.File]::ReadAllText($_.FullName) })
$script:launchCalled = $false
function Start-Process { $script:launchCalled = $true }
$lockedLog = [IO.File]::Open((Join-Path $fixtureLogs 'napcat-console.log'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try { $blockedStart = Start-NapCat } finally { $lockedLog.Dispose() }
@{ started = $started; archived = $saved; blockedStart = $blockedStart; launchCalled = $script:launchCalled; preserved = [IO.File]::ReadAllText((Join-Path $fixtureLogs 'napcat-console.log')) } | ConvertTo-Json -Compress
`, root);
  assert.equal(result.started, true);
  assert.deepEqual(new Set(result.archived), new Set(['previous stdout', 'previous stderr']));
  assert.equal(result.blockedStart, false);
  assert.equal(result.launchCalled, false, 'a failed archive must not proceed to truncation');
  assert.equal(result.preserved, 'new stdout');
}));

test('PowerShell 5.1 invokes the shared detector and caches credentials across dot-source refreshes', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  let logins = 0;
  const token = 'synthetic-ps-webui-token';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 0, data }));
    if (req.url === '/api/auth/login') {
      assert.equal(JSON.parse(body).hash, createHash('sha256').update(`${token}.napcat`).digest('hex'));
      logins += 1;
      return reply({ Credential: 'synthetic-private-credential' });
    }
    assert.equal(req.headers.authorization, 'Bearer synthetic-private-credential');
    return reply(req.url.includes('CheckLoginStatus')
      ? { isLogin: true, isOffline: false, loginPhase: 'ready' }
      : { uin: '12345678', nick: 'fixture', online: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const relative of ['scripts/napcat-health.mjs', 'src/napcat-health.js', 'src/napcat-health-onebot.js', 'src/onebot.js']) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.copyFile(path.join(ROOT, relative), path.join(root, relative));
    }
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    const dir = path.join(root, 'napcat', 'napcat', 'config');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'webui.json'), JSON.stringify({ token, host: '127.0.0.1', port: server.address().port }));
    const code = `
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
$fixtureRoot = ${quote(root)}
function Get-ProcessControlConfig { @{ Root = $fixtureRoot; NapCatDir = (Join-Path $fixtureRoot 'napcat') } }
function Get-NapCatProcess { [pscustomobject]@{ Running = $true } }
function Resolve-NodeExe { ${quote(process.execPath)} }
$first = Get-NapCatLoginState
# The tray dot-sources the module again for every asynchronous status request.
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
function Get-ProcessControlConfig { @{ Root = $fixtureRoot; NapCatDir = (Join-Path $fixtureRoot 'napcat') } }
function Get-NapCatProcess { [pscustomobject]@{ Running = $true } }
function Resolve-NodeExe { ${quote(process.execPath)} }
@{ first = $first; second = (Get-NapCatLoginState) } | ConvertTo-Json -Depth 5 -Compress
`;
    const got = await powershell(code, root);
    assert.equal(got.first.LoggedIn, true);
    assert.equal(got.second.State, 'online');
    assert.equal(got.second.Account, '12345678');
    assert.equal(logins, 1);
    assert.ok(!JSON.stringify(got).includes('credential'));
    assert.ok(!JSON.stringify(got).includes(token));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('a stale bridge status cannot claim connected even with a live owned process', { skip: process.platform !== 'win32' }, () => fixture(async (root) => {
  const statusFile = path.join(root, 'status.json');
  await fs.writeFile(statusFile, JSON.stringify({ pid: 123, connected: true, updatedAt: '2026-01-01T00:00:00Z' }));
  const code = `
. ${quote(path.join(ROOT, 'launcher/lib/ProcessControl.ps1'))}
$fixtureEntry = ${quote(path.join(root, 'src/index.js'))}
function Get-ProcessControlConfig { @{ BridgeScript = $fixtureEntry; StatusFile = ${quote(statusFile)} } }
function Get-CimInstance { [pscustomobject]@{ ProcessId = 123; CommandLine = ('node "' + $fixtureEntry + '"') } }
$stale = Get-BridgeProcess
[IO.File]::WriteAllText(${quote(statusFile)}, (@{ pid = 123; connected = $true; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
$fresh = Get-BridgeProcess
[IO.File]::WriteAllText(${quote(statusFile)}, (@{ pid = 999; connected = $true; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
$wrongPid = Get-BridgeProcess
@{ stale = $stale; fresh = $fresh; wrongPid = $wrongPid } | ConvertTo-Json -Depth 4 -Compress
`;
  const ps7 = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  for (const executable of [PS, ps7]) {
    try { await fs.access(executable); } catch { continue; }
    await fs.writeFile(statusFile, JSON.stringify({ pid: 123, connected: true, updatedAt: '2026-01-01T00:00:00Z' }));
    const result = await powershell(code, root, executable);
    assert.equal(result.stale.Running, true);
    assert.equal(result.stale.Connected, false);
    assert.equal(result.fresh.Connected, true, `retain JSON timestamp timezone in ${path.basename(executable)}`);
    assert.equal(result.wrongPid.Connected, false);
  }
}));
