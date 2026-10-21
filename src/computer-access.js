import fs from 'node:fs';
import { isAdministrator } from './security.js';

/** 每次执行/发送前重读名单；文件损坏或读取失败时收回电脑权限。 */
export function readComputerAccessConfig(configPath, config = {}) {
  let security = { adminUserIds: [] };
  let permission = config?.dsh?.permissionMode ?? '';
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    const ids = raw?.security?.adminUserIds;
    const denied = raw?.security?.denyFrom;
    if (ids !== undefined && !Array.isArray(ids)) throw new Error('Invalid administrator list');
    if (denied !== undefined && !Array.isArray(denied)) throw new Error('Invalid deny list');
    const validId = (id) =>
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === 'string' && /^[1-9]\d*$/.test(id.trim()));
    if (!(ids ?? []).every(validId) || !(denied ?? []).every(validId)) {
      throw new Error('Invalid QQ identifier');
    }
    permission = raw?.dsh?.permissionMode ?? permission;
    if (!['', 'read-only', 'workspace-write', 'danger-full-access'].includes(permission)) {
      throw new Error('Invalid permission mode');
    }
    security = { ...raw.security, adminUserIds: ids ?? [], denyFrom: denied ?? [] };
  } catch {
    // 不沿用上次成功读取的管理员身份，避免撤权或坏配置继续放行。
  }
  return { ...config, security, dsh: { ...config.dsh, permissionMode: permission } };
}

export function computerSessionKey(msg, config) {
  const userId = String(msg.userId);
  const chat = msg.messageType === 'group' ? `g:${msg.groupId}` : `p:${userId}`;
  const scope = isAdministrator(userId, config)
    ? `admin:${config?.dsh?.permissionMode || 'workspace-write'}`
    : 'chat';
  return `${chat}:u:${userId}:${scope}:v1`;
}

export function qqReplyParams(msg, text, config) {
  const message = isAdministrator(msg.userId, config)
    ? String(text ?? '')
    : [{ type: 'text', data: { text: String(text ?? '') } }];
  return msg.messageType === 'group'
    ? { group_id: msg.groupId, message }
    : { user_id: msg.userId, message };
}
