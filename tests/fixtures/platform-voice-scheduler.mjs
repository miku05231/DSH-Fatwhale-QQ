import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.QQ_PLATFORM_VOICE_ROOT;
const actual = await import(`${pathToFileURL(path.join(root, 'src/platform-scheduler.js')).href}?fixture-actual`);
const trace = (event) => fs.appendFileSync(path.join(root, 'trace.jsonl'), `${JSON.stringify({ event })}\n`);

export function createPlatformScheduler(options) {
  trace('scheduler:create');
  const scheduler = actual.createPlatformScheduler(options);
  return {
    ...scheduler,
    start() { trace('scheduler:start'); scheduler.start(); },
    stop() { trace('scheduler:stop'); scheduler.stop(); },
  };
}
