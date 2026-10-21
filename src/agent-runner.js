// src/agent-runner.js —— DSH 调用路由（desktop / headless）
//
// 背景：
//   - headless 模式（旧默认）只加载 base + headless，没有桌面插件，但启动快、
//     对机器没有额外要求，Docker/无桌面环境也能跑。
//   - desktop 模式加载用户安装的 desktop profile，QQ 会话能用全部桌面插件，
//     并和桌面端共用会话库（桌面端刷新即可看到）；代价是要多起一个常驻宿主，
//     首次消息启动约十几秒。
//
// dsh.mode:
//   auto     默认。本机有 desktop profile 就用 desktop，否则 headless。
//   desktop  强制 desktop；启动失败按 fallbackToHeadless 回退。
//   headless 强制 headless。
//
// 回退只发生在「会话还没被 desktop host 接受」之前，避免把同一轮对话跑两遍。
// 装了 companion 插件时优先走 companion：会话由桌面宿主自己创建，桌面端
// 的会话列表会实时出现；companion 不可用才退回独立宿主/headless。

import process from 'node:process';

import { runDsh } from './dsh.js';
import { probeCompanion, runCompanionDsh } from './dsh-companion.js';
import { detectDesktopProfile, runDesktopDsh, shutdownDesktopHost } from './dsh-desktop.js';
import { redactSecrets } from './redact.js';

export const AGENT_MODES = ['auto', 'desktop', 'headless'];

let lastCompanionState = null;

/**
 * 决定本次（以及启动日志里展示的）运行模式。只读文件系统，不启动进程。
 *
 * @param {object} cfg
 * @param {{cwd: string, log?: any}} options
 * @returns {{mode: 'desktop'|'headless', reason: string, probe?: object}}
 */
export function resolveAgentMode(cfg, options = {}) {
  const configured = String(cfg?.dsh?.mode ?? 'auto').trim().toLowerCase();
  const mode = AGENT_MODES.includes(configured) ? configured : 'auto';
  if (mode === 'headless') {
    return { mode: 'headless', reason: '配置 dsh.mode=headless' };
  }

  const probe = detectDesktopProfile(cfg, String(options.cwd ?? process.cwd()));
  if (mode === 'desktop') {
    return { mode: 'desktop', reason: '配置 dsh.mode=desktop', probe };
  }
  if (probe.available) {
    return { mode: 'desktop', reason: '自动检测到 desktop profile', probe };
  }
  return { mode: 'headless', reason: probe.reason || '没有可用的 desktop profile', probe };
}

/**
 * 跑一轮对话。接口与 runDsh 相同，另外多一个 model（desktop 模式用）。
 *
 * @param {string} text
 * @param {object} options 传给 runDsh 的全部选项 + {model}
 * @returns {Promise<{sessionId: string|null, finalText: string, events: object[]}>}
 */
export async function runAgent(text, options = {}) {
  const { cfg, cwd, log } = options;
  const resolved = resolveAgentMode(cfg, { cwd, log });

  if (resolved.mode === 'headless') {
    return runDsh(text, options);
  }

  if (cfg?.dsh?.companion !== false) {
    const probe = await probeCompanion(cfg);
    if (probe.available) {
      if (lastCompanionState !== 'ok') {
        lastCompanionState = 'ok';
        log?.info?.(
          `DSH desktop 连伴可用（宿主 pid ${probe.info.pid}），会话将由桌面端实时创建`,
        );
      }
      try {
        return await runCompanionDsh(text, options);
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        const detail = redactSecrets(wrapped.message);
        if (!wrapped.channelError) {
          wrapped.message = detail;
          throw wrapped;
        }
        log?.warn?.(`DSH 连伴连接失败，改用独立宿主：${detail}`);
      }
    } else if (probe.reason && probe.reason !== lastCompanionState) {
      lastCompanionState = probe.reason;
      log?.info?.(`DSH 连伴暂不可用（${probe.reason}），改用独立宿主`);
    }
  }

  try {
    return await runDesktopDsh(text, options);
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    const fallback = cfg?.dsh?.fallbackToHeadless !== false;
    const canFallback = fallback && !wrapped.sessionAccepted;
    const detail = redactSecrets(wrapped.message);
    if (!canFallback) {
      wrapped.message = detail;
      throw wrapped;
    }
    log?.warn?.(`DSH desktop 模式失败，本次回退 headless：${detail}`);
    try {
      return await runDsh(text, options);
    } catch (headlessError) {
      const headlessDetail = redactSecrets(
        headlessError instanceof Error ? headlessError.message : String(headlessError),
      );
      const combined = new Error(
        `desktop 模式失败：${detail}；回退 headless 也失败：${headlessDetail}`,
      );
      combined.desktopError = wrapped;
      combined.headlessError = headlessError;
      combined.sessionId = headlessError?.sessionId ?? wrapped.sessionId ?? null;
      throw combined;
    }
  }
}

/** 桥接退出时释放常驻宿主（测试和关机路径用） */
export function shutdownAgentRuntime() {
  shutdownDesktopHost();
}
