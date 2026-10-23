import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3]);
let instance;
let stopping;

function notify(type, extra = {}) {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send({ type, pid: process.pid, ...extra }, () => resolve());
  });
}

function stop(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    try {
      await instance?.stop();
      await notify('stopped');
      process.exitCode = code;
    } catch {
      await notify('failed', { code: 'console-stop-failed' });
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  return stopping;
}

process.on('message', (message) => {
  if (message?.type === 'stop') void stop();
});
process.once('disconnect', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  if (!process.connected || !path.basename(root).startsWith('qq-napcat-console-process-')
      || process.env.QQ_CONFIG !== path.join(root, 'config.json')
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('isolated-console-arguments-required');
  }
  const config = JSON.parse(await fs.readFile(process.env.QQ_CONFIG, 'utf8'));
  const { createWebUiServer } = await import('../../src/webui/server.mjs');
  instance = createWebUiServer({
    config, configRoot: root, port,
    updateManager: { async start() {}, stop() {} },
  });
  await instance.start();
  await notify('ready', { url: instance.url });
} catch {
  await notify('failed', { code: 'console-start-failed' });
  await stop(1);
}
