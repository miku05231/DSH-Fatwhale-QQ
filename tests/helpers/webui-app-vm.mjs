import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLogView } from '../../src/webui/public/logs.js';

const LOGS_IMPORT = "import { createLogView } from './logs.js';";

export function runWebUiAppInContext(source, context) {
  const importCount = source.split(LOGS_IMPORT).length - 1;
  assert.equal(importCount, 1,
    `Expected exactly one supported app.js logs import; found ${importCount}`);

  const vmSource = source.replace(LOGS_IMPORT, '');
  assert.doesNotMatch(vmSource, /^\s*import\b/m,
    'app.js contains an import that is not bridged into the test VM');

  context.createLogView = createLogView;
  return vm.runInContext(vmSource, context, { filename: 'src/webui/public/app.js' });
}
