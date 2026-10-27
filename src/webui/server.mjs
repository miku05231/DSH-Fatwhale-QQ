// src/webui/server.mjs —— 本地控制台 Web 服务（零依赖，默认只绑 127.0.0.1）
//
// 契约见 SPEC-2 §5.1 / §5.2：
//   createWebUiServer({ config, configRoot, log, port }) → { start, stop, url }
//
// 设计要点：
//   * 只用 node: 内置模块，没有任何第三方依赖；
//   * 只监听 127.0.0.1，端口被占用时 +1 顺延（最多 10 次），成功后把实际端口
//     写进 <stateDir>/webui-port.txt 供托盘 / bootstrap 读取；
//   * 所有 JSON 响应统一 {ok:true,data} / {ok:false,error}；
//   * 记忆笔记的读写路径必须落在记忆根目录内（防 ../、绝对路径、URL 编码穿越）；
//   * 进程控制不拼字符串，改为生成临时 .ps1（UTF-8 with BOM）再交给
//     powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 执行；
//   * 任何对外文本都会把 token=xxx 打码成 token=***。
//
// 单独调试：node src\webui\server.mjs

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createUpdateManager } from '../updates.mjs';
import { createImagegenApi } from './imagegen-api.mjs';
import { createPlatformScheduler } from '../platform-scheduler.js';
import { createBilibiliQrLogin } from '../platforms/bilibili-login.js';
import { createNapcatHealth, createNapcatHealthJournal, readNapcatSettings } from '../napcat-health.js';
import { DEFAULT_SESSION_WINDOW_MINUTES, isValidSessionWindowMinutes } from '../sessions.js';
import { openLocalPath, openExternalUrl } from '../open-path.js';
import { describeModelState, writeModelState, validateModelSelection, MODEL_MODES, REASONING_EFFORTS } from '../model-follow.js';
import { inspectDshRuntime } from '../dsh.js';
import { fetchCompanionModelCatalog } from '../dsh-companion.js';
import { PluginHost, PLUGIN_HOOKS, SCHEMA_TYPES, coerceValue } from '../plugins.js';
import { validateTtsConfig } from '../plugins/reply-tts.js';
import { validMediaKey } from '../media-api.js';
import { resolvePersonaPath, resolveMemoryRoot, resolveWorkspace, expandPath } from '../persona.js';
import {
  createPersona,
  deletePersona,
  listPersonas,
  personaDir,
  readPersona,
  readState,
  resolvePersonaFor,
  seedFromFile,
  setActivePersona,
  setChatPersona,
  writePersona,
} from '../personas.js';
import {
  normalizeReflectSettings,
  nextRunAt,
  reflectionPath,
  countBackups,
  readReflectState,
  readReflectLock,
  isReflectLocked,
  summarizeLines,
  runReflect,
} from '../reflect.js';
import {
  ensureIndex,
  deleteSticker,
  listStickers,
  loadIndex,
  migrateStore,
  normalizeStickerSettings,
  rebuildIndex,
  resolveStickerFile,
  stickerRootDir,
  storeStats,
  tagCounts,
  updateTags,
} from '../stickers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const PUBLIC_DIR = path.join(HERE, 'public');

/** 默认端口与最多顺延次数（SPEC-2 §5.1） */
const DEFAULT_PORT = 5830;
const MAX_PORT_TRIES = 10;
/** 单个进程操作的超时（SPEC-2 §5.2：60 秒） */
const ACTION_TIMEOUT_MS = 60_000;
/** 请求体上限，人格文件再长也不该超过这个数 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 读取日志时最多回看的字节数，避免把整个日志读进内存 */
const LOG_TAIL_BYTES = 256 * 1024;

const SERVICE_NAMES = ['napcat', 'bridge', 'dsh'];
const SERVICE_ACTIONS = ['start', 'stop', 'restart'];

const SERVICE_LABEL = { napcat: 'NapCat', bridge: '桥接', dsh: 'DSH' };
const SERVICE_FUNCS = {
  napcat: { start: 'Start-NapCat', stop: 'Stop-NapCat' },
  bridge: { start: 'Start-Bridge', stop: 'Stop-Bridge' },
  dsh: { start: 'Start-Dsh', stop: 'Stop-Dsh' },
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

/** 允许通过 PUT /api/settings 改写的字段白名单（绝不含密钥） */
const SETTINGS_SPEC = {
  // 路径类：人格文件、记忆库根、DSH 工作区都可以指到任意位置
  persona: {
    enabled: 'bool',
    path: 'path',
    maxChars: 'int',
  },
  memory: {
    enabled: 'bool',
    root: 'path',
    maxInjectChars: 'int',
    capture: 'bool',
    reflectEvery: 'int',
    reflectDaily: 'bool',
    reflectTime: 'time',
    reflectForce: 'bool',
    reflectDays: 'int',
    reflectBackup: 'bool',
    reflectCatchUp: 'bool',
  },
  dsh: {
    cwd: 'path',
  },
  security: {
    adminUserIds: 'qqIdArray',
    allowFrom: 'intArray',
    denyFrom: 'intArray',
    allowGroupIds: 'intArray',
    denyGroupIds: 'intArray',
    privatePolicy: 'policy',
    allowGroups: 'bool',
    allowGroupMembers: 'bool',
    rateLimitPerMinute: 'int',
    maxChars: 'int',
  },
  behavior: {
    queuedNotice: 'string',
    maxReplyChunk: 'int',
    showErrors: 'bool',
    wakeWord: 'string',
    wakeWordMatch: 'string',
    groupContextCount: 'int',
    sessionWindowMinutes: 'sessionWindow',
  },
  jev: {
    baseUrl: 'string',
    token: 'string',
    model: 'string',
    timeoutMs: 'int',
    contextMessages: 'int',
  },
  groupMemory: { limit: 'int' },
  // 表情包库：目录能搬、开关能关、阈值能调（都在控制台「表情」页上）
  stickers: {
    enabled: 'bool',
    root: 'path',
    autoCollect: 'bool',
    autoTag: 'bool',
    sendProbability: 'probability',
    maxBytes: 'int',
    minBytes: 'int',
    maxPerMessage: 'int',
    perMinute: 'int',
  },
};

// ------------------------------------------------------------------ 小工具

/** 去掉 BOM / 首尾空白的安全字符串化 */
function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** 把任何输出里的密钥换成 ***（SPEC-2 铁律 6）
 *
 *  三种形态分开处理，互不干扰：
 *    1) JSON 形态：`"accessToken":"xxx"` → `"accessToken":"***"`（引号保持成对，不破坏结构）
 *    2) 键值形态：`token=xxx` / `password: xxx` → `token=***`
 *    3) Bearer 形态：`Authorization: Bearer xxx` → `Bearer ***`
 */
const JSON_SECRET_RE =
  /("(?:access_?token|refresh_?token|token|password|passwd|pwd|secret|api_?key|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const KV_SECRET_RE =
  /\b(access_?token|refresh_?token|token|password|passwd|pwd|secret|api_?key|authorization)\b\s*[=:]\s*(?!\*)([^\s"'&,;}\]]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;

export function redactSecrets(input) {
  return text(input)
    .replace(JSON_SECRET_RE, '$1"***"')
    .replace(KV_SECRET_RE, '$1=***')
    .replace(BEARER_RE, 'Bearer ***');
}

/** 相对路径按 root 解析；绝对路径原样返回 */
function resolveFrom(root, p) {
  if (p === undefined || p === null || text(p).trim() === '') return path.resolve(root);
  const raw = text(p).trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

/** target 是否严格位于 root 之内（Windows 下大小写不敏感由 path.relative 处理） */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return false;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith('..' + path.sep) && rel !== '..';
}

/** 本地时间戳 YYYYMMDD-HHmmss，用于人格备份文件名 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 安全读 JSON；失败返回 null，绝不抛 */
async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (raw.trim() === '') return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 原子写：先写同目录 .tmp 再 rename，Windows 撞锁重试几次 */
async function writeAtomic(file, content) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, content, 'utf8');
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (i === 4) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

/** 进程是否还活着（Windows 上 EPERM 也代表存在） */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** 探测本机 TCP 端口是否有人监听 */
function probeTcp(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(Number(port), host);
    } catch {
      finish(false);
    }
  });
}

/** 包一层 child_process.spawn，返回 {code,stdout,stderr}，超时会尽量连子进程一起杀掉 */
function runProcess(file, args, { timeoutMs = ACTION_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // powershell 会拉起子进程，只 kill 自身可能留下残留，补一刀 taskkill。
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* 忽略 */
      }
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`操作超时（${Math.round(timeoutMs / 1000)} 秒）`);
        err.code = 'ETIMEDOUT';
        reject(err);
        return;
      }
      resolve({ code: Number(code) || 0, stdout, stderr });
    });
  });
}

/** PowerShell 单引号字符串转义：把 ' 变成 '' */
function psQuote(value) {
  return `'${text(value).replace(/'/g, "''")}'`;
}

// -------------------------------------------------- 进程控制：临时 .ps1 桥

/**
 * 生成进程控制脚本内容（供 tests 校验参数拼装）。
 * 脚本 dot-source ProcessControl.ps1 后调用 Start-/Stop- 函数，
 * 结果写进 resultPath（UTF-8 无 BOM 的 JSON），stdout 只留给人看。
 * @param {{name:string, action:string, resultPath:string, libPath:string}} opts
 * @returns {string}
 */
export function buildServiceScript({ name, action, resultPath, libPath }) {
  if (!SERVICE_NAMES.includes(name)) throw new Error(`不支持的进程：${name}`);
  if (!SERVICE_ACTIONS.includes(action)) throw new Error(`不支持的操作：${action}`);
  const funcs = SERVICE_FUNCS[name];
  const label = SERVICE_LABEL[name];

  const lines = [
    '# 由控制台自动生成，勿手工修改。执行完请勿复用（文件名带随机串）。',
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$lib = ${psQuote(libPath)}`,
    `$resultPath = ${psQuote(resultPath)}`,
    `$action = ${psQuote(action)}`,
    '',
    'function Write-ConsoleResult([bool]$Ok, [string]$Message) {',
    '    try {',
    "        $payload = [ordered]@{ ok = $Ok; message = $Message; at = (Get-Date).ToString('o') }",
    '        $json = $payload | ConvertTo-Json -Compress',
    '        $utf8 = New-Object System.Text.UTF8Encoding($false)',
    '        [System.IO.File]::WriteAllText($resultPath, $json, $utf8)',
    '    } catch { }',
    '}',
    '',
    '$ok = $false',
    "$message = ''",
    'try {',
    '    if (-not (Test-Path -LiteralPath $lib)) { throw ("找不到进程控制模块：" + $lib) }',
    '    . $lib',
    "    if ($action -eq 'start') {",
    `        $ok = [bool](${funcs.start})`,
    `        if ($ok) { $message = '${label} 已启动' } else { $message = '${label} 启动失败（可到日志里看原因）' }`,
    "    } elseif ($action -eq 'stop') {",
    `        $ok = [bool](${funcs.stop})`,
    `        if ($ok) { $message = '${label} 已停止' } else { $message = '${label} 停止失败（可能仍在退出中）' }`,
    "    } elseif ($action -eq 'restart') {",
    `        $null = ${funcs.stop}`,
    '        Start-Sleep -Milliseconds 900',
    `        $ok = [bool](${funcs.start})`,
    `        if ($ok) { $message = '${label} 已重启' } else { $message = '${label} 重启失败' }`,
    '    } else {',
    '        throw ("未知操作：" + $action)',
    '    }',
    '} catch {',
    '    $ok = $false',
    "    $message = '执行出错：' + [string]$_.Exception.Message",
    '}',
    'Write-ConsoleResult $ok $message',
    'exit 0',
    '',
  ];
  return lines.join('\n');
}

/** 写 .ps1 时必须是 UTF-8 with BOM，否则 PS 5.1 会把中文读成乱码（SPEC-2 铁律 3） */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ------------------------------------------------------------ 响应工具

function sendBuffer(res, status, buffer, contentType, extra = {}) {
  const head = {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  };
  res.writeHead(status, head);
  if (res.__headOnly) res.end();
  else res.end(buffer);
}

function sendJson(res, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"ok":false,"error":"响应序列化失败"}';
    status = 500;
  }
  // 兜底再打一次码：我们自己构造的 JSON 不含密钥，这里只是防止意外。
  // 用的正则会跳过 " 引号，不会把 accessToken":"xxx" 这类 JSON 结构吃坏。
  body = redactSecrets(body);
  sendBuffer(res, status, Buffer.from(body, 'utf8'), 'application/json; charset=utf-8');
}

const ok = (res, data) => sendJson(res, 200, { ok: true, data });
const fail = (res, status, error) => sendJson(res, status, { ok: false, error: text(error) });

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 });
    }
    return parsed;
  } catch (err) {
    if (err.statusCode) throw err;
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 });
  }
}

// -------------------------------------------------- 记忆笔记路径安检

/**
 * 把用户给出的相对路径解析成记忆根内的绝对路径。
 * 挡掉：../ 穿越、绝对路径、盘符、UNC、URL 编码穿越、空字节、NTFS 数据流。
 * @returns {{ok:true, abs:string, rel:string} | {ok:false, reason:string}}
 */
export function resolveNotePath(root, rawPath) {
  const original = text(rawPath).trim();
  if (original === '') return { ok: false, reason: '缺少 path 参数' };
  if (original.length > 512) return { ok: false, reason: '路径过长' };

  // URL 解码可能是二段编码（%252e%252e%252f），这里收口成一次可判定的形式。
  let decoded = original;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('\0')) return { ok: false, reason: '路径包含非法字符' };
  if (normalized.startsWith('/')) return { ok: false, reason: '不允许使用绝对路径' };
  if (/^[a-zA-Z]:/.test(normalized)) return { ok: false, reason: '不允许使用盘符路径' };
  if (normalized.includes(':')) return { ok: false, reason: '路径包含非法字符' };
  if (normalized.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: '不允许使用上级目录' };
  }

  const abs = path.resolve(root, normalized);
  if (!isInside(root, abs)) return { ok: false, reason: '路径超出记忆库范围' };

  // 已存在的文件再做一次真实路径校验，挡掉符号链接 / 目录联接。
  try {
    const realRoot = fs.realpathSync(root);
    const realAbs = fs.realpathSync(abs);
    if (!isInside(realRoot, realAbs)) return { ok: false, reason: '路径超出记忆库范围' };
  } catch {
    /* 文件不存在时跳过；写入前会再建目录，仍在 root 内 */
  }

  return { ok: true, abs, rel: path.relative(root, abs).split(path.sep).join('/') };
}

// ------------------------------------------------------------ 主工厂

/**
 * @param {{config?: object, configRoot?: string, log?: object, port?: number, host?: string}} opts
 * @returns {{start: Function, stop: Function, url: string, port: number}}
 */
/**
 * NapCat WebUI 地址归一化。
 * 默认是 6099 端口的 /webui/；前端以前把整个 URL 当端口用，拼出了
 * http://127.0.0.1:http://127.0.0.1:6099 这种非法地址，点了没反应 —— 统一在这里兜住。
 */
/** 给 WebUI 地址拼上登录 token（NapCat 的 /web_login 支持 ?token= 自动登录） */
export function withWebuiToken(baseUrl, token) {
  const base = normalizeNapcatWebUi(baseUrl);
  const value = String(token ?? '').trim();
  if (!value) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(value)}`;
}

/** 展示/回传时把 token 打码，避免出现在控制台界面与日志里 */
export function maskTokenUrl(url) {
  return String(url ?? '').replace(/([?&]token=)[^&]+/i, '$1***');
}

export function normalizeNapcatWebUi(raw) {
  const fallback = 'http://127.0.0.1:6099/webui/';
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    if (!url.pathname || url.pathname === '/') url.pathname = '/webui/';
    else if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    return url.toString();
  } catch {
    return fallback;
  }
}
/**
 * 配置文件路径：优先环境变量 QQ_CONFIG（容器里配置单独挂一个目录），
 * 否则用 <项目根>/config.json。
 * @param {string} root 项目根目录
 * @returns {string}
 */
