import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sniffImage, upsertSticker, loadIndex, resolveStickerFile } from '../src/stickers.js';
import { applyStickerSendPolicy } from '../src/sticker-send-policy.js';

const args = process.argv.slice(2);
function option(name, fallback = '') {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
}

if (!args.includes('--live')) {
  console.log('SKIP live image service: pass --live --connection <private-json> --output <private-directory>.');
  process.exit(0);
}

const connectionPath = path.resolve(option('--connection'));
const output = path.resolve(option('--output'));
assert.ok(option('--connection') && option('--output'), 'Explicit private connection and output paths are required.');
assert.ok(output.split(path.sep).includes('.imagegen-runtime'), 'Live artifacts must stay in the private runtime directory.');
const connection = JSON.parse(await fs.readFile(connectionPath, 'utf8'));
assert.equal(connection.auth?.type, 'none', 'This diagnostic uses the user-authorized no-auth connection.');
const base = new URL(connection.baseUrl);
assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.hash);
const generation = new URL(connection.generationPath, base);
assert.equal(generation.origin, base.origin);

const prompt = 'A friendly cartoon robot waving happily, large expressive eyes, bold clean outlines, simple white background, square sticker composition, no lettering.';
const cases = {
  minimal: { request: { prompt }, kind: 'image' },
  square: { request: { prompt, width: 1024, height: 1024, seed: 42 }, kind: 'image', dimensions: [1024, 1024], seed: 42 },
  landscape: { request: { prompt: 'A bright futuristic city park with a small friendly robot, clean digital illustration, wide composition, no lettering.', negative_prompt: 'blurry, low contrast', width: 1344, height: 768, seed: 42, steps: 8, cfg: 1 }, kind: 'image', dimensions: [1344, 768], seed: 42 },
  portrait: { request: { prompt, width: 768, height: 1344, seed: 42 }, kind: 'image', dimensions: [768, 1344], seed: 42 },
  chinese: { request: { prompt: '\u4e00\u4e2a\u673a\u5668\u4eba\u7684\u65e0\u8bed\u8868\u60c5\u5305\uff0c\u767d\u8272\u80cc\u666f\uff0c\u4e0d\u8981\u6587\u5b57', width: 1024, height: 1024, seed: 7 }, kind: 'image', dimensions: [1024, 1024], seed: 7 },
  'malformed-json': { raw: '{', kind: 'rejection' },
  'missing-prompt': { request: {}, kind: 'rejection' },
  'empty-prompt': { request: { prompt: '' }, kind: 'rejection' },
  'invalid-size': { request: { prompt, size: 'not-a-size' }, kind: 'rejection' },
  'invalid-model': { request: { prompt, model: 'qq-imagegen-nonexistent-test-model' }, kind: 'rejection' },
  'prompt-object': { request: { prompt: { text: 'invalid type' } }, kind: 'rejection' },
  'prompt-too-long': { request: { prompt: 'x'.repeat(16001) }, kind: 'rejection' },
  'width-zero': { request: { prompt, width: 0 }, kind: 'rejection' },
  'height-negative': { request: { prompt, height: -64 }, kind: 'rejection' },
  'width-string': { request: { prompt, width: '1024' }, kind: 'rejection' },
  'seed-negative': { request: { prompt, seed: -1 }, kind: 'rejection' },
  'steps-zero': { request: { prompt, steps: 0 }, kind: 'rejection' },
  'cfg-string': { request: { prompt, cfg: 'invalid' }, kind: 'rejection' },
  'width-too-large': { request: { prompt, width: 2049 }, kind: 'rejection' },
  'steps-too-large': { request: { prompt, steps: 101 }, kind: 'rejection' },
  'cfg-too-large': { request: { prompt, cfg: 16 }, kind: 'rejection' },
  'seed-overflow': { raw: '{"prompt":"invalid seed boundary test","seed":18446744073709551616}', kind: 'rejection' },
  'negative-prompt-object': { request: { prompt, negative_prompt: { text: 'invalid type' } }, kind: 'rejection' },
};
cases['square-repeat'] = { ...cases.square, compareWith: 'square' };
for (const [field, value] of Object.entries({ unknown_test_field: 1, width: 1024, height: 1024, seed: 42, negative_prompt: 'blurry', steps: 8, cfg: 1 })) {
  cases[`field-${field}`] = { request: { prompt: '', [field]: value }, kind: 'rejection' };
}
const selected = option('--case', 'minimal');
assert.ok(Object.hasOwn(cases, selected), 'Unknown live test case.');
const test = cases[selected];
const responsePath = path.join(output, `${selected}-response.bin`);
if (args.includes('--resume')) {
  assert.equal(test.kind, 'image', 'Only an existing image submission can be resumed.');
} else {
  let exists = true;
  try { await fs.access(responsePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  assert.ok(!exists, 'Preserve the existing response; use --resume or a fresh output directory instead of submitting again.');
}
const report = { at: new Date().toISOString(), case: selected, auth: 'none', checks: [], network: [], artifacts: [] };
await fs.mkdir(output, { recursive: true });
const reportPath = path.join(output, `${selected}-report.json`);
const check = (condition, name) => {
  assert.ok(condition, name);
  if (!report.checks.includes(name)) report.checks.push(name);
};

function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key === 'seed' && typeof value === 'number' && !Number.isSafeInteger(value)) {
      assert.ok(context?.source, 'Unsafe numeric seeds require their original decimal source.');
      return context.source;
    }
    return value;
  });
}

