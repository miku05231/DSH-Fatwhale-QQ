import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTestCase, testCaseRecord } from './helpers/run-test-case.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'qq-runner-regression-'));
const retained = [];
const item = { name: 'synthetic case', file: 'case.mjs', expect: ['fixture stdout'], note: 'isolated' };
try {
  await writeFile(path.join(root, item.file), `
console.log('fixture stdout');
console.error('fixture stderr');
process.exitCode = 23;
`);
  let cleanupOptions;
  const failed = await runTestCase(root, item.file, 10_000, {
    async remove(directory, options) {
      retained.push(directory);
      cleanupOptions = options;
      throw Object.assign(new Error('controlled EBUSY'), { code: 'EBUSY' });
    },
  });
  const failedRecord = testCaseRecord(item, failed);
  check('A failed cleanup preserves the original child exit code', failed.code === 23 && failedRecord.code === 23);
  check('A failed cleanup preserves original stdout and stderr', (
    failedRecord.output.includes('fixture stdout') && failedRecord.output.includes('fixture stderr')
  ));
  check('Cleanup diagnostics are retained in the failed report', (
    !failedRecord.pass && failedRecord.cleanupError.includes('controlled EBUSY')
      && failedRecord.output.includes('Isolated test cleanup failed')
  ));
  check('Cleanup requests bounded retry handling for Windows locks', (
    cleanupOptions.maxRetries === 8 && cleanupOptions.retryDelay === 250
  ));
  const serialized = JSON.parse(JSON.stringify({ results: [failedRecord] }));
  check('Failure records retain child and cleanup evidence through JSON serialization', (
    serialized.results[0].code === 23
      && serialized.results[0].stdout.includes('fixture stdout')
      && serialized.results[0].stderr.includes('fixture stderr')
      && serialized.results[0].output.includes('fixture stderr')
      && serialized.results[0].cleanupError.includes('controlled EBUSY')
  ));

  await writeFile(path.join(root, item.file), "console.log('fixture stdout');\n");
  const cleanupOnly = await runTestCase(root, item.file, 10_000, {
    async remove(directory) {
      retained.push(directory);
      throw new Error('controlled cleanup-only failure');
    },
  });
  check('A successful child with failed cleanup is still a failed test', (
    cleanupOnly.code === 0 && !testCaseRecord(item, cleanupOnly).pass
  ));

  const pidFile = path.join(root, 'exited-pid.txt');
  await writeFile(path.join(root, item.file), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log('fixture stdout');
`);
  let exitedBeforeCleanup = false;
  let removedDirectory;
  const normal = await runTestCase(root, item.file, 10_000, {
    async remove(directory, options) {
      const pid = Number(await readFile(pidFile, 'utf8'));
      try { process.kill(pid, 0); } catch (error) { exitedBeforeCleanup = error.code === 'ESRCH'; }
      removedDirectory = directory;
      await rm(directory, options);
    },
  });
  check('Ordinary tests remain successful and clean their temporary directory', (
    testCaseRecord(item, normal).pass
      && await readFile(removedDirectory).then(() => false, (error) => error.code === 'ENOENT')
  ));
  check('Temporary cleanup starts after the child process has exited', exitedBeforeCleanup);

  await writeFile(path.join(root, item.file), `
console.log('fixture stdout');
setInterval(() => {}, 1000);
`);
  const timedOut = await runTestCase(root, item.file, 2000);
  check('A timed out process closes and remains a failed result', (
    timedOut.timedOut && !testCaseRecord(item, timedOut).pass
      && timedOut.stderr.includes('Test timed out after 2000ms.')
  ));
  check('An expected success marker cannot turn a timeout into a pass', (
    !testCaseRecord(item, { code: 0, stdout: 'fixture stdout', stderr: '', ms: 1, timedOut: true }).pass
  ));
  check('Missing required output remains a failure', (
    !testCaseRecord(item, { code: 0, stdout: '', stderr: '', ms: 1 }).pass
  ));

  const missing = await runTestCase(path.join(root, 'missing'), item.file, 10_000);
  check('Spawn failures are recorded after close rather than aborting the suite', (
    missing.code === -1 && !testCaseRecord(item, missing).pass && missing.stderr.includes('ENOENT')
  ));
} finally {
  for (const directory of retained) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
console.log(`\n\u901a\u8fc7 ${passed} \u9879\uff0c\u5931\u8d25 0 \u9879`);
