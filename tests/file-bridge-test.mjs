import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allowedFileRoots,
  normalizeFileMappings,
  prepareFileForNapcat,
} from '../src/file-bridge.js';
import { DEFAULTS, validateConfig } from '../src/config.js';
import { inspectDshRuntime } from '../src/dsh.js';

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}
async function asyncOk(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-bridge-files-'));
const stateDir = path.join(tmp, 'state');
const sharedDir = path.join(tmp, 'shared');
const outsideDir = path.join(tmp, 'outside');
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(sharedDir, { recursive: true });
await fs.mkdir(outsideDir, { recursive: true });
process.on('exit', () => { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

const config = {
  ...structuredClone(DEFAULTS),
  stateDir,
  files: {
    mappings: [{ container: sharedDir, napcat: '/volume1' }],
    napcatStateDir: '/app/state',
    allowedRoots: [],
  },
};
validateConfig(structuredClone(config));

try {
  ok('default config declares an empty file mapping list', () => {
    assert.deepEqual(DEFAULTS.files, { mappings: [] });
  });

  ok('invalid file mappings are rejected', () => {
    for (const mappings of [
      'nope',
      [{ container: 'relative', napcat: '/volume1' }],
      [{ container: '/volume1', napcat: 'relative' }],
      [{ container: 1, napcat: '/volume1' }],
    ]) {
      assert.throws(() => validateConfig({
        ...structuredClone(DEFAULTS), files: { mappings },
      }), /files\.mappings/);
    }
  });

  ok('normalization ignores malformed entries and strips trailing separators', () => {
    assert.deepEqual(normalizeFileMappings({
      files: { mappings: [
        { container: `${sharedDir}/`, napcat: '/volume1/' },
        { container: 'relative', napcat: '/x' },
        null,
      ] },
    }), [{ container: sharedDir, napcat: '/volume1' }]);
  });

  ok('allowed roots include mappings, state, workspace and memory', () => {
    const roots = allowedFileRoots(config, {
      configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'), stickerDir: path.join(tmp, 'stickers'),
    });
    for (const root of [
      sharedDir, stateDir, path.join(tmp, 'workspace'),
      path.join(tmp, 'memory'), path.join(tmp, 'stickers'),
    ]) {
      assert.ok(roots.includes(root), root);
    }
  });

  await asyncOk('a shared file is copied into the NapCat-visible outbox', async () => {
    const source = path.join(sharedDir, '报告 #1.txt');
    await fs.writeFile(source, 'hello from NAS\n');
    const result = await prepareFileForNapcat(source, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.copied, true);
    assert.match(result.file, /^\/app\/state\/outbox\//);
    const relative = result.file.slice('/app/state/'.length);
    assert.equal(await fs.readFile(path.join(stateDir, relative), 'utf8'), 'hello from NAS\n');
  });

  await asyncOk('a file already in state keeps its path without copying', async () => {
    const source = path.join(stateDir, 'already.txt');
    await fs.writeFile(source, 'inline\n');
    const result = await prepareFileForNapcat(source, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.copied, false);
    assert.equal(result.file, '/app/state/already.txt');
  });

  await asyncOk('files outside every allowed root are refused', async () => {
    const source = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(source, 'private\n');
    const result = await prepareFileForNapcat(source, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /不在允许发送的目录内/);
  });

  await asyncOk('directories and missing files are refused', async () => {
    assert.match((await prepareFileForNapcat(sharedDir, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    })).error, /不是普通文件/);
    assert.match((await prepareFileForNapcat(path.join(sharedDir, 'missing.txt'), {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    })).error, /文件不存在/);
  });

  await asyncOk('the same source reuses the copied outbox file', async () => {
    const source = path.join(sharedDir, '报告 #1.txt');
    const first = await prepareFileForNapcat(source, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    const second = await prepareFileForNapcat(source, {
      config, configRoot: tmp, stateDir, workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    assert.equal(second.file, first.file);
    assert.equal((await fs.readdir(path.join(stateDir, 'outbox'))).filter((name) => name.includes('报告')).length, 1);
  });

  await asyncOk('a NapCat-side mapped path is translated before copying', async () => {
    const result = await prepareFileForNapcat('/volume1/docker/report.txt', {
      config: {
        ...config,
        files: {
          mappings: [{ container: sharedDir, napcat: '/volume1/docker' }],
          napcatStateDir: '/app/state',
        },
      },
      configRoot: tmp,
      stateDir,
      workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    // 源映射目录里没有 report.txt，因此应当是“不存在”；能走到存在性检查说明路径已翻译。
    assert.equal(result.ok, false);
    assert.match(result.error, /文件不存在/);
  });

  await asyncOk('a NapCat-side path that exists through the mapping is copied', async () => {
    const file = path.join(sharedDir, 'from-napcat.txt');
    await fs.writeFile(file, 'visible through mapping\n');
    const result = await prepareFileForNapcat('/volume1/docker/from-napcat.txt', {
      config: {
        ...config,
        files: {
          mappings: [{ container: sharedDir, napcat: '/volume1/docker' }],
          napcatStateDir: '/app/state',
        },
      },
      configRoot: tmp,
      stateDir,
      workspaceDir: path.join(tmp, 'workspace'),
      memoryDir: path.join(tmp, 'memory'),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.copied, true);
    assert.match(result.file, /^\/app\/state\/outbox\//);
  });

  await asyncOk('DSH runtime inspection reports a JS entry without starting it', async () => {
    const dshRoot = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh');
    const bin = path.join(dshRoot, 'lib', 'bin.js');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(path.join(dshRoot, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }));
    await fs.writeFile(bin, '// fixture\n');
    const result = inspectDshRuntime(bin, tmp);
    assert.equal(result.ready, true, result.detail);
    assert.equal(result.mode, 'on-demand');
    assert.equal(result.version, '9.9.9-test');
    assert.equal(inspectDshRuntime(path.join(tmp, 'missing-dsh.js'), tmp).ready, false);
  });

  console.log(`\n通过 ${passed} 项 file bridge 检查`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
