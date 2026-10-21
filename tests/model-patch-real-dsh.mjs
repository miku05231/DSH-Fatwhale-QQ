// Real DSH merges the public base patch with an isolated desktop-model fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopProfileLayerPath, parseDesktopLayer, resolveModelPlan } from '../src/model-follow.js';
import { createLocalDshFixture } from './helpers/isolated-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATCH = path.join(ROOT, 'patches', 'headless-model.yml');

async function dump(fixture, patches) {
  const args = [fixture.command, '--profile', 'headless'];
  for (const patch of patches) args.push('--patch', patch);
  args.push('--dump-config');
  const child = spawn(process.execPath, args, {
    cwd: fixture.workspace, env: fixture.env, windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, output.slice(-2000));
    const section = output.match(/^\s*-\s*id:\s*agent-default-model\s*$[\s\S]*?(?=^\s*#\s*==|$(?![\s\S]))/m)?.[0];
    assert(section, 'DSH dump must contain agent-default-model');
    return section;
  } finally {
    clearTimeout(timer);
  }
}

const fixture = await createLocalDshFixture({ prefix: 'qq-model-merge-' });
try {
  const home = path.join(fixture.root, 'home');
  const layerPath = desktopProfileLayerPath(home);
  await fs.mkdir(path.dirname(layerPath), { recursive: true });
  await fs.writeFile(layerPath, fixture.layer);
  const desktop = parseDesktopLayer(fixture.layer);
  assert(desktop.ok && desktop.model);
  const plan = resolveModelPlan({
    stateDir: path.join(fixture.root, 'state'), basePatchPath: BASE_PATCH, homedir: home,
  });
  assert.equal(plan.patchPaths.length, 1);
  const section = await dump(fixture, [BASE_PATCH, ...plan.patchPaths]);
  assert.match(section, /^\s*provider:\s*test-local\s*$/m);
  assert.match(section, /^\s*model:\s*test-chat\s*$/m);
  assert.match(section, /^\s*reasoningEffort:\s*high\s*$/m);
  const reversed = await dump(fixture, [...plan.patchPaths, BASE_PATCH]);
  assert.match(reversed, /^\s*provider:\s*relay-a\s*$/m);
  assert.equal(fixture.requests.length, 0, '--dump-config must not contact a model');
  console.log('通过 8 项：真实 DSH 合并、反向顺序、模型和强度覆盖；未读取用户配置或调用在线模型');
} finally {
  await fixture.close();
}
