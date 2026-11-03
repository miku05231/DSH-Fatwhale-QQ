import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from '../src/dsh.js';
import { isolatedEnv, prepareIsolatedHome } from './helpers/isolated-fixtures.mjs';

const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = `[Console]::Out.WriteLine('script-start')
$ErrorActionPreference = 'Stop'
$null = New-Object Text.StringBuilder
[Console]::Out.WriteLine('new-object-complete')
Add-Type -TypeDefinition 'public class QQStartupProbe { public static int Value() { return 1; } }'
[Console]::Out.WriteLine('add-type-complete')
Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c exit 0' -WindowStyle Hidden -Wait
[Console]::Out.WriteLine('start-process-complete')
`;

for (const mode of ['PSModulePath', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ALLUSERSPROFILE', 'ProgramW6432', 'CommonProgramFiles']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-startup-probe-'));
  await prepareIsolatedHome(root);
  const env = mode === 'inherited' ? { ...process.env } : isolatedEnv(root);
  if (mode === 'system-paths') {
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'SystemDrive', 'PSModulePath']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  if (process.env[mode] !== undefined) env[mode] = process.env[mode];
  if (mode === 'system-modules') env.PSModulePath = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  if (mode === 'system-drive') env.SystemDrive = process.env.SystemDrive;
  const started = Date.now();
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => console.log(JSON.stringify({ mode, elapsedMs: Date.now() - started, stream, text: data.toString('utf8').slice(0, 1500) })));
  const timer = setTimeout(() => killProcessTree(child), 20000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: error.code }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  console.log(JSON.stringify({ mode, elapsedMs: Date.now() - started, ...result }));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