function configFileOf(root) {
  const raw = typeof process.env.QQ_CONFIG === 'string' ? process.env.QQ_CONFIG.trim() : '';
  return raw === '' ? path.join(root, 'config.json') : path.resolve(raw);
}

export function createWebUiServer({
  config = {}, configRoot, log, port = DEFAULT_PORT, host = '127.0.0.1', updateManager,
  openPath = openLocalPath, openUrl = openExternalUrl, platformControl, platformQrLogin, napcatHealth,
} = {}) {
  const root = path.resolve(text(configRoot) || PROJECT_ROOT);
  const basePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : DEFAULT_PORT;

  const stateDir = resolveFrom(root, config?.stateDir ?? 'state');
  const logDir = resolveFrom(root, config?.logDir ?? 'logs');
  const configPath = configFileOf(root);
  // 人格 / 记忆 / 工作区都支持自定义路径：每次按当前配置解析，改完不用重启控制台
  const personaFilePath = () => resolvePersonaPath({ configRoot: root, config });
  const memoryRootDir = () => resolveMemoryRoot({ configRoot: root, config });
  const workspaceDir = () => resolveWorkspace({ configRoot: root, config });
  const backupDir = path.join(stateDir, 'persona-backup');
  const webuiTmpDir = path.join(stateDir, 'webui');
  const portFile = path.join(stateDir, 'webui-port.txt');
  const statusFile = path.join(stateDir, 'status.json');
  const sessionsFile = path.join(stateDir, 'sessions.json');
  const groupMemDir = path.join(stateDir, 'groupmem');
  const chatSessionsFile = text(config?.chatSessionsPath).trim()
    ? resolveFrom(root, config.chatSessionsPath)
    : path.join(os.homedir(), '.dsh', 'media', 'onebot', 'chat-sessions.json');
  const libPath = path.join(root, 'launcher', 'lib', 'ProcessControl.ps1');
  // 记忆库根目录见 memoryRootDir()（支持 config.memory.root 指到任意位置）


  // 基础 patch（与 src/index.js 同一套解析规则）；模型跟随拿它当兜底。
  const configuredPatch = config?.dsh?.patchPath ?? path.join('patches', 'headless-model.yml');
  const basePatchPath = configuredPatch ? resolveFrom(root, configuredPatch) : '';

  const onebotPort = Number(config?.onebot?.port) || portFromUrl(config?.onebot?.url) || 3001;
  const napcatWebUi = normalizeNapcatWebUi(readNapcatSettings(root, config).baseUrl);

  /** NapCat 的 WebUI token：先看配置，再读 napcat 自己的 webui.json（两种目录布局都认） */
  function readNapcatWebuiToken() {
    return readNapcatSettings(root, config).token;
  }

  /** 真正用来打开浏览器的地址（带 token，自动登录） */
  function napcatWebuiLaunchUrl() {
    return withWebuiToken(napcatWebUi, readNapcatWebuiToken());
  }

  const safeLog = {
    debug: (...a) => log?.debug?.(...a),
    info: (...a) => log?.info?.(...a),
    warn: (...a) => log?.warn?.(...a),
    error: (...a) => log?.error?.(...a),
  };

  const journalNapcatHealth = createNapcatHealthJournal({ logDir });
  const healthProbe = napcatHealth ?? createNapcatHealth({
    root, config,
    onResult(health) {
      try { journalNapcatHealth(health); }
      catch { safeLog.warn?.('NapCat 状态记录写入失败'); }
    },
  });
  let healthTimer = null;
  let healthEnabled = false;
  let healthSampling = null;

  const updates = updateManager ?? createUpdateManager({
    projectRoot: root,
    stateDir,
    configFile: configPath,
    log: safeLog,
  });
  const updateToken = randomBytes(32).toString('hex');
  // Only the bridge starts the scheduler; this instance edits configuration and queues work.
  const platforms = platformControl ?? createPlatformScheduler({ configPath, stateDir, log: safeLog });
  const automationToken = randomBytes(32).toString('hex');
  const imagegen = createImagegenApi({ configPath, configRoot: root, config, readBody, ok, fail, log: safeLog });
  const qrLogin = platformQrLogin ?? createBilibiliQrLogin({
    saveCookies: (cookies, options) => platforms.importLoginCookies(cookies, options),
  });

  let server = null;
  let actualPort = 0;
  let startedAt = 0;
  let stopping = false;

  // 记忆模块是另一个子代理在写，这里懒加载并兜底，绝不让服务起不来。
  const memoryState = { promise: null, instance: null, failedAt: 0 };

  function memoryModule() {
    if (memoryState.instance) return Promise.resolve(memoryState.instance);
    if (Date.now() - memoryState.failedAt < 10_000) return Promise.resolve(null);
    if (memoryState.promise) return memoryState.promise;
    memoryState.promise = (async () => {
      try {
        const mod = await import(new URL('../memory.js', import.meta.url).href);
        const Ctor = mod?.ObsidianMemory;
        if (typeof Ctor !== 'function') throw new Error('未导出 ObsidianMemory');
        const instance = new Ctor({
          root: memoryRootDir(),
          log: safeLog,
          maxSearchResults: 8,
          injectMaxChars: 1200,
          dailySoftLimit: 400,
        });
        if (typeof instance.ensure === 'function') await instance.ensure();
        memoryState.instance = instance;
        return instance;
      } catch (err) {
        memoryState.failedAt = Date.now();
        safeLog.debug('记忆模块暂不可用：', err?.message ?? err);
        return null;
      } finally {
        memoryState.promise = null;
      }
    })();
    return memoryState.promise;
  }

  const MEMORY_NOT_READY = '记忆模块未就绪';

  // ---------------------------------------------------------------- 数据采集

  let procCache = { at: 0, snapshot: { names: new Set() } };
  let procPromise = null;

  async function processSnapshot() {
    if (Date.now() - procCache.at < 6000) return procCache.snapshot;
    if (procPromise) return procPromise;
    procPromise = (async () => {
      const snapshot = { names: new Set() };
      try {
        if (process.platform === 'win32' && fs.existsSync(libPath)) {
          const script = [
            '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
            `. ${psQuote(libPath)}`,
            '$napcat = Get-NapCatProcess',
            '$bridge = Get-BridgeProcess',
            '@{ names = @(Get-Process | Select-Object -ExpandProperty ProcessName); napcatRunning = [bool]$napcat.Running; napcatPid = $napcat.ProcessId; bridgeRunning = [bool]$bridge.Running; bridgePid = $bridge.ProcessId } | ConvertTo-Json -Compress',
          ].join('\n');
          const { stdout } = await runProcess(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')], { timeoutMs: 5000 });
          const parsed = JSON.parse(stdout.trim());
          for (const name of parsed.names || []) snapshot.names.add(`${String(name).toLowerCase()}.exe`);
          snapshot.napcatRunning = parsed.napcatRunning === true;
          snapshot.napcatPid = Number(parsed.napcatPid) || 0;
          snapshot.bridgeRunning = parsed.bridgeRunning === true;
          snapshot.bridgePid = Number(parsed.bridgePid) || 0;
        } else {
          const { stdout } = await runProcess('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 5000 });
          for (const line of stdout.split(/\r?\n/)) {
            const m = /^"([^"]+)"/.exec(line.trim());
            if (m) snapshot.names.add(m[1].toLowerCase());
          }
        }
      } catch {
        /* 取不到就当空集合 */
      }
      procCache = { at: Date.now(), snapshot };
      procPromise = null;
      return snapshot;
    })();
    return procPromise;
  }

  async function sampleNapcatHealth() {
    if (healthSampling) return healthSampling;
    healthSampling = (async () => {
      const snapshot = await processSnapshot();
      if (!healthEnabled) return { state: 'unknown', loggedIn: false, known: false, reachable: false, detail: 'QQ 登录状态待确认' };
      return healthProbe.check({ running: snapshot.napcatRunning });
    })().finally(() => { healthSampling = null; });
    return healthSampling;
  }

  async function countTodayMessages() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const min = midnight.getTime();
    let count = 0;
    let files = [];
    try {
      files = (await fsp.readdir(groupMemDir)).filter((n) => n.endsWith('.jsonl')).slice(0, 80);
    } catch {
      return 0;
    }
    for (const name of files) {
      let raw;
      try {
        raw = await fsp.readFile(path.join(groupMemDir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const rec = JSON.parse(line);
          if (Number(rec?.ts) >= min) count += 1;
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    return count;
  }

  async function memoryResult(fn) {
    const instance = await memoryModule();
    if (!instance || typeof instance[fn] !== 'function') return { ok: false, error: MEMORY_NOT_READY };
    try {
      const value = await instance[fn]();
      return { ok: true, data: value };
    } catch (err) {
      return { ok: false, error: `记忆模块出错：${err?.message ?? err}` };
    }
  }

  async function buildOverview() {
    const status = await readJson(statusFile);
    const bridgePid = Number(status?.pid) || 0;
    const statusAge = Date.now() - Date.parse(status?.updatedAt);
    const statusFresh = Number.isFinite(statusAge) && statusAge >= -5000 && statusAge < 20_000;
    const [portOpen, snapshot, todayMessages, memStats, health] = await Promise.all([
      probeTcp(onebotPort),
      processSnapshot(),
      countTodayMessages(),
      memoryResult('stats'),
      sampleNapcatHealth(),
    ]);

    const { names } = snapshot;
    const bridgeAlive = snapshot.bridgeRunning === undefined
      ? (isPidAlive(bridgePid) && statusFresh)
      : snapshot.bridgeRunning;
    const bridgeConnected = Boolean(bridgeAlive && statusFresh && status?.connected === true
      && (snapshot.bridgePid === undefined || snapshot.bridgePid === bridgePid));
    const napcatRunning = Boolean(snapshot.napcatRunning || health.reachable);
    // DSH 有两种运行形态：Windows 桌面端常驻进程，或容器里的按需 headless 运行时。
    // 后者本来就不会常驻，不能按进程名判断，否则永远显示“未运行”。
    const dshRuntime = inspectDshRuntime(config?.dsh?.command || 'dsh', root);
    const desktopDsh = names.has('deepseek harness.exe') || names.has('deepseek harness');
    const dshRunning = desktopDsh || dshRuntime.ready;

    return {
      now: new Date().toISOString(),
      uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
      version: readPackageVersion(),
      ports: { webui: actualPort, onebot: onebotPort, napcatWebui: napcatWebUi, napcatWebuiToken: Boolean(readNapcatWebuiToken()) },
      napcat: {
        ...health,
        running: napcatRunning,
        processRunning: snapshot.napcatRunning ?? null,
        pid: snapshot.napcatPid || 0,
        portOpen,
        port: onebotPort,
        webui: napcatWebUi,
        qqRunning: names.has('qq.exe'),
      },
      bridge: {
        running: bridgeAlive,
        pid: snapshot.bridgePid ?? bridgePid,
        connected: bridgeConnected,
        statusFresh,
        startedAt: status?.startedAt ?? null,
        updatedAt: status?.updatedAt ?? null,
        sessions: Number(status?.sessions) || 0,
        inFlight: Number(status?.inFlight) || 0,
        queueDepth: Number(status?.queueDepth) || 0,
        lastMessageAt: status?.lastMessageAt ?? null,
        lastDrop: status?.lastDrop ? redactSecrets(status.lastDrop) : null,
        lastDropAt: status?.lastDropAt ?? null,
        lastError: status?.lastError ? redactSecrets(status.lastError) : null,
      },
      dsh: {
        running: dshRunning,
        processName: dshRuntime.command,
        kind: dshRuntime.mode,
        ready: dshRuntime.ready,
        version: dshRuntime.version || '',
        detail: dshRuntime.detail || '',
        controlsAvailable: process.platform === 'win32' && fs.existsSync(libPath),
      },
      model: { label: text(status?.model) || null, mode: text(status?.modelMode) || 'follow' },
      memory: memStats,
      today: { messages: todayMessages },
      runtime: {
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryRoot: memoryRootDir(),
        configPath,
      },
    };
  }

  function readPackageVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return text(pkg.version) || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  // ------------------------------------------------------------ 各端点实现

  async function getLogs(url, res) {
    const name = text(url.searchParams.get('name') || 'napcat').trim();
    if (name !== 'napcat' && name !== 'bridge') return fail(res, 400, 'name 只能是 napcat 或 bridge');
    const linesRaw = Number(url.searchParams.get('lines'));
    const lines = Number.isFinite(linesRaw) ? Math.min(1000, Math.max(1, Math.floor(linesRaw))) : 200;
    const file = path.join(logDir, name === 'napcat' ? 'napcat-console.log' : 'bridge-console.log');
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return ok(res, { name, file, lines: [], bytes: 0, updatedAt: null, missing: true });
    }
    if (!st.isFile()) return fail(res, 400, '日志路径不是文件');

    const from = Math.max(0, st.size - LOG_TAIL_BYTES);
    let chunk = '';
    let fh = null;
    try {
      fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(st.size - from);
      await fh.read(buf, 0, buf.length, from);
      chunk = buf.toString('utf8');
    } catch (err) {
      return fail(res, 500, `读取日志失败：${err?.message ?? err}`);
    } finally {
      await fh?.close().catch(() => {});
    }
    if (from > 0) {
      const idx = chunk.indexOf('\n');
      if (idx >= 0) chunk = chunk.slice(idx + 1);
    }
    const all = chunk.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    const tail = all.slice(-lines).map((line) => redactSecrets(line));
    return ok(res, {
      name,
      file,
      lines: tail,
      total: all.length,
      bytes: st.size,
      truncated: from > 0,
      updatedAt: st.mtime.toISOString(),
    });
  }

  async function getMemoryStats(res) {
    const result = await memoryResult('stats');
    if (!result.ok) return sendJson(res, 200, result);
    return ok(res, result.data);
  }

  async function searchMemory(url, res) {
    const q = text(url.searchParams.get('q')).trim();
    if (q === '') return fail(res, 400, '缺少搜索关键词 q');
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 8;
    const instance = await memoryModule();
    if (!instance || typeof instance.search !== 'function') {
      return sendJson(res, 200, { ok: false, error: MEMORY_NOT_READY });
    }
    try {
      const raw = await instance.search(q, { limit });
      const items = (Array.isArray(raw) ? raw : []).slice(0, limit).map((item) => ({
        path: text(item?.path),
        title: text(item?.title) || path.basename(text(item?.path), '.md'),
        score: Number(item?.score) || 0,
        snippet: redactSecrets(item?.snippet ?? ''),
      }));
      return ok(res, { query: q, limit, items, count: items.length });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: `记忆检索失败：${err?.message ?? err}` });
    }
  }

  async function getNote(url, res) {
    const checked = resolveNotePath(memoryRootDir(), url.searchParams.get('path'));
    if (!checked.ok) return fail(res, 403, checked.reason);
    if (!/\.(md|markdown|txt)$/i.test(checked.abs)) return fail(res, 400, '只允许读取 .md / .markdown / .txt');
    let st;
    try {
      st = await fsp.stat(checked.abs);
    } catch {
      return fail(res, 404, `笔记不存在：${checked.rel}`);
    }
    if (!st.isFile()) return fail(res, 400, '目标不是文件');
    if (st.size > 2 * 1024 * 1024) return fail(res, 413, '笔记过大（超过 2MB）');
    try {
      const body = await fsp.readFile(checked.abs, 'utf8');
      return ok(res, {
        path: checked.rel,
        title: guessTitle(body, checked.rel),
        body,
        size: st.size,
        updatedAt: st.mtime.toISOString(),
      });
    } catch (err) {
      return fail(res, 500, `读取失败：${err?.message ?? err}`);
    }
  }

  async function putNote(req, res) {
    const body = await readJsonBody(req);
    const checked = resolveNotePath(memoryRootDir(), body.path);
    if (!checked.ok) return fail(res, 403, checked.reason);
    if (!/\.(md|markdown)$/i.test(checked.abs)) return fail(res, 400, '只允许写入 .md / .markdown');
    const content = text(body.body);
    if (content.length > 2 * 1024 * 1024) return fail(res, 413, '正文过长（超过 2MB）');
    try {
      await fsp.mkdir(path.dirname(checked.abs), { recursive: true });
      await writeAtomic(checked.abs, content);
      const st = await fsp.stat(checked.abs);
      return ok(res, { path: checked.rel, bytes: st.size, updatedAt: st.mtime.toISOString() });
    } catch (err) {
      return fail(res, 500, `保存失败：${err?.message ?? err}`);
    }
  }

  // -------------------------------------------------- 记忆反思（一键 + 每天定时）
  // 真正的实现在 src/reflect.js：桥接和控制台是两个进程，靠 state/reflect.lock
  // 互斥、靠 state/reflect-state.json 互相汇报。这里只做「看一眼」和「点一下」。

  /** 控制台里正在跑的那次（只在本进程内有效；桥接那边跑的从状态文件看） */
  let reflectRun = null;

  async function reflectSnapshot() {
    const settings = normalizeReflectSettings(config?.memory ?? {});
    const rootDir = memoryRootDir();
    const file = reflectionPath(rootDir);
    const state = await readReflectState(stateDir);
    const locked = await isReflectLocked(stateDir);
    const holder = locked ? await readReflectLock(stateDir) : null;

    let paper = { exists: false, bytes: 0, updatedAt: null };
    if (file) {
      try {
        const st = await fsp.stat(file);
        paper = { exists: true, bytes: st.size, updatedAt: st.mtime.toISOString() };
      } catch {
        /* 本周还没写过反思，正常 */
      }
    }

    const live = reflectRun && !reflectRun.finished ? reflectRun : null;
    const next = settings.daily ? nextRunAt(settings.time) : null;
    return {
      settings,
      running: Boolean(live) || locked,
      runningTrigger: live?.trigger ?? holder?.holder ?? state.runningTrigger ?? null,
      startedAt: live?.startedAt ?? state.runningSince ?? null,
      lines: live ? live.lines.slice(-80) : Array.isArray(state.lastLines) ? state.lastLines.slice(-40) : [],
      lastRunAt: state.lastRunAt ?? null,
      lastOk: typeof state.lastOk === 'boolean' ? state.lastOk : null,
      lastTrigger: state.lastTrigger ?? null,
      lastMessage: state.lastMessage ?? '',
      lastBackup: state.lastBackup ?? null,
      nextAt: next ? next.toISOString() : null,
      memoryRoot: rootDir,
      reflection: {
        name: file ? path.basename(file) : '',
        path: file,
        week: file ? path.basename(file, '.md').replace(/^反思\s*/, '') : '',
        exists: paper.exists,
        bytes: paper.bytes,
        updatedAt: paper.updatedAt,
      },
      backups: await countBackups(file),
    };
  }

  async function getReflect(res) {
    try {
      return ok(res, await reflectSnapshot());
    } catch (err) {
      return fail(res, 500, `读取反思状态失败：${err?.message ?? err}`);
    }
  }

  async function postReflectRun(req, res) {
    const body = await readJsonBody(req).catch(() => ({}));
    if (reflectRun && !reflectRun.finished) return fail(res, 409, '正在反思中，等这一轮跑完再点');
    if (await isReflectLocked(stateDir)) {
      const holder = await readReflectLock(stateDir);
      const who = holder?.holder === 'daily' ? '桥接里的定时任务' : '另一个窗口';
      return fail(res, 409, `正在反思中（${who}），等它跑完再点`);
    }

    const settings = normalizeReflectSettings(config?.memory ?? {});
    // 手动点按钮 = 明确要重跑本周：默认 --force，并且覆盖前备份
    const force = body?.force === undefined ? true : Boolean(body.force);
    const days = Number(body?.days) || settings.days;

    const run = {
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      lines: [],
      finished: false,
      result: null,
    };
    reflectRun = run;

    run.promise = runReflect({
      stateDir,
      projectRoot: PROJECT_ROOT,
      memoryRoot: memoryRootDir(),
      trigger: 'manual',
      force,
      days,
      backup: settings.backup,
      onLine: (line) => {
        run.lines.push(line);
        if (run.lines.length > 200) run.lines.shift();
      },
      log: safeLog,
    })
      .then((result) => {
        run.result = result;
        return result;
      })
      .catch((err) => {
        run.result = { ok: false, message: String(err?.message ?? err) };
        safeLog.warn?.('手动反思失败：', err?.message ?? err);
        return run.result;
      })
      .finally(() => {
        run.finished = true;
        // 留 30 秒给前端把最后几行读走，然后清掉
        const timer = setTimeout(() => {
          if (reflectRun === run) reflectRun = null;
        }, 30000);
        timer.unref?.();
      });

    safeLog.info?.(`手动触发一次记忆反思（${force ? '--force' : '跳过已存在'} · ${days} 天）`);
    return ok(res, { started: true, startedAt: run.startedAt, force, days });
  }

  // ------------------------------------------------------------ 表情包库
  // 采集是桥接那边干的；控制台只负责「看一眼、改标签、重建索引、搬家」。
  // 目录每次现算 —— 用户可能刚在设置里改了 stickers.root，或者刚搬完家。

  const stickerSettings = () => normalizeStickerSettings(config?.stickers ?? {});
  const stickerDir = () => stickerRootDir({ configRoot: root, config });

  async function stickerSnapshot(params) {
    const settings = stickerSettings();
    const dir = stickerDir();
    const index = await ensureIndex(dir, { settings });
    const stats = storeStats(index);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(params?.get('limit')) || 60)));
    const offset = Math.max(0, Math.trunc(Number(params?.get('offset')) || 0));
    const page = listStickers(index, {
      tag: params?.get('tag') ?? '',
      query: params?.get('q') ?? params?.get('query') ?? '',
      limit,
      offset,
    });
    return {
      settings,
      root: dir,
      rootExists: fs.existsSync(dir),
      indexFile: path.join(dir, 'index.json'),
      count: stats.count,
      bytes: stats.bytes,
      animated: stats.animated,
      staticCount: stats.staticCount,
      tags: stats.tags,
      lastAt: stats.lastAt,
      total: page.total,
      offset,
      limit,
      items: page.items.map((item) => ({
        id: item.id,
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        animated: item.animated,
        mime: item.mime,
        firstAt: item.firstAt,
        lastAt: item.lastAt,
        seen: item.seen,
        tags: item.tags,
        source: item.source,
        text: item.text,
        summary: item.summary,
        file: item.file,
        url: `/api/stickers/file?id=${encodeURIComponent(item.id)}`,
      })),
    };
  }

  async function getStickers(res, url) {
    try {
      return ok(res, await stickerSnapshot(url.searchParams));
    } catch (err) {
      return fail(res, 500, `读表情包库失败：${err?.message ?? err}`);
    }
  }

  async function getStickerFile(res, url) {
    const id = url.searchParams.get('id') ?? '';
    const dir = stickerDir();
    try {
      const index = await loadIndex(dir);
      const item = index.items.find((entry) => entry.id === id);
      if (!item) return fail(res, 404, '库里没有这张表情');
      const abs = resolveStickerFile(dir, item.file);
      const buf = await fsp.readFile(abs);
      return sendBuffer(res, 200, buf, item.mime || 'application/octet-stream', {
        'Cache-Control': 'private, max-age=60',
        ETag: `"${item.id}"`,
      });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return fail(res, 404, '图片文件不在了（点「重建索引」可以清掉这类记录）');
      }
      // 索引里的路径被手改坏了：这是请求的问题，不是服务端的锅
      if (/越界|只能读图片|缺少文件路径/.test(String(err?.message ?? ''))) {
        return fail(res, 400, `这张的路径不合法：${err.message}`);
      }
      return fail(res, 500, `读图片失败：${err?.message ?? err}`);
    }
  }

  async function postStickerRebuild(req, res) {
    try {
      const result = await rebuildIndex(stickerDir(), { settings: stickerSettings() });
      safeLog.info?.(
        `表情包索引已重建：扫到 ${result.scanned} 个文件，保留 ${result.kept} 张、新收 ${result.added} 张`,
      );
      return ok(res, {
        scanned: result.scanned,
        kept: result.kept,
        added: result.added,
        dropped: result.dropped,
        root: stickerDir(),
        stats: {
          count: result.stats.count,
          bytes: result.stats.bytes,
          animated: result.stats.animated,
          tags: result.stats.tags.length,
        },
      });
    } catch (err) {
      return fail(res, 500, `重建索引失败：${err?.message ?? err}`);
    }
  }

  async function postStickerTag(req, res) {
    const body = await readJsonBody(req);
    const id = text(body.id).trim();
    if (!id) return fail(res, 400, '要给哪一张改标签？缺少 id');
    const add = Array.isArray(body.add) ? body.add : [];
    const remove = Array.isArray(body.remove) ? body.remove : [];
    if (add.length === 0 && remove.length === 0) return fail(res, 400, '至少要给一个 add 或 remove');
    try {
      const item = await updateTags(stickerDir(), id, { add, remove });
      return ok(res, { item });
    } catch (err) {
      if (err?.code === 'STICKER_NOT_FOUND') return fail(res, 404, err.message);
      return fail(res, 500, `改标签失败：${err?.message ?? err}`);
    }
  }

  async function postStickerDelete(req, res) {
    const body = await readJsonBody(req);
    const id = text(body.id).trim();
    if (!id) return fail(res, 400, '要删哪一张？缺少 id');
    try {
      const result = await deleteSticker(stickerDir(), id);
      safeLog.info?.(`从表情包库删掉一张：${result.item.id}`);
      return ok(res, { deleted: true, id: result.item.id, removedFile: result.removedFile });
    } catch (err) {
      if (err?.code === 'STICKER_NOT_FOUND') return fail(res, 404, err.message);
      return fail(res, 500, `删除失败：${err?.message ?? err}`);
    }
  }

  /** 搬家后 30 秒补一次：桥接最多 15 秒才切到新目录，这期间写进旧目录的图不能丢 */
  function scheduleStickerCatchUp(from, to) {
    const timer = setTimeout(async () => {
      try {
        if (!fs.existsSync(from)) return;
        const { scanImageFiles } = await import('../stickers.js');
        const files = await scanImageFiles(from);
        let copied = 0;
        for (const rel of files) {
          const src = path.join(from, rel);
          const dest = path.join(to, rel);
          try {
            const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dest).catch(() => null)]);
            if (b && b.size === a.size) continue;
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.copyFile(src, dest);
            copied += 1;
          } catch {
            /* 单张失败不影响其它 */
          }
        }
        if (copied > 0) safeLog.info?.(`表情包搬家补漏：又搬过去 ${copied} 张`);
      } catch (err) {
        safeLog.warn?.('表情包搬家补漏失败：', err?.message ?? err);
      }
    }, 30_000);
    timer.unref?.();
    return timer;
  }

  async function postStickerMigrate(req, res) {
    const body = await readJsonBody(req);
    const raw = text(body.to).trim();
    if (!raw) return fail(res, 400, '要搬到哪个目录？缺少 to');
    const from = stickerDir();
    const to = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(root, expandPath(raw) || raw);
    if (to === from) return fail(res, 400, '目标就是当前目录，不用搬');

    try {
      const result = await migrateStore({ fromRoot: from, toRoot: to });
      // 配置一起改掉：桥接 15 秒内热更新，控制台下一次请求就是新目录
      let disk;
      try {
        disk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
        disk.stickers = { ...(disk.stickers ?? {}), root: to };
        await writeAtomic(configPath, `${JSON.stringify(disk, null, 2)}\n`);
        config.stickers = { ...(config.stickers ?? {}), root: to };
      } catch (err) {
        return fail(
          res,
          500,
          `图片已经搬到 ${to}，但改写配置失败（${err?.message ?? err}）：请到「设置」里把表情包目录手动改成这个路径`,
        );
      }
      scheduleStickerCatchUp(from, to);
      safeLog.info?.(`表情包库已搬到 ${to}（${result.copied} 张）`);
      return ok(res, {
        from: result.from,
        to: result.to,
        copied: result.copied,
        bytes: result.bytes,
        items: result.items,
        oldDir: from,
        note: `桥接 15 秒内自动切到新目录，旧目录（${from}）我没删，你确认没问题再自己删`,
      });
    } catch (err) {
      return fail(res, 500, `搬家失败：${err?.message ?? err}`);
    }
  }

  async function getPersona(res, url) {
    const dir = personaDirPath();
    let state = { active: '', chats: {} };
    try {
      state = await readState(dir);
    } catch {
      /* 读不到就按单文件模式处理 */
    }
    const wanted = text(url?.searchParams?.get('name')) || state.active || '';
    if (wanted) {
      try {
        const item = await readPersona(dir, wanted);
        return ok(res, {
          name: item.name,
          path: item.file,
          body: item.body,
          size: item.size,
          updatedAt: item.updatedAt,
          active: state.active === item.name,
          mode: 'library',
        });
      } catch (err) {
        if (err?.code === 'PERSONA_NOT_FOUND') return fail(res, 404, `人格不存在：${wanted}`);
        return fail(res, 500, `读人格失败：${err?.message ?? err}`);
      }
    }
    try {
      const st = await fsp.stat(personaFilePath());
      const body = await fsp.readFile(personaFilePath(), 'utf8');
      return ok(res, { name: '', path: personaFilePath(), body, size: st.size, updatedAt: st.mtime.toISOString(), mode: 'single' });
    } catch {
      return ok(res, { name: '', path: personaFilePath(), body: '', size: 0, updatedAt: null, missing: true, mode: 'single' });
    }
  }

  async function putPersona(req, res) {
    const body = await readJsonBody(req);
    if (typeof body.body !== 'string') return fail(res, 400, 'body 必须是字符串');
    if (body.body.length > 2 * 1024 * 1024) return fail(res, 413, '人格文件过长（超过 2MB）');
    const dir = personaDirPath();
    let state = { active: '', chats: {} };
    try {
      state = await readState(dir);
    } catch {
      /* 忽略，按单文件模式 */
    }
    const targetName = text(body.name) || state.active || '';
    try {
      if (targetName) {
        const backup = await backupPersonaBody(targetName, await readPersona(dir, targetName).then((r) => r.body).catch(() => ''));
        const meta = await writePersona(dir, targetName, body.body);
        safeLog.info?.(`人格「${meta.name}」已保存（备份：${backup ?? '无'}）`);
        return ok(res, { name: meta.name, path: meta.file, bytes: meta.size, updatedAt: meta.updatedAt, backup });
      }
      await fsp.mkdir(path.dirname(personaFilePath()), { recursive: true });
      let backup = null;
      try {
        const current = await fsp.readFile(personaFilePath(), 'utf8');
        backup = await backupPersonaBody('AGENTS', current);
      } catch {
        /* 原本没有人格文件就不备份 */
      }
      await writeAtomic(personaFilePath(), body.body);
      const st = await fsp.stat(personaFilePath());
      safeLog.info?.(`人格文件已保存（备份：${backup ?? '无'}）`);
      return ok(res, { name: '', path: personaFilePath(), bytes: st.size, updatedAt: st.mtime.toISOString(), backup });
    } catch (err) {
      if (err?.code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      if (err?.code === 'PERSONA_BAD_BODY') return fail(res, 413, err.message);
      return fail(res, 500, `保存人格失败：${err?.message ?? err}`);
    }
  }

  // ------------------------------------------------------ 多套人格（人格库）

  const personaDirPath = () => personaDir({ configRoot: root, config });

  /** 备份旧内容到 state/persona-backup/，返回相对路径（没有旧内容返回 null） */
  async function backupPersonaBody(name, body) {
    if (typeof body !== 'string' || !body) return null;
    try {
      await fsp.mkdir(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${name || 'persona'}-${stamp()}.md`);
      await fsp.writeFile(backupPath, body, 'utf8');
      return path.relative(root, backupPath).split(path.sep).join('/');
    } catch {
      return null;
    }
  }

  async function getPersonas(res) {
    try {
      const dir = personaDirPath();
      const state = await readState(dir);
      const items = await listPersonas(dir);
      const activeName = state.active || text(config?.persona?.active);
      const resolution = resolvePersonaFor({ configRoot: root, config, dir, state });
      return ok(res, {
        dir,
        active: activeName,
        chats: state.chats,
        path: personaFilePath(),
        mode: items.length ? 'library' : 'single',
        resolution,
        items: items.map((item) => ({ ...item, active: item.name === activeName })),
      });
    } catch (err) {
      return fail(res, 500, `读人格库失败：${err?.message ?? err}`);
    }
  }

  async function postPersonaCreate(req, res) {
    const body = await readJsonBody(req);
    try {
      const meta = await createPersona(personaDirPath(), {
        name: body?.name ?? '',
        body: typeof body?.body === 'string' ? body.body : undefined,
      });
      safeLog.info?.(`新建人格：${meta.name}`);
      return ok(res, meta);
    } catch (err) {
      const code = err?.code;
      if (code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      if (code === 'PERSONA_EXISTS') return fail(res, 409, err.message);
      if (code === 'PERSONA_BAD_BODY') return fail(res, 413, err.message);
      return fail(res, 500, `新建人格失败：${err?.message ?? err}`);
    }
  }

  async function putPersonaActive(req, res) {
    const body = await readJsonBody(req);
    try {
      const state = await setActivePersona(personaDirPath(), body?.name ?? '');
      safeLog.info?.(`当前人格切换为：${state.active || '默认文件'}`);
      return ok(res, state);
    } catch (err) {
      if (err?.code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      if (err?.code === 'PERSONA_NOT_FOUND') return fail(res, 404, err.message);
      return fail(res, 500, `切换人格失败：${err?.message ?? err}`);
    }
  }

  async function putPersonaChat(req, res) {
    const body = await readJsonBody(req);
    try {
      const result = await setChatPersona(personaDirPath(), body?.chatKey, body?.name ?? '');
      safeLog.info?.(`会话人格：${result.chatKey} → ${result.name || '跟随全局'}`);
      return ok(res, result);
    } catch (err) {
      if (err?.code === 'PERSONA_BAD_CHAT' || err?.code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      if (err?.code === 'PERSONA_NOT_FOUND') return fail(res, 404, err.message);
      return fail(res, 500, `设置会话人格失败：${err?.message ?? err}`);
    }
  }

  async function deletePersonaHandler(req, res, url) {
    const name = url.searchParams.get('name') ?? '';
    try {
      const result = await deletePersona(personaDirPath(), name);
      safeLog.info?.(`删除人格：${result.name}`);
      return ok(res, result);
    } catch (err) {
      if (err?.code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      if (err?.code === 'PERSONA_NOT_FOUND') return fail(res, 404, err.message);
      return fail(res, 500, `删除人格失败：${err?.message ?? err}`);
    }
  }

  /** 把当前单文件人格导入人格库，并设为当前；库里已经有人格时只是补一份 */
  async function postPersonaSeed(req, res) {
    const body = await readJsonBody(req);
    try {
      const name = text(body?.name) || '默认人格';
      const result = await seedFromFile({ dir: personaDirPath(), fromFile: personaFilePath(), name });
      safeLog.info?.(`人格库导入：${result.name}`);
      return ok(res, result);
    } catch (err) {
      if (err?.code === 'PERSONA_BAD_NAME') return fail(res, 400, err.message);
      return fail(res, 500, `导入人格失败：${err?.message ?? err}`);
    }
  }

  async function getSessions(res) {
    const bridgeMap = (await readJson(sessionsFile)) ?? {};
    const chatMap = (await readJson(chatSessionsFile)) ?? {};
    const merged = new Map();

    const touch = (qq, sessionId, source) => {
      const key = text(qq);
      if (key === '') return;
      const item = merged.get(key) ?? { qq: key, sessionId: '', sources: [], kind: 'private' };
      const id = typeof sessionId === 'string' ? sessionId : sessionId?.sessionId;
      if (!item.sessionId && typeof id === 'string') item.sessionId = id;
      if (/^g:/.test(key)) item.kind = 'group';
      if (!item.sources.includes(source)) item.sources.push(source);
      merged.set(key, item);
    };

    if (bridgeMap && typeof bridgeMap === 'object' && !Array.isArray(bridgeMap)) {
      for (const [qq, sessionId] of Object.entries(bridgeMap)) touch(qq, sessionId, '桥接');
    }
    if (chatMap && typeof chatMap === 'object' && !Array.isArray(chatMap)) {
      for (const [key, sessionId] of Object.entries(chatMap)) {
        const m = /^(private|group)[:_](.+)$/.exec(key);
        if (m) {
          const item = merged.get(m[2]) ?? { qq: m[2], sessionId: '', sources: [], kind: m[1] };
          item.kind = m[1] === 'group' ? 'group' : 'private';
          if (!item.sessionId) item.sessionId = text(sessionId);
          if (!item.sources.includes('DSH')) item.sources.push('DSH');
          merged.set(m[2], item);
        } else {
          touch(key, sessionId, 'DSH');
        }
      }
    }

    const items = [...merged.values()].sort((a, b) => a.qq.localeCompare(b.qq));
    return ok(res, {
      items,
      counts: { total: items.length, private: items.filter((i) => i.kind === 'private').length },
      files: { bridge: sessionsFile, dsh: chatSessionsFile },
    });
  }

  /** 从某个 JSON 映射里删掉一个键，返回是否真的删了 */
  async function dropSessionKey(file, key) {
    const map = await readJson(file);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    const removed = [];
    if (Object.hasOwn(map, key)) {
      delete map[key];
      removed.push(key);
    }
    for (const existing of Object.keys(map)) {
      if (existing === key) continue;
      if (existing.endsWith(`:${key}`) || existing.endsWith(`_${key}`)) {
        delete map[existing];
        removed.push(existing);
      }
    }
    if (removed.length > 0) await writeAtomic(file, `${JSON.stringify(map, null, 2)}\n`);
    return removed;
  }

  async function deleteSession(rawKey, res) {
    const key = text(rawKey).trim();
    if (key === '' || key.length > 200) return fail(res, 400, '会话标识不合法');
    try {
      const a = await dropSessionKey(sessionsFile, key);
      const b = await dropSessionKey(chatSessionsFile, key);
      const removed = [...new Set([...a, ...b])];
      if (removed.length === 0) return fail(res, 404, `没有找到会话：${key}`);
      safeLog.info?.(`已清除会话映射：${key}`);
      return ok(res, { key, removed });
    } catch (err) {
      return fail(res, 500, `清除会话失败：${err?.message ?? err}`);
    }
  }

  function pickSettings(cfg) {
    const out = {};
    for (const [group, fields] of Object.entries(SETTINGS_SPEC)) {
      out[group] = {};
      for (const key of Object.keys(fields)) {
        const value = cfg?.[group]?.[key];
        out[group][key] = value === undefined
          ? group === 'behavior' && key === 'sessionWindowMinutes' ? DEFAULT_SESSION_WINDOW_MINUTES : null
          : value;
      }
    }
    out.jev.hasToken = Boolean(cfg?.jev?.token);
    delete out.jev.token;
    return out;
  }

  function coerce(type, value) {
    if (type === 'bool') return Boolean(value);
    if (type === 'probability') {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
    }
    if (type === 'sessionWindow') return isValidSessionWindowMinutes(value) ? value : null;
    if (type === 'int') {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    if (type === 'path') {
      const raw = text(value).trim().replace(/^\uFEFF/, '');
      if (!raw || raw.length > 500) return null;
      if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
      // 展开后会变成空的（比如只有 ~ 却取不到主目录）也拒掉
      if (!expandPath(raw)) return null;
      return raw;
    }
    if (type === 'policy') {
      const value2 = text(value).trim().toLowerCase();
      return value2 === 'blacklist' || value2 === 'allowlist' ? value2 : null;
    }
    if (type === 'time') {
      // 只收 HH:MM（控制台的时间输入框也只会给这个形状）
      const raw = text(value).trim();
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
      return m ? `${m[1]}:${m[2]}` : null;
    }
    if (type === 'qqIdArray') {
      if (!Array.isArray(value) || value.length > 1000) return null;
      const valid = value.every((id) =>
        (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
        (typeof id === 'string' && /^[1-9]\d*$/.test(id.trim())));
      return valid ? [...new Set(value.map((id) => String(id).trim()))] : null;
    }
    if (type === 'intArray') {
      if (!Array.isArray(value)) return null;
      const nums = value.map((v) => Number(String(v).trim())).filter((n) => Number.isFinite(n));
      return nums.map((n) => Math.trunc(n));
    }
    return text(value);
  }

  async function getSettings(res) {
    return ok(res, {
      ...pickSettings(config),
      path: configPath,
      editable: SETTINGS_SPEC,
    });
  }

  async function putSettings(req, res) {
    const body = await readJsonBody(req);
    if (Object.hasOwn(body?.jev ?? {}, 'baseUrl')) {
      const value = text(body.jev.baseUrl).trim();
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        if (value) return fail(res, 400, 'JEV Base URL 必须是没有内嵌凭据的 http 或 https 地址');
      }
    }
    if (Object.hasOwn(body?.jev ?? {}, 'token') && text(body.jev.token).length > 4096) {
      return fail(res, 400, 'JEV Token 长度不能超过 4096 个字符');
    }
    if (Object.hasOwn(body?.jev ?? {}, 'model') && text(body.jev.model).length > 200) {
      return fail(res, 400, 'JEV 模型名长度不能超过 200 个字符');
    }
    for (const [key, max] of [['timeoutMs', 60000], ['contextMessages', 100]]) {
      if (!Object.hasOwn(body?.jev ?? {}, key)) continue;
      const value = body.jev[key];
      if (!Number.isInteger(value) || value < 1 || value > max) {
        return fail(res, 400, `JEV ${key} 必须是 1–${max} 的整数`);
      }
    }
    if (Object.hasOwn(body?.security ?? {}, 'adminUserIds') &&
        coerce('qqIdArray', body.security.adminUserIds) === null) {
      return fail(res, 400, '电脑操作管理员必须是正整数 QQ 号数组');
    }
    if (Object.hasOwn(body?.stickers ?? {}, 'sendProbability') &&
        coerce('probability', body.stickers.sendProbability) === null) {
      return fail(res, 400, '表情发送概率必须是 0–1 之间的数字');
    }
    if (Object.hasOwn(body?.behavior ?? {}, 'sessionWindowMinutes') &&
        coerce('sessionWindow', body.behavior.sessionWindowMinutes) === null) {
      return fail(res, 400, '新建会话间隔必须是大于等于 0 的整数分钟，且换算为毫秒后不能超出安全整数范围');
    }
    let disk;
    try {
      disk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new Error('配置文件不是对象');
    } catch (err) {
      return fail(res, 500, `读取配置失败：${err?.message ?? err}`);
    }

    const applied = {};
    const updates = [];
    for (const [group, fields] of Object.entries(SETTINGS_SPEC)) {
      if (!body?.[group] || typeof body[group] !== 'object') continue;
      for (const [key, type] of Object.entries(fields)) {
        if (!Object.hasOwn(body[group], key)) continue;
        if (group === 'jev' && key === 'token' && text(body[group][key]).trim() === '') continue;
        const value = coerce(type, body[group][key]);
        if (value === null && type !== 'string') continue;
        disk[group] = disk[group] && typeof disk[group] === 'object' ? disk[group] : {};
        disk[group][key] = value;
        updates.push({ group, key, value });
        if (!(group === 'jev' && key === 'token')) applied[`${group}.${key}`] = value;
      }
    }

    if (updates.length === 0) return fail(res, 400, '没有可更新的字段');
    try {
      await writeAtomic(configPath, `${JSON.stringify(disk, null, 2)}\n`);
      for (const { group, key, value } of updates) {
        config[group] = config[group] && typeof config[group] === 'object' ? config[group] : {};
        config[group][key] = value;
      }
      safeLog.info?.(`配置已更新：${updates.map(({ group, key }) => `${group}.${key}`).join('、')}`);
      return ok(res, { applied, settings: pickSettings(config), path: configPath });
    } catch (err) {
      return fail(res, 500, `保存配置失败：${err?.message ?? err}`);
    }
  }

  // -------------------------------------------------- 路径（人格/记忆/工作区）
  // 三个路径都支持相对项目根、绝对路径、~ 和 %VAR%；这里返回「配置原值 + 解析结果 + 存在性」，
  // 前端据此即时提示，不需要用户自己猜解析规则。

  async function statPath(p) {
    try {
      const st = await fsp.stat(p);
      return {
        exists: true,
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        bytes: st.size,
        updatedAt: new Date(st.mtimeMs).toISOString(),
      };
    } catch {
      return { exists: false, isFile: false, isDir: false, bytes: 0, updatedAt: null };
    }
  }

  async function pathsSnapshot() {
    const persona = personaFilePath();
    const memory = memoryRootDir();
    const workspace = workspaceDir();
    return {
      configPath,
      requiresBridgeRestart: true,
      persona: {
        raw: text(config?.persona?.path) || path.join('qq-workspace', 'AGENTS.md'),
        resolved: persona,
        enabled: config?.persona?.enabled !== false,
        ...(await statPath(persona)),
      },
      memory: {
        raw: text(config?.memory?.root),
        resolved: memory,
        enabled: config?.memory?.enabled !== false,
        ...(await statPath(memory)),
      },
      workspace: {
        raw: text(config?.dsh?.cwd),
        resolved: workspace,
        ...(await statPath(workspace)),
      },
    };
  }

  async function getPaths(res) {
    try {
      return ok(res, await pathsSnapshot());
    } catch (err) {
      return fail(res, 500, `读取路径失败：${err?.message ?? err}`);
    }
  }

  /** 前端边输入边校验用：不落盘，只告诉它解析后是什么、存不存在 */
  async function postPathCheck(req, res) {
    const body = await readJsonBody(req);
    const raw = text(body?.path).trim();
    if (!raw) return fail(res, 400, '缺少 path');
    if (raw.length > 500) return fail(res, 400, '路径太长（上限 500 字符）');
    if (/[\u0000-\u001f\u007f]/.test(raw)) return fail(res, 400, '路径里有控制字符');
    const expanded = expandPath(raw);
    if (!expanded) return fail(res, 400, '路径展开后为空');
    const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
    const kind = text(body?.kind) || 'any';
    try {
      const stat = await statPath(resolved);
      return ok(res, { raw, resolved, kind, ...stat });
    } catch (err) {
      return fail(res, 500, `检查路径失败：${err?.message ?? err}`);
    }
  }

  // -------------------------------------------------------- 插件
  // 控制台是独立进程，所以这里每次都重新读盘：插件源码 + config.json + state/plugins.json。
  // 改完开关/配置需要重启桥接才会生效（控制台会明确提示，而不是假装已生效）。

  const pluginDir = resolveFrom(root, config?.plugins?.dir ?? path.join('src', 'plugins'));

  function newPluginHost() {
    return new PluginHost({ dir: pluginDir, stateDir, config, log: safeLog });
  }

  async function pluginsSnapshot() {
    const host = newPluginHost();
    await host.load();
    return {
      dir: pluginDir,
      hooks: PLUGIN_HOOKS,
      schemaTypes: SCHEMA_TYPES,
      plugins: host.list().map((plugin) => {
        const values = { ...plugin.config };
        const secretFields = {};
        for (const field of plugin.configSchema) if (field.type === 'secret') {
          secretFields[field.key] = Boolean(values[field.key]?.trim());
          delete values[field.key];
        }
        return { ...plugin, config: values, secretFields };
      }),
      failures: host.failures,
      stateFile: host.stateFile,
      requiresBridgeRestart: true,
    };
  }

  async function getPlugins(res) {
    try {
      return ok(res, await pluginsSnapshot());
    } catch (err) {
      return fail(res, 500, `读取插件失败：${err?.message ?? err}`);
    }
  }

  async function putPlugin(req, res, name) {
    const body = await readJsonBody(req);
    const host = newPluginHost();
    await host.load();
    if (!host.registry.has(name)) return fail(res, 404, `没有这个插件：${name}`);

    const entry = host.registry.get(name);
    const applied = {};

    if (typeof body?.enabled === 'boolean') {
      try {
        applied.enabled = await host.setEnabled(name, body.enabled);
      } catch (err) {
        return fail(res, 500, `保存插件开关失败：${err?.message ?? err}`);
      }
    }

    if (body?.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
      const changed = {};
      for (const field of entry.meta.configSchema) {
        if (!Object.hasOwn(body.config, field.key)) continue;
        changed[field.key] = coerceValue(field.type, body.config[field.key], field.default);
        if (field.type === 'secret' && !validMediaKey(changed[field.key])) return fail(res, 400, '密钥格式无效，请重新输入；留空表示不鉴权');
      }
      if (Object.keys(changed).length > 0) {
        let disk;
        try {
          disk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
          if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new Error('配置文件不是对象');
        } catch (err) {
          return fail(res, 500, `读取配置失败：${err?.message ?? err}`);
        }
        disk.plugins = disk.plugins && typeof disk.plugins === 'object' ? disk.plugins : {};
        const previous = disk.plugins[name] ?? {};
        if ((Object.hasOwn(changed, 'provider') && changed.provider !== (previous.provider ?? entry.meta.configSchema.find((f) => f.key === 'provider')?.default)) ||
            (Object.hasOwn(changed, 'baseUrl') && changed.baseUrl.replace(/\/+$/, '') !== String(previous.baseUrl ?? '').replace(/\/+$/, ''))) {
          for (const field of entry.meta.configSchema) if (field.type === 'secret' && !Object.hasOwn(changed, field.key)) changed[field.key] = '';
        }
        disk.plugins[name] = { ...(disk.plugins[name] ?? {}), ...changed };
        if (name === 'reply-tts') {
          try {
            const checked = validateTtsConfig(disk.plugins[name]);
            if (checked.provider === 'edge' && checked.speechLanguage !== 'auto') {
              disk.plugins[name].voice = changed.voice = checked.voice;
            }
          }
          catch { return fail(res, 400, '请检查 TTS 平台、API 地址、模型、语种、音色、格式、翻译设置和密钥'); }
        }
        config.plugins = disk.plugins;
        try {
          await writeAtomic(configPath, `${JSON.stringify(disk, null, 2)}\n`);
        } catch (err) {
          return fail(res, 500, `保存插件配置失败：${err?.message ?? err}`);
        }
        applied.config = { ...changed };
        for (const field of entry.meta.configSchema) if (field.type === 'secret') delete applied.config[field.key];
      }
    }

    if (Object.keys(applied).length === 0) return fail(res, 400, '没有可更新的字段（enabled / config）');
    safeLog.info?.(`插件 ${name} 已更新：${Object.keys(applied).join('、')}`);
    try {
      return ok(res, { applied, snapshot: await pluginsSnapshot(), requiresBridgeRestart: true });
    } catch (err) {
      return fail(res, 500, `保存后重新读取失败：${err?.message ?? err}`);
    }
  }

  // -------------------------------------------------- 开机自启与本地资源

  /**
   * 托盘菜单精简后，原来菜单里的「开机自启」「记忆库」都搬到这里。
   * 快捷方式与 Launcher.ps1 的 Enable-Autostart 保持同一套参数，
   * 所以托盘和这里改的是同一个文件，互相能看见。
   */
  const STARTUP_DIR = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  const STARTUP_LNK = path.join(STARTUP_DIR, 'QQDshLauncher.lnk');
  const BOOTSTRAP_PS1 = path.join(root, 'launcher', 'bootstrap.ps1');
  const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  let psScriptSeq = 0;
  /** 跑一段 PowerShell：写成带 BOM 的临时 .ps1 再 -File 执行，避免 -Command 的引号地狱 */
  async function runPowerShell(script, { timeoutMs = 25000 } = {}) {
    const tmpDir = path.join(stateDir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `console-${process.pid}-${Date.now()}-${psScriptSeq++}.ps1`);
    const body = `$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\n${script.replace(/\r?\n/g, '\r\n')}\r\n`;
    // .ps1 必须带 BOM，否则 PowerShell 5.1 按 ANSI 读，中文直接碎掉
    await fsp.writeFile(file, `\uFEFF${body}`, 'utf8');
    try {
      const result = await runProcess(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { timeoutMs });
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || `PowerShell 退出码 ${result.code}`).trim();
        throw new Error(detail.slice(0, 400));
      }
      return result.stdout.trim();
    } finally {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  async function autostartSnapshot() {
    const script = [
      `$lnk = ${psQuote(STARTUP_LNK)}`,
      '$info = [ordered]@{ shortcutPath = $lnk; enabled = $false; targetPath = ""; arguments = "" }',
      'if (Test-Path -LiteralPath $lnk -PathType Leaf) {',
      '    $info.enabled = $true',
      '    try {',
      '        $shell = New-Object -ComObject WScript.Shell',
      '        $sc = $shell.CreateShortcut($lnk)',
      '        $info.targetPath = [string]$sc.TargetPath',
      '        $info.arguments = [string]$sc.Arguments',
      '    } catch { }',
      '}',
      '$info | ConvertTo-Json -Compress',
    ].join('\n');

    let parsed = {};
    try {
      parsed = JSON.parse(await runPowerShell(script));
    } catch (err) {
      safeLog.warn?.('读取开机自启状态失败：', err?.message ?? err);
      return {
        enabled: false,
        shortcutPath: STARTUP_LNK,
        targetPath: '',
        arguments: '',
        bootstrapPath: BOOTSTRAP_PS1,
        available: fs.existsSync(BOOTSTRAP_PS1),
        error: String(err?.message ?? err).slice(0, 300),
      };
    }
    return {
      enabled: parsed.enabled === true,
      shortcutPath: text(parsed.shortcutPath) || STARTUP_LNK,
      targetPath: text(parsed.targetPath),
      arguments: text(parsed.arguments),
      bootstrapPath: BOOTSTRAP_PS1,
      available: fs.existsSync(BOOTSTRAP_PS1),
    };
  }

  async function getAutostart(res) {
    return ok(res, await autostartSnapshot());
  }

  async function putAutostart(req, res) {
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') return fail(res, 400, 'enabled 必须是 true 或 false');

    const script = body.enabled
      ? [
          `$lnk = ${psQuote(STARTUP_LNK)}`,
          `$bootstrap = ${psQuote(BOOTSTRAP_PS1)}`,
          'if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw "找不到引导脚本：$bootstrap" }',
          `$ps = ${psQuote(PS_EXE)}`,
          '$shell = New-Object -ComObject WScript.Shell',
          '$sc = $shell.CreateShortcut($lnk)',
          '$sc.TargetPath = $ps',
          `$sc.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $bootstrap + '"'`,
          `$sc.WorkingDirectory = ${psQuote(root)}`,
          '$sc.WindowStyle = 7',
          '$sc.IconLocation = $ps + ",0"',
          "$sc.Description = 'QQ-DSH 一键启动（开机自启）'",
          '$sc.Save()',
        ].join('\n')
      : [`$lnk = ${psQuote(STARTUP_LNK)}`, 'if (Test-Path -LiteralPath $lnk -PathType Leaf) { Remove-Item -LiteralPath $lnk -Force }'].join(
          '\n',
        );

    try {
      await runPowerShell(script);
    } catch (err) {
      return fail(res, 500, `设置开机自启失败：${err?.message ?? err}`);
    }
    safeLog.info?.(`开机自启已${body.enabled ? '启用' : '关闭'}`);
    return ok(res, { applied: { enabled: body.enabled }, snapshot: await autostartSnapshot() });
  }

  /** 托盘里原来的「记忆库」菜单项，现在由控制台调这里 */
  async function postOpen(req, res) {
    const body = await readJsonBody(req);
    const target = text(body?.target);
    if (!target) return fail(res, 400, '缺少 target');

    if (target === 'memory' || target === 'memory-obsidian') {
      if (!fs.existsSync(memoryRootDir())) return fail(res, 404, `记忆库还不存在：${memoryRootDir()}`);
      if (target === 'memory') {
        try {
          await openPath(memoryRootDir());
        } catch (err) {
          return fail(res, 500, `打开文件夹失败：${err?.message ?? err}`);
        }
        return ok(res, { opened: 'memory', path: memoryRootDir() });
      }
      const indexFile = path.join(memoryRootDir(), '大肥鱼.md');
      if (!fs.existsSync(indexFile)) return fail(res, 404, `记忆库索引不存在：${indexFile}`);
      try {
        const url = `obsidian://open?path=${encodeURIComponent(indexFile)}`;
        await openUrl(url);
        return ok(res, { opened: 'memory-obsidian', path: indexFile });
      } catch (err) {
        return fail(res, 500, `调起 Obsidian 失败：${err?.message ?? err}`);
      }
    }

    if (target === 'reflection') {
      // 记忆页「打开反思文件」：能选中文件就选中，还没有就退到 50-反思 目录
      const file = reflectionPath(memoryRootDir());
      if (!file) return fail(res, 404, '记忆库根目录还没配置');
      if (fs.existsSync(file)) {
        try {
          await openPath(file, { select: true });
          return ok(res, { opened: 'reflection', path: file, selected: true });
        } catch (err) {
          return fail(res, 500, `打开反思文件失败：${err?.message ?? err}`);
        }
      }
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) return fail(res, 404, '还没有写过反思，点「立即反思」生成第一篇');
      try {
        await openPath(dir);
        return ok(res, { opened: 'reflection', path: dir, selected: false });
      } catch (err) {
        return fail(res, 500, `打开反思目录失败：${err?.message ?? err}`);
      }
    }

    if (target === 'stickers') {
      // 表情页「打开文件夹」：库在哪就在哪开，还没有就现建一个，别让按钮点了没反应
      const dir = stickerDir();
      try {
        await fsp.mkdir(dir, { recursive: true });
        await openPath(dir);
        return ok(res, { opened: 'stickers', path: dir });
      } catch (err) {
        return fail(res, 500, `打开表情包目录失败：${err?.message ?? err}`);
      }
    }

    if (target === 'napcat-webui') {
      try {
        // 用系统默认浏览器打开：控制台自己是 Edge --app 窗口，window.open 常被拦。
        // 地址带上 webui.json 里的 token，NapCat 的 /web_login 会用 ?token= 自动登录。
        const url = napcatWebuiLaunchUrl();
        const tokenAttached = url !== napcatWebUi;
        await openUrl(url);
        return ok(res, { opened: 'napcat-webui', path: maskTokenUrl(url), tokenAttached });
      } catch (err) {
        return fail(res, 500, `打开 NapCat WebUI 失败：${err?.message ?? err}`);
      }
    }

    if (target === 'workspace' || target === 'persona') {
      const dir = target === 'workspace' ? workspaceDir() : path.dirname(personaFilePath());
      if (!fs.existsSync(dir)) return fail(res, 404, `目录还不存在：${dir}`);
      try {
        await openPath(dir);
        return ok(res, { opened: target, path: dir });
      } catch (err) {
        return fail(res, 500, `打开文件夹失败：${err?.message ?? err}`);
      }
    }

    return fail(res, 400, `不认识的 target：${target}`);
  }

  // -------------------------------------------------------- 模型跟随

  async function modelSnapshot() {
    try {
      const snap = describeModelState({ stateDir, basePatchPath, command: config?.dsh?.command, cwd: root, log: safeLog });
      const catalog = config?.dsh?.companion === false ? null : await fetchCompanionModelCatalog(config);
      if (catalog) {
        for (const group of catalog.providers) {
          let provider = snap.providers.find((item) => item.id === group.id);
          if (!provider) { provider = { id: group.id, models: [] }; snap.providers.push(provider); }
          for (const model of group.models) {
            if (!provider.models.includes(model.id)) provider.models.push(model.id);
            const capability = { provider: group.id, model: model.id, reasoning: model.reasoning };
            const index = snap.modelCapabilities.findIndex((item) => item.provider === group.id && item.model === model.id);
            if (index < 0) snap.modelCapabilities.push(capability);
            else snap.modelCapabilities[index] = capability;
          }
        }
      }
      if (snap.effective) snap.validation = validateModelSelection(snap.effective, snap);
      const status = await readJson(statusFile);
      const applied = status?.modelApplied ?? null;
      const applicationError = status?.modelApplicationError
        ? { ...status.modelApplicationError, message: redactSecrets(status.modelApplicationError.message) } : null;
      const matches = (value) => value?.provider === snap.effective?.provider && value?.model === snap.effective?.model &&
        (!snap.effective?.reasoningEffort || value?.reasoningEffort === snap.effective.reasoningEffort);
      const relevantError = applicationError && matches(applicationError.requested) &&
        (!snap.updatedAt || applicationError.at >= snap.updatedAt);
      const application = snap.validation?.status === 'invalid' ? 'invalid'
        : relevantError ? 'error' : applied && matches(applied) ? 'applied' : 'pending';
      return { ...snap, efforts: REASONING_EFFORTS, catalogSource: catalog ? 'companion' : 'desktop-config',
        applied, applicationError: relevantError ? applicationError : null, application };
    } catch (err) {
      safeLog.warn?.('读取模型状态失败：', err?.message ?? err);
      return { error: `读取模型状态失败：${err?.message ?? err}` };
    }
  }

  async function getModel(res) {
    return ok(res, await modelSnapshot());
  }

  /** 校验一段「标识符类」字符串：非空、不太长、无控制字符 */
  function cleanId(value, label, max = 200) {
    const raw = text(value);
    if (!raw) throw new Error(`${label}不能为空`);
    if (raw.length > max) throw new Error(`${label}太长（最多 ${max} 个字符）`);
    if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error(`${label}含有控制字符`);
    return raw;
  }

  async function putModel(req, res) {
    const body = await readJsonBody(req);
    const mode = text(body?.mode).toLowerCase();
    if (!MODEL_MODES.includes(mode)) return fail(res, 400, `mode 只能是 ${MODEL_MODES.join(' / ')}`);

    const current = await modelSnapshot();
    // 切到「跟随」时可以不带 manual，沿用之前记住的手动值，方便来回来回切
    let manual = current.manual ?? null;
    if (body?.manual && typeof body.manual === 'object') {
      try {
        manual = {
          provider: cleanId(body.manual.provider, '供应商 id', 120),
          model: cleanId(body.manual.model, '模型 id', 200),
          ...(text(body.manual.reasoningEffort) ? { reasoningEffort: text(body.manual.reasoningEffort) } : {}),
        };
      } catch (err) {
        return fail(res, 400, err?.message ?? err);
      }
      if ((manual.reasoningEffort?.length ?? 0) > 40) return fail(res, 400, 'reasoningEffort 太长');
    }

    if (mode === 'manual' && !manual) {
      return fail(res, 400, '手动模式需要同时提供供应商与模型');
    }
    if (mode === 'manual') {
      const validation = validateModelSelection(manual, current);
      if (validation.status === 'invalid') return fail(res, 400, validation.message);
      manual = validation.selection;
    }

    try {
      await writeModelState(stateDir, { mode, manual });
    } catch (err) {
      return fail(res, 500, `保存模型设置失败：${err?.message ?? err}`);
    }

    safeLog.info?.(`模型设置已更新：${mode}${manual ? `（${manual.provider}/${manual.model}）` : ''}`);
    return ok(res, await modelSnapshot());
  }

  async function runServiceAction(name, action, res) {
    if (!SERVICE_NAMES.includes(name)) return fail(res, 404, `未知服务：${name}`);
    if (!SERVICE_ACTIONS.includes(action)) return fail(res, 400, `未知操作：${action}`);

    const id = `svc-${stamp()}-${randomUUID().slice(0, 8)}`;
    const ps1Path = path.join(webuiTmpDir, `${id}.ps1`);
    const resultPath = path.join(webuiTmpDir, `${id}.json`);
    let stdout = '';
    let stderr = '';
    try {
      await fsp.mkdir(webuiTmpDir, { recursive: true });
      const script = buildServiceScript({ name, action, resultPath, libPath });
      await fsp.writeFile(ps1Path, Buffer.concat([UTF8_BOM, Buffer.from(script, 'utf8')]));
      const run = await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
        { timeoutMs: ACTION_TIMEOUT_MS, cwd: root },
      );
      stdout = run.stdout;
      stderr = run.stderr;
    } catch (err) {
      await fsp.rm(ps1Path, { force: true }).catch(() => {});
      const message =
        err?.code === 'ETIMEDOUT' ? `操作超时（>${ACTION_TIMEOUT_MS / 1000} 秒）` : `执行失败：${err?.message ?? err}`;
      safeLog.warn?.(`${SERVICE_LABEL[name]} ${action}：${message}`);
      return sendJson(res, 500, { ok: false, error: message, output: redactSecrets(stderr || stdout) });
    }

    const result = await readJson(resultPath);
    await fsp.rm(ps1Path, { force: true }).catch(() => {});
    await fsp.rm(resultPath, { force: true }).catch(() => {});

    const output = redactSecrets([stdout, stderr].filter(Boolean).join('\n')).slice(0, 20000);
    if (!result) {
      return sendJson(res, 500, {
        ok: false,
        error: `${SERVICE_LABEL[name]} ${action} 未返回结果`,
        output,
      });
    }
    if (result.ok) {
      safeLog.info?.(`${SERVICE_LABEL[name]}：${result.message}`);
      return sendJson(res, 200, {
        ok: true,
        data: { name, action, message: redactSecrets(result.message) },
        output,
      });
    }
    return sendJson(res, 500, {
      ok: false,
      error: redactSecrets(result.message) || `${SERVICE_LABEL[name]} 操作失败`,
      output,
    });
  }

  // ------------------------------------------------------------ 静态资源

  async function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendBuffer(res, 400, Buffer.from('路径编码非法', 'utf8'), 'text/plain; charset=utf-8');
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    rel = rel.replace(/\\/g, '/');
    if (rel.includes('\0') || rel.split('/').includes('..')) {
      return sendBuffer(res, 403, Buffer.from('禁止访问', 'utf8'), 'text/plain; charset=utf-8');
    }
    const abs = path.resolve(PUBLIC_DIR, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
    if (!isInside(PUBLIC_DIR, abs)) {
      return sendBuffer(res, 403, Buffer.from('禁止访问', 'utf8'), 'text/plain; charset=utf-8');
    }
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return sendBuffer(res, 404, Buffer.from('页面不存在', 'utf8'), 'text/html; charset=utf-8');
    }
    if (!st.isFile()) {
      return sendBuffer(res, 404, Buffer.from('页面不存在', 'utf8'), 'text/html; charset=utf-8');
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME_TYPES[ext] ?? 'application/octet-stream';
    try {
      const buf = await fsp.readFile(abs);
      return sendBuffer(res, 200, buf, type);
    } catch {
      return sendBuffer(res, 500, Buffer.from('读取文件失败', 'utf8'), 'text/plain; charset=utf-8');
    }
  }

  // ------------------------------------------------------------ 路由

  const automationErrors = {
    cron_invalid: 'Cron 必须是有效的 5 字段表达式',
    mention_uid_invalid: '@ 目标 UID 必须是正整数',
    config_invalid: '自动化配置格式不正确',
    boolean_invalid: '启用状态与人工验收状态必须是布尔值',
    keywords_invalid: '搜索关键词必须为字符串数组，每项不超过 100 字',
    upUsers_invalid: 'UP 主 UID 必须为正整数字符串数组',
    targets_invalid: 'QQ 推送目标格式不正确',
    comment_acceptance_required: '开启自动评论前需填写 @ UID 并确认已完成人工验收',
    sources_targets_required: '启用自动化前需配置内容来源和 QQ 推送目标',
    target_invalid: 'QQ 推送目标格式不正确',
    browser_invalid: '请选择 Chrome 或 Edge',
    cookie_extractor_unavailable: '无法启动 Cookie 提取工具，请检查 Python 是否已安装',
    cookie_extractor_failed: '浏览器登录态提取失败，请检查所选浏览器是否已登录 B站',
    cookie_extractor_timeout: '读取浏览器登录态超时，请完全退出所选浏览器后重试',
    cookie_database_locked: '所选浏览器正在占用 Cookie 数据库，请完全退出该浏览器（含后台进程）后重试',
    cookie_app_bound_unsupported: '所选浏览器的登录态使用应用绑定加密（v20），当前提取工具无法读取',
    cookie_crypto_unavailable: '缺少 Cookie 解密依赖，请为桥接使用的 Python 安装 cryptography',
    cookie_decryption_failed: '无法解密所选浏览器登录态，请使用登录该浏览器的 Windows 用户运行桥接',
    browser_profile_not_found: '未找到所选浏览器配置，请先打开该浏览器并登录 B站',
    cookie_database_unreadable: '无法读取所选浏览器的 Cookie 数据库，请检查访问权限并关闭浏览器后重试',
    bilibili_login_not_found: '未找到有效的 B站登录态',
    cookie_extractor_invalid_output: '未能导入 B站登录态',
    bilibili_login_required: 'B站登录态已失效，请在所选浏览器重新登录后导入',
    bilibili_invalid_cookie: 'B站登录态格式无效，请重新登录后导入',
    bilibili_http_error: '验证 B站登录态时 HTTP 请求失败，请稍后重试',
    bilibili_request_failed: '无法连接 B站验证登录态，请检查网络后重试',
    bilibili_request_timeout: 'B站登录态验证超时，请稍后重试',
    bilibili_api_rejected: 'B站拒绝了登录验证请求，请稍后重试',
    bilibili_invalid_response: 'B站返回了无法识别的登录验证结果，请稍后重试',
    busy: '自动化任务正在运行，请等待完成后重试',
    qrcode_network_error: '无法连接 B站登录服务，请检查网络后重试',
    qrcode_timeout: 'B站扫码请求超时，请重试',
    qrcode_response_invalid: 'B站扫码登录返回异常，请重新生成二维码',
    qrcode_platform_refused: 'B站暂时拒绝扫码登录，请稍后重试',
    qrcode_login_invalid: '扫码返回的登录态不完整，请重新生成二维码',
    qrcode_save_failed: '登录态保存失败，请重新扫码',
    qrcode_cancelled: '二维码已取消或失效，请重新生成',
    qrcode_session_invalid: '二维码已取消或失效，请重新生成',
  };

  function automationSnapshot(raw = {}) {
    const cfg = raw.config ?? {};
    const configKeys = ['enabled', 'cron', 'keywords', 'upUsers', 'targets', 'mentionUid', 'commentEnabled', 'commentApproved'];
    const clean = (value) => redactSecrets(text(value)).slice(0, 8000);
    const safeFields = (value, keys) => Object.fromEntries(keys
      .filter((key) => value && Object.hasOwn(value, key))
      .map((key) => [key, typeof value[key] === 'number' || typeof value[key] === 'boolean' ? value[key] : clean(value[key])]));
    return {
      config: Object.fromEntries(configKeys.filter((key) => Object.hasOwn(cfg, key)).map((key) => [key, cfg[key]])),
      cookieAvailable: raw.cookieAvailable === true,
      nextRunAt: raw.nextRunAt ?? null,
      lastRun: raw.lastRun ? safeFields(raw.lastRun, ['status', 'at', 'found', 'published', 'reason']) : null,
      todayComments: Number(raw.todayComments) || 0,
      busy: raw.busy === true || raw.lastRun?.status === 'running',
      blockedReason: clean(raw.blockedReason ?? ''),
      commentPublicationAvailable: raw.commentPublicationAvailable === true,
      commentPublicationStatus: clean(raw.commentPublicationStatus ?? ''),
      audit: (Array.isArray(raw.audit) ? raw.audit : []).slice(-100).map((entry) => safeFields(entry,
        ['dynamicId', 'targetUid', 'mentionUid', 'at', 'status', 'result', 'reason', 'text', 'body', 'comment'])),
      automationToken,
    };
  }

  async function routeAutomation(req, res, pathname, method) {
    const authority = text(req.headers.host).toLowerCase();
    const port = req.socket.localPort;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(authority)) {
      return fail(res, 403, '自动化接口仅允许本机控制台访问');
    }
    const origin = text(req.headers.origin);
    if ((origin && origin !== `http://${authority}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      return fail(res, 403, '自动化接口不接受跨站请求');
    }
    const base = '/api/automation/bilibili';
    const expectedMethod = pathname === base ? null : {
      [`${base}/run`]: 'POST', [`${base}/cookie`]: 'POST', [`${base}/audit`]: 'GET',
      [`${base}/login/start`]: 'POST', [`${base}/login/poll`]: 'POST', [`${base}/login/cancel`]: 'POST',
    }[pathname];
    if (pathname !== base && !expectedMethod) return fail(res, 404, '没有这个自动化接口');
    if (pathname === base ? !['GET', 'PUT'].includes(method) : method !== expectedMethod) {
      return fail(res, 405, pathname === base ? '只支持 GET / PUT' : `只支持 ${expectedMethod}`);
    }
    if (method === 'GET') {
      try {
        const snapshot = automationSnapshot(await platforms.snapshot());
        return ok(res, pathname.endsWith('/audit') ? { audit: snapshot.audit } : snapshot);
      } catch {
        safeLog.warn?.('读取 B站自动化状态失败');
        return fail(res, 500, '读取自动化状态失败');
      }
    }
    const supplied = Buffer.from(text(req.headers['x-qq-automation-token']), 'utf8');
    const expected = Buffer.from(automationToken, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return fail(res, 403, '请刷新自动化页面后再操作');
    }
    if (text(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') {
      return fail(res, 415, '自动化请求需要 JSON');
    }
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024) || '{}'); }
    catch (error) { return fail(res, Number(error?.statusCode) || 400, '自动化请求格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, '自动化请求需要 JSON 对象');
    try {
      if (pathname.startsWith(`${base}/login/`)) {
        if (pathname.endsWith('/start')) {
          if (Object.keys(body).length) return fail(res, 400, '生成二维码不接受额外参数');
          const result = await qrLogin.start();
          if (typeof result?.id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(result.id)
            || typeof result.qrImage !== 'string' || !/^data:image\/(?:gif|png);base64,[A-Za-z\d+/]+={0,2}$/.test(result.qrImage)
            || result.qrImage.length > 256 * 1024 || !Number.isFinite(Date.parse(result.expiresAt))) {
            throw new Error('qrcode_response_invalid');
          }
          return ok(res, { id: result.id, qrImage: result.qrImage, expiresAt: result.expiresAt, status: 'waiting' });
        }
        if (Object.keys(body).length !== 1 || typeof body.id !== 'string'
          || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.id)) {
          return fail(res, 400, '扫码会话标识无效，请重新生成二维码');
        }
        if (pathname.endsWith('/cancel')) {
          const result = await qrLogin.cancel(body.id);
          if (!['expired', 'success'].includes(result?.status)) throw new Error('qrcode_response_invalid');
          return ok(res, { cancelled: result.status !== 'success', status: result.status });
        }
        const result = await qrLogin.poll(body.id);
        if (!['waiting', 'scanned', 'expired', 'success'].includes(result?.status)) throw new Error('qrcode_response_invalid');
        return ok(res, { status: result.status });
      }
      if (pathname === base) {
        const fields = new Set(['enabled', 'cron', 'keywords', 'upUsers', 'targets', 'mentionUid', 'commentEnabled', 'commentApproved']);
        if (Object.keys(body).some((key) => !fields.has(key))) return fail(res, 400, '自动化配置包含未知字段');
        await platforms.saveConfig(body);
        return ok(res, automationSnapshot(await platforms.snapshot()));
      }
      if (pathname.endsWith('/run')) {
        if (Object.keys(body).length) return fail(res, 400, '立即检查不接受额外参数');
        await platforms.queueManualRun();
        return ok(res, { queued: true, message: '检查已排队，桥接运行时执行' });
      }
      if (Object.keys(body).length !== 1 || !['edge', 'chrome'].includes(body.browser)) {
        return fail(res, 400, '请选择 Chrome 或 Edge');
      }
      await platforms.extractBrowserCookie(body.browser);
      return ok(res, { imported: true, message: 'B站登录态已导入' });
    } catch (error) {
      const code = [error?.code, error?.message].find(value => typeof value === 'string' && Object.hasOwn(automationErrors, value));
      safeLog.warn?.(`B站自动化控制操作失败（${code ?? 'operation_failed'}）`);
      return fail(res, 400, code ? automationErrors[code] : '自动化操作失败，请检查配置或本机登录状态');
    }
  }

  async function routeUpdates(req, res, pathname, method) {
    // A separate token and strict loopback origin keep websites from triggering an installer.
    const authority = text(req.headers.host).toLowerCase();
    const port = req.socket.localPort;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(authority)) return fail(res, 403, '更新接口仅允许本机控制台访问');
    const origin = text(req.headers.origin);
    if ((origin && origin !== `http://${authority}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return fail(res, 403, '更新接口不接受跨站请求');
    }

    if (pathname === '/api/updates' && method === 'GET') {
      return ok(res, { ...await updates.status(), updateToken });
    }
    const action = {
      '/api/updates/check': 'POST',
      '/api/updates/settings': 'PUT',
      '/api/updates/install': 'POST',
    }[pathname];
    if (!action) return fail(res, 404, '没有这个更新接口');
    if (method !== action) return fail(res, 405, `只支持 ${action}`);
    const supplied = Buffer.from(text(req.headers['x-qq-update-token']), 'utf8');
    const expected = Buffer.from(updateToken, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return fail(res, 403, '请刷新控制台后再操作更新');
    }
    if (text(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') {
      return fail(res, 415, '更新请求需要 JSON');
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 4096) || '{}');
    } catch (err) {
      return fail(res, Number(err?.statusCode) || 400, '更新请求格式不正确');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, '更新请求需要 JSON 对象');
    }
    const fields = Object.keys(body);
    try {
      let result;
      if (pathname === '/api/updates/check') {
        if (fields.length) return fail(res, 400, '检查更新不接受额外参数');
        result = await updates.check();
      } else if (pathname === '/api/updates/settings') {
        if (fields.length !== 1 || fields[0] !== 'automatic' || typeof body.automatic !== 'boolean') {
          return fail(res, 400, 'automatic 必须是布尔值');
        }
        result = await updates.setAutomatic(body.automatic);
      } else {
        if (fields.length !== 1 || fields[0] !== 'version' ||
            typeof body.version !== 'string' || body.version.length > 100) {
          return fail(res, 400, '请指定确认安装的版本');
        }
        result = await updates.install({ version: body.version });
      }
      return ok(res, { ...result, updateToken });
    } catch (err) {
      return fail(res, Number(err?.statusCode) || 400, err?.message || '更新操作失败，请稍后重试');
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return fail(res, 400, '路径编码非法');
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '只支持 GET');
      return serveStatic(url.pathname, res);
    }

    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (pathname === '/api/imagegen' || pathname.startsWith('/api/imagegen/')) {
      return imagegen.route(req, res, pathname, method, url);
    }

    if (pathname === '/api/updates' || pathname.startsWith('/api/updates/')) {
      return routeUpdates(req, res, pathname, method);
    }
    if (pathname === '/api/automation' || pathname.startsWith('/api/automation/')) {
      return routeAutomation(req, res, pathname, method);
    }
    if (pathname === '/api/overview' && method === 'GET') return ok(res, await buildOverview());
    if (pathname === '/api/logs' && method === 'GET') return getLogs(url, res);
    if (pathname === '/api/memory/stats' && method === 'GET') return getMemoryStats(res);
    if (pathname === '/api/memory/search' && method === 'GET') return searchMemory(url, res);
    if (pathname === '/api/memory/note') {
      if (method === 'GET') return getNote(url, res);
      if (method === 'POST') return putNote(req, res);
      return fail(res, 405, '只支持 GET / POST');
    }
    if (pathname === '/api/reflect') {
      if (method === 'GET') return getReflect(res);
      if (method === 'POST') return postReflectRun(req, res);
      return fail(res, 405, '只支持 GET / POST');
    }
    if (pathname === '/api/persona') {
      if (method === 'GET') return getPersona(res, url);
      if (method === 'PUT') return putPersona(req, res);
      return fail(res, 405, '只支持 GET / PUT');
    }
    if (pathname === '/api/personas' && method === 'GET') return getPersonas(res);
    if (pathname === '/api/personas' && method === 'POST') return postPersonaCreate(req, res);
    if (pathname === '/api/personas' && method === 'DELETE') return deletePersonaHandler(req, res, url);
    if (pathname === '/api/personas/active' && method === 'PUT') return putPersonaActive(req, res);
    if (pathname === '/api/personas/chat' && method === 'PUT') return putPersonaChat(req, res);
    if (pathname === '/api/personas/seed' && method === 'POST') return postPersonaSeed(req, res);
    if (pathname.startsWith('/api/personas/')) return fail(res, 404, `没有这个接口：${pathname}`);
    if (pathname === '/api/stickers' && method === 'GET') return getStickers(res, url);
    if (pathname === '/api/stickers/file' && method === 'GET') return getStickerFile(res, url);
    if (pathname === '/api/stickers/rebuild' && method === 'POST') return postStickerRebuild(req, res);
    if (pathname === '/api/stickers/tag' && method === 'POST') return postStickerTag(req, res);
    if (pathname === '/api/stickers/delete' && method === 'POST') return postStickerDelete(req, res);
    if (pathname === '/api/stickers/migrate' && method === 'POST') return postStickerMigrate(req, res);
    if (pathname.startsWith('/api/stickers/')) return fail(res, 404, `没有这个表情包接口：${pathname}`);
    if (pathname === '/api/sessions' && method === 'GET') return getSessions(res);
    if (pathname.startsWith('/api/sessions/')) {
      if (method !== 'DELETE') return fail(res, 405, '只支持 DELETE');
      return deleteSession(pathname.slice('/api/sessions/'.length), res);
    }
    const service = /^\/api\/service\/([a-z]+)\/([a-z]+)$/.exec(pathname);
    if (service) {
      const [, name, action] = service;
      if (method !== 'POST') return fail(res, 405, '只支持 POST');
      return runServiceAction(name, action, res);
    }
    if (pathname === '/api/paths') {
      if (method !== 'GET') return fail(res, 405, '只支持 GET');
      return getPaths(res);
    }
    if (pathname === '/api/paths/check') {
      if (method !== 'POST') return fail(res, 405, '只支持 POST');
      return postPathCheck(req, res);
    }
    if (pathname === '/api/settings') {
      if (method === 'GET') return getSettings(res);
      if (method === 'PUT') return putSettings(req, res);
      return fail(res, 405, '只支持 GET / PUT');
    }
    if (pathname === '/api/model') {
      if (method === 'GET') return getModel(res);
      if (method === 'PUT') return putModel(req, res);
      return fail(res, 405, '只支持 GET / PUT');
    }
    if (pathname === '/api/plugins' && method === 'GET') return getPlugins(res);
    const pluginMatch = /^\/api\/plugins\/([a-z0-9][a-z0-9-]*)$/.exec(pathname);
    if (pluginMatch) {
      if (method !== 'PUT') return fail(res, 405, '只支持 PUT');
      return putPlugin(req, res, pluginMatch[1]);
    }
    if (pathname === '/api/autostart') {
      if (method === 'GET') return getAutostart(res);
      if (method === 'PUT') return putAutostart(req, res);
      return fail(res, 405, '只支持 GET / PUT');
    }
    if (pathname === '/api/open') {
      if (method !== 'POST') return fail(res, 405, '只支持 POST');
      return postOpen(req, res);
    }

    return fail(res, 404, `没有这个接口：${pathname}`);
  }

  async function handle(req, res) {
    res.__headOnly = req.method === 'HEAD';
    try {
      await route(req, res);
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (!res.headersSent) {
        fail(res, status, status === 500 ? `服务内部错误：${err?.message ?? err}` : err.message);
      } else {
        try {
          res.end();
        } catch {
          /* 忽略 */
        }
      }
      if (status === 500) safeLog.error?.('控制台请求异常：', err?.stack ?? err);
    }
  }

  function attach(res) {
    res.setTimeout(ACTION_TIMEOUT_MS + 5000, () => {
      try {
        res.destroy();
      } catch {
        /* 忽略 */
      }
    });
    return res;
  }

  // ------------------------------------------------------------ 生命周期

  async function listenOnce(targetPort) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => handle(req, attach(res)));
      s.keepAliveTimeout = 5000;
      s.headersTimeout = 10_000;
      s.requestTimeout = ACTION_TIMEOUT_MS + 10_000;
      const onError = (err) => {
        s.removeListener('listening', onListening);
        try {
          s.close();
        } catch {
          /* 忽略 */
        }
        reject(err);
      };
      const onListening = () => {
        s.removeListener('error', onError);
        s.on('error', (err) => safeLog.error?.('控制台服务异常：', err?.message ?? err));
        resolve(s);
      };
      s.once('error', onError);
      s.once('listening', onListening);
      try {
        s.listen(targetPort, host);
      } catch (err) {
        onError(err);
      }
    });
  }

  async function start() {
    if (server && actualPort) return { port: actualPort };
    let lastErr = null;
    for (let i = 0; i < MAX_PORT_TRIES; i += 1) {
      const candidate = basePort + i;
      try {
        server = await listenOnce(candidate);
        actualPort = candidate;
        break;
      } catch (err) {
        lastErr = err;
        if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') break;
      }
    }
    if (!server || !actualPort) {
      throw new Error(
        `控制台无法监听 ${basePort}-${basePort + MAX_PORT_TRIES - 1} 之间的端口：${lastErr?.message ?? lastErr}`,
      );
    }
    startedAt = Date.now();
    try {
      await fsp.mkdir(stateDir, { recursive: true });
      await writeAtomic(portFile, `${actualPort}\n`);
    } catch (err) {
      safeLog.warn?.('写入控制台端口文件失败：', err?.message ?? err);
    }
    safeLog.info?.(`控制台已启动：http://127.0.0.1:${actualPort}/`);
    healthEnabled = true;
    void sampleNapcatHealth().catch(() => {});
    healthTimer = setInterval(() => { void sampleNapcatHealth().catch(() => {}); }, 15_000);
    healthTimer.unref?.();
    try {
      await updates.start();
    } catch (err) {
      safeLog.warn?.('自动更新检查未启动：', err?.message ?? err);
    }
    return { port: actualPort };
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    healthEnabled = false;
    clearInterval(healthTimer);
    healthTimer = null;
    healthProbe.close?.();
    await healthSampling?.catch(() => {});
    updates.stop();
    await imagegen.stop();
    await qrLogin.stop();
    const s = server;
    server = null;
    const port = actualPort;
    actualPort = 0;
    if (s) {
      await new Promise((resolve) => {
        s.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
      try {
        s.closeAllConnections?.();
      } catch {
        /* 忽略 */
      }
    }
    if (port) {
      try {
        const raw = await fsp.readFile(portFile, 'utf8');
        if (raw.trim() === String(port)) await fsp.rm(portFile, { force: true });
      } catch {
        /* 端口文件可能已被别处改掉，忽略 */
      }
    }
    stopping = false;
  }

  return {
    start,
    stop,
    get url() {
      return actualPort ? `http://127.0.0.1:${actualPort}/` : `http://127.0.0.1:${basePort}/`;
    },
    get port() {
      return actualPort || basePort;
    },
    get listening() {
      return Boolean(server && actualPort);
    },
  };
}

/** ws://127.0.0.1:3001 → 3001 */
function portFromUrl(raw) {
  const value = text(raw);
  if (value === '') return 0;
  try {
    const u = new URL(value);
    return Number(u.port) || 0;
  } catch {
    const m = /:(\d{2,5})(?:\/|$)/.exec(value);
    return m ? Number(m[1]) : 0;
  }
}

/** 从 markdown 里猜标题：先看一级标题，再看文件名 */
function guessTitle(body, rel) {
  const m = /^#\s+(.+)$/m.exec(text(body));
  if (m) return m[1].trim().slice(0, 120);
  return path.basename(rel, path.extname(rel));
}

// ------------------------------------------------------- 单独调试入口

async function main() {
  let config = {};
  let log = null;
  try {
    const { loadConfig } = await import('../config.js');
    const custom = (process.env.QQ_CONFIG || '').trim();
    const loaded = loadConfig(PROJECT_ROOT, { createIfMissing: false, ...(custom ? { configFile: custom } : {}) });
    config = loaded.config;
  } catch (err) {
    console.warn(`[控制台] 读取配置失败，改用默认值：${err?.message ?? err}`);
  }
  try {
    const { createLogger } = await import('../logger.js');
    log = createLogger('webui', { logDir: resolveFrom(PROJECT_ROOT, config.logDir ?? 'logs'), echo: true });
  } catch {
    log = null;
  }

  const envPort = Number(process.env.WEBUI_PORT);
  const instance = createWebUiServer({
    config,
    configRoot: PROJECT_ROOT,
    log,
    host: process.env.WEBUI_HOST?.trim() || '127.0.0.1',
    ...(Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? { port: envPort } : {}),
  });
  const { port } = await instance.start();
  const line = `[控制台] 就绪：http://127.0.0.1:${port}/  （Ctrl+C 退出）`;
  console.log(line);
  log?.info?.(line);

  const shutdown = async (signal) => {
    log?.info?.(`控制台收到 ${signal}，正在退出…`);
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('[控制台] 未处理的 Promise 拒绝：', err);
  });
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(SELF_FILE).toLowerCase();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[控制台] 启动失败：', err?.message ?? err);
    process.exit(1);
  });
}
