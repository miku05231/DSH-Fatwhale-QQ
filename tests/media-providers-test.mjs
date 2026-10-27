import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createImageClient } from '../src/imagegen-client.js';
import { createImagegenService } from '../src/imagegen.js';
import { mediaEndpoint, mediaHeaders } from '../src/media-api.js';
import { sendReplyVoice, synthesizeSpeech, validateTtsConfig } from '../src/plugins/reply-tts.js';
import { createConsoleFixture } from './helpers/isolated-fixtures.mjs';
import { createImagegenFixture } from './helpers/imagegen-fixture.mjs';

const secret = 'fixture-media-key-DO-NOT-ECHO';
const fixtureTest = (name, fn) => test(name, async () => {
  const f = await createImagegenFixture();
  try { await fn(f); } finally { await f.close(); }
});
const imageSettings = (f, provider = 'openai-compatible') => {
  f.config.imagegen = { ...f.config.imagegen, provider, model: 'fixture-model', apiKey: secret, baseUrl: `${f.baseUrl}/proxy/v1` };
  f.state.mode = provider === 'siliconflow' ? 'syncSiliconflow' : 'syncBase64';
  f.save();
  return f.config.imagegen;
};

test('media URLs accept root or /v1 prefixes without duplication; blank keys omit auth', () => {
  for (const [base, expected] of [
    ['https://example.com', 'https://example.com/v1/audio/speech'],
    ['https://example.com/v1/', 'https://example.com/v1/audio/speech'],
    ['https://example.com/proxy/v1', 'https://example.com/proxy/v1/audio/speech'],
  ]) assert.equal(mediaEndpoint(base, '/v1/audio/speech').href, expected);
  assert.deepEqual(mediaHeaders(''), {});
  assert.deepEqual(mediaHeaders('   ', true), { 'Content-Type': 'application/json' });
  assert.throws(() => mediaHeaders('bad\r\nkey'));
  assert.throws(() => mediaEndpoint('https://user:pass@example.com', '/v1/audio/speech'));
});

test('Edge ignores stale API-only keys while API speech still validates authentication', () => {
  for (const apiKey of ['***', 'invalid\nkey']) {
    assert.equal(validateTtsConfig({ provider: 'edge', apiKey, responseFormat: 'stale-format' }).provider, 'edge');
    assert.throws(() => validateTtsConfig({ provider: 'openai', apiKey }), /tts_configuration_invalid/);
  }
});

fixtureTest('ComfyUI optional bearer auth covers health, submit, poll and image; no secret in jobs', async (f) => {
  f.config.imagegen.apiKey = secret; f.save();
  await f.service.check();
  const job = await f.service.generate({ prompt: 'optional comfy key' });
  assert.equal(job.status, 'completed');
  assert.ok(f.state.requests.length >= 4);
  assert.ok(f.state.requests.every((r) => r.headers.authorization === `Bearer ${secret}`));
  assert.doesNotMatch(JSON.stringify(job), /fixture-media-key/);
  assert.doesNotMatch(await fs.readFile(path.join(f.service.runtimeDir, 'jobs', `${job.id}.json`), 'utf8'), /fixture-media-key/);
  f.config.imagegen.apiKey = ''; f.save(); f.state.requests.length = 0;
  assert.equal((await f.service.generate({ prompt: 'no authentication' })).status, 'completed');
  assert.ok(f.state.requests.every((r) => r.headers.authorization === undefined));
});

