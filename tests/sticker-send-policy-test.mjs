// All files, configuration, model output, and QQ traffic stay in test fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyStickerSendPolicy } from '../src/sticker-send-policy.js';
import { createFakeNapCat } from './ws-harness.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(projectRoot, 'tools', 'qq.mjs');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-policy-'));
const configRoot = path.join(tmp, 'external config');
const configPath = path.join(configRoot, 'config.json');
const library = path.join(configRoot, 'sticker,library');
const sticker = path.join(library, '2026-10', 'one.png');
const unindexed = path.join(library, 'two.gif');
const outside = path.join(tmp, 'ordinary files');
const photo = path.join(outside, 'photo.png');
const document = path.join(outside, 'notes.txt');
const itemId = 'abcdef0123456789';
const text = (value) => ({ type: 'text', data: { text: value } });
const image = (file, extra = {}) => ({ type: 'image', data: { file, ...extra } });
const face = { type: 'face', data: { id: '14' } };
const options = { configPath, configRoot, cwd: tmp };
let passed = 0;
let fake;
let onebot = {};

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`  PASS ${label}`);
}

async function saveConfig(probability = 1, stickers = {}) {
  await writeFile(configPath, JSON.stringify({
    onebot,
    stickers: { root: 'sticker,library', sendProbability: probability, ...stickers },
  }));
}

