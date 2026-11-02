import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { invalidateAstrbotScheduledAuthorization } from './astrbot-outbound.mjs';

const execFileAsync = promisify(execFile);
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_RPC_BODY = 2 * 1024 * 1024;
const MAX_TREE_FILES = 100_000;
const MAX_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PLUGIN_SCHEMA_BYTES = 256 * 1024;
const RUNTIME_STOP_TIMEOUT_MS = 60_000;
const GENERATION_PREPARE_TIMEOUT_MS = 1_800_000;
const GENERATION_STARTUP_TIMEOUT_MS = 160_000;
const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:5831';
const DEFAULT_CALLBACK_URL = 'http://127.0.0.1:5832/rpc/callback';
const ALLOWED_GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com']);
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);

function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw failure('ASTRBOT_BAD_INPUT', label + ' must be a JSON object.');
  }
  return value;
}

function safeJsonValue(value, label, maxBytes = 256 * 1024) {
  const visit = (item, seen) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      if (seen.has(item)) throw failure('ASTRBOT_BAD_INPUT', label + ' must not contain cycles.');
      seen.add(item);
      for (const child of item) visit(child, seen);
      seen.delete(item);
      return;
    }
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      if (seen.has(item)) throw failure('ASTRBOT_BAD_INPUT', label + ' must not contain cycles.');
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          throw failure('ASTRBOT_BAD_INPUT', label + ' contains an unsafe key.');
        }
        visit(child, seen);
      }
      seen.delete(item);
      return;
    }
    throw failure('ASTRBOT_BAD_INPUT', label + ' must contain only JSON values.');
  };
  visit(value, new Set());
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw failure('ASTRBOT_BAD_INPUT', label + ' is too large.');
  return text;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function archivePath(rawName, isDirectory) {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')
      || rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive contains an unsafe path.');
  }
  const name = isDirectory ? rawName.replace(/\/+$/, '') : rawName;
  const segments = name.split('/');
  if (!name || segments.some((part) => !part || part === '.' || part === '..'
      || part.includes(':') || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
      || /[\u0000-\u001f<>\"|?*]/.test(part))) {
    throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive contains an unsafe path.');
  }
  return segments.join('/');
}

function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP_BYTES) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive is empty or exceeds the size limit.');
  }
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has no valid ZIP directory.');
  }
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount
      || entryCount === 0 || entryCount > MAX_ZIP_ENTRIES
      || directoryOffset === 0xffffffff || directorySize === 0xffffffff
      || eocd + 22 + commentLength !== buffer.length
      || directoryOffset + directorySize > eocd) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive uses an unsupported ZIP layout.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = [];
  const seenNames = new Set();
  let expandedTotal = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryOffset + directorySize || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has a malformed ZIP directory.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (end > directoryOffset + directorySize || nameLength === 0
        || compressedSize === 0xffffffff || expandedSize === 0xffffffff
        || localOffset === 0xffffffff || diskStart !== 0 || (flags & 1) !== 0
        || (flags & 0x20) !== 0 || ![0, 8].includes(method)) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive uses an unsupported ZIP entry.');
    }
    let rawName;
    try {
      rawName = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive contains a non-UTF-8 path.');
    }
    const unixMode = externalAttributes >>> 16;
    const windowsAttributes = externalAttributes & 0xffff;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    const isSpecial = unixMode !== 0 && ![0x4000, 0x8000, 0xa000].includes(unixMode & 0xf000);
    const isReparsePoint = (windowsAttributes & 0x0400) !== 0;
    const isDirectory = rawName.endsWith('/');
    if (isSymlink || isSpecial || isReparsePoint) {
      throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive contains a link or special file.');
    }
    const relative = archivePath(rawName, isDirectory);
    const identity = relative.toLocaleLowerCase('en-US');
    if (seenNames.has(identity)) throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive contains duplicate paths.');
    seenNames.add(identity);
    expandedTotal += expandedSize;
    if (expandedTotal > MAX_EXPANDED_BYTES) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive expands beyond the size limit.');
    }
    entries.push({
      relative, isDirectory, method, expectedCrc, compressedSize, expandedSize, localOffset,
      localName: Buffer.from(buffer.subarray(offset + 46, offset + 46 + nameLength)),
    });
    offset = end;
  }
  if (offset !== directoryOffset + directorySize) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive directory size is inconsistent.');
  }
  const roots = new Set(entries.map((entry) => entry.relative.split('/')[0]));
  if (roots.size !== 1) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive must contain one top-level directory.');
  }
  const rootName = [...roots][0];
  if (!entries.some((entry) => !entry.isDirectory && entry.relative !== rootName)) {
    throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has no files.');
  }
  const files = new Set(entries.filter((entry) => !entry.isDirectory)
    .map((entry) => entry.relative.toLocaleLowerCase('en-US')));
  for (const entry of entries) {
    const parts = entry.relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      if (files.has(parts.slice(0, length).join('/').toLocaleLowerCase('en-US'))) {
        throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive has a file-directory path conflict.');
      }
    }
  }
  return { entries, rootName };
}

function cleanPluginId(value) {
  const id = String(value || '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!id || id.length > 128 || id === '.' || id === '..'
      || ['__all__', '__proto__', 'constructor', 'prototype'].includes(id)) {
    throw failure('ASTRBOT_BAD_PLUGIN_ID', 'The plugin archive has no safe plugin name.');
  }
  return id;
}

function parseGithubSource(source) {
  if (typeof source !== 'string' || source.length > 2048) {
    throw failure('ASTRBOT_BAD_SOURCE', 'source must be a GitHub repository URL or owner/repository.');
  }
  let owner;
  let repository;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    [owner, repository] = source.split('/');
  } else {
    let url;
    try { url = new URL(source); } catch {
      throw failure('ASTRBOT_BAD_SOURCE', 'source must be a GitHub repository URL or owner/repository.');
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
        || url.port || url.search || url.hash || !match) {
      throw failure('ASTRBOT_BAD_SOURCE', 'Only public GitHub repository URLs are supported.');
    }
    owner = match[1];
    repository = match[2];
  }
  repository = repository.replace(/\.git$/i, '');
  if (!owner || !repository || owner === '.' || owner === '..'
      || repository === '.' || repository === '..') {
    throw failure('ASTRBOT_BAD_SOURCE', 'Invalid GitHub repository source.');
  }
  return { owner, repository, id: cleanPluginId(owner + '_' + repository) };
}

function validateRef(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref !== 'string' || ref.length > 160 || !/^[A-Za-z0-9._/-]+$/.test(ref)
      || ref.startsWith('/') || ref.includes('..') || ref.includes('//') || ref.endsWith('/')
      || ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    throw failure('ASTRBOT_BAD_REF', 'ref must be a safe Git branch or tag name.');
  }
  return ref;
}

async function assertSafePath(value) {
  const absolute = path.resolve(value);
  for (let probe = absolute; ; probe = path.dirname(probe)) {
    try {
      const info = await lstat(probe);
      if (info.isSymbolicLink() || (process.platform === 'win32' && (info.attributes & 0x400) !== 0)) {
        throw failure('ASTRBOT_UNSAFE_PATH', 'AstrBot storage contains a symbolic link or reparse point.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(probe) === probe) break;
  }
}

async function ensureDirectory(directory) {
  await assertSafePath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafePath(directory);
}

async function pathExists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(file, fallback) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
      throw failure('ASTRBOT_BAD_STATE', 'AstrBot state file is not a regular bounded file.');
    }
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicJson(file, value) {
  const directory = path.dirname(file);
  await ensureDirectory(directory);
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    if (process.platform !== 'win32') await (await import('node:fs/promises')).chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function scanRegularTree(root) {
  const result = [];
  let totalBytes = 0;
  const visit = async (directory, relative) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const rel = relative ? relative + '/' + entry.name : entry.name;
      const info = await lstat(full);
      if (info.isSymbolicLink() || (process.platform === 'win32' && (info.attributes & 0x400) !== 0)) {
        throw failure('ASTRBOT_UNSAFE_PATH', 'Plugin data contains a symbolic link or reparse point.');
      }
      if (info.isDirectory()) await visit(full, rel);
      else if (info.isFile()) {
        totalBytes += info.size;
        if (result.length >= MAX_TREE_FILES || totalBytes > MAX_TREE_BYTES) {
          throw failure('ASTRBOT_TREE_TOO_LARGE', 'AstrBot generation exceeds the safe file count or size limit.', 413);
        }
        result.push({ path: full, relative: rel });
      }
      else throw failure('ASTRBOT_UNSAFE_PATH', 'Plugin data contains a special file.');
    }
  };
  await visit(root, '');
  return result;
}

async function treeHash(root) {
  const files = await scanRegularTree(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update(Buffer.from([0]));
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function extractZip(buffer, destination) {
  const { entries, rootName } = parseZip(buffer);
  await ensureDirectory(destination);
  const extractedRoot = path.join(destination, rootName);
  await ensureDirectory(extractedRoot);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (const entry of entries) {
    if (entry.relative === rootName) continue;
    const relative = entry.relative.slice(rootName.length + 1);
    const target = path.resolve(extractedRoot, ...relative.split('/'));
    const prefix = path.resolve(extractedRoot) + path.sep;
    if (target !== path.resolve(extractedRoot) && !target.startsWith(prefix)) {
      throw failure('ASTRBOT_UNSAFE_ARCHIVE', 'The plugin archive escapes its staging directory.');
    }
    if (entry.isDirectory) {
      await ensureDirectory(target);
      continue;
    }
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has a malformed local file header.');
    }
    const flags = buffer.readUInt16LE(local + 6);
    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    if ((flags & 1) !== 0 || local + 30 + nameLength + extraLength > buffer.length) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has an unsupported local file header.');
    }
    let localName;
    try { localName = utf8.decode(buffer.subarray(local + 30, local + 30 + nameLength)); } catch {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive contains a non-UTF-8 path.');
    }
    if (localName !== entry.relative) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'ZIP directory and local paths do not match.');
    }
    const dataStart = local + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive has truncated data.');
    const compressed = buffer.subarray(dataStart, dataEnd);
    let contents;
    try {
      contents = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.expandedSize + 1 });
    } catch {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'A plugin archive file could not be decompressed safely.');
    }
    if (contents.length !== entry.expandedSize || crc32(contents) !== entry.expectedCrc) {
      throw failure('ASTRBOT_BAD_ARCHIVE', 'A plugin archive file failed its size or CRC check.');
    }
    await ensureDirectory(path.dirname(target));
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
  }
  return extractedRoot;
}

