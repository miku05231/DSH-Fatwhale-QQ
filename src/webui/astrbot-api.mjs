import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyProxyAssertion } from './proxy-assertion.mjs';

const BASE = '/api/astrbot';
const MAX_CONFIG_DEPTH = 16;
const MAX_CONFIG_NODES = 10_000;
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const WEATHER_PLUGIN_ID = 'astrbot_plugin_weather';
const OUTBOUND_TARGET_ID = /^[1-9]\d{0,19}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SCHEMA_KEYS = ['configSchema', 'config_schema', 'confSchema', 'conf_schema', '_conf_schema'];
const SECRET_KEY = /(?:secret|password|passwd|credential|authorization|token|api.?key|private.?key)/i;
const PLUGIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const GROUP_ID = /^[1-9]\d{0,19}$/;
const GITHUB_SOURCE = /^(?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\.git)?(?:\/tree\/[A-Za-z0-9_.\/-]+)?\/?$/;

function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeTree(value, depth = 0, counter = { count: 0 }) {
  counter.count += 1;
  if (depth > MAX_CONFIG_DEPTH || counter.count > MAX_CONFIG_NODES) {
    throw Object.assign(new Error('请求结构过大或嵌套过深'), { statusCode: 400 });
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item, depth + 1, counter);
    return;
  }
  if (!ownObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw Object.assign(new Error('请求包含非法字段'), { statusCode: 400 });
    assertSafeTree(item, depth + 1, counter);
  }
}

function schemaType(field) {
  return String(field?.type ?? field?.datatype ?? field?.dataType ?? '').toLowerCase();
}

function isSecretField(name, field) {
  return field?.secret === true || field?.sensitive === true ||
    ['secret', 'password', 'passwd'].includes(schemaType(field)) ||
    String(field?.format ?? '').toLowerCase() === 'password' || SECRET_KEY.test(String(name ?? ''));
}

function schemaField(schema, key) {
  if (Array.isArray(schema)) {
    return schema.find((field) => String(field?.key ?? field?.name ?? field?.id ?? '') === key);
  }
  if (!ownObject(schema)) return undefined;
  if (Array.isArray(schema.fields)) return schemaField(schema.fields, key);
  if (String(schema.key ?? schema.name ?? schema.id ?? '') === key && schema.type !== undefined) return schema;
  if (ownObject(schema.properties) && Object.hasOwn(schema.properties, key)) return schema.properties[key];
  if (schemaType(schema) === 'object' && ownObject(schema.items)) return schemaField(schema.items, key);
  if (Object.hasOwn(schema, key)) return schema[key];
  return undefined;
}

function schemaForPlugin(plugin) {
  return plugin?.configSchema ?? plugin?.config_schema ?? plugin?.confSchema ?? plugin?.conf_schema ??
    plugin?._conf_schema ?? plugin?.metadata?.configSchema ?? plugin?.metadata?.config_schema ??
    plugin?.metadata?.confSchema ?? plugin?.metadata?.conf_schema ?? plugin?.metadata?._conf_schema ?? null;
}

function schemaChildren(field) {
  return ['properties', 'schema', 'children', 'items', 'templates']
    .map((key) => field?.[key])
    .filter((value) => ownObject(value) || Array.isArray(value));
}

function collectSecretNames(schema, names = new Set(), depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) return names;
  if (Array.isArray(schema)) {
    for (const field of schema) {
      const key = String(field?.key ?? field?.name ?? field?.id ?? '');
      if (key && isSecretField(key, field)) names.add(key.toLowerCase());
      for (const nested of schemaChildren(field)) collectSecretNames(nested, names, depth + 1);
    }
  } else if (ownObject(schema)) {
    if (Array.isArray(schema.fields)) collectSecretNames(schema.fields, names, depth + 1);
    if (String(schema.key ?? schema.name ?? schema.id ?? '')) {
      const key = String(schema.key ?? schema.name ?? schema.id);
      if (isSecretField(key, schema)) names.add(key.toLowerCase());
      for (const nested of schemaChildren(schema)) collectSecretNames(nested, names, depth + 1);
      return names;
    }
    const props = ownObject(schema.properties) ? schema.properties :
      schemaType(schema) === 'object' && (ownObject(schema.items) || Array.isArray(schema.items)) ? schema.items : schema;
    for (const [key, field] of Object.entries(props)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      if (isSecretField(key, field)) names.add(key.toLowerCase());
      for (const nested of schemaChildren(field)) collectSecretNames(nested, names, depth + 1);
    }
  }
  return names;
}

