#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createImagegenService } from '../src/imagegen.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `局域网生图（无密钥，异步任务）
  node tools/imagegen.mjs check [--config config.json] [--json]
  node tools/imagegen.mjs generate --prompt '画面描述' [--mode image|sticker]
       [--preset square|landscape|portrait] [--negative-prompt '内容']
       [--seed 十进制整数] [--steps 1-100] [--cfg 0-15] [--tags '标签,情绪']
       [--context 当前会话编号] [--config config.json] [--json]
  node tools/imagegen.mjs status [任务编号] [--config config.json] [--json]
  node tools/imagegen.mjs resume 任务编号 [--context 当前会话编号] [--config config.json] [--json]
  node tools/imagegen.mjs release 任务编号 --confirmed [--config config.json] [--json]

generate 每次只提交一张；不自动重试 POST。resume 只查询已有远端任务。
release 仅在人工确认服务端没有未结束任务后，解除 unknown 任务占用。
sticker 模式导入当前表情库；QQ 会话图片由桥接自动发送。`;

let json = process.argv.includes('--json');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      ...['config', 'context', 'prompt', 'negative-prompt', 'mode', 'preset', 'seed', 'steps', 'cfg', 'width', 'height', 'tags']
        .map((name) => [name, { type: 'string' }]),
      ...['json', 'help', 'confirmed'].map((name) => [name, { type: 'boolean' }]),
    ]),
  });
  json = Boolean(values.json);
  const [command, id] = positionals;
  if (values.help || !command) process.stdout.write(`${HELP}\n`);
  else {
    if (positionals.length > 2) throw new Error('位置参数过多');
    let configPath = path.resolve(process.cwd(), values.config || process.env.QQ_CONFIG || path.join(root, 'config.json'));
    if (!path.extname(configPath)) configPath = path.join(configPath, 'config.json');
    const service = createImagegenService({ configPath });
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());
    let data;
    if (command === 'check') data = await service.check();
    else if (command === 'status') data = id ? await service.get(id) : (await service.list()).slice(0, 50);
    else if (command === 'generate') {
      const input = { prompt: values.prompt };
      for (const key of ['mode', 'preset', 'seed']) if (values[key] !== undefined) input[key] = values[key];
      for (const key of ['steps', 'cfg', 'width', 'height']) if (values[key] !== undefined) input[key] = Number(values[key]);
      if (values['negative-prompt'] !== undefined) input.negative_prompt = values['negative-prompt'];
      if (values.tags !== undefined) input.tags = values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      data = await service.generate(input, { contextId: values.context, signal: abort.signal });
    } else if (command === 'resume') data = await service.resume(id, { contextId: values.context, signal: abort.signal });
    else if (command === 'release' && values.confirmed) data = await service.release(id);
    else throw new Error(command === 'release' ? '请先人工确认远端状态，再加 --confirmed' : `未知命令：${command}`);
    const success = !data?.status || ['ok', 'completed', 'released'].includes(data.status) || command === 'status';
    let file;
    if (data?.status === 'completed') file = (await service.artifact(data.id)).file;
    if (json) process.stdout.write(`${JSON.stringify({ ok: success, data, ...(file ? { path: file } : {}) }, null, 2)}\n`);
    else process.stdout.write(`${Array.isArray(data) ? `${data.length} 个生图任务` : `${data.id ? `任务 ${data.id}：` : ''}${data.status ?? '完成'}`}${file ? `\n${file}` : ''}${data.error ? `\n${data.error}` : ''}\n`);
    if (!success) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${json ? JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'IMAGEGEN_ERROR' }) : error.message}\n`);
  process.exitCode = 1;
}
