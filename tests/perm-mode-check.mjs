// 验证：桥接跑 DSH 时，子进程是否真的拿到了 config.dsh.permissionMode。
//
// 背景：本机上 dsh 默认的 workspace-write 会卡在给工作区授 ACL 一步
// （Win32 5 拒绝访问），导致 QQ 里的 agent 完全没 shell。修法是给子进程
// 传 DSH_PERMISSION_MODE=danger-full-access。这个脚本走的就是桥接的真实
// 调用路径（runDsh → spawn），不经过 QQ。
//
// 用法：node tests/perm-mode-check.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolvePath } from '../src/config.js';
import { runDsh } from '../src/dsh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
  error: (...a) => console.log('[error]', ...a),
  debug: () => {},
};

const config = loadConfig(PROJECT_ROOT).config;
const patchPath = resolvePath(PROJECT_ROOT, config.dsh.patchPath);
const cwd = resolvePath(PROJECT_ROOT, config.dsh.cwd);

console.log(`permissionMode = ${JSON.stringify(config.dsh.permissionMode)}`);
console.log(`cwd            = ${cwd}`);
console.log(`patchPath      = ${patchPath}`);
console.log('');

const result = await runDsh(
  '用 shell 执行命令 `node -e "console.log(123456+654321)"`，然后只回复这个数字，不要任何解释。',
  { cfg: config, cwd, log, patchPath, projectRoot: PROJECT_ROOT },
);

const text = String(result.finalText ?? '').trim();
console.log('');
console.log(`sessionId = ${result.sessionId}`);
console.log(`finalText = ${JSON.stringify(text)}`);

if (text.includes('777777')) {
  console.log('\nPASS 子进程拿到了 shell，且能执行命令（777777 正确）');
  process.exit(0);
}
console.log('\nFAIL 没有拿到期望的命令输出，说明子进程里 shell 仍不可用');
process.exit(1);
