import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { boundedMediaBody, mediaEndpoint, mediaHeaders } from './media-api.js';

export const IMAGE_PRESETS = Object.freeze({
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 },
});

export function imagegenError(message, code = 'IMAGEGEN_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function imageRequest(input = {}) {
  const allowed = new Set(['prompt', 'negative_prompt', 'preset', 'width', 'height', 'seed', 'steps', 'cfg', 'mode', 'tags']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw imagegenError('生图参数必须是对象');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw imagegenError(`不支持的生图参数：${key}`);
  const request = {};
  for (const key of ['prompt', 'negative_prompt']) {
    if (key === 'negative_prompt' && input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 16000 || (key === 'prompt' && !input[key].trim())) {
      throw imagegenError(`${key} 必须是最多 16000 字的${key === 'prompt' ? '非空' : ''}字符串`);
    }
    request[key] = input[key].trim();
  }
  const preset = input.preset ?? 'square';
  if (!Object.hasOwn(IMAGE_PRESETS, preset)) throw imagegenError('画幅必须是 square、landscape 或 portrait');
  for (const key of ['width', 'height']) {
    const value = input[key] ?? IMAGE_PRESETS[preset][key];
    if (!Number.isInteger(value) || value < 256 || value > 2048) throw imagegenError(`${key} 必须是 256–2048 之间的整数`);
    request[key] = value;
  }
  if (input.seed !== undefined && input.seed !== '') {
    const value = input.seed;
    if (!(typeof value === 'string' && /^\d{1,20}$/.test(value)) && !(Number.isSafeInteger(value) && value >= 0)) {
      throw imagegenError('seed 必须是无符号整数，大整数请用十进制字符串');
    }
    const seed = BigInt(value);
    if (seed > 18446744073709551615n) throw imagegenError('seed 超出 uint64 范围');
    request.seed = String(seed);
  }
  if (input.steps !== undefined) {
    if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100) throw imagegenError('steps 必须是 1–100 之间的整数');
    request.steps = input.steps;
  }
  if (input.cfg !== undefined) {
    if (typeof input.cfg !== 'number' || !Number.isFinite(input.cfg) || input.cfg < 0 || input.cfg > 15) throw imagegenError('cfg 必须是 0–15 之间的数字');
    request.cfg = input.cfg;
  }
  if (input.mode !== undefined && !['image', 'sticker'].includes(input.mode)) throw imagegenError('模式必须是 image 或 sticker');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || !input.tags.every((v) => typeof v === 'string' && v.length <= 60))) {
    throw imagegenError('tags 必须是最多 20 个短标签');
  }
  return { request, mode: input.mode ?? 'image', tags: input.tags ?? [] };
}

// The service returns uint64 seeds as JSON numbers. Keep their original decimal token.
export function parseImageJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key === 'seed' && typeof value === 'number') {
      if (context?.source && /^\d+$/.test(context.source)) return context.source;
      if (!Number.isSafeInteger(value)) throw imagegenError('当前 Node 无法精确读取 seed，请升级 Node 22+');
      return String(value);
    }
    return value;
  });
}

export function imageServiceUrl(settings, relative) {
  const base = new URL(settings.baseUrl);
  const url = new URL(relative, `${base.origin}/`);
  if (url.origin !== base.origin || url.username || url.password || url.hash) throw imagegenError('生图服务返回了不属于当前服务的地址');
  return url;
}

export function providerImageRequest(settings, request) {
  const provider = settings.provider ?? 'comfyui';
  if (provider === 'comfyui') return request;
  if (provider === 'siliconflow') {
    if (request.seed !== undefined && BigInt(request.seed) > 9999999999n) throw imagegenError('硅基流动的 seed 必须小于 10000000000');
    return {
      model: settings.model, prompt: request.prompt, image_size: `${request.width}x${request.height}`,
      ...(request.negative_prompt ? { negative_prompt: request.negative_prompt } : {}),
      ...(request.seed !== undefined ? { seed: Number(request.seed) } : {}),
      ...(request.steps !== undefined ? { num_inference_steps: request.steps } : {}),
      ...(request.cfg !== undefined ? { guidance_scale: request.cfg } : {}),
    };
  }
  for (const key of ['seed', 'steps', 'cfg']) if (request[key] !== undefined) throw imagegenError(`当前平台不支持 ${key}，请清空该选项`);
  let size = `${request.width}x${request.height}`;
  if (provider === 'openai') {
    const model = settings.model;
    const horizontal = request.width > request.height;
    const square = request.width === request.height;
    if (model === 'dall-e-2' && !square) throw imagegenError('dall-e-2 只支持方图');
    size = square ? '1024x1024' : model === 'dall-e-3'
      ? horizontal ? '1792x1024' : '1024x1792'
      : horizontal ? '1536x1024' : '1024x1536';
  }
  return { model: settings.model, prompt: [request.prompt, request.negative_prompt ? `Avoid: ${request.negative_prompt}` : ''].filter(Boolean).join('\n\n'),
    n: 1, size, ...(!/^gpt-image-|^chatgpt-image-/.test(settings.model) ? { response_format: 'b64_json' } : {}) };
}

