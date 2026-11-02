import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE_ROOT = path.join(REPO_ROOT, '.tmp', 'astrbot-windows-acceptance');
const MARKER_PATH = path.join(ACCEPTANCE_ROOT, '.astrbot-windows-acceptance-only');
const MARKER_CONTENT = 'qq-bridge isolated Windows AstrBot acceptance root v1\n';
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'astrbot_plugin_boundary');
const RUNTIME_SOURCE = path.join(REPO_ROOT, 'runtime', 'astrbot');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'astrbot-runtime.ps1');
const LOCK_PATH = path.join(REPO_ROOT, 'runtime', 'astrbot-lock.json');
const RUNTIME_URL = 'http://127.0.0.1:15831';
const CALLBACK_URL = 'http://127.0.0.1:15832/rpc/callback';
const GROUP_ID = '123456789';
const MEMBER_ID = '789';
const ADMIN_ID = '456';

function acceptanceError(code) {
  return Object.assign(new Error(code), { code });
}

function requireThat(value, code) {
  if (!value) throw acceptanceError(code);
}

function isReparsePoint(info) {
  return info.isSymbolicLink() || ((info.attributes || 0) & 0x400) !== 0;
}

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(code)
    ? code : 'ASTRBOT_WINDOWS_ACCEPTANCE_UNEXPECTED_ERROR';
}

function getEnv(name) {
  const key = Object.keys(process.env).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

function safeWindowsEnvironment(extra = {}) {
  const env = {};
  for (const name of [
    'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT',
  ]) {
    const value = getEnv(name);
    if (typeof value === 'string') env[name] = value;
  }
  Object.assign(env, extra);
  return env;
}

function assertNoAmbientSecrets(childEnv, label) {
  const secretName = /token|secret|password|passwd|api.?key|credential|private.?key|access.?key/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (secretName.test(name) && value && childEnv[name] === value) {
      throw acceptanceError(`ASTRBOT_ACCEPTANCE_${label}_SECRET_ENV_INHERITED`);
    }
  }
}

async function prepareAcceptanceRoot() {
  const rootInfo = await fs.lstat(ACCEPTANCE_ROOT).catch(() => null);
  if (rootInfo) {
    requireThat(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
      'ASTRBOT_ACCEPTANCE_ROOT_UNSAFE');
  } else {
    await fs.mkdir(ACCEPTANCE_ROOT, { recursive: false });
  }

  const markerInfo = await fs.lstat(MARKER_PATH).catch(() => null);
  if (markerInfo) {
    requireThat(markerInfo.isFile() && !markerInfo.isSymbolicLink(),
      'ASTRBOT_ACCEPTANCE_MARKER_UNSAFE');
    requireThat((await fs.readFile(MARKER_PATH, 'utf8')) === MARKER_CONTENT,
      'ASTRBOT_ACCEPTANCE_MARKER_INVALID');
  } else {
    const contents = await fs.readdir(ACCEPTANCE_ROOT);
    requireThat(contents.length === 0, 'ASTRBOT_ACCEPTANCE_MARKER_REQUIRED');
    await fs.writeFile(MARKER_PATH, MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
  }
}

async function validateRunRoot(value) {
  const runRoot = path.resolve(value);
  const relative = path.relative(ACCEPTANCE_ROOT, runRoot);
  requireThat(relative && !path.isAbsolute(relative)
    && !relative.startsWith('..' + path.sep)
    && path.dirname(runRoot).toLowerCase() === ACCEPTANCE_ROOT.toLowerCase(),
  'ASTRBOT_ACCEPTANCE_RUN_ROOT_OUTSIDE_MARKER');
  const info = await fs.lstat(runRoot).catch(() => null);
  requireThat(info?.isDirectory() && !isReparsePoint(info),
    'ASTRBOT_ACCEPTANCE_RUN_ROOT_INVALID');
  return runRoot;
}

async function validateStateRoot(value) {
  const stateRoot = path.resolve(value);
  requireThat(path.basename(stateRoot).toLowerCase() === 'astrbot',
    'ASTRBOT_ACCEPTANCE_STATE_ROOT_INVALID');
  await validateRunRoot(path.dirname(stateRoot));
  const info = await fs.lstat(stateRoot).catch(() => null);
  requireThat(info?.isDirectory() && !isReparsePoint(info),
    'ASTRBOT_ACCEPTANCE_STATE_ROOT_INVALID');
  return stateRoot;
}

async function validateRegularFile(file, code) {
  const info = await fs.lstat(file).catch(() => null);
  requireThat(info?.isFile() && !isReparsePoint(info), code);
}

async function assertPortFree(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  }).catch(() => { throw acceptanceError(`ASTRBOT_ACCEPTANCE_PORT_${port}_IN_USE`); });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function fixtureZipBytes() {
  const mainPath = path.join(FIXTURE_ROOT, 'main.py');
  const metadataPath = path.join(FIXTURE_ROOT, 'metadata.yaml');
  const main = await fs.readFile(mainPath);
  const metadata = await fs.readFile(metadataPath);
  return zipStored([
    { name: 'astrbot_plugin_boundary/', data: Buffer.alloc(0) },
    { name: 'astrbot_plugin_boundary/main.py', data: main },
    { name: 'astrbot_plugin_boundary/metadata.yaml', data: metadata },
  ]);
}

