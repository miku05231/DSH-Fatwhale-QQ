/**
 * src/plugins.js —— 插件宿主（零依赖）
 *
 * 设计参考 AstrBot 的插件模型（插件 = 元数据 + 事件钩子 + 配置 + 控制台卡片），
 * 但只保留这个项目真正需要的扩展点，让「加功能」不需要改 index.js：
 *
 *   onMessage(ctx)   消息进门、还没决定要不要交给 dsh 之前调用。
 *                    典型用途：指令类插件（/ping、/help），或对消息做预处理。
 *                    返回 {handled:true} 表示「我已经回过了，别再走 dsh」；
 *                    返回 {text:'...'} 可以改掉这一轮的话术。
 *   beforeReply(ctx) 交给 dsh 之前、prompt 组装之前调用，同上。
 *   afterReply(ctx)  dsh 回完、发出去之前调用，返回 {text} 修饰最终回复。
 *
 * 插件就是一个 .js 文件，放在 src/plugins/ 下：
 *
 *   export const meta = {
 *     name: 'ping',                       // 必须与文件名一致
 *     displayName: 'Ping',
 *     version: '1.0.0',
 *     description: '一行说明，控制台里显示',
 *     defaultEnabled: true,
 *     configSchema: [{ key: 'reply', type: 'string', label: '回复内容', default: 'pong' }],
 *   };
 *   export async function onMessage(ctx) { ... }
 *
 * 开关状态存 state/plugins.json；插件自己的配置存 config.json 的 plugins.<name>，
 * 由控制台「插件」页读写。任何插件抛错都只记日志，绝不影响回话。
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 支持的钩子（顺序即执行顺序的一部分：onMessage → beforeReply → … → afterReply） */
export const PLUGIN_HOOKS = ['onMessage', 'beforeReply', 'afterReply'];

/** 配置项类型（控制台据此渲染表单） */
export const SCHEMA_TYPES = ['string', 'text', 'bool', 'int', 'select', 'secret'];

function asText(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** 把 schema 默认值 + 用户配置合成一份「拿到就能用」的配置 */
export function mergeConfig(schema, stored) {
  const out = {};
  for (const field of Array.isArray(schema) ? schema : []) {
    if (!field || typeof field.key !== 'string' || !field.key) continue;
    const fallback = field.default;
    const value = stored && Object.hasOwn(stored, field.key) ? stored[field.key] : fallback;
    out[field.key] = coerceValue(field.type, value, fallback);
  }
  // 用户存了 schema 之外的键也带上，插件可能自己在用
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (!Object.hasOwn(out, key)) out[key] = value;
    }
  }
  return out;
}

/** 按类型收敛一个配置值 */
export function coerceValue(type, value, fallback) {
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true' || value === '1';
    return Boolean(fallback);
  }
  if (type === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number(fallback) || 0;
  }
  if (type === 'string' || type === 'text' || type === 'select' || type === 'secret') return asText(value);
  return value;
}

/** 校验插件元数据，返回可展示的描述（缺字段的任务直接拒绝，免得控制台显示一半） */
export function normalizeMeta(meta, fileBase) {
  if (!meta || typeof meta !== 'object') return { error: '没有导出 meta' };
  const name = asText(meta.name).trim();
  if (!name) return { error: 'meta.name 不能为空' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: `meta.name「${name}」只能用 a-z0-9-` };
  if (fileBase && name !== fileBase) return { error: `meta.name「${name}」与文件名「${fileBase}.js」不一致` };
  const schema = Array.isArray(meta.configSchema) ? meta.configSchema : [];
  for (const field of schema) {
    if (!field || typeof field.key !== 'string' || !field.key) return { error: 'configSchema 里有条目缺少 key' };
    if (!SCHEMA_TYPES.includes(field.type)) return { error: `configSchema.${field.key} 的 type 必须是 ${SCHEMA_TYPES.join('/')}` };
  }
  return {
    meta: {
      name,
      displayName: asText(meta.displayName).trim() || name,
      version: asText(meta.version).trim() || '0.0.0',
      description: asText(meta.description).trim(),
      defaultEnabled: meta.defaultEnabled !== false,
      configSchema: schema,
    },
  };
}

