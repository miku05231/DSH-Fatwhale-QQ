import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.QQ_PLATFORM_VOICE_ROOT;
const real = await import(`${pathToFileURL(path.join(root, 'src/platforms/bilibili.js')).href}?fixture-actual`);
export const formatFeedSummary = real.formatFeedSummary;
export const canonicalItemKey = real.canonicalItemKey;
const trace = (entry) => fs.appendFileSync(path.join(root, 'trace.jsonl'), `${JSON.stringify(entry)}\n`);

export async function runChatOnlyDsh(prompt, options = {}) {
  const kind = options.requesterId ? 'chat' : prompt.includes('[语音翻译]') ? 'translation'
    : prompt.includes('{"relevant":false}') ? 'comment' : 'summary';
  trace({ event: 'model', kind, sessionId: options.sessionId, prompt });
  return {
    sessionId: kind === 'chat' ? 'fixture-private-session' : null,
    finalText: kind === 'translation' ? 'こんにちは。翻訳した音声です。'
      : kind === 'comment' ? '{"relevant":true,"text":"fixture polite comment"}'
      : kind === 'summary' ? 'fixture platform summary'
        : prompt.includes('VOICE_FAIL') ? 'fixture reply failure' : 'fixture reply speech',
  };
}

export function createBilibiliAdapter({ cookie }) {
  trace({ event: 'adapter', hasCookie: Boolean(cookie) });
  return {
    async search(keyword) { trace({ event: 'search', keyword }); return []; },
    async dynamics(uid) {
      trace({ event: 'dynamics', uid });
      return [{
        id: '900001', key: 'dynamic:900001', kind: 'dynamic', source: 'dynamic',
        title: 'fixture feed', text: 'fixture subscribed update', author: 'fixture author',
        url: 'https://t.bilibili.com/900001', commentOid: '700001', commentType: 17,
      }];
    },
    async publishComment(item, text, uid, { beforePublish } = {}) {
      const message = `@fixture ${text}`;
      if (beforePublish && !await beforePublish({ message })) return { published: false, reason: 'bilibili_publication_cancelled' };
      trace({ event: 'publish', dynamicId: item.id, text, uid });
      return { published: true, message };
    },
    async validateLogin() { return { mid: '990001' }; },
  };
}
