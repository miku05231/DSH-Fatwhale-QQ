// Real DSH merges isolated base and desktop model patches in both orders.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopProfileLayerPath, parseDesktopLayer, resolveModelPlan } from '../src/model-follow.js';
import { createLocalDshFixture } from './helpers/isolated-fixtures.mjs';

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
  const basePatch = path.join(fixture.root, 'base-model.yml');
  await fs.writeFile(basePatch, `- id: llm-pi-ai
  config:
    providers:
      test-base:
        api: openai-completions
        baseURL: http://127.0.0.1:1/v1
        apiKeyEnv: QQ_FIXTURE_API_KEY
        models:
          - id: base-chat
            input: [text]
            contextWindow: 32000
            reasoningEfforts:
              low: low
- id: agent-default-model
  config:
    provider: test-base
    model: base-chat
    reasoningEffort: low
`);
  const home = path.join(fixture.root, 'home');
  const layerPath = desktopProfileLayerPath(home);
  await fs.mkdir(path.dirname(layerPath), { recursive: true });
  await fs.writeFile(layerPath, fixture.layer);
  const desktop = parseDesktopLayer(fixture.layer);
  assert(desktop.ok && desktop.model);
  const plan = resolveModelPlan({
    stateDir: path.join(fixture.root, 'state'), basePatchPath: basePatch, homedir: home,
  });
  assert.equal(plan.patchPaths.length, 1);
  const section = await dump(fixture, [basePatch, ...plan.patchPaths]);
  assert.match(section, /^\s*provider:\s*test-local\s*$/m);
  assert.match(section, /^\s*model:\s*test-chat\s*$/m);
  assert.match(section, /^\s*reasoningEffort:\s*high\s*$/m);
  const reversed = await dump(fixture, [...plan.patchPaths, basePatch]);
  assert.match(reversed, /^\s*provider:\s*test-base\s*$/m);
  assert.match(reversed, /^\s*model:\s*base-chat\s*$/m);
  assert.match(reversed, /^\s*reasoningEffort:\s*low\s*$/m);
  assert.equal(fixture.requests.length, 0, '--dump-config must not contact a model');
  console.log('通过 10 项：真实 DSH 合并、反向顺序、模型和强度覆盖；未读取用户配置或调用在线模型');
} finally {
  await fixture.close();
}
