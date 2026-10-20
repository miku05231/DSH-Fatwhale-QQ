// 用「真实的 config.json」跑一次 DSH，确认默认配置本身可用
// （尤其是 dsh.cwd 指向 C:\DSH 时，patch 里的相对路径仍然解析正确）。
import path from 'node:path';
import process from 'node:process';

import { loadConfig, resolvePath } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { runDsh } from '../src/dsh.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const { config } = loadConfig(ROOT, { createIfMissing: false });
const log = createLogger('realconf', { logDir: path.join(ROOT, 'logs'), echo: false });

const patchPath = resolvePath(ROOT, config.dsh.patchPath);
const cwd = resolvePath(ROOT, config.dsh.cwd);

console.log(`profile   = ${config.dsh.profile}`);
console.log(`patchPath = ${patchPath}`);
console.log(`cwd       = ${cwd}`);

// patch 文件必须存在，否则 dsh 会退回内置路由然后配额失败
import fs from 'node:fs';
if (!fs.existsSync(patchPath)) {
  throw new Error(`patch 文件不存在：${patchPath}`);
}

// 让它在 cwd 里报告当前目录，验证工作目录真的生效
const result = await runDsh('用一句话回答：当前工作目录的绝对路径是什么？', {
  cfg: config,
  cwd,
  log,
  patchPath,
  projectRoot: ROOT,
});

console.log(`sessionId = ${result.sessionId}`);
console.log(`finalText = ${result.finalText.slice(0, 200)}`);

const normalized = result.finalText.replace(/\//g, '\\').toLowerCase();
if (!normalized.includes('d:\\dsh') && !normalized.includes('c:\\d\\dsh')) {
  console.log('WARN: 回复里没看到期望的目录名，人工确认上面的 finalText');
} else {
  console.log('OK: 工作目录生效');
}
