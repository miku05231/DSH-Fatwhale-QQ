/**
 * Windows EXE integration tests. All children use isolated bootstrap/node/browser
 * fixtures; no project services, QQ instances or startup shortcuts are touched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const result = spawnSync(exe, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function successful(exe, args, options = {}) {
  const result = run(exe, args, options);
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

async function waitForFile(file) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Fixture did not write ${file}`);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP exe-host-test requires Windows and .NET Framework csc.exe.');
    return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-exe-host-'));
  const app = path.join(temporary, "app space ' \u6d4b\u8bd5");
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
    successful(CSC, ['/nologo', '/target:exe', `/out:${fakeNode}`, fakeSource]);
    const fakeProgramFiles = path.join(temporary, 'fake program files');
    const fakeEdge = path.join(fakeProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    await fs.mkdir(path.dirname(fakeEdge), { recursive: true });
    successful(CSC, ['/nologo', '/target:winexe', `/out:${fakeEdge}`, fakeSource]);

    const exe = path.join(app, 'dist', 'qq-bridge.exe');
    successful(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'build-exe.ps1'),
      '-OutputPath', exe, '-Version', TEST_VERSION]);
    check('The desktop/CLI EXE compiles with the built-in compiler', () => assert.ok(exe));

    const metadataResult = successful(PS, ['-NoProfile', '-Command',
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
    const env = { ...process.env, QQ_NODE: fakeNode, QQ_EXE_TEST_CAPTURE: capture, QQ_EXE_TEST_EXIT: '0' };
    const cliArgs = [
      'logs', 'bridge', '--lines', '7', '', 'two words', 'literal"quote',
      'C:\\a path\\trailing\\', 'slashes\\\\\\"quote', '\\\\', '\u6d4b\u8bd5',
    ];
    const cli = successful(exe, cliArgs, { cwd: temporary, env });
    const forwarded = await captured(capture);
    check('CLI arguments preserve spaces, quotes, backslashes, Unicode and empty values', () => {
      assert.deepEqual(forwarded, [path.join(app, 'tools', 'cli.mjs'), ...cliArgs]);
    });
    check('CLI stdout and stderr are inherited', () => {
      assert.match(cli.stdout, /\[fixture\] stdout/);
      assert.match(cli.stderr, /\[fixture\] stderr/);
    });
    const failedCli = run(exe, ['status'], { env: { ...env, QQ_EXE_TEST_EXIT: '37' } });
    check('CLI child exit codes are preserved', () => assert.equal(failedCli.status, 37));

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
    const failedDesktop = run(exe, [], { env: { ...desktopEnv, QQ_EXE_TEST_EXIT: '37' } });
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
    successful(exe, [], { env: desktopEnv });
    await waitForFile(capture);
    const browserArgs = await captured(capture);
    check('Successful desktop startup opens an Edge app at the published console port', () => {
      assert.deepEqual(browserArgs, ['--app=http://127.0.0.1:5943/', '--window-size=1180,820']);
    });

    await fs.rm(capture);
    await fs.writeFile(path.join(app, 'state', 'webui-port.txt'), '999999\n');
    successful(exe, [], { env: desktopEnv });
    await waitForFile(capture);
    const fallbackArgs = await captured(capture);
    check('An invalid console port falls back to 5830', () => {
      assert.deepEqual(fallbackArgs, ['--app=http://127.0.0.1:5830/', '--window-size=1180,820']);
    });

    await fs.rm(bootstrap);
    const missingBootstrap = run(exe, [], { env: desktopEnv });
    check('Incomplete desktop packages fail with a useful diagnostic', () => {
      assert.equal(missingBootstrap.status, 2);
      assert.match(missingBootstrap.stderr, /bootstrap\.ps1/);
    });

    const invalidBuild = run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
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
    successful(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
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
    const zipEntries = successful(PS, ['-NoProfile', '-Command',
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
    const staleVersion = run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
      '-Version', '1.2.3', '-SkipBuild']);
    check('SkipBuild rejects an executable from another release version', () => {
      assert.notEqual(staleVersion.status, 0);
      assert.match(`${staleVersion.stdout}${staleVersion.stderr}`, /SkipBuild/);
    });
    assert.equal((await fs.readdir(releaseDirectory)).length, 4);

    for (const output of ['.', 'dist', 'dist\\..\\..', 'dist\\qq-dsh-bridge-1.2.3']) {
      const unsafe = run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
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
    const linked = run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releaseScript,
      '-OutDir', 'dist\\junction\\release', '-SkipBuild']);
    const untouched = await fs.readFile(path.join(external, 'keep.txt'), 'utf8');
    check('Release cleanup rejects junction paths and preserves the target', () => {
      assert.notEqual(linked.status, 0);
      assert.equal(untouched, 'untouched\n');
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
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
