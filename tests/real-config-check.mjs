// The real CLI loads a temporary config, resolves relative patches and uses its cwd.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolvePath } from '../src/config.js';
import { runDsh } from '../src/dsh.js';
import { createLocalDshFixture, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

const fixture = await createLocalDshFixture({
  prefix: 'qq-config-kernel-',
  reply(body) {
    const messages = JSON.stringify(body.messages);
    assert(messages.includes('fixture-cwd-marker'), 'The real model request must contain this test prompt');
    assert(messages.toLowerCase().replaceAll('\\\\', '\\').replaceAll('/', '\\')
      .includes(fixture.workspace.toLowerCase().replaceAll('/', '\\')),
    'The DSH runtime context must report the configured working directory');
    return 'fixture-cwd-confirmed';
  },
});
const restore = useIsolatedEnv(fixture.root, { QQ_FIXTURE_API_KEY: 'synthetic-local-key' });
try {
  await fs.copyFile(fixture.patchPath, path.join(fixture.root, 'relative-model.yml'));
  await fs.writeFile(path.join(fixture.root, 'config.json'), JSON.stringify({
    dsh: {
      command: fixture.command, mode: 'headless', companion: false, profile: 'headless',
      patchPath: 'relative-model.yml', cwd: 'workspace', permissionMode: 'read-only', timeoutMs: 45000,
    },
  }));
  const { config } = loadConfig(fixture.root, { createIfMissing: false });
  const cwd = resolvePath(fixture.root, config.dsh.cwd);
  const patchPath = resolvePath(fixture.root, config.dsh.patchPath);
  assert.equal(cwd, fixture.workspace);
  assert.equal(patchPath, path.join(fixture.root, 'relative-model.yml'));
  const result = await runDsh('fixture-cwd-marker: confirm the runtime working directory.', {
    cfg: config, cwd, projectRoot: fixture.root,
  });
  assert.equal(result.finalText, 'fixture-cwd-confirmed');
  assert(fixture.requests.length > 0, 'The configured local model must receive a request');
  assert(result.sessionId);
  console.log('通过：isolated config cwd and relative patch reach the real DSH kernel');
} finally {
  restore();
  await fixture.close();
}
