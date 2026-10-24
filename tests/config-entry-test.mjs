import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeNapCat } from './ws-harness.mjs';
import { isolatedEnv } from './helpers/isolated-fixtures.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('bridge entry loads the selected file and resolves resources from its directory', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-config-entry-'));
  const bot = createFakeNapCat();
  t.after(async () => {
    await bot.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('qq-config-entry-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.cp(path.join(PROJECT, 'src'), path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const port = await bot.listen();
  const config = {
    onebot: { url: `ws://127.0.0.1:${port}` },
    dsh: { mode: 'headless', companion: false, patchPath: '', cwd: '.' },
    security: { allowFrom: [1000000002] },
    memory: { enabled: false, reflectDaily: false },
    plugins: { enabled: false }, persona: { enabled: false }, stickers: { enabled: false },
  };
  const cases = [
    { name: 'custom JSON filename', file: 'custom/custom.json' },
    { name: 'existing file without a JSON extension', file: 'other/bridge.settings' },
    { name: 'directory argument', file: 'directory/config.json', directory: true },
    { name: 'explicit CLI file overrides QQ_CONFIG', file: 'explicit/config.json', env: path.join(root, 'missing.json') },
    { name: 'QQ_CONFIG custom filename', file: 'environment/alternate.json', environment: true },
    { name: 'relative QQ_CONFIG is resolved from the process cwd', file: 'relative/alternate.json', environment: true, relative: true },
    { name: 'default project configuration', file: 'config.json', default: true },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const configPath = path.join(root, item.file);
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      await fsp.writeFile(configPath, JSON.stringify(config));
      const cwd = path.join(root, 'working-directory');
      await fsp.mkdir(cwd, { recursive: true });
      const argv = [path.join(root, 'src', 'index.js')];
      if (!item.environment && !item.default) argv.push('--config', item.directory ? path.dirname(configPath) : configPath);
      const child = spawn(process.execPath, argv, {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: isolatedEnv(root, { QQ_CONFIG: item.environment
          ? (item.relative ? path.relative(cwd, configPath) : configPath) : item.env ?? '' }),
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = once(child, 'exit');
      try {
        const statusPath = path.join(path.dirname(configPath), 'state', 'status.json');
        const deadline = Date.now() + 7000;
        let connected = false;
        while (Date.now() < deadline && child.exitCode === null) {
          try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            connected = status.pid === child.pid && status.connected === true;
          } catch { /* Wait for the first status write. */ }
          if (connected) break;
          await delay(25);
        }
        assert.equal(connected, true, output);
        assert.ok(output.includes(configPath), output);
        assert.ok(fs.existsSync(path.join(path.dirname(configPath), 'logs')));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    });
  }
});
