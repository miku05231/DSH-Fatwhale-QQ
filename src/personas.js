/**
 * src/personas.js —— 多套人格的库、当前选择与按会话覆盖（零依赖）
 *
 * 目录结构（`config.persona.dir`，默认 `state/personas`）：
 *
 *   state/personas/
 *     大肥鱼.md            一套人格 = 一篇 Markdown
 *     客服小助手.md
 *     active.json          { "active": "大肥鱼", "chats": { "g:200000001": "客服小助手" } }
 *
 * 解析顺序（`resolvePersonaFor`）：
 *   1. 某个会话的覆盖（`chats["g:<群号>"]` / `chats["p:<QQ号>"]`）
 *   2. 全局当前人格（`active.json` 的 `active`，为空时用 `config.persona.active`）
 *   3. 都没有 → 回到老配置 `config.persona.path`（兼容升级前的单文件模式）
 *
 * 所有写操作都是「临时文件 + rename」，读坏 JSON 会把原文件改名 `.bad-<时间戳>` 再当空库，
 * 保证升级过程中人格库怎么坏都不会让桥接起不来。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { expandPath, DEFAULT_PERSONA_PATH } from './persona.js';

export const DEFAULT_PERSONA_DIR = path.join('state', 'personas');
export const PERSONA_NAME_MAX = 40;
export const PERSONA_BODY_MAX = 2 * 1024 * 1024;
export const ACTIVE_FILE = 'active.json';

/** 人格名不能带路径分隔符和 Windows 保留字符，也不能只有点 */
export function sanitizePersonaName(raw) {
  let name = String(raw ?? '').replace(/^\uFEFF/, '').replace(/[\u0000-\u001f]/g, '').trim();
  name = name.replace(/\s+/g, ' ');
  if (!name) {
    const err = new Error('人格名不能为空');
    err.code = 'PERSONA_BAD_NAME';
    throw err;
  }
  if (name.length > PERSONA_NAME_MAX) {
    const err = new Error(`人格名太长（最多 ${PERSONA_NAME_MAX} 个字符）`);
    err.code = 'PERSONA_BAD_NAME';
    throw err;
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    const err = new Error('人格名不能包含 \\ / : * ? " < > | 这些字符');
    err.code = 'PERSONA_BAD_NAME';
    throw err;
  }
  if (/^\.+$/.test(name)) {
    const err = new Error('人格名不能只有点');
    err.code = 'PERSONA_BAD_NAME';
    throw err;
  }
  return name;
}

/** 人格库目录（相对路径按项目根） */
export function personaDir({ configRoot, config, homedir } = {}) {
  const raw = String(config?.persona?.dir ?? '').trim();
  const value = expandPath(raw || DEFAULT_PERSONA_DIR, { homedir });
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configRoot ?? '.', value);
}

export function activeFilePath(dir) {
  return path.join(dir, ACTIVE_FILE);
}

export function personaFile(dir, name) {
  return path.join(dir, `${sanitizePersonaName(name)}.md`);
}

/** 目录为空 / 不存在时都返回空状态，坏 JSON 先改名留档 */
export async function readState(dir) {
  const file = activeFilePath(dir);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { active: '', chats: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const state = { active: '', chats: {} };
    if (parsed && typeof parsed === 'object') {
      state.active = typeof parsed.active === 'string' ? parsed.active.trim() : '';
      if (parsed.chats && typeof parsed.chats === 'object') {
        for (const [key, value] of Object.entries(parsed.chats)) {
          if (typeof key !== 'string' || !key.trim()) continue;
          if (typeof value === 'string' && value.trim()) state.chats[key] = value.trim();
        }
      }
    }
    return state;
  } catch {
    try {
      await fsp.rename(file, `${file}.bad-${Date.now()}`);
    } catch {
      /* 改名失败就当空库 */
    }
    return { active: '', chats: {} };
  }
}