async function makeFixtureZip(destination) {
  const archive = await fixtureZipBytes();
  await fs.writeFile(destination, archive, { flag: 'wx', mode: 0o600 });
  return archive;
}

function powershellExe() {
  const root = getEnv('SystemRoot') || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function runInstaller({ stateRoot, lockPath }) {
  requireThat(path.resolve(lockPath) === LOCK_PATH, 'ASTRBOT_ACCEPTANCE_INSTALLER_LOCK_INVALID');
  const installerEnv = safeWindowsEnvironment({ PIP_CONFIG_FILE: 'NUL', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' });
  assertNoAmbientSecrets(installerEnv, 'INSTALLER');
  console.log(JSON.stringify({ phase: 'installer', status: 'started', stateRoot }));
  const child = spawn(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER,
    '-Action', 'Install', '-StateRoot', stateRoot, '-LockPath', lockPath,
  ], { cwd: REPO_ROOT, env: installerEnv, windowsHide: true, stdio: 'inherit' });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(acceptanceError('ASTRBOT_ACCEPTANCE_INSTALLER_SIGNALLED'));
      else resolve(code);
    });
  });
  requireThat(exitCode === 0, 'ASTRBOT_ACCEPTANCE_INSTALLER_FAILED');
  console.log(JSON.stringify({ phase: 'installer', status: 'passed' }));
}

async function powershellJson(script) {
  const { stdout } = await execFile(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    cwd: REPO_ROOT,
    env: safeWindowsEnvironment(),
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

async function processTable() {
  const script = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); ConvertTo-Json -InputObject $p -Compress";
  const value = await powershellJson(script);
  return (Array.isArray(value) ? value : [value]).filter((item) => item && Number(item.ProcessId) > 0)
    .map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: String(item.Name || ''),
      executablePath: String(item.ExecutablePath || ''),
      commandLine: String(item.CommandLine || ''),
    }));
}

function sameProcessIdentity(actual, expected) {
  return actual.pid === expected.pid
    && actual.name === expected.name
    && actual.executablePath === expected.executablePath
    && actual.commandLine === expected.commandLine;
}

async function cleanupProbeProcesses(marker) {
  const root64 = Buffer.from(ACCEPTANCE_ROOT, 'utf8').toString('base64');
  const marker64 = Buffer.from(marker, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${root64}'))`,
    `$marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker64}'))`,
    "$matches=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine.Contains($marker) })",
    'foreach($target in $matches) {',
    "  $current=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$target.ProcessId)",
    '  if($current -and $current.Name -eq $target.Name -and $current.ExecutablePath -eq $target.ExecutablePath -and $current.CommandLine -eq $target.CommandLine) { Stop-Process -Id ([int]$target.ProcessId) -Force -ErrorAction SilentlyContinue }',
    '}',
    "$remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine.Contains($marker) })",
    'ConvertTo-Json -InputObject @{ remaining=@($remaining | ForEach-Object { $_.ProcessId }) } -Compress',
  ].join('\n');
  const result = await powershellJson(script);
  requireThat(Array.isArray(result?.remaining) && result.remaining.length === 0,
    'ASTRBOT_ACCEPTANCE_PROBE_CLEANUP_FAILED');
}

function descendantTree(rows, rootPid) {
  const found = new Map([[rootPid, { pid: rootPid, parentPid: null, name: '', commandLine: '' }]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.parentPid)) {
        found.set(row.pid, row);
        changed = true;
      }
    }
  }
  return [...found.values()];
}

async function waitForProcessesGone(expectedProcesses, timeoutMs = 10_000) {
  requireThat(Array.isArray(expectedProcesses) && expectedProcesses.length > 0
    && expectedProcesses.every((item) => Number.isInteger(item?.pid)
      && typeof item.name === 'string' && typeof item.executablePath === 'string'
      && typeof item.commandLine === 'string'),
  'ASTRBOT_ACCEPTANCE_PROCESS_SNAPSHOT_INVALID');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await processTable();
    const alive = expectedProcesses.some((expected) =>
      rows.some((actual) => sameProcessIdentity(actual, expected)));
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const rows = await processTable();
  if (expectedProcesses.some((expected) =>
    rows.some((actual) => sameProcessIdentity(actual, expected)))) {
    throw acceptanceError('ASTRBOT_ACCEPTANCE_NATIVE_CHILD_REMAINS');
  }
}