async function capture(url, { method = 'GET', body, limit = 32 * 1024 * 1024, timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  const record = { method, path: url.pathname, authorizationSent: false, elapsedMs: 0 };
  report.network.push(record);
  try {
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
    });
    record.status = response.status;
    record.contentType = response.headers.get('content-type');
    record.allow = response.headers.get('allow');
    record.headersAfterMs = Date.now() - started;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('response_too_large');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        throw new Error('response_too_large');
      }
      chunks.push(chunk);
    }
    record.bytes = bytes;
    record.elapsedMs = Date.now() - started;
    return { response, bytes: Buffer.concat(chunks, bytes) };
  } catch (error) {
    record.elapsedMs = Date.now() - started;
    record.error = error.name === 'TimeoutError' ? 'timeout_remote_result_unknown' : 'transport_or_body_error';
    throw error;
  }
}

async function extractImage(payload) {
  const images = payload.images ?? payload.data;
  check(Array.isArray(images) && images.length === 1, 'response contains exactly one image');
  const item = images[0];
  report.imageFields = Object.keys(item);
  if (typeof item.b64_json === 'string') {
    const value = item.b64_json;
    check(value.length <= Math.ceil(20 * 1024 * 1024 / 3) * 4, 'base64 encoded size is bounded');
    check(value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'base64 syntax is valid');
    const buffer = Buffer.from(value, 'base64');
    check(buffer.toString('base64') === value, 'base64 is canonical');
    report.encoding = 'b64_json';
    return buffer;
  }
  check(typeof item.url === 'string', 'response supplies a supported image field');
  const url = new URL(item.url, base);
  check(url.origin === base.origin && !url.username && !url.password && !url.hash, 'download URL stays at the configured service');
  report.encoding = 'url';
  const downloaded = await capture(url, { limit: 20 * 1024 * 1024, timeoutMs: 30_000 });
  check(downloaded.response.ok, 'image download succeeds');
  return downloaded.bytes;
}

