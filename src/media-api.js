export const IMAGE_PROVIDERS = Object.freeze({
  comfyui: { label: 'ComfyUI 异步接口', baseUrl: '', model: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' },
  'openai-compatible': { label: '自定义 OpenAI 兼容', baseUrl: '', model: '' },
});

export const TTS_PROVIDERS = Object.freeze({
  edge: { label: 'Edge TTS', baseUrl: '', model: '', apiVoice: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', apiVoice: 'alloy' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', apiVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
  'openai-compatible': { label: '自定义 OpenAI 兼容', baseUrl: '', model: '', apiVoice: '' },
});

export function validMediaBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function mediaEndpoint(baseUrl, endpoint) {
  if (!validMediaBaseUrl(baseUrl)) throw new Error('media_invalid_url');
  const base = String(baseUrl).replace(/\/+$/, '');
  return new URL(`${base}${/\/v1$/i.test(base) ? endpoint.replace(/^\/v1(?=\/)/, '') : endpoint}`);
}

export function validMediaKey(value) {
  return typeof value === 'string' && value.length <= 4096 && (value.trim() === '' || /^[\x21-\x7e]+$/.test(value)) && value !== '***';
}

export function mediaHeaders(apiKey, json = false) {
  if (!validMediaKey(apiKey ?? '')) throw new Error('media_invalid_key');
  const key = String(apiKey ?? '').trim();
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

export async function boundedMediaBody(response, limit, oversized) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw oversized();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) {
      await response.body?.cancel().catch(() => {});
      throw oversized();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
