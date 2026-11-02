import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAdministrator, isAllowed, isGroupWatched, isUserBlocked } from './security.js';
import { createAstrbotOutbound, invalidateAstrbotScheduledAuthorization } from './astrbot-outbound.mjs';

export const validAstrbotId = (value) => typeof value === 'string'
  && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)
  && !['__ai__', '__all__', '__proto__', 'constructor', 'prototype'].includes(value);
export const astrbotError = (code) => Object.assign(new Error(code), { code });
export function astrbotStateRoot(root, config = {}) {
  return path.resolve(root, config.stateDir || 'state', 'astrbot');
}
function validGroup(id) {
  if (!/^[1-9]\d{0,19}$/.test(String(id))) throw astrbotError('ASTRBOT_GROUP_INVALID');
  return String(id);
}
export function normalizeAstrbotGroup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.pluginIds) || value.pluginIds.length > 128
    || value.pluginIds.some((id) => !validAstrbotId(id))
    || !['dsh', 'astrbot'].includes(value.chatMode)) throw astrbotError('ASTRBOT_POLICY_INVALID');
  return { pluginIds: [...new Set(value.pluginIds)].sort(), chatMode: value.chatMode };
}
export async function atomicAstrbotJson(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, filename);
  } finally { await fs.rm(tmp, { force: true }); }
}

/** Only the authenticated console mutates policy; bridge workers re-read it. */
export function createAstrbotPolicy({ root, readConfig = () => ({}) }) {
  const filename = () => path.join(astrbotStateRoot(root, readConfig()), 'policy.json');
  let pending = Promise.resolve();
  async function get() {
    let data;
    try {
      const bytes = await fs.readFile(filename());
      if (bytes.length > 1024 * 1024) throw astrbotError('ASTRBOT_POLICY_INVALID');
      data = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw astrbotError('ASTRBOT_POLICY_UNREADABLE');
      return { enabled: false, revision: 'initial', groups: {} };
    }
    if (typeof data.enabled !== 'boolean' || typeof data.revision !== 'string'
      || !data.groups || typeof data.groups !== 'object' || Array.isArray(data.groups)
      || Object.keys(data.groups).length > 1000) throw astrbotError('ASTRBOT_POLICY_INVALID');
    const groups = {};
    for (const [id, group] of Object.entries(data.groups)) groups[validGroup(id)] = normalizeAstrbotGroup(group);
    return { enabled: data.enabled, revision: data.revision, groups };
  }
  function mutate(action) {
    const op = pending.catch(() => {}).then(async () => {
      const data = await get();
      await action(data);
      data.revision = randomUUID();
      await atomicAstrbotJson(filename(), data);
      return data;
    });
    pending = op;
    return op;
  }
  const outbound = createAstrbotOutbound({ root: () => astrbotStateRoot(root, readConfig()), readConfig, getPolicy: get });
  const invalidate = (pluginIds = null) => invalidateAstrbotScheduledAuthorization({
    root: astrbotStateRoot(root, readConfig()), pluginIds, reason: 'policy',
  });
  return {
    get, getEnabled: async () => (await get()).enabled,
    listOutboundGrants: outbound.list, createOutboundGrant: outbound.create,
    revokeOutboundGrant: outbound.revoke, authorizeOutbound: outbound.authorize,
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw astrbotError('ASTRBOT_POLICY_INVALID');
      return mutate(async (data) => {
        if (!enabled) await invalidate();
        data.enabled = enabled;
      });
    },
    setGroup(id, group) {
      id = validGroup(id); group = normalizeAstrbotGroup(group);
      return mutate(async (data) => {
        if (!Object.hasOwn(data.groups, id) && Object.keys(data.groups).length >= 1000) throw astrbotError('ASTRBOT_GROUP_LIMIT');
        const removed = (data.groups[id]?.pluginIds || []).filter((pluginId) => !group.pluginIds.includes(pluginId));
        if (removed.length) await invalidate(removed);
        data.groups[id] = group;
      });
    },
    removeGroup(id) {
      id = validGroup(id);
      return mutate(async (data) => {
        const removed = data.groups[id]?.pluginIds || [];
        if (removed.length) await invalidate(removed);
        delete data.groups[id];
      });
    },
  };
}

/** This is admission to the plugin lane, not admission to the computer lane. */
export function astrbotAdmission(msg, cfg, policy, enabledIds) {
  if (!policy.enabled || isUserBlocked(msg.userId, cfg)) return null;
  const isGroup = msg.messageType === 'group';
  const admin = isAdministrator(msg.userId, cfg);
  if (isGroup && (!cfg.security?.allowGroups || !isGroupWatched(msg.groupId, cfg))) return null;
  if (!isGroup && (!admin || !isAllowed(msg.userId, cfg))) return null;
  const group = isGroup ? policy.groups[String(msg.groupId)] : { pluginIds: enabledIds, chatMode: 'dsh' };
  if (!group) return null;
  const pluginIds = group.pluginIds.filter((id) => enabledIds.includes(id));
  if (!pluginIds.length && group.chatMode !== 'astrbot') return null;
  return { pluginIds, chatMode: group.chatMode, isAdmin: admin, isGroup };
}