async function waitForJob(submission) {
  check(typeof submission.id === 'string' && typeof submission.status_url === 'string', 'accepted submission supplies a job ID and status URL');
  const url = new URL(submission.status_url, base);
  check(url.origin === base.origin && !url.username && !url.password && !url.hash, 'job query stays at the configured service');
  report.protocol = 'asynchronous-job';
  report.job = { id: submission.id, statusPath: url.pathname, seed: submission.seed, seedType: typeof submission.seed };
  const deadline = Date.now() + 180_000;
  let poll = 0;
  let lastStatus;
  while (Date.now() < deadline) {
    const result = await capture(url, { timeoutMs: Math.min(15_000, deadline - Date.now()) });
    check(result.response.status === 200, 'job query succeeds without authorization');
    const payload = parseJson(result.bytes.toString('utf8'));
    await fs.writeFile(path.join(output, `${selected}-status-latest.json`), result.bytes);
    check(payload.id === submission.id, 'job response belongs to the accepted submission');
    report.job.status = payload.status;
    report.job.polls = ++poll;
    if (payload.status === 'completed') return payload;
    if (['failed', 'cancelled', 'canceled', 'error'].includes(payload.status)) {
      report.job.error = typeof payload.error === 'string' ? payload.error.slice(0, 500) : payload.error;
      throw new Error('remote_job_failed');
    }
    check(['queued', 'running', 'pending', 'processing'].includes(payload.status), 'job reports a recognized pending state');
    if (payload.status !== lastStatus || poll % 15 === 0) {
      console.log(JSON.stringify({ case: selected, jobStatus: payload.status, polls: poll }));
      lastStatus = payload.status;
    }
    const pause = Math.min(2000, deadline - Date.now());
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
  }
  throw new Error('job_wait_timeout_no_resubmission');
}

async function testLocalStickerFlow(buffer, imagePath) {
  const root = await fs.mkdtemp(path.join(output, 'isolated sticker library-'));
  const settings = { minBytes: 0, maxBytes: 5 * 1024 * 1024, autoTag: false };
  const first = await upsertSticker({ root, buffer, tags: ['generated', 'happy'], source: { type: 'imagegen-test' }, settings });
  check(first.added && first.item, 'real generated image imports into an isolated sticker library');
  const duplicate = await upsertSticker({ root, buffer, tags: ['verified'], settings });
  check(duplicate.duplicate && duplicate.item.seen === 2, 'same generated image is deduplicated');
  check(duplicate.item.tags.includes('happy') && duplicate.item.tags.includes('verified'), 'sticker tags merge on duplicate import');
  const index = await loadIndex(root);
  check(index.items.length === 1, 'isolated library retains one item');
  const libraryFile = resolveStickerFile(root, first.item.file);
  check((await fs.readFile(libraryFile)).equals(buffer), 'imported image bytes match the generated artifact');
  const params = { group_id: 'synthetic-test-group', message: [{ type: 'image', data: { file: libraryFile } }] };
  for (const [probability, draw, allowed] of [[0, 0.1, false], [0.35, 0.1, true], [0.35, 0.9, false], [1, 0.9, true]]) {
    let draws = 0;
    const result = await applyStickerSendPolicy('send_group_msg', params, {
      config: { stickers: { root, sendProbability: probability } }, configRoot: output,
      random: () => { draws++; return draw; },
    });
    check(result.skipped === !allowed, `generated sticker follows probability ${probability} with draw ${draw}`);
    check(draws === (probability > 0 && probability < 1 ? 1 : 0), 'probability decision is sampled only when needed');
  }
  const ordinary = await applyStickerSendPolicy('send_group_msg', {
    ...params, message: [{ type: 'image', data: { file: imagePath } }],
  }, { config: { stickers: { root, sendProbability: 0 } }, configRoot: output });
  check(!ordinary.skipped, 'ordinary generated file remains a regular image');
  report.localStickerFlow = { isolated: true, deduplicated: true, probabilityVerified: true, realQqMessagesSent: 0 };
}