function lineReader(child) {
  return createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
}

async function nextLine(iterator, timeoutMs = 10_000) {
  let timer;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(acceptanceError('ASTRBOT_ACCEPTANCE_JOB_OBJECT_PROBE_TIMEOUT')), timeoutMs);
      }),
    ]);
    if (result.done) throw acceptanceError('ASTRBOT_ACCEPTANCE_JOB_OBJECT_PROBE_EOF');
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

async function exerciseWindowsJobObject(pythonExe, basePythonExe, stateRoot) {
  const env = safeWindowsEnvironment({
    __PYVENV_LAUNCHER__: pythonExe,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: RUNTIME_SOURCE,
  });
  assertNoAmbientSecrets(env, 'JOB_OBJECT_PROBE');
  const probeMarker = `astrbot-job-${randomUUID()}`;
  const parentCode = [
    'import json, os, subprocess, sys',
    'sys.path.insert(0, sys.argv[2])',
    'from qq_astrbot.processes import python_child_launch',
    'probe_marker = sys.argv[1]',
    "print(json.dumps({'phase':'parent-ready','pid':os.getpid(),'prefix':sys.prefix,'executable':sys.executable}), flush=True)",
    "if sys.stdin.readline().strip() != 'spawn': raise SystemExit(2)",
    'child_code = "import json,os,sys,time; print(json.dumps(dict(pid=os.getpid(),prefix=sys.prefix,executable=sys.executable)),flush=True); time.sleep(600)"',
    'child_executable, child_env = python_child_launch(dict(os.environ))',
    "child = subprocess.Popen([child_executable, '-u', '-c', child_code, probe_marker], env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=0x08000000)",
    'child_info = json.loads(child.stdout.readline())',
    "print(json.dumps({'childPid':child.pid,'reportedChildPid':child_info['pid'],'childPrefix':child_info['prefix'],'childExecutable':child_info['executable'],'parentPid':os.getpid(),'parentPrefix':sys.prefix}), flush=True)",
    "if sys.stdin.readline().strip() == 'terminate': child.terminate(); child.wait(timeout=5); print('child-terminated', flush=True)",
  ].join('\n');
  const runtimeSourceLiteral = JSON.stringify(RUNTIME_SOURCE);
  const jobCode = [
    'import ctypes, json, sys',
    'from ctypes import wintypes',
    `sys.path.insert(0, ${runtimeSourceLiteral})`,
    'from qq_astrbot.processes import ProcessTree',
    'tree = ProcessTree(int(sys.argv[1]))',
    "if tree.job is None: raise RuntimeError('ASTRBOT_PROCESS_TREE_UNAVAILABLE')",
    "print('job-attached', flush=True)",
    "child_line = sys.stdin.readline().strip()",
    "if not child_line.startswith('child:'): raise SystemExit(2)",
    "child_pid = int(child_line.split(':', 1)[1])",
    'tree.api.IsProcessInJob.argtypes = (wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL))',
    'tree.api.IsProcessInJob.restype = wintypes.BOOL',
    'def membership(pid):',
    '    handle = tree.api.OpenProcess(0x1000, False, pid)',
    '    if not handle: return False, False',
    '    inside = wintypes.BOOL()',
    '    ok = tree.api.IsProcessInJob(handle, tree.job, ctypes.byref(inside))',
    '    any_job = wintypes.BOOL()',
    '    any_ok = tree.api.IsProcessInJob(handle, None, ctypes.byref(any_job))',
    '    tree.api.CloseHandle(handle)',
    '    return bool(ok and inside.value), bool(any_ok and any_job.value)',
    "parent_membership = membership(int(sys.argv[1]))",
    'child_membership = membership(child_pid)',
    "print(json.dumps({'parentInJob': parent_membership[0], 'parentInAnyJob': parent_membership[1], 'childInJob': child_membership[0], 'childInAnyJob': child_membership[1]}), flush=True)",
    "if sys.stdin.readline().strip() != 'close': raise SystemExit(2)",
    'terminate_job_object = tree.api.TerminateJobObject',
    'def report_terminate(handle, exit_code):',
    '    result = terminate_job_object(handle, exit_code)',
    "    print(json.dumps({'terminateJobObject': bool(result), 'lastError': ctypes.get_last_error()}), flush=True)",
    '    return result',
    'tree.api.TerminateJobObject = report_terminate',
    'tree.close()',
    "print('job-closed', flush=True)",
  ].join('\n');

  const parent = spawn(basePythonExe, ['-u', '-c', parentCode, probeMarker, RUNTIME_SOURCE], {
    cwd: stateRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const parentLines = lineReader(parent);
  let jobProcess;
  let childPid;
  try {
    const ready = JSON.parse(await nextLine(parentLines));
    requireThat(ready.phase === 'parent-ready' && ready.pid === parent.pid
      && path.resolve(ready.prefix).toLowerCase() === path.dirname(path.dirname(pythonExe)).toLowerCase()
      && path.resolve(ready.executable).toLowerCase() === pythonExe.toLowerCase(),
      'ASTRBOT_ACCEPTANCE_JOB_OBJECT_PARENT_NOT_READY');
    jobProcess = spawn(basePythonExe, ['-u', '-c', jobCode, String(parent.pid)], {
      cwd: REPO_ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const jobLines = lineReader(jobProcess);
    const attached = await nextLine(jobLines);
    if (attached !== 'job-attached') throw acceptanceError('ASTRBOT_PROCESS_TREE_UNAVAILABLE');
    parent.stdin.write('spawn\n');
    const spawned = JSON.parse(await nextLine(parentLines));
    childPid = Number(spawned.childPid);
    requireThat(Number.isInteger(childPid) && childPid > 0
      && spawned.reportedChildPid === childPid
      && path.resolve(spawned.parentPrefix).toLowerCase() === path.dirname(path.dirname(pythonExe)).toLowerCase()
      && path.resolve(spawned.childPrefix).toLowerCase() === path.dirname(path.dirname(pythonExe)).toLowerCase()
      && path.resolve(spawned.childExecutable).toLowerCase() === pythonExe.toLowerCase(),
    'ASTRBOT_ACCEPTANCE_JOB_OBJECT_CHILD_PID_MISMATCH');
    const processSnapshot = await processTable();
    const expected = [parent.pid, childPid].map((pid) =>
      processSnapshot.find((row) => row.pid === pid));
    requireThat(expected.every((row) => row && row.commandLine.includes(probeMarker)
      && row.executablePath.toLowerCase().startsWith(ACCEPTANCE_ROOT.toLowerCase())),
    'ASTRBOT_ACCEPTANCE_JOB_OBJECT_CHILD_NOT_RUNNING');
    jobProcess.stdin.write(`child:${childPid}\n`);
    const membership = JSON.parse(await nextLine(jobLines));
    console.log(JSON.stringify({ phase: 'windows-job-object-membership', ...membership }));
    requireThat(membership.parentInJob === true && membership.childInJob === true,
      'ASTRBOT_ACCEPTANCE_JOB_OBJECT_PARENT_NOT_CONTAINED');
    const jobExited = new Promise((resolve) => jobProcess.once('exit', resolve));
    jobProcess.stdin.write('close\n');
    const termination = JSON.parse(await nextLine(jobLines));
    const closed = await nextLine(jobLines);
    requireThat(closed === 'job-closed', 'ASTRBOT_ACCEPTANCE_JOB_OBJECT_CLOSE_FAILED');
    requireThat(termination.terminateJobObject === true,
      'ASTRBOT_ACCEPTANCE_TERMINATE_JOB_OBJECT_FAILED');
    await jobExited;
    await waitForProcessesGone(expected);
    console.log(JSON.stringify({ phase: 'windows-job-object', status: 'passed',
      killedNativeChildCount: 2 }));
    return [parent.pid, childPid];
  } finally {
    if (jobProcess && jobProcess.exitCode === null) jobProcess.kill();
    if (parent.exitCode === null) {
      try {
        parent.stdin.write('terminate\n');
        await nextLine(parentLines, 1500);
      } catch {}
      if (parent.exitCode === null) parent.kill();
    }
    await cleanupProbeProcesses(probeMarker);
  }
}

function makeMessage(id, text, userId = MEMBER_ID) {
  return {
    messageType: 'group',
    groupId: GROUP_ID,
    userId,
    text,
    raw: {
      message_id: `windows-${id}-${randomUUID()}`,
      message: [{ type: 'text', data: { text } }],
      sender: { role: userId === ADMIN_ID ? 'owner' : 'member', nickname: 'windows-acceptance' },
    },
  };
}

function sentText(item) {
  return (Array.isArray(item?.params?.message) ? item.params.message : [])
    .filter((part) => part?.type === 'text' && typeof part?.data?.text === 'string')
    .map((part) => part.data.text).join('');
}

async function waitForSend(sends, expected, startIndex, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sends.slice(startIndex).find((item) => sentText(item) === expected);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw acceptanceError('ASTRBOT_ACCEPTANCE_SCHEDULED_SEND_TIMEOUT');
}

function openAiResponse(content) {
  return {
    id: 'qq-bridge-windows-acceptance',
    object: 'chat.completion',
    created: 0,
    model: 'controlled-windows-acceptance',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function waitForInstall(manager, id, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  while (Date.now() < deadline) {
    const job = await manager.job(id);
    requireThat(job && typeof job === 'object', 'ASTRBOT_ACCEPTANCE_INSTALL_JOB_MISSING');
    const state = `${job.phase || 'queued'}:${job.status || 'unknown'}:${job.progress || 0}`;
    if (state !== previous) {
      console.log(JSON.stringify({ phase: 'plugin-install', state }));
      previous = state;
    }
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      throw acceptanceError(/^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(job.error?.code || ''))
        ? job.error.code : 'ASTRBOT_ACCEPTANCE_INSTALL_FAILED');
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw acceptanceError('ASTRBOT_ACCEPTANCE_INSTALL_TIMEOUT');
}

async function fileFromBridgeUri(value) {
  requireThat(typeof value === 'string' && value.startsWith('file:'),
    'ASTRBOT_ACCEPTANCE_IMAGE_FILE_URI_MISSING');
  return fs.readFile(fileURLToPath(value));
}

async function verifyRuntimeTree(spawned) {
  requireThat(Number.isInteger(spawned.pid), 'ASTRBOT_ACCEPTANCE_SUPERVISOR_PID_MISSING');
  const rows = await processTable();
  const tree = descendantTree(rows, spawned.pid);
  const worker = tree.find((row) => /qq_astrbot\.worker/i.test(row.commandLine));
  requireThat(worker, 'ASTRBOT_ACCEPTANCE_NATIVE_WORKER_NOT_FOUND');
  return tree.map((row) => rows.find((actual) => actual.pid === row.pid)).filter(Boolean);
}

async function main() {
  requireThat(process.platform === 'win32', 'ASTRBOT_WINDOWS_ACCEPTANCE_REQUIRES_WINDOWS');
  requireThat(!getEnv('ASTRBOT_RUNTIME_MODE') && !getEnv('ASTRBOT_RUNTIME_URL'),
    'ASTRBOT_ACCEPTANCE_AMBIENT_RUNTIME_OVERRIDE_PRESENT');
  await prepareAcceptanceRoot();
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === '--job-object-probe') {
    const stateRoot = await validateStateRoot(String(arguments_[1] || ''));
    const pythonExe = path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
    const basePythonExe = path.join(stateRoot, 'runtime', 'python', 'python.exe');
    await validateRegularFile(pythonExe, 'ASTRBOT_ACCEPTANCE_PRIVATE_PYTHON_INVALID');
    await validateRegularFile(basePythonExe, 'ASTRBOT_ACCEPTANCE_BASE_PYTHON_INVALID');
    await exerciseWindowsJobObject(pythonExe, basePythonExe, stateRoot);
    console.log(JSON.stringify({ status: 'passed', probe: 'windows-job-object' }));
    return;
  }
  await assertPortFree(15831);
  await assertPortFree(15832);

  const reuseIndex = arguments_.indexOf('--reuse-run-root');
  requireThat(arguments_.length === 0 || (reuseIndex === 0 && arguments_.length === 2),
    'ASTRBOT_ACCEPTANCE_ARGUMENTS_INVALID');
  const reuseRunRoot = reuseIndex === 0
    ? await validateRunRoot(String(arguments_[1] || '')) : null;
  const runRoot = reuseRunRoot || path.join(ACCEPTANCE_ROOT,
    'run-' + new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + process.pid
      + '-' + randomUUID().slice(0, 8));
  const stateRoot = path.join(runRoot, 'astrbot');
  const runId = randomUUID();
  const archivePath = path.join(runRoot, 'fixture.zip');
  const configPath = path.join(runRoot, 'fake-config.json');
  let archive;
  if (reuseRunRoot) {
    await validateStateRoot(stateRoot);
    await validateRegularFile(archivePath, 'ASTRBOT_ACCEPTANCE_FIXTURE_ARCHIVE_INVALID');
    await validateRegularFile(configPath, 'ASTRBOT_ACCEPTANCE_FAKE_CONFIG_INVALID');
    archive = await fs.readFile(archivePath);
    requireThat(archive.equals(await fixtureZipBytes()),
      'ASTRBOT_ACCEPTANCE_FIXTURE_ARCHIVE_CHANGED');
    requireThat(JSON.stringify(JSON.parse(await fs.readFile(configPath, 'utf8')))
      === JSON.stringify({ acceptanceOnly: true }), 'ASTRBOT_ACCEPTANCE_FAKE_CONFIG_INVALID');
    await validateRegularFile(
      path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe'),
      'ASTRBOT_ACCEPTANCE_PRIVATE_PYTHON_MISSING',
    );
    await validateRegularFile(
      path.join(stateRoot, 'runtime', 'python', 'python.exe'),
      'ASTRBOT_ACCEPTANCE_BASE_PYTHON_MISSING',
    );
    await validateRegularFile(
      path.join(stateRoot, 'runtime', 'dependency-inventory.json'),
      'ASTRBOT_ACCEPTANCE_DEPENDENCY_INVENTORY_MISSING',
    );
    console.log(JSON.stringify({ phase: 'reuse-installed-runtime', runRoot, stateRoot }));
  } else {
    await fs.mkdir(runRoot, { recursive: false });
    archive = await makeFixtureZip(archivePath);
    await fs.writeFile(configPath, JSON.stringify({ acceptanceOnly: true }),
      { flag: 'wx', mode: 0o600 });
  }

  const [{ createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge }] = await Promise.all([
    import('../src/astrbot-manager.mjs'),
    import('../src/astrbot-policy.mjs'),
    import('../src/astrbot-bridge.mjs'),
  ]);
  const cfg = {
    stateDir: runRoot,
    security: {
      allowGroups: true,
      allowGroupIds: [GROUP_ID],
      allowFrom: [ADMIN_ID],
      denyFrom: [],
      adminUserIds: [ADMIN_ID],
      allowGroupMembers: true,
    },
    astrbot: {
      enabled: true,
      runtimeMode: 'managed',
      runtimeUrl: RUNTIME_URL,
      host: '127.0.0.1',
      port: 15831,
      callbackUrl: CALLBACK_URL,
    },
  };
  const readConfig = () => cfg;
  let installerRuns = 0;
  const launches = [];
  const ambientSecretValues = Object.entries(process.env)
    .filter(([name, value]) => /token|secret|password|passwd|api.?key|credential|private.?key|access.?key/i.test(name)
      && Boolean(value));
  const manager = createAstrbotManager({
    projectRoot: REPO_ROOT,
    configPath,
    readConfig,
    logger: () => {},
    installManagedPython: async (options) => {
      installerRuns += 1;
      requireThat(path.resolve(options.stateRoot) === path.resolve(stateRoot),
        'ASTRBOT_ACCEPTANCE_INSTALLER_STATE_ROOT_INVALID');
      await runInstaller({ stateRoot: options.stateRoot, lockPath: options.lockPath });
    },
    spawnImpl: (command, args, options) => {
      assertNoAmbientSecrets(options.env || {}, 'RUNTIME');
      const child = spawn(command, args, options);
      launches.push({ pid: child.pid, command, args: [...args], env: { ...(options.env || {}) } });
      return child;
    },
  });
  const policy = createAstrbotPolicy({ root: REPO_ROOT, readConfig });
  const sends = [];
  const modelRequests = [];
  const bridge = createAstrbotBridge({
    root: REPO_ROOT,
    readConfig,
    manager,
    policy,
    host: '127.0.0.1',
    port: 15832,
    // This array is the only message sink; it never contacts QQ/NapCat.
    send: async (action, params) => {
      sends.push({ action, params: structuredClone(params) });
      return { message_id: `windows-collector-${sends.length}` };
    },
    generate: async (request) => {
      modelRequests.push(request);
      const messages = Array.isArray(request?.messages) ? request.messages : [];
      const flattened = JSON.stringify(messages);
      return openAiResponse(flattened.includes('fixture-model-request')
        ? 'controlled-windows-model-response' : 'controlled-windows-response');
    },
  });

  let managerRunning = false;
  let bridgeStarted = false;
  let failure;
  const stoppedTrees = [];
  try {
    const callbackAddress = await bridge.start();
    bridgeStarted = true;
    requireThat(callbackAddress.address === '127.0.0.1' && callbackAddress.port === 15832,
      'ASTRBOT_ACCEPTANCE_CALLBACK_BIND_INVALID');
    await policy.setEnabled(false);

    console.log(JSON.stringify({ phase: 'managed-start', runtimeUrl: RUNTIME_URL,
      callbackUrl: CALLBACK_URL, stateRoot }));
    const started = await manager.start();
    managerRunning = true;
    requireThat(started.running === true && started.managed === true && started.external === false,
      'ASTRBOT_ACCEPTANCE_MANAGED_START_FAILED');
    requireThat(installerRuns === (reuseRunRoot ? 0 : 1),
      reuseRunRoot ? 'ASTRBOT_ACCEPTANCE_REUSE_REINSTALLED_RUNTIME'
        : 'ASTRBOT_ACCEPTANCE_PINNED_INSTALLER_NOT_RUN');
    requireThat(launches.length === 1, 'ASTRBOT_ACCEPTANCE_SUPERVISOR_LAUNCH_COUNT_INVALID');
    const runtimeToken = await manager.getToken({ create: false });
    requireThat(launches[0].env.QQ_ASTRBOT_TOKEN === runtimeToken,
      'ASTRBOT_ACCEPTANCE_RUNTIME_TOKEN_NOT_ISOLATED');
    for (const [name, value] of ambientSecretValues) {
      requireThat(launches[0].env[name] !== value, 'ASTRBOT_ACCEPTANCE_RUNTIME_SECRET_ENV_INHERITED');
    }

    const jobObjectPython = path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
    requireThat(await fs.stat(jobObjectPython).then((item) => item.isFile()).catch(() => false),
      'ASTRBOT_ACCEPTANCE_PRIVATE_PYTHON_MISSING');
    const basePython = path.join(stateRoot, 'runtime', 'python', 'python.exe');
    const jobProbePids = await exerciseWindowsJobObject(jobObjectPython, basePython, stateRoot);

    await fs.access(path.join(stateRoot, 'runtime', 'dependency-inventory.json'));
    const previousFixture = (await manager.listPlugins())
      .find((plugin) => plugin.id === 'qq_boundary_fixture');
    if (previousFixture?.enabled) {
      await manager.configure('qq_boundary_fixture', { enabled: false });
    }
    const install = await manager.install({ zipBase64: archive.toString('base64') });
    const installed = await waitForInstall(manager, install.id);
    requireThat(installed.status === 'succeeded' && installed.plugin === 'qq_boundary_fixture',
      'ASTRBOT_ACCEPTANCE_PLUGIN_INSTALL_FAILED');

    let plugins = await manager.listPlugins();
    let fixture = plugins.find((plugin) => plugin.id === 'qq_boundary_fixture');
    requireThat(fixture && fixture.enabled === false, 'ASTRBOT_ACCEPTANCE_PLUGIN_DEFAULT_NOT_DISABLED');
    await manager.configure('qq_boundary_fixture', { enabled: true });
    plugins = await manager.listPlugins();
    fixture = plugins.find((plugin) => plugin.id === 'qq_boundary_fixture');
    requireThat(fixture?.enabled === true, 'ASTRBOT_ACCEPTANCE_PLUGIN_ENABLE_FAILED');
    await policy.setGroup(GROUP_ID, { pluginIds: ['qq_boundary_fixture'], chatMode: 'dsh' });
    await policy.setEnabled(true);

    let result = await bridge.dispatch(makeMessage('echo', '/ast_echo windows-ok'));
    requireThat(result.status === 'handled' && sentText(sends.at(-1)) === 'echo:windows-ok'
      && sends.at(-1).action === 'send_group_msg'
      && String(sends.at(-1).params.group_id) === GROUP_ID,
    'ASTRBOT_ACCEPTANCE_ECHO_FAILED');

    const beforeAdminDenial = sends.length;
    await bridge.dispatch(makeMessage('admin-member', '/ast_admin', MEMBER_ID));
    requireThat(!sends.slice(beforeAdminDenial).some((item) => sentText(item).includes('admin-only')),
      'ASTRBOT_ACCEPTANCE_ADMIN_COMMAND_NOT_DENIED');
    result = await bridge.dispatch(makeMessage('admin-project', '/ast_admin', ADMIN_ID));
    requireThat(result.status === 'handled' && sentText(sends.at(-1)).includes('admin-only'),
      'ASTRBOT_ACCEPTANCE_ADMIN_COMMAND_FAILED');

    const beforeImage = sends.length;
    result = await bridge.dispatch(makeMessage('image', '/ast_image'));
    requireThat(result.status === 'handled' && sends.length === beforeImage + 1,
      'ASTRBOT_ACCEPTANCE_PNG_NOT_SENT');
    const imageSegment = sends.at(-1).params.message.find((part) => part?.type === 'image');
    const png = await fileFromBridgeUri(imageSegment?.data?.file);
    requireThat(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 2 && png.readUInt32BE(20) === 2,
    'ASTRBOT_ACCEPTANCE_PNG_CONTENT_INVALID');

    result = await bridge.dispatch(makeMessage('model', '/ast_llm'));
    requireThat(result.status === 'handled' && modelRequests.some((request) =>
      JSON.stringify(request?.messages || []).includes('fixture-model-request'))
      && sentText(sends.at(-1)) === 'controlled-windows-model-response',
    'ASTRBOT_ACCEPTANCE_CONTROLLED_MODEL_FAILED');
    console.log(JSON.stringify({ phase: 'plugin-policy-echo-admin-png-model', status: 'passed' }));

    const timerStart = sends.length;
    const timerMarker = `windows-${runId}`;
    result = await bridge.dispatch(makeMessage('timer', `/ast_timer 3 ${timerMarker}`));
    requireThat(result.status === 'handled'
      && sentText(sends.at(-1)).startsWith(`timer-scheduled:${timerMarker};`),
    'ASTRBOT_ACCEPTANCE_TIMER_NOT_SCHEDULED');
    const timerSend = await waitForSend(sends, `timer-fired:${timerMarker}`, timerStart);
    requireThat(String(timerSend.params.group_id) === GROUP_ID,
      'ASTRBOT_ACCEPTANCE_TIMER_SOURCE_SESSION_CHANGED');

    const crossMarker = `cross-${runId}`;
    const crossStart = sends.length;
    result = await bridge.dispatch(makeMessage('timer-cross', `/ast_timer 3 ${crossMarker} 987654321`));
    requireThat(result.status === 'handled'
      && sentText(sends.at(-1)).startsWith(`timer-scheduled:${crossMarker};`),
    'ASTRBOT_ACCEPTANCE_CROSS_GROUP_TIMER_NOT_SCHEDULED');
    await waitForSend(sends, `timer-denied-cross-group:${crossMarker}`, crossStart);
    requireThat(sends.slice(crossStart).every((item) => String(item.params.group_id) === GROUP_ID),
      'ASTRBOT_ACCEPTANCE_TIMER_CROSSED_GROUP');

    const restartMarker = `restart-${runId}`;
    const restartSendStart = sends.length;
    result = await bridge.dispatch(makeMessage('timer-restart', `/ast_timer 30 ${restartMarker}`));
    requireThat(result.status === 'handled'
      && sentText(sends.at(-1)).startsWith(`timer-scheduled:${restartMarker};`),
    'ASTRBOT_ACCEPTANCE_PERSISTENT_TIMER_NOT_SCHEDULED');

    let activeSupervisor = launches.at(-1);
    let processTree = await verifyRuntimeTree(activeSupervisor);
    requireThat(processTree.length >= 2, 'ASTRBOT_ACCEPTANCE_MANAGED_CHILD_NOT_FOUND');
    const stopped = await manager.stop();
    managerRunning = false;
    requireThat(stopped.stopped === true && stopped.managed === true,
      'ASTRBOT_ACCEPTANCE_MANAGED_STOP_FAILED');
    await waitForProcessesGone(processTree);
    stoppedTrees.push(processTree.length);

    const restarted = await manager.start();
    managerRunning = true;
    requireThat(restarted.running === true && restarted.managed === true && launches.length === 2,
      'ASTRBOT_ACCEPTANCE_MANAGED_RESTART_FAILED');
    result = await bridge.dispatch(makeMessage('post-restart', '/ast_echo restarted'));
    requireThat(result.status === 'handled' && sentText(sends.at(-1)) === 'echo:restarted',
      'ASTRBOT_ACCEPTANCE_POST_RESTART_DISPATCH_FAILED');
    const restartedTimer = await waitForSend(
      sends, `timer-fired:${restartMarker}`, restartSendStart, 45_000,
    );
    requireThat(String(restartedTimer.params.group_id) === GROUP_ID
      && sends.slice(restartSendStart).filter((item) => sentText(item) === `timer-fired:${restartMarker}`).length === 1,
    'ASTRBOT_ACCEPTANCE_PERSISTENT_TIMER_RESTORE_FAILED');
    activeSupervisor = launches.at(-1);
    processTree = await verifyRuntimeTree(activeSupervisor);
    requireThat(processTree.length >= 2, 'ASTRBOT_ACCEPTANCE_RESTART_CHILD_NOT_FOUND');
    const finalStop = await manager.stop();
    managerRunning = false;
    requireThat(finalStop.stopped === true && finalStop.managed === true,
      'ASTRBOT_ACCEPTANCE_FINAL_STOP_FAILED');
    await waitForProcessesGone(processTree);
    stoppedTrees.push(processTree.length);
    requireThat(installerRuns === (reuseRunRoot ? 0 : 1),
      'ASTRBOT_ACCEPTANCE_INSTALLER_REPEATED_UNEXPECTEDLY');
    console.log(JSON.stringify({ phase: 'managed-stop-restart-reap', status: 'passed',
      processTreeSizes: stoppedTrees, windowsJobObjectProbe: 'passed' }));
    console.log(JSON.stringify({ status: 'passed', runRoot, fixtureZip: archivePath,
      ambientSecretEnvInherited: false, sendsCaptured: sends.length }));
  } catch (error) {
    failure = error;
  } finally {
    try { await policy.setEnabled(false); }
    catch (error) { if (!failure) failure = error; }
    if (managerRunning) {
      try { await manager.stop(); }
      catch (error) { if (!failure) failure = error; }
    }
    if (bridgeStarted) {
      try { await bridge.stop(); }
      catch (error) { if (!failure) failure = error; }
    }
  }

  if (failure) throw acceptanceError(safeErrorCode(failure));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeErrorCode(error) }));
  process.exitCode = 1;
}