async function readLimitedBody(response, maxBytes, code, message) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw failure(code, message, 502);
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!response.body) return Buffer.alloc(0);
    throw failure('ASTRBOT_RPC_BAD_RESPONSE', 'The response body is not a readable stream.', 502);
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = value?.byteLength ?? value?.length ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw failure(code, message, 502);
      }
      total += size;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function fetchLimited(fetchImpl, initialUrl, { timeoutMs, maxBytes, json = false }) {
  let target = new URL(initialUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (target.protocol !== 'https:' || !ALLOWED_GITHUB_HOSTS.has(target.hostname)
          || target.username || target.password || target.port) {
        throw failure('ASTRBOT_BAD_SOURCE', 'The download URL or redirect host is not allowed.');
      }
      const response = await fetchImpl(target, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'qq-bridge-astrbot/1',
          Accept: json ? 'application/vnd.github+json' : 'application/zip, application/octet-stream',
        },
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw failure('ASTRBOT_DOWNLOAD_FAILED', 'GitHub returned an invalid redirect.');
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) throw failure('ASTRBOT_DOWNLOAD_FAILED', 'GitHub download failed with HTTP ' + response.status + '.');
      const bytes = await readLimitedBody(response, maxBytes, 'ASTRBOT_BAD_ARCHIVE',
        'The plugin download exceeds the size limit.');
      return bytes;
    }
    throw failure('ASTRBOT_DOWNLOAD_FAILED', 'GitHub returned too many redirects.');
  } catch (error) {
    if (error.name === 'AbortError' || controller.signal.aborted) {
      throw failure('ASTRBOT_DOWNLOAD_TIMEOUT', 'The plugin download timed out.', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function githubArchive(fetchImpl, source, ref, options) {
  const repository = parseGithubSource(source);
  let selectedRef = ref;
  if (!selectedRef) {
    const metadataBytes = await fetchLimited(
      fetchImpl,
      'https://api.github.com/repos/' + encodeURIComponent(repository.owner) + '/'
        + encodeURIComponent(repository.repository),
      { ...options, maxBytes: 1024 * 1024, json: true },
    );
    let metadata;
    try { metadata = JSON.parse(metadataBytes.toString('utf8')); } catch {
      throw failure('ASTRBOT_DOWNLOAD_FAILED', 'GitHub returned invalid repository metadata.');
    }
    selectedRef = validateRef(metadata.default_branch);
    if (!selectedRef) throw failure('ASTRBOT_DOWNLOAD_FAILED', 'GitHub did not return a default branch.');
  }
  const archiveUrl = 'https://api.github.com/repos/' + encodeURIComponent(repository.owner) + '/'
    + encodeURIComponent(repository.repository) + '/zipball/'
    + selectedRef.split('/').map(encodeURIComponent).join('/');
  const archive = await fetchLimited(fetchImpl, archiveUrl, { ...options, maxBytes: MAX_ZIP_BYTES });
  return { archive, id: repository.id, ref: selectedRef, source: 'https://github.com/'
    + repository.owner + '/' + repository.repository };
}

function newManifest() {
  return { schemaVersion: 1, plugins: {}, history: {} };
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !value.plugins || typeof value.plugins !== 'object'
      || Array.isArray(value.plugins) || Object.getPrototypeOf(value.plugins) !== Object.prototype
      || !value.history || typeof value.history !== 'object' || Array.isArray(value.history)
      || Object.getPrototypeOf(value.history) !== Object.prototype) {
    throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin state has an unsupported format.');
  }
  for (const [id, plugin] of Object.entries(value.plugins)) {
    validatePluginId(id);
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)
        || Object.getPrototypeOf(plugin) !== Object.prototype
        || (plugin.id !== undefined && plugin.id !== id)
        || (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean')) {
      throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin state contains an invalid plugin entry.', 500);
    }
    if (plugin.config !== undefined) {
      if (!plugin.config || typeof plugin.config !== 'object' || Array.isArray(plugin.config)
          || Object.getPrototypeOf(plugin.config) !== Object.prototype) {
        throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin configuration is invalid.', 500);
      }
      try { safeJsonValue(plugin.config, 'stored plugin config', 256 * 1024); } catch {
        throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin configuration is invalid.', 500);
      }
    }
  }
  for (const [id, history] of Object.entries(value.history)) {
    validatePluginId(id);
    if (!Array.isArray(history) || history.length > 100) {
      throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin history is invalid.', 500);
    }
  }
  return value;
}

function validatePluginId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)
      || ['.', '..', '__ai__', '__all__', '__proto__', 'constructor', 'prototype'].includes(id)) {
    throw failure('ASTRBOT_BAD_PLUGIN_ID', 'id must be a safe installed plugin name.');
  }
  return id;
}

function withoutSecretSchemaDefaults(value, fieldName = '', depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 10_000) {
    throw failure('ASTRBOT_BAD_SCHEMA', 'Plugin configuration schema is too deep or large.');
  }
  if (Array.isArray(value)) {
    return value.map((item) => withoutSecretSchemaDefaults(item,
      String(item?.key ?? item?.name ?? item?.id ?? fieldName), depth + 1, budget));
  }
  if (!value || typeof value !== 'object') return value;
  const kind = String(value.type ?? value.datatype ?? value.dataType ?? '').toLowerCase();
  const secret = value.secret === true || value.sensitive === true
    || ['secret', 'password', 'passwd'].includes(kind)
    || String(value.format ?? '').toLowerCase() === 'password'
    || /secret|password|passwd|credential|authorization|access.?token|refresh.?token|api.?key|private.?key/i.test(fieldName);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || (secret && key === 'default')) continue;
    result[key] = withoutSecretSchemaDefaults(child, key, depth + 1, budget);
  }
  return result;
}

