import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TTS_PROVIDERS, boundedMediaBody, mediaEndpoint, mediaHeaders, validMediaBaseUrl, validMediaKey } from '../media-api.js';

const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const SPEECH_LANGUAGES = Object.freeze({
  auto: { label: '自动' },
  zh: { label: '中文', voice: 'zh-CN-XiaoxiaoNeural' },
  ja: { label: '日语', voice: 'ja-JP-NanamiNeural' },
  en: { label: '英语', voice: 'en-US-JennyNeural' },
  ko: { label: '韩语', voice: 'ko-KR-SunHiNeural' },
  fr: { label: '法语', voice: 'fr-FR-DeniseNeural' },
  de: { label: '德语', voice: 'de-DE-KatjaNeural' },
  es: { label: '西班牙语', voice: 'es-ES-ElviraNeural' },
  it: { label: '意大利语', voice: 'it-IT-ElsaNeural' },
  pt: { label: '葡萄牙语', voice: 'pt-BR-FranciscaNeural' },
  ru: { label: '俄语', voice: 'ru-RU-SvetlanaNeural' },
});
const ERROR_CODES = new Set([
  'tts_timeout', 'tts_aborted', 'tts_provider_unavailable', 'tts_provider_failed',
  'tts_provider_unsupported', 'tts_empty_text', 'tts_audio_invalid', 'tts_send_failed', 'tts_configuration_invalid',
  'tts_translation_unavailable', 'tts_translation_failed', 'tts_translation_timeout',
]);

export const meta = {
  name: 'reply-tts',
  displayName: '回复语音',
  version: '1.4.0',
  description: '在 QQ 文字回复后附加语音，支持 Edge TTS、OpenAI、硅基流动和兼容服务。',
  defaultEnabled: false,
  configSchema: [
    { key: 'provider', type: 'select', label: 'TTS 平台', default: 'edge', options: Object.entries(TTS_PROVIDERS).map(([value, p]) => ({ value, label: p.label })) },
    { key: 'speechLanguage', type: 'select', label: '语音语种', default: 'auto',
      options: Object.entries(SPEECH_LANGUAGES).map(([value, { label }]) => ({ value, label,
        ...(value === 'auto' ? {} : { providers: ['edge', 'openai-compatible'] }) })) },
    { key: 'voice', type: 'string', label: 'Edge TTS 音色', default: 'zh-CN-XiaoxiaoNeural', providers: ['edge'],
      presetsBy: 'speechLanguage', preserveMatchingPrefix: true,
      presets: Object.fromEntries(Object.entries(SPEECH_LANGUAGES).filter(([, p]) => p.voice).map(([value, p]) => [value, p.voice])) },
    { key: 'python', type: 'string', label: '已安装 edge-tts 的 Python 命令', default: 'python', providers: ['edge'] },
    ...['baseUrl', 'model', 'apiVoice'].map((key) => ({ key, type: 'string', default: '',
      label: { baseUrl: 'API 服务地址（可含 /v1）', model: '语音模型', apiVoice: 'API 音色（自定义兼容可留空）' }[key],
      providers: ['openai', 'siliconflow', 'openai-compatible'],
      presets: Object.fromEntries(Object.entries(TTS_PROVIDERS).map(([provider, p]) => [provider, p[key]])),
    })),
    { key: 'responseFormat', type: 'select', label: '音频格式', default: 'mp3',
      options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }],
      providers: ['openai', 'siliconflow', 'openai-compatible'] },
    { key: 'apiKey', type: 'secret', label: 'API 密钥（可选）', default: '', providers: ['openai', 'siliconflow', 'openai-compatible'] },
    { key: 'translationEnabled', type: 'bool', label: '合成前翻译', default: false },
    { key: 'targetLanguage', type: 'string', label: '翻译目标语言', default: '日语', visibleWhen: { translationEnabled: true } },
    { key: 'translationPrompt', type: 'text', label: '附加翻译要求（可选）', default: '', visibleWhen: { translationEnabled: true } },
    { key: 'translationTimeoutMs', type: 'int', label: '翻译超时（毫秒）', default: 60000, visibleWhen: { translationEnabled: true } },
    { key: 'maxChars', type: 'int', label: '单段语音最大字符数', default: 600 },
    { key: 'timeoutMs', type: 'int', label: '合成超时（毫秒）', default: 60000 },
  ],
};

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function settingsOf(config = {}) {
  const defaults = Object.fromEntries(meta.configSchema.map(({ key, default: value }) => [key, value]));
  const settings = { ...defaults, ...config };
  settings.maxChars = boundedNumber(settings.maxChars, 600, 1, MAX_TEXT_CHARS);
  settings.timeoutMs = boundedNumber(settings.timeoutMs, 60000, 1000, 120000);
  const preset = TTS_PROVIDERS[settings.provider];
  for (const key of ['baseUrl', 'model', 'apiVoice']) settings[key] = String(settings[key] || preset?.[key] || '').trim();
  settings.responseFormat = String(settings.responseFormat ?? 'mp3').trim();
  settings.speechLanguage = String(settings.speechLanguage ?? 'auto').trim();
  const languageVoice = SPEECH_LANGUAGES[settings.speechLanguage]?.voice;
  if (settings.provider === 'edge' && languageVoice && !String(settings.voice).startsWith(`${settings.speechLanguage}-`)) {
    settings.voice = languageVoice;
  }
  settings.translationEnabled = settings.translationEnabled === true;
  settings.targetLanguage = String(settings.targetLanguage ?? '日语').trim();
  settings.translationPrompt = String(settings.translationPrompt ?? '').trim();
  settings.translationTimeoutMs = boundedNumber(settings.translationTimeoutMs, 60000, 1000, 120000);
  return settings;
}

