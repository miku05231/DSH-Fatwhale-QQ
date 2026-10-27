import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeNapCat } from './ws-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-upload-path-'));
process.on('exit', () => { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

try {
  const stateDir = path.join(tmp, 'state');
  const sharedDir = path.join(tmp, 'nas');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  const source = path.join(sharedDir, '验收 文件.txt');
  await fs.writeFile(source, 'upload path fixture\n');
  const configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    onebot: { url: 'ws://127.0.0.1:1', accessToken: '' },
    stateDir: 'state',
    dsh: { cwd: 'workspace' },
    memory: { root: 'memory' },
    files: {
      mappings: [{ container: sharedDir, napcat: '/volume1' }],
      napcatStateDir: '/app/state',
    },
  }));

  const napcat = createFakeNapCat();
  const port = await napcat.listen();
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.onebot.url = `ws://127.0.0.1:${port}`;
  await fs.writeFile(configPath, JSON.stringify(config));
  try {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'tools', 'qq.mjs'), '--config', configPath,
      'upload_private_file',
      JSON.stringify({ user_id: 123456789, file: source, name: '验收 文件.txt' }),
    ], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    const upload = napcat.state.calls.find((call) => call.action === 'upload_private_file');
    assert.ok(upload, 'upload_private_file was not called');
    assert.match(upload.params.file, /^\/app\/state\/outbox\/[^/]+-验收 文件\.txt$/);
    assert.equal(upload.params.name, '验收 文件.txt');
    const relative = upload.params.file.slice('/app/state/'.length);
    assert.equal(await fs.readFile(path.join(stateDir, relative), 'utf8'), 'upload path fixture\n');
    ok('upload_private_file receives a NapCat-visible path and copies the bytes');

    const missing = spawn(process.execPath, [
      path.join(ROOT, 'tools', 'qq.mjs'), '--config', configPath,
      'upload_private_file', JSON.stringify({ user_id: 123456789, file: path.join(tmp, 'outside.txt'), name: 'x.txt' }),
    ], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let missingErr = '';
    missing.stderr.on('data', (chunk) => { missingErr += chunk; });
    assert.equal(await new Promise((resolve, reject) => {
      missing.once('error', reject);
      missing.once('close', resolve);
    }), 1);
    assert.match(missingErr, /文件不存在|不在允许发送的目录内/);
    ok('an unreadable or disallowed upload fails before opening OneBot');

    console.log(`\n通过 ${passed} 项 QQ upload 路径检查`);
  } finally {
    await napcat.close();
  }
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
