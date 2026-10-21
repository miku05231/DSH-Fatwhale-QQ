import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_HELPER = fileURLToPath(new URL('./open-path.ps1', import.meta.url));

function launchDetached(command, args, { spawnImpl = spawn, windowsHide = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, windowsHide, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    // spawn errors arrive asynchronously; keep this listener after spawn as well.
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function requireTarget(target) {
  if (typeof target !== 'string' || !target.trim() || target.includes('\0')) {
    throw new TypeError('A non-empty path or URL is required');
  }
}

function openWindowsPath(target, { select, spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let finished = false;
    let stdout = '';
    let stderr = '';
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      child = spawnImpl(powershell, [
        '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
        '-File', WINDOWS_HELPER, '-Target', target, ...(select ? ['-SelectFile'] : []),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(err);
      return;
    }
    child.once('error', finish);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Opening the folder failed (exit ${code})`));
        return;
      }
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (result.visible !== true) throw new Error('The folder window was not confirmed visible');
        finish();
      } catch (err) {
        finish(new Error(`The folder window was not confirmed visible: ${err.message}`));
      }
    });
    timer = setTimeout(() => {
      finish(new Error('Opening the folder timed out'));
      child.kill();
    }, timeoutMs);
  });
}

export async function openLocalPath(target, {
  select = false, spawnImpl = spawn, platform = process.platform, timeoutMs = 15_000,
} = {}) {
  requireTarget(target);
  if (platform === 'win32') {
    return openWindowsPath(target, { select, spawnImpl, timeoutMs });
  }
  if (platform === 'darwin') {
    return launchDetached('open', select ? ['-R', target] : [target], { spawnImpl });
  }
  return launchDetached('xdg-open', [select ? path.dirname(target) : target], { spawnImpl });
}

export async function openExternalUrl(target, { spawnImpl = spawn, platform = process.platform } = {}) {
  requireTarget(target);
  if (platform === 'win32') {
    return launchDetached('cmd.exe', ['/c', 'start', '""', target], { spawnImpl, windowsHide: true });
  }
  return launchDetached(platform === 'darwin' ? 'open' : 'xdg-open', [target], { spawnImpl });
}