export function createImageClient(settings, { signal, fetchImpl = fetch } = {}) {
  const synchronous = settings.provider && settings.provider !== 'comfyui';
  async function call(relative, { method = 'GET', body, image = false, external = false } = {}) {
    const timeout = AbortSignal.timeout(synchronous && method === 'POST' ? settings.timeoutMs : settings.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      const url = external ? new URL(relative, `${settings.baseUrl}/`) : imageServiceUrl(settings, relative);
      const sameOrigin = url.origin === new URL(settings.baseUrl).origin;
      if (external && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!sameOrigin && url.protocol !== 'https:'))) {
        throw imagegenError('生图服务返回了不安全的图片地址', 'IMAGEGEN_RESPONSE', 502);
      }
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: combined,
        headers: mediaHeaders(sameOrigin ? settings.apiKey : '', Boolean(body)),
        ...(body ? { body } : {}),
      });
      const limit = image ? settings.maxBytes : synchronous && method === 'POST' ? Math.ceil(settings.maxBytes * 4 / 3) + 1024 * 1024 : 1024 * 1024;
      const buffer = await boundedMediaBody(response, limit, () => imagegenError('生图响应超过大小上限', 'IMAGEGEN_RESPONSE', 502));
      if (!response.ok) throw imagegenError(`生图服务返回 HTTP ${response.status}`, 'IMAGEGEN_HTTP', response.status);
      return image ? buffer : parseImageJson(buffer.toString('utf8'));
    } catch (error) {
      if (error.code?.startsWith('IMAGEGEN_')) throw error;
      if (signal?.aborted) throw imagegenError('生图等待已停止，可按任务编号恢复', 'IMAGEGEN_PAUSED', 409);
      throw imagegenError('生图服务连接失败或响应无效，请检查服务状态', 'IMAGEGEN_NETWORK', 502);
    }
  }
  return {
    synchronous: Boolean(synchronous),
    async health() {
      if (synchronous) {
        const result = await call(mediaEndpoint(settings.baseUrl, '/v1/models').href);
        if (!Array.isArray(result?.data)) throw imagegenError('模型列表检查未通过，请检查 API 地址', 'IMAGEGEN_RESPONSE', 502);
        return { status: 'ok' };
      }
      const result = await call('/health');
      if (result?.status !== 'ok') throw imagegenError('生图服务健康检查未通过', 'IMAGEGEN_RESPONSE', 502);
      return { status: 'ok' };
    },
    async submit(request) {
      const wire = { ...providerImageRequest(settings, request) };
      if (!synchronous && wire.seed !== undefined) {
        if (typeof JSON.rawJSON !== 'function') throw imagegenError('精确发送 seed 需要 Node 22+');
        wire.seed = JSON.rawJSON(wire.seed);
      }
      const result = await call(synchronous ? mediaEndpoint(settings.baseUrl, settings.generationPath).href : settings.generationPath, { method: 'POST', body: JSON.stringify(wire) });
      if (!synchronous) return result;
      const images = result?.data ?? (settings.provider === 'siliconflow' ? result?.images : undefined);
      if (!Array.isArray(images) || images.length !== 1 || !images[0] || (!images[0].b64_json && !images[0].url)) {
        throw imagegenError('生图服务未返回一张有效图片', 'IMAGEGEN_RESPONSE', 502);
      }
      return { id: randomUUID(), status: 'completed', images: images.map(({ b64_json, url }) => ({ ...(b64_json ? { b64_json } : {}), ...(url ? { url } : {}) })) };
    },
    status: (url) => call(url),
    async download(source) {
      if (typeof source?.b64_json === 'string') {
        const encoded = source.b64_json;
        if (encoded.length > Math.ceil(settings.maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
          throw imagegenError('生图结果的 Base64 图片无效或过大', 'IMAGEGEN_RESPONSE', 502);
        }
        const buffer = Buffer.from(encoded, 'base64');
        if (buffer.length > settings.maxBytes) throw imagegenError('生图响应超过大小上限', 'IMAGEGEN_RESPONSE', 502);
        return buffer;
      }
      return call(typeof source === 'string' ? source : source.url, { image: true, external: Boolean(synchronous) });
    },
    wait: () => sleep(settings.pollIntervalMs, undefined, { signal }),
  };
}
