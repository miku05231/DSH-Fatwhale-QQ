import assert from 'node:assert/strict';
import {
  BilibiliError, BILIBILI_REASON_MAP, canonicalItemKey, createBilibiliAdapter,
  formatFeedSummary, getUserDynamics, normalizeDynamic, publishDynamicComment,
  resolveBilibiliMention, searchBilibili, signBilibiliWbi, validateBilibiliLogin,
} from '../src/platforms/bilibili.js';

const COOKIE = 'SESSDATA=fixture-private-session; bili_jct=fixturecsrf; buvid3=fixture-device';
const BVID = 'BV1xx411c7mD';
const LOGIN = { isLogin: true, mid: 42 };
const WBI_KEYS = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
const WBI_NAV = { ...LOGIN, wbi_img: {
  img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.imgKey}.png`,
  sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.subKey}.png`,
} };
const CARD = { card: { mid: '123', name: 'Configured Account' } };
const DYNAMIC = {
  id_str: '1063487284684259332', type: 'DYNAMIC_TYPE_DRAW',
  basic: { comment_id_str: '349795473', comment_type: 11, rid_str: '999' },
  modules: {
    module_author: { mid: 66, name: 'Fixture author', pub_ts: 123 },
    module_dynamic: { desc: { text: 'A dynamic update' } },
  },
};
const ITEM = normalizeDynamic(DYNAMIC);
const json = (data, status = 200) => new Response(JSON.stringify({ code: 0, data }), { status });
let passed = 0;

async function test(name, run) {
  try { await run(); passed += 1; }
  catch (error) { console.error(`FAILED: ${name}`); throw error; }
}

function mockPublish(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = { url: new URL(url), options };
    calls.push(request);
    const pathname = request.url.pathname;
    if (overrides[pathname]) return overrides[pathname](request);
    if (pathname.endsWith('/nav')) return json(LOGIN);
    if (pathname.endsWith('/card')) return json(CARD);
    if (pathname.endsWith('/reply/add')) return json({ rpid_str: '9007199254740993' });
    throw new Error('unexpected mock endpoint');
  };
  return { calls, fetchImpl };
}

const publish = (fetchImpl, overrides = {}) => publishDynamicComment({
  cookie: COOKIE, item: ITEM, text: 'Useful update', mentionUid: '123', fetchImpl, ...overrides,
});

await test('dynamic uses explicit comment resource, never dynamic/rid fallback', () => {
  assert.equal(ITEM.commentOid, '349795473');
  assert.equal(ITEM.commentType, 11);
  assert.notEqual(ITEM.commentOid, ITEM.id);
  const missing = normalizeDynamic({ ...DYNAMIC, basic: { rid_str: '999', comment_type: 17 } });
  assert.equal(missing.commentOid, '');
  assert.equal(normalizeDynamic({ ...DYNAMIC, basic: { comment_id_str: '4', comment_type: 88 } }).commentType, null);
  assert.equal(normalizeDynamic({ ...DYNAMIC, basic: { comment_id_str: '4', comment_type: '11' } }).commentType, null);
});

await test('unsafe numeric identifiers rejected without precision loss', () => {
  assert.equal(normalizeDynamic({ ...DYNAMIC, id_str: undefined, id: 9007199254740993 }).id, '');
  assert.equal(normalizeDynamic({ ...DYNAMIC, basic: { comment_id_str: 9007199254740993, comment_type: 17 } }).commentOid, '');
  assert.equal(normalizeDynamic({ ...DYNAMIC, id_str: '1063487284684259332' }).id, '1063487284684259332');
});

await test('archive title/text and BVID canonical keys merge video with dynamic', async () => {
  const archive = normalizeDynamic({ ...DYNAMIC, modules: {
    ...DYNAMIC.modules, module_dynamic: { major: { archive: { bvid: BVID, title: 'Video title', desc: 'Description' } } },
  } });
  const results = await searchBilibili('test', { cookie: COOKIE, fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith('/nav')) return json(WBI_NAV);
    assert.equal(new URL(url).pathname, '/x/web-interface/wbi/search/type');
    assert.equal(new URL(url).searchParams.get('order'), 'pubdate');
    assert.match(new URL(url).searchParams.get('w_rid'), /^[0-9a-f]{32}$/);
    assert.equal(options.redirect, 'error');
    return json({ result: [{ bvid: BVID, title: '<em>Video</em> &amp; title', author: 'Author', mid: 66 }] });
  } });
  assert.equal(archive.title, 'Video title');
  assert.equal(archive.text, 'Description');
  assert.equal(archive.key, results[0].key);
  assert.equal(canonicalItemKey(archive), `video:${BVID}`);
  assert.equal(results[0].title, 'Video & title');
  assert.equal(results[0].url, `https://www.bilibili.com/video/${BVID}`);
});

