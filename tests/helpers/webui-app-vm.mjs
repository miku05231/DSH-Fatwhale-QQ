import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLogView } from '../../src/webui/public/logs.js';
import { bindPluginFold, foldCard } from '../../src/webui/public/plugin-fold.js';

/** app.js 的静态 import 逐条桥接进测试 VM：去掉 import 语句，把对应导出放进上下文。 */
const BRIDGED_IMPORTS = [
  { statement: "import { createLogView } from './logs.js';", exports: { createLogView } },
  { statement: "import { bindPluginFold, foldCard } from './plugin-fold.js';", exports: { bindPluginFold, foldCard } },
];

export function runWebUiAppInContext(source, context) {
  let vmSource = source;
  for (const { statement, exports } of BRIDGED_IMPORTS) {
    const importCount = vmSource.split(statement).length - 1;
    assert.equal(importCount, 1,
      `Expected exactly one supported app.js import "${statement}"; found ${importCount}`);
    vmSource = vmSource.replace(statement, '');
    Object.assign(context, exports);
  }
  assert.doesNotMatch(vmSource, /^\s*import\b/m,
    'app.js contains an import that is not bridged into the test VM');

  return vm.runInContext(vmSource, context, { filename: 'src/webui/public/app.js' });
}
