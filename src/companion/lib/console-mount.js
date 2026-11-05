import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridgeSupervisor } from './bridge-supervisor.js';
import { createEmbeddedBridge } from './embedded-bridge.js';

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
} = {}) {
  const root = path.resolve(projectRoot || inferProjectRoot());
  const mode = runMode === 'embedded' ? 'embedded' : 'standalone';
  const bridge = supervisor ?? (mode === 'embedded'
    ? createEmbeddedBridge({
      projectRoot: root,
      configFile,
      agentRuntime,
      startBridgeImpl,
      log: ctx?.logger,
    })
    : createBridgeSupervisor({
      projectRoot: root,
      configFile,
      ...(typeof spawnImpl === 'function' ? { spawnImpl } : {}),
    }));

  let disposeRoute = null;
  const release = () => {
    try { disposeRoute?.(); } catch { /* route already gone */ }
    return bridge.stop?.();
  };

  let webServer;
  let connection;
  try { webServer = ctx.get('webServer'); } catch { webServer = null; }
  try { connection = ctx.get('connection'); } catch { connection = null; }

  async function finish(result) {
    ctx.effect?.(() => release);
    if (autoStart && mode === 'embedded') {
      try {
        await bridge.start();
      } catch (error) {
        ctx.logger?.warn?.(`companion: 进程内桥接没有启动：${String(error?.message ?? error)}`);
      }
    }
    return { ...result, bridge, runMode: mode };
  }

  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.info?.('companion: 当前宿主没有 webServer，插件页控制台不挂载');
    return finish({ mounted: false, reason: 'no-web-server' });
  }
  if (!connection || typeof connection.requestRejection !== 'function') {
    ctx.logger?.warn?.('companion: 宿主没有连接鉴权，拒绝挂载插件页控制台');
    return finish({ mounted: false, reason: 'no-connection-auth' });
  }

  const createServer = serverFactory ?? (await import(pathToFileURL(path.join(root, 'src', 'webui', 'server.mjs')).href)).createWebUiServer;
  let config = {};
  try {
    const { loadConfig } = await import(pathToFileURL(path.join(root, 'src', 'config.js')).href);
    const loaded = loadConfig(root, {
      createIfMissing: false,
      ...(configFile ? { configFile } : {}),
    });
    config = loaded.config;
  } catch {
    config = {};
  }
  const consoleServer = createServer({
    config,
    configRoot: root,
    log: ctx.logger,
    publicBase: CONSOLE_PREFIX,
    bridgeControl: bridge,
  });
  if (typeof consoleServer.activate === 'function') await consoleServer.activate();

  disposeRoute = webServer.register({
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
  ctx.logger?.info?.(`companion: 插件页控制台已挂到 ${CONSOLE_PREFIX}/`);
  return finish({ mounted: true, prefix: CONSOLE_PREFIX });
}