export class PluginHost {
  /**
   * @param {{dir: string, stateDir: string, config?: object, log?: object}} opts
   */
  constructor({ dir, stateDir, config, log } = {}) {
    this.dir = dir;
    this.stateFile = path.join(stateDir ?? '.', 'plugins.json');
    this.config = config ?? {};
    this.log = log;
    /** name → { meta, hooks: {hook: fn}, module } */
    this.registry = new Map();
    /** name → { enabled: boolean } */
    this.state = {};
    /** 加载失败清单，控制台会显示出来 */
    this.failures = [];
  }

  async load() {
    this.registry.clear();
    this.failures = [];
    this.state = await this.readState();

    let entries = [];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.failures.push({ file: this.dir, message: `读插件目录失败：${err?.message ?? err}` });
      }
      return this;
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();

    for (const file of files) {
      const name = file.replace(/\.js$/, '');
      try {
        const mod = await import(pathToFileURL(path.join(this.dir, file)).href);
        const normalized = normalizeMeta(mod.meta, name);
        if (normalized.error) {
          this.failures.push({ file, message: normalized.error });
          continue;
        }
        const hooks = {};
        for (const hook of PLUGIN_HOOKS) {
          if (typeof mod[hook] === 'function') hooks[hook] = mod[hook];
        }
        if (!Object.keys(hooks).length) {
          this.failures.push({ file, message: `没有导出任何钩子（${PLUGIN_HOOKS.join(' / ')}）` });
          continue;
        }
        this.registry.set(name, { meta: normalized.meta, hooks, module: mod });
      } catch (err) {
        this.failures.push({ file, message: `import 失败：${err?.message ?? err}` });
      }
    }

    this.log?.info?.(`插件已加载 ${this.registry.size} 个${this.failures.length ? `，失败 ${this.failures.length} 个` : ''}`);
    return this;
  }

  async readState() {
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  isEnabled(name) {
    const entry = this.registry.get(name);
    if (!entry) return false;
    const saved = this.state?.[name];
    if (saved && typeof saved.enabled === 'boolean') return saved.enabled;
    return entry.meta.defaultEnabled !== false;
  }

  configOf(name) {
    const entry = this.registry.get(name);
    if (!entry) return {};
    return mergeConfig(entry.meta.configSchema, this.config?.plugins?.[name]);
  }

  /** 控制台用：不带函数，全是能 JSON 化的东西 */
  list() {
    return [...this.registry.values()].map((entry) => ({
      ...entry.meta,
      hooks: Object.keys(entry.hooks),
      enabled: this.isEnabled(entry.meta.name),
      config: this.configOf(entry.meta.name),
    }));
  }

  async setEnabled(name, enabled) {
    if (!this.registry.has(name)) throw new Error(`没有这个插件：${name}`);
    this.state[name] = { ...(this.state[name] ?? {}), enabled: Boolean(enabled) };
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.stateFile);
    return this.isEnabled(name);
  }

  /**
   * 顺序执行某个钩子：**上一个插件的输出是下一个插件的输入**，
   * 任何一个插件返回 {handled:true} 就停住这一轮。
   * 插件抛错只记日志并跳过它，不影响其它插件和主流程。
   * @returns {{handled: boolean, text: string}}
   */
  async runSequential(hook, ctx) {
    let text = asText(ctx?.text);
    for (const entry of this.registry.values()) {
      ctx?.signal?.throwIfAborted();
      if (typeof ctx?.canExecute === 'function' && !ctx.canExecute()) {
        throw new Error('管理员权限已变更，已停止执行插件');
      }
      const { name } = entry.meta;
      if (!this.isEnabled(name)) continue;
      const fn = entry.hooks[hook];
      if (!fn) continue;
      try {
        const result = await fn({ ...ctx, text, config: this.configOf(name), meta: entry.meta });
        if (result && typeof result === 'object') {
          if (result.handled) return { handled: true, text };
          if (typeof result.text === 'string' && result.text.trim()) text = result.text;
        }
      } catch (err) {
        this.log?.warn?.(`插件 ${name} 的 ${hook} 出错：${err?.message ?? err}`);
      }
    }
    return { handled: false, text };
  }

  /** onMessage / beforeReply 用：允许接管这一轮，也允许改写文本 */
  async runMessageHook(hook, ctx) {
    return this.runSequential(hook, ctx);
  }

  /** afterReply 用：只关心最终文本 */
  async runAfterReply(ctx) {
    const outcome = await this.runSequential('afterReply', ctx);
    return outcome.text;
  }

  /** 控制台「重新读取插件」用 */
  async reload() {
    return this.load();
  }
}
