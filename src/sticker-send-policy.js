import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isImageFile, stickerRootDir } from './stickers.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGE_ACTIONS = new Set([
  'send_msg', 'send_group_msg', 'send_private_msg',
  'send_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg',
]);
const FILE_ACTIONS = new Set(['upload_group_file', 'upload_private_file']);
const EMOJI_TYPES = new Set(['face', 'mface', 'marketface']);
const SKIP_RESULT = Object.freeze({
  ok: true,
  skipped: true,
  reason: 'sticker_probability',
  message: '本次未命中表情发送概率，请勿重试；文字和普通文件不受影响。',
});

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function decodeCq(value) {
  const entities = { '&amp;': '&', '&#91;': '[', '&#93;': ']', '&#44;': ',' };
  return value.replace(/&amp;|&#91;|&#93;|&#44;/g, (entity) => entities[entity]);
}

function cqData(attributes) {
  const entries = [];
  for (const item of attributes.split(',').slice(1)) {
    const equals = item.indexOf('=');
    if (equals > 0) entries.push([item.slice(0, equals), decodeCq(item.slice(equals + 1))]);
  }
  return Object.fromEntries(entries);
}

function autoEscaped(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function mayContainSticker(message, escaped = false, depth = 0) {
  if (depth > 32) throw new Error('转发表情消息嵌套层数过多。');
  if (typeof message === 'string') {
    return !escaped && /\[CQ:(?:face|mface|marketface|image|file)(?:,[^\]]*)?\]/i.test(message);
  }
  if (!Array.isArray(message)) return false;
  return message.some((segment) => {
    if (!segment || typeof segment !== 'object') return false;
    const type = String(segment.type ?? '').toLowerCase();
    if (EMOJI_TYPES.has(type) || type === 'image' || type === 'file') return true;
    return type === 'node' && mayContainSticker(segment.data?.content, autoEscaped(segment.data?.auto_escape), depth + 1);
  });
}

async function readSettings(options) {
  let config = options.config ?? {};
  if (options.configPath) {
    try {
      config = JSON.parse((await fs.readFile(options.configPath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('无法读取表情发送概率配置。');
    }
  }
  const probability = config?.stickers?.sendProbability === undefined ? 1 : config.stickers.sendProbability;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('stickers.sendProbability 必须是 0 到 1 之间的数字。');
  }
  const configRoot = path.resolve(options.configRoot || options.projectRoot || PROJECT_ROOT);
  return { probability, root: stickerRootDir({ configRoot, config }) };
}

function createLibraryMatcher(root, cwd) {
  const cache = new Map();
  let rootReal;
  let index;
  const realRoot = () => rootReal ??= fs.realpath(root).catch(() => null);
  const realImage = async (candidate) => {
    if (!isImageFile(candidate)) return false;
    const [base, file] = await Promise.all([realRoot(), fs.realpath(candidate).catch(() => null)]);
    if (!base || !file || !inside(base, file)) return false;
    try { return (await fs.stat(file)).isFile(); } catch { return false; }
  };
  const indexedImage = async (value) => {
    index ??= fs.readFile(path.join(root, 'index.json'), 'utf8')
      .then((text) => JSON.parse(text.replace(/^\uFEFF/, '')))
      .then((value) => Array.isArray(value?.items) ? value.items : [])
      .catch(() => []);
    for (const item of await index) {
      if (typeof item?.file !== 'string' || path.isAbsolute(item.file) || path.win32.isAbsolute(item.file)) continue;
      if (value !== item.id && value.replace(/\\/g, '/') !== item.file.replace(/\\/g, '/')) continue;
      const file = path.resolve(root, item.file);
      if (inside(path.resolve(root), file) && await realImage(file)) return true;
    }
    return false;
  };
  const matches = async (raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const value = raw.trim();
    let local;
    if (/^file:/i.test(value)) {
      try { local = fileURLToPath(value); } catch { return false; }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !path.win32.isAbsolute(value)) {
      return false;
    } else {
      local = path.resolve(cwd, value);
    }
    try {
      await fs.stat(local);
      return realImage(local);
    } catch {
      return !path.isAbsolute(value) && !path.win32.isAbsolute(value) ? indexedImage(value) : false;
    }
  };
  return (value) => {
    if (!cache.has(value)) cache.set(value, matches(value));
    return cache.get(value);
  };
}

function hasContent(message) {
  if (typeof message === 'string') return message.trim().length > 0;
  if (!Array.isArray(message)) return message !== null && message !== undefined;
  return message.some((segment) => {
    if (!segment || typeof segment !== 'object') return Boolean(segment);
    if (segment.type === 'text') return String(segment.data?.text ?? '').trim().length > 0;
    if (segment.type === 'node' && Object.hasOwn(segment.data ?? {}, 'content')) {
      return hasContent(segment.data.content);
    }
    return true;
  });
}

/** Filter supported QQ sends without granting the sender any additional tools. */
export async function applyStickerSendPolicy(action, params, options = {}) {
  const unchanged = { action, params, skipped: false, filtered: 0, probability: 1 };
  if (!MESSAGE_ACTIONS.has(action) && !FILE_ACTIONS.has(action)) return unchanged;
  if (MESSAGE_ACTIONS.has(action) && !['message', 'messages'].some((field) =>
    mayContainSticker(params?.[field], autoEscaped(params?.auto_escape)))) return unchanged;
  const { probability, root } = await readSettings(options);
  const original = { ...unchanged, probability };
  if (probability === 1 || !params || typeof params !== 'object') return original;
  const isLibraryImage = createLibraryMatcher(root, path.resolve(options.cwd || process.cwd()));
  const stickerSegment = async (type, raw) => {
    const data = raw && typeof raw === 'object' ? raw : {};
    return EMOJI_TYPES.has(type) ||
      ((type === 'image' || type === 'file') &&
        ((type === 'image' && Number(data.sub_type ?? data.subType) === 1) ||
          await isLibraryImage(data.file ?? data.url)));
  };

  let stickerCount = 0;
  let stripped;
  if (FILE_ACTIONS.has(action)) {
    if (await isLibraryImage(params.file)) stickerCount = 1;
  } else {
    const walk = async (message, escaped = false, depth = 0) => {
      if (depth > 32) throw new Error('转发表情消息嵌套层数过多。');
      if (typeof message === 'string') {
        if (escaped) return message;
        const matches = [...message.matchAll(/\[CQ:([a-z\d_-]+)((?:,[^\]]*)?)\]/gi)];
        const drop = await Promise.all(matches.map((match) => stickerSegment(match[1].toLowerCase(), cqData(match[2]))));
        let value = '';
        let from = 0;
        matches.forEach((match, i) => {
          value += message.slice(from, match.index);
          if (drop[i]) stickerCount += 1;
          else value += match[0];
          from = match.index + match[0].length;
        });
        return value + message.slice(from);
      }
      if (!Array.isArray(message)) return message;
      const result = [];
      for (const segment of message) {
        if (!segment || typeof segment !== 'object') {
          result.push(segment);
          continue;
        }
        const type = String(segment.type ?? '').toLowerCase();
        if (await stickerSegment(type, segment.data)) {
          stickerCount += 1;
          continue;
        }
        // Text segments stay opaque: a literal CQ string is still plain text.
        if (type === 'node' && Object.hasOwn(segment.data ?? {}, 'content')) {
          const before = stickerCount;
          const content = await walk(segment.data.content, autoEscaped(segment.data.auto_escape), depth + 1);
          if (stickerCount > before && !hasContent(content)) continue;
          result.push(content === segment.data.content ? segment : {
            ...segment, data: { ...segment.data, content },
          });
        } else {
          result.push(segment);
        }
      }
      return result;
    };
    stripped = { ...params };
    for (const field of ['message', 'messages']) {
      if (Object.hasOwn(params, field)) {
        stripped[field] = await walk(params[field], autoEscaped(params.auto_escape));
      }
    }
  }
  if (stickerCount === 0) return original;
  let allowed = false;
  if (probability > 0) {
    const sample = (options.random ?? Math.random)();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('表情发送随机数必须在 [0, 1) 范围内。');
    allowed = sample < probability;
  }
  if (allowed) return original;
  const skipped = FILE_ACTIONS.has(action) ||
    !['message', 'messages'].some((field) => Object.hasOwn(stripped, field) && hasContent(stripped[field]));
  return {
    action, params: stripped ?? params, probability, filtered: stickerCount, skipped,
    ...(skipped ? { result: { ...SKIP_RESULT, probability } } : {}),
  };
}
