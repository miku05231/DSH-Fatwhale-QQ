import path from 'node:path';
import { createNapcatHealth } from '../src/napcat-health.js';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex < 0 || !args[rootIndex + 1]) {
  console.error('Usage: napcat-health.mjs --root <installation> [--running|--stopped]');
  process.exitCode = 2;
} else {
  let session;
  const exchange = args.includes('--exchange-session');
  if (exchange) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 32_768) throw new Error('Health session input too large');
    }
    try { session = JSON.parse(input).session; } catch { /* No reusable credential. */ }
  }
  const health = createNapcatHealth({ root: path.resolve(args[rootIndex + 1]), session });
  try {
    const status = await health.check({ running: args.includes('--stopped') ? false : args.includes('--running') ? true : undefined });
    console.log(JSON.stringify(exchange ? { health: status, session: health.exportSession() } : status));
  } finally { health.close(); }
}