export function validateTtsConfig(config = {}) {
  const settings = settingsOf(config);
  if (!Object.hasOwn(TTS_PROVIDERS, settings.provider)) throw new Error('tts_provider_unsupported');
  if (!Object.hasOwn(SPEECH_LANGUAGES, settings.speechLanguage) ||
      (!['edge', 'openai-compatible'].includes(settings.provider) && settings.speechLanguage !== 'auto')) {
    throw new Error('tts_configuration_invalid');
  }
  if (settings.translationEnabled && (!settings.targetLanguage || settings.targetLanguage.length > 80 ||
      /[\r\n\0]/.test(settings.targetLanguage) || settings.translationPrompt.length > 4000 ||
      settings.translationPrompt.includes('\0'))) throw new Error('tts_configuration_invalid');
  if (settings.provider !== 'edge' && !validMediaKey(settings.apiKey)) throw new Error('tts_configuration_invalid');
  if (settings.provider !== 'edge' && (!validMediaBaseUrl(settings.baseUrl) ||
      !settings.model || settings.model.length > 200 || (!settings.apiVoice && settings.provider !== 'openai-compatible') || settings.apiVoice.length > 200 ||
      !['mp3', 'wav'].includes(settings.responseFormat) ||
      /[\r\n\0]/.test(`${settings.model}${settings.apiVoice}`))) throw new Error('tts_configuration_invalid');
  return settings;
}

function cleanText(text, maxChars) {
  return Array.from(String(text ?? '').trim().slice(0, maxChars * 2)).slice(0, maxChars).join('');
}

function errorCode(error, fallback = 'tts_provider_failed') {
  return ERROR_CODES.has(error?.message) ? error.message : fallback;
}

async function speechText(text, settings, translator, signal) {
  if (!settings.translationEnabled) return text;
  if (typeof translator !== 'function') throw new Error('tts_translation_unavailable');
  const timeout = AbortSignal.timeout(settings.translationTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(new Error(signal?.aborted ? 'tts_aborted' : 'tts_translation_timeout'));
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) onAbort();
  });
  try {
    const translated = await Promise.race([
      Promise.resolve().then(() => translator(text, {
        targetLanguage: settings.targetLanguage, translationPrompt: settings.translationPrompt,
        maxChars: settings.maxChars, timeoutMs: settings.translationTimeoutMs, signal: combined,
      })),
      stopped,
    ]);
    if (combined.aborted) throw new Error('tts_aborted');
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('tts_translation_failed');
    return cleanText(translated, settings.maxChars);
  } catch {
    if (signal?.aborted) throw new Error('tts_aborted');
    if (timeout.aborted) throw new Error('tts_translation_timeout');
    throw new Error('tts_translation_failed');
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
}

function runEdge(command, args, text, { timeoutMs, signal, spawnImpl }) {
  if (signal?.aborted) return Promise.reject(new Error('tts_aborted'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch {
      reject(new Error('tts_provider_unavailable'));
      return;
    }
    let failure;
    let killTimer;
    const stop = (code) => {
      if (failure) return;
      failure = code;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref?.();
    };
    const abort = () => stop('tts_aborted');
    const timer = setTimeout(() => stop('tts_timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => { failure ||= 'tts_provider_unavailable'; });
    child.stdin?.on('error', () => { /* A stopped child may close stdin before consuming it. */ });
    // Wait for close, including after cancellation, before a caller removes temporary files.
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(new Error(failure || 'tts_provider_failed'));
      else resolve();
    });
    if (signal?.aborted) abort();
    child.stdin?.end(text);
  });
}

/** Provider contract: synthesize(text, { outputFile, speechLanguage, voice, python, timeoutMs, signal }). */
export function createEdgeTtsProvider({ spawnImpl = spawn } = {}) {
  return {
    name: 'edge',
    async synthesize(text, options) {
      const { outputFile, voice, python, timeoutMs, signal } = validateTtsConfig({ ...options, provider: 'edge' });
      if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(String(voice)) ||
          !String(python).trim() || String(python).includes('\0')) {
        throw new Error('tts_provider_failed');
      }
      // edge-tts supports --file -; keeping text on stdin avoids exposing replies in process arguments.
      await runEdge(String(python), ['-m', 'edge_tts', '--file', '-', '--voice', String(voice), '--write-media', outputFile], text, {
        timeoutMs, signal, spawnImpl,
      });
    },
  };
}

