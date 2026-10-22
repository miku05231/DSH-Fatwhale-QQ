// src/config.js —— 读取 / 校验 / 原子写配置（零依赖）
//
// 约定：
// - 相对路径不在这里展开，调用方用 resolvePath(projectRoot, p) 自行解析（SPEC §3）
// - security.allowFrom 为空即拒绝一切，这里绝不填充默认放行值
// - 所有面向用户/终端的错误信息都是中文，并指出具体字段

import fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_SESSION_WINDOW_MINUTES, isValidSessionWindowMinutes } from './sessions.js';

/** 默认配置（与 SPEC §3、config.example.json 完全一致） */
export const DEFAULTS = deepFreeze({
  onebot: {
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
  },
  dsh: {
    command: 'dsh',
    // auto = 本机有 desktop profile 就用桌面 profile（全部插件），否则 headless
    mode: 'auto',
    // headless 模式的 profile 名；desktop 模式固定使用 desktopProfile
    profile: 'headless',
    // desktop profile 名，或绝对路径（测试/多 profile 时用）
    desktopProfile: 'desktop',
    // desktop host 启动最长时间；首次消息要等这么久，超时回退 headless
    desktopBootTimeoutMs: 120000,
    // desktop host 空闲多久后关闭（毫秒，0 = 不自动关）。关掉释放内存，下条消息再拉起
    desktopIdleMs: 900000,
    // desktop 启动失败时，本条消息是否回退 headless
    fallbackToHeadless: true,
    // 桌面端装了 qq-bridge-companion 时，优先让桌面宿主自己建会话（列表实时刷新）
    companion: true,
    // companion discovery 文件；留空 = <DSH_HOME>/qq-bridge-companion.json
    companionDiscovery: '',
    patchPath: 'patches/headless-model.yml',
    // '.' = 配置文件所在目录（项目根）；换台电脑、搬目录、进容器都不用改。
    // 想固定一个自己的工作区就写绝对路径，或相对路径（按项目根解析）。
    cwd: '.',
    timeoutMs: 300000,
    // 传给子进程 dsh 的 DSH_PERMISSION_MODE。
    // 空字符串 = 不设，让 dsh 用自己的默认值（workspace-write）。
    // 设成 danger-full-access 后，QQ 里的 agent 才能真正跑 shell 命令
    // （发图、撤回、发说说都靠 tools/qq.mjs）。代价是它对这个用户能干的
    // 事也一并放开，只给 security.adminUserIds 中的可信账号使用。
    permissionMode: 'danger-full-access',
  },
  security: {
    // 独立于聊天准入名单。只有显式配置的账号能调用电脑工具。
    adminUserIds: [],
    allowFrom: [],
    // allowGroupIds 非空时按群号精确放行；为空则退回 allowGroups 开关
    allowGroupIds: [],
    allowGroups: false,
    rateLimitPerMinute: 10,
    maxChars: 4000,
  },
  behavior: {
    queuedNotice: '收到，正在处理…',
    maxReplyChunk: 1200,
    showErrors: true,
    wakeWord: '',
    // 从首次对话开始的固定窗口，0 持续复用；控制台保存后下一条消息生效。
    sessionWindowMinutes: DEFAULT_SESSION_WINDOW_MINUTES,
  },
  // JEV URL 和 token 齐全时用于群聊判断，否则沿用当前默认模型。
  jev: {
    baseUrl: '',
    token: '',
    model: '',
    timeoutMs: 8000,
    contextMessages: 12,
  },
  automation: {
    bilibili: {
      enabled: false,
      cron: '0 9 * * *',
      keywords: [],
      upUsers: [],
      targets: [],
      mentionUid: '',
      commentEnabled: false,
      commentApproved: false,
    },
  },
  // 人格：一篇 Markdown。默认在工作区 AGENTS.md（DSH 自己会读，桥接就不重复注入）；
  // 指到别处时由桥接每条消息读出来注入 prompt。
  persona: {
    enabled: true,
    path: 'qq-workspace\\AGENTS.md',
    dir: 'state\\personas',
    active: '',
    maxChars: 8000,
  },
  // 长期记忆（Obsidian 库根目录）。相对路径按项目根解析。
  memory: {
    enabled: true,
    root: '记忆库',
    maxInjectChars: 1200,
    capture: true,
    reflectEvery: 20,
    // 记忆反思（src/reflect.js）：控制台「记忆」页有一键按钮，桥接里还有每天定时。
    // reflectForce=true 时每次都 --force（重写本周笔记，覆盖前自动备份）；
    // 关掉就退化成「本周已经有反思就跳过」。
    reflectDaily: true,
    reflectTime: '04:00',
    reflectForce: true,
    reflectDays: 3,
    reflectBackup: true,
    reflectCatchUp: true,
  },
  logDir: 'logs',
  stateDir: 'state',
  // 表情包库（src/stickers.js）：只自动采集有 QQ 表情元数据的图片、打标签、建索引。
  // root 可以指到任意位置（控制台「表情」页能改，也能一键迁移）；相对路径按项目根解析。
  stickers: {
    enabled: true,
    root: 'state\\stickers',
    autoCollect: true,
    autoTag: true,
    // 0 关闭表情发送，1 保留原发送频率。
    sendProbability: 1,
    maxBytes: 5 * 1024 * 1024,
    minBytes: 200,
    maxPerMessage: 3,
    perMinute: 20,
  },
});