for (const provider of ['openai', 'siliconflow', 'openai-compatible']) fixtureTest(`${provider} image mapping, authenticated URLs and local verified result`, async (f) => {
  imageSettings(f, provider);
  await f.service.check();
  const input = { prompt: 'provider fixture', preset: 'portrait', negative_prompt: 'blur' };
  if (provider === 'siliconflow') Object.assign(input, { steps: 9, cfg: 0, seed: '9999999999' });
  const job = await f.service.generate(input);
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual((await f.service.artifact(job.id)).buffer, f.state.png);
  assert.equal(f.state.posts.length, 1);
  const body = JSON.parse(f.state.posts[0].body);
  assert.equal(body.model, 'fixture-model');
  if (provider === 'siliconflow') {
    assert.equal(body.image_size, '768x1344');
    assert.equal(body.num_inference_steps, 9);
    assert.equal(body.guidance_scale, 0);
    assert.equal(body.seed, 9999999999);
    assert.equal(body.negative_prompt, 'blur');
    assert.equal(body.width, undefined);
    assert.equal(body.batch_size, undefined);
  } else {
    assert.equal(body.size, provider === 'openai' ? '1024x1536' : '768x1344');
    assert.match(body.prompt, /Avoid: blur/);
    assert.equal(body.n, 1);
    assert.equal(body.width, undefined);
  }
  assert.ok(f.state.requests.every((r) => r.headers.authorization === `Bearer ${secret}`));
  assert.equal(f.state.requests[0].url, '/proxy/v1/models');
  assert.equal(f.state.requests[1].url, '/proxy/v1/images/generations');
  assert.doesNotMatch(JSON.stringify(job), /fixture-media-key/);
});

fixtureTest('GPT Image omits response_format and image POST allows a full generation timeout', async (f) => {
  const settings = imageSettings(f, 'openai'); settings.model = 'gpt-image-1';
  settings.requestTimeoutMs = 100; settings.timeoutMs = 2000;
  let wire;
  const client = createImageClient(settings, { fetchImpl: async (url, options) => {
    wire = JSON.parse(options.body);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    return new Response(JSON.stringify({ data: [{ b64_json: f.state.png.toString('base64') }] }));
  } });
  const result = await client.submit({ prompt: 'timeout fixture', width: 1344, height: 768 });
  assert.equal(result.status, 'completed');
  assert.equal(wire.size, '1536x1024');
  assert.equal(wire.response_format, undefined);
});

fixtureTest('synchronous image response above 1MiB and recovery use cached data without a second POST', async (f) => {
  imageSettings(f);
  f.state.png = Buffer.concat([f.state.png, Buffer.alloc(1024 * 1024)]);
  const job = await f.service.generate({ prompt: 'large synchronous result' });
  assert.equal(job.status, 'completed', job.error);
  await f.service.update(job.id, (record) => { record.status = 'paused'; record.artifact = null; record.worker = null; });
  const restarted = createImagegenService({ configPath: f.configPath });
  f.config.imagegen.provider = 'openai'; f.save();
  await assert.rejects(() => restarted.resume(job.id), /平台或地址已变更/);
  f.config.imagegen.provider = 'openai-compatible'; f.save();
  assert.equal((await restarted.resume(job.id)).status, 'completed');
  assert.equal(f.state.posts.length, 1);
  const recovered = (await restarted.artifact(job.id)).buffer;
  assert.equal(recovered.length, f.state.png.length);
  assert.ok(recovered.equals(f.state.png));
});

fixtureTest('same-origin URL result and blank keys work for a local compatible provider', async (f) => {
  imageSettings(f); f.state.mode = 'syncUrl';
  f.config.imagegen.apiKey = ''; f.save();
  assert.equal((await f.service.generate({ prompt: 'local keyless synchronous image' })).status, 'completed');
  assert.ok(f.state.requests.every((r) => !r.headers.authorization));
});

fixtureTest('foreign image downloads never receive the API key and unsafe URLs are rejected', async (f) => {
  const settings = imageSettings(f);
  const requests = [];
  const client = createImageClient(settings, { fetchImpl: async (url, options) => {
    requests.push({ url: url.href, ...options });
    return new Response(f.state.png);
  } });
  assert.deepEqual(await client.download({ url: 'https://cdn.example.com/result.png?signature=fixture' }), f.state.png);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].redirect, 'error');
  await assert.rejects(() => client.download({ url: 'http://foreign.example/result.png' }), /不安全/);
  await assert.rejects(() => client.download({ url: 'https://user:pass@foreign.example/result.png' }), /不安全/);
  assert.equal(requests.length, 1);
});