await test('WBI matches published protocol vector and filters forbidden characters', () => {
  const signed = signBilibiliWbi({ foo: '114', bar: '514', zab: 1919810 }, { ...WBI_KEYS, timestamp: 1702204169 });
  assert.equal(signed.w_rid, '8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.equal(signed.wts, '1702204169');
  assert.equal(signBilibiliWbi({ foo: "a b!'()*" }, { ...WBI_KEYS, timestamp: 1702204169 }).foo, 'a b');
});

await test('WBI keys are cached within adapter and spaces encode as percent20', async () => {
  const calls = [];
  const adapter = createBilibiliAdapter({ cookie: COOKIE, fetchImpl: async (url) => {
    calls.push(new URL(url));
    return new URL(url).pathname.endsWith('/nav') ? json(WBI_NAV) : json({ result: [] });
  } });
  await adapter.search('first term');
  await adapter.search('second term');
  assert.equal(calls.filter((url) => url.pathname.endsWith('/nav')).length, 1);
  assert.match(calls[1].href, /keyword=first%20term/);
  assert.equal(calls[1].href.includes('+'), false);
});

await test('search supports anonymous WBI envelope but requires device cookie', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return new URL(url).pathname.endsWith('/nav')
      ? new Response(JSON.stringify({ code: -101, data: { ...WBI_NAV, isLogin: false } })) : json({ result: [] });
  };
  await assert.rejects(searchBilibili('fixture', { fetchImpl }), { message: 'bilibili_login_required' });
  assert.equal(calls, 0);
  assert.deepEqual(await searchBilibili('fixture', { cookie: 'buvid3=fixture-device', fetchImpl }), []);
  assert.equal(calls, 2);
});

await test('search and dynamics validate input before network', async () => {
  const fetchImpl = () => { throw new Error('network must not run'); };
  for (const keyword of ['', 'x'.repeat(101)]) assert.deepEqual(await searchBilibili(keyword, { fetchImpl }), []);
  for (const uid of ['0', '-1', '1e3', '123\nInjected: header', 9007199254740993, {}, null]) {
    assert.deepEqual(await getUserDynamics(uid, { fetchImpl }), []);
  }
});

await test('feed/space contract and result bounds', async () => {
  const items = await getUserDynamics('66', { fetchImpl: async (url) => {
    assert.equal(new URL(url).pathname, '/x/polymer/web-dynamic/v1/feed/space');
    assert.equal(new URL(url).searchParams.get('host_mid'), '66');
    return json({ items: Array.from({ length: 30 }, () => DYNAMIC) });
  } });
  assert.equal(items.length, 20);
  assert.equal(items[0].commentOid, '349795473');
  assert.equal(items[0].key, `dynamic:${ITEM.id}`);
});

await test('upstream output text and summaries are bounded', async () => {
  const huge = 'x'.repeat(20000);
  const item = normalizeDynamic({ ...DYNAMIC, type: huge, modules: {
    module_author: { name: huge },
    module_dynamic: { desc: { text: huge }, major: { archive: { title: huge } } },
  } });
  assert.equal(item.type.length, 64);
  assert.equal(item.author.length, 100);
  assert.equal(item.title.length, 200);
  assert.equal(item.text.length, 800);
  const summary = formatFeedSummary(Array(50).fill({ title: huge, text: huge, url: huge, author: huge }), { maxItems: 99 });
  assert.ok(summary.length < 30000);
  assert.equal(summary.match(/\n\d+\./g).length, 20);
});

await test('login is checked before mention and comment, mention payload exact', async () => {
  const { calls, fetchImpl } = mockPublish();
  const result = await publish(fetchImpl);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ['/x/web-interface/nav', '/x/web-interface/card', '/x/v2/reply/add']);
  const request = calls[2];
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('oid'), '349795473');
  assert.equal(body.get('type'), '11');
  assert.equal(body.get('csrf'), 'fixturecsrf');
  assert.equal(body.get('message'), 'Useful update @Configured Account ');
  assert.deepEqual(JSON.parse(body.get('at_name_to_mid')), { 'Configured Account': 123 });
  assert.equal(request.options.headers.cookie, COOKIE);
  assert.equal(request.options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(result, { published: true, rpid: '9007199254740993', message: 'Useful update @Configured Account ' });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-session|fixturecsrf/);
});

