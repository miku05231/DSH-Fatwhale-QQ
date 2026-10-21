import path from 'node:path';

function quoteArg(value, platform) {
  const text = String(value);
  return platform === 'win32' ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, "'\\''")}'`;
}

/** 每次提示都明确当前库与导入工具，空库也能引导搜索后入库。 */
export function buildStickerPrompt({ projectRoot, configPath, root, stats, sendProbability = 1, platform = process.platform } = {}) {
  const tool = path.join(projectRoot, 'tools', 'stickers.mjs');
  const base = `node ${quoteArg(tool, platform)}`;
  const options = `--config ${quoteArg(configPath, platform)} --root ${quoteArg(root, platform)} --json`;
  const tags = (stats?.tags ?? [])
    .filter((entry) => !entry.tag.startsWith('月份:'))
    .slice(0, 4)
    .map((entry) => entry.tag)
    .join('、');
  const count = stats?.count ?? 0;
  const summary = count > 0
    ? `共 ${count} 张（动图 ${stats?.animated ?? 0} 张），常用标签：${tags || '暂无'}。`
    : '当前为空，可以按用户要求搜索并导入表情包。';
  const probability = typeof sendProbability === 'number' && Number.isFinite(sendProbability)
    && sendProbability >= 0 && sendProbability <= 1 ? sendProbability : 1;
  return `[表情包库] 当前目录：${root}。${summary}` +
    `表情发送概率为 ${probability}（0 不发送，1 保留你的原有发送频率），由发送工具统一抽签，挑图和入库不抽签。` +
    '工具返回 skipped:true 时本次不发表情，不要重试、改用别的发送方式或重新抽签；仍可正常回复文字。' +
    `想发表情，先运行 \`${base} pick --query '关键词' ${options}\`，再用返回的本地 path 交给 qq.mjs 发图。` +
    `用户让你搜索/搜集表情时，找到实际原图地址后必须运行 \`${base} add '实际原图的http(s)地址或本地绝对路径' --tag '关键词' ${options}\` 完成入库；` +
    '命令返回 ok:true 和 path、确认文件已保存后才说明收集完成。' +
    '下载的图片必须导入当前库，不能只留在临时文件夹或另建 assets/stickers 库。' +
    `查看其他用法：\`${base} --help\`。`;
}
