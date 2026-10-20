/**
 * src/plugins/ping.js —— 最小的指令类插件示例（onMessage）
 *
 * 群里 @ 它 或私聊发「/ping」，直接回一句，不消耗 dsh 调用。
 * 拿来演示「插件怎么接管一条消息」以及「配置怎么在控制台里改」。
 */

export const meta = {
  name: 'ping',
  displayName: 'Ping 指令',
  version: '1.0.0',
  description: '收到 /ping 时立刻回一句，不经过 dsh（演示指令类插件）',
  defaultEnabled: true,
  configSchema: [
    { key: 'reply', type: 'string', label: '回复内容', default: 'pong 🐟' },
  ],
};

export async function onMessage(ctx) {
  const text = String(ctx.text ?? '').trim();
  if (!/^[/／]ping\b/i.test(text)) return undefined;
  const reply = String(ctx.config?.reply ?? 'pong 🐟');
  await ctx.reply(reply);
  return { handled: true };
}
