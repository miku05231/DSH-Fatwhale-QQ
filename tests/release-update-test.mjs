import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions } from '../src/updates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = `qq-bridge-${version}-portable-win64.zip`;
const artifact = path.join(root, 'dist', 'release', name);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-release-update-'));
// Exact helper shipped in v0.2.3 (commit 777b149), retained offline for shallow CI checkouts.
const legacyHelperPath = path.join(root, 'tests', 'fixtures', 'updates', 'install-update-v0.2.3.ps1');
const legacyHelperHash = '12d4985bcd81b394e6d9fbe451a8c8d51b195fccdbc643d80e4e416da66f0fa2';
let passed = 0;

function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`PASS ${label}`);
}

async function put(applicationRoot, relative, value) {
  const target = path.join(applicationRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function installArtifact({ label, directory, helperSource }, digest) {
  const applicationRoot = path.join(temporary, directory);
  for (const relative of [
    'qq-bridge.exe', 'launcher/bootstrap.ps1', 'launcher/Launcher.ps1',
    'src/index.js', 'src/webui/server.mjs',
  ]) await put(applicationRoot, relative, 'old application file');
  await put(applicationRoot, 'package.json', JSON.stringify({ name: 'qq-bridge', version: '0.2.3', type: 'module' }));
  await put(applicationRoot, 'scripts/install-update.ps1', helperSource);
  const preserved = {
    'config.json': JSON.stringify({
      dsh: { cwd: '.', patchPath: 'patches/custom.local.yml' },
      persona: { path: 'qq-workspace/AGENTS.md', dir: 'state/personas' },
      memory: { root: 'memory' },
      stickers: { root: 'state/stickers' },
    }),
    'AGENTS.md': 'local root persona',
    'state/personas/active.json': '{"name":"local"}',
    'state/stickers/local.gif': 'local sticker bytes',
    'state/sessions.json': '{"private:fixture":"local-session"}',
    'memory/note.md': 'local memory',
    'qq-workspace/AGENTS.md': 'local persona',
    'patches/custom.local.yml': '# local model configuration',
    'napcat/config/account.json': '{"local":true}',
    'logs/local.log': 'local log',
    'src/local-plugin.js': '// user-added file',
    'companion/local-data.txt': 'user-owned top-level companion data',
  };
  for (const [relative, content] of Object.entries(preserved)) await put(applicationRoot, relative, content);

  const jobId = randomUUID();
  const jobDir = path.join(applicationRoot, 'state', 'updates', jobId);
  await mkdir(jobDir, { recursive: true });
  const packagePath = path.join(jobDir, name);
  await copyFile(artifact, packagePath);
  const helper = path.join(jobDir, 'install-update.ps1');
  await copyFile(path.join(applicationRoot, 'scripts', 'install-update.ps1'), helper);
  const resultPath = path.join(applicationRoot, 'state', 'updates', 'result.json');
  const jobPath = path.join(jobDir, 'job.json');
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1, jobId, projectRoot: applicationRoot, packagePath,
    expectedSha256: digest, version, consolePid: 0, resultPath,
  }));
  await put(applicationRoot, 'state/updates/install.lock', JSON.stringify({ schemaVersion: 1, jobId }));

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-JobPath', jobPath, '-SkipProcessActions', '-SkipRestart',
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const installed = JSON.parse(await readFile(resultPath, 'utf8'));
  check(`${label}: the trusted installed helper accepts the complete generated portable package`,
    installed.phase === 'complete' && installed.version === version);
  check(`${label}: the installed package has the release version`,
    JSON.parse(await readFile(path.join(applicationRoot, 'package.json'), 'utf8')).version === version);
  for (const relative of [
    'src/open-path.ps1', 'src/open-path.js', 'src/sticker-prompt.js',
    'src/sessions.js', 'src/config.js', 'src/index.js',
    'src/webui/server.mjs', 'src/webui/public/app.js', 'src/webui/public/index.html',
    'src/companion/lib/index.js', 'src/companion/package.json', 'tools/install-companion.mjs',
  ]) {
    const expected = (await readFile(path.join(root, relative), 'utf8')).replace(/^\uFEFF/, '');
    const actual = (await readFile(path.join(applicationRoot, relative), 'utf8')).replace(/^\uFEFF/, '');
    check(`${label}: the installed package contains the complete current source: ${relative}`, actual === expected);
  }
  const exampleConfig = JSON.parse(await readFile(path.join(applicationRoot, 'config.example.json'), 'utf8'));
  check(`${label}: the installed example includes the default session window`,
    exampleConfig.behavior.sessionWindowMinutes === 180);
  const plugin = JSON.parse(await readFile(path.join(applicationRoot, 'src', 'companion', 'package.json'), 'utf8'));
  check(`${label}: companion remains a standalone ESM plugin inside the existing src whitelist`,
    plugin.name === 'qq-bridge-companion' && plugin.type === 'module' && plugin.main === 'lib/index.js');
  for (const [relative, content] of Object.entries(preserved)) {
    check(`${label}: local data survives the real package: ${relative}`,
      await readFile(path.join(applicationRoot, relative), 'utf8') === content);
  }
  check(`${label}: the release adds no files to the existing top-level companion directory`,
    JSON.stringify(await readdir(path.join(applicationRoot, 'companion'))) === '["local-data.txt"]');
  await access(path.join(jobDir, 'backup', 'src', 'index.js'));
  check(`${label}: the actual installation keeps a recovery backup`, true);
  check(`${label}: the recovery backup retains the exact previously trusted helper`,
    (await readFile(path.join(jobDir, 'backup', 'scripts', 'install-update.ps1'))).equals(helperSource));
  const { createUpdateManager } = await import(pathToFileURL(path.join(applicationRoot, 'src', 'updates.mjs')).href);
  const updates = createUpdateManager({ projectRoot: applicationRoot, isDocker: false });
  const status = await updates.status();
  check(`${label}: the installed updater loads without network or third-party packages`,
    status.currentVersion === version && status.phase === 'complete');
  updates.stop();
}

try {
  assert.equal(process.platform, 'win32', 'Run the release installation check on Windows.');
  assert.ok(compareVersions(version, '0.2.3') > 0, 'The real upgrade artifact must be newer than 0.2.3.');
  const bytes = await readFile(artifact);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const checksumLines = (await readFile(path.join(root, 'dist', 'release', 'SHA256SUMS.txt'), 'utf8'))
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  check('The actual portable artifact matches its published checksum',
    checksumLines.filter((line) => line === `${digest}  ${name}`).length === 1);
  const legacyHelper = await readFile(legacyHelperPath);
  check('The offline legacy helper is the exact v0.2.3 source',
    createHash('sha256').update(legacyHelper).digest('hex') === legacyHelperHash);
  for (const installer of [
    { label: 'v0.2.3 helper', directory: 'legacy-0.2.3', helperSource: legacyHelper },
    { label: 'current helper', directory: 'current', helperSource: await readFile(path.join(root, 'scripts', 'install-update.ps1')) },
  ]) await installArtifact(installer, digest);
  console.log(`\n通过 ${passed} 项，失败 0 项。`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
