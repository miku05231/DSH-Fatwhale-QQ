import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WINDOWS_HELPER = fileURLToPath(new URL('./open-console.ps1', import.meta.url));

/** Open only a generated loopback console URL, with no shell interpolation. */
export function openLocalConsoleUrl(target, { spawnImpl = spawn, platform = process.platform } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || !url.pathname.endsWith('/auth')
    || !/^#grant=[A-Za-z0-9_-]{43}$/.test(url.hash)) {
    throw new TypeError('只允许打开本机控制台');
  }
  const command = platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_HELPER, '-Url', url.href]
    : [url.href];
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    function finish(error) {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    try {
      child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      finish(new Error('无法打开默认浏览器'));
      return;
    }
    child.once('error', () => finish(new Error('无法打开默认浏览器')));
    child.once('close', code => finish(code === 0 ? null : new Error('无法打开默认浏览器')));
    timer = setTimeout(() => {
      child.kill?.();
      finish(new Error('打开默认浏览器超时'));
    }, 15_000);
    timer.unref?.();
  });
}
