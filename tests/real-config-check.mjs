// The real CLI loads a temporary config, resolves relative patches and uses its cwd.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolvePath } from '../src/config.js';
import { runDsh } from '../src/dsh.js';
import { createLocalDshFixture, useIsolatedEnv } from './helpers/isolated-fixtures.mjs';

const fixture = await createLocalDshFixture({
  prefix: 'qq-config-kernel-',
  reply: () => 'fixture-cwd-confirmed',
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
  const prompt = 'fixture-cwd-marker: confirm the runtime working directory.';
  const result = await runDsh(prompt, {
    cfg: config, cwd, projectRoot: fixture.root,
  });
  assert.equal(result.finalText, 'fixture-cwd-confirmed');
  assert(fixture.requests.length > 0, 'The configured local model must receive a request');
  // Newer DSH quotes paths as JSON and also makes separate title-generation requests.
  assert(fixture.requests.some((body) => {
    const texts = body.messages.map(({ content }) => typeof content === 'string' ? content :
      (Array.isArray(content) ? content.map((part) => part.text ?? '').join('\n') : ''));
    const messages = texts.join('\n');
    return body.model === 'test-chat' &&
      body.messages.some((message, index) => message.role === 'user' && texts[index] === prompt) &&
      [fixture.workspace, JSON.stringify(fixture.workspace), fixture.workspace.replaceAll('\\', '/')]
        .some((cwd) => messages.includes(cwd));
  }), 'A real conversation request must contain the test prompt and the configured working directory');
  assert(result.sessionId);
  console.log('通过：isolated config cwd and relative patch reach the real DSH kernel');
} finally {
  restore();
  await fixture.close();
}
