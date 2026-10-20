// src/dsh-desktop.js —— DSH Desktop profile 客户端
//
// 作用：让 QQ 会话跑在「桌面 profile」里（全部桌面插件/工具可用），并且会话
// 落在和桌面端同一本 ~/.dsh/sessions 账上，桌面端刷新后就能看到。
//
// 做法：懒启动一个常驻子进程 src/dsh-desktop-host.mjs，用 NDJSON 走 stdin/stdout。
// 子进程用 @deepseek-ai/dsh-app-boot 加载用户安装的 desktop profile，再用
// sessionController.create/prompt 驱动。这样不需要伪造浏览器 cookie，也不用
// 修改用户的 Desktop profile。
//
// 任何失败都只是一次调用失败：上层 agent-runner 会按配置回退到 headless，
// 不能让桥接因为桌面端没开、插件升级、锁冲突而失联。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveCommandPlan, killProcessTree } from './dsh.js';
import { redactSecrets } from './redact.js';

const HOST_SCRIPT = fileURLToPath(new URL('./dsh-desktop-host.mjs', import.meta.url));
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const STDERR_TAIL_CHARS = 4096;
const CANCEL_GRACE_MS = 5000;

/** 安装目录缓存：同一条 dsh.command 只解析一次 */
const installRootCache = new Map();

/**
 * 从 `dsh` 命令解析出 DSH 安装根目录。
 *
 * 支持：
 *   - dsh.command 指向 .../@deepseek-ai/dsh/lib/bin.js（最稳）
 *   - dsh.command = "dsh"，PATH 里是 npm 生成的 .cmd 垫片（Windows）
 *   - dsh.command = "dsh"，PATH 里是指向 bin.js 的符号链接（Linux/macOS）
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {string} 形如 C:\...\node_modules\@deepseek-ai\dsh
 */
