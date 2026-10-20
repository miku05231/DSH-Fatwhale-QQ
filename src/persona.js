/**
 * src/persona.js —— 人格文件的定位与读取（零依赖）
 *
 * 人格就是一篇 Markdown。默认放在工作区的 `AGENTS.md`（DSH 自己会读这个文件），
 * 但也可以指到任意位置，由桥接在每条消息前读出来注入 prompt。
 *
 * 从「多套人格」开始支持两种模式，`resolvePersonaFor()` 决定这一条消息用哪份：
 *   1. 人格库模式：`persona.dir` 里放多份 `<名字>.md`，通过 `active.json` 选当前那套，
 *      还能给某个群 / 某个人单独指定（`chats`），见 src/personas.js；
 *   2. 单文件模式（兼容旧配置）：仍然只看 `persona.path`。
 *
 *   config.json
 *   {
 *     "persona": { "enabled": true, "dir": "state\\personas", "path": "qq-workspace\\AGENTS.md", "maxChars": 8000 },
 *     "memory":  { "root": "D:\\memory\\小号" },
 *     "dsh":     { "cwd": "D:\\workspace" }
 *   }
 *
 * 去重规则：如果选中的人格文件正好是 `<dsh.cwd>\AGENTS.md`，就**不注入**——
 * DSH 自己会把它当工作区说明读进去，再注入一遍会让模型看到两份。
 *
 * 路径写法支持：
 *   * 绝对路径（`D:\persona\x.md`）
 *   * 相对路径（相对项目根，`qq-workspace\AGENTS.md`）
 *   * 以 `~` 开头（当前用户主目录）
 *   * `%USERPROFILE%` / `$USERPROFILE` 这类环境变量
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { activeFilePath, personaDir, readState, resolvePersonaFor } from './personas.js';

export const DEFAULT_PERSONA_PATH = path.join('qq-workspace', 'AGENTS.md');
export const DEFAULT_PERSONA_MAX_CHARS = 8000;

/** 展开 `~` 与 `%VAR%` / `$VAR`；不处理不认识的变量（原样保留，后面解析会失败并报错） */
export function expandPath(raw, { homedir = os.homedir() } = {}) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === '~') value = homedir;
  else if (/^~[\\/]/.test(value)) value = path.join(homedir, value.slice(2));
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) =>
    process.env[name] === undefined ? whole : process.env[name],
  );
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
    const name = a || b;
    return process.env[name] === undefined ? whole : process.env[name];
  });
  return value;
}

/** 人格文件的绝对路径（配置为空时回默认） */
export function resolvePersonaPath({ configRoot, config, homedir } = {}) {
  const raw = String(config?.persona?.path ?? '').trim();
  const value = expandPath(raw || DEFAULT_PERSONA_PATH, { homedir });
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configRoot ?? '.', value);
}

/** 记忆库根目录（配置为空时回 `记忆库`；相对路径按项目根） */
export function resolveMemoryRoot({ configRoot, config, homedir } = {}) {
  const raw = String(config?.memory?.root ?? '').trim();
  const value = expandPath(raw || '记忆库', { homedir });
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configRoot ?? '.', value);
}

/** 工作区目录（配置为空时回项目根；相对路径按项目根） */
export function resolveWorkspace({ configRoot, config, homedir } = {}) {
  const raw = String(config?.dsh?.cwd ?? '').trim();
  const value = expandPath(raw || '.', { homedir });
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configRoot ?? '.', value);
}

function clampText(value, maxChars) {
  const textValue = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (!textValue) return { body: '', truncated: false };
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || textValue.length <= limit) return { body: textValue, truncated: false };
  return { body: `${textValue.slice(0, limit)}\n\n（人格设定超过 ${limit} 字，已截断）`, truncated: true };
}

/**
 * 人格加载器：按 inode+mtime+size 缓存，文件没变就不重复读盘。
 * 支持多套人格：每条消息先看一眼 `active.json` 有没有变（一次 stat，几乎不要钱），
 * 变了就立刻换文件，不需要重启桥接。
 * 任何错误都退化成空串，绝不影响回话。
 */
