import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridgeSupervisor } from './bridge-supervisor.js';
import { createEmbeddedBridge } from './embedded-bridge.js';
import { createLocalConsole } from './local-console.js';

export const CONSOLE_PREFIX = '/qq-bridge';

export function inferProjectRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
}

function stripPrefix(url) {
  const parsed = new URL(url || '/', 'http://127.0.0.1');
  if (parsed.pathname !== CONSOLE_PREFIX && !parsed.pathname.startsWith(`${CONSOLE_PREFIX}/`)) return null;
  const rest = parsed.pathname.slice(CONSOLE_PREFIX.length) || '/';
  return `${rest}${parsed.search}`;
}

/**
 * Same-origin console under the DSH web server. Desktop forwards dsh-app://
 * requests to that server, so this route is the one both shells can open.
 * Admission is the host connection fence; loopback alone is not enough.
 *
 * runMode "embedded" starts the message core in this process. The default
 * "standalone" keeps the supervised child and does not start it here.
 */
export async function mountCompanionConsole(ctx, {
  projectRoot,
  configFile = '',
  supervisor,
  serverFactory,
  runMode = 'standalone',
  agentRuntime = null,
  spawnImpl,
  startBridgeImpl,
  autoStart = false,
  openBrowser,
  consoleNow,
} = {}) {
  const root = path.resolve(projectRoot || inferProjectRoot());
  const explicitConfig = configFile ? path.resolve(root, configFile) : '';
  const configRoot = explicitConfig ? path.dirname(explicitConfig) : root;
  const mode = runMode === 'embedded' ? 'embedded' : 'standalone';
  const bridge = supervisor ?? (mode === 'embedded'
    ? createEmbeddedBridge({
      projectRoot: root,
      configFile: explicitConfig,
      agentRuntime,
      startBridgeImpl,
      log: ctx?.logger,
    })
    : createBridgeSupervisor({
      projectRoot: root,
      configFile: explicitConfig,
      ...(typeof spawnImpl === 'function' ? { spawnImpl } : {}),
    }));

  // Web/auth services can appear after this plugin. Their scopes own console
  // resources; only the outer plugin scope owns the shared bridge controller.
  const consoles = new Set();
  let disposed = false;
  let reason = 'waiting-for-web-services';

  function unregister(entry) {
    const dispose = entry.unregister;
    entry.unregister = null;
    entry.mounted = false;
    try { dispose?.(); } catch { /* route already gone */ }
  }

  function stopServer(entry) {
    if (!entry.stopping) {
      entry.stopping = Promise.resolve().then(async () => {
        await entry.local?.stop();
        await entry.server?.stop?.();
      }).catch((error) => {
        ctx.logger?.warn?.(`companion: 停止插件页控制台失败：${String(error?.message ?? error)}`);
      });
    }
    return entry.stopping;
  }

  function releaseConsole(entry) {
    if (entry.releasing) return entry.releasing;
    entry.disposed = true;
    unregister(entry);
    entry.releasing = (async () => {
      try { await entry.pending; } catch { /* mounting already reported its error */ }
      unregister(entry);
      await stopServer(entry);
      consoles.delete(entry);
    })();
    return entry.releasing;
  }

  function mount(scope) {
    if (disposed) return Promise.resolve();
    let webServer;
    let connection;
    try { webServer = scope.get('webServer'); } catch { webServer = null; }
    try { connection = scope.get('connection'); } catch { connection = null; }
    if (!webServer || typeof webServer.register !== 'function') {
      reason = 'no-web-server';
      ctx.logger?.info?.('companion: 当前宿主没有 webServer，插件页控制台不挂载');
      return Promise.resolve();
    }
    if (!connection || typeof connection.requestRejection !== 'function') {
      reason = 'no-connection-auth';
      ctx.logger?.warn?.('companion: 宿主没有连接鉴权，拒绝挂载插件页控制台');
      return Promise.resolve();
    }

    const entry = { server: null, unregister: null, pending: null, stopping: null, releasing: null, mounted: false, disposed: false };
    consoles.add(entry);
    scope.effect?.(() => () => releaseConsole(entry));
    entry.pending = (async () => {
      try {
        const createServer = serverFactory ?? (await import(pathToFileURL(path.join(root, 'src', 'webui', 'server.mjs')).href)).createWebUiServer;
        if (disposed || entry.disposed) return;
        let config = {};
        try {
          const { loadConfig } = await import(pathToFileURL(path.join(root, 'src', 'config.js')).href);
          config = loadConfig(configRoot, {
            createIfMissing: false,
            ...(explicitConfig ? { configFile: explicitConfig } : {}),
          }).config;
        } catch {
          config = {};
        }
        if (disposed || entry.disposed) return;
        const consoleServer = createServer({
          config,
          configRoot,
          ...(explicitConfig ? { configFile: explicitConfig } : {}),
          log: scope.logger,
          publicBase: CONSOLE_PREFIX,
          bridgeControl: bridge,
          openConsole: page => entry.local.open(page),
        });
        entry.server = consoleServer;
        entry.local = createLocalConsole({
          handle: consoleServer.handle,
          openBrowser,
          now: consoleNow,
          prefix: CONSOLE_PREFIX,
        });
        if (typeof consoleServer.activate === 'function') await consoleServer.activate();
        if (disposed || entry.disposed) return;

        entry.unregister = webServer.register({
          kind: 'prefix',
          path: CONSOLE_PREFIX,
          handler: async (req, res) => {
            const rejection = connection.requestRejection({ headers: req.headers });
            if (rejection) {
              res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
              res.end(rejection === 401 ? '需要 DSH 登录' : 'DSH 拒绝了这个来源');
              return;
            }
            if (req.headers['sec-fetch-site'] === 'cross-site') {
              res.writeHead(403, { 'cache-control': 'no-store' });
              res.end('跨站请求已拒绝');
              return;
            }
            const nextUrl = stripPrefix(req.url);
            if (!nextUrl) {
              res.writeHead(404, { 'cache-control': 'no-store' });
              res.end('not found');
              return;
            }
            req.url = nextUrl;
            await consoleServer.handle(req, res);
          },
        });
        entry.mounted = true;
        reason = null;
        if (disposed || entry.disposed) unregister(entry);
        else scope.logger?.info?.(`companion: 插件页控制台已挂到 ${CONSOLE_PREFIX}/`);
      } catch (error) {
        reason = 'mount-failed';
        await stopServer(entry);
        consoles.delete(entry);
        throw error;
      } finally {
        if (disposed || entry.disposed) await stopServer(entry);
      }
    })();
    return entry.pending;
  }

  ctx.effect?.(() => () => {
    disposed = true;
    return Promise.allSettled([
      ...[...consoles].map(releaseConsole),
      Promise.resolve().then(() => bridge.stop?.()),
    ]);
  });
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scope) => mount(scope).catch((error) => {
      ctx.logger?.warn?.(`companion: 插件页控制台没有挂上：${String(error?.message ?? error)}`);
    }));
  } else {
    await mount(ctx);
  }
  if (!disposed && autoStart && mode === 'embedded') {
    try {
      await bridge.start();
    } catch (error) {
      ctx.logger?.warn?.(`companion: 进程内桥接没有启动：${String(error?.message ?? error)}`);
    }
  }
  return {
    bridge,
    runMode: mode,
    get mounted() { return [...consoles].some(entry => entry.mounted); },
    get reason() { return this.mounted ? undefined : reason; },
    prefix: CONSOLE_PREFIX,
  };
}