function sanitizeSchema(schema, key = '', depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > MAX_CONFIG_DEPTH || state.nodes > MAX_CONFIG_NODES) return null;
  if (Array.isArray(schema)) {
    return schema.slice(0, MAX_CONFIG_NODES).map((field) => {
      const fieldKey = String(field?.key ?? field?.name ?? field?.id ?? '');
      return sanitizeSchema(field, fieldKey, depth + 1, state);
    });
  }
  if (!ownObject(schema)) {
    if (typeof schema === 'string') return schema.slice(0, 20_000);
    return schema === null || typeof schema === 'boolean' || (typeof schema === 'number' && Number.isFinite(schema))
      ? schema : null;
  }
  const secret = isSecretField(key, schema);
  const result = {};
  for (const [childKey, value] of Object.entries(schema)) {
    if (FORBIDDEN_KEYS.has(childKey)) continue;
    if (secret && ['default', 'defaultValue', 'default_value', 'value'].includes(childKey)) continue;
    result[childKey] = sanitizeSchema(value, childKey, depth + 1, state);
  }
  return result;
}

function sanitize(value, secretNames = new Set(), key = '', depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) return null;
  if (key && (SECRET_KEY.test(key) || secretNames.has(key.toLowerCase()))) {
    if (value === undefined || value === null || value === '') return '';
    return '***';
  }
  if (Array.isArray(value)) return value.slice(0, MAX_CONFIG_NODES).map((item) => sanitize(item, secretNames, '', depth + 1));
  if (ownObject(value)) {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(childKey)) continue;
      result[childKey] = sanitize(child, secretNames, childKey, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') return value.slice(0, 20_000);
  return value;
}

function pluginArray(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.plugins)) return result.plugins;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

function pluginIdOf(plugin) {
  return String(plugin?.id ?? plugin?.pluginId ?? plugin?.name ?? '');
}

function pluginConfigOf(plugin) {
  const config = plugin?.config ?? plugin?.desiredConfig ?? plugin?.desired_config ?? plugin?.configuration;
  return ownObject(config) ? config : {};
}

function objectChildSchema(field) {
  for (const key of ['properties', 'schema', 'children']) {
    if (ownObject(field?.[key]) || Array.isArray(field?.[key])) return field[key];
  }
  if (['object', 'dict'].includes(schemaType(field))) {
    return ownObject(field?.items) || Array.isArray(field?.items) ? field.items : field;
  }
  return field;
}

function arrayItemSchema(field) {
  const items = field?.items;
  if (!ownObject(items) && !Array.isArray(items)) return undefined;
  if (['object', 'dict'].includes(schemaType(items))) return objectChildSchema(items);
  return items;
}

function templateRowSchema(field, entry) {
  const templateKey = typeof entry?.__template_key === 'string' ? entry.__template_key : '';
  const template = templateKey ? field?.templates?.[templateKey] : undefined;
  if (!ownObject(template)) return undefined;
  return objectChildSchema({ ...template, type: 'object' });
}

function matchTemplateRow(previousRows, entry, field, usedRows) {
  if (!Array.isArray(previousRows)) return undefined;
  const templateKey = typeof entry?.__template_key === 'string' ? entry.__template_key : '';
  const candidates = previousRows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => !usedRows.has(index) && ownObject(row) && row.__template_key === templateKey);
  const template = templateKey ? field?.templates?.[templateKey] : undefined;
  const displayItem = typeof field?.display_item === 'string' ? field.display_item
    : typeof template?.display_item === 'string' ? template.display_item : '';
  if (displayItem && Object.hasOwn(entry, displayItem)) {
    const match = candidates.find(({ row }) => Object.is(row[displayItem], entry[displayItem]));
    if (match) {
      usedRows.add(match.index);
      return match.row;
    }
  }
  const match = candidates[0];
  if (!match) return undefined;
  usedRows.add(match.index);
  return match.row;
}

