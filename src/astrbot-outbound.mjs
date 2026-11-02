import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isUserBlocked, isGroupWatched } from './security.js';

const WEATHER_ARCHIVE = 'd149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30';
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INITIAL = 'initial';
const MAX_JSON = 1024 * 1024;
const denied = (code = 'ASTRBOT_OUTBOUND_PERMISSION_DENIED', status = 403) => {
  throw Object.assign(new Error(code), { code, status });
};
function pluginId(value) {
  if (typeof value !== 'string' || !ID.test(value)
    || ['__ai__', '__all__', '__proto__', 'constructor', 'prototype'].includes(value)) denied('ASTRBOT_OUTBOUND_PLUGIN_INVALID', 400);
  return value;
}
function target(value) {
  if (!value || !['private', 'group'].includes(value.kind)
    || typeof value.id !== 'string' || !/^[1-9]\d{0,19}$/.test(value.id)
    || !Number.isSafeInteger(Number(value.id))) denied('ASTRBOT_OUTBOUND_TARGET_INVALID', 400);
  return { kind: value.kind, id: value.id };
}
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  denied('ASTRBOT_OUTBOUND_STATE_INVALID');
}
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
async function json(filename, fallback) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON) denied('ASTRBOT_OUTBOUND_STATE_INVALID');
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    denied('ASTRBOT_OUTBOUND_STATE_UNREADABLE');
  }
}
async function write(filename, data) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) denied('ASTRBOT_OUTBOUND_STATE_INVALID');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function marker(root, key) {
  const value = await json(path.join(root, 'scheduled-revocations', `${key}.json`), null);
  if (value === null) return INITIAL;
  if (typeof value?.epoch !== 'string' || !UUID.test(value.epoch)) denied('ASTRBOT_OUTBOUND_STATE_INVALID');
  return value.epoch;
}

/** These epochs live outside generation snapshots. Each mutation writes a new,
 * never reused nonce: parallel processes cannot overwrite a revocation with an
 * older authority. No cross-process read/modify/write counter is needed. */
export async function astrbotScheduledOriginEpochs(root, pluginIds) {
  const entries = await Promise.all(pluginIds.map(async (id) => [pluginId(id), await marker(root, pluginId(id))]));
  return { all: await marker(root, '__all__'), plugins: Object.fromEntries(entries) };
}
export async function assertAstrbotScheduledOrigin({ root, pluginId: id, context }) {
  id = pluginId(id);
  const current = await astrbotScheduledOriginEpochs(root, [id]);
  const captured = context.scheduledAuthorization;
  if (current.all !== (captured?.all || INITIAL)
    || current.plugins[id] !== (captured?.plugins?.[id] || INITIAL)) denied('ASTRBOT_SCHEDULED_ORIGIN_REVOKED');
}
export async function invalidateAstrbotScheduledAuthorization({ root, pluginIds = null, reason = 'configure' }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) denied('ASTRBOT_OUTBOUND_STATE_INVALID');
  const keys = pluginIds === null ? ['__all__'] : [...new Set(pluginIds.map(pluginId))];
  const safeReason = ['install', 'configure', 'uninstall', 'rollback', 'policy'].includes(reason) ? reason : 'configure';
  for (const key of keys) await write(path.join(root, 'scheduled-revocations', `${key}.json`), {
    epoch: randomUUID(), reason: safeReason, changedAt: new Date().toISOString(),
  });
}

async function installed(root, id) {
  const pointer = await json(path.join(root, 'plugins.json'), null);
  const generation = pointer?.activeGeneration;
  if (pointer?.schemaVersion !== 2 || typeof generation !== 'string' || !ID.test(generation)) denied('ASTRBOT_OUTBOUND_PLUGIN_UNAVAILABLE');
  const manifest = await json(path.join(root, 'generations', generation, 'manager', 'plugins.json'), null);
  const entry = manifest?.plugins?.[id];
  if (!entry || entry.id !== id) denied('ASTRBOT_OUTBOUND_PLUGIN_UNAVAILABLE');
  return entry;
}
function binding(entry) {
  const archive = entry.archiveSHA256 || entry.sourceSHA256;
  if (archive !== WEATHER_ARCHIVE || !/^[a-f0-9]{64}$/.test(entry.treeSHA256 || '')
    || typeof entry.installedAt !== 'string') denied('ASTRBOT_OUTBOUND_PLUGIN_UNSUPPORTED');
  return hash({ archive, tree: entry.treeSHA256, installedAt: entry.installedAt, config: entry.config || {} });
}

