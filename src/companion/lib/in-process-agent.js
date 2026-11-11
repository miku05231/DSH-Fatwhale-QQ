// Admin turns call the companion prompt handler in this process.
// Everyone else still goes through the isolated chat-only child process.

function permissionModeOf(cfg) {
  return String(cfg?.dsh?.permissionMode ?? 'workspace-write').trim();
}

export function createInProcessAgentRuntime({ prompt, runChatOnly = null, isAdmin = null } = {}) {
  if (typeof prompt !== 'function') throw new Error('进程内代理需要 prompt');
  return {
    async run(text, options = {}) {
      const admin = isAdmin ?? (await import('../../security.js')).isAdministrator;
      if (!admin(options.requesterId, options.cfg)) {
        const chatOnly = runChatOnly ?? (await import('../../chat-only.js')).runChatOnlyDsh;
        return chatOnly(text, options);
      }
      const requestAbort = new AbortController();
      const onAbort = () => requestAbort.abort();
      if (options.signal) {
        if (options.signal.aborted) requestAbort.abort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const workspacePath = options.workspacePath ?? options.cwd;
        const result = await prompt({
          text,
          ...(options.sessionId ? { sessionId: String(options.sessionId) } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(options.model ? { model: options.model } : {}),
          permissionMode: permissionModeOf(options.cfg),
          ...(Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {}),
        }, requestAbort);
        const finalText = String(result?.text ?? '');
        const sessionId = result?.sessionId ?? options.sessionId ?? null;
        return {
          sessionId,
          finalText,
          events: [
            { type: 'session', sessionId },
            { type: 'final', sessionId, text: finalText },
          ],
          model: result?.model ?? null,
          modelsUsed: Array.isArray(result?.modelsUsed) ? result.modelsUsed : [],
          elapsedMs: result?.elapsedMs,
          workspaceId: result?.workspaceId ?? null,
        };
      } finally {
        options.signal?.removeEventListener?.('abort', onAbort);
      }
    },
    shutdown() {},
  };
}
