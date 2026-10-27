/**
 * 跨进程文件桥：把桥接能读到的 NAS 文件复制到 NapCat 也能读到的共享 outbox。
 *
 * 背景：桥接容器与 NapCat 容器不是同一个文件系统。直接把宿主路径塞给
 * `upload_*_file` 会被 NapCat 判成不存在或没权限。这里只复制管理员要发送的
 * 单个文件，不复制目录、不跟随符号链接，并限制在显式允许的根目录内。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePath } from './config.js';

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function inside(root, file) {
  const normalize = (value) => path.posix.resolve(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  const relative = path.posix.relative(normalize(root), normalize(file));
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

/** 按 POSIX 语义拼接映射路径；NapCat 映射在 Linux 上，不应用 Windows 的 path.join。 */
function posixJoin(...parts) {
  return path.posix.join(...parts.map((value) => String(value).replace(/\\/g, '/')));
}

function safeName(name) {
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'file').slice(0, 160);
}

/** 读取并规范化 files.mappings；非法条目直接忽略，配置校验会另外报错。 */
export function normalizeFileMappings(config) {
  const raw = config?.files?.mappings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const container = text(item.container);
    const napcat = text(item.napcat);
    if (!path.isAbsolute(container) || !path.isAbsolute(napcat)) return [];
    return [{ container: container.replace(/[\\/]+$/, ''), napcat: napcat.replace(/[\\/]+$/, '') }];
  });
}

export function resolveFileStateDir(config, configRoot) {
  return resolvePath(configRoot || process.cwd(), text(config?.stateDir) || 'state');
}

export function resolveNapcatStateDir(config, stateDir) {
  const configured = text(config?.files?.napcatStateDir);
  return configured && path.isAbsolute(configured) ? configured.replace(/[\\/]+$/, '') : stateDir;
}

/** 允许发送的根目录：显式映射 + 共享状态/工作区/记忆。 */
export function allowedFileRoots(config, {
  configRoot, stateDir, workspaceDir, memoryDir, stickerDir,
} = {}) {
  const roots = normalizeFileMappings(config).map((item) => item.container);
  for (const value of [stateDir, workspaceDir, memoryDir, stickerDir]) {
    if (text(value)) roots.push(resolvePath(configRoot || process.cwd(), value));
  }
  const configured = [
    ...(Array.isArray(config?.files?.allowedRoots) ? config.files.allowedRoots : []),
    ...(Array.isArray(config?.stickers?.allowedRoots) ? config.stickers.allowedRoots : []),
  ];
  for (const value of configured) {
    if (typeof value === 'string' && path.isAbsolute(value.trim())) roots.push(value.trim());
  }
  return [...new Set(roots)];
}

/**
 * 将 localPath 变成 NapCat 可读的路径。返回 { ok, file, copied, error }。
 * 已经位于共享 stateDir 的文件不复制；位于映射的 NAS 根目录的文件复制到
 * stateDir/outbox，避免 NapCat 没有该 NAS 挂载。
 */
export async function prepareFileForNapcat(localPath, {
  config, configRoot, stateDir, workspaceDir, memoryDir, stickerDir,
  outboxName = 'outbox', maxBytes,
} = {}) {
  const raw = text(localPath);
  if (!raw) return { ok: false, error: '文件路径为空' };
  let absolute = path.sep === '\\'
    ? (path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw))
    : path.posix.isAbsolute(raw.replace(/\\/g, '/')) ? raw.replace(/\\/g, '/') : path.posix.resolve(raw.replace(/\\/g, '/'));
  // 模型可能按 NapCat 视角写宿主机路径；桥接里看不到这个路径，
  // 先按映射翻译成容器视角，再走同样的存在性/越界检查。
  const mappings = normalizeFileMappings(config);
  const translated = mappings.flatMap((mapping) => (
    inside(mapping.napcat, absolute)
      ? [path.posix.join(mapping.container.replace(/\\/g, '/'),
          path.posix.relative(mapping.napcat.replace(/\\/g, '/'), absolute.replace(/\\/g, '/')))].map((value) => (
          path.sep === '\\' ? value.replace(/\//g, '\\') : value
        ))
      : []
  ));
  const candidates = [absolute, ...translated];
  let existing = null;
  for (const candidate of candidates) {
    try {
      existing = await fsp.realpath(candidate);
      break;
    } catch {
      /* 继续尝试另一个视角 */
    }
  }
  if (!existing) return { ok: false, error: `文件不存在：${raw}` };
  absolute = existing;
  let stat;
  try {
    stat = await fsp.stat(absolute);
  } catch (err) {
    return { ok: false, error: `无法读取文件：${err?.message ?? err}` };
  }
  if (!stat.isFile()) return { ok: false, error: `不是普通文件：${raw}` };
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes) : DEFAULT_MAX_BYTES;
  if (stat.size > limit) return { ok: false, error: `文件超过发送上限（${limit} 字节）` };

  const roots = allowedFileRoots(config, { configRoot, stateDir, workspaceDir, memoryDir, stickerDir });
  if (!roots.some((root) => inside(root, absolute))) {
    return { ok: false, error: `文件不在允许发送的目录内：${absolute}` };
  }

  const state = path.resolve(stateDir);
  if (inside(state, absolute)) {
    const napcatState = resolveNapcatStateDir(config, state);
    const relative = path.relative(state, absolute).split(path.sep).join('/');
    return { ok: true, file: path.posix.join(napcatState.split(path.sep).join('/'), relative), copied: false, original: absolute };
  }

  const outbox = path.join(state, outboxName);
  await fsp.mkdir(outbox, { recursive: true, mode: 0o700 });
  const fingerprint = createHash('sha256')
    .update(`${absolute}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex').slice(0, 16);
  const destination = path.join(outbox, `${fingerprint}-${safeName(absolute)}`);
  // The outbox grows with every out-of-state file. Keep the newest 100 entries
  // (never the one about to be used) so an administrator cannot fill the disk.
  try {
    const entries = await fsp.readdir(outbox, { withFileTypes: true });
    const old = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
      .filter((name) => path.join(outbox, name) !== destination)
      .slice(0, Math.max(0, entries.length - 100));
    for (const name of old) await fsp.rm(path.join(outbox, name), { force: true });
  } catch {
    /* Cleanup is best effort; sending must not fail because of it. */
  }
  let already = false;
  try {
    const existing = await fsp.stat(destination);
    already = existing.isFile() && existing.size === stat.size;
  } catch {
    /* 不存在就复制 */
  }
  if (!already) {
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.copyFile(absolute, temp);
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, destination);
  }
  const napcatState = resolveNapcatStateDir(config, state);
  const relative = path.relative(state, destination).split(path.sep).join('/');
  return {
    ok: true,
    file: path.posix.join(napcatState.split(path.sep).join('/'), relative),
    copied: true,
    original: absolute,
    bytes: stat.size,
  };
}

export function isRemoteFileReference(value) {
  return typeof value === 'string' && /^(?:https?|base64):\/\//i.test(value.trim());
}