export async function writeState(dir, state) {
  await fsp.mkdir(dir, { recursive: true });
  const file = activeFilePath(dir);
  const clean = { active: '', chats: {} };
  if (state && typeof state === 'object') {
    clean.active = typeof state.active === 'string' ? state.active.trim() : '';
    for (const [key, value] of Object.entries(state.chats ?? {})) {
      if (typeof value === 'string' && value.trim()) clean.chats[key] = value.trim();
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return clean;
}

/** 列出所有人格（按名字排序），预览取第一行非空正文 */
export async function listPersonas(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    try {
      const st = await fsp.stat(file);
      const body = await fsp.readFile(file, 'utf8');
      const preview =
        body
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#')) ?? '';
      items.push({
        name: entry.name.replace(/\.md$/i, ''),
        file,
        size: st.size,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        preview: preview.slice(0, 80),
      });
    } catch {
      /* 单个文件读不了就跳过 */
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return items;
}

export async function readPersona(dir, name) {
  const safe = sanitizePersonaName(name);
  const file = personaFile(dir, safe);
  let st;
  try {
    st = await fsp.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const notFound = new Error(`人格不存在：${safe}`);
      notFound.code = 'PERSONA_NOT_FOUND';
      throw notFound;
    }
    throw err;
  }
  if (!st.isFile()) {
    const err = new Error(`人格不存在：${safe}`);
    err.code = 'PERSONA_NOT_FOUND';
    throw err;
  }
  const body = await fsp.readFile(file, 'utf8');
  return { name: safe, file, body, size: st.size, updatedAt: new Date(st.mtimeMs).toISOString() };
}

/** 写一套人格（不存在就创建；存在就覆盖）。返回元信息 */
export async function writePersona(dir, name, body) {
  const safe = sanitizePersonaName(name);
  if (typeof body !== 'string') {
    const err = new Error('人格内容必须是字符串');
    err.code = 'PERSONA_BAD_BODY';
    throw err;
  }
  if (body.length > PERSONA_BODY_MAX) {
    const err = new Error('人格内容过长（超过 2MB）');
    err.code = 'PERSONA_BAD_BODY';
    throw err;
  }
  await fsp.mkdir(dir, { recursive: true });
  const file = personaFile(dir, safe);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, file);
  const st = await fsp.stat(file);
  return { name: safe, file, size: st.size, updatedAt: new Date(st.mtimeMs).toISOString() };
}

export async function createPersona(dir, { name, body = '' } = {}) {
  const safe = sanitizePersonaName(name);
  const file = personaFile(dir, safe);
  let exists = true;
  try {
    await fsp.stat(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    exists = false;
  }
  if (exists) {
    const err = new Error(`已经有一套叫「${safe}」的人格了`);
    err.code = 'PERSONA_EXISTS';
    throw err;
  }
  return writePersona(dir, safe, body);
}

/**
 * 删一套人格。如果它正被全局或某个会话引用，引用会被一起清掉（回到默认文件）。
 * 返回 { name, wasActive, clearedChats }。
 */
export async function deletePersona(dir, name) {
  const safe = sanitizePersonaName(name);
  const file = personaFile(dir, safe);
  try {
    await fsp.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const notFound = new Error(`人格不存在：${safe}`);
      notFound.code = 'PERSONA_NOT_FOUND';
      throw notFound;
    }
    throw err;
  }
  await fsp.rm(file, { force: true });
  const state = await readState(dir);
  const wasActive = state.active === safe;
  const clearedChats = [];
  if (wasActive) state.active = '';
  for (const [key, value] of Object.entries(state.chats)) {
    if (value === safe) {
      delete state.chats[key];
      clearedChats.push(key);
    }
  }
  if (wasActive || clearedChats.length) await writeState(dir, state);
  return { name: safe, wasActive, clearedChats };
}

/** 把全局当前人格设为 name（空字符串 / null = 取消，回到 config.persona.path） */
export async function setActivePersona(dir, name) {
  const state = await readState(dir);
  if (name) {
    const safe = sanitizePersonaName(name);
    const file = personaFile(dir, safe);
    await fsp.stat(file).catch(() => {
      const err = new Error(`人格不存在：${safe}`);
      err.code = 'PERSONA_NOT_FOUND';
      throw err;
    });
    state.active = safe;
  } else {
    state.active = '';
  }
  await writeState(dir, state);
  return state;
}

/** 给某个会话单独指定人格；name 为空 = 清掉这个会话的覆盖 */
export async function setChatPersona(dir, chatKey, name) {
  const key = String(chatKey ?? '').trim();
  if (!/^[gp]:[0-9A-Za-z_-]+$/.test(key)) {
    const err = new Error('会话键应形如 g:12345 或 p:12345');
    err.code = 'PERSONA_BAD_CHAT';
    throw err;
  }
  const state = await readState(dir);
  if (name) {
    const safe = sanitizePersonaName(name);
    await fsp.stat(personaFile(dir, safe)).catch(() => {
      const err = new Error(`人格不存在：${safe}`);
      err.code = 'PERSONA_NOT_FOUND';
      throw err;
    });
    state.chats[key] = safe;
  } else {
    delete state.chats[key];
  }
  await writeState(dir, state);
  return { state, chatKey: key, name: name ? sanitizePersonaName(name) : '' };
}

/**
 * 特定会话最终使用的人格文件与来源。
 * 返回 { file, name, source: 'chat' | 'global' | 'config' , chatKey }
 */
export function resolvePersonaFor({ configRoot, config, dir, state, chatKey } = {}) {
  const chats = state?.chats ?? {};
  const key = String(chatKey ?? '').trim();
  if (key && chats[key]) {
    return { file: personaFile(dir, chats[key]), name: chats[key], source: 'chat', chatKey: key };
  }
  const globalName = String(state?.active ?? '').trim() || String(config?.persona?.active ?? '').trim();
  if (globalName) {
    return { file: personaFile(dir, globalName), name: globalName, source: 'global', chatKey: key };
  }
  const raw = String(config?.persona?.path ?? '').trim() || DEFAULT_PERSONA_PATH;
  const value = expandPath(raw);
  const file = path.isAbsolute(value) ? path.normalize(value) : path.resolve(configRoot ?? '.', value);
  return { file, name: '', source: 'config', chatKey: key };
}

export const PERSONA_CMD_RE = /^\/人格(?:\s+([\s\S]*))?$/;

/**
 * 解析 `/人格` 指令。
 * 返回 null（不是指令）或 { action, name }：
 *   list / set-chat / set-global / reset-chat / reset-global / create
 */
export function parsePersonaCommand(text) {
  const match = PERSONA_CMD_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  const args = String(match[1] ?? '').trim();
  if (!args) return { action: 'list', name: '' };
  const [head, ...rest] = args.split(/\s+/);
  const tail = rest.join(' ').trim();
  if (head === '重置' || head === '默认') {
    return { action: 'reset-chat', name: tail };
  }
  if (head === '全局') {
    if (!tail || tail === '重置' || tail === '默认') return { action: 'reset-global', name: '' };
    return { action: 'set-global', name: tail };
  }
  if (head === '新建') {
    if (!tail) return { action: 'create', name: '' };
    return { action: 'create', name: tail };
  }
  return { action: 'set-chat', name: args };
}

/** 拼 `/人格` 列表回复（QQ 是纯文本，不用 Markdown 表格） */
export function buildPersonaListText({ items, state, chatKey, activeName }) {
  const lines = [];
  const currentName = state?.chats?.[chatKey] || activeName || '';
  lines.push(`当前人格：${currentName || '默认（config.persona.path）'}${state?.chats?.[chatKey] ? '（本会话指定）' : ''}`);
  if (!items.length) {
    lines.push('人格库还是空的，去控制台「人格」页新建一套，或者直接发 /人格 新建 名字。');
    return lines.join('\n');
  }
  lines.push(`可用人格（${items.length}）：`);
  for (const item of items) {
    const marks = [];
    if (activeName && item.name === activeName) marks.push('全局');
    if (state?.chats?.[chatKey] === item.name) marks.push('本会话');
    lines.push(`· ${item.name}${marks.length ? ` ← ${marks.join(' / ')}` : ''}`);
  }
  lines.push('');
  lines.push('切换：/人格 名字（只改这里）｜/人格 全局 名字（所有会话）｜/人格 重置');
  return lines.join('\n');
}

/** 新建人格时给的空白模板，省得从零想 */
export function defaultPersonaTemplate(name) {
  return `# 人格：${name}

你叫 ${name}。

## 说话风格
- 简短、口语化，像真人发消息，一句话能说完就别写三句
- 不用 Markdown、不列表格、不输出代码块（QQ 不渲染）
- 默认中文

## 人设
（在这里补充身份、经历、口头禅、擅长什么、不聊什么……）
`;
}

/** 人格名匹配：先精确，再忽略大小写，最后唯一前缀 */
export function matchPersonaName(items, raw) {
  const wanted = String(raw ?? '').trim();
  if (!wanted) return '';
  const exact = items.find((item) => item.name === wanted);
  if (exact) return exact.name;
  const lower = wanted.toLowerCase();
  const ci = items.find((item) => item.name.toLowerCase() === lower);
  if (ci) return ci.name;
  const prefix = items.filter((item) => item.name.toLowerCase().startsWith(lower));
  return prefix.length === 1 ? prefix[0].name : '';
}

/**
 * 第一次启用多套人格时，把现在这份人格文件复制进库里当第一套。
 * 返回 { created, name }；库非空就什么都不做。
 */
export async function seedFromFile({ dir, fromFile, name }) {
  let existing = await listPersonas(dir);
  if (existing.length) return { created: false, name: existing[0].name };
  let body = '';
  try {
    body = await fsp.readFile(fromFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const safe = sanitizePersonaName(name || defaultNameFromFile(fromFile));
  const meta = await writePersona(dir, safe, body);
  const state = await readState(dir);
  if (!state.active) {
    state.active = safe;
    await writeState(dir, state);
  }
  return { created: true, name: safe, ...meta };
}

export function defaultNameFromFile(file) {
  const base = path.basename(String(file ?? ''), path.extname(String(file ?? '')));
  try {
    return sanitizePersonaName(base);
  } catch {
    return '默认人格';
  }
}
