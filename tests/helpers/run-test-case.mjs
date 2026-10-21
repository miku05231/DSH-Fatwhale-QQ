import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from '../../src/dsh.js';
import { browserRuntimeEnv, isolatedEnv, prepareIsolatedHome } from './isolated-fixtures.mjs';

export async function runTestCase(root, file, timeoutMs, { remove = rm } = {}) {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-suite-case-'));
  const started = Date.now();
  let result;
  try {
    await prepareIsolatedHome(isolatedRoot);
    result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, file)], {
        cwd: root,
        windowsHide: true,
        env: (['tests/dsh-web-test.mjs', 'tests/ui-cdp.mjs', 'tests/updates-ui.mjs'].includes(file)
          ? browserRuntimeEnv : isolatedEnv)(isolatedRoot, {
          NODE_NO_WARNINGS: '1', QQ_TEST_REQUIRE_DSH: '1', QQ_TEST_REQUIRE_BROWSER: '1',
        }),
      });
      let stdout = '';
      let stderr = '';
      let processError;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.once('error', (error) => { processError = error; });
      // close follows error/exit and drained output, so cleanup cannot race the child.
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (processError) stderr += `\n${processError.stack ?? processError}`;
        if (timedOut) stderr += `\nTest timed out after ${timeoutMs}ms.`;
        resolve({
          code: processError ? -1 : code,
          signal, stdout, stderr, timedOut, ms: Date.now() - started,
        });
      });
    });
  } catch (error) {
    result = { code: -1, stdout: '', stderr: String(error.stack ?? error), ms: Date.now() - started };
  }
  try {
    await remove(isolatedRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    result.cleanupError = String(error.stack ?? error);
    result.stderr += `\nIsolated test cleanup failed:\n${result.cleanupError}`;
  }
  return result;
}

export function testCaseRecord(item, result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  const missing = item.expect.filter((needle) => !combined.includes(needle));
  const pass = result.code === 0 && !result.timedOut && !result.cleanupError && missing.length === 0;
  return {
    name: item.name, file: item.file, note: item.note,
    pass, code: result.code, ms: result.ms, missing,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}),
    tail: combined.trimEnd().split(/\r?\n/).slice(-6).join('\n'),
    ...(!pass ? { stdout: result.stdout, stderr: result.stderr, output: combined.trimEnd() } : {}),
  };
}
