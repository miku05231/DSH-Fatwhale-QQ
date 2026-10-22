import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.QQ_PLATFORM_VOICE_ROOT;
const replacements = new Map([
  ['chat-only.js', 'platform-voice-runtime.mjs'],
  ['platforms/bilibili.js', 'platform-voice-runtime.mjs'],
  ['platform-scheduler.js', 'platform-voice-scheduler.mjs'],
  ['plugins/reply-tts.js', 'platform-voice-tts.mjs'],
].map(([source, target]) => [pathToFileURL(path.join(root, 'src', source)).href, new URL(target, import.meta.url).href]));

export async function resolve(specifier, context, nextResolve) {
  const requested = context.parentURL ? new URL(specifier, context.parentURL).href : '';
  const replacement = replacements.get(requested);
  if (replacement) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context);
}
