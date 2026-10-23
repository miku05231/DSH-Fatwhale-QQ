import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveDshInstallRoot } from '../../src/dsh-desktop.js';

export const DSH_TEST_VERSION = '0.2.0-rc.2';

export function isolatedEnv(root, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:path|pathext|systemroot|windir|comspec|processor_architecture|lang|lc_all|tz|ci|node_no_warnings)$/i.test(key)
        || /^QQ_TEST_/.test(key) || key === 'QQ_PLATFORM_BROWSER_TEST') env[key] = value;
  }
  const home = path.join(root, 'home');
  return {
    ...env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), DSH_HOME: path.join(home, '.dsh'),
    TEMP: root, TMP: root, TMPDIR: root, DSH_TELEMETRY_DISABLED: '1',
    ...extra,
  };
}

export function browserRuntimeEnv(root, extra = {}) {
  const env = isolatedEnv(root, extra);
  // Windows Known Folders requires the registered profile for browser startup.
  // Every browser caller still supplies a fresh --user-data-dir.
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function useIsolatedEnv(root, extra = {}) {
  const previous = { ...process.env };
  const next = isolatedEnv(root, extra);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  };
}

export async function prepareIsolatedHome(root) {
  for (const dir of ['appdata', 'localappdata', 'config', 'cache', 'data', '.dsh']) {
    await fs.mkdir(path.join(root, 'home', dir), { recursive: true });
  }
}

export async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export function modelLayer(baseURL, provider = 'test-local', model = 'test-chat') {
  return `- id: llm-pi-ai
  config:
    providers:
      ${provider}:
        api: openai-completions
        baseURL: ${baseURL}
        apiKeyEnv: QQ_FIXTURE_API_KEY
        models:
          - id: ${model}
            input: [text]
            contextWindow: 32000
            reasoningEfforts:
              high: high
- id: agent-default-model
  config:
    provider: ${provider}
    model: ${model}
    reasoningEffort: high
`;
}

export async function createLocalDshFixture({ prefix = 'qq-local-dsh-', reply = () => 'fixture reply' } = {}) {
  const installRoot = resolveDshInstallRoot(process.env.QQ_TEST_DSH_COMMAND || 'dsh', process.cwd());
  const pkg = JSON.parse(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8'));
  if (pkg.version !== DSH_TEST_VERSION) {
    throw new Error(`Set QQ_TEST_DSH_COMMAND to DSH ${DSH_TEST_VERSION}; found ${pkg.version}`);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await prepareIsolatedHome(root);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const content = await reply(body, requests);
      if (res.destroyed || content === null) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: String(content) }, null], [{}, 'stop'],
      ]) {
        res.write(`data: ${JSON.stringify({
          id: 'fixture-chat', object: 'chat.completion.chunk', created: 1,
          model: 'test-chat', choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const patchPath = path.join(root, 'model.yml');
  const layer = modelLayer(`http://127.0.0.1:${server.address().port}/v1`);
  await fs.writeFile(patchPath, layer);
  const env = isolatedEnv(root, { QQ_FIXTURE_API_KEY: 'synthetic-local-key' });
  return {
    root, workspace, patchPath, layer, env, requests,
    command: path.join(installRoot, 'lib', 'bin.js'),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function createConsoleFixture(root, { napcatHealth, platformQrLogin } = {}) {
  const configPath = path.join(root, 'config.json');
  const restoreEnv = useIsolatedEnv(root, { QQ_CONFIG: configPath });
  let instance;
  try {
    await prepareIsolatedHome(root);
    const { loadConfig } = await import('../../src/config.js');
    const { createWebUiServer } = await import('../../src/webui/server.mjs');
    const { ObsidianMemory } = await import('../../src/memory.js');
    const { config } = loadConfig(root);
    config.onebot = { url: `ws://127.0.0.1:${await freePort()}`, accessToken: 'synthetic-onebot-token' };
    config.dsh = { ...config.dsh, mode: 'headless', companion: false, cwd: 'workspace', patchPath: 'model.yml' };
    config.persona.path = 'workspace/AGENTS.md';
    config.behavior.groupContextCount = 40;
    config.memory = { ...config.memory, root: 'memory', reflectDaily: false, reflectEvery: 0 };
    config.stickers.root = 'state/stickers';
    await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.mkdir(path.join(root, 'logs'), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config));
    await fs.writeFile(path.join(root, 'workspace', 'AGENTS.md'), '# Fixture persona\nUse concise answers.\n');
    const layer = modelLayer('http://127.0.0.1:1/v1');
    await fs.writeFile(path.join(root, 'model.yml'), layer);
    const desktop = path.join(root, 'home', '.dsh', 'profiles', 'desktop');
    await fs.mkdir(desktop, { recursive: true });
    await fs.writeFile(path.join(desktop, 'cordis.patch.yml'), layer);
    await fs.writeFile(path.join(root, 'logs', 'bridge-console.log'), 'Fixture bridge started.\ntoken=synthetic-onebot-token\n');
    await fs.writeFile(path.join(root, 'logs', 'napcat-console.log'), 'Fixture NapCat started.\n');
    const memory = new ObsidianMemory({ root: path.join(root, 'memory') });
    await memory.ensure();
    await fs.writeFile(path.join(root, 'memory', '20-群聊', 'fixture.md'), '# 群聊测试\n群聊记忆来自隔离 fixture。\n');
    const updateStatus = {
      currentVersion: '0.0.0', latestVersion: '0.0.0', phase: 'idle', automatic: false,
      checkedAt: null, releaseUrl: '', releaseNotes: '', canInstall: false,
      installReason: 'Isolated test console', progress: null, error: '',
    };
    instance = createWebUiServer({
      config, configRoot: root, port: await freePort(), napcatHealth, platformQrLogin,
      updateManager: {
        async start() {}, stop() {}, async status() { return { ...updateStatus }; },
      },
    });
    await instance.start();
    return {
      instance, config, configPath, port: instance.port,
      async close() { await instance.stop(); restoreEnv(); },
    };
  } catch (error) {
    await instance?.stop();
    restoreEnv();
    throw error;
  }
}
