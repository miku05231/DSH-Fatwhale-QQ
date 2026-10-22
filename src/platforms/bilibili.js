import { createHash } from 'node:crypto';

const API_ROOT = 'https://api.bilibili.com';
const COMMENT_TYPES = new Set([1, 11, 12, 17]);
const LOGIN_CODES = new Set([-101, -111, -403]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WBI_KEY_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const wbiKeyCache = new WeakMap();

export const BILIBILI_REASON_MAP = Object.freeze({
  bilibili_invalid_response: 'platform_refused',
  bilibili_login_required: 'login_required',
  bilibili_api_rejected: 'platform_refused',
  bilibili_http_error: 'network_error',
  bilibili_request_failed: 'network_error',
  bilibili_request_timeout: 'network_error',
  bilibili_response_too_large: 'platform_refused',
  bilibili_invalid_cookie: 'login_invalid',
  bilibili_invalid_mention: 'mention_invalid',
  bilibili_invalid_comment: 'invalid_request',
  bilibili_comment_uncertain: 'publication_uncertain',
  bilibili_publication_cancelled: 'publication_cancelled',
});

const SAFE_REASONS = new Set(Object.keys(BILIBILI_REASON_MAP));

export class BilibiliError extends Error {
  constructor(reason) {
    const safeReason = SAFE_REASONS.has(reason) ? reason : 'bilibili_request_failed';
    super(safeReason);
    this.name = 'BilibiliError';
    this.reason = safeReason;
  }
}

function positiveId(value) {
  if (!['string', 'number'].includes(typeof value)) return '';
  if (typeof value === 'string' && /[\r\n\x00]/.test(value)) return '';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value ?? '').trim();
  return /^[1-9]\d{0,23}$/.test(id) ? id : '';
}

function apiData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.code !== 'number') {
    throw new BilibiliError('bilibili_invalid_response');
  }
  if (payload.code !== 0) {
    throw new BilibiliError(LOGIN_CODES.has(payload.code) ? 'bilibili_login_required' : 'bilibili_api_rejected');
  }
  return payload.data;
}

async function readJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel?.().catch(() => {});
    throw new BilibiliError('bilibili_response_too_large');
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new BilibiliError('bilibili_response_too_large');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new BilibiliError('bilibili_response_too_large');
  }
  try { return JSON.parse(text); } catch { throw new BilibiliError('bilibili_invalid_response'); }
}

async function requestJson(endpoint, { params = {}, body, fetchImpl = globalThis.fetch, cookie = '', timeoutMs = 15000 } = {}) {
  if (typeof cookie !== 'string' || cookie.length > 32768 || /[\r\n\x00]/.test(cookie)) throw new BilibiliError('bilibili_invalid_cookie');
  const url = new URL(endpoint, API_ROOT);
  url.search = Object.entries(params).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&');
  const timeout = Math.max(1, Math.min(120000, Math.floor(Number(timeoutMs) || 15000)));
  const controller = new AbortController();
  let timer;
  try {
    const request = (async () => {
      const response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          'user-agent': 'Mozilla/5.0 qq-bridge/0.2',
          referer: 'https://www.bilibili.com/',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        signal: controller.signal,
      });
      if (response.redirected) throw new BilibiliError('bilibili_http_error');
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw new BilibiliError('bilibili_http_error');
      }
      return readJson(response);
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new BilibiliError('bilibili_request_timeout'));
        controller.abort();
      }, timeout);
    });
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof BilibiliError) throw error;
    throw new BilibiliError('bilibili_request_failed');
  } finally { clearTimeout(timer); }
}

function boundedString(value, limit = 800) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function stripTags(value, limit = 800) {
  const entities = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return boundedString(value, 16384).replace(/<[^>]*>/g, '').replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, entity) => entities[entity]).replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function canonicalItemKey(item = {}) {
  const bvid = typeof item.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(item.bvid) ? item.bvid : '';
  if (bvid) return `video:${bvid}`;
  return item.kind === 'dynamic' || item.source === 'dynamic' ? `dynamic:${item.id}` : `video:${item.id}`;
}

