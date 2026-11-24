/**
 * src/dsh-host.js —— 插件模式下跟随宿主 DSH
 *
 * 桥接作为 DSH 插件跑在宿主进程里时（DSH Desktop 或 `dsh web`），普通聊天、
 * 群聊判定、每日总结这些「不带工具」的调用会另起一个子进程加载 DSH 内核。
 * 以前它按 config.dsh.command（默认 `dsh`）去 PATH 里找，找到的往往是另装的
 * npm 版，和宿主不是同一个版本。
 *
 * 现在：插件模式下，dsh.command 是默认值（空 / `dsh` / `auto`）时，
 * 一律用宿主自己的 @deepseek-ai/dsh —— Desktop 里就跟随 Desktop 内置的内核，
 * `dsh web` 里就跟随启动它的那份安装。dsh.command 写了具体路径时照旧用那个路径。
 *
 * 插件登记宿主内核时同时写环境变量 QQ_HOST_DSH_ROOT，插件以独立进程方式拉起的
 * 桥接（runMode=standalone）继承它，也跟随同一个宿主。
 */

import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = '@deepseek-ai/dsh';
const MAX_DEPTH = 10;
const FOLLOW_VALUES = new Set(['', 'dsh', 'auto']);
export const HOST_DSH_ENV = 'QQ_HOST_DSH_ROOT';

let hostRoot = null;

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function packageAt(dir) {
  const pkg = readPackage(dir);
  return pkg?.name === PACKAGE_NAME ? { root: dir, version: String(pkg.version || '') } : null;
}

/**
 * 从宿主进程的入口脚本往上找 @deepseek-ai/dsh：
 *   - `dsh web`：入口就是 .../@deepseek-ai/dsh/lib/bin.js，往上第一个 package.json 就是它；
 *   - Desktop：入口是 .../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js，
 *     往上走到 node_modules 那一层，旁边就是 @deepseek-ai/dsh。
 * @param {{argv?: string[]}} [opts]
 * @returns {{root: string, version: string}|null}
 */
export function detectHostDsh({ argv = process.argv } = {}) {
  const entry = typeof argv?.[1] === 'string' && argv[1] ? path.resolve(argv[1]) : '';
  if (!entry) return null;
  let dir = path.dirname(entry);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const own = packageAt(dir);
    if (own) return own;
    const sibling = packageAt(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh'));
    if (sibling) return sibling;
    if (path.basename(dir) === 'node_modules') {
      const inside = packageAt(path.join(dir, '@deepseek-ai', 'dsh'));
      if (inside) return inside;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** dsh.command 是不是「没特别指定」：这种情况下插件模式跟随宿主 */
export function followsHostCommand(command) {
  return FOLLOW_VALUES.has(String(command ?? '').trim().toLowerCase());
}

/**
 * 插件启动时登记宿主内核；传 null 取消（测试收尾）。
 * @param {{root: string, version?: string}|null} info
 * @param {{env?: object}} [opts] 同步写进这个环境变量表，子进程会继承
 */
export function setHostDsh(info, { env = process.env } = {}) {
  hostRoot = info?.root ? { root: info.root, version: String(info.version || '') } : null;
  if (!env) return;
  if (hostRoot) env[HOST_DSH_ENV] = hostRoot.root;
  else delete env[HOST_DSH_ENV];
}

let envCache = { value: '', info: null };

/** @returns {{root: string, version: string}|null} 登记的宿主内核，或从环境变量继承的 */
export function getHostDsh({ env = process.env } = {}) {
  if (hostRoot) return hostRoot;
  const fromEnv = typeof env?.[HOST_DSH_ENV] === 'string' ? env[HOST_DSH_ENV].trim() : '';
  if (!fromEnv || !path.isAbsolute(fromEnv)) return null;
  if (envCache.value !== fromEnv) envCache = { value: fromEnv, info: packageAt(fromEnv) };
  return envCache.info;
}

/** 这条 dsh.command 在当前进程里应该用宿主内核时，返回宿主内核目录 */
export function hostDshRootFor(command, opts) {
  const host = getHostDsh(opts);
  return host && followsHostCommand(command) ? host.root : null;
}
