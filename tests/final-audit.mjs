#!/usr/bin/env node
// Audit the public project and a generated config, without loading user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig, resolvePath } from '../src/config.js';
import { resolvePatchChain } from '../src/dsh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function check(label, run) {
  await run();
  passed += 1;
  console.log(`  OK ${label}`);
}
const required = [
  'package.json', 'config.example.json', 'README.md', 'LICENSE',
  'qq-bridge.cmd', 'assets/app-icon.png', 'assets/app-icon.ico',
  'launcher/bootstrap.ps1', 'launcher/Launcher.ps1', 'launcher/lib/TrayAppearance.ps1',
  'launcher/lib/ProcessControl.ps1', 'launcher/lib/UiWindows.ps1',
  'scripts/setup.ps1', 'scripts/install-napcat.ps1', 'scripts/install-update.ps1',
  'src/index.js', 'src/config.js', 'src/dsh.js', 'src/memory.js', 'src/updates.mjs',
  'src/webui/server.mjs', 'src/webui/public/index.html', 'src/webui/public/app.js',
  'src/webui/public/app.css', 'tools/qq.mjs', 'tools/memory.mjs', 'tools/reflect.mjs',
  'tests/run-all.mjs', 'tests/ws-harness.mjs', 'tests/helpers/isolated-fixtures.mjs',
];
for (const file of required) {
  await check(`public file: ${file}`, () => fs.access(path.join(ROOT, file)));
}

async function walk(dir) {
  const files = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(file));
    else if (item.isFile()) files.push(file);
  }
  return files;
}
for (const dir of ['src', 'launcher', 'scripts', 'patches', 'tools', 'tests']) {
  for (const file of await walk(path.join(ROOT, dir))) {
    const ext = path.extname(file).toLowerCase();
    const windowsEntry = ext === '.ps1' && ['launcher', 'scripts'].includes(dir);
    if (!['.js', '.mjs', '.json', '.yml', '.yaml'].includes(ext) && !windowsEntry) continue;
    const bytes = await fs.readFile(file);
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    await check(`encoding: ${path.relative(ROOT, file)}`, () => assert.equal(bom, windowsEntry));
  }
}

const example = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
await check('public example has no access token', () => assert.equal(example.onebot.accessToken, ''));
for (const value of [example.dsh.cwd, example.dsh.patchPath, example.persona.path, example.memory.root,
  example.stateDir, example.logDir, example.stickers.root]) {
  await check(`portable example path: ${value}`, () => {
    assert.equal(typeof value, 'string');
    assert(value.trim().length > 0);
    assert.equal(path.win32.isAbsolute(value) || path.posix.isAbsolute(value), false);
    assert(!value.split(/[\\/]/).includes('..'));
    const relative = path.relative(ROOT, path.resolve(ROOT, value));
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
const modelPatch = path.resolve(ROOT, example.dsh.patchPath);
await check('public example model patch exists', () => fs.access(modelPatch));
await check('built-in configuration denies unspecified users', () => {
  assert.deepEqual(DEFAULTS.security.allowFrom, []);
  assert.deepEqual(DEFAULTS.security.adminUserIds, []);
});

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-public-audit-'));
try {
  await fs.copyFile(path.join(ROOT, 'config.example.json'), path.join(fixture, 'config.example.json'));
  const fixturePatch = path.resolve(fixture, example.dsh.patchPath);
  await fs.mkdir(path.dirname(fixturePatch), { recursive: true });
  await fs.copyFile(modelPatch, fixturePatch);
  const loaded = loadConfig(fixture, { configFile: 'config.json' });
  await check('clean installation creates a valid config', async () => {
    const written = JSON.parse(await fs.readFile(path.join(fixture, 'config.json'), 'utf8'));
    assert.deepEqual(written, example);
    assert.deepEqual(loaded.config.security.adminUserIds, []);
  });
  await check('default paths remain within the temporary installation', () => {
    for (const value of [loaded.config.dsh.cwd, loaded.config.dsh.patchPath, loaded.config.persona.path,
      loaded.config.memory.root, loaded.config.stateDir, loaded.config.logDir, loaded.config.stickers.root]) {
      const resolved = resolvePath(fixture, value);
      const relative = path.relative(fixture, resolved);
      assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    }
  });
  await check('relative public model patch resolves from config root', () => {
    const chain = resolvePatchChain({
      dshCfg: loaded.config.dsh, projectRoot: fixture,
      workDir: resolvePath(fixture, loaded.config.dsh.cwd),
    });
    assert.equal(chain.ok, true);
    assert.deepEqual(chain.patches, [fixturePatch]);
  });
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
console.log(`\n最终审计：通过 ${passed} 项公共文件、编码与隔离配置检查`);
