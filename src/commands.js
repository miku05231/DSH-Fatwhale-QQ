/**
 * src/commands.js —— 内置安全指令（零依赖、纯函数）
 *
 * 插件只在管理员出队后执行（插件能跑任意本机代码），所以普通群友原来
 * 除了 /人格 没有任何指令可用。这里补几条**不碰电脑、不调模型、只读统计**
 * 的指令，参考 NoneBot / Koishi 生态里最常见的 /帮助、/状态、/排行：
 *
 *   /帮助  /help  /菜单        列出可用指令
 *   /状态  /status             运行时长、今日收发、成功率、平均耗时、当前模型
 *   /排行  /今日排行  /昨日排行  本群发言排行（仅群聊）
 *
 * 配置 config.commands：
 *   enabled  默认 true；false 时整组关闭，消息照常交给模型
 *   rank     默认 true；false 时只关 /排行
 *   rankSize 默认 10，最多 30
 */

const PATTERNS = [
  { name: 'help', re: /^[/／](帮助|help|菜单|指令)$/i },
  { name: 'status', re: /^[/／](状态|status)$/i },
  { name: 'rank', re: /^[/／](今日排行|排行|发言排行|rank)$/i },
  { name: 'rankYesterday', re: /^[/／](昨日排行)$/i },
  { name: 'summary', re: /^[/／](今日总结|群聊总结)$/i },
];

/**
 * 识别内置指令。只认整句（去掉首尾空白后），避免误伤正常聊天。
 * @param {string} text
 * @returns {{name: string}|null}
 */
export function parseBuiltinCommand(text) {
  const body = String(text ?? '').trim();
  if (!body || body.length > 16) return null;
  for (const { name, re } of PATTERNS) {
    if (re.test(body)) return { name };
  }
  return null;
}

export function commandSettings(config) {
  const raw = config?.commands ?? {};
  const size = Math.trunc(Number(raw.rankSize));
  return {
    enabled: raw.enabled !== false,
    rank: raw.rank !== false,
    rankSize: Number.isFinite(size) && size > 0 ? Math.min(30, size) : 10,
  };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return `${s} 秒`;
}

function formatMs(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '—';
  return n >= 10_000 ? `${(n / 1000).toFixed(0)} 秒` : `${(n / 1000).toFixed(1)} 秒`;
}

/**
 * @param {{botName?: string, isGroup?: boolean, rankEnabled?: boolean, pluginCommands?: Array<{cmd: string, desc: string}>}} opts
 */
export function formatHelp({ botName = '我', isGroup = false, rankEnabled = true, pluginCommands = [] } = {}) {
  const lines = [`${botName}能听懂这些指令：`];
  lines.push('/帮助 —— 看这份说明');
  lines.push('/状态 —— 运行情况和今天的收发');
  if (rankEnabled && isGroup) lines.push('/排行 · /昨日排行 —— 本群发言排行');
  lines.push('/人格 —— 查看或切换人格（白名单用户）');
  if (isGroup) lines.push('/今日总结 —— 立刻总结本群今天的聊天（管理员）');
  const extra = (Array.isArray(pluginCommands) ? pluginCommands : [])
    .filter((c) => c && typeof c.cmd === 'string' && c.cmd.trim())
    .slice(0, 12);
  if (extra.length) {
    lines.push('', '插件指令（管理员）：');
    for (const c of extra) lines.push(`${c.cmd.trim()}${c.desc ? ` —— ${String(c.desc).trim()}` : ''}`);
  }
  lines.push('', isGroup ? '其他事 @我 或用唤醒词直接说就行。' : '其他事直接说就行。');
  return lines.join('\n');
}

/**
 * @param {{uptimeSeconds: number, connected: boolean, today: object, model?: string, queueDepth?: number}} info
 */
export function formatStatus({ uptimeSeconds = 0, connected = true, today = {}, model = '', queueDepth = 0 } = {}) {
  const rate = today.successRate == null ? '—' : `${Math.round(today.successRate * 100)}%`;
  const lines = [
    `状态：${connected ? '在线' : '连接中断'} · 已运行 ${formatDuration(uptimeSeconds)}`,
    `今日：收到 ${today.received ?? 0} 条（私聊 ${today.privateIn ?? 0} / 群聊 ${today.groupIn ?? 0}），回复 ${today.replied ?? 0} 条`,
    `成功率 ${rate} · 平均耗时 ${formatMs(today.avgLatencyMs)}`,
  ];
  if (model) lines.push(`模型：${model}`);
  if (queueDepth > 0) lines.push(`排队中：${queueDepth} 条`);
  return lines.join('\n');
}

/**
 * @param {Array<{id: string, name: string, count: number}>} rows
 */
export function formatRanking(rows, { yesterday = false } = {}) {
  const title = yesterday ? '昨日发言排行' : '今日发言排行';
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `${title}：还没有记录。`;
  const medals = ['🥇', '🥈', '🥉'];
  const total = list.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
  const lines = [`${title}（前 ${list.length} 名共 ${total} 条）`];
  list.forEach((r, i) => {
    const who = r.name || `QQ ${maskId(r.id)}`;
    lines.push(`${medals[i] ?? `${i + 1}.`} ${who} —— ${r.count} 条`);
  });
  return lines.join('\n');
}

/** 群里展示时不暴露完整 QQ 号 */
export function maskId(id) {
  const s = String(id ?? '');
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