// WBI protocol/table: pskdje/bilibili-API-collect docs/misc/sign/wbi.md;
// current search usage: jackwener/OpenCLI clis/bilibili/utils.js.
export function signBilibiliWbi(params, { imgKey, subKey, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  if (!/^[0-9a-f]{32}$/i.test(imgKey) || !/^[0-9a-f]{32}$/i.test(subKey) || !Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new BilibiliError('bilibili_invalid_response');
  }
  const raw = imgKey + subKey;
  const mixin = WBI_KEY_ORDER.map((index) => raw[index]).join('').slice(0, 32);
  const source = { ...params, wts: String(timestamp) };
  const sorted = Object.fromEntries(Object.keys(source).sort().map((name) => [name, String(source[name]).replace(/[!'()*]/g, '')]));
  const query = Object.entries(sorted).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return { ...sorted, w_rid: createHash('md5').update(query + mixin).digest('hex') };
}

async function getWbiKeys(options) {
  const cached = wbiKeyCache.get(options);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.promise;
  const promise = (async () => {
    const payload = await requestJson('/x/web-interface/nav', options);
    // Public WBI keys are returned even with the documented -101 anonymous envelope.
    if (payload?.code !== 0 && payload?.code !== -101) apiData(payload);
    const imageKey = (value) => typeof value === 'string' ? value.match(/\/([0-9a-f]{32})\.[a-z]+(?:[?#].*)?$/i)?.[1] : '';
    const imgKey = imageKey(payload?.data?.wbi_img?.img_url);
    const subKey = imageKey(payload?.data?.wbi_img?.sub_url);
    if (!imgKey || !subKey) throw new BilibiliError('bilibili_invalid_response');
    return { imgKey, subKey };
  })();
  wbiKeyCache.set(options, { at: Date.now(), promise });
  return promise;
}

export async function searchBilibili(keyword, options = {}) {
  const query = String(keyword ?? '').trim();
  if (!query || query.length > 100) return [];
  if (!readCookie('buvid3', options.cookie)) throw new BilibiliError('bilibili_login_required');
  const keys = await getWbiKeys(options);
  const params = signBilibiliWbi({ search_type: 'video', keyword: query, page: 1, order: 'pubdate' }, keys);
  const data = apiData(await requestJson('/x/web-interface/wbi/search/type', {
    ...options, params,
  }));
  if (!Array.isArray(data?.result)) throw new BilibiliError('bilibili_invalid_response');
  return data.result.slice(0, 10).filter((item) => item && typeof item === 'object').map((item) => {
    const bvid = typeof item.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(item.bvid) ? item.bvid : '';
    const aid = positiveId(item.aid ?? item.id);
    const result = {
      id: bvid || aid,
      kind: 'video', source: 'video', bvid,
      title: stripTags(item.title, 200),
      author: boundedString(item.author, 100),
      mid: positiveId(item.mid),
      description: stripTags(item.description, 500),
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : aid ? `https://www.bilibili.com/video/av${aid}` : '',
      publishedAt: Number(item.pubdate) || 0,
    };
    return { ...result, key: canonicalItemKey(result) };
  }).filter((item) => item.id);
}

export async function getUserDynamics(uid, options = {}) {
  const id = positiveId(uid);
  if (!id) return [];
  const data = apiData(await requestJson('/x/polymer/web-dynamic/v1/feed/space', {
    ...options, params: { host_mid: id },
  }));
  if (!Array.isArray(data?.items)) throw new BilibiliError('bilibili_invalid_response');
  return data.items.slice(0, 20).map(normalizeDynamic).filter((item) => item.id);
}

export function normalizeDynamic(item) {
  const modules = item?.modules ?? {};
  const author = modules.module_author ?? {};
  const content = modules.module_dynamic ?? {};
  const major = content.major ?? {};
  const id = positiveId(item?.id_str ?? item?.id);
  const title = stripTags(major.archive?.title ?? major.opus?.title ?? major.article?.title ?? '', 200);
  const text = stripTags(content.desc?.text ?? major.opus?.summary?.text ?? major.archive?.desc ?? major.article?.desc ?? '');
  const bvid = typeof major.archive?.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(major.archive.bvid) ? major.archive.bvid : '';
  const commentType = item?.basic?.comment_type;
  const result = {
    id, kind: 'dynamic', source: 'dynamic',
    type: boundedString(item?.type, 64), bvid, title,
    uid: positiveId(author.mid), author: boundedString(author.name, 100),
    text: text.slice(0, 800),
    url: id ? `https://t.bilibili.com/${id}` : '',
    publishedAt: Number(author.pub_ts) || 0,
    // Feed/space metadata: pskdje/bilibili-API-collect docs/dynamic/space.md.
    // Dynamic IDs and reply resource IDs differ; require the explicit reply metadata.
    commentOid: positiveId(item?.basic?.comment_id_str),
    commentType: COMMENT_TYPES.has(commentType) ? commentType : null,
  };
  return { ...result, key: canonicalItemKey(result) };
}

export function formatFeedSummary(items, { maxItems = 8 } = {}) {
  const limit = Math.max(1, Math.min(20, Math.floor(Number(maxItems) || 8)));
  const list = (Array.isArray(items) ? items : []).slice(0, limit);
  if (!list.length) return 'B站检查完成，暂时没有新内容。';
  return ['B站新内容：', ...list.map((item, index) => {
    const title = boundedString(item?.title, 200);
    const text = boundedString(item?.text, 800);
    const author = boundedString(item?.author, 100);
    const url = boundedString(item?.url, 256);
    const description = title && text ? `${title} ${text}` : title || text || '（无文字）';
    return `${index + 1}. ${description}${author ? ` · ${author}` : ''}${url ? `\n${url}` : ''}`;
  })].join('\n');
}

function readCookie(name, cookie) {
  if (typeof cookie !== 'string' || cookie.length > 32768 || /[\r\n]/.test(cookie)) return '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

export async function validateBilibiliLogin(options = {}) {
  if (!readCookie('SESSDATA', options.cookie)) throw new BilibiliError('bilibili_login_required');
  const data = apiData(await requestJson('/x/web-interface/nav', options));
  if (data?.isLogin !== true || !positiveId(data?.mid)) throw new BilibiliError('bilibili_login_required');
  return { uid: positiveId(data.mid) };
}

export async function resolveBilibiliMention(uid, options = {}) {
  const id = positiveId(uid);
  if (!id || !Number.isSafeInteger(Number(id))) throw new BilibiliError('bilibili_invalid_mention');
  // User-card API: https://github.com/Yuelioi/bpi-rs/blob/main/src/user/client.rs
  const data = apiData(await requestJson('/x/web-interface/card', { ...options, params: { mid: id } }));
  const card = data?.card;
  const name = typeof card?.name === 'string' ? card.name.trim() : '';
  if (positiveId(card?.mid) !== id || !name || name.length > 64 || /[@\uFF20\r\n\x00-\x1f]/.test(name)) {
    throw new BilibiliError('bilibili_invalid_mention');
  }
  return { uid: id, name };
}

export async function publishDynamicComment({ item, cookie, mentionUid, text, fetchImpl = globalThis.fetch, timeoutMs = 15000, beforePublish } = {}) {
  const oid = positiveId(item?.commentOid);
  const type = item?.commentType;
  const uid = positiveId(mentionUid);
  const content = typeof text === 'string' ? text.trim() : '';
  if ((item?.kind !== 'dynamic' && item?.source !== 'dynamic') || !positiveId(item?.id) || !oid || !COMMENT_TYPES.has(type) || !uid || !Number.isSafeInteger(Number(uid)) || !content || content.length > 1000 || /[@\uFF20]/.test(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
    return { published: false, reason: 'bilibili_invalid_comment', blocked: true };
  }
  const csrf = readCookie('bili_jct', cookie);
  if (!csrf || !/^[a-zA-Z0-9_-]{1,128}$/.test(csrf)) {
    return { published: false, reason: 'bilibili_login_required', blocked: true };
  }
  const options = { cookie, fetchImpl, timeoutMs };
  let postStarted = false;
  try {
    await validateBilibiliLogin(options);
    const mention = await resolveBilibiliMention(uid, options);
    const message = `${content} @${mention.name} `;
    if (message.length > 1000) return { published: false, reason: 'bilibili_invalid_comment', blocked: true };
    // Verified protocols: inorilzy/bilibili-api comment.py (resource types) and
    // jackwener/OpenCLI clis/bilibili/comment.js (reply/add, csrf, at_name_to_mid).
    const body = new URLSearchParams({
      oid, type: String(type), message, plat: '1', csrf,
      at_name_to_mid: JSON.stringify({ [mention.name]: Number(uid) }),
    });
    if (beforePublish !== undefined) {
      let allowed = false;
      try { allowed = typeof beforePublish === 'function' && await beforePublish({ message }) === true; } catch {}
      if (!allowed) return { published: false, reason: 'bilibili_publication_cancelled', blocked: false };
    }
    postStarted = true;
    const data = apiData(await requestJson('/x/v2/reply/add', { ...options, body }));
    const rpid = positiveId(data?.rpid_str ?? data?.rpid);
    if (!rpid) return { published: false, reason: 'bilibili_comment_uncertain', blocked: true, uncertain: true, message };
    return { published: true, rpid, message };
  } catch (error) {
    return {
      published: false,
      reason: error instanceof BilibiliError ? error.reason : 'bilibili_request_failed',
      blocked: true,
      ...(postStarted && !['bilibili_login_required', 'bilibili_api_rejected'].includes(error?.reason) ? { uncertain: true } : {}),
    };
  }
}

export function createBilibiliAdapter(options = {}) {
  return Object.freeze({
    search: (keyword) => searchBilibili(keyword, options),
    dynamics: (uid) => getUserDynamics(uid, options),
    resolveMention: (uid) => resolveBilibiliMention(uid, options),
    validateLogin: () => validateBilibiliLogin(options),
    publishComment: (item, text, uid, publishOptions = {}) => publishDynamicComment({ ...options, beforePublish: publishOptions?.beforePublish, item, text, mentionUid: uid }),
  });
}

export const BILIBILI_API_ROOT = API_ROOT;