const CREATE_NOTICE = '已生成默认配置，请填写 security.allowFrom 后再使用';

// ---------------------------------------------------------------- 工具

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 深拷贝（数组/普通对象；Date 等非纯对象按引用保留） */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
    return copy;
  }
  return value;
}

/** 用用户配置覆盖默认值（对象递归合并、数组整体替换、未知字段原样保留） */
function mergeDefaults(input, base = clone(DEFAULTS)) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  for (const [key, value] of Object.entries(input)) {
    const current = base[key];
    const bothPlainObjects =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current);
    if (bothPlainObjects) {
      base[key] = mergeDefaults(value, current);
    } else {
      base[key] = clone(value);
    }
  }
  return base;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 原子写：先写 <file>.tmp，再 renameSync 覆盖；任何失败都清理临时文件 */
function writeFileAtomic(target, text) {
  const abs = resolve(target);
  const tmp = `${abs}.tmp`;
  try {
    fs.mkdirSync(dirname(abs), { recursive: true });
  } catch (err) {
    throw new Error(`无法创建配置文件所在目录：${dirname(abs)}（${err.message}）`);
  }
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    throw new Error(`写入配置文件失败：${abs}（${err.message}）`);
  }
  return abs;
}

function describe(value) {
  let text;
  if (typeof value === 'string') {
    text = JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  } else {
    try {
      const json = JSON.stringify(value);
      text = json === undefined ? String(value) : json;
    } catch {
      text = String(value);
    }
    if (text.length > 80) text = `${text.slice(0, 80)}…`;
  }
  return text;
}

