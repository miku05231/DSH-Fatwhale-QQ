import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = `qq-bridge-${version}-portable-win64.zip`;
const artifact = path.join(root, 'dist', 'release', name);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-release-update-'));
let passed = 0;

function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`PASS ${label}`);
}

async function put(relative, value) {
  const target = path.join(temporary, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

try {
  assert.equal(process.platform, 'win32', 'Run the release installation check on Windows.');
  const bytes = await readFile(artifact);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const checksumLines = (await readFile(path.join(root, 'dist', 'release', 'SHA256SUMS.txt'), 'utf8'))
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  check('The actual portable artifact matches its published checksum',
    checksumLines.filter((line) => line === `${digest}  ${name}`).length === 1);

  for (const relative of [
    'qq-bridge.exe', 'launcher/bootstrap.ps1', 'launcher/Launcher.ps1',
    'src/index.js', 'src/webui/server.mjs',
  ]) await put(relative, 'old application file');
  await put('package.json', JSON.stringify({ name: 'qq-bridge', version: '0.0.0', type: 'module' }));
  const preserved = {
    'config.json': JSON.stringify({
      dsh: { cwd: '.', patchPath: 'patches/custom.local.yml' },
      persona: { path: 'qq-workspace/AGENTS.md', dir: 'state/personas' },
      memory: { root: 'memory' },
    }),
    'state/personas/active.json': '{"name":"local"}',
    'memory/note.md': 'local memory',
    'qq-workspace/AGENTS.md': 'local persona',
    'patches/custom.local.yml': '# local model configuration',
    'napcat/config/account.json': '{"local":true}',
    'logs/local.log': 'local log',
    'src/local-plugin.js': '// user-added file',
  };
  for (const [relative, content] of Object.entries(preserved)) await put(relative, content);

  const jobId = randomUUID();
  const jobDir = path.join(temporary, 'state', 'updates', jobId);
  await mkdir(jobDir, { recursive: true });
  const packagePath = path.join(jobDir, name);
  await copyFile(artifact, packagePath);
  const helper = path.join(jobDir, 'install-update.ps1');
  await copyFile(path.join(root, 'scripts', 'install-update.ps1'), helper);
  const resultPath = path.join(temporary, 'state', 'updates', 'result.json');
  const jobPath = path.join(jobDir, 'job.json');
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1, jobId, projectRoot: temporary, packagePath,
    expectedSha256: digest, version, consolePid: 0, resultPath,
  }));
  await put('state/updates/install.lock', JSON.stringify({ schemaVersion: 1, jobId }));

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-JobPath', jobPath, '-SkipProcessActions', '-SkipRestart',
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const installed = JSON.parse(await readFile(resultPath, 'utf8'));
  check('The trusted installer accepts the complete generated portable package',
    installed.phase === 'complete' && installed.version === version);
  check('The installed package has the release version',
    JSON.parse(await readFile(path.join(temporary, 'package.json'), 'utf8')).version === version);
  for (const [relative, content] of Object.entries(preserved)) {
    check(`Local data survives the real package: ${relative}`,
      await readFile(path.join(temporary, relative), 'utf8') === content);
  }
  await access(path.join(jobDir, 'backup', 'src', 'index.js'));
  check('The actual installation keeps a recovery backup', true);
  const { createUpdateManager } = await import(pathToFileURL(path.join(temporary, 'src', 'updates.mjs')).href);
  const updates = createUpdateManager({ projectRoot: temporary, isDocker: false });
  const status = await updates.status();
  check('The installed updater loads without network or third-party packages',
    status.currentVersion === version && status.phase === 'complete');
  updates.stop();
  console.log(`\n通过 ${passed} 项，失败 0 项。`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
