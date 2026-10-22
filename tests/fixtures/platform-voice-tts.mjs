import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.QQ_PLATFORM_VOICE_ROOT;
const actual = await import(`${pathToFileURL(path.join(root, 'src/plugins/reply-tts.js')).href}?fixture-actual`);
export const meta = actual.meta;

export function afterReply(ctx) {
  return actual.afterReply({
    ...ctx,
    ttsProvider: {
      async synthesize(content, { outputFile }) {
        const fail = fs.existsSync(path.join(root, 'tts-fail'));
        fs.appendFileSync(path.join(root, 'trace.jsonl'), `${JSON.stringify({ event: fail ? 'tts:failed' : 'tts:synthesized', text: content })}\n`);
        if (fail) throw new Error('fixture_provider_failure');
        fs.writeFileSync(outputFile, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253, 1)]));
      },
    },
  });
}
