// src/dsh.js —— DSH CLI 调用层
//
// 用法：
//   const { sessionId, finalText, events } = await runDsh('你好', { cfg });
//
// 协议（已实测）：
//   dsh --profile headless --patch <绝对路径> --json [--session-id <id>] <任务文本>
//   输出 NDJSON：首行 {"type":"session","sessionId":"session-<uuid>",...}
//                末行 {"type":"final","text":"..."}
//                错误 {"type":"error","message":"..."}
//
// 注意：--session-id 只能用于「已存在」的会话。传入不存在的 id 时 dsh 会失败并
// 输出 `session "<id>" does not exist; ...`。所以新建会话时不传 --session-id，
// 跑完从首行的 session 事件里取回新的 sessionId 交给调用方持久化。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

/** 未配置超时时的兜底值（5 分钟） */
const DEFAULT_TIMEOUT_MS = 300_000;
/** stderr 只保留最后这么多字符，避免吃内存 */
const STDERR_TAIL_CHARS = 4096;
/** 写进错误消息里的 stderr 截断长度 */
const STDERR_REPORT_CHARS = 500;
/** 单行 NDJSON 的最大长度，超过视为协议异常 */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 行缓冲器：正确处理跨 chunk 的半行
 * ------------------------------------------------------------------ */
class LineBuffer {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = '';
    this.overflow = false;
  }

  push(chunk) {
    if (this.overflow) return;
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.trim()) this.onLine(line);
    }
    // 防御：单个事件行异常长（例如 dsh 输出了非 NDJSON 的巨块）时不要无限增长
    if (this.buf.length > MAX_LINE_CHARS) {
      this.overflow = true;
      this.buf = '';
    }
  }

  /** 进程结束时把残留的无换行结尾也当成一行 */
  flush() {
    if (this.overflow) return;
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    if (rest.trim()) this.onLine(rest);
  }
}

/* ------------------------------------------------------------------ *
 * 命令解析
 *
 * Windows 上 `dsh` 通常是 npm 生成的 dsh.cmd 垫片，而 CreateProcess 无法直接
 * 执行 .cmd/.bat（Node 在没有 shell 时也会直接 ENOENT / EINVAL）。项目铁律是
 * 「参数用数组、绝不用 shell:true」，所以这里做两件事：
 *   1) 按 PATH/PATHEXT 找到真实文件；
 *   2) 如果是 .cmd/.bat 垫片，就从垫片内容里解析出它启动的 .js 入口，
 *      直接用 spawn(node, [入口, ...args]) 运行 —— 全程不经过 shell，
 *      任务文本里的 & | > % " 等字符不会被解释，安全且无引号问题。
 * ------------------------------------------------------------------ */

function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