fixtureTest('unsupported parameters fail before submit and malformed synchronous data cannot become an artifact', async (f) => {
  imageSettings(f, 'openai');
  for (const extra of [{ steps: 8 }, { seed: '0' }, { cfg: 7 }]) {
    await assert.rejects(() => f.service.generate({ prompt: 'unsupported', ...extra }), /不支持/);
  }
  assert.equal(f.state.posts.length, 0);
  imageSettings(f, 'siliconflow');
  await assert.rejects(() => f.service.generate({ prompt: 'seed limit', seed: '10000000000' }), /seed/);
  assert.equal(f.state.posts.length, 0);
  imageSettings(f); f.state.mode = 'syncBadBase64';
  const job = await f.service.generate({ prompt: 'bad bytes' });
  assert.equal(job.status, 'failed');
  assert.equal(job.artifact, null);
});

fixtureTest('lost synchronous response is unknown and never automatically resubmitted', async (f) => {
  imageSettings(f); f.state.mode = 'dropSubmit';
  const job = await f.service.generate({ prompt: 'lost paid response' });
  assert.equal(job.status, 'unknown');
  assert.equal((await f.service.resume(job.id)).status, 'unknown');
  assert.equal(f.state.posts.length, 1);
});

fixtureTest('reconfiguration before task reservation cannot submit the old route', async (f) => {
  const pending = f.service.generate({ prompt: 'concurrent settings update' });
  f.config.imagegen.provider = 'openai-compatible';
  f.config.imagegen.model = 'new-image-model';
  f.save();
  await assert.rejects(pending, (error) => error.code === 'IMAGEGEN_CONFIG_CHANGED' && error.statusCode === 409);
  assert.equal(f.state.posts.length, 0);
  assert.equal((await f.service.list()).length, 0);
});