export function createApiTtsProvider({ fetchImpl = fetch } = {}) {
  return {
    name: 'api',
    async synthesize(text, options) {
      const settings = validateTtsConfig(options);
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const signal = settings.signal ? AbortSignal.any([settings.signal, timeout]) : timeout;
      try {
        const response = await fetchImpl(mediaEndpoint(settings.baseUrl, '/v1/audio/speech'), {
          method: 'POST', redirect: 'error', signal, headers: mediaHeaders(settings.apiKey, true),
          body: JSON.stringify({ model: settings.model, input: text,
            ...(settings.apiVoice ? { voice: settings.apiVoice } : {}),
            ...(settings.provider === 'openai-compatible' && settings.speechLanguage !== 'auto' ? { language: settings.speechLanguage } : {}),
            response_format: settings.responseFormat }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('tts_provider_failed'); }
        const type = (response.headers.get('content-type') || '').split(';')[0];
        if (!type.startsWith('audio/') && type !== 'application/octet-stream') {
          await response.body?.cancel(); throw new Error('tts_audio_invalid');
        }
        const audio = await boundedMediaBody(response, MAX_AUDIO_BYTES, () => new Error('tts_audio_invalid'));
        const magic = audio.subarray(0, 4).toString('ascii');
        if (audio.length < 128 || !(magic.startsWith('ID3') || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) ||
            magic === 'OggS' || magic === 'fLaC' || (magic === 'RIFF' && audio.subarray(8, 12).toString() === 'WAVE'))) {
          throw new Error('tts_audio_invalid');
        }
        if (signal.aborted) throw new Error('tts_aborted');
        await fs.writeFile(settings.outputFile, audio);
      } catch (error) {
        if (settings.signal?.aborted) throw new Error('tts_aborted');
        if (timeout.aborted) throw new Error('tts_timeout');
        throw new Error(errorCode(error));
      }
    },
  };
}

/** Providers write into this call's directory; the returned audio has no local-path dependency. */
export async function synthesizeSpeech(text, {
  config = {}, provider, translator, tempDir = os.tmpdir(), signal,
} = {}) {
  const settings = settingsOf(config);
  if (!provider) validateTtsConfig(settings);
  const selected = provider ?? (settings.provider === 'edge' ? createEdgeTtsProvider() : createApiTtsProvider());
  if (typeof selected?.synthesize !== 'function') throw new Error('tts_provider_unsupported');
  const clean = cleanText(text, settings.maxChars);
  if (!clean) throw new Error('tts_empty_text');
  if (signal?.aborted) throw new Error('tts_aborted');
  const spoken = await speechText(clean, settings, translator, signal);
  if (signal?.aborted) throw new Error('tts_aborted');
  const directory = await fs.mkdtemp(path.join(tempDir, 'qq-tts-'));
  const extension = settings.provider !== 'edge' && settings.responseFormat === 'wav' ? 'wav' : 'mp3';
  const outputFile = path.join(directory, `reply.${extension}`);
  try {
    await selected.synthesize(spoken, { ...settings, outputFile, signal });
    if (signal?.aborted) throw new Error('tts_aborted');
    const stat = await fs.lstat(outputFile);
    if (!stat.isFile() || stat.size < 128 || stat.size > MAX_AUDIO_BYTES) throw new Error('tts_audio_invalid');
    return await fs.readFile(outputFile);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function sendReplyVoice(text, {
  enabled = false, config = {}, sendRecord, log, provider, translator, tempDir, signal,
} = {}) {
  if (!enabled || typeof sendRecord !== 'function') return { sent: false, skipped: true };
  if (!String(text ?? '').trim()) return { sent: false, skipped: true };
  let phase = 'synthesis';
  try {
    const audio = await synthesizeSpeech(text, { config, provider, translator, tempDir, signal });
    if (signal?.aborted) throw new Error('tts_aborted');
    phase = 'send';
    if (await sendRecord(`base64://${audio.toString('base64')}`) === false) throw new Error('tts_send_failed');
    return { sent: true };
  } catch (error) {
    const code = errorCode(error, phase === 'send' ? 'tts_send_failed' : 'tts_provider_failed');
    log?.warn?.(`回复语音失败（${code}）`);
    return { sent: false, error: code };
  }
}

/** Register work before delivery and execute it only after the final text reply succeeds. */
export async function afterReply(ctx) {
  if (typeof ctx?.afterSend !== 'function' || typeof ctx?.sendRecord !== 'function') return;
  ctx.afterSend(({ text } = {}) => sendReplyVoice(text ?? ctx.text, {
    enabled: true,
    config: ctx.config,
    sendRecord: ctx.sendRecord,
    log: ctx.log,
    signal: ctx.signal,
    provider: ctx.ttsProvider,
    translator: ctx.ttsTranslator,
    tempDir: ctx.ttsTempDir,
  }));
}

export const TTS_LIMITS = Object.freeze({ maxTextChars: MAX_TEXT_CHARS, maxAudioBytes: MAX_AUDIO_BYTES });
