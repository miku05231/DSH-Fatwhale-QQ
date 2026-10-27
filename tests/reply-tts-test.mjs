import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterReply, createEdgeTtsProvider, meta, sendReplyVoice, synthesizeSpeech, TTS_LIMITS } from '../src/plugins/reply-tts.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-tts-test-'));
let passed = 0;
const audio = Buffer.alloc(256, 7);
const writer = {
  async synthesize(text, { outputFile }) {
    await fs.writeFile(outputFile, audio);
  },
};
async function check(name, run) {
  await run();
  assert.deepEqual(await fs.readdir(root), [], `${name}: temporary audio must be removed`);
  passed++;
}
function fakeProcess(implementation) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => implementation(child, command, args, options));
    return child;
  };
}
function recordingEdgeProvider(calls) {
  return createEdgeTtsProvider({ spawnImpl: fakeProcess(async (child, command, args) => {
    calls.push({
      command, args: [...args],
      voice: args[args.indexOf('--voice') + 1],
      stdin: child.stdin.read().toString(),
    });
    await fs.writeFile(args.at(-1), audio);
    child.emit('close', 0);
  }) });
}

try {
  assert.equal(meta.defaultEnabled, false);
  assert.equal(meta.configSchema.find(({ key }) => key === 'speechLanguage')?.default, 'auto');
  await check('disabled', async () => {
    const result = await sendReplyVoice('retained text', {
      provider: { synthesize() { throw new Error('must not run'); } }, tempDir: root,
      sendRecord() { throw new Error('must not send'); },
    });
    assert.deepEqual(result, { sent: false, skipped: true });
  });

  await check('hook runs only after text and receives final reply', async () => {
    const events = [];
    const jobs = [];
    const ctx = {
      text: 'original reply', config: {}, ttsTempDir: root,
      afterSend(job) { jobs.push(job); },
      ttsProvider: { async synthesize(text, { outputFile }) {
        events.push(`tts:${text}`);
        await fs.writeFile(outputFile, audio);
      } },
      async sendRecord(file) {
        assert.match(file, /^base64:\/\//);
        assert.deepEqual(Buffer.from(file.slice('base64://'.length), 'base64'), audio);
        events.push('record');
      },
    };
    assert.equal(await afterReply(ctx), undefined);
    assert.equal(ctx.text, 'original reply');
    assert.deepEqual(events, []);
    assert.equal(jobs.length, 1);
    events.push('text:decorated reply');
    assert.deepEqual(await jobs[0]({ text: 'decorated reply' }), { sent: true });
    assert.deepEqual(events, ['text:decorated reply', 'tts:decorated reply', 'record']);
    await afterReply({ ...ctx, afterSend: undefined });
    assert.equal(jobs.length, 1, 'generic plugin chain must not schedule TTS twice');
  });

  await check('provider failure preserves reply and hides details', async () => {
    const logs = [];
    let sends = 0;
    const result = await sendReplyVoice('retained text', {
      enabled: true, tempDir: root,
      provider: { async synthesize(text, { outputFile }) {
        await fs.writeFile(outputFile, audio);
        throw new Error('Bearer private-token Cookie=private-cookie');
      } },
      sendRecord() { sends++; }, log: { warn(message) { logs.push(message); } },
    });
    assert.deepEqual(result, { sent: false, error: 'tts_provider_failed' });
    assert.equal(sends, 0);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /private-token|private-cookie/);
  });

  await check('OneBot failure is isolated', async () => {
    const result = await sendReplyVoice('retained text', {
      enabled: true, provider: writer, tempDir: root,
      sendRecord() { throw new Error('OneBot auth-token secret'); },
    });
    assert.deepEqual(result, { sent: false, error: 'tts_send_failed' });
  });

  await check('configured character limit preserves emoji', async () => {
    let input;
    await synthesizeSpeech(' \u{1f60a}\u{1f60a}\u{1f60a}tail ', {
      config: { maxChars: 2 }, tempDir: root,
      provider: { async synthesize(text, { outputFile }) {
        input = text;
        await fs.writeFile(outputFile, audio);
      } },
    });
    assert.equal(input, '\u{1f60a}\u{1f60a}');
  });

  await check('hard character limit', async () => {
    let input;
    await synthesizeSpeech('x'.repeat(5000), {
      config: { maxChars: 5000 }, tempDir: root,
      provider: { async synthesize(text, { outputFile }) {
        input = text;
        await fs.writeFile(outputFile, audio);
      } },
    });
    assert.equal(input.length, TTS_LIMITS.maxTextChars);
  });

  await check('invalid audio', async () => {
    await assert.rejects(synthesizeSpeech('hello', {
      tempDir: root,
      provider: { async synthesize(text, { outputFile }) { await fs.writeFile(outputFile, 'empty'); } },
    }), /tts_audio_invalid/);
  });

  await check('oversize audio', async () => {
    await assert.rejects(synthesizeSpeech('hello', {
      tempDir: root,
      provider: { async synthesize(text, { outputFile }) {
        const file = await fs.open(outputFile, 'w');
        try { await file.truncate(TTS_LIMITS.maxAudioBytes + 1); } finally { await file.close(); }
      } },
    }), /tts_audio_invalid/);
  });

  await check('unknown provider is rejected', async () => {
    await assert.rejects(synthesizeSpeech('hello', { config: { provider: 'unknown' }, tempDir: root }), /tts_provider_unsupported/);
  });

  await check('API temporary files follow the selected response format', async () => {
    for (const [responseFormat, extension] of [[undefined, '.mp3'], ['wav', '.wav']]) {
      await synthesizeSpeech('format fixture', {
        config: { provider: 'openai-compatible', responseFormat }, tempDir: root,
        provider: { async synthesize(text, { outputFile }) {
          assert.equal(path.extname(outputFile), extension);
          await fs.writeFile(outputFile, audio);
        } },
      });
    }
  });

  await check('edge CLI uses stdin and awaits close', async () => {
    let stdin = '';
    let closed = false;
    const provider = createEdgeTtsProvider({ spawnImpl: fakeProcess(async (child, command, args, options) => {
      assert.equal(command, 'python');
      assert.deepEqual(args.slice(0, 4), ['-m', 'edge_tts', '--file', '-']);
      assert.equal(args.includes('private spoken text'), false);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.PYTHONUTF8, '1');
      assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
      stdin = child.stdin.read().toString();
      const outputFile = args.at(-1);
      assert.equal(path.extname(outputFile), '.mp3', 'Edge output remains MP3 regardless of API format');
      await fs.writeFile(outputFile, audio);
      child.emit('exit', 0);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((await fs.stat(outputFile)).size, audio.length, 'exit must not clean up before close');
      closed = true;
      child.emit('close', 0);
    }) });
    assert.deepEqual(await synthesizeSpeech('private spoken text 中文语音', { tempDir: root, provider, config: { responseFormat: 'wav' } }), audio);
    assert.equal(stdin, 'private spoken text 中文语音');
    assert.equal(closed, true);
  });

  await check('edge speech language selects voice without rewriting text', async () => {
    const calls = [];
    const provider = recordingEdgeProvider(calls);
    const chinese = '今天天气不错，我们出去走走吧。';
    const japanese = '今日はいい天気ですね。';

    // auto keeps the custom voice and the original text.
    await synthesizeSpeech(chinese, {
      config: { speechLanguage: 'auto', voice: 'zh-CN-YunxiNeural' }, tempDir: root, provider,
    });
    assert.equal(calls[0].voice, 'zh-CN-YunxiNeural');
    assert.equal(calls[0].stdin, chinese);

    // ja with a Chinese default voice resolves to a Japanese Edge voice.
    await synthesizeSpeech(chinese, {
      config: { speechLanguage: 'ja', voice: 'zh-CN-XiaoxiaoNeural' }, tempDir: root, provider,
    });
    assert.equal(calls[1].voice, 'ja-JP-NanamiNeural');
    assert.equal(calls[1].stdin, chinese, 'language selection must not translate the text');

    // ja keeps an already Japanese custom voice.
    await synthesizeSpeech(japanese, {
      config: { speechLanguage: 'ja', voice: 'ja-JP-KeitaNeural' }, tempDir: root, provider,
    });
    assert.equal(calls[2].voice, 'ja-JP-KeitaNeural');
    assert.equal(calls[2].stdin, japanese);

    // Switching back to auto keeps the voice currently configured.
    await synthesizeSpeech(japanese, {
      config: { speechLanguage: 'auto', voice: 'ja-JP-NanamiNeural' }, tempDir: root, provider,
    });
    assert.equal(calls[3].voice, 'ja-JP-NanamiNeural');
    assert.equal(calls[3].stdin, japanese);
    assert.equal(calls.length, 4);
  });

  await check('selected language with translation disabled keeps text and translator untouched', async () => {
    const calls = [];
    const provider = recordingEdgeProvider(calls);
    const translated = [];
    const translator = (text) => { translated.push(text); return Promise.resolve('must not be used'); };
    const chinese = '这句中文保持原样。';
    const japanese = 'この日本語はそのまま。';

    await synthesizeSpeech(chinese, {
      config: { speechLanguage: 'ja', translationEnabled: false, voice: 'zh-CN-XiaoxiaoNeural' },
      tempDir: root, provider, translator,
    });
    assert.equal(calls[0].voice, 'ja-JP-NanamiNeural');
    assert.equal(calls[0].stdin, chinese);

    await synthesizeSpeech(japanese, {
      config: { speechLanguage: 'auto', translationEnabled: false, voice: 'ja-JP-KeitaNeural' },
      tempDir: root, provider, translator,
    });
    assert.equal(calls[1].voice, 'ja-JP-KeitaNeural');
    assert.equal(calls[1].stdin, japanese);
    assert.deepEqual(translated, [], 'translation disabled must never call the translator');
  });

  await check('invalid speech language is rejected before Edge starts', async () => {
    let spawns = 0;
    const provider = createEdgeTtsProvider({ spawnImpl: fakeProcess(async (child, command, args) => {
      spawns++;
      await fs.writeFile(args.at(-1), audio);
      child.emit('close', 0);
    }) });
    const result = await sendReplyVoice('保留的文本', {
      enabled: true, tempDir: root, provider,
      config: { provider: 'edge', speechLanguage: 'klingon', voice: 'zh-CN-XiaoxiaoNeural' },
      sendRecord() { throw new Error('must not send'); },
    });
    assert.deepEqual(result, { sent: false, error: 'tts_configuration_invalid' });
    assert.equal(spawns, 0, 'the Edge CLI must not start for an invalid speech language');
  });

  await check('timeout stops child before cleanup', async () => {
    let stopped = false;
    let closed = false;
    const provider = createEdgeTtsProvider({ spawnImpl: fakeProcess(async (child, command, args) => {
      const outputFile = args.at(-1);
      await fs.writeFile(outputFile, audio);
      child.kill = () => {
        stopped = true;
        setTimeout(async () => {
          assert.equal((await fs.stat(outputFile)).size, audio.length);
          closed = true;
          child.emit('close', 1);
        }, 20);
        return true;
      };
    }) });
    const result = await sendReplyVoice('retained text', {
      enabled: true, tempDir: root, config: { timeoutMs: 1000 }, provider,
      sendRecord() { throw new Error('must not send timed out audio'); },
    });
    assert.deepEqual(result, { sent: false, error: 'tts_timeout' });
    assert.equal(stopped, true);
    assert.equal(closed, true);
  });

  await check('already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(synthesizeSpeech('hello', { tempDir: root, provider: writer, signal: controller.signal }), /tts_aborted/);
  });

  await check('abort during synthesis stops child', async () => {
    const controller = new AbortController();
    let stopped = false;
    const provider = createEdgeTtsProvider({ spawnImpl: fakeProcess(async (child, command, args) => {
      const outputFile = args.at(-1);
      await fs.writeFile(outputFile, audio);
      child.kill = () => {
        stopped = true;
        queueMicrotask(() => child.emit('close', 1));
        return true;
      };
      controller.abort();
    }) });
    await assert.rejects(synthesizeSpeech('hello', { tempDir: root, provider, signal: controller.signal }), /tts_aborted/);
    assert.equal(stopped, true);
  });

  await check('missing Python module is sanitized', async () => {
    const provider = createEdgeTtsProvider({ spawnImpl: fakeProcess(child => {
      child.emit('error', new Error('private local executable path'));
      child.emit('close', -2);
    }) });
    const result = await sendReplyVoice('text', {
      enabled: true, tempDir: root, provider, sendRecord() { throw new Error('must not send'); },
    });
    assert.deepEqual(result, { sent: false, error: 'tts_provider_unavailable' });
  });

  console.log(`通过：语音插件 ${passed} 项（隔离模拟，无真实 TTS/OneBot 请求）`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
