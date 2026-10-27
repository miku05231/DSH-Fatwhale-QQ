import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deliverTextAndVoice } from '../src/reply-delivery.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-reply-delivery-test-'));
const audio = Buffer.alloc(256, 4);
let passed = 0;
async function check(name, run) {
  await run();
  assert.deepEqual(await fs.readdir(root), [], `${name}: temporary files must be removed`);
  passed++;
}
const writer = { async synthesize(text, { outputFile }) { await fs.writeFile(outputFile, audio); } };
const unusedProvider = { synthesize() { throw new Error('synthesis must not run'); } };

try {
  await check('final text first and one voice only', async () => {
    const events = [];
    const result = await deliverTextAndVoice('final decorated reply', {
      voiceEnabled: true, ttsTempDir: root,
      async sendText(text) { events.push(['text', text]); return true; },
      ttsProvider: { async synthesize(text, { outputFile }) {
        events.push(['tts', text]);
        await fs.writeFile(outputFile, audio);
      } },
      async sendRecord(file) {
        assert.deepEqual(Buffer.from(file.slice('base64://'.length), 'base64'), audio);
        events.push(['record']);
      },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: true });
    assert.deepEqual(events, [['text', 'final decorated reply'], ['tts', 'final decorated reply'], ['record']]);
  });

  await check('wait for confirmed text delivery', async () => {
    let confirmText;
    let synthesized = false;
    const pending = deliverTextAndVoice('reply', {
      voiceEnabled: true, ttsTempDir: root,
      sendText() { return new Promise(resolve => { confirmText = resolve; }); },
      ttsProvider: { async synthesize(text, { outputFile }) {
        synthesized = true;
        await fs.writeFile(outputFile, audio);
      } },
      async sendRecord() {},
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(synthesized, false);
    confirmText(true);
    assert.deepEqual(await pending, { textSent: true, voiceSent: true });
  });

  await check('translation changes only speech after the original text succeeds', async () => {
    const events = [];
    const result = await deliverTextAndVoice('你好，今天天气真好。', {
      voiceEnabled: true, voiceConfig: { translationEnabled: true, targetLanguage: '日语' }, ttsTempDir: root,
      async sendText(text) { events.push(['text', text]); return true; },
      async ttsTranslator(text, options) {
        events.push(['translate', text, options.targetLanguage]);
        return 'こんにちは。今日はいい天気ですね。';
      },
      ttsProvider: { async synthesize(text, { outputFile }) {
        events.push(['tts', text]); await fs.writeFile(outputFile, audio);
      } },
      async sendRecord() { events.push(['record']); },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: true });
    assert.deepEqual(events, [
      ['text', '你好，今天天气真好。'], ['translate', '你好，今天天气真好。', '日语'],
      ['tts', 'こんにちは。今日はいい天気ですね。'], ['record'],
    ]);
  });

  await check('translation failure retains text and never submits untranslated speech', async () => {
    const logs = [];
    const result = await deliverTextAndVoice('中文原文', {
      voiceEnabled: true, voiceConfig: { translationEnabled: true }, ttsTempDir: root,
      async sendText(text) { assert.equal(text, '中文原文'); return true; },
      async ttsTranslator() { throw new Error('Bearer fixture-private-translation-key'); },
      ttsProvider: unusedProvider, async sendRecord() { assert.fail('failed translations must not produce audio'); },
      log: { warn(line) { logs.push(line); } },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, error: 'tts_translation_failed' });
    assert.doesNotMatch(logs.join('\n'), /private-translation|中文原文/);
  });

  for (const [name, sendText] of [
    ['rejected text', async () => false],
    ['unconfirmed text', async () => undefined],
    ['text exception', async () => { throw new Error('secret text-send token'); }],
    ['missing text sender', undefined],
  ]) {
    await check(name, async () => {
      const logs = [];
      const result = await deliverTextAndVoice('private reply contents', {
        sendText, voiceEnabled: true, ttsProvider: unusedProvider, ttsTempDir: root,
        sendRecord() { throw new Error('must not send record'); },
        log: { warn(message) { logs.push(message); } },
      });
      assert.deepEqual(result, { textSent: false, voiceSent: false, error: 'text_send_failed' });
      assert.doesNotMatch(JSON.stringify({ result, logs }), /secret|private reply contents/);
    });
  }

  await check('voice disabled', async () => {
    const result = await deliverTextAndVoice('reply', {
      async sendText() { return true; },
      voiceEnabled: false, ttsProvider: unusedProvider, ttsTempDir: root,
      sendRecord() { throw new Error('must not send record'); },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, voiceSkipped: true });
  });

  await check('missing record sender', async () => {
    const result = await deliverTextAndVoice('reply', {
      async sendText() { return true; }, voiceEnabled: true,
      ttsProvider: unusedProvider, ttsTempDir: root,
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, voiceSkipped: true });
  });

  await check('TTS failure preserves text', async () => {
    const delivered = [];
    const logs = [];
    const result = await deliverTextAndVoice('reply', {
      async sendText(text) { delivered.push(text); return true; },
      voiceEnabled: true, ttsTempDir: root,
      ttsProvider: { async synthesize(text, { outputFile }) {
        await fs.writeFile(outputFile, audio);
        throw new Error('Cookie=secret-token');
      } },
      sendRecord() { throw new Error('must not send record'); },
      log: { warn(message) { logs.push(message); } },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, error: 'tts_provider_failed' });
    assert.deepEqual(delivered, ['reply']);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /secret-token/);
  });

  await check('OneBot exception preserves text', async () => {
    let textSent = 0;
    const result = await deliverTextAndVoice('reply', {
      async sendText() { textSent++; return true; },
      voiceEnabled: true, ttsProvider: writer, ttsTempDir: root,
      async sendRecord() { throw new Error('OneBot secret-token'); },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, error: 'tts_send_failed' });
    assert.equal(textSent, 1);
  });

  await check('explicit record rejection', async () => {
    const result = await deliverTextAndVoice('reply', {
      async sendText() { return true; },
      voiceEnabled: true, ttsProvider: writer, ttsTempDir: root,
      async sendRecord() { return false; },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, error: 'tts_send_failed' });
  });

  await check('cancel after text stops synthesis', async () => {
    const controller = new AbortController();
    const result = await deliverTextAndVoice('reply', {
      async sendText() { controller.abort(); return true; },
      voiceEnabled: true, ttsProvider: unusedProvider, ttsTempDir: root, signal: controller.signal,
      async sendRecord() { throw new Error('must not send record'); },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: false, error: 'tts_aborted' });
  });

  await check('logging failures do not reject delivery', async () => {
    const result = await deliverTextAndVoice('reply', {
      async sendText() { return false; },
      log: { warn() { throw new Error('logger failed'); } },
    });
    assert.deepEqual(result, { textSent: false, voiceSent: false, error: 'text_send_failed' });
  });

  await check('ordinary chat voice never invokes user plugins', async () => {
    let calls = 0;
    const result = await deliverTextAndVoice('reply', {
      async sendText() { return true; },
      voiceEnabled: true, ttsProvider: writer, ttsTempDir: root,
      async sendRecord() { calls++; },
      plugins: { runAfterReply() { throw new Error('privileged plugin execution must stay in index'); } },
    });
    assert.deepEqual(result, { textSent: true, voiceSent: true });
    assert.equal(calls, 1);
  });

  console.log(`通过：文本/语音发送编排 ${passed} 项（隔离模拟，无真实请求）`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