try {
  if (selected === 'minimal' && !args.includes('--resume')) {
    const health = await capture(new URL('/health', base), { timeoutMs: 5_000, limit: 65536 });
    check(health.response.status === 200, 'health succeeds without authorization');
    const method = await capture(generation, { method: 'OPTIONS', timeoutMs: 5_000, limit: 65536 });
    check(method.response.status === 405 && (method.response.headers.get('allow') ?? '').split(/\s*,\s*/).includes('POST'), 'generation route declares POST');
  }
  let result;
  if (args.includes('--resume')) {
    result = { response: { ok: true, status: 202 }, bytes: await fs.readFile(responsePath) };
    report.resumedExistingSubmission = true;
  } else {
    await fs.writeFile(path.join(output, `${selected}-request.json`), test.raw ?? JSON.stringify(test.request, null, 2));
    result = await capture(generation, { method: 'POST', body: test.raw ?? JSON.stringify(test.request) });
    await fs.writeFile(responsePath, result.bytes);
  }
  let payload;
  try { payload = parseJson(result.bytes.toString('utf8')); } catch { /* Report the HTTP and content-type evidence before failing. */ }
  report.responseFields = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  if (!result.response.ok) {
    const error = payload?.error;
    report.serviceError = typeof error === 'string' ? error.slice(0, 800) : error && typeof error === 'object' ? {
      type: String(error.type ?? '').slice(0, 120), code: String(error.code ?? '').slice(0, 120), message: String(error.message ?? '').slice(0, 800),
    } : 'nonstandard_error_response';
  }
  if (test.kind === 'rejection') {
    if (result.response.status === 202) {
      report.unexpectedAcceptance = true;
      const completed = await waitForJob(payload);
      const buffer = await extractImage(completed);
      const image = sniffImage(buffer);
      if (image) {
        const imagePath = path.join(output, `unexpected-${selected}${image.ext}`);
        await fs.writeFile(imagePath, buffer);
        report.artifacts.push(imagePath);
        report.image = { ...image, bytes: buffer.length };
      }
    }
    check(result.response.status >= 400 && result.response.status < 500, 'invalid request is rejected with a 4xx response');
    check(Boolean(payload && typeof payload === 'object'), 'validation error is structured JSON');
  } else {
    check(result.response.ok, 'generation request succeeds without authorization');
    check(Boolean(payload && typeof payload === 'object'), 'generation response is JSON');
    if (result.response.status === 202) payload = await waitForJob(payload);
    const buffer = await extractImage(payload);
    check(buffer.length > 1024 && buffer.length <= 20 * 1024 * 1024, 'image byte length is valid');
    const image = sniffImage(buffer);
    check(Boolean(image?.width > 0 && image?.height > 0), 'image signature and dimensions are recognized');
    const imagePath = path.join(output, `${selected}${image.ext}`);
    await fs.writeFile(imagePath, buffer);
    report.artifacts.push(imagePath);
    report.image = { ...image, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
    if (test.dimensions) check(image.width === test.dimensions[0] && image.height === test.dimensions[1], 'requested dimensions are honored');
    if (test.seed !== undefined) check(report.job?.seed === test.seed, 'explicit seed is preserved by the service');
    if (test.compareWith) {
      const earlier = JSON.parse(await fs.readFile(path.join(output, `${test.compareWith}-report.json`), 'utf8'));
      check(earlier.image.sha256 === report.image.sha256, 'identical prompt and seed reproduce identical image bytes');
    }
    if (test.request?.response_format) report.requestedResponseFormat = test.request.response_format;
    if (selected === 'minimal') await testLocalStickerFlow(buffer, imagePath);
  }
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.failure = { name: error.name, message: String(error.message).slice(0, 300) };
  process.exitCode = 1;
} finally {
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ case: selected, pass: report.pass, checks: report.checks.length,
    requests: report.network.length, job: report.job, image: report.image, encoding: report.encoding,
    requestedResponseFormat: report.requestedResponseFormat, serviceError: report.serviceError,
    unexpectedAcceptance: report.unexpectedAcceptance, failure: report.failure,
    artifacts: report.artifacts, reportPath }));
}