function getField(config, dotted) {
  let current = config;
  for (const key of dotted.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function invalid(field, reason, value) {
  throw new Error(`配置项 "${field}" ${reason}（当前值：${describe(value)}）`);
}

// ---------------------------------------------------------------- 校验

const REQUIRED_STRINGS = [
  'onebot.url',
  'dsh.command',
  'dsh.profile',
  'logDir',
  'stateDir',
];

const OPTIONAL_STRINGS = [
  'onebot.accessToken',
  'dsh.mode',
  'dsh.desktopProfile',
  'dsh.companionDiscovery',
  'dsh.permissionMode',
  'dsh.cwd', // 留空 = 进程当前目录；'.' = 配置文件所在目录
  'dsh.patchPath', // 留空 = 不套补丁（干净的机器、Docker 里默认就没补丁）
  'behavior.queuedNotice',
  'behavior.wakeWord',
  'jev.baseUrl',
  'jev.token',
  'jev.model',
  'persona.dir',
  'persona.active',
];

const POSITIVE_INTEGERS = [
  ['dsh.timeoutMs', '超时时间'],
  ['dsh.desktopBootTimeoutMs', 'desktop host 启动超时'],
  ['security.maxChars', '单条消息最大字符数'],
  ['behavior.maxReplyChunk', '回复分片长度'],
];

function validateConfig(config) {
  if (!isValidSessionWindowMinutes(config?.behavior?.sessionWindowMinutes)) {
    invalid('behavior.sessionWindowMinutes', '必须是非负整数分钟（0 表示持续复用）',
      config?.behavior?.sessionWindowMinutes);
  }
  for (const field of REQUIRED_STRINGS) {
    const value = getField(config, field);
    if (typeof value !== 'string' || value.trim() === '') {
      invalid(field, '必须是非空字符串', value);
    }
  }

  for (const field of OPTIONAL_STRINGS) {
    const value = getField(config, field);
    if (typeof value !== 'string') {
      invalid(field, '必须是字符串（可以为空字符串）', value);
    }
  }

  const mode = getField(config, 'dsh.mode');
  if (!['auto', 'desktop', 'headless'].includes(mode)) {
    invalid('dsh.mode', '必须是 auto、desktop 或 headless 之一', mode);
  }
  const permission = getField(config, 'dsh.permissionMode');
  if (!['', 'read-only', 'workspace-write', 'danger-full-access'].includes(permission)) {
    invalid('dsh.permissionMode', '必须是空字符串、read-only、workspace-write 或 danger-full-access', permission);
  }

  const idleMs = getField(config, 'dsh.desktopIdleMs');
  if (!Number.isInteger(idleMs) || idleMs < 0) {
    invalid('dsh.desktopIdleMs', '必须是大于等于 0 的整数（0 表示不自动关闭）', idleMs);
  }

  // onebot.url：必须是合法的 ws:// 或 wss:// 地址
  const url = getField(config, 'onebot.url');
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    invalid('onebot.url', '不是合法的 URL（应形如 ws://127.0.0.1:3001）', url);
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    invalid('onebot.url', '必须以 ws:// 或 wss:// 开头', url);
  }

  for (const [field, label] of POSITIVE_INTEGERS) {
    const value = getField(config, field);
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      invalid(field, `必须是正整数（${label}）`, value);
    }
  }

  for (const field of ['jev.timeoutMs', 'jev.contextMessages']) {
    const value = getField(config, field);
    const max = field === 'jev.timeoutMs' ? 60000 : 100;
    if (!Number.isInteger(value) || value < 1 || value > max) {
      invalid(field, `必须是 1–${max} 之间的整数`, value);
    }
  }
  const jevBaseUrl = getField(config, 'jev.baseUrl').trim();
  if (jevBaseUrl) {
    let parsed;
    try { parsed = new URL(jevBaseUrl); } catch { invalid('jev.baseUrl', '不是合法的 URL', jevBaseUrl); }
    if (!['http:', 'https:'].includes(parsed.protocol)) invalid('jev.baseUrl', '必须使用 http 或 https', jevBaseUrl);
  }

  // rateLimitPerMinute：<= 0 表示不限流，所以允许 0 与负数
  const rate = getField(config, 'security.rateLimitPerMinute');
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    invalid('security.rateLimitPerMinute', '必须是数字（小于等于 0 表示不限流）', rate);
  }

  for (const field of ['security.allowGroups', 'behavior.showErrors', 'dsh.fallbackToHeadless', 'dsh.companion']) {
    const value = getField(config, field);
    if (typeof value !== 'boolean') invalid(field, '必须是 true 或 false', value);
  }

  // 记忆反思（src/reflect.js）：时间必须是 HH:MM，天数 1–30（reflect.mjs 自己的钳制范围）
  for (const field of [
    'memory.reflectDaily',
    'memory.reflectForce',
    'memory.reflectBackup',
    'memory.reflectCatchUp',
  ]) {
    const value = getField(config, field);
    if (typeof value !== 'boolean') invalid(field, '必须是 true 或 false', value);
  }
  const reflectTime = getField(config, 'memory.reflectTime');
  if (typeof reflectTime !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(reflectTime)) {
    invalid('memory.reflectTime', '必须是 HH:MM 格式的 24 小时时间（例如 04:00）', reflectTime);
  }
  const reflectDays = getField(config, 'memory.reflectDays');
  if (!Number.isInteger(reflectDays) || reflectDays < 1 || reflectDays > 30) {
    invalid('memory.reflectDays', '必须是 1–30 之间的整数（反思素材取最近几天）', reflectDays);
  }

  // 表情包库（src/stickers.js）：目录可指到任意位置，阈值别填反
  for (const field of ['stickers.enabled', 'stickers.autoCollect', 'stickers.autoTag']) {
    const value = getField(config, field);
    if (typeof value !== 'boolean') invalid(field, '必须是 true 或 false', value);
  }
  const sendProbability = getField(config, 'stickers.sendProbability');
  if (typeof sendProbability !== 'number' || !Number.isFinite(sendProbability) ||
      sendProbability < 0 || sendProbability > 1) {
    invalid('stickers.sendProbability', '必须是 0–1 之间的数字（0 关闭发送，1 保留原频率）', sendProbability);
  }
  const stickerRoot = getField(config, 'stickers.root');
  if (typeof stickerRoot !== 'string' || stickerRoot.trim() === '') {
    invalid('stickers.root', '必须是非空字符串（存放目录，绝对路径或相对项目根）', stickerRoot);
  }
  for (const [field, label, min, max] of [
    ['stickers.maxBytes', '单张上限（字节）', 1024, 64 * 1024 * 1024],
    ['stickers.minBytes', '单张下限（字节）', 0, 1024 * 1024],
    ['stickers.maxPerMessage', '一条消息最多收几张', 1, 9],
    ['stickers.perMinute', '每分钟最多收几张', 1, 200],
  ]) {
    const value = getField(config, field);
    if (!Number.isInteger(value) || value < min || value > max) {
      invalid(field, `必须是 ${min}–${max} 之间的整数（${label}）`, value);
    }
  }
  if (getField(config, 'stickers.minBytes') >= getField(config, 'stickers.maxBytes')) {
    invalid('stickers.minBytes', '不能大于等于 stickers.maxBytes', getField(config, 'stickers.minBytes'));
  }

  // allowFrom：QQ 号数组（数字或纯数字字符串都接受）；允许空数组（= 拒绝一切）
  const allowFrom = getField(config, 'security.allowFrom');
  if (!Array.isArray(allowFrom)) {
    invalid('security.allowFrom', '必须是数组（元素为 QQ 号；留空 [] 表示拒绝所有消息）', allowFrom);
  }
  allowFrom.forEach((entry, index) => {
    const field = `security.allowFrom[${index}]`;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || !Number.isInteger(entry)) {
        invalid(field, '必须是整数 QQ 号或纯数字字符串', entry);
      }
      return;
    }
    if (typeof entry === 'string') {
      if (!/^\d+$/.test(entry.trim())) {
        invalid(field, '必须是纯数字的 QQ 号字符串', entry);
      }
      return;
    }
    invalid(field, '必须是整数 QQ 号或纯数字字符串', entry);
  });

  const admins = getField(config, 'security.adminUserIds');
  if (!Array.isArray(admins)) {
    invalid('security.adminUserIds', '必须是 QQ 号数组（留空 [] 表示无人拥有电脑权限）', admins);
  }
  admins.forEach((entry, index) => {
    if (
      !((typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0) ||
        (typeof entry === 'string' && /^[1-9]\d*$/.test(entry.trim())))
    ) {
      invalid(`security.adminUserIds[${index}]`, '必须是正整数 QQ 号或纯数字字符串', entry);
    }
  });

  return config;
}