/** 找到命令对应的真实文件路径，找不到返回 null */
function findExecutable(command, cwd) {
  const pathLike = command.includes('/') || command.includes('\\') || path.isAbsolute(command);
  if (pathLike) {
    const abs = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  }

  // Windows 下优先按 PATHEXT 找（.exe/.cmd/...），避免命中 git-bash 风格的
  // 无扩展名 POSIX 脚本（那种文件 CreateProcess 起不来）。
  const exts = WINDOWS
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim()).filter(Boolean)
    : [];
  const dirs = [cwd, ...pathDirs()];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
    const bare = path.join(dir, command);
    try {
      if (fs.statSync(bare).isFile()) return bare;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 从 .cmd/.bat 垫片里解析出它要启动的 .js 入口 */
function findShimScript(shimFile) {
  let text = '';
  try {
    text = fs.readFileSync(shimFile, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimFile);
  const found = [];
  // 带引号的路径（npm 垫片形如 "%dp0%\node_modules\xxx\lib\bin.js"）
  for (const m of text.matchAll(/"([^"\r\n]+?\.(?:js|mjs|cjs))"/gi)) found.push(m[1]);
  // npx/pnpm 垫片里有时不带引号
  if (found.length === 0) {
    for (const m of text.matchAll(/([A-Za-z]:[^\s"'<>|&^]*?\.(?:js|mjs|cjs))\b/gi)) found.push(m[1]);
  }

  for (let i = found.length - 1; i >= 0; i--) {
    let p = found[i]
      .replace(/%~dp0%?/gi, dir + path.sep)
      .replace(/%dp0%/gi, dir + path.sep);
    p = p.replace(/\//g, path.sep);
    if (!path.isAbsolute(p)) p = path.resolve(dir, p);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/**
 * 把配置里的命令解析成可直接 spawn 的 { file, fixedArgs }。
 * 解析失败返回 { error }
 */
export function resolveCommandPlan(command, cwd) {
  const exe = findExecutable(command, cwd);
  if (!exe) return { error: `找不到命令「${command}」` };

  const ext = path.extname(exe).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { file: process.execPath, fixedArgs: [exe] };
  }
  if (ext === '.cmd' || ext === '.bat') {
    const js = findShimScript(exe);
    if (js) return { file: process.execPath, fixedArgs: [js] };
    return {
      error:
        `无法解析垫片「${exe}」的 Node 入口。` +
        '请把配置项 dsh.command 指向 dsh 的实际可执行文件（dsh.exe 或 ...\\dsh\\lib\\bin.js）',
    };
  }
  return { file: exe, fixedArgs: [] };
}

/* ------------------------------------------------------------------ *
 * 杀进程树（Windows 用 taskkill /T /F）
 * ------------------------------------------------------------------ */
function taskkillPath() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const p = path.join(root, 'System32', 'taskkill.exe');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 回落到 PATH */
    }
  }
  return 'taskkill';
}

export function killProcessTree(child, log) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (WINDOWS) {
    try {
      const tk = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      tk.on('error', (err) => {
        log?.warn?.(`taskkill 执行失败（${err.message}），改为直接结束进程`);
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      });
    } catch (err) {
      log?.warn?.(`taskkill 启动异常（${err.message}），改为直接结束进程`);
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  // 非 Windows：先 SIGTERM，3 秒后 SIGKILL
  try {
    child.kill('SIGTERM');
  } catch {
    /* 忽略 */
  }
  const hard = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }, 3000);
  hard.unref?.();
}

/* ------------------------------------------------------------------ *
 * 主函数
 * ------------------------------------------------------------------ */
/**
 * 解析 patch 链：基础 patch（必须存在）+ 额外 patch（模型跟随生成的 runtime patch 等）。
 * 抽成纯函数，方便单测在不真的起 dsh 的情况下验证参数拼装。
 *
 * @param {object} opts
 * @param {string} [opts.patchPath] 显式指定的基础 patch
 * @param {object} [opts.dshCfg] 配置里的 dsh 段（用它里面的 patchPath）
 * @param {string} [opts.projectRoot] 相对路径的解析基准（优先）
 * @param {string} [opts.workDir] 没有 projectRoot 时的解析基准
 * @param {string[]} [opts.extraPatchPaths] 额外 patch（按顺序追加）
 * @param {object} [opts.log] 日志器
 * @returns {{ok: true, patchPath: string, patches: string[], skipped: string[]} | {ok: false, error: string}}
 */
export function resolvePatchChain({ patchPath: explicitPatchPath, dshCfg = {}, projectRoot, workDir, extraPatchPaths, log } = {}) {
  const base = path.resolve(workDir || process.cwd());
  const baseRoot = projectRoot || base;

  // --patch 必须是绝对路径。相对路径按「项目根」解析，而不是按工作目录：
  // patch 里的 qq-bridge/patches/ 这类相对路径，会按 dsh.cwd（也就是项目根）解析；两者别搞混。
  let patchPath = explicitPatchPath || dshCfg.patchPath || '';
  // 没配 patch 就不加 --patch：Docker 镜像与干净安装里默认没有补丁文件
  if (!patchPath) return { ok: true, patchPath: '', patches: [], skipped: ['没有配置 dsh.patchPath，按不加补丁运行'], disabled: true };
  if (!path.isAbsolute(patchPath)) patchPath = path.resolve(baseRoot, patchPath);
  if (!fs.existsSync(patchPath)) {
    return { ok: false, error: `找不到 patch 文件「${patchPath}」，请检查配置项 dsh.patchPath` };
  }

  // 额外 patch 缺失或非法时静默跳过，绝不让「跟随模型」把正常对话拖垮
  // （最坏情况也只是回落到基础 patch 里的模型）。
  const patches = [patchPath];
  const skipped = [];
  for (const extra of Array.isArray(extraPatchPaths) ? extraPatchPaths : []) {
    if (typeof extra !== 'string' || extra.trim() === '') continue;
    const abs = path.isAbsolute(extra) ? extra : path.resolve(baseRoot, extra);
    if (!fs.existsSync(abs)) {
      skipped.push(abs);
      log?.debug?.(`忽略不存在的额外 patch：${abs}`);
      continue;
    }
    patches.push(abs);
  }

  return { ok: true, patchPath, patches, skipped };
}

/**
 * 调用一次 dsh，等待最终回答。
 *
 * @param {string} text 任务文本（作为独立 argv 传入）
 * @param {object} opts
 * @param {string|null} [opts.sessionId] 续传用会话 id；为空则新建会话
 * @param {object} [opts.cfg] 全局配置（需要 cfg.dsh）
 * @param {string} [opts.cwd] 工作目录，默认 cfg.dsh.cwd 或 process.cwd()
 * @param {object} [opts.log] 日志器（有 info/warn/error/debug 即可）
 * @param {AbortSignal} [opts.signal] 中止信号
 * @param {string[]} [opts.extraPatchPaths] 额外叠加的 patch（如模型跟随生成的 runtime patch，按顺序追加在基础 patch 之后）
 * @returns {Promise<{sessionId: string|null, finalText: string, events: object[]}>}
 */
export function runDsh(
  text,
  { sessionId = null, cfg, cwd, log, signal, patchPath: explicitPatchPath, projectRoot, extraPatchPaths } = {},
) {
  return new Promise((resolve, reject) => {
    // ---- 参数校验 ----
    if (typeof text !== 'string' || text.trim() === '') {
      reject(new Error('DSH 调用失败：任务文本不能为空'));
      return;
    }
    if (!cfg || !cfg.dsh) {
      reject(new Error('DSH 调用失败：缺少配置（cfg.dsh）'));
      return;
    }
    if (signal?.aborted) {
      reject(new Error('DSH 调用已取消'));
      return;
    }

    const dshCfg = cfg.dsh;
    const command = dshCfg.command || 'dsh';
    const profile = dshCfg.profile || 'headless';
    const workDir = path.resolve(cwd || dshCfg.cwd || process.cwd());
    const timeoutMs =
      Number.isFinite(Number(dshCfg.timeoutMs)) && Number(dshCfg.timeoutMs) > 0
        ? Number(dshCfg.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    // --patch 链：基础 patch + 额外 patch（顺序即优先级）
    const chain = resolvePatchChain({
      patchPath: explicitPatchPath,
      dshCfg,
      projectRoot,
      workDir,
      extraPatchPaths,
      log,
    });
    if (!chain.ok) {
      reject(new Error(`DSH 调用失败：${chain.error}`));
      return;
    }
    const patches = chain.patches;

    // ---- 组装参数（数组，绝不拼 shell）----
    const dshArgs = ['--profile', profile];
    for (const item of patches) dshArgs.push('--patch', item);
    dshArgs.push('--json');
    if (sessionId) dshArgs.push('--session-id', String(sessionId));
    dshArgs.push(text);
    log?.debug?.(`dsh patch 链：${patches.join(' → ')}`);

    const plan = resolveCommandPlan(command, workDir);
    if (plan.error) {
      reject(new Error(`DSH 调用失败：${plan.error}`));
      return;
    }

    const spawnArgs = [...plan.fixedArgs, ...dshArgs];

    // ---- 运行期状态 ----
    const events = [];
    let resolvedSessionId = sessionId ? String(sessionId) : null;
    let finalText = '';
    let hasFinal = false;
    let errorMessage = '';
    let stderrTail = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child = null;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      err.events = events;
      err.stderrTail = stderrTail;
      err.sessionId = resolvedSessionId;
      err.timedOut = timedOut;
      err.aborted = aborted;
      err.exitCode = child?.exitCode ?? null;
      reject(err);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ sessionId: resolvedSessionId, finalText, events });
    };

    function onAbort() {
      if (settled) return;
      aborted = true;
      log?.warn?.('DSH 调用收到中止信号，正在结束进程树');
      killProcessTree(child, log);
    }

    // ---- 处理一行 NDJSON ----
    const handleLine = (line) => {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // 非 JSON 行（例如 CLI 的 banner）忽略，但留到 stderr 尾部里方便排查
        stderrTail = (stderrTail + '\n[stdout 非 JSON 行] ' + line).slice(-STDERR_TAIL_CHARS);
        log?.debug?.(`DSH 输出了非 JSON 行（已忽略）：${line.slice(0, 200)}`);
        return;
      }
      if (!evt || typeof evt !== 'object') return;
      events.push(evt);

      switch (evt.type) {
        case 'session':
          if (typeof evt.sessionId === 'string' && evt.sessionId) {
            resolvedSessionId = evt.sessionId;
          }
          break;
        case 'final':
          if (typeof evt.text === 'string') {
            finalText = evt.text;
            hasFinal = true;
          }
          break;
        case 'error':
          errorMessage = typeof evt.message === 'string' ? evt.message : '未知错误';
          log?.error?.(`DSH 返回错误事件：${errorMessage}`);
          break;
        default:
          break;
      }
    };

    // ---- 启动子进程 ----
    // permissionMode 决定子进程 dsh 的沙箱档位。不给就一直沿用 dsh 默认的
    // workspace-write —— 在本机上那会卡在给工作区授 ACL 一步（Win32 5 拒绝访问），
    // 结果是 QQ 里的 agent 完全没有 shell 可用。
    const permissionMode = String(cfg?.dsh?.permissionMode ?? '').trim();
    const childEnv = { ...process.env };
    if (permissionMode) childEnv.DSH_PERMISSION_MODE = permissionMode;

    try {
      child = spawn(plan.file, spawnArgs, {
        cwd: workDir,
        windowsHide: true,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      fail(new Error(`DSH 调用失败：无法启动 DSH 进程（${err.message}）`));
      return;
    }

    const lineBuffer = new LineBuffer(handleLine);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => lineBuffer.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    child.on('error', (err) => {
      const hint =
        err.code === 'ENOENT'
          ? `（找不到命令「${command}」，请检查配置项 dsh.command 或系统 PATH）`
          : '';
      fail(new Error(`DSH 调用失败：无法启动 DSH 进程${hint}：${err.message}`));
    });

    child.on('close', (code, sig) => {
      lineBuffer.flush();

      if (aborted) {
        fail(new Error('DSH 调用已取消（收到中止信号）'));
        return;
      }
      if (timedOut) {
        fail(new Error(`DSH 调用超时：超过 ${timeoutMs} 毫秒没有完成，已强制结束进程树`));
        return;
      }
      if (hasFinal) {
        done();
        return;
      }
      if (errorMessage) {
        fail(new Error(`DSH 调用失败：${errorMessage}`));
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.trim().slice(-STDERR_REPORT_CHARS);
        const detail = tail ? `：${tail}` : '（没有更多错误输出）';
        fail(new Error(`DSH 调用失败：进程异常退出（退出码 ${code}${sig ? `，信号 ${sig}` : ''}）${detail}`));
        return;
      }
      // 退出码 0 却没有 final：仍然把已经收集到的 text 事件拼起来返回
      const streamed = events
        .filter((e) => e.type === 'text' && typeof e.text === 'string')
        .map((e) => e.text)
        .join('');
      if (streamed) {
        finalText = streamed;
        log?.warn?.('DSH 没有输出 final 事件，已用 text 事件拼接作为回答');
        done();
        return;
      }
      const tail = stderrTail.trim().slice(-STDERR_REPORT_CHARS);
      fail(new Error(`DSH 调用失败：进程退出但没有返回最终回答${tail ? `：${tail}` : ''}`));
    });

    // ---- 超时与中止 ----
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log?.warn?.(`DSH 调用超时（${timeoutMs} 毫秒），正在结束进程树`);
      killProcessTree(child, log);
    }, timeoutMs);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    log?.info?.(
      `DSH 调用开始（profile=${profile}, ${sessionId ? `续传会话 ${sessionId}` : '新建会话'}, ` +
        `超时 ${timeoutMs}ms）：${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`,
    );
  });
}
