import { afterReply } from './plugins/reply-tts.js';

function warn(log, code) {
  try { log?.warn?.(`回复发送未完成（${code}）`); } catch { /* Logging must not change delivery results. */ }
}

/** sendText must resolve true only after every text chunk succeeds. */
export async function deliverTextAndVoice(text, {
  sendText, voiceEnabled = false, voiceConfig = {}, sendRecord, log, signal,
  ttsProvider, ttsTranslator, ttsTempDir,
} = {}) {
  const outgoing = String(text ?? '');
  const jobs = [];
  let registrationFailed = false;
  if (voiceEnabled === true && typeof sendRecord === 'function') {
    try {
      // This built-in hook has no access to the privileged user-plugin execution path.
      await afterReply({
        text: outgoing, config: voiceConfig, sendRecord, log, signal, ttsProvider, ttsTranslator, ttsTempDir,
        afterSend(job) { if (typeof job === 'function') jobs.push(job); },
      });
    } catch {
      registrationFailed = true;
    }
  }

  try {
    if (typeof sendText !== 'function' || await sendText(outgoing) !== true) {
      warn(log, 'text_send_failed');
      return { textSent: false, voiceSent: false, error: 'text_send_failed' };
    }
  } catch {
    warn(log, 'text_send_failed');
    return { textSent: false, voiceSent: false, error: 'text_send_failed' };
  }

  if (registrationFailed) {
    warn(log, 'voice_delivery_failed');
    return { textSent: true, voiceSent: false, error: 'voice_delivery_failed' };
  }
  if (!jobs.length) return { textSent: true, voiceSent: false, voiceSkipped: true };
  try {
    const result = await jobs[0]({ text: outgoing });
    if (result?.sent === true) return { textSent: true, voiceSent: true };
    if (result?.skipped === true) return { textSent: true, voiceSent: false, voiceSkipped: true };
    return { textSent: true, voiceSent: false, error: result?.error ?? 'voice_delivery_failed' };
  } catch {
    warn(log, 'voice_delivery_failed');
    return { textSent: true, voiceSent: false, error: 'voice_delivery_failed' };
  }
}
