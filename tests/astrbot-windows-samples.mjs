import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceRoot = path.join(project, '.tmp', 'astrbot-windows-acceptance');
const args = process.argv.slice(2);
let supervisor;
let token;

function requireThat(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
async function portFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function environment(extra = {}) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'userprofile', 'lang', 'tz']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', ...extra };
}
async function rpc(method) {
  const response = await fetch('http://127.0.0.1:15831/rpc', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, id: randomUUID(), method, params: {} }),
    signal: AbortSignal.timeout(method === 'runtime.stop' ? 60_000 : 2000),
  });
  const body = await response.json();
  requireThat(response.ok && !body.error, 'ASTRBOT_WINDOWS_SAMPLE_RPC_FAILED');
  return body.result;
}

try {
  requireThat(process.platform === 'win32' && args.length === 2 && args[0] === '--run-root',
    'ASTRBOT_WINDOWS_SAMPLE_ARGUMENTS_INVALID');
  const runRoot = path.resolve(args[1]);
  requireThat(path.dirname(runRoot).toLowerCase() === acceptanceRoot.toLowerCase(),
    'ASTRBOT_WINDOWS_SAMPLE_ROOT_INVALID');
  requireThat(await fs.readFile(path.join(acceptanceRoot, '.astrbot-windows-acceptance-only'), 'utf8')
    === 'qq-bridge isolated Windows AstrBot acceptance root v1\n', 'ASTRBOT_WINDOWS_SAMPLE_MARKER_INVALID');
  for (const directory of [runRoot, path.join(runRoot, 'astrbot')]) {
    const stat = await fs.lstat(directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'ASTRBOT_WINDOWS_SAMPLE_ROOT_INVALID');
  }
  await Promise.all([portFree(15831), portFree(15832)]);
  const stateRoot = path.join(runRoot, 'astrbot');
  const base = path.join(stateRoot, 'runtime', 'python', 'python.exe');
  const venv = path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
  for (const file of [base, venv]) requireThat((await fs.lstat(file)).isFile(), 'ASTRBOT_WINDOWS_SAMPLE_PYTHON_MISSING');
  token = (await fs.readFile(path.join(stateRoot, 'rpc-token'), 'utf8')).trim();
  requireThat(token.length >= 24, 'ASTRBOT_WINDOWS_SAMPLE_TOKEN_INVALID');
  const marker = path.join(runRoot, '.astrbot-acceptance-only');
  try { await fs.writeFile(marker, 'isolated Windows sample acceptance v1\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireThat(await fs.readFile(marker, 'utf8') === 'isolated Windows sample acceptance v1\n',
      'ASTRBOT_WINDOWS_SAMPLE_MARKER_INVALID');
  }
  const samples = path.join(runRoot, 'samples');
  await fs.mkdir(samples, { recursive: true });
  const lock = JSON.parse(await fs.readFile(path.join(project, 'runtime', 'astrbot-samples.json'), 'utf8'));
  for (const key of ['helloworld', 'randommeme', 'reminder', 'weather']) {
    const bytes = await fs.readFile(path.join(project, '.tmp', 'astrbot-locked-samples', `${key}.zip`));
    const hash = createHash('sha256').update(bytes).digest('hex');
    requireThat(lock.samples.some((entry) => entry.archiveSHA256 === hash), 'ASTRBOT_WINDOWS_SAMPLE_ARCHIVE_MISMATCH');
    await fs.writeFile(path.join(samples, `${key}.zip`), bytes);
  }
  const callback = 'http://127.0.0.1:15832/rpc/callback';
  supervisor = spawn(base, ['-m', 'qq_astrbot'], {
    cwd: path.join(project, 'runtime', 'astrbot'), windowsHide: true, stdio: 'ignore',
    env: environment({ __PYVENV_LAUNCHER__: venv, QQ_ASTRBOT_HOST: '127.0.0.1', QQ_ASTRBOT_PORT: '15831',
      QQ_ASTRBOT_TOKEN: token, QQ_ASTRBOT_CALLBACK_URL: callback,
      QQ_ASTRBOT_ROOT: path.join(project, 'runtime', 'astrbot'), QQ_ASTRBOT_STATE_ROOT: stateRoot }),
  });
  let startupError;
  supervisor.on('error', (error) => { startupError = error; });
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    requireThat(!startupError && supervisor.exitCode === null, 'ASTRBOT_WINDOWS_SAMPLE_SUPERVISOR_EXITED');
    try { healthy = (await rpc('health')).healthy === true; } catch {}
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  requireThat(healthy, 'ASTRBOT_WINDOWS_SAMPLE_SUPERVISOR_UNAVAILABLE');
  console.log(JSON.stringify({ phase: 'windows-locked-samples', status: 'started' }));
  const child = spawn(process.execPath, [path.join(project, 'tests', 'astrbot-samples-native.mjs')], {
    cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment({ ASTRBOT_NATIVE_TEST: '1', ASTRBOT_RUNTIME_URL: 'http://127.0.0.1:15831',
      ASTRBOT_SAMPLE_APP_ROOT: project, ASTRBOT_SAMPLE_STATE_DIR: runRoot,
      ASTRBOT_SAMPLE_CALLBACK_URL: callback, ASTRBOT_SAMPLE_CALLBACK_HOST: '127.0.0.1', ASTRBOT_SAMPLE_CALLBACK_PORT: '15832' }),
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  requireThat(output.length < 2 * 1024 * 1024, 'ASTRBOT_WINDOWS_SAMPLE_OUTPUT_LIMIT');
  const report = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  const reportPath = path.join(runRoot, `windows-samples-${report.runId || randomUUID()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, runId: report.runId, reportPath,
    globalFailureCodes: report.globalFailureCodes, cleanupFailureCodes: report.cleanupFailureCodes,
    samples: report.samples.map((sample) => ({ plugin: sample.pluginId || sample.repository,
      status: sample.status, failureCodes: sample.failureCodes })) }));
  requireThat(code === 0 && report.status === 'passed', 'ASTRBOT_WINDOWS_SAMPLE_MATRIX_FAILED');
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: /^ASTRBOT_[A-Z_]+$/.test(error.code || '')
    ? error.code : 'ASTRBOT_WINDOWS_SAMPLE_UNEXPECTED_ERROR' }));
  process.exitCode = 1;
} finally {
  if (supervisor && supervisor.exitCode === null) {
    try { await rpc('runtime.stop'); } catch { process.exitCode = 1; }
    const exited = new Promise((resolve) => supervisor.once('exit', resolve));
    supervisor.kill();
    await exited;
  }
  try { await Promise.all([portFree(15831), portFree(15832)]); }
  catch { process.exitCode = 1; console.error(JSON.stringify({ error: 'ASTRBOT_WINDOWS_SAMPLE_PORT_REMAINS' })); }
}