export function createAstrbotManager({
  projectRoot,
  configPath,
  readConfig,
  logger = () => {},
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  runtimeRpcImpl,
  installManagedPython,
  platform = process.platform,
  requestTimeoutMs = 20_000,
  healthTimeoutMs = 2_000,
  dispatchTimeoutMs = 180_000,
  downloadTimeoutMs = 120_000,
  jobIdFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required.');
  if (typeof configPath !== 'string' || !configPath) throw new TypeError('configPath is required.');
  if (typeof readConfig !== 'function') throw new TypeError('readConfig is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  const root = path.resolve(projectRoot);
  const absoluteConfigPath = path.resolve(configPath);
  const runtimeSource = path.join(root, 'runtime', 'astrbot');
  const lockPath = path.join(root, 'runtime', 'astrbot-lock.json');
  let child = null;
  let childExit = null;
  let operationQueue = Promise.resolve();
  let lifecycleQueue = Promise.resolve();
  let runtimeJobQueue = Promise.resolve();
  const jobs = new Map();
  const jobWrites = new Map();

  function configuration() {
    const value = readConfig();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw failure('ASTRBOT_BAD_CONFIG', 'readConfig() did not return an application config object.', 500);
    }
    return value;
  }

  function stateRoot() {
    const config = configuration();
    const configured = config.stateDir === undefined ? 'state' : config.stateDir;
    if (typeof configured !== 'string' || !configured.trim()) {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.stateDir must be a non-empty path.', 500);
    }
    return path.resolve(root, configured, 'astrbot');
  }

  async function invalidateScheduledAuthorization(pluginIds, reason) {
    await invalidateAstrbotScheduledAuthorization({
      root: stateRoot(),
      readConfig,
      pluginIds,
      reason,
    });
  }

  function configAstrbot() {
    const config = configuration();
    const value = config.astrbot;
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot must be an object.', 500);
    }
    return value;
  }

  function report(message) {
    try {
      const result = typeof logger === 'function' ? logger(message) : logger?.info?.(message);
      result?.catch?.(() => {});
    } catch { /* Logging must not interrupt runtime management. */ }
  }

  async function readPolicy() {
    const policy = await readJson(path.join(stateRoot(), 'policy.json'), { enabled: false });
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
        || (policy.enabled !== undefined && typeof policy.enabled !== 'boolean')) {
      throw failure('ASTRBOT_BAD_POLICY', 'state/astrbot/policy.json must contain a boolean enabled field.');
    }
    return { ...policy, enabled: policy.enabled === true };
  }

  function validGenerationId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw failure('ASTRBOT_BAD_STATE', 'AstrBot active generation identifier is invalid.', 500);
    }
    return id;
  }

  async function readGenerationState() {
    const rootPath = stateRoot();
    const top = await readJson(path.join(rootPath, 'plugins.json'), newManifest());
    if (top.schemaVersion === 1) {
      return { pointer: null, manifest: validateManifest(top), generationRoot: null };
    }
    if (top.schemaVersion !== 2 || !Array.isArray(top.history) || top.history.length > 100) {
      throw failure('ASTRBOT_BAD_STATE', 'AstrBot plugin state has an unsupported format.', 500);
    }
    const generationId = validGenerationId(top.activeGeneration);
    for (const item of top.history) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw failure('ASTRBOT_BAD_STATE', 'AstrBot generation history is invalid.', 500);
      }
      validGenerationId(item.generationId);
      if (item.pluginId !== null) validatePluginId(item.pluginId);
    }
    const generationRoot = path.join(rootPath, 'generations', generationId);
    await assertSafePath(generationRoot);
    const manifest = validateManifest(await readJson(
      path.join(generationRoot, 'manager', 'plugins.json'), null,
    ));
    return { pointer: top, manifest, generationRoot };
  }

  async function readManifest() {
    return (await readGenerationState()).manifest;
  }

  async function withStateLock(name, task, waitMs = 5 * 60_000) {
    const rootPath = stateRoot();
    await ensureDirectory(rootPath);
    const lockPath = path.join(rootPath, name);
    const token = randomUUID();
    const record = JSON.stringify({ token, pid: process.pid, createdAt: now() });
    const deadline = Date.now() + waitMs;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(record, 'utf8');
        await handle.sync();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw failure('ASTRBOT_MANAGER_BUSY', 'Another AstrBot manager operation is still active.', 409);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => {});
      try {
        if ((await readFile(lockPath, 'utf8')) === record) await rm(lockPath, { force: true });
      } catch { /* Keep an unexpected replacement lock intact. */ }
    }
  }

  async function copySafeTree(source, destination) {
    if (!(await pathExists(source))) return false;
    await assertSafePath(source);
    await scanRegularTree(source);
    await ensureDirectory(path.dirname(destination));
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await scanRegularTree(destination);
    return true;
  }

  async function ensureInitialGeneration() {
    return withStateLock('mutation.lock', async () => {
      const current = await readGenerationState();
      if (current.pointer) return current;
      const rootPath = stateRoot();
      const generationId = await createGenerationId('base-');
      const generationRoot = path.join(rootPath, 'generations', generationId);
      const stageRoot = path.join(rootPath, 'staging', 'generations', generationId);
      let pointerWritten = false;
      try {
        await ensureDirectory(path.join(stageRoot, 'manager'));
        await ensureDirectory(path.join(stageRoot, 'data', 'plugins'));
        await ensureDirectory(path.join(stageRoot, 'data', 'plugin_data'));
        await ensureDirectory(path.join(stageRoot, 'data', 'site-packages'));
        await copySafeTree(path.join(rootPath, 'plugins'), path.join(stageRoot, 'data', 'plugins-legacy'));
        if (await pathExists(path.join(stageRoot, 'data', 'plugins-legacy'))) {
          const legacy = path.join(stageRoot, 'data', 'plugins-legacy');
          const activePlugins = path.join(stageRoot, 'data', 'plugins');
          for (const entry of await readdir(legacy)) {
            await rename(path.join(legacy, entry), path.join(activePlugins, entry));
          }
          await rm(legacy, { recursive: true, force: true });
        }
        await copySafeTree(path.join(rootPath, 'plugin_data'), path.join(stageRoot, 'data', 'plugin_data-legacy'));
        if (await pathExists(path.join(stageRoot, 'data', 'plugin_data-legacy'))) {
          const legacy = path.join(stageRoot, 'data', 'plugin_data-legacy');
          const activeData = path.join(stageRoot, 'data', 'plugin_data');
          for (const entry of await readdir(legacy)) {
            await rename(path.join(legacy, entry), path.join(activeData, entry));
          }
          await rm(legacy, { recursive: true, force: true });
        }
        const legacyManifest = validateManifest(await readJson(path.join(rootPath, 'plugins.json'), newManifest()));
        await atomicJson(path.join(stageRoot, 'manager', 'plugins.json'), legacyManifest);
        await ensureDirectory(path.dirname(generationRoot));
        await rename(stageRoot, generationRoot);
        const pointer = { schemaVersion: 2, activeGeneration: generationId, history: [], updatedAt: now() };
        await atomicJson(path.join(rootPath, 'plugins.json'), pointer);
        pointerWritten = true;
      } catch (error) {
        await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        if (!pointerWritten) await rm(generationRoot, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return readGenerationState();
    });
  }

  async function getToken({ create = true } = {}) {
    const rootPath = stateRoot();
    const tokenPath = path.join(rootPath, 'rpc-token');
    const configuredToken = configAstrbot().token;
    if (configuredToken !== undefined && (typeof configuredToken !== 'string'
        || configuredToken.length < 32 || configuredToken.length > 4096
        || /[\r\n\0]/.test(configuredToken))) {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot.token must be a 32-4096 character secret.', 500);
    }
    if (create) await ensureDirectory(rootPath);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const info = await lstat(tokenPath);
        if (!info.isFile() || info.isSymbolicLink()
            || (platform === 'win32' && (info.attributes & 0x400) !== 0)) {
          throw failure('ASTRBOT_UNSAFE_PATH', 'The AstrBot RPC token path is not a regular file.', 500);
        }
        const stored = (await readFile(tokenPath, 'utf8')).trim();
        if (stored.length < 32 || stored.length > 4096 || /[\r\n\0]/.test(stored)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        if (configuredToken && stored !== configuredToken) {
          throw failure('ASTRBOT_TOKEN_MISMATCH', 'config.astrbot.token differs from state/astrbot/rpc-token.', 500);
        }
        return stored;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) throw failure('ASTRBOT_TOKEN_MISSING', 'The external AstrBot runtime token has not been provisioned.', 503);
      }
      const token = configuredToken || randomBytes(32).toString('base64url');
      try {
        const handle = await open(tokenPath, 'wx', 0o600);
        try {
          await handle.writeFile(token + '\n', 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (platform !== 'win32') {
          const fs = await import('node:fs/promises');
          await fs.chmod(tokenPath, 0o600);
        }
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw failure('ASTRBOT_TOKEN_BUSY', 'The AstrBot RPC token is being created by another process.', 503);
  }

  async function runtimeRpc(method, params, { signal, createToken = true } = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(method)) {
      throw failure('ASTRBOT_BAD_RPC', 'method must be a valid RPC method name.');
    }
    const serialized = safeJsonValue(params ?? {}, 'params', MAX_RPC_BODY);
    const runtimeUrl = runtimeSettings().runtimeUrl;
    let endpoint;
    try {
      endpoint = new URL('/rpc', runtimeUrl);
    } catch {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot.runtimeUrl must be a valid HTTP URL.', 500);
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.hash || endpoint.search) {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot.runtimeUrl must use HTTP or HTTPS without credentials.', 500);
    }
    const token = await getToken({ create: createToken });
    const controller = new AbortController();
    const timeoutMs = method === 'dispatch' ? Math.min(dispatchTimeoutMs, 180_000)
      : method === 'health' ? Math.min(healthTimeoutMs, 2_000)
        : method === 'generation.prepare' ? Math.max(requestTimeoutMs, GENERATION_PREPARE_TIMEOUT_MS)
        : method === 'generation.activate' ? Math.max(requestTimeoutMs, GENERATION_STARTUP_TIMEOUT_MS)
        : ['generation.freeze', 'runtime.stop'].includes(method)
          ? Math.max(requestTimeoutMs, RUNTIME_STOP_TIMEOUT_MS)
          : requestTimeoutMs;
    if (typeof runtimeRpcImpl === 'function') {
      return runtimeRpcImpl(method, JSON.parse(serialized), { signal, timeoutMs });
    }
    const timer = setTimeout(() => controller.abort(new Error('RPC request timed out.')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason || new Error('RPC request aborted.'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const requestId = randomUUID();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ version: 1, id: requestId, method, params: JSON.parse(serialized) }),
        signal: controller.signal,
      });
      const body = await readLimitedBody(response, MAX_RPC_BODY, 'ASTRBOT_RPC_RESPONSE_TOO_LARGE',
        'AstrBot RPC response is too large.');
      if (response.status === 401 || response.status === 403) {
        throw failure('ASTRBOT_RPC_AUTH', 'AstrBot rejected the RPC token.', 502);
      }
      if (!response.ok) throw failure('ASTRBOT_RPC_HTTP', 'AstrBot RPC returned HTTP ' + response.status + '.', 502);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch {
        throw failure('ASTRBOT_RPC_BAD_RESPONSE', 'AstrBot returned invalid JSON.', 502);
      }
      if (!payload || payload.id !== requestId || payload.version !== 1) {
        throw failure('ASTRBOT_RPC_BAD_RESPONSE', 'AstrBot returned a mismatched RPC response.', 502);
      }
      if (payload.error) {
        throw failure('ASTRBOT_RPC_REMOTE', typeof payload.error.message === 'string'
          ? payload.error.message.slice(0, 1000) : 'AstrBot RPC failed.', 502);
      }
      return payload.result;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw failure('ASTRBOT_RPC_ABORTED', 'AstrBot RPC was aborted.', 499);
        throw failure('ASTRBOT_RPC_TIMEOUT', 'AstrBot RPC timed out.', 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function persistJob(record) {
    const snapshot = structuredClone(record);
    const previous = jobWrites.get(record.id) || Promise.resolve();
    let pending;
    pending = previous.catch(() => {}).then(() => atomicJson(
      path.join(stateRoot(), 'jobs', record.id + '.json'), snapshot,
    )).finally(() => {
      if (jobWrites.get(record.id) === pending) jobWrites.delete(record.id);
    });
    jobWrites.set(record.id, pending);
    return pending;
  }

  async function updateJob(record, updates) {
    Object.assign(record, updates, { updatedAt: now() });
    jobs.set(record.id, record);
    await persistJob(record);
  }

  function createJobId() {
    const id = jobIdFactory();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || jobs.has(id)) {
      throw failure('ASTRBOT_BAD_JOB_ID', 'The manager job could not be assigned a valid identifier.', 500);
    }
    return id;
  }

  async function createGenerationId(prefix = '') {
    const id = validGenerationId(prefix + jobIdFactory());
    const stage = path.join(stateRoot(), 'staging', 'generations', id);
    const generation = generationRootPath(id);
    if (await pathExists(stage) || await pathExists(generation)) {
      throw failure('ASTRBOT_GENERATION_ID_COLLISION', 'The manager could not allocate a fresh generation identifier.', 409);
    }
    return id;
  }

  function enqueueMutation(task) {
    const result = operationQueue.then(task, task);
    operationQueue = result.catch(() => {});
    return result;
  }

  function generationRootPath(generationId) {
    return path.join(stateRoot(), 'generations', validGenerationId(generationId));
  }

  function relativeGenerationPath(generationId, suffix = '') {
    return path.posix.join('generations', validGenerationId(generationId), suffix);
  }

  function relativeStagePath(generationId, suffix = '') {
    return path.posix.join('staging', 'generations', validGenerationId(generationId), suffix);
  }

  async function checkedRpcResult(method, params, requiredFlag) {
    const result = await runtimeRpc(method, params);
    if (!result || result[requiredFlag] !== true) {
      throw failure('ASTRBOT_GENERATION_RPC_UNSUPPORTED',
        'AstrBot runtime did not confirm ' + method + ' validation.', 503);
    }
    return result;
  }

  async function assertNoPluginIdCollision(manifest, id) {
    const collision = Object.keys(manifest.plugins).find((key) => key.toLowerCase() === id.toLowerCase() && key !== id);
    if (collision) throw failure('ASTRBOT_PLUGIN_ID_COLLISION', 'Plugin identifiers collide on this filesystem.', 409);
  }

  async function writeGenerationPointer(pointer, transaction) {
    const pointerPath = path.join(stateRoot(), 'plugins.json');
    try { await atomicJson(pointerPath, pointer); }
    catch (error) {
      const saved = await readJson(pointerPath, null).catch(() => null);
      if (saved && JSON.stringify(saved) === JSON.stringify(pointer)) transaction.pointerFlipped = true;
      throw error;
    }
    transaction.pointerFlipped = true;
  }

  async function prepareGeneration({ stageRoot, generationId, pluginId, action, candidatePath }) {
    const manifest = validateManifest(await readJson(path.join(stageRoot, 'manager', 'plugins.json'), null));
    if (!['install', 'configure', 'uninstall'].includes(action)) {
      throw failure('ASTRBOT_GENERATION_ACTION_INVALID', 'The staged generation action is invalid.');
    }
    const relativeStage = relativeStagePath(generationId);
    const result = await checkedRpcResult('generation.prepare', {
      schemaVersion: 1,
      generationId,
      stagePath: relativeStage,
      action,
      pluginId: pluginId || null,
      candidatePath: candidatePath || null,
      expectedAstrbotVersion: '4.29.3',
      layout: {
        plugins: 'data/plugins',
        pluginData: 'data/plugin_data',
        sitePackages: 'data/site-packages',
        manifest: 'manager/plugins.json',
      },
    }, 'valid');
    if (result.metadataParsed !== true || result.dependenciesInstalled !== true
        || result.nativeValidated !== true || result.coreValidated !== true
        || result.astrbotVersion !== '4.29.3'
        || result.pluginCount !== Object.keys(manifest.plugins).length
        || typeof result.dependencySHA256 !== 'string'
        || !/^[a-f0-9]{64}$/i.test(result.dependencySHA256)) {
      throw failure('ASTRBOT_GENERATION_VALIDATION_FAILED',
        'AstrBot runtime did not complete metadata, dependency, native, and core validation.', 422);
    }
    return result;
  }

  async function activateGeneration({
    current, stageRoot, generationId, pluginId, action, manifest,
    transaction, dependencySHA256,
  }) {
    const rootPath = stateRoot();
    const destination = generationRootPath(generationId);
    const oldPointer = structuredClone(current.pointer);
    const oldGenerationId = oldPointer.activeGeneration;
    await atomicJson(path.join(stageRoot, 'manager', 'plugins.json'), manifest);
    await ensureDirectory(path.dirname(destination));
    if (await pathExists(destination)) {
      throw failure('ASTRBOT_GENERATION_ID_COLLISION', 'The target generation identifier is already in use.', 409);
    }
    await rename(stageRoot, destination);
    const history = [{
      generationId: oldGenerationId,
      pluginId: pluginId || null,
      action,
      dependencySHA256: oldPointer.dependencySHA256 || null,
      at: now(),
    }, ...oldPointer.history].slice(0, 100);
    const pointer = {
      schemaVersion: 2,
      activeGeneration: generationId,
      dependencySHA256,
      history,
      updatedAt: now(),
    };
    try { await writeGenerationPointer(pointer, transaction); }
    catch (error) {
      if (!transaction.pointerFlipped) {
        try { await rename(destination, stageRoot); }
        catch {
          throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
            'AstrBot could not return an uncommitted generation to staging.', 503);
        }
      }
      throw error;
    }
    await checkedRpcResult('generation.activate', {
      generationId,
      generationPath: relativeGenerationPath(generationId),
    }, 'active');
    return { generationId, pluginId, dependencySHA256, oldPointer, oldGenerationId };
  }

  async function restoreGenerationTransaction(transaction) {
    if (!transaction.pointerFlipped) return;
    const failures = [];
    try { await atomicJson(path.join(stateRoot(), 'plugins.json'), transaction.oldPointer); }
    catch { failures.push('pointer'); }
    try {
      await checkedRpcResult('generation.activate', {
        generationId: transaction.oldGenerationId,
        generationPath: relativeGenerationPath(transaction.oldGenerationId),
      }, 'active');
    } catch { failures.push('runtime'); }
    if (failures.length) {
      throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
        'AstrBot could not fully restore the previous generation. Keep the runtime frozen and inspect local state.', 503);
    }
  }

  async function commitArchive({ record, source, ref, archive }) {
    await ensureInitialGeneration();
    return withStateLock('mutation.lock', async () => {
      const rootPath = stateRoot();
      const current = await readGenerationState();
      if (!current.pointer) throw failure('ASTRBOT_GENERATION_STATE_REQUIRED', 'The active generation has not been initialized.', 503);
      const generationId = await createGenerationId();
      const stageRoot = path.join(rootPath, 'staging', 'generations', generationId);
      const sourceSHA256 = createHash('sha256').update(archive).digest('hex');
      let stageExists = false;
      let frozen = false;
      const transaction = {
        oldPointer: structuredClone(current.pointer),
        oldGenerationId: current.pointer.activeGeneration,
        pointerFlipped: false,
        committed: false,
      };
      try {
        await updateJob(record, { phase: 'snapshot', progress: 15, message: 'Snapshotting active plugin data and dependencies.' });
        await checkedRpcResult('generation.freeze', {
          generationId: current.pointer.activeGeneration,
          reason: 'install',
        }, 'frozen');
        frozen = true;
        await ensureDirectory(path.dirname(stageRoot));
        stageExists = true;
        await copySafeTree(current.generationRoot, stageRoot);
        const incomingRoot = path.join(stageRoot, 'incoming');
        const candidate = await extractZip(archive, incomingRoot);
        const candidatePath = relativeStagePath(generationId,
          path.posix.join('incoming', path.basename(candidate).replaceAll('\\', '/')));
        const inspected = await checkedRpcResult('generation.inspect', {
          candidatePath,
          expectedAstrbotVersion: '4.29.3',
        }, 'metadataParsed');
        if (inspected.astrbotVersion !== '4.29.3') {
          throw failure('ASTRBOT_UNSUPPORTED_VERSION', 'The plugin metadata was inspected against an unsupported AstrBot version.', 422);
        }
        const metadata = plainObject(inspected.metadata, 'plugin metadata');
        const id = validatePluginId(metadata.name);
        const manifest = structuredClone(current.manifest);
        await assertNoPluginIdCollision(manifest, id);
        await invalidateScheduledAuthorization([id], 'install');
        const previousEntry = manifest.plugins[id] || null;
        const pluginTarget = path.join(stageRoot, 'data', 'plugins', id);
        await ensureDirectory(path.dirname(pluginTarget));
        if (await pathExists(pluginTarget)) {
          await assertSafePath(pluginTarget);
          await scanRegularTree(pluginTarget);
          await rm(pluginTarget, { recursive: true, force: true });
        }
        await rename(candidate, pluginTarget);
        await rm(path.join(stageRoot, 'incoming'), { recursive: true, force: true });
        const treeSHA256 = await treeHash(pluginTarget);
        manifest.plugins[id] = {
          id, source, ref: ref || null, sourceSHA256, archiveSHA256: sourceSHA256, treeSHA256,
          dependencySHA256: null, metadata: {
            name: metadata.name,
            version: String(metadata.version || ''),
            author: String(metadata.author || ''),
            display_name: String(metadata.display_name || ''),
            desc: String(metadata.desc || ''),
          },
          installedAt: now(), updatedAt: now(), enabled: previousEntry?.enabled === true,
          config: previousEntry?.config && typeof previousEntry.config === 'object' ? previousEntry.config : {},
        };
        if (!Array.isArray(manifest.history[id])) manifest.history[id] = [];
        await atomicJson(path.join(stageRoot, 'manager', 'plugins.json'), manifest);
        await updateJob(record, { phase: 'validation', progress: 45, plugin: id,
          message: 'Installing staged dependencies and validating the plugin environment.' });
        const prepared = await prepareGeneration({
          stageRoot, generationId, pluginId: id, action: 'install',
          candidatePath: relativeStagePath(generationId, path.posix.join('data', 'plugins', id)),
        });
        for (const entry of Object.values(manifest.plugins)) {
          entry.dependencySHA256 = prepared.dependencySHA256;
        }
        const activated = await activateGeneration({
          current, stageRoot, generationId, pluginId: id, action: 'install',
          manifest, transaction,
          dependencySHA256: prepared.dependencySHA256,
        });
        await checkedRpcResult('generation.resume', { generationId }, 'resumed');
        await waitForHealth();
        frozen = false;
        transaction.committed = true;
        stageExists = false;
        await updateJob(record, {
          status: 'succeeded', progress: 100, finishedAt: now(), plugin: id,
          generationId, sourceSHA256, archiveSHA256: sourceSHA256, treeSHA256,
          dependencySHA256: prepared.dependencySHA256,
        }).catch((error) => report('AstrBot install succeeded but job status could not be persisted: '
          + String(error?.code || 'IO_ERROR')));
        report('AstrBot plugin generation activated: ' + id);
        return activated;
      } catch (error) {
        if (transaction.committed) throw error;
        await restoreGenerationTransaction(transaction);
        if (frozen) {
          try {
            await checkedRpcResult('generation.resume', { generationId: transaction.oldGenerationId }, 'resumed');
            await waitForHealth();
          } catch {
            throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
              'AstrBot could not resume the previous generation after a failed update.', 503);
          }
        }
        throw error;
      } finally {
        if (stageExists && await pathExists(stageRoot)) {
          await assertSafePath(stageRoot);
          await scanRegularTree(stageRoot);
          await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        }
      }
    });
  }

  async function performInstall(record, input) {
    await updateJob(record, { status: 'running', progress: 1, startedAt: now() });
    try {
      let archive;
      let id;
      let source;
      let ref;
      if (input.zipBase64 !== undefined) {
        if (typeof input.zipBase64 !== 'string' || input.zipBase64.length > Math.ceil(MAX_ZIP_BYTES * 4 / 3) + 8
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.zipBase64)) {
          throw failure('ASTRBOT_BAD_ARCHIVE', 'zipBase64 must contain a valid bounded base64 ZIP archive.');
        }
        archive = Buffer.from(input.zipBase64, 'base64');
        if (archive.length > MAX_ZIP_BYTES) throw failure('ASTRBOT_BAD_ARCHIVE', 'The plugin archive exceeds the size limit.');
        if (input.source && input.source !== 'upload.zip') {
          const parsed = parseGithubSource(input.source);
          id = parsed.id;
          source = parsed.source || ('https://github.com/' + parsed.owner + '/' + parsed.repository);
          ref = validateRef(input.ref);
        } else {
          const parsed = parseZip(archive);
          id = cleanPluginId(parsed.rootName);
          source = 'zip-upload';
          ref = null;
        }
      } else {
        const github = await githubArchive(fetchImpl, input.source, validateRef(input.ref), {
          timeoutMs: downloadTimeoutMs,
        });
        archive = github.archive;
        id = github.id;
        source = github.source;
        ref = github.ref;
      }
      await updateJob(record, { phase: 'runtime', progress: 5, message: 'Checking AstrBot runtime health.' });
      await start();
      await commitArchive({ record, source, ref, archive });
    } catch (error) {
      const code = typeof error.code === 'string' && error.code.startsWith('ASTRBOT_') ? error.code : 'ASTRBOT_INSTALL_FAILED';
      const message = typeof error.code === 'string' && error.code.startsWith('ASTRBOT_')
        ? error.message : 'AstrBot plugin installation failed. Check local logs for details.';
      report('AstrBot plugin install failed: ' + message);
      await updateJob(record, { status: 'failed', finishedAt: now(), error: { code, message } }).catch(() => {});
    }
  }

  async function install(input) {
    plainObject(input, 'install input');
    if (input.source !== undefined && typeof input.source !== 'string') {
      throw failure('ASTRBOT_BAD_SOURCE', 'source must be a string.');
    }
    if (input.ref !== undefined) validateRef(input.ref);
    const id = createJobId();
    const record = { id, kind: 'install', status: 'queued', progress: 0, createdAt: now(), updatedAt: now() };
    jobs.set(id, record);
    const task = async () => {
      try {
        await persistJob(record);
        await performInstall(record, input);
      } catch (error) {
        await updateJob(record, {
          status: 'failed', finishedAt: now(),
          error: { code: 'ASTRBOT_INSTALL_FAILED', message: 'AstrBot plugin installation could not start.' },
        }).catch(() => {});
        report('AstrBot install job could not start: ' + String(error?.message || error));
      }
    };
    operationQueue = operationQueue.then(task, task).catch(() => {});
    return { id, status: 'queued' };
  }

  async function job(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    if (jobs.has(id)) {
      await jobWrites.get(id)?.catch(() => {});
      return { ...jobs.get(id) };
    }
    return readJson(path.join(stateRoot(), 'jobs', id + '.json'), null);
  }

  async function readPluginConfigSchema(generationRoot, id) {
    const pluginRoot = generationRoot
      ? path.join(generationRoot, 'data', 'plugins', id)
      : path.join(stateRoot(), 'plugins', id);
    const schemaPath = path.join(pluginRoot, '_conf_schema.json');
    try {
      await assertSafePath(pluginRoot);
      const info = await lstat(schemaPath);
      if (!info.isFile() || info.isSymbolicLink()
          || (process.platform === 'win32' && (info.attributes & 0x400) !== 0)
          || info.size > MAX_PLUGIN_SCHEMA_BYTES) {
        return null;
      }
      const parsed = JSON.parse(await readFile(schemaPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const safe = JSON.parse(safeJsonValue(parsed, 'plugin config schema', MAX_PLUGIN_SCHEMA_BYTES));
      return withoutSecretSchemaDefaults(safe);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        report('AstrBot plugin config schema ignored: ' + String(error?.code || 'INVALID_SCHEMA'));
      }
      return null;
    }
  }

  async function listPlugins() {
    const current = await readGenerationState();
    const manifest = current.manifest;
    const entries = [];
    for (const plugin of Object.values(manifest.plugins).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      let id;
      try { id = validatePluginId(plugin.id); } catch {
        report('AstrBot plugin state contains an invalid plugin identifier.');
        continue;
      }
      const metadata = plugin.metadata && typeof plugin.metadata === 'object' && !Array.isArray(plugin.metadata)
        ? plugin.metadata : {};
      const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
      const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
        ? value.toLowerCase() : null;
      let config = {};
      try {
        const value = plugin.config && typeof plugin.config === 'object' && !Array.isArray(plugin.config)
          ? plugin.config : {};
        config = JSON.parse(safeJsonValue(value, 'plugin config', 256 * 1024));
      } catch { /* An invalid saved config is not returned to the UI. */ }
      const enabled = plugin.enabled === true;
      const version = text(metadata.version, 200);
      entries.push({
        id,
        name: text(metadata.name, 200) || id,
        displayName: text(metadata.display_name, 300) || text(metadata.name, 200) || id,
        version,
        author: text(metadata.author, 300),
        description: text(metadata.desc, 2000),
        metadata: {
          name: text(metadata.name, 200) || id,
          version,
          author: text(metadata.author, 300),
          display_name: text(metadata.display_name, 300),
          desc: text(metadata.desc, 2000),
        },
        configSchema: await readPluginConfigSchema(current.generationRoot, id),
        source: text(plugin.source, 500),
        ref: text(plugin.ref, 200) || null,
        sourceSHA256: digest(plugin.sourceSHA256),
        archiveSHA256: digest(plugin.archiveSHA256 || plugin.sourceSHA256),
        treeSHA256: digest(plugin.treeSHA256),
        dependencySHA256: digest(plugin.dependencySHA256),
        generationId: current.pointer?.activeGeneration || null,
        installedAt: text(plugin.installedAt, 100) || null,
        updatedAt: text(plugin.updatedAt, 100) || null,
        state: enabled ? 'enabled' : 'disabled',
        enabled,
        config,
      });
    }
    return entries;
  }

  async function configure(id, options) {
    validatePluginId(id);
    plainObject(options, 'configure options');
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
      throw failure('ASTRBOT_BAD_INPUT', 'enabled must be a boolean.');
    }
    if (options.config !== undefined) safeJsonValue(options.config, 'config');
    return enqueueMutation(async () => {
      await start();
      await ensureInitialGeneration();
      return withStateLock('mutation.lock', async () => {
        const current = await readGenerationState();
        if (!current.pointer) {
          throw failure('ASTRBOT_GENERATION_STATE_REQUIRED', 'The active generation has not been initialized.', 503);
        }
        const manifest = structuredClone(current.manifest);
        const plugin = manifest.plugins[id];
        if (!plugin) throw failure('ASTRBOT_PLUGIN_NOT_FOUND', 'Plugin is not installed.', 404);
        await invalidateScheduledAuthorization([id], 'configure');
        const generationId = await createGenerationId();
        const stageRoot = path.join(stateRoot(), 'staging', 'generations', generationId);
        const transaction = {
          oldPointer: structuredClone(current.pointer),
          oldGenerationId: current.pointer.activeGeneration,
          pointerFlipped: false,
          committed: false,
        };
        let stageExists = false;
        let frozen = false;
        try {
          await checkedRpcResult('generation.freeze', {
            generationId: current.pointer.activeGeneration,
            reason: 'configure',
          }, 'frozen');
          frozen = true;
          await ensureDirectory(path.dirname(stageRoot));
          stageExists = true;
          await copySafeTree(current.generationRoot, stageRoot);
          const stagedPlugin = manifest.plugins[id];
          if (options.enabled !== undefined) stagedPlugin.enabled = options.enabled;
          if (options.config !== undefined) {
            stagedPlugin.config = JSON.parse(safeJsonValue(options.config, 'config'));
          }
          stagedPlugin.updatedAt = now();
          await atomicJson(path.join(stageRoot, 'manager', 'plugins.json'), manifest);
          const prepared = await prepareGeneration({
            stageRoot, generationId, pluginId: id, action: 'configure',
            candidatePath: relativeStagePath(generationId, path.posix.join('data', 'plugins', id)),
          });
          for (const entry of Object.values(manifest.plugins)) {
            entry.dependencySHA256 = prepared.dependencySHA256;
          }
          const activated = await activateGeneration({
            current, stageRoot, generationId, pluginId: id, action: 'configure',
            manifest, transaction, dependencySHA256: prepared.dependencySHA256,
          });
          await checkedRpcResult('generation.resume', { generationId }, 'resumed');
          await waitForHealth();
          frozen = false;
          transaction.committed = true;
          stageExists = false;
          return {
            id,
            enabled: manifest.plugins[id].enabled === true,
            config: structuredClone(manifest.plugins[id].config || {}),
            generationId: activated.generationId,
          };
        } catch (error) {
          if (transaction.committed) throw error;
          await restoreGenerationTransaction(transaction);
          if (frozen) {
            try {
              await checkedRpcResult('generation.resume', { generationId: transaction.oldGenerationId }, 'resumed');
              await waitForHealth();
            } catch {
              throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
                'AstrBot could not resume the previous generation after a failed configuration update.', 503);
            }
          }
          throw error;
        } finally {
          if (stageExists && await pathExists(stageRoot)) {
            await assertSafePath(stageRoot);
            await scanRegularTree(stageRoot);
            await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
          }
        }
      });
    });
  }

  async function rollback(id) {
    validatePluginId(id);
    return enqueueMutation(async () => {
      await start();
      await ensureInitialGeneration();
      return withStateLock('mutation.lock', async () => {
        const current = await readGenerationState();
        if (!current.pointer) {
          throw failure('ASTRBOT_NO_ROLLBACK', 'No complete generation is available to restore.', 409);
        }
        const index = current.pointer.history.findIndex((entry) => entry.pluginId === id);
        if (index < 0) {
          throw failure('ASTRBOT_NO_ROLLBACK', 'No saved plugin version is available to restore.', 409);
        }
        const selected = current.pointer.history[index];
        const targetId = validGenerationId(selected.generationId);
        const targetRoot = generationRootPath(targetId);
        await assertSafePath(targetRoot);
        await scanRegularTree(targetRoot);
        const targetManifest = validateManifest(await readJson(path.join(targetRoot, 'manager', 'plugins.json'), null));
        await invalidateScheduledAuthorization(null, 'rollback');
        const oldPointer = structuredClone(current.pointer);
        const transaction = {
          oldPointer,
          oldGenerationId: oldPointer.activeGeneration,
          pointerFlipped: false,
          committed: false,
        };
        let frozen = false;
        try {
          await checkedRpcResult('generation.freeze', { generationId: oldPointer.activeGeneration, reason: 'rollback' }, 'frozen');
          frozen = true;
          const history = [{
            generationId: oldPointer.activeGeneration,
            pluginId: id,
            action: 'rollback',
            dependencySHA256: oldPointer.dependencySHA256 || null,
            at: now(),
          }, ...oldPointer.history.filter((_, itemIndex) => itemIndex !== index)].slice(0, 100);
          const pointer = {
            schemaVersion: 2,
            activeGeneration: targetId,
            dependencySHA256: selected.dependencySHA256 || null,
            history,
            updatedAt: now(),
          };
          await writeGenerationPointer(pointer, transaction);
          await checkedRpcResult('generation.activate', {
            generationId: targetId,
            generationPath: relativeGenerationPath(targetId),
          }, 'active');
          await checkedRpcResult('generation.resume', { generationId: targetId }, 'resumed');
          await waitForHealth();
          frozen = false;
          transaction.committed = true;
          return { id, rolledBack: true, installed: Boolean(targetManifest.plugins[id]), generationId: targetId };
        } catch (error) {
          if (transaction.committed) throw error;
          await restoreGenerationTransaction(transaction);
          if (frozen) {
            try {
              await checkedRpcResult('generation.resume', { generationId: transaction.oldGenerationId }, 'resumed');
              await waitForHealth();
            } catch {
              throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
                'AstrBot could not resume the previous generation after a failed rollback.', 503);
            }
          }
          throw error;
        }
      });
    });
  }

  async function stagePluginDataPurge(id, purgeId) {
    const rootPath = stateRoot();
    const generationDirectory = path.join(rootPath, 'generations');
    const backupRoot = path.join(rootPath, 'staging', 'purged-data', validGenerationId(purgeId));
    const moved = [];
    try {
      if (await pathExists(generationDirectory)) {
        await assertSafePath(generationDirectory);
        for (const entry of await readdir(generationDirectory, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const generationId = validGenerationId(entry.name);
          const generationRoot = generationRootPath(generationId);
          const pluginData = path.join(generationRoot, 'data', 'plugin_data', id);
          if (await pathExists(pluginData)) {
            await assertSafePath(pluginData);
            await scanRegularTree(pluginData);
            const backup = path.join(backupRoot, generationId, 'plugin_data', id);
            await ensureDirectory(path.dirname(backup));
            await rename(pluginData, backup);
            moved.push({ pluginData, backup });
          }
        }
      }
      const legacyData = path.join(rootPath, 'plugin_data', id);
      if (await pathExists(legacyData)) {
        await assertSafePath(legacyData);
        await scanRegularTree(legacyData);
        const backup = path.join(backupRoot, 'legacy', 'plugin_data', id);
        await ensureDirectory(path.dirname(backup));
        await rename(legacyData, backup);
        moved.push({ pluginData: legacyData, backup });
      }
      return { backupRoot, moved };
    } catch (error) {
      try { await restorePluginDataPurge({ backupRoot, moved }); }
      catch {
        throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
          'AstrBot could not restore plugin data after a failed purge; data remains staged for recovery.', 503);
      }
      throw error;
    }
  }

  async function restorePluginDataPurge(purge) {
    for (const { pluginData, backup } of [...purge.moved].reverse()) {
      if (!(await pathExists(backup))) continue;
      await ensureDirectory(path.dirname(pluginData));
      await rename(backup, pluginData);
    }
    await rm(purge.backupRoot, { recursive: true, force: true }).catch(() => {});
  }

  async function finalizePluginDataPurge(purge) {
    await rm(purge.backupRoot, { recursive: true, force: true });
  }

  async function uninstall(id, { purgeData = false } = {}) {
    validatePluginId(id);
    if (typeof purgeData !== 'boolean') throw failure('ASTRBOT_BAD_INPUT', 'purgeData must be a boolean.');
    return enqueueMutation(async () => {
      await start();
      await ensureInitialGeneration();
      return withStateLock('mutation.lock', async () => {
        const rootPath = stateRoot();
        const current = await readGenerationState();
        if (!current.pointer) throw failure('ASTRBOT_GENERATION_STATE_REQUIRED', 'The active generation has not been initialized.', 503);
        const manifest = structuredClone(current.manifest);
        if (!manifest.plugins[id]) throw failure('ASTRBOT_PLUGIN_NOT_FOUND', 'Plugin is not installed.', 404);
        await invalidateScheduledAuthorization([id], 'uninstall');
        const generationId = await createGenerationId();
        const stageRoot = path.join(rootPath, 'staging', 'generations', generationId);
        const transaction = {
          oldPointer: structuredClone(current.pointer),
          oldGenerationId: current.pointer.activeGeneration,
          pointerFlipped: false,
          committed: false,
        };
        let stageExists = false;
        let frozen = false;
        let purge = null;
        try {
          await checkedRpcResult('generation.freeze', { generationId: current.pointer.activeGeneration, reason: 'uninstall' }, 'frozen');
          frozen = true;
          await ensureDirectory(path.dirname(stageRoot));
          stageExists = true;
          await copySafeTree(current.generationRoot, stageRoot);
          const pluginPath = path.join(stageRoot, 'data', 'plugins', id);
          if (await pathExists(pluginPath)) {
            await assertSafePath(pluginPath);
            await scanRegularTree(pluginPath);
            await rm(pluginPath, { recursive: true, force: true });
          }
          if (purgeData) {
            const pluginData = path.join(stageRoot, 'data', 'plugin_data', id);
            if (await pathExists(pluginData)) {
              await assertSafePath(pluginData);
              await scanRegularTree(pluginData);
              await rm(pluginData, { recursive: true, force: true });
            }
          }
          delete manifest.plugins[id];
          if (!Array.isArray(manifest.history[id])) manifest.history[id] = [];
          await atomicJson(path.join(stageRoot, 'manager', 'plugins.json'), manifest);
          const prepared = await prepareGeneration({ stageRoot, generationId, pluginId: id, action: 'uninstall' });
          for (const entry of Object.values(manifest.plugins)) entry.dependencySHA256 = prepared.dependencySHA256;
          if (purgeData) purge = await stagePluginDataPurge(id, generationId);
          const activated = await activateGeneration({
            current, stageRoot, generationId, pluginId: id, action: 'uninstall',
            manifest, transaction, dependencySHA256: prepared.dependencySHA256,
          });
          await checkedRpcResult('generation.resume', { generationId }, 'resumed');
          await waitForHealth();
          frozen = false;
          transaction.committed = true;
          stageExists = false;
          if (purge) {
            try { await finalizePluginDataPurge(purge); }
            catch (error) {
              report('AstrBot plugin data purge cleanup remains staged: ' + String(error?.code || 'IO_ERROR'));
              return { id, uninstalled: true, dataPurged: false, generationId: activated.generationId };
            }
          }
          return { id, uninstalled: true, dataPurged: purgeData, generationId: activated.generationId };
        } catch (error) {
          if (transaction.committed) throw error;
          const recoveryFailures = [];
          if (purge) {
            try { await restorePluginDataPurge(purge); }
            catch { recoveryFailures.push('plugin data'); }
          }
          try { await restoreGenerationTransaction(transaction); }
          catch { recoveryFailures.push('generation'); }
          if (recoveryFailures.length) {
            throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
              'AstrBot could not fully restore the previous generation and plugin data.', 503);
          }
          if (frozen) {
            try {
              await checkedRpcResult('generation.resume', { generationId: transaction.oldGenerationId }, 'resumed');
              await waitForHealth();
            } catch {
              throw failure('ASTRBOT_GENERATION_RECOVERY_FAILED',
                'AstrBot could not resume the previous generation after a failed uninstall.', 503);
            }
          }
          throw error;
        } finally {
          if (stageExists && await pathExists(stageRoot)) {
            await assertSafePath(stageRoot);
            await scanRegularTree(stageRoot);
            await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
          }
        }
      });
    });
  }

  async function managedPythonPath() {
    const lock = await readJson(lockPath, null);
    if (!lock || lock.schemaVersion !== 1 || !lock.python || lock.python.version !== '3.12.10') {
      throw failure('ASTRBOT_BAD_LOCK', 'The pinned AstrBot runtime lock is missing or unsupported.', 500);
    }
    return path.join(stateRoot(), 'runtime', 'venv', 'Scripts', 'python.exe');
  }

  async function installPython() {
    if (typeof installManagedPython === 'function') {
      return installManagedPython({ projectRoot: root, stateRoot: stateRoot(), lockPath });
    }
    if (platform !== 'win32') {
      throw failure('ASTRBOT_RUNTIME_UNAVAILABLE', 'No managed AstrBot Python runtime is installed for this platform.', 501);
    }
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(root, 'scripts', 'astrbot-runtime.ps1');
    await execFileAsync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', 'Install', '-StateRoot', stateRoot(), '-LockPath', lockPath,
    ], { cwd: root, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 });
  }

  function runtimeSettings() {
    const config = configAstrbot();
    const runtimeMode = process.env.ASTRBOT_RUNTIME_MODE || config.runtimeMode || 'managed';
    if (!['managed', 'external'].includes(runtimeMode)) {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot.runtimeMode must be managed or external.', 500);
    }
    const runtimeUrl = process.env.ASTRBOT_RUNTIME_URL || config.runtimeUrl || DEFAULT_RUNTIME_URL;
    let parsed;
    try { parsed = new URL(runtimeUrl); } catch {
      throw failure('ASTRBOT_BAD_CONFIG', 'config.astrbot.runtimeUrl must be a valid HTTP URL.', 500);
    }
    const host = config.host || parsed.hostname || '127.0.0.1';
    const port = config.port === undefined ? (Number(parsed.port) || 5831) : Number(config.port);
    if (typeof host !== 'string' || !host || /[\r\n\0]/.test(host)
        || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw failure('ASTRBOT_BAD_CONFIG', 'AstrBot host and port are invalid.', 500);
    }
    return {
      mode: runtimeMode, host, port, runtimeUrl,
      callbackUrl: config.callbackUrl || DEFAULT_CALLBACK_URL,
    };
  }

  function healthyResponse(health) {
    return health === true || health?.ok === true || health?.healthy === true || health?.status === 'ok';
  }

  function connectionRefused(error) {
    const code = error?.cause?.code || error?.code;
    return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code);
  }

  async function probeHealth({ createToken = true } = {}) {
    try {
      const health = await runtimeRpc('health', {}, { createToken });
      return healthyResponse(health) ? { healthy: true, health }
        : { healthy: false, error: failure('ASTRBOT_RUNTIME_UNHEALTHY', 'AstrBot runtime returned an unhealthy response.', 503) };
    } catch (error) {
      return { healthy: false, error };
    }
  }

  async function waitForRuntimeIdle(timeoutMs = RUNTIME_STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      const probe = await probeHealth({ createToken: false });
      if (probe.healthy && probe.health?.running === false) return probe.health;
      lastError = probe.healthy
        ? failure('ASTRBOT_RUNTIME_STOPPING', 'AstrBot health has not confirmed that the runtime is idle.', 503)
        : probe.error;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw failure('ASTRBOT_RUNTIME_IDLE_TIMEOUT',
      'AstrBot runtime did not become idle after stop: ' + String(lastError?.message || 'health check timed out'), 504);
  }

  function childEnvironment(settings, token, generationRoot) {
    const result = {};
    const permitted = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'TZ'];
    for (const wanted of permitted) {
      const key = Object.keys(process.env).find((name) => name.toLowerCase() === wanted.toLowerCase());
      if (key && typeof process.env[key] === 'string') result[wanted] = process.env[key];
    }
    Object.assign(result, {
      PYTHONPATH: runtimeSource,
      QQ_ASTRBOT_HOST: settings.host,
      QQ_ASTRBOT_PORT: String(settings.port),
      QQ_ASTRBOT_TOKEN: token,
      QQ_ASTRBOT_CALLBACK_URL: settings.callbackUrl,
      QQ_ASTRBOT_ROOT: runtimeSource,
      QQ_ASTRBOT_STATE_ROOT: stateRoot(),
      QQ_ASTRBOT_GENERATION_ROOT: generationRoot,
    });
    return result;
  }

  async function waitForHealth(timeoutMs = GENERATION_STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      if (childExit) throw failure('ASTRBOT_RUNTIME_EXITED', 'AstrBot runtime exited before health became ready.', 503);
      try {
        const health = await runtimeRpc('health', {});
        if (healthyResponse(health) && health?.running === true) return health;
        lastError = healthyResponse(health)
          ? failure('ASTRBOT_RUNTIME_STARTING', 'AstrBot supervisor is healthy but the runtime is not running yet.', 503)
          : failure('ASTRBOT_RUNTIME_UNHEALTHY', 'AstrBot runtime returned an unhealthy response.', 503);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw failure('ASTRBOT_RUNTIME_HEALTH_TIMEOUT',
      'AstrBot runtime did not become healthy: ' + String(lastError?.message || 'health check timed out'), 504);
  }

  async function start() {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const settings = runtimeSettings();
          if (settings.mode === 'external') {
            const preflight = await probeHealth({ createToken: false });
            if (!preflight.healthy) {
              throw failure('ASTRBOT_EXTERNAL_UNAVAILABLE',
                'Configured external AstrBot runtime is not healthy; managed Python will not be spawned.', 503);
            }
          }
          await withStateLock('lifecycle.lock', async () => {
            if (settings.mode === 'managed') await getToken();
            const probe = await probeHealth({ createToken: false });
            if (probe.healthy && probe.health?.running === true) {
              if (settings.mode === 'managed' && child && child.exitCode === null && !child.killed) {
                resolve({ running: true, managed: true, external: false, health: probe.health });
                return;
              }
              resolve({ running: true, managed: false, external: settings.mode === 'external', health: probe.health });
              return;
            }
            if (probe.healthy) {
              if (settings.mode === 'managed' && child && child.exitCode === null && !child.killed) {
                const health = await waitForHealth();
                resolve({ running: true, managed: true, external: false, health });
                return;
              }
              const initial = await ensureInitialGeneration();
              await runtimeRpc('runtime.start', {
                generationId: initial.pointer.activeGeneration,
                generationPath: relativeGenerationPath(initial.pointer.activeGeneration),
              });
              const health = await waitForHealth();
              resolve({
                running: true,
                managed: settings.mode === 'managed',
                external: settings.mode === 'external',
                health,
              });
              return;
            }
            if (settings.mode === 'external') {
              throw failure('ASTRBOT_EXTERNAL_UNAVAILABLE',
                'Configured external AstrBot runtime is not healthy; managed Python will not be spawned.', 503);
            }
            if (child && child.exitCode === null && !child.killed) {
              throw failure('ASTRBOT_RUNTIME_UNHEALTHY', 'The owned AstrBot process is running but failed its health check.', 503);
            }
            if (!connectionRefused(probe.error)) throw probe.error;
            childExit = null;
            if (!(await pathExists(runtimeSource))) {
              throw failure('ASTRBOT_RUNTIME_SOURCE_MISSING', 'runtime/astrbot Python adapter is missing.', 503);
            }
            let python = await managedPythonPath();
            if (!(await pathExists(python))) {
              await installPython();
              python = await managedPythonPath();
            }
            if (!(await pathExists(python))) throw failure('ASTRBOT_RUNTIME_UNAVAILABLE', 'Managed Python installation did not produce python.exe.', 503);
            const initial = await ensureInitialGeneration();
            const environment = childEnvironment(settings, await getToken(), initial.generationRoot);
            let executable = python;
            if (platform === 'win32') {
              executable = path.join(stateRoot(), 'runtime', 'python', 'python.exe');
              if (!(await pathExists(executable))) {
                throw failure('ASTRBOT_RUNTIME_UNAVAILABLE', 'Managed base Python installation did not produce runtime/python/python.exe.', 503);
              }
              environment.__PYVENV_LAUNCHER__ = python;
            }
            const spawned = spawnImpl(executable, ['-m', 'qq_astrbot'], {
              cwd: runtimeSource, env: environment, windowsHide: true, stdio: 'ignore',
            });
            child = spawned;
            spawned.once('exit', (code, signal) => {
              childExit = { code, signal, at: now() };
              if (child === spawned) child = null;
            });
            spawned.once('error', (error) => {
              childExit = { code: null, signal: null, error: String(error.message), at: now() };
              if (child === spawned) child = null;
            });
            spawned.unref?.();
            const health = await waitForHealth();
            resolve({ running: true, managed: true, external: false, health });
          }, 20 * 60_000);
        } catch (error) {
          reject(error);
        }
      };
      lifecycleQueue = lifecycleQueue.then(task, task).catch((error) => reject(error));
    });
  }

  async function stop() {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const settings = runtimeSettings();
          if (settings.mode === 'external') {
            const preflight = await probeHealth({ createToken: false });
            if (!preflight.healthy) throw failure('ASTRBOT_EXTERNAL_UNAVAILABLE',
              'Configured external AstrBot runtime is not healthy.', 503);
          }
          await withStateLock('lifecycle.lock', async () => {
            if (settings.mode === 'external') {
              const probe = await probeHealth({ createToken: false });
              if (!probe.healthy) throw failure('ASTRBOT_EXTERNAL_UNAVAILABLE',
                'Configured external AstrBot runtime is not healthy.', 503);
              await runtimeRpc('runtime.stop', {}, { createToken: false });
              await waitForRuntimeIdle();
              resolve({ running: false, stopped: true, managed: false, external: true });
              return;
            }
            if (!child) {
              const probe = await probeHealth({ createToken: false });
              if (probe.healthy && probe.health?.running === true) {
                await runtimeRpc('runtime.stop', {}, { createToken: false });
                await waitForRuntimeIdle();
                resolve({ running: false, stopped: true, managed: false, external: false });
                return;
              }
              resolve({ running: false, stopped: false, managed: false, external: false });
              return;
            }
            const target = child;
            const exited = new Promise((done) => target.once('exit', done));
            try { await runtimeRpc('runtime.stop', {}); }
            catch (error) {
              const code = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(error?.code || ''))
                ? error.code : 'ASTRBOT_RUNTIME_STOP_FAILED';
              report('AstrBot graceful runtime stop failed before supervisor shutdown: ' + code);
            }
            if (target.exitCode === null && !target.killed) target.kill('SIGTERM');
            const timer = setTimeout(() => target.kill('SIGKILL'), 5_000);
            await Promise.race([exited, new Promise((done) => setTimeout(done, 5_500))]);
            clearTimeout(timer);
            if (child === target && target.exitCode === null) {
              throw failure('ASTRBOT_STOP_FAILED', 'AstrBot runtime did not stop after SIGTERM.', 503);
            }
            if (child === target) child = null;
            resolve({ running: false, stopped: true, managed: true, external: false });
          });
        } catch (error) { reject(error); }
      };
      lifecycleQueue = lifecycleQueue.then(task, task).catch((error) => reject(error));
    });
  }

  function scheduleRuntime(input) {
    plainObject(input, 'runtime operation');
    const { action } = input;
    if (!['start', 'restart'].includes(action)) {
      throw failure('ASTRBOT_BAD_RUNTIME_ACTION', 'action must be start or restart.');
    }
    const id = createJobId();
    const timestamp = now();
    const record = {
      id, kind: 'runtime', action, status: 'queued', state: 'queued', phase: 'queued', progress: 0,
      message: `AstrBot ${action} operation queued.`, createdAt: timestamp, updatedAt: timestamp,
    };
    jobs.set(id, record);

    const run = async () => {
      try {
        await persistJob(record);
        await updateJob(record, {
          status: 'running', state: 'running', phase: action === 'restart' ? 'stopping' : 'starting',
          progress: 1, startedAt: now(), message: `AstrBot ${action} operation is running.`,
        });
        if (action === 'restart') {
          await updateJob(record, { phase: 'stopping', progress: 10, message: 'Stopping AstrBot runtime.' });
          await stop();
        }
        await updateJob(record, { phase: 'starting', progress: action === 'restart' ? 45 : 10,
          message: 'Starting AstrBot runtime.' });
        const result = await start();
        await updateJob(record, {
          status: 'succeeded', state: 'succeeded', phase: 'complete', progress: 100,
          finishedAt: now(), message: `AstrBot ${action} operation completed.`,
          result: { running: result?.running === true, enabled: result?.enabled === true },
        });
      } catch (error) {
        const candidate = String(error?.code || 'ASTRBOT_RUNTIME_FAILED');
        const code = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : 'ASTRBOT_RUNTIME_FAILED';
        report(`AstrBot runtime ${action} job failed: ${code}`);
        await updateJob(record, {
          status: 'failed', state: 'failed', phase: 'failed', progress: 100, finishedAt: now(),
          message: 'AstrBot runtime operation failed. Check local logs for details.',
          error: { code, message: 'AstrBot runtime operation failed.' },
        }).catch(() => {});
      }
    };

    setImmediate(() => {
      const result = runtimeJobQueue.then(run, run);
      runtimeJobQueue = result.catch(() => {});
    });
    return { id, status: 'queued' };
  }

  async function status() {
    const policy = await readPolicy();
    const generation = await readGenerationState();
    const manifest = generation.manifest;
    const settings = runtimeSettings();
    const python = path.join(stateRoot(), 'runtime', 'venv', 'Scripts', 'python.exe');
    const active = [...jobs.values()].filter((record) => ACTIVE_JOB_STATES.has(record.status));
    const plugins = Object.values(manifest.plugins);
    let externalHealth = null;
    let externalRuntimeRunning = false;
    if (settings.mode === 'external' && await pathExists(path.join(stateRoot(), 'rpc-token'))) {
      const probe = await probeHealth({ createToken: false });
      externalHealth = probe.healthy;
      externalRuntimeRunning = probe.healthy && probe.health?.running === true;
    }
    return {
      version: '4.29.3',
      enabled: policy.enabled,
      runtimeMode: settings.mode,
      running: settings.mode === 'external' ? externalRuntimeRunning
        : Boolean(child && child.exitCode === null && !child.killed),
      managed: settings.mode === 'managed' && Boolean(child),
      external: settings.mode === 'external',
      activeGeneration: generation.pointer?.activeGeneration || null,
      runtimeUrl: settings.runtimeUrl,
      pythonInstalled: settings.mode === 'managed' && await pathExists(python),
      pluginCount: plugins.length,
      enabledPluginCount: plugins.filter((plugin) => plugin.enabled === true).length,
      activeJobs: active.length,
      externalHealth,
      lastExit: childExit ? { ...childExit } : null,
    };
  }

  return {
    status,
    listPlugins,
    install,
    job,
    configure,
    rollback,
    uninstall,
    start,
    stop,
    scheduleRuntime,
    runtimeRpc,
    getToken,
  };
}