function runCli(args, sample) {
  const preload = sample === undefined ? [] : [
    '--import', `data:text/javascript,${encodeURIComponent(`Math.random = () => ${sample};`)}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload, tool, '--config', configPath, ...args], {
      cwd: tmp,
      env: { ...process.env, QQ_CONFIG: '', QQ_ONEBOT_URL: '', QQ_ONEBOT_TOKEN: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out); } catch {}
      resolve({ code, json, out, err });
    });
  });
}

function assertCli(result) {
  assert.equal(result.code, 0, result.err);
  assert.notEqual(result.json, undefined, result.out);
}

try {
  await mkdir(path.dirname(sticker), { recursive: true });
  await mkdir(outside);
  await writeFile(sticker, 'fixture image');
  await writeFile(unindexed, 'fixture gif');
  await writeFile(photo, 'fixture image');
  await writeFile(document, 'ordinary desktop document');
  await writeFile(path.join(library, 'index.json'), JSON.stringify({
    items: [{ id: itemId, file: '2026-10/one.png' }],
  }));
  await saveConfig(1);

  await check('probability 1 and the absent setting preserve existing requests without randomness', async () => {
    const params = { group_id: 12345, message: [text('hello'), face, image(sticker)] };
    const failRandom = () => assert.fail('0 and 1 must not use randomness');
    assert.equal((await applyStickerSendPolicy('send_group_msg', params, { ...options, random: failRandom })).params, params);
    const defaulted = await applyStickerSendPolicy('send_group_msg', params, {
      config: { stickers: { root: library } }, random: failRandom,
    });
    assert.equal(defaulted.probability, 1);
    assert.equal(defaulted.params, params);
  });

  await check('probability 0 removes only real stickers and keeps text, ordinary images, and documents', async () => {
    await saveConfig(0);
    const keep = [text('hello'), image(photo), image('https://example.invalid/photo.png'),
      { type: 'file', data: { file: document } }];
    const params = { group_id: 12345, message: [
      ...keep, face, { type: 'mface', data: {} }, { type: 'marketface', data: {} },
      image('https://example.invalid/emoji.gif', { sub_type: '1' }),
      image('base64://not-a-real-image', { subType: 1 }),
      image(pathToFileURL(sticker).href), image(unindexed),
    ] };
    const before = structuredClone(params);
    const policy = await applyStickerSendPolicy('send_group_msg', params, {
      ...options, random: () => assert.fail('zero probability must not draw'),
    });
    assert.deepEqual(policy.params.message, keep);
    assert.equal(policy.filtered, 7);
    assert.equal(policy.skipped, false);
    assert.deepEqual(params, before);
  });

  await check('pure stickers are a successful skip with a no-retry explanation', async () => {
    const policy = await applyStickerSendPolicy('send_private_msg', { user_id: 12345, message: [face] }, options);
    assert.equal(policy.skipped, true);
    assert.equal(policy.result.ok, true);
    assert.equal(policy.result.skipped, true);
    assert.match(policy.result.message, /勿重试/);
  });

  await check('CQ parsing removes recognized stickers and decodes escaped library paths once', async () => {
    const url = pathToFileURL(sticker).href.replace(/,/g, '&#44;');
    const params = { group_id: 12345, message:
      `before[CQ:face,id=14][CQ:image,file=${url}]after[CQ:image,file=https://example.invalid/photo.png]` };
    const policy = await applyStickerSendPolicy('send_group_msg', params, options);
    assert.equal(policy.filtered, 2);
    assert.equal(policy.params.message, 'beforeafter[CQ:image,file=https://example.invalid/photo.png]');
    const pure = await applyStickerSendPolicy('send_msg', { message: '[CQ:mface,id=1]' }, options);
    assert.equal(pure.skipped, true);
  });

  await check('literal CQ in text segments or auto-escaped strings remains ordinary text', async () => {
    const literal = { user_id: 12345, message: [text('[CQ:face,id=14]')] };
    assert.equal((await applyStickerSendPolicy('send_private_msg', literal, options)).params, literal);
    const escaped = { message: '[CQ:face,id=14]', auto_escape: true };
    assert.equal((await applyStickerSendPolicy('send_msg', escaped, options)).params, escaped);
    const unreadable = { ...options, configPath: path.join(tmp, 'missing.json'),
      random: () => assert.fail('literal text must not draw') };
    assert.equal((await applyStickerSendPolicy('send_private_msg', literal, unreadable)).params, literal);
    assert.equal((await applyStickerSendPolicy('send_msg', escaped, unreadable)).params, escaped);
    const malformed = { message: [image(undefined, { sub_type: 0 }), { type: 'image', data: null }] };
    assert.equal((await applyStickerSendPolicy('send_msg', malformed, options)).params, malformed);
  });

  await check('forward nodes are filtered recursively while their text and metadata stay intact', async () => {
    const params = { group_id: 12345, messages: [
      { type: 'node', data: { name: 'one', uin: '12345', content: [face] } },
      { type: 'node', data: { name: 'two', uin: '12345', content: [
        text('retained'), { type: 'node', data: { content: '[CQ:marketface,id=1]' } }, image(sticker),
      ] } },
    ] };
    const before = structuredClone(params);
    const policy = await applyStickerSendPolicy('send_group_forward_msg', params, options);
    assert.equal(policy.filtered, 3);
    assert.deepEqual(policy.params.messages, [{
      type: 'node', data: { name: 'two', uin: '12345', content: [text('retained')] },
    }]);
    assert.deepEqual(params, before);
    const pure = await applyStickerSendPolicy('send_private_forward_msg', {
      messages: [{ type: 'node', data: { content: [face] } }],
    }, options);
    assert.equal(pure.skipped, true);
  });

  await check('indexed media IDs and relative library files are recognized without broad image blocking', async () => {
    for (const file of [itemId, '2026-10/one.png', path.relative(tmp, sticker)]) {
      const policy = await applyStickerSendPolicy('send_msg', { message: [image(file)] }, options);
      assert.equal(policy.skipped, true, file);
    }
    assert.equal((await applyStickerSendPolicy('send_msg', {
      message: [image(path.relative(tmp, photo))],
    }, options)).filtered, 0);
  });

  await check('a library junction to an outside image does not turn an ordinary file into a sticker', async () => {
    const junction = path.join(library, 'outside');
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const params = { message: [image(path.join(junction, 'photo.png'))] };
    assert.equal((await applyStickerSendPolicy('send_msg', params, options)).params, params);
  });

  await check('file uploads are gated only for images from the actual sticker library', async () => {
    for (const action of ['upload_group_file', 'upload_private_file']) {
      assert.equal((await applyStickerSendPolicy(action, { file: sticker }, options)).skipped, true);
      for (const file of [document, photo]) {
        const params = { file };
        assert.equal((await applyStickerSendPolicy(action, params, options)).params, params);
      }
    }
  });

  await check('fractional probability makes exactly one decision for the whole request', async () => {
    await saveConfig(0.5);
    const params = { message: [text('hello'), face, image(sticker), { type: 'mface', data: {} }] };
    for (const sample of [0.2, 0.5, 0.8]) {
      let draws = 0;
      const policy = await applyStickerSendPolicy('send_msg', params, {
        ...options, random: () => { draws += 1; return sample; },
      });
      assert.equal(draws, 1);
      assert.deepEqual(policy.params.message, sample < 0.5 ? params.message : [text('hello')]);
    }
    await applyStickerSendPolicy('send_msg', { message: [text('no stickers')] }, {
      ...options, random: () => assert.fail('plain text does not need a probability draw'),
    });
  });

  await check('each request reloads probability and library location from disk', async () => {
    const opts = { ...options, config: { stickers: { sendProbability: 1 } } };
    const params = { message: [image(sticker)] };
    await saveConfig(1);
    assert.equal((await applyStickerSendPolicy('send_msg', params, opts)).skipped, false);
    await saveConfig(0);
    assert.equal((await applyStickerSendPolicy('send_msg', params, opts)).skipped, true);
    await saveConfig(0, { root: outside });
    assert.equal((await applyStickerSendPolicy('send_msg', params, opts)).filtered, 0);
    assert.equal((await applyStickerSendPolicy('send_msg', { message: [image(photo)] }, opts)).skipped, true);
    await saveConfig(0);
  });

  await check('invalid probabilities and unreadable settings fail without silently sending stickers', async () => {
    for (const value of [-0.1, 1.1, '0.5', Number.NaN, null]) {
      const config = { stickers: { sendProbability: value } };
      await assert.rejects(applyStickerSendPolicy('send_msg', { message: [face] }, { config }), /0 到 1/);
    }
    await assert.rejects(applyStickerSendPolicy('send_msg', { message: [face] }, {
      configPath: path.join(tmp, 'missing.json'), config: {},
    }), /无法读取/);
    const raw = await readFile(configPath);
    await writeFile(configPath, '{broken');
    await assert.rejects(applyStickerSendPolicy('send_msg', { message: [face] }, options), /无法读取/);
    await writeFile(configPath, raw);
  });

  await check('non-send QQ operations are unchanged and do not read sticker settings', async () => {
    const params = { message: [face] };
    const policy = await applyStickerSendPolicy('get_msg', params, { configPath: path.join(tmp, 'missing.json') });
    assert.equal(policy.params, params);
  });

  fake = createFakeNapCat({ onCall: (call) => call.reply({ message_id: fake.state.calls.length }) });
  const port = await fake.listen();
  onebot = { url: `ws://127.0.0.1:${port}`, accessToken: '' };

  await check('QQ image shortcut and raw pure-sticker sends skip before opening any connection', async () => {
    await saveConfig(0);
    const before = fake.state.connections;
    for (const args of [
      ['image', 'group:12345', sticker],
      ['send_group_msg', JSON.stringify({ group_id: 12345, message: '[CQ:face,id=14]' })],
      ['upload_private_file', JSON.stringify({ user_id: 12345, file: sticker, name: 'emoji.png' })],
    ]) {
      const result = await runCli(args);
      assertCli(result);
      assert.equal(result.json.ok, true);
      assert.equal(result.json.skipped, true);
    }
    assert.equal(fake.state.connections, before);
    assert.equal(fake.state.calls.length, 0);
  });

  await check('QQ mixed raw sends retain their text and ordinary picture at probability zero', async () => {
    const result = await runCli(['send_group_msg', JSON.stringify({
      group_id: 12345, message: [text('hello'), face, image(sticker), image(photo)],
    })]);
    assertCli(result);
    assert.deepEqual(fake.state.calls.at(-1).params.message, [text('hello'), image(photo)]);
    const literal = await runCli(['send', 'group:12345', '[CQ:face,id=14]']);
    assertCli(literal);
    assert.deepEqual(fake.state.calls.at(-1).params.message, [text('[CQ:face,id=14]')]);
  });

  await check('QQ probability one preserves both shortcut images and raw CQ', async () => {
    await saveConfig(1);
    assertCli(await runCli(['image', '12345', sticker]));
    assert.deepEqual(fake.state.calls.at(-1).params.message, [image(pathToFileURL(sticker).href)]);
    assertCli(await runCli(['send_private_msg', JSON.stringify({ user_id: 12345, message: '[CQ:face,id=14]' })]));
    assert.equal(fake.state.calls.at(-1).params.message, '[CQ:face,id=14]');
  });

  await check('QQ fractional sends reproducibly allow or remove all stickers in one request', async () => {
    await saveConfig(0.5);
    const message = [text('hello'), face, image(sticker), { type: 'mface', data: {} }];
    for (const sample of [0.2, 0.8]) {
      assertCli(await runCli(['send_group_msg', JSON.stringify({ group_id: 12345, message })], sample));
      assert.deepEqual(fake.state.calls.at(-1).params.message, sample < 0.5 ? message : [text('hello')]);
    }
  });

  await check('QQ forwards and ordinary file uploads use the same policy without blocking desktop files', async () => {
    await saveConfig(0);
    const messages = [{ type: 'node', data: { name: 'fixture', content: [text('kept'), face] } }];
    assertCli(await runCli(['send_group_forward_msg', JSON.stringify({ group_id: 12345, messages })]));
    assert.deepEqual(fake.state.calls.at(-1).params.messages[0].data.content, [text('kept')]);
    for (const file of [document, photo]) {
      assertCli(await runCli(['upload_group_file', JSON.stringify({ group_id: 12345, file, name: path.basename(file) })]));
      assert.equal(fake.state.calls.at(-1).params.file, file);
    }
  });
} finally {
  await fake?.close();
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} 项 sticker send policy checks`);