// ---------------------------------------------------------------- 对外 API

/**
 * 读取配置。
 * @param {string} projectRoot 项目根目录（默认的 config.json 与 config.example.json 所在目录）
 * @param {{createIfMissing?: boolean, configFile?: string}} [opts]
 *   configFile：可选的自定义配置文件路径（相对路径按 projectRoot 解析），
 *   用于 `node src/index.js --config <path>`；不传则用 <projectRoot>/config.json。
 * @returns {{config: object, path: string, created: boolean, notice: string|null}}
 *   created=true 表示本次是自动生成的默认配置；notice 为对应的中文提示，否则为 null。
 */
export function loadConfig(projectRoot, { createIfMissing = true, configFile } = {}) {
  const root = resolve(projectRoot ? String(projectRoot) : process.cwd());
  const configPath =
    typeof configFile === 'string' && configFile.trim() !== ''
      ? resolvePath(root, configFile)
      : envConfigFile() || join(root, 'config.json');
  const examplePaths = [...new Set([join(dirname(configPath), 'config.example.json'), join(root, 'config.example.json')])];

  let created = false;
  let notice = null;

  if (!fs.existsSync(configPath)) {
    if (createIfMissing === false) {
      throw new Error(
        `配置文件不存在：${configPath}。请先创建 config.json（可复制 config.example.json 后修改）。`,
      );
    }
    createFromExample(examplePaths, configPath);
    created = true;
    notice = CREATE_NOTICE;
  }

  let raw;
  try {
    raw = readText(configPath);
  } catch (err) {
    throw new Error(`无法读取配置文件：${configPath}（${err.message}）`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `配置文件格式错误：${configPath}（${err.message}）。请检查 JSON 语法（不能有注释、末尾不能有多余逗号）。`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件格式错误：${configPath} 的最外层必须是一个 JSON 对象（{ ... }）。`);
  }

  const config = validateConfig(mergeDefaults(parsed));

  if (created) {
    // 同时打到终端日志（index.js 拿到 notice 后还会用自己的 logger 再记一次）
    console.warn(`[qq-bridge] ${notice}（配置文件：${configPath}）`);
  } else if (Array.isArray(config.security?.allowFrom) && config.security.allowFrom.length === 0) {
    console.warn(
      `[qq-bridge] security.allowFrom 为空：按安全默认将拒绝所有消息。请在 ${configPath} 中填写允许的 QQ 号。`,
    );
  }

  return { config, path: configPath, created, notice };
}

/** 用 config.example.json 的副本生成配置文件（示例缺失/损坏时退回内置 DEFAULTS） */
function createFromExample(examplePaths, configPath) {
  for (const examplePath of examplePaths) {
    if (!fs.existsSync(examplePath)) continue;
    try {
      const text = readText(examplePath);
      const example = JSON.parse(text);
      if (!example || typeof example !== 'object' || Array.isArray(example)) {
        console.warn(`[qq-bridge] ${examplePath} 的最外层不是 JSON 对象，已跳过。`);
        continue;
      }
      writeFileAtomic(configPath, text.endsWith('\n') ? text : `${text}\n`);
      return;
    } catch {
      console.warn(`[qq-bridge] ${examplePath} 无法解析，已跳过。`);
    }
  }
  console.warn('[qq-bridge] 未找到可用的 config.example.json，已用内置默认配置生成 config.json。');
  writeFileAtomic(configPath, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
}

/**
 * 保存配置（原子写：先写 <file>.tmp 再 renameSync）。
 * @param {string} path 配置文件路径
 * @param {object} config 配置对象
 * @returns {string} 实际写入的绝对路径
 */
export function saveConfig(path, config) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('saveConfig 需要非空的配置文件路径（字符串）');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('saveConfig 需要配置对象（不能是数组或空值）');
  }
  let text;
  try {
    text = `${JSON.stringify(config, null, 2)}\n`;
  } catch (err) {
    throw new Error(`配置内容无法序列化为 JSON（${err.message}）`);
  }
  return writeFileAtomic(path, text);
}

/**
 * 环境变量 QQ_CONFIG 指定的配置文件（绝对路径，或相对当前工作目录）。
 * 容器里用得到：镜像里的 /app 是只读代码，配置单独挂一个目录。
 * @returns {string|null}
 */
export function envConfigFile() {
  const raw = typeof process.env.QQ_CONFIG === 'string' ? process.env.QQ_CONFIG.trim() : '';
  return raw === '' ? null : resolve(raw);
}

/**
 * 解析路径：绝对路径原样返回，相对路径拼到 projectRoot 上。
 * @param {string} projectRoot 项目根目录
 * @param {string} p 绝对或相对路径
 * @returns {string} 绝对路径
 */
export function resolvePath(projectRoot, p) {
  const root = resolve(projectRoot ? String(projectRoot) : process.cwd());
  if (p === undefined || p === null) return root;
  if (typeof p !== 'string') throw new TypeError('路径参数必须是字符串');
  const raw = p.trim();
  if (raw === '') return root;
  if (isAbsolute(raw)) return raw;
  return resolve(root, raw);
}