await test('verified dynamic resource types preserve distinct oid', async () => {
  for (const commentType of [1, 11, 12, 17]) {
    const { calls, fetchImpl } = mockPublish();
    const result = await publish(fetchImpl, { item: { ...ITEM, commentType } });
    assert.equal(result.published, true);
    assert.equal(new URLSearchParams(calls.at(-1).options.body).get('type'), String(commentType));
    assert.equal(new URLSearchParams(calls.at(-1).options.body).get('oid'), '349795473');
  }
});

await test('invalid resources and arbitrary model mentions never use network', async () => {
  const { calls, fetchImpl } = mockPublish();
  const variants = [
    { item: { ...ITEM, kind: 'video', source: 'video' } },
    { item: { ...ITEM, commentOid: '' } },
    { item: { ...ITEM, commentType: '17' } },
    { item: { ...ITEM, commentType: 9 } },
    { item: { ...ITEM, commentOid: 9007199254740993 } },
    { item: { ...ITEM, id: '1\r\n' } },
    { mentionUid: '9007199254740993' },
    { text: 'ping @someone' }, { text: 'ping ＠someone' },
    { text: 'x'.repeat(1001) }, { text: 'bad\x00text' },
  ];
  for (const overrides of variants) assert.equal((await publish(fetchImpl, overrides)).reason, 'bilibili_invalid_comment');
  assert.equal(calls.length, 0);
  assert.equal((await publishDynamicComment({ cookie: COOKIE, dynamicId: ITEM.id, text: 'x', mentionUid: '123', fetchImpl })).published, false);
});

await test('invalid cookies prevent requests without exposing credentials', async () => {
  for (const cookie of ['', 'SESSDATA=x', 'SESSDATA=fixture-private-session; bili_jct=csrf\r\nother: bad']) {
    const { calls, fetchImpl } = mockPublish();
    const result = await publish(fetchImpl, { cookie });
    assert.equal(result.reason, 'bilibili_login_required');
    assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-session/);
  }
  await assert.rejects(getUserDynamics('42', { cookie: 'bad\nfixture-secret', fetchImpl: () => assert.fail('no network') }), {
    message: 'bilibili_invalid_cookie',
  });
});

await test('expired/rejected login prevents mention and POST', async () => {
  for (const response of [json({ isLogin: false, mid: 42 }), new Response(JSON.stringify({ code: -101, message: COOKIE }))]) {
    const { calls, fetchImpl } = mockPublish({ '/x/web-interface/nav': () => response });
    const result = await publish(fetchImpl);
    assert.equal(result.reason, 'bilibili_login_required');
    assert.equal(result.blocked, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-session/);
  }
});

await test('mismatched/malformed configured account prevents POST', async () => {
  for (const card of [
    { mid: '124', name: 'Wrong account' }, { mid: '123', name: 'Bad@name' },
    { mid: '123', name: 'x'.repeat(65) }, { mid: '123', name: '' },
    { mid: 9007199254740993, name: 'Wrong precision' },
  ]) {
    const { calls, fetchImpl } = mockPublish({ '/x/web-interface/card': () => json({ card }) });
    const result = await publish(fetchImpl);
    assert.equal(result.reason, 'bilibili_invalid_mention');
    assert.equal(calls.length, 2);
  }
});

await test('beforePublish sees final message immediately before POST', async () => {
  const { calls, fetchImpl } = mockPublish();
  const adapter = createBilibiliAdapter({ cookie: COOKIE, fetchImpl });
  let observed = false;
  const result = await adapter.publishComment(ITEM, 'x', '123', { beforePublish: async ({ message }) => {
    assert.equal(calls.length, 2);
    assert.equal(message, 'x @Configured Account ');
    observed = true;
    return true;
  } });
  assert.equal(observed, true);
  assert.equal(result.published, true);
  assert.equal(calls.length, 3);
});

await test('disabled/throwing preflight blocks POST without blocking future publication', async () => {
  for (const beforePublish of [async () => false, async () => undefined, async () => 'true', async () => { throw new Error(COOKIE); }]) {
    const { calls, fetchImpl } = mockPublish();
    const result = await publish(fetchImpl, { beforePublish });
    assert.deepEqual(result, { published: false, reason: 'bilibili_publication_cancelled', blocked: false });
    assert.equal(calls.length, 2);
  }
});

