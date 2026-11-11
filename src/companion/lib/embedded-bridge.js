import path from 'node:path';

/**
 * Run startBridge inside this process. start() never throws: NapCat being down,
 * a bad config file, or an unexpected exception stays on the returned status
 * so the DSH host can keep serving.
 */
export function createEmbeddedBridge({
  projectRoot,
  configFile = '',
  agentRuntime = null,
  startBridgeImpl = null,
  log = null,
} = {}) {
  if (!projectRoot) throw new Error('桥接目录不能为空');
  const root = path.resolve(projectRoot);
  let handle = null;
  let starting = null;
  let stopping = null;
  let lastError = null;
  let generation = 0;

  function status() {
    let live = null;
    try {
      live = handle?.status?.() ?? null;
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 300);
    }
    const running = Boolean(handle) && !stopping;
    return {
      running,
      pid: running ? process.pid : 0,
      projectRoot: root,
      mode: 'embedded',
      connected: live?.connected === true,
      lastError: live?.lastError ?? lastError,
      onebotUrl: live?.onebotUrl ?? '',
    };
  }

  async function start() {
    if (stopping) await stopping;
    if (handle) return status();
    if (starting) return starting;
    const token = ++generation;
    // Defer execution until pending and starting are both assigned. An injected
    // start implementation may throw synchronously, before its first await.
    const pending = Promise.resolve().then(async () => {
      let next = null;
      try {
        const imported = typeof startBridgeImpl === 'function' ? null : await import('../../index.js');
        const impl = startBridgeImpl ?? imported.startBridge;
        const argv = [];
        if (configFile) argv.push('--config', path.resolve(root, configFile));
        next = await impl({
          argv,
          embedded: true,
          ...(agentRuntime ? { agentRuntime } : {}),
        });
        if (token !== generation) return status();
        if (!next || typeof next.stop !== 'function') {
          throw new Error('进程内桥接没有返回停止句柄');
        }
        handle = next;
        lastError = null;
      } catch (error) {
        if (token === generation) {
          handle = null;
          lastError = String(error?.message ?? error).slice(0, 300);
          log?.warn?.(`companion: 进程内桥接没有启动：${lastError}`);
        }
      } finally {
        if (next && token !== generation) {
          try { await next.stop('stop'); } catch { /* 过期启动直接关掉 */ }
        }
      }
      return status();
    }).finally(() => {
      if (starting === pending) starting = null;
    });
    starting = pending;
    return pending;
  }

  function stop() {
    if (stopping) return stopping;
    const token = ++generation;
    const current = handle;
    handle = null;
    const pendingStart = starting;
    // The microtask also makes an idle stop clear stopping after assignment.
    const pending = Promise.resolve().then(async () => {
      try {
        if (pendingStart) await pendingStart;
        if (current) await current.stop('stop');
        if (handle && token === generation) {
          const stale = handle;
          handle = null;
          await stale.stop('stop');
        }
      } catch (error) {
        lastError = String(error?.message ?? error).slice(0, 300);
        log?.warn?.(`companion: 停止进程内桥接失败：${lastError}`);
      }
      return status();
    }).finally(() => {
      if (stopping === pending) stopping = null;
    });
    stopping = pending;
    return pending;
  }

  return { start, stop, status };
}
