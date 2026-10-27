import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createFakeNapCat } from './ws-harness.mjs';
import { createImagegenFixture, waitUntil } from './helpers/imagegen-fixture.mjs';
import { isolatedEnv, prepareIsolatedHome } from './helpers/isolated-fixtures.mjs';
import { killProcessTree } from '../src/dsh.js';

test('real bridge -> DSH CLI tool -> local image service -> fake QQ, image-only responses', { timeout: 60000 }, async () => {
  const f = await createImagegenFixture();
  const napcat = createFakeNapCat();
  let child;
  let output = '';
  try {
    await prepareIsolatedHome(f.root);
    const port = await napcat.listen(0);
    f.config.onebot.url = `ws://127.0.0.1:${port}`;
    f.config.security.allowGroups = true;
    f.config.security.allowGroupIds = [789];
    f.config.security.rateLimitPerMinute = 0;
    f.config.dsh.mode = 'headless';
    f.config.dsh.companion = false;
    f.config.dsh.cwd = f.root;
    f.config.dsh.timeoutMs = 15000;
    f.config.dsh.patchPath = path.join(f.root, 'model.yml');
    await fs.writeFile(f.config.dsh.patchPath, '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture\n');
    const fakeDsh = path.join(f.root, 'fake-dsh.mjs');
    const tool = path.resolve('tools/imagegen.mjs');
    await fs.writeFile(fakeDsh, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const prompt = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'prompts.jsonl'))}, JSON.stringify(prompt) + '\\n');
const context = prompt.match(/--context '([a-f0-9-]+)'/)?.[1];
if (!context) throw new Error('No current image generation context in prompt');
const result = spawnSync(process.execPath, [${JSON.stringify(tool)}, 'generate', '--config', ${JSON.stringify(f.configPath)}, '--context', context, '--prompt', 'A happy cartoon robot', '--mode', prompt.includes('STICKER_TEST') ? 'sticker' : 'image', '--json'], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-imagegen-fixture' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '' }) + '\\n');
`);
    f.config.dsh.command = fakeDsh;
    f.save();
    child = spawn(process.execPath, [path.resolve('src/index.js'), '--config', f.configPath], {
      cwd: f.root, env: isolatedEnv(f.root, { QQ_CONFIG: f.configPath }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await waitUntil(() => napcat.state.connections > 0);
    const images = () => napcat.state.calls.filter((call) => Array.isArray(call.params?.message) && call.params.message.some((s) => s.type === 'image'));
    napcat.sendPrivateMessage({ userId: 123, text: 'IMAGE_TEST', messageId: 1 });
    await waitUntil(() => images().length === 1, 20000);
    assert.equal(images()[0].action, 'send_private_msg');
    assert.equal(images()[0].params.user_id, 123);
    assert.ok(images()[0].params.message[0].data.file.startsWith('file:'));
    assert.equal(napcat.state.calls.some((call) => String(call.params?.message).includes('没有产生')), false);
    await waitUntil(async () => (await f.service.list())[0]?.delivery?.state === 'sent');

    napcat.sendGroupMessage({ groupId: 789, userId: 123, text: 'IMAGE_TEST', messageId: 2, atSelf: true });
    await waitUntil(() => images().length === 2, 20000);
    assert.equal(images()[1].action, 'send_group_msg');
    assert.equal(images()[1].params.group_id, 789);
    await waitUntil(async () => (await f.service.list())[0]?.delivery?.state === 'sent');

    f.config.stickers.sendProbability = 0; f.save();
    napcat.sendPrivateMessage({ userId: 123, text: 'STICKER_TEST', messageId: 3 });
    await waitUntil(async () => (await f.service.list())[0]?.delivery?.state === 'skipped', 20000);
    assert.equal(images().length, 2);
    assert.equal(f.state.posts.length, 3);
    const jobs = await f.service.list();
    assert.equal(jobs[0].mode, 'sticker');
    assert.ok(jobs[0].sticker.id);
    assert.equal(new Set(jobs.map((job) => job.contextId)).size, 3);
    assert.equal(napcat.state.calls.some((call) => String(call.params?.message).includes('没有产生')), false);

    const before = f.state.posts.length;
    napcat.sendPrivateMessage({ userId: 456, text: 'IMAGE_TEST', messageId: 4 });
    await waitUntil(async () => {
      const status = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'status.json'), 'utf8'));
      return status.lastMessageAt && status.inFlight === 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.state.posts.length, before);
    const prompts = (await fs.readFile(path.join(f.root, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every((prompt) => prompt.includes('[图片生成]')));
  } catch (error) {
    error.message += `\nBridge output:\n${output.slice(-5000)}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      killProcessTree(child);
      await closed;
    }
    await napcat.close();
    await f.close();
  }
});