for (const provider of ['openai', 'siliconflow', 'openai-compatible']) fixtureTest(`${provider} speech maps model and voice, uses binary audio, cleans temporary files`, async (f) => {
  const directory = path.join(f.root, 'audio'); await fs.mkdir(directory);
  const config = { provider, baseUrl: `${f.baseUrl}/proxy/v1`, model: 'speech-fixture', apiVoice: 'fixture-voice', apiKey: secret };
  const audio = await synthesizeSpeech('Speech fixture 中文语音', { config, tempDir: directory });
  assert.equal(audio.subarray(0, 3).toString(), 'ID3');
  assert.deepEqual(await fs.readdir(directory), []);
  assert.deepEqual(f.state.speech[0].body, { model: 'speech-fixture', input: 'Speech fixture 中文语音', voice: 'fixture-voice', response_format: 'mp3' });
  assert.equal(f.state.speech[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(f.state.speech[0].url, '/proxy/v1/audio/speech');
  const wav = await synthesizeSpeech('keyless', { config: { ...config, apiKey: '', responseFormat: 'wav' }, tempDir: directory });
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(f.state.speech[1].headers.authorization, undefined);
  assert.deepEqual(f.state.speech[1].body, { model: 'speech-fixture', input: 'keyless', voice: 'fixture-voice', response_format: 'wav' });
  assert.deepEqual(await fs.readdir(directory), []);
});

fixtureTest('custom speech omits a blank voice and authentication, accepts WAV and sends a QQ record', async (f) => {
  const directory = path.join(f.root, 'audio'); await fs.mkdir(directory);
  const config = { provider: 'openai-compatible', baseUrl: f.baseUrl, model: 'irodori-tts', apiVoice: '   ', responseFormat: 'wav' };
  let delivered;
  const result = await sendReplyVoice('service default voice', { enabled: true, config, tempDir: directory,
    sendRecord(file) { delivered = Buffer.from(file.slice('base64://'.length), 'base64'); },
  });
  assert.deepEqual(result, { sent: true });
  assert.equal(delivered.subarray(0, 4).toString(), 'RIFF');
  assert.equal(delivered.subarray(8, 12).toString(), 'WAVE');
  assert.deepEqual(f.state.speech[0].body, { model: 'irodori-tts', input: 'service default voice', response_format: 'wav' });
  assert.equal(f.state.speech[0].headers.authorization, undefined);
  assert.equal(f.state.speech[0].url, '/v1/audio/speech');
  assert.deepEqual(await fs.readdir(directory), []);
});

fixtureTest('custom speech accepts a missing or empty voice and retains the MP3 default', async (f) => {
  for (const extra of [{}, { apiVoice: '' }]) {
    const config = { provider: 'openai-compatible', baseUrl: f.baseUrl, model: 'speech-fixture', ...extra };
    const audio = await synthesizeSpeech('default format and voice', { config, tempDir: f.root });
    assert.equal(audio.subarray(0, 3).toString(), 'ID3');
    assert.deepEqual(f.state.speech.at(-1).body, { model: 'speech-fixture', input: 'default format and voice', response_format: 'mp3' });
  }
  for (const provider of ['openai', 'siliconflow']) {
    assert.ok(validateTtsConfig({ provider, apiVoice: '' }).apiVoice, 'official platforms retain their preset voice');
  }
  assert.equal(validateTtsConfig({ provider: 'openai', responseFormat: null }).responseFormat, 'mp3');
});

fixtureTest('speech language is independent of translation and sends the original text unchanged', async (f) => {
  const config = { provider: 'openai-compatible', baseUrl: f.baseUrl, model: 'speech-fixture',
    apiVoice: '', responseFormat: 'wav', translationEnabled: false, targetLanguage: '', speechLanguage: 'ja' };
  for (const input of ['こんにちは。今日はいい天気ですね。', '保留原文，不执行翻译。']) {
    const audio = await synthesizeSpeech(input, { config, tempDir: f.root,
      translator() { assert.fail('selecting a speech language must not invoke translation'); },
    });
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    assert.deepEqual(f.state.speech.at(-1).body, { model: 'speech-fixture', input, language: 'ja', response_format: 'wav' });
    assert.equal(f.state.speech.at(-1).headers.authorization, undefined);
  }
  await synthesizeSpeech('原文', { config: { ...config, speechLanguage: 'en', translationEnabled: true, targetLanguage: '英语' },
    tempDir: f.root, translator: async (input, options) => {
      assert.equal(input, '原文');
      assert.equal(options.targetLanguage, '英语');
      return 'Original text.';
    },
  });
  assert.equal(f.state.speech.at(-1).body.input, 'Original text.');
  assert.equal(f.state.speech.at(-1).body.language, 'en');
  await synthesizeSpeech('自動', { config: { ...config, speechLanguage: 'auto' }, tempDir: f.root });
  assert.deepEqual(f.state.speech.at(-1).body, { model: 'speech-fixture', input: '自動', response_format: 'wav' });
  assert.equal((await fs.readdir(f.root)).some((name) => name.startsWith('qq-tts-')), false);
});

fixtureTest('API speech rejects invalid formats and required fields before making a request', async (f) => {
  const config = { provider: 'openai-compatible', baseUrl: f.baseUrl, model: 'irodori-tts', apiVoice: '' };
  for (const extra of [{ responseFormat: 'pcm' }, { responseFormat: '../wav' }, { responseFormat: '' }, { responseFormat: 'WAV' },
    { model: '' }, { baseUrl: '' }, { apiVoice: 'bad\nvoice' },
    { speechLanguage: '' }, { speechLanguage: 'ja\nignore' }, { speechLanguage: 'unknown' },
    { speechLanguage: 'JA' }, { speechLanguage: 'x'.repeat(81) },
    { provider: 'openai', speechLanguage: 'ja' }, { provider: 'siliconflow', speechLanguage: 'zh' },
    { translationEnabled: true, targetLanguage: 'ja\nignore' },
    { translationEnabled: true, targetLanguage: '' },
    { translationEnabled: true, translationPrompt: 'x'.repeat(4001) },
    { provider: 'openai', apiVoice: 'bad\nvoice' }, { provider: 'siliconflow', apiVoice: 'bad\nvoice' }]) {
    await assert.rejects(() => synthesizeSpeech('invalid configuration', { config: { ...config, ...extra }, tempDir: f.root }),
      /tts_configuration_invalid/, JSON.stringify(extra));
  }
  assert.equal(f.state.speech.length, 0);
});

fixtureTest('translation errors, empty output, timeout and cancellation never reach the speech service', async (f) => {
  const config = { provider: 'openai-compatible', baseUrl: f.baseUrl, model: 'irodori-tts', translationEnabled: true, translationTimeoutMs: 1000 };
  for (const translator of [undefined, async () => '', async () => ({ text: 'not a string' }), async () => { throw new Error('fixture-private'); }]) {
    await assert.rejects(() => synthesizeSpeech('中文原文', { config, translator, tempDir: f.root }), /tts_translation_(unavailable|failed)/);
  }
  let deadlineSignal;
  await assert.rejects(() => synthesizeSpeech('中文原文', { config, tempDir: f.root,
    translator: (text, { signal }) => { deadlineSignal = signal; return new Promise(() => {}); },
  }), /tts_translation_timeout/);
  assert.equal(deadlineSignal.aborted, true);
  const controller = new AbortController();
  await assert.rejects(() => synthesizeSpeech('中文原文', { config, tempDir: f.root, signal: controller.signal,
    translator: async () => { controller.abort(); return 'こんにちは。'; },
  }), /tts_aborted/);
  assert.equal(f.state.speech.length, 0);
  assert.equal((await fs.readdir(f.root)).some((name) => name.startsWith('qq-tts-')), false);
});

fixtureTest('speech HTTP errors, JSON, invalid audio and oversized bodies retain text, hide secrets and do not retry', async (f) => {
  const directory = path.join(f.root, 'audio'); await fs.mkdir(directory);
  for (const [mode, code] of [['audioHttpError', 'tts_provider_failed'], ['audioJson', 'tts_audio_invalid'], ['audioInvalid', 'tts_audio_invalid'], ['audioLarge', 'tts_audio_invalid']]) {
    f.state.mode = mode;
    const logs = [];
    const result = await sendReplyVoice('keep the original reply', { enabled: true, tempDir: directory,
      config: { provider: 'openai', baseUrl: f.baseUrl, apiKey: secret }, log: { warn: (line) => logs.push(line) },
      sendRecord() { assert.fail('invalid audio must not be sent'); },
    });
    assert.equal(result.error, code);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /fixture-media-key|Bearer/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
  assert.equal(f.state.speech.length, 4);
});

fixtureTest('speech timeout and cancellation abort the request and remove temporary audio', async (f) => {
  const directory = path.join(f.root, 'audio'); await fs.mkdir(directory);
  f.state.mode = 'audioWait';
  const config = { provider: 'openai', baseUrl: f.baseUrl, timeoutMs: 1000 };
  await assert.rejects(() => synthesizeSpeech('timeout', { config, tempDir: directory }), /tts_timeout/);
  const controller = new AbortController();
  const pending = synthesizeSpeech('cancelled', { config, tempDir: directory, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 40);
  try { await assert.rejects(() => pending, /tts_aborted/); } finally { clearTimeout(timer); }
  assert.deepEqual(await fs.readdir(directory), []);
});

fixtureTest('console preserves/replaces/clears image and speech keys without exposing them', async (f) => {
  f.config.plugins = { enabled: true, dir: path.resolve('src/plugins'),
    'reply-tts': { provider: 'openai', baseUrl: f.baseUrl, apiKey: secret } };
  f.config.imagegen.apiKey = secret; f.save();
  const consoleFixture = await createConsoleFixture(f.root);
  try {
    const origin = consoleFixture.instance.url.replace(/\/$/, '');
    const rawBootstrap = await (await fetch(`${origin}/api/imagegen`)).text();
    assert.ok(!rawBootstrap.includes(secret));
    const bootstrap = JSON.parse(rawBootstrap).data;
    assert.equal(bootstrap.settings.apiKey, undefined);
    assert.equal(bootstrap.settings.hasApiKey, true);
    const putImage = async (body) => {
      const response = await fetch(`${origin}/api/imagegen/settings`, { method: 'PUT', headers: {
        'Content-Type': 'application/json', 'X-QQ-Imagegen-Token': bootstrap.imagegenToken,
      }, body: JSON.stringify(body) });
      const raw = await response.text(); assert.ok(!raw.includes(secret));
      return { status: response.status, ...JSON.parse(raw) };
    };
    const disk = async () => JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal((await putImage({ timeoutMs: 4000 })).data.settings.hasApiKey, true);
    assert.equal((await disk()).imagegen.apiKey, secret);
    assert.equal((await putImage({ apiKey: '' })).data.settings.hasApiKey, false);
    assert.equal((await disk()).imagegen.apiKey, '');
    await putImage({ apiKey: secret });
    await putImage({ provider: 'openai', model: 'gpt-image-1', baseUrl: `${f.baseUrl}/v1` });
    assert.equal((await disk()).imagegen.apiKey, '', 'changing platforms must clear the old key');

    const snapshot = await (await fetch(`${origin}/api/plugins`)).text();
    assert.ok(!snapshot.includes(secret));
    const tts = JSON.parse(snapshot).data.plugins.find((p) => p.name === 'reply-tts');
    assert.equal(tts.secretFields.apiKey, true);
    assert.equal(tts.config.apiKey, undefined);
    const putTts = async (config) => {
      const response = await fetch(`${origin}/api/plugins/reply-tts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
      const raw = await response.text(); assert.ok(!raw.includes(secret));
      return { status: response.status, ...JSON.parse(raw) };
    };
    assert.equal((await putTts({ maxChars: 100 })).status, 200);
    assert.equal((await disk()).plugins['reply-tts'].apiKey, secret);
    assert.equal((await putTts({ apiKey: '' })).status, 200);
    assert.equal((await disk()).plugins['reply-tts'].apiKey, '');
    await putTts({ apiKey: secret });
    await putTts({ baseUrl: `${f.baseUrl}/v1` });
    assert.equal((await disk()).plugins['reply-tts'].apiKey, '');
    await putTts({ apiKey: secret });
    await putTts({ provider: 'siliconflow' });
    assert.equal((await disk()).plugins['reply-tts'].apiKey, '');
    assert.equal((await putTts({ provider: 'openai-compatible', baseUrl: f.baseUrl,
      model: 'irodori-tts', apiVoice: '', responseFormat: 'wav', translationEnabled: true,
      targetLanguage: '日语', translationPrompt: '使用自然口语。', translationTimeoutMs: 45000 })).status, 200);
    const customSpeech = (await disk()).plugins['reply-tts'];
    assert.equal(customSpeech.provider, 'openai-compatible');
    assert.equal(customSpeech.model, 'irodori-tts');
    assert.equal(customSpeech.apiVoice, '');
    assert.equal(customSpeech.responseFormat, 'wav');
    assert.equal(customSpeech.translationEnabled, true);
    assert.equal(customSpeech.targetLanguage, '日语');
    assert.equal(customSpeech.translationPrompt, '使用自然口语。');
    assert.equal(customSpeech.translationTimeoutMs, 45000);
    assert.equal((await putTts({ speechLanguage: 'ja', translationEnabled: false })).status, 200);
    const directSpeech = (await disk()).plugins['reply-tts'];
    assert.equal(directSpeech.speechLanguage, 'ja');
    assert.equal(directSpeech.translationEnabled, false);
    assert.equal(directSpeech.targetLanguage, '日语', 'disabling translation preserves its saved preferences');
    const reloadedTts = (await (await fetch(`${origin}/api/plugins`)).json()).data.plugins.find((p) => p.name === 'reply-tts');
    assert.equal(reloadedTts.config.speechLanguage, 'ja');
    assert.equal(reloadedTts.config.translationEnabled, false);
    const before = await fs.readFile(f.configPath, 'utf8');
    assert.equal((await putTts({ apiKey: '***' })).status, 400);
    assert.equal((await putTts({ provider: 'unknown' })).status, 400);
    assert.equal((await putTts({ baseUrl: 'file:///tmp' })).status, 400);
    assert.equal((await putTts({ responseFormat: 'unsupported' })).status, 400);
    assert.equal((await putTts({ speechLanguage: 'unsupported' })).status, 400);
    assert.equal((await putTts({ translationEnabled: true, targetLanguage: '' })).status, 400);
    assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
    assert.equal((await putTts({ provider: 'edge', speechLanguage: 'ja', voice: 'zh-CN-XiaoxiaoNeural' })).status, 200);
    assert.equal((await disk()).plugins['reply-tts'].voice, 'ja-JP-NanamiNeural', 'saved voice must match the runtime selection');
    assert.equal((await putTts({ voice: 'ja-JP-KeitaNeural' })).status, 200);
    assert.equal((await disk()).plugins['reply-tts'].voice, 'ja-JP-KeitaNeural');
  } finally { await consoleFixture.close(); }
});

fixtureTest('unfinished image tasks preserve their route while keys and enablement remain editable', async (f) => {
  f.config.imagegen.baseUrl = `${f.baseUrl}/`;
  f.config.imagegen.apiKey = secret;
  f.save();
  f.state.mode = 'dropSubmit';
  const job = await f.service.generate({ prompt: 'unconfirmed generation' });
  assert.equal(job.status, 'unknown');
  assert.equal(job.server.baseUrl, f.baseUrl, 'task snapshots canonicalize the service URL');
  const consoleFixture = await createConsoleFixture(f.root);
  try {
    const origin = consoleFixture.instance.url.replace(/\/$/, '');
    const { data } = await (await fetch(`${origin}/api/imagegen`)).json();
    const put = (body) => fetch(`${origin}/api/imagegen/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-QQ-Imagegen-Token': data.imagegenToken },
      body: JSON.stringify(body),
    });
    const before = await fs.readFile(f.configPath, 'utf8');
    for (const change of [{ baseUrl: 'http://127.0.0.1:8199' }, { model: 'other-model' },
      { provider: 'openai-compatible', model: 'fixture-model' }]) {
      assert.equal((await put(change)).status, 409);
      assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
    }
    const disabled = await put({ apiKey: '', enabled: false });
    assert.equal(disabled.status, 200);
    const disabledView = (await disabled.json()).data.settings;
    assert.equal(disabledView.hasApiKey, false);
    assert.equal(disabledView.enabled, false);
    let saved = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal(saved.imagegen.apiKey, '');
    assert.equal(saved.imagegen.enabled, false);
    assert.equal((await put({ enabled: true })).status, 200);
    saved = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal(saved.imagegen.enabled, true);
    await f.service.release(job.id);
    assert.equal((await f.service.get(job.id)).status, 'released');
    assert.equal((await put({ provider: 'openai-compatible', model: 'fixture-model' })).status, 200);
    saved = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal(saved.imagegen.provider, 'openai-compatible');
    assert.equal(saved.imagegen.model, 'fixture-model');
    assert.equal(f.state.posts.length, 1, 'release and reconfiguration must not resubmit generation');
  } finally { await consoleFixture.close(); }
});