await test('POST rejection is one attempt, safe failure, no retry', async () => {
  const { calls, fetchImpl } = mockPublish({ '/x/v2/reply/add': () => new Response(JSON.stringify({ code: -412, message: COOKIE })) });
  const result = await publish(fetchImpl);
  assert.equal(result.reason, 'bilibili_api_rejected');
  assert.equal(result.blocked, true);
  assert.equal(result.uncertain, undefined);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-session|fixturecsrf/);
});

await test('POST missing or unsafe rpid is uncertain and never retried', async () => {
  for (const data of [{}, { rpid: 9007199254740993 }, { rpid_str: 'invalid' }]) {
    const { calls, fetchImpl } = mockPublish({ '/x/v2/reply/add': () => json(data) });
    const result = await publish(fetchImpl);
    assert.equal(result.reason, 'bilibili_comment_uncertain');
    assert.equal(result.uncertain, true);
    assert.equal(result.blocked, true);
    assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
  }
});

await test('POST network failure and HTML refusal are uncertain and sanitized', async () => {
  for (const response of [() => { throw new Error(`transport leaked ${COOKIE}`); }, () => new Response(`HTML ${COOKIE}`), () => new Response('refused', { status: 412 })]) {
    const { calls, fetchImpl } = mockPublish({ '/x/v2/reply/add': response });
    const result = await publish(fetchImpl);
    assert.equal(result.uncertain, true);
    assert.equal(result.blocked, true);
    assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-session|fixturecsrf/);
  }
});

await test('GET transport errors never leak URL/Cookie/body', async () => {
  await assert.rejects(searchBilibili('test', { cookie: COOKIE, fetchImpl: async () => { throw new Error(COOKIE); } }), {
    name: 'BilibiliError', message: 'bilibili_request_failed', reason: 'bilibili_request_failed',
  });
  await assert.rejects(getUserDynamics('42', { fetchImpl: async () => new Response(COOKIE) }), { message: 'bilibili_invalid_response' });
  assert.equal(new BilibiliError(COOKIE).message, 'bilibili_request_failed');
});

await test('redirect cannot forward credentials to another origin', async () => {
  const calls = [];
  await assert.rejects(searchBilibili('fixture', { cookie: COOKIE, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    return new Response('', { status: 302, headers: { location: 'https://untrusted.invalid/stolen' } });
  } }), { message: 'bilibili_http_error' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, 'https://api.bilibili.com');
  assert.equal(calls[0].url.href.includes('fixture-private-session'), false);
});

await test('already-followed redirected response is rejected', async () => {
  const response = json({ result: [] });
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(searchBilibili('fixture', { cookie: COOKIE, fetchImpl: async () => response }), { message: 'bilibili_http_error' });
});

await test('response declared/streamed bytes are limited', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(searchBilibili('fixture', { cookie: COOKIE, fetchImpl: async () => response }), { message: 'bilibili_response_too_large' });
  }
});

await test('per-request timeout covers fetch that ignores abort', async () => {
  let signal;
  const start = Date.now();
  await assert.rejects(searchBilibili('fixture', { cookie: COOKIE, timeoutMs: 10, fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), { message: 'bilibili_request_timeout' });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 1000);
});

await test('per-request timeout covers streaming body', async () => {
  await assert.rejects(searchBilibili('fixture', { cookie: COOKIE, timeoutMs: 10, fetchImpl: async (_url, options) => {
    const stream = new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new Error(COOKIE)), { once: true });
    } });
    return new Response(stream);
  } }), { message: 'bilibili_request_timeout' });
});

await test('injected fetch cannot override adapter credentials through publish options', async () => {
  const { calls, fetchImpl } = mockPublish();
  const adapter = createBilibiliAdapter({ cookie: COOKIE, fetchImpl });
  const result = await adapter.publishComment(ITEM, 'x', '123', { cookie: '', fetchImpl: () => assert.fail('unexpected override') });
  assert.equal(result.published, true);
  assert.equal(calls.at(-1).options.headers.cookie, COOKIE);
});

await test('standalone login/mention helpers and exported safe reason map', async () => {
  const { fetchImpl } = mockPublish();
  assert.deepEqual(await validateBilibiliLogin({ cookie: COOKIE, fetchImpl }), { uid: '42' });
  assert.deepEqual(await resolveBilibiliMention('123', { cookie: COOKIE, fetchImpl }), { uid: '123', name: 'Configured Account' });
  assert.equal(BILIBILI_REASON_MAP.bilibili_comment_uncertain, 'publication_uncertain');
  assert.equal(BILIBILI_REASON_MAP.bilibili_publication_cancelled, 'publication_cancelled');
});

console.log(`Passed: Bilibili adapter ${passed} isolated checks`);