export function resolveDshInstallRoot(command, cwd) {
  const cacheKey = `${command}\u0000${cwd}`;
  const cached = installRootCache.get(cacheKey);
  if (cached) return cached;

  const plan = resolveCommandPlan(String(command || 'dsh'), cwd);
  if (plan.error) throw new Error(plan.error);

  let entry = null;
  if (plan.fixedArgs.length > 0 && /\.(js|mjs|cjs)$/i.test(plan.fixedArgs[0])) {
    entry = path.resolve(cwd, plan.fixedArgs[0]);
  } else if (/\.(js|mjs|cjs)$/i.test(plan.file)) {
    entry = path.resolve(cwd, plan.file);
  } else {
    // 无扩展名的 POSIX 垫片通常是指向 bin.js 的符号链接
    try {
      const real = fs.realpathSync(plan.file);
      if (/\.(js|mjs|cjs)$/i.test(real)) entry = real;
    } catch {
      /* 保持 entry = null */
    }
  }
  if (!entry || !fs.existsSync(entry)) {
    throw new Error(
      `无法从 dsh.command「${command}」定位 DSH 的 Node 入口；` +
        'desktop 模式需要把 dsh.command 指向 ...\\@deepseek-ai\\dsh\\lib\\bin.js（或可解析到它的垫片）。',
    );
  }

  let dir = path.dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg?.name === '@deepseek-ai/dsh') {
          installRootCache.set(cacheKey, dir);
          return dir;
        }
      }
    } catch {
      /* 坏 package.json，继续往上找 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Node 入口「${entry}」不在 @deepseek-ai/dsh 安装目录里`);
}

/** DSH home：优先 $DSH_HOME，否则 ~/.dsh */
export function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** desktop profile 目录；配置里可以写绝对路径 */
export function resolveDesktopProfileDir(cfg) {
  const configured = String(cfg?.dsh?.desktopProfile ?? '').trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(resolveDshHome(), 'profiles', configured || 'desktop');
}

/**
 * 探测当前机器是否具备 desktop 模式。
 * 只做文件系统检查，不启动任何进程，供启动日志/控制台展示用。
 *
 * @returns {{available: boolean, reason: string, root?: string, profileDir?: string}}
 */
export function detectDesktopProfile(cfg, cwd) {
  let root;
  try {
    root = resolveDshInstallRoot(String(cfg?.dsh?.command ?? 'dsh'), cwd);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const profileDir = resolveDesktopProfileDir(cfg);
  const profilePkg = path.join(profileDir, 'package.json');
  if (!fs.existsSync(profileDir)) {
    return { available: false, reason: `没有 desktop profile 目录：${profileDir}`, root, profileDir };
  }
  if (!fs.existsSync(profilePkg)) {
    return { available: false, reason: `desktop profile 不完整（缺 package.json）：${profileDir}`, root, profileDir };
  }
  if (!fs.existsSync(HOST_SCRIPT)) {
    return { available: false, reason: `缺少宿主脚本：${HOST_SCRIPT}`, root, profileDir };
  }
  return { available: true, reason: '', root, profileDir };
}

/* ------------------------------------------------------------------ *
 * 常驻宿主进程
 * ------------------------------------------------------------------ */

class DesktopHost {
  constructor(settings) {
    this.settings = settings;
    this.log = settings.log;
    this.child = null;
    this.rl = null;
    this.ready = false;
    this.everReady = false;
    this.readyError = null;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.bootTimer = null;
    this.pending = new Map();
    this.stderrTail = '';
    this.idleTimer = null;
    this.stopping = false;
    this.startedAt = 0;
  }

  /** 启动（或复用）宿主；重复调用共享同一个启动 Promise */
  ensureStarted() {
    if (this.ready && this.child && this.child.exitCode === null) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this._spawn();
    });
    return this.startPromise;
  }

  _spawn() {
    const { dshRoot, profileDir, cwd, permission, bootTimeoutMs } = this.settings;
    this.stopping = false;
    this.ready = false;
    this.readyError = null;
    this.stderrTail = '';
    this.startedAt = Date.now();

    const env = { ...process.env };
    if (permission) env.DSH_PERMISSION_MODE = permission;
    // 万一把桥接塞进 Electron 里跑，子进程仍按 Node 解释
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

    const args = [
      HOST_SCRIPT,
      '--dsh-root',
      dshRoot,
      '--profile-dir',
      profileDir,
      '--cwd',
      cwd,
    ];
    if (permission) args.push('--permission', permission);

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.readyError = `无法启动 desktop host：${error.message}`;
      const reject = this.startReject;
      this.startReject = null;
      this.startResolve = null;
      this.startPromise = null;
      reject?.(new Error(this.readyError));
      return;
    }
    this.child = child;
    this.log?.debug?.(`desktop host 启动（pid=${child.pid ?? '?'}, profile=${profileDir}）`);

    this.bootTimer = setTimeout(() => {
      this.readyError = `desktop host 启动超时（${bootTimeoutMs}ms）`;
      this.log?.warn?.(this.readyError);
      this.kill('启动超时');
      this.startReject?.(new Error(this.readyError));
    }, bootTimeoutMs);
    this.bootTimer.unref?.();

    child.stdout.setEncoding('utf8');
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._handleLine(line));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = redactSecrets(`${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS), STDERR_TAIL_CHARS);
    });

    child.on('error', (error) => {
      this.readyError = `desktop host 进程错误：${error.message}`;
      this.startReject?.(new Error(this.readyError));
      this.kill('进程错误');
    });
    child.on('exit', (code, signal) => this._onExit(code, signal));
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.log?.debug?.('desktop host 输出了非协议行，已忽略');
      return;
    }
    if (!message || message.v !== 1) return;

    if (message.type === 'ready') {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
      this.ready = true;
      this.everReady = true;
      this.log?.debug?.(`desktop host 就绪（${message.bootMs ?? Date.now() - this.startedAt}ms）`);
      this.startResolve?.();
      this.startResolve = null;
      this.startReject = null;
      return;
    }
    if (message.type === 'fatal') {
      this.readyError = redactSecrets(message.message || 'desktop host 启动失败');
      this.log?.warn?.(this.readyError);
      this.startReject?.(new Error(this.readyError));
      this.kill('fatal');
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'session') {
      pending.sessionId = message.sessionId ?? null;
      pending.adopted = Boolean(message.adopted);
      return;
    }
    if (message.type === 'final') {
      this._settle(pending, null, {
        sessionId: message.sessionId ?? pending.sessionId ?? pending.requestedSessionId,
        finalText: typeof message.text === 'string' ? message.text : '',
        model: message.model ?? null,
        reason: message.reason ?? null,
      });
      return;
    }
    if (message.type === 'error') {
      const error = new Error(redactSecrets(message.message || 'desktop host 返回错误'));
      error.code = message.code ?? 'desktop-error';
      error.sessionId = message.sessionId ?? pending.sessionId ?? null;
      if (!error.sessionId) error.sessionId = pending.requestedSessionId ?? null;
      this._settle(pending, error);
    }
  }

  _settle(pending, error, value) {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.cancelTimer) clearTimeout(pending.cancelTimer);
    if (pending.abortHandler && pending.signal) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    this.pending.delete(pending.id);
    if (error) {
      // 会话已经被 host 接受（session 事件到了）之后出的错不能回退重跑，
      // 否则同一轮对话会被执行两遍。
      if (pending.sessionId) error.sessionAccepted = true;
      pending.reject(error);
    }
    else pending.resolve(value);
    this._scheduleIdle();
  }

  _send(message) {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin?.writable) {
      throw new Error('desktop host 没有在运行');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * 发一条 prompt 并等结果。父进程的 timeoutMs 覆盖「启动 + 执行」。
   *
   * @param {string} text
   * @param {{sessionId?: string|null, signal?: AbortSignal, timeoutMs?: number, model?: object|null}} options
   * @returns {Promise<{sessionId: string|null, finalText: string, model: object|null, reason: string|null}>}
   */
  async request(text, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    await this.ensureStarted();
    if (options.signal?.aborted) throw new Error('DSH 调用已取消（收到中止信号）');

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        // 请求里带的旧会话 id 和「宿主真的接受了哪个会话」要分开：
        // 只有收到 session 事件才算接受，没接受之前失败才允许回退 headless。
        requestedSessionId: options.sessionId ? String(options.sessionId) : null,
        sessionId: null,
        resolve,
        reject,
        settled: false,
        signal: options.signal ?? null,
        abortHandler: null,
        timer: null,
        cancelTimer: null,
      };
      this.pending.set(id, pending);

      pending.timer = setTimeout(() => {
        pending.timedOut = true;
        const error = new Error(`DSH 调用超时：超过 ${timeoutMs} 毫秒没有完成，已强制结束 desktop host`);
        error.timedOut = true;
        this.kill('调用超时');
        this._settle(pending, error);
      }, timeoutMs);

      if (options.signal) {
        pending.abortHandler = () => {
          if (pending.settled) return;
          pending.cancelled = true;
          this.log?.warn?.('DSH(desktop) 调用收到中止信号，正在取消');
          try {
            this._send({ v: 1, op: 'cancel', id });
          } catch {
            /* 宿主已经没了，直接失败 */
          }
          pending.cancelTimer = setTimeout(() => {
            this.kill('取消超时');
            this._settle(
              pending,
              Object.assign(new Error('DSH 调用已取消（收到中止信号）'), { aborted: true }),
            );
          }, CANCEL_GRACE_MS);
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }

      try {
        this._send({
          v: 1,
          op: 'prompt',
          id,
          sessionId: pending.requestedSessionId,
          cwd: this.settings.cwd,
          text: String(text ?? ''),
          model: options.model ?? null,
        });
      } catch (error) {
        this._settle(pending, error);
      }
    });
  }

  _scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.pending.size > 0) return;
    const idleMs = Number(this.settings.idleMs);
    if (!(idleMs > 0) || !this.ready) return;
    this.idleTimer = setTimeout(() => {
      this.log?.debug?.(`desktop host 空闲 ${Math.round(idleMs / 1000)}s，关闭以释放内存`);
      this.stop();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  _onExit(code, signal) {
    clearTimeout(this.bootTimer);
    this.bootTimer = null;
    const wasReady = this.ready;
    this.ready = false;
    this.child = null;
    try {
      this.rl?.close();
    } catch {
      /* 忽略 */
    }
    this.rl = null;
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;

    const tail = this.stderrTail.trim();
    const detail = tail ? `：${tail.slice(-500)}` : '';
    const error = new Error(
      `desktop host 已退出（退出码 ${code ?? '?'}${signal ? `，信号 ${signal}` : ''}）${detail}`,
    );
    error.desktopHostExit = true;

    if (!wasReady) {
      this.readyError = error.message;
      reject?.(error);
    }
    for (const pending of [...this.pending.values()]) {
      this._settle(pending, error);
    }
  }

  /** 立即杀掉宿主和它的子进程树 */
  kill(reason) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      this.log?.debug?.(`结束 desktop host（${reason || '主动结束'}, pid=${child.pid ?? '?'}）`);
      killProcessTree(child, this.log);
    }
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;
    if (reject) reject(new Error(this.readyError || 'desktop host 已结束'));
    for (const pending of [...this.pending.values()]) {
      this._settle(pending, new Error(`desktop host 已结束（${reason || '主动结束'}）`));
    }
  }

  /** 优雅关闭：先发 shutdown，再等 3 秒，超时杀树 */
  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      this._send({ v: 1, op: 'shutdown' });
    } catch {
      /* 已经没了 */
    }
    const child = this.child;
    setTimeout(() => {
      if (this.child === child && child) this.kill('关闭超时');
    }, 3000).unref?.();
  }

  stderrTailText() {
    return this.stderrTail.trim();
  }
}

/* ------------------------------------------------------------------ *
 * 单例管理
 * ------------------------------------------------------------------ */

let sharedHost = null;
let sharedKey = '';

/** 进程退出时尽量带走宿主（taskkill /T 也会带走，这里只是兜底） */
process.once('exit', () => {
  try {
    sharedHost?.child?.kill();
  } catch {
    /* 忽略 */
  }
});

/** 测试/关机用：主动关闭常驻宿主 */
export function shutdownDesktopHost() {
  if (!sharedHost) return;
  sharedHost.stop();
  sharedHost = null;
  sharedKey = '';
}

function hostKeyFor(settings) {
  return [settings.dshRoot, settings.profileDir, settings.cwd, settings.permission ?? ''].join('|');
}

/**
 * 跑一轮 QQ 对话，返回和 runDsh 相同的形状，调用方无感。
 *
 * @param {string} text
 * @param {{cfg: object, cwd: string, log?: any, sessionId?: string|null, signal?: AbortSignal,
 *          timeoutMs?: number, model?: object|null}} options
 * @returns {Promise<{sessionId: string|null, finalText: string, events: object[]}>}
 */
export async function runDesktopDsh(text, options = {}) {
  const { cfg, log, signal } = options;
  if (signal?.aborted) throw new Error('DSH 调用已取消（收到中止信号）');

  const cwd = path.resolve(String(options.cwd ?? process.cwd()));
  const timeoutMs = Number(options.timeoutMs ?? cfg?.dsh?.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const dshRoot = resolveDshInstallRoot(String(cfg?.dsh?.command ?? 'dsh'), cwd);
  const profileDir = resolveDesktopProfileDir(cfg);
  const settings = {
    dshRoot,
    profileDir,
    cwd,
    permission: String(cfg?.dsh?.permissionMode ?? '').trim(),
    bootTimeoutMs:
      Number(cfg?.dsh?.desktopBootTimeoutMs) > 0
        ? Number(cfg.dsh.desktopBootTimeoutMs)
        : DEFAULT_BOOT_TIMEOUT_MS,
    idleMs:
      Number.isFinite(Number(cfg?.dsh?.desktopIdleMs)) && Number(cfg.dsh.desktopIdleMs) >= 0
        ? Number(cfg.dsh.desktopIdleMs)
        : DEFAULT_IDLE_MS,
    log,
  };

  const key = hostKeyFor(settings);
  if (!sharedHost || sharedKey !== key) {
    if (sharedHost) sharedHost.kill('切换 DSH 配置');
    sharedHost = new DesktopHost(settings);
    sharedKey = key;
  }
  const host = sharedHost;
  const startedAt = Date.now();
  log?.info?.(
    `DSH(desktop) 调用开始（${options.sessionId ? `续传会话 ${options.sessionId}` : '新建会话'}，` +
      `超时 ${timeoutMs}ms）：${String(text).slice(0, 120)}${String(text).length > 120 ? '…' : ''}`,
  );

  try {
    const value = await host.request(text, {
      sessionId: options.sessionId ?? null,
      signal,
      timeoutMs,
      model: options.model ?? null,
    });
    log?.info?.(`DSH(desktop) 完成（${Date.now() - startedAt}ms，session=${value.sessionId ?? '?'}）`);
    return {
      sessionId: value.sessionId ?? options.sessionId ?? null,
      finalText: value.finalText,
      events: [
        { type: 'session', sessionId: value.sessionId ?? options.sessionId ?? null },
        { type: 'final', text: value.finalText },
      ],
    };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.desktop = true;
    wrapped.desktopBootFailure = !host.everReady;
    wrapped.sessionId = wrapped.sessionId ?? options.sessionId ?? null;
    wrapped.stderrTail = host.stderrTailText();
    throw wrapped;
  }
}