export class PersonaLoader {
  constructor({ configRoot, config, dshCwd, homedir, log, dir } = {}) {
    this.configRoot = configRoot;
    this.config = config ?? {};
    this.dshCwd = dshCwd ?? resolveWorkspace({ configRoot, config, homedir });
    this.homedir = homedir;
    this.log = log;
    this.dir = dir ?? personaDir({ configRoot, config, homedir });
    this.state = null;
    this.stateStamp = null;
    this.resolution = null;
    this.filePath = resolvePersonaPath({ configRoot, config, homedir });
    /** 最近一次读到的状态，控制台/状态文件可以读 */
    this.last = null;
    this.cache = null;
  }

  /** 重读 active.json；文件没变就跳过。返回 state */
  async refreshState() {
    const file = activeFilePath(this.dir);
    let stamp = 'missing';
    try {
      const st = await fsp.stat(file, { bigint: true });
      // 用 ino + 纳秒当 key。Windows 上 rename 覆盖 active.json 后，stat 可能还会短暂
      // 返回旧文件的 mtime（NTFS 元数据缓存），但 ino 每次都变，所以不会漏读。
      stamp = `${st.ino}:${st.mtimeNs}:${st.size}`;
      if (stamp === this.stateStamp && this.state) return this.state;
    } catch (err) {
      if (err?.code !== 'ENOENT') this.log?.debug?.(`读取人格选择失败：${err?.message ?? err}`);
    }
    if (stamp === this.stateStamp && this.state) return this.state;
    this.stateStamp = stamp;
    try {
      this.state = await readState(this.dir);
    } catch (err) {
      this.log?.debug?.(`解析人格选择失败：${err?.message ?? err}`);
      this.state = { active: '', chats: {} };
    }
    return this.state;
  }

  /** 当前（或指定会话）实际使用的人格文件 */
  resolutionFor(chatKey) {
    return resolvePersonaFor({ configRoot: this.configRoot, config: this.config, dir: this.dir, state: this.state, chatKey });
  }

  /** 是否因为「DSH 自己会读」而跳过注入 */
  isDshAutoLoaded(file = this.filePath) {
    const auto = path.join(this.dshCwd, 'AGENTS.md');
    return path.resolve(file).toLowerCase() === path.resolve(auto).toLowerCase();
  }

  /** 返回 { text, body, path, name, source, bytes, updatedAt, missing, skipped, truncated } */
  async load({ chatKey } = {}) {
    const state = await this.refreshState();
    const resolution = this.resolutionFor(chatKey);
    this.resolution = resolution;
    this.filePath = resolution.file;

    const result = {
      text: '',
      body: '',
      path: resolution.file,
      name: resolution.name,
      source: resolution.source,
      bytes: 0,
      updatedAt: null,
      missing: false,
      skipped: null,
      truncated: false,
    };

    if (this.config?.persona?.enabled === false) {
      result.skipped = 'disabled';
      this.last = result;
      return result;
    }
    if (this.isDshAutoLoaded(resolution.file)) {
      result.skipped = 'dsh-auto';
      this.last = result;
      return result;
    }

    try {
      const st = await fsp.stat(resolution.file, { bigint: true });
      if (!st.isFile()) {
        result.missing = true;
        this.last = result;
        return result;
      }
      const stamp = `${resolution.file}|${st.ino}:${st.mtimeNs}:${st.size}`;
      if (this.cache && this.cache.stamp === stamp) {
        this.last = { ...this.cache.result };
        return this.last;
      }
      const raw = await fsp.readFile(resolution.file, 'utf8');
      const { body, truncated } = clampText(raw, this.config?.persona?.maxChars ?? DEFAULT_PERSONA_MAX_CHARS);
      result.body = body;
      result.bytes = Number(st.size);
      result.updatedAt = new Date(Number(st.mtimeMs)).toISOString();
      result.truncated = truncated;
      result.text = body ? `[人格设定]\n${body}\n\n` : '';
      this.cache = { stamp, result: { ...result } };
      this.last = result;
      return result;
    } catch (err) {
      result.missing = err?.code === 'ENOENT';
      this.log?.debug?.(`读取人格文件失败（${resolution.file}）：${err?.message ?? err}`);
      this.last = result;
      return result;
    }
  }

  /** 直接拿「塞进 prompt 的那段文本」 */
  async loadBlock({ chatKey } = {}) {
    return (await this.load({ chatKey })).text;
  }
}
