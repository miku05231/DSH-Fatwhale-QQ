import { spawn } from 'node:child_process';
import path from 'node:path';

const STOP_GRACE_MS = 4000;

/**
 * Run the bridge CLI as its own process. The DSH host must not call
 * process.exit, so start/stop here is a supervised child of src/index.js.
 */
export function createBridgeSupervisor({
  projectRoot,
  configFile = '',
  execPath = process.execPath,
  spawnImpl = spawn,
} = {}) {
  if (!projectRoot) throw new Error('桥接目录不能为空');
  const root = path.resolve(projectRoot);
  const script = path.join(root, 'src', 'index.js');
  let child = null;
  let stopping = null;

  function status() {
    return {
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child && child.exitCode === null ? child.pid : 0,
      projectRoot: root,
    };
  }

  function start() {
    if (status().running) return status();
    const args = [script];
    if (configFile) args.push('--config', configFile);
    child = spawnImpl(execPath, args, {
      cwd: root,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('exit', () => {
      child = null;
    });
    return status();
  }

  function stop() {
    if (!child || child.exitCode !== null) {
      child = null;
      return Promise.resolve(status());
    }
    if (stopping) return stopping;
    const current = child;
    stopping = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { current.kill('SIGKILL'); } catch { /* already gone */ }
      }, STOP_GRACE_MS);
      timer.unref?.();
      current.once('exit', () => {
        clearTimeout(timer);
        if (child === current) child = null;
        stopping = null;
        resolve(status());
      });
      try { current.kill('SIGTERM'); } catch { /* already gone */ }
    });
    return stopping;
  }

  return { start, stop, status };
}
