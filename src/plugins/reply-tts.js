import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ERROR_CODES = new Set([
  'tts_timeout', 'tts_aborted', 'tts_provider_unavailable', 'tts_provider_failed',
  'tts_provider_unsupported', 'tts_empty_text', 'tts_audio_invalid', 'tts_send_failed',
]);

export const meta = {
  name: 'reply-tts',
  displayName: '回复语音',
  version: '1.0.0',
  description: '使用 Edge TTS 在 QQ 回复后附加语音，保留原文字回复。',
  defaultEnabled: false,
  configSchema: [
    { key: 'provider', type: 'select', label: 'TTS 引擎', default: 'edge', options: ['edge'] },
    { key: 'voice', type: 'string', label: 'Edge TTS 音色', default: 'zh-CN-XiaoxiaoNeural' },
    { key: 'python', type: 'string', label: '已安装 edge-tts 的 Python 命令', default: 'python' },
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
  return settings;
}

function cleanText(text, maxChars) {
  return Array.from(String(text ?? '').trim().slice(0, maxChars * 2)).slice(0, maxChars).join('');
}

function errorCode(error, fallback = 'tts_provider_failed') {
  return ERROR_CODES.has(error?.message) ? error.message : fallback;
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

/** Provider contract: synthesize(text, { outputFile, voice, python, timeoutMs, signal }). */
export function createEdgeTtsProvider({ spawnImpl = spawn } = {}) {
  return {
    name: 'edge',
    async synthesize(text, { outputFile, voice, python, timeoutMs, signal }) {
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

/** Providers write into this call's directory; the returned audio has no local-path dependency. */
export async function synthesizeSpeech(text, {
  config = {}, provider, tempDir = os.tmpdir(), signal,
} = {}) {
  const settings = settingsOf(config);
  if (settings.provider !== 'edge' && !provider) throw new Error('tts_provider_unsupported');
  const selected = provider ?? createEdgeTtsProvider();
  if (typeof selected?.synthesize !== 'function') throw new Error('tts_provider_unsupported');
  const clean = cleanText(text, settings.maxChars);
  if (!clean) throw new Error('tts_empty_text');
  if (signal?.aborted) throw new Error('tts_aborted');
  const directory = await fs.mkdtemp(path.join(tempDir, 'qq-tts-'));
  const outputFile = path.join(directory, 'reply.mp3');
  try {
    await selected.synthesize(clean, { ...settings, outputFile, signal });
    if (signal?.aborted) throw new Error('tts_aborted');
    const stat = await fs.lstat(outputFile);
    if (!stat.isFile() || stat.size < 128 || stat.size > MAX_AUDIO_BYTES) throw new Error('tts_audio_invalid');
    return await fs.readFile(outputFile);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function sendReplyVoice(text, {
  enabled = false, config = {}, sendRecord, log, provider, tempDir, signal,
} = {}) {
  if (!enabled || typeof sendRecord !== 'function') return { sent: false, skipped: true };
  if (!String(text ?? '').trim()) return { sent: false, skipped: true };
  let phase = 'synthesis';
  try {
    const audio = await synthesizeSpeech(text, { config, provider, tempDir, signal });
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
    tempDir: ctx.ttsTempDir,
  }));
}

export const TTS_LIMITS = Object.freeze({ maxTextChars: MAX_TEXT_CHARS, maxAudioBytes: MAX_AUDIO_BYTES });