function cleanConfigChanges(value, schema, previous = {}, depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) throw Object.assign(new Error('配置嵌套过深'), { statusCode: 400 });
  const result = ownObject(previous) ? structuredClone(previous) : {};
  for (const [key, item] of Object.entries(value)) {
    const field = schemaField(schema, key);
    if (isSecretField(key, field)) {
      if (typeof item === 'string' && (item.trim() === '' || item.trim() === '***')) continue;
      if (Array.isArray(item) && (item.length === 0 || item.some((entry) => entry === '***') ||
          item.every((entry) => typeof entry === 'string' && entry.trim() === ''))) continue;
      if (typeof item !== 'string' && !Array.isArray(item)) continue;
    }
    if (ownObject(item)) {
      result[key] = cleanConfigChanges(item, objectChildSchema(field), result[key], depth + 1);
    } else if (Array.isArray(item)) {
      if (schemaType(field) === 'template_list') {
        const usedRows = new Set();
        result[key] = item.map((entry) => {
          if (!ownObject(entry)) return structuredClone(entry);
          const templateKey = String(entry.__template_key ?? '');
          if (!templateKey || !ownObject(field?.templates?.[templateKey])) {
            throw Object.assign(new Error('模板列表包含未知模板类型'), { statusCode: 400 });
          }
          const previousRow = matchTemplateRow(previous?.[key], entry, field, usedRows);
          return cleanConfigChanges(entry, templateRowSchema(field, entry), previousRow, depth + 1);
        });
      } else {
        const rowSchema = arrayItemSchema(field);
        result[key] = item.map((entry, index) => ownObject(entry)
          ? cleanConfigChanges(entry, rowSchema, previous?.[key]?.[index], depth + 1)
          : structuredClone(entry));
      }
    } else {
      result[key] = structuredClone(item);
    }
  }
  return result;
}

function maskPlugin(plugin, schema = schemaForPlugin(plugin)) {
  const secretNames = collectSecretNames(schema);
  if (!ownObject(plugin)) return sanitize(plugin, secretNames);
  const record = { ...plugin };
  for (const key of SCHEMA_KEYS) delete record[key];
  if (ownObject(record.metadata)) {
    const metadata = { ...record.metadata };
    for (const key of SCHEMA_KEYS) delete metadata[key];
    record.metadata = metadata;
  }
  const masked = sanitize(record, secretNames);
  if (ownObject(masked) && schema !== null && schema !== undefined) {
    masked.configSchema = sanitizeSchema(schema);
  }
  return masked;
}

function maskPlugins(result) {
  const plugins = pluginArray(result).map((plugin) => maskPlugin(plugin));
  if (Array.isArray(result)) return { plugins };
  const envelope = ownObject(result) ? { ...result } : {};
  delete envelope.plugins;
  delete envelope.items;
  return { ...(sanitize(envelope) ?? {}), plugins };
}

function safeFailure(log, label, error, fallback, fail, res) {
  const status = Number(error?.statusCode);
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
  try { log?.warn?.(label); } catch { /* logging is best effort */ }
  return fail(res, safeStatus, fallback);
}