/** Weather's explicit send-only authority is independent of inbound identities.
 * A grant never authorizes model calls, tools, another destination or plugin. */
export function createAstrbotOutbound({ root, readConfig, getPolicy }) {
  const directory = () => typeof root === 'function' ? root() : root;
  const grantsDir = () => path.join(directory(), 'outbound-grants');
  const grantFile = (id) => {
    if (typeof id !== 'string' || !UUID.test(id)) denied('ASTRBOT_OUTBOUND_GRANT_INVALID', 400);
    return path.join(grantsDir(), `${id}.json`);
  };
  async function assess(grant) {
    try {
      if (!grant || grant.schemaVersion !== 1 || grant.purpose !== 'weather.daily') return 'invalid';
      pluginId(grant.pluginId); target(grant.target); grantFile(grant.id);
      if (await json(`${grantFile(grant.id)}.revoked`, null)) return 'revoked';
      const epochs = await astrbotScheduledOriginEpochs(directory(), [grant.pluginId]);
      if (epochs.all !== grant.epochs?.all || epochs.plugins[grant.pluginId] !== grant.epochs?.plugins?.[grant.pluginId]) return 'revoked';
      const plugin = await installed(directory(), grant.pluginId);
      if (!plugin.enabled) return 'plugin-disabled';
      if (binding(plugin) !== grant.binding) return 'plugin-changed';
      const policy = await getPolicy();
      if (!policy.enabled) return 'runtime-disabled';
      const config = readConfig();
      if (grant.target.kind === 'private') {
        if (isUserBlocked(grant.target.id, config)) return 'target-blocked';
      } else if (!config.security?.allowGroups || !isGroupWatched(grant.target.id, config)
        || !policy.groups[grant.target.id]?.pluginIds?.includes(grant.pluginId)) return 'target-not-authorized';
      return null;
    } catch { return 'unavailable'; }
  }
  async function view(grant) {
    const reason = await assess(grant);
    const revoked = await json(`${grantFile(grant.id)}.revoked`, null);
    return { id: grant.id, pluginId: grant.pluginId, purpose: grant.purpose, target: grant.target,
      createdAt: grant.createdAt, revokedAt: revoked?.revokedAt || null, active: reason === null, reason };
  }
  async function list() {
    let names;
    try { names = await fs.readdir(grantsDir()); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const ids = names.filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith('.json'));
    if (ids.length > 2000) denied('ASTRBOT_OUTBOUND_GRANT_LIMIT');
    const records = [];
    for (const name of ids) {
      const value = await json(path.join(grantsDir(), name), null);
      if (value) records.push(await view(value));
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function create(input) {
    const id = pluginId(input?.pluginId), destination = target(input?.target);
    if (input?.purpose !== 'weather.daily') denied('ASTRBOT_OUTBOUND_PURPOSE_INVALID', 400);
    const plugin = await installed(directory(), id);
    if (plugin.enabled !== true) denied('ASTRBOT_OUTBOUND_PLUGIN_DISABLED');
    const fingerprint = binding(plugin);
    if ((await list()).length >= 2000) denied('ASTRBOT_OUTBOUND_GRANT_LIMIT');
    const grant = { schemaVersion: 1, id: randomUUID(), pluginId: id, purpose: 'weather.daily',
      target: destination, binding: fingerprint,
      epochs: await astrbotScheduledOriginEpochs(directory(), [id]), createdAt: new Date().toISOString() };
    await write(grantFile(grant.id), grant);
    return view(grant);
  }
  async function revoke(id) {
    const filename = grantFile(id), grant = await json(filename, null);
    if (!grant) denied('ASTRBOT_OUTBOUND_GRANT_NOT_FOUND', 404);
    await write(`${filename}.revoked`, { revokedAt: new Date().toISOString() });
    return view(grant);
  }
  async function authorize(input) {
    const id = pluginId(input?.pluginId), destination = target(input?.target);
    if (input.purpose !== 'weather.daily' || input.sourceSHA256 !== WEATHER_ARCHIVE) denied();
    for (const grant of await list()) {
      if (grant.active && grant.pluginId === id && grant.purpose === input.purpose
        && grant.target.kind === destination.kind && grant.target.id === destination.id) {
        // Re-read the selected record after list() to include a concurrent revoke.
        const record = await json(grantFile(grant.id), null);
        if (record && await assess(record) === null) return { grantId: grant.id, target: destination };
      }
    }
    denied();
  }
  return { list, create, revoke, authorize };
}