function safeOutboundGrantFailure(log, label, error, fallback, fail, res) {
  const status = Number(error?.statusCode ?? error?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
  const code = typeof error?.code === 'string' && /^ASTRBOT_[A-Z0-9_]{1,96}$/.test(error.code)
    ? ` (${error.code})` : '';
  try { log?.warn?.(label); } catch { /* logging is best effort */ }
  return fail(res, safeStatus, `${fallback}${code}`);
}

/**
 * Build the AstrBot admin API around injected manager and policy instances.
 * Requests require true loopback access or a signed console-gateway assertion;
 * mutations also require same-origin checks and a per-console token.
 */
export function createAstrbotApi({ manager, policy, readBody, ok, fail, log, proxySecret = '' } = {}) {
  if (!manager || !policy || typeof readBody !== 'function' ||
      typeof ok !== 'function' || typeof fail !== 'function') {
    throw new TypeError('createAstrbotApi requires manager, policy, body readers, and response helpers');
  }
  const csrfToken = randomBytes(32).toString('hex');
  proxySecret = String(proxySecret ?? '');
  const proxyNonces = new Map();
  const localJobs = new Map();

  function loopbackAddress(value) {
    const address = String(value ?? '').toLowerCase();
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  function runtimeJobSnapshot(job, id = job.id) {
    const allowed = ['kind', 'action', 'status', 'state', 'phase', 'progress', 'message', 'detail', 'statusText',
      'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'result'];
    const snapshot = { id };
    for (const key of allowed) if (job[key] !== undefined) snapshot[key] = sanitize(job[key]);
    return snapshot;
  }

  function terminal(job) {
    return ['success', 'succeeded', 'complete', 'completed', 'failed', 'error', 'cancelled', 'canceled']
      .includes(String(job?.status ?? job?.state ?? '').toLowerCase());
  }

  function queueRuntimeAction(action) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(), kind: 'runtime', action, status: 'queued', progress: { percent: 0 },
      message: '运行操作已排队', createdAt: now, updatedAt: now,
    };
    localJobs.set(job.id, job);
    while (localJobs.size > 128) {
      const oldestCompleted = [...localJobs].find(([, item]) => terminal(item));
      if (!oldestCompleted) break;
      localJobs.delete(oldestCompleted[0]);
    }
    setImmediate(async () => {
      job.status = 'running';
      job.progress = { percent: 1 };
      job.message = 'AstrBot 运行操作正在执行';
      job.updatedAt = new Date().toISOString();
      try {
        let scheduled;
        if (typeof manager.scheduleRuntime === 'function') {
          scheduled = await manager.scheduleRuntime({ action });
        } else {
          if (action === 'restart') await manager.stop();
          await manager.start();
        }
        const managerJobId = typeof scheduled === 'string'
          ? scheduled
          : String(scheduled?.jobId ?? scheduled?.job?.id ?? scheduled?.id ?? '');
        if (managerJobId && managerJobId !== job.id && typeof manager.job === 'function') {
          job.managerJobId = managerJobId;
          const current = await manager.job(managerJobId);
          if (current && terminal(current)) {
            Object.assign(job, runtimeJobSnapshot(current, job.id));
          } else {
            job.status = 'delegated';
            job.message = '运行操作已交由 AstrBot 管理器执行';
            job.progress = current?.progress ?? { percent: 1 };
            job.updatedAt = new Date().toISOString();
          }
        } else {
          job.status = 'succeeded';
          job.progress = { percent: 100 };
          job.message = 'AstrBot 运行操作已完成';
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
        }
      } catch {
        job.status = 'failed';
        job.progress = { percent: 100 };
        job.message = 'AstrBot 运行操作失败';
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
      }
    });
    return job;
  }

  function queuePluginAction(action, run, maskResult) {
    const actionLabel = { configure: '配置', rollback: '回滚', uninstall: '卸载' }[action] ?? '操作';
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(), kind: 'plugin', action, status: 'queued', progress: { percent: 0 },
      message: `插件${actionLabel}已排队`, createdAt: now, updatedAt: now,
    };
    localJobs.set(job.id, job);
    while (localJobs.size > 128) {
      const oldestCompleted = [...localJobs].find(([, item]) => terminal(item));
      if (!oldestCompleted) break;
      localJobs.delete(oldestCompleted[0]);
    }
    setImmediate(async () => {
      job.status = 'running';
      job.progress = { percent: 1 };
      job.message = `AstrBot 插件${actionLabel}正在执行`;
      job.updatedAt = new Date().toISOString();
      try {
        const result = await run();
        if (typeof maskResult === 'function') job.result = maskResult(result);
        job.status = 'succeeded';
        job.progress = { percent: 100 };
        job.message = `AstrBot 插件${actionLabel}已完成`;
      } catch {
        job.status = 'failed';
        job.progress = { percent: 100 };
        job.message = `AstrBot 插件${actionLabel}失败`;
      }
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
    });
    return job;
  }

  function authorized(req, res) {
    const authority = String(req.headers.host ?? '').toLowerCase();
    const port = req.socket.localPort;
    const local = loopbackAddress(req.socket.remoteAddress) &&
      new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(authority);
    const proxy = verifyProxyAssertion(proxySecret, req.headers['x-qq-console-assertion'], {
      method: req.method,
      url: req.url || req.originalUrl || '',
      host: req.headers.host,
      nonceCache: proxyNonces,
    });
    if (!local && !proxy) {
      fail(res, 403, 'AstrBot 管理接口需要本机访问或经过认证的控制台网关');
      return false;
    }
    const origin = String(req.headers.origin ?? '');
    if ((origin && origin !== `http://${authority}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      fail(res, 403, 'AstrBot 管理接口不接受跨站请求');
      return false;
    }
    return true;
  }

  function requireCsrf(req, res) {
    const supplied = Buffer.from(String(req.headers['x-qq-astrbot-token'] ?? ''), 'utf8');
    const expected = Buffer.from(csrfToken, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      fail(res, 403, '请刷新 AstrBot 管理页面后再操作');
      return false;
    }
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      fail(res, 415, 'AstrBot 管理请求需要 JSON');
      return false;
    }
    return true;
  }

  async function body(req, limit = 256 * 1024) {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req, limit) || '{}');
    } catch (error) {
      throw Object.assign(new Error('请求格式不正确'), { statusCode: Number(error?.statusCode) || 400 });
    }
    if (!ownObject(parsed)) throw Object.assign(new Error('请求需要 JSON 对象'), { statusCode: 400 });
    assertSafeTree(parsed);
    return parsed;
  }

  async function runtimeSnapshot(includeToken = false) {
    const status = await manager.status();
    let enabled = false;
    if (typeof policy.getEnabled === 'function') enabled = (await policy.getEnabled()) === true;
    else enabled = (await policy.get())?.enabled === true;
    const snapshot = sanitize(ownObject(status) ? status : { status });
    return { ...snapshot, enabled, ...(includeToken ? { csrfToken } : {}) };
  }

  async function route(req, res, pathname, method) {
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return false;
    if (!authorized(req, res)) return true;

    const path = pathname.slice(BASE.length) || '/';
    if (path === '/runtime' && method === 'GET') {
      try { ok(res, await runtimeSnapshot(true)); }
      catch (error) { safeFailure(log, 'astrbot_runtime_read_failed', error, '读取 AstrBot 运行状态失败', fail, res); }
      return true;
    }

    if (path === '/plugins' && method === 'GET') {
      try { ok(res, maskPlugins(await manager.listPlugins())); }
      catch (error) { safeFailure(log, 'astrbot_plugins_read_failed', error, '读取 AstrBot 插件失败', fail, res); }
      return true;
    }

    if (path === '/groups' && method === 'GET') {
      try { ok(res, sanitize(await policy.get())); }
      catch (error) { safeFailure(log, 'astrbot_groups_read_failed', error, '读取群聊插件策略失败', fail, res); }
      return true;
    }

    if (path === '/outbound-grants' && method === 'GET') {
      try {
        const grants = typeof policy.listOutboundGrants === 'function'
          ? await policy.listOutboundGrants() : [];
        ok(res, sanitize(Array.isArray(grants) ? grants : []));
      } catch (error) {
        safeOutboundGrantFailure(log, 'astrbot_outbound_grants_read_failed', error,
          '读取天气推送授权失败', fail, res);
      }
      return true;
    }

    if (path === '/outbound-grants' && method === 'POST') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).some((key) => !['pluginId', 'purpose', 'target'].includes(key)) ||
            payload.pluginId !== WEATHER_PLUGIN_ID || payload.purpose !== 'weather.daily' ||
            !ownObject(payload.target) ||
            Object.keys(payload.target).some((key) => !['kind', 'id'].includes(key)) ||
            !['private', 'group'].includes(payload.target.kind) ||
            typeof payload.target.id !== 'string' || !OUTBOUND_TARGET_ID.test(payload.target.id)) {
          fail(res, 400, '天气推送授权必须指定已知天气插件、weather.daily 用途和正整数私聊或群聊目标');
          return true;
        }
        if (typeof policy.createOutboundGrant !== 'function') {
          fail(res, 501, '当前策略模块不支持天气推送授权');
          return true;
        }
        const items = pluginArray(await manager.listPlugins());
        if (!items.some((entry) => pluginIdOf(entry) === WEATHER_PLUGIN_ID)) {
          fail(res, 404, '未安装已知的 AstrBot 天气插件');
          return true;
        }
        const grant = await policy.createOutboundGrant({
          pluginId: WEATHER_PLUGIN_ID,
          purpose: 'weather.daily',
          target: { kind: payload.target.kind, id: payload.target.id },
        });
        ok(res, sanitize(grant), 201);
      } catch (error) {
        safeOutboundGrantFailure(log, 'astrbot_outbound_grant_create_failed', error,
          '创建天气推送授权失败', fail, res);
      }
      return true;
    }

    const outboundGrantMatch = /^\/outbound-grants\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (outboundGrantMatch && method === 'DELETE') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).length) { fail(res, 400, '撤销授权请求不接受参数'); return true; }
        if (typeof policy.revokeOutboundGrant !== 'function') {
          fail(res, 501, '当前策略模块不支持撤销天气推送授权');
          return true;
        }
        const grant = await policy.revokeOutboundGrant(outboundGrantMatch[1]);
        ok(res, sanitize(grant));
      } catch (error) {
        safeOutboundGrantFailure(log, 'astrbot_outbound_grant_revoke_failed', error,
          '撤销天气推送授权失败', fail, res);
      }
      return true;
    }

    const jobMatch = /^\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (jobMatch && method === 'GET') {
      try {
        const runtimeJob = localJobs.get(jobMatch[1]);
        if (runtimeJob) {
          if (runtimeJob.managerJobId) {
            const current = await manager.job(runtimeJob.managerJobId);
            if (current) {
              const merged = { ...runtimeJob, ...current };
              if (terminal(current)) Object.assign(runtimeJob, runtimeJobSnapshot(merged, runtimeJob.id));
              ok(res, runtimeJobSnapshot(merged, runtimeJob.id));
              return true;
            }
          }
          ok(res, runtimeJobSnapshot(runtimeJob));
          return true;
        }
        const result = await manager.job(jobMatch[1]);
        if (!result) fail(res, 404, '没有这个安装任务');
        else ok(res, runtimeJobSnapshot(result, jobMatch[1]));
      } catch (error) { safeFailure(log, 'astrbot_job_read_failed', error, '读取 AstrBot 任务失败', fail, res); }
      return true;
    }

    if (path === '/runtime' && method === 'PUT') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).length !== 1 || typeof payload.enabled !== 'boolean') {
          fail(res, 400, 'enabled 必须是布尔值');
          return true;
        }
        await policy.setEnabled(payload.enabled);
        ok(res, await runtimeSnapshot());
      } catch (error) { safeFailure(log, 'astrbot_runtime_update_failed', error, '保存 AstrBot 运行开关失败', fail, res); }
      return true;
    }

    if (path === '/runtime' && method === 'POST') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).length !== 1 || !['start', 'stop', 'restart'].includes(payload.action)) {
          fail(res, 400, 'action 必须是 start、stop 或 restart');
          return true;
        }
        if (payload.action === 'stop') {
          await manager[payload.action]();
          ok(res, await runtimeSnapshot());
        } else {
          const job = queueRuntimeAction(payload.action);
          ok(res, { id: job.id, job: runtimeJobSnapshot(job) }, 202);
        }
      } catch (error) { safeFailure(log, 'astrbot_runtime_action_failed', error, 'AstrBot 运行操作失败', fail, res); }
      return true;
    }

    if (path === '/install' && method === 'POST') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 24 * 1024 * 1024);
        const keys = Object.keys(payload);
        if (keys.some((key) => !['source', 'ref', 'zipBase64'].includes(key))) {
          fail(res, 400, '安装请求只接受 source、ref 和 zipBase64');
          return true;
        }
        const source = typeof payload.source === 'string' ? payload.source.trim() : '';
        const ref = payload.ref === undefined ? undefined : String(payload.ref).trim();
        const zipBase64 = payload.zipBase64;
        if (ref !== undefined && (!ref || ref.length > 200 || /[\u0000-\u001f\u007f]/.test(ref))) {
          fail(res, 400, '版本或分支名称无效');
          return true;
        }
        if (zipBase64 !== undefined) {
          if (typeof zipBase64 !== 'string' || zipBase64.length > Math.ceil(MAX_ZIP_BYTES * 4 / 3) + 8 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(zipBase64)) {
            fail(res, 400, 'ZIP 文件数据无效或超过 16 MiB');
            return true;
          }
          const zipBuffer = Buffer.from(zipBase64, 'base64');
          if (zipBuffer.length < 4 || zipBuffer.length > MAX_ZIP_BYTES ||
              zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
            fail(res, 400, 'ZIP 文件数据无效或超过 16 MiB');
            return true;
          }
        } else if (!source || source.length > 2048 || /[\u0000-\u001f\u007f]/.test(source) || !GITHUB_SOURCE.test(source)) {
          fail(res, 400, '请提供 GitHub 插件来源');
          return true;
        }
        const result = await manager.install({ source: source || 'upload.zip', ...(ref ? { ref } : {}), ...(zipBase64 ? { zipBase64 } : {}) });
        const id = typeof result === 'string' ? result : String(result?.id ?? result?.jobId ?? result?.job?.id ?? '');
        if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
          fail(res, 500, 'AstrBot 安装任务没有返回有效编号');
          return true;
        }
        const jobResult = await manager.job(id).catch(() => null);
        ok(res, { job: runtimeJobSnapshot(jobResult ?? result, id), id }, 202);
      } catch (error) {
        safeFailure(log, 'astrbot_install_failed', error, 'AstrBot 插件安装失败，请检查 GitHub 来源或 ZIP 文件', fail, res);
      }
      return true;
    }

    const updateMatch = /^\/plugins\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})\/update$/.exec(path);
    if (updateMatch && method === 'POST') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).length) { fail(res, 400, '更新请求不接受参数'); return true; }
        const items = pluginArray(await manager.listPlugins());
        const plugin = items.find((entry) => pluginIdOf(entry) === updateMatch[1]);
        if (!plugin) { fail(res, 404, '没有这个 AstrBot 插件'); return true; }
        const source = String(plugin?.source ?? plugin?.repo ?? plugin?.repository ?? plugin?.url ?? '').trim();
        const ref = plugin?.ref === undefined || plugin?.ref === null ? '' : String(plugin.ref).trim();
        if (!source || source.length > 2048 || !GITHUB_SOURCE.test(source)) {
          fail(res, 409, '这个插件没有可用于更新的 GitHub 来源');
          return true;
        }
        if (ref && (ref.length > 200 || /[\u0000-\u001f\u007f]/.test(ref))) {
          fail(res, 409, '已记录的插件版本信息无效，无法更新');
          return true;
        }
        const result = await manager.install({ source, ...(ref ? { ref } : {}) });
        const id = typeof result === 'string' ? result : String(result?.id ?? result?.jobId ?? result?.job?.id ?? '');
        if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
          fail(res, 500, 'AstrBot 更新任务没有返回有效编号');
          return true;
        }
        const jobResult = await manager.job(id).catch(() => null);
        ok(res, { job: runtimeJobSnapshot(jobResult ?? result, id), id }, 202);
      } catch (error) {
        safeFailure(log, 'astrbot_plugin_update_failed', error, 'AstrBot 插件更新失败，请检查已记录的 GitHub 来源', fail, res);
      }
      return true;
    }

    const groupMatch = /^\/groups\/([^/]+)$/.exec(path);
    if (groupMatch && ['PUT', 'DELETE'].includes(method)) {
      if (!requireCsrf(req, res)) return true;
      const groupId = groupMatch[1];
      if (!GROUP_ID.test(groupId)) { fail(res, 400, '群号必须是正整数'); return true; }
      try {
        if (method === 'DELETE') {
          await policy.removeGroup(groupId);
        } else {
          const payload = await body(req, 64 * 1024);
          if (Object.keys(payload).some((key) => !['pluginIds', 'chatMode'].includes(key)) ||
              !Array.isArray(payload.pluginIds) || payload.pluginIds.length > 128 ||
              payload.pluginIds.some((id) => typeof id !== 'string' || !PLUGIN_ID.test(id) || FORBIDDEN_KEYS.has(id)) ||
              new Set(payload.pluginIds).size !== payload.pluginIds.length ||
              !['dsh', 'astrbot'].includes(payload.chatMode)) {
            fail(res, 400, '群聊策略必须包含有效 pluginIds 和 chatMode');
            return true;
          }
          await policy.setGroup(groupId, { pluginIds: payload.pluginIds, chatMode: payload.chatMode });
        }
        ok(res, sanitize(await policy.get()));
      } catch (error) { safeFailure(log, 'astrbot_group_update_failed', error, '保存群聊插件策略失败', fail, res); }
      return true;
    }

    const rollbackMatch = /^\/plugins\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})\/rollback$/.exec(path);
    if (rollbackMatch && method === 'POST') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).length) { fail(res, 400, '回滚请求不接受参数'); return true; }
        const items = pluginArray(await manager.listPlugins());
        if (!items.some((entry) => pluginIdOf(entry) === rollbackMatch[1])) {
          fail(res, 404, '没有这个 AstrBot 插件');
          return true;
        }
        const job = queuePluginAction('rollback', () => manager.rollback(rollbackMatch[1]));
        ok(res, { id: job.id, job: runtimeJobSnapshot(job) }, 202);
      } catch (error) { safeFailure(log, 'astrbot_rollback_failed', error, 'AstrBot 插件回滚失败', fail, res); }
      return true;
    }

    const pluginMatch = /^\/plugins\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(path);
    if (pluginMatch && method === 'PUT') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 512 * 1024);
        if (Object.keys(payload).some((key) => !['enabled', 'config'].includes(key)) ||
            (Object.hasOwn(payload, 'enabled') && typeof payload.enabled !== 'boolean') ||
            (Object.hasOwn(payload, 'config') && !ownObject(payload.config)) ||
            (!Object.hasOwn(payload, 'enabled') && !Object.hasOwn(payload, 'config'))) {
          fail(res, 400, '插件设置只接受 enabled 或对象类型的 config');
          return true;
        }
        const items = pluginArray(await manager.listPlugins());
        const plugin = items.find((entry) => pluginIdOf(entry) === pluginMatch[1]);
        if (!plugin) { fail(res, 404, '没有这个 AstrBot 插件'); return true; }
        const changes = {};
        if (Object.hasOwn(payload, 'enabled')) changes.enabled = payload.enabled;
        if (Object.hasOwn(payload, 'config')) {
          const schema = schemaForPlugin(plugin);
          changes.config = cleanConfigChanges(payload.config, schema, pluginConfigOf(plugin));
        }
        const schema = schemaForPlugin(plugin);
        const job = queuePluginAction('configure', () => manager.configure(pluginMatch[1], changes),
          (result) => maskPlugin(result, schema));
        ok(res, { id: job.id, job: runtimeJobSnapshot(job) }, 202);
      } catch (error) { safeFailure(log, 'astrbot_plugin_configure_failed', error, '保存 AstrBot 插件设置失败', fail, res); }
      return true;
    }

    if (pluginMatch && method === 'DELETE') {
      if (!requireCsrf(req, res)) return true;
      try {
        const payload = await body(req, 4096);
        if (Object.keys(payload).some((key) => key !== 'purgeData') ||
            (Object.hasOwn(payload, 'purgeData') && typeof payload.purgeData !== 'boolean')) {
          fail(res, 400, 'purgeData 必须是布尔值');
          return true;
        }
        const items = pluginArray(await manager.listPlugins());
        if (!items.some((entry) => pluginIdOf(entry) === pluginMatch[1])) {
          fail(res, 404, '没有这个 AstrBot 插件');
          return true;
        }
        const job = queuePluginAction('uninstall', () => manager.uninstall(pluginMatch[1], { purgeData: payload.purgeData === true }));
        ok(res, { id: job.id, job: runtimeJobSnapshot(job) }, 202);
      } catch (error) { safeFailure(log, 'astrbot_uninstall_failed', error, '卸载 AstrBot 插件失败', fail, res); }
      return true;
    }

    if (path === '/runtime' || path === '/plugins' || path === '/groups' || path === '/install' ||
        path === '/outbound-grants' || path.startsWith('/jobs/') || path.startsWith('/plugins/') ||
        path.startsWith('/groups/') || path.startsWith('/outbound-grants/')) {
      fail(res, 405, 'AstrBot 管理接口不支持此请求方法或路径');
      return true;
    }
    fail(res, 404, '没有这个 AstrBot 管理接口');
    return true;
  }

  return { route };
}
