import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAstrbotApi } from '../src/webui/astrbot-api.mjs';
import { createProxyAssertion } from '../src/webui/proxy-assertion.mjs';
import { createConsoleFixture } from './helpers/isolated-fixtures.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS ${label}`);
}

function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body !== undefined && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: requestHeaders }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function pollJob(port, id) {
  let response;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    response = await request(port, `/api/astrbot/jobs/${encodeURIComponent(id)}`);
    if (['success', 'succeeded', 'complete', 'completed', 'failed', 'error', 'cancelled', 'canceled']
      .includes(String(response.body?.data?.status ?? response.body?.data?.state ?? '').toLowerCase())) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return response;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-astrbot-api-'));
const calls = { start: 0, stop: 0, runtimeScheduled: [], install: 0, configure: 0, rollback: 0, uninstall: [] };
let runtimeManagerJob = null;
let policyData = { enabled: false, revision: 'initial', groups: {} };
let policyRevision = 0;
let plugin = {
  id: 'demo', name: 'demo', displayName: 'Demo', version: '1.0.0', source: 'https://github.com/example/demo', ref: 'v1.0.0',
  enabled: true,
  config: {
    apiKey: 'synthetic-secret', token: 'unmarked-token-secret', label: 'old',
    nested: { access_token: 'nested-secret', servicePin: 'nested-custom-secret' },
    providers: [
      { __template_key: 'oauth', name: 'primary', clientSecret: 'primary-row-secret', region: 'us' },
      { __template_key: 'oauth', name: 'backup', clientSecret: 'backup-row-secret', region: 'eu' },
    ],
  },
  _conf_schema: {
    type: 'object',
    items: {
      apiKey: { type: 'string', secret: true },
      token: { type: 'string' },
      label: { type: 'string' },
      nested: { type: 'object', items: {
        access_token: { type: 'string', format: 'password' },
        servicePin: { type: 'string', secret: true },
      } },
      providers: { type: 'template_list', display_item: 'name', templates: { oauth: { type: 'object', display_name: 'OAuth', items: {
        name: { type: 'string' },
        clientSecret: { type: 'string', secret: true },
        region: { type: 'string' },
      } } } },
    },
  },
};
const weatherPlugin = {
  id: 'astrbot_plugin_weather', name: 'astrbot_plugin_weather', displayName: 'Weather', version: '1.0.0',
  source: 'https://github.com/zzby-poi/astrbot_plugin_weather', ref: 'main', enabled: true, config: {}, _conf_schema: { type: 'object', items: {} },
};
let weatherInstalled = true;
const manager = {
  async status() { return { running: false, version: '1.2.3' }; },
  async listPlugins() { return { plugins: [structuredClone(plugin), ...(weatherInstalled ? [structuredClone(weatherPlugin)] : [])] }; },
  async install(input) { calls.install += 1; calls.installInput = input; return { id: 'job-1' }; },
  async job(id) {
    if (id === 'job-1') return { id, status: 'queued', progress: 0 };
    if (id === 'runtime-manager-job') return structuredClone(runtimeManagerJob);
    return null;
  },
  async configure(id, changes) {
    calls.configure += 1;
    if (Object.hasOwn(changes, 'enabled')) plugin.enabled = changes.enabled;
    if (Object.hasOwn(changes, 'config')) plugin.config = changes.config;
    return structuredClone(plugin);
  },
  async rollback(id) { calls.rollback += 1; return { id, status: 'rolled-back' }; },
  async uninstall(id, options) { calls.uninstall.push({ id, ...options }); return { id, removed: true }; },
  scheduleRuntime({ action }) {
    calls.runtimeScheduled.push(action);
    runtimeManagerJob = { id: 'runtime-manager-job', kind: 'runtime', action, status: 'queued', progress: { percent: 0 }, message: '排队中' };
    setTimeout(() => {
      runtimeManagerJob = { ...runtimeManagerJob, status: 'succeeded', progress: { percent: 100 }, message: '已完成' };
    }, 25);
    return { id: 'runtime-manager-job' };
  },
  async start() { calls.start += 1; },
  async stop() { calls.stop += 1; },
};
const policy = {
  async get() { return structuredClone(policyData); },
  async getEnabled() { return policyData.enabled; },
  async setEnabled(enabled) { policyData = { ...policyData, enabled, revision: `r${++policyRevision}` }; return structuredClone(policyData); },
  async setGroup(groupId, value) {
    policyData = { ...policyData, groups: { ...policyData.groups, [groupId]: { pluginIds: [...value.pluginIds].sort(), chatMode: value.chatMode } } };
    return structuredClone(policyData);
  },
  async removeGroup(groupId) {
    const groups = { ...policyData.groups };
    delete groups[groupId];
    policyData = { ...policyData, groups };
    return structuredClone(policyData);
  },
};
const outboundGrantRecords = [];
const outboundGrantCalls = { create: [], revoke: [] };

const proxySecret = 'a'.repeat(64);
const fixture = await createConsoleFixture(path.join(temporary, 'console'), {
  astrbotManager: manager, astrbotPolicy: policy, astrbotProxySecret: proxySecret,
});
try {
  const { port, instance } = fixture;
  let response = await request(port, '/api/astrbot/runtime');
  check('Runtime status is readable and defaults disabled', response.status === 200 && response.body.data.enabled === false);
  const token = response.body.data.csrfToken;
  check('Runtime read issues a per-console CSRF token', /^[a-f0-9]{64}$/.test(token));
  check('Runtime status exposes the manager version', response.body.data.version === '1.2.3');
  const headers = {
    'Content-Type': 'application/json',
    'X-QQ-Astrbot-Token': token,
    Origin: instance.url.slice(0, -1),
  };

  response = await request(port, '/api/astrbot/plugins');
  const pluginJson = JSON.stringify(response.body);
  check('Plugin listing masks root, nested, template-row, and token-named secrets in AstrBot _conf_schema', response.status === 200 &&
    !pluginJson.includes('synthetic-secret') && !pluginJson.includes('nested-secret') && !pluginJson.includes('nested-custom-secret') &&
    !pluginJson.includes('primary-row-secret') && !pluginJson.includes('backup-row-secret') &&
    !pluginJson.includes('unmarked-token-secret') && pluginJson.includes('***'));
  response = await request(port, '/api/astrbot/groups');
  check('Group policy returns only group configuration', response.status === 200 && response.body.data.enabled === false && Object.keys(response.body.data.groups).length === 0);

  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
  check('Writes without the session token are refused', response.status === 403 && policyData.enabled === false);
  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: '{"enabled":true}' });
  check('Cross-origin writes are refused even with a valid token', response.status === 403 && policyData.enabled === false);
  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body: '{"enabled":true}' });
  check('Cross-site fetches are refused', response.status === 403 && policyData.enabled === false);
  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{"enabled":true}' });
  check('Simple form requests cannot change runtime policy', response.status === 415 && policyData.enabled === false);
  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers, body: '{"enabled":"true"}' });
  check('Runtime enablement requires an actual boolean', response.status === 400 && policyData.enabled === false);
  response = await request(port, '/api/astrbot/runtime', { method: 'PUT', headers, body: '{"enabled":true}' });
  check('Runtime enablement updates policy without changing manager status', response.status === 200 && policyData.enabled && response.body.data.running === false);

  response = await request(port, '/api/astrbot/runtime', { method: 'POST', headers, body: '{"action":"stop"}' });
  check('Runtime stop remains a direct manager action', response.status === 200 && calls.stop === 1);
  response = await request(port, '/api/astrbot/runtime', { method: 'POST', headers, body: '{"action":"restart"}' });
  const runtimeJobId = response.body?.data?.id;
  check('Runtime restart returns a pollable job without awaiting Python setup', response.status === 202 && typeof runtimeJobId === 'string');
  let runtimeJobResponse;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    runtimeJobResponse = await request(port, `/api/astrbot/jobs/${encodeURIComponent(runtimeJobId)}`);
    if (['succeeded', 'failed'].includes(runtimeJobResponse.body?.data?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check('Runtime job delegates to manager scheduling and reaches a terminal poll status', runtimeJobResponse.status === 200 && runtimeJobResponse.body.data.status === 'succeeded' && calls.runtimeScheduled.includes('restart'));
  response = await request(port, '/api/astrbot/runtime', { method: 'POST', headers, body: '{"action":"install"}' });
  check('Unknown runtime actions are rejected', response.status === 400 && calls.runtimeScheduled.length === 1);

  response = await request(port, '/api/astrbot/groups/001', { method: 'PUT', headers, body: '{"pluginIds":[],"chatMode":"dsh"}' });
  check('Group IDs reject leading zeroes', response.status === 400 && !Object.hasOwn(policyData.groups, '001'));
  response = await request(port, '/api/astrbot/groups/123456', { method: 'PUT', headers, body: '{"pluginIds":["demo","demo"],"chatMode":"dsh"}' });
  check('Duplicate plugin IDs are rejected', response.status === 400 && !Object.hasOwn(policyData.groups, '123456'));
  response = await request(port, '/api/astrbot/groups/123456', { method: 'PUT', headers, body: '{"pluginIds":["__proto__"],"chatMode":"dsh"}' });
  check('Prototype-sensitive plugin IDs are rejected', response.status === 400 && !Object.hasOwn(policyData.groups, '123456'));
  response = await request(port, '/api/astrbot/groups/123456', { method: 'PUT', headers, body: '{"pluginIds":["demo"],"chatMode":"astrbot"}' });
  check('A valid positive group policy is persisted through policy.setGroup', response.status === 200 && policyData.groups['123456'].chatMode === 'astrbot');
  response = await request(port, '/api/astrbot/groups/123456', { method: 'DELETE', headers, body: '{}' });
  check('Group policy deletion uses policy.removeGroup', response.status === 200 && !Object.hasOwn(policyData.groups, '123456'));

  response = await request(port, '/api/astrbot/outbound-grants');
  check('Outbound grant listing safely defaults to an empty array for legacy policy mocks',
    response.status === 200 && Array.isArray(response.body.data) && response.body.data.length === 0);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId: 'astrbot_plugin_weather', purpose: 'weather.daily', target: { kind: 'private', id: '123' } }) });
  check('Outbound grant creation still requires the admin CSRF token when policy methods are missing', response.status === 403);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers,
    body: JSON.stringify({ pluginId: 'astrbot_plugin_weather', purpose: 'weather.daily', target: { kind: 'private', id: '123' } }) });
  check('Legacy policy mocks report outbound grant creation as unsupported', response.status === 501);
  response = await request(port, '/api/astrbot/outbound-grants/legacy-grant', { method: 'DELETE', headers, body: '{}' });
  check('Legacy policy mocks report outbound grant revocation as unsupported', response.status === 501);

  policy.listOutboundGrants = async () => structuredClone(outboundGrantRecords);
  policy.createOutboundGrant = async (input) => {
    outboundGrantCalls.create.push(structuredClone(input));
    const grant = {
      id: `grant-${outboundGrantRecords.length + 1}`,
      ...structuredClone(input),
      createdAt: '2026-11-01T00:00:00.000Z', revokedAt: null, active: true, reason: null,
    };
    outboundGrantRecords.push(grant);
    return structuredClone(grant);
  };
  policy.revokeOutboundGrant = async (id) => {
    outboundGrantCalls.revoke.push(id);
    const grant = outboundGrantRecords.find((item) => item.id === id);
    if (!grant) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'ASTRBOT_OUTBOUND_GRANT_NOT_FOUND' });
    grant.active = false;
    grant.revokedAt = '2026-11-01T00:01:00.000Z';
    grant.reason = 'revoked_by_admin';
    return structuredClone(grant);
  };
  outboundGrantRecords.push({
    id: 'stale-config', pluginId: 'astrbot_plugin_weather', purpose: 'weather.daily',
    target: { kind: 'group', id: '456' }, createdAt: '2026-10-31T00:00:00.000Z', revokedAt: null,
    active: false, reason: 'plugin_config_changed',
  });

  const outboundHeaders = { ...headers };
  const privateGrantPayload = { pluginId: 'astrbot_plugin_weather', purpose: 'weather.daily', target: { kind: 'private', id: '123' } };
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify({ ...privateGrantPayload, extra: true }) });
  check('Outbound grants reject extra caller fields', response.status === 400 && outboundGrantCalls.create.length === 0);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify({ ...privateGrantPayload, target: { kind: 'private', id: 'not-a-numeric-id' } }) });
  check('Outbound grants require an explicit numeric target ID', response.status === 400 && outboundGrantCalls.create.length === 0);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify({ ...privateGrantPayload, purpose: 'weather.anything' }) });
  check('Outbound grants are limited to the weather.daily purpose', response.status === 400 && outboundGrantCalls.create.length === 0);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify({ ...privateGrantPayload, pluginId: 'demo' }) });
  check('Outbound grants cannot be issued to another installed plugin', response.status === 400 && outboundGrantCalls.create.length === 0);
  weatherInstalled = false;
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify(privateGrantPayload) });
  check('Outbound grants require the known weather plugin to be installed', response.status === 404 && outboundGrantCalls.create.length === 0);
  weatherInstalled = true;

  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify(privateGrantPayload) });
  const createdPrivateGrant = response.body?.data;
  check('Admin can create an explicit private-target weather.daily grant', response.status === 201 &&
    createdPrivateGrant?.pluginId === 'astrbot_plugin_weather' && createdPrivateGrant?.target?.kind === 'private' &&
    createdPrivateGrant?.target?.id === '123' && outboundGrantCalls.create.length === 1);
  response = await request(port, '/api/astrbot/outbound-grants', { method: 'POST', headers: outboundHeaders,
    body: JSON.stringify({ ...privateGrantPayload, target: { kind: 'group', id: '456' } }) });
  const createdGroupGrant = response.body?.data;
  check('Admin can create an explicit group-target weather.daily grant', response.status === 201 &&
    createdGroupGrant?.target?.kind === 'group' && createdGroupGrant?.target?.id === '456');
  response = await request(port, '/api/astrbot/outbound-grants');
  check('Grant listing preserves stale state and its reason for the UI', response.status === 200 &&
    response.body.data.some((grant) => grant.id === 'stale-config' && grant.active === false && grant.reason === 'plugin_config_changed'));

  response = await request(port, `/api/astrbot/outbound-grants/${encodeURIComponent(createdPrivateGrant.id)}`, { method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: instance.url.slice(0, -1) }, body: '{}' });
  check('Grant revocation requires the admin CSRF token', response.status === 403 && outboundGrantCalls.revoke.length === 0);
  response = await request(port, `/api/astrbot/outbound-grants/${encodeURIComponent(createdPrivateGrant.id)}`, { method: 'DELETE', headers: outboundHeaders, body: '{}' });
  check('Admin can revoke a grant and receives its revoked state', response.status === 200 &&
    response.body.data.active === false && Boolean(response.body.data.revokedAt) && response.body.data.reason === 'revoked_by_admin');
  response = await request(port, '/api/astrbot/outbound-grants/missing-grant', { method: 'DELETE', headers: outboundHeaders, body: '{}' });
  check('Grant revocation preserves policy not-found status and safe error code', response.status === 404 &&
    response.body.error.includes('ASTRBOT_OUTBOUND_GRANT_NOT_FOUND'));

  response = await request(port, '/api/astrbot/plugins/demo', {
    method: 'PUT', headers,
    body: JSON.stringify({ config: {
      apiKey: '', token: '', label: 'updated',
      nested: { access_token: '***', servicePin: '' },
      providers: [
        { __template_key: 'oauth', name: 'backup', clientSecret: '***', region: 'ca' },
        { __template_key: 'oauth', name: 'primary', clientSecret: '', region: 'jp' },
      ],
    } }),
  });
  const configureJobId = response.body?.data?.id;
  const configureJob = await pollJob(port, configureJobId);
  check('Plugin configuration writes return an accepted background job', response.status === 202 && typeof configureJobId === 'string' &&
    configureJob.body?.data?.status === 'succeeded' && calls.configure === 1);
  check('Blank or masked secret updates preserve stored values',
    plugin.config.apiKey === 'synthetic-secret' && plugin.config.token === 'unmarked-token-secret' &&
    plugin.config.nested.access_token === 'nested-secret' && plugin.config.nested.servicePin === 'nested-custom-secret');
  check('Template-list rows preserve their own secrets when reordered by display item',
    plugin.config.providers[0].name === 'backup' && plugin.config.providers[0].clientSecret === 'backup-row-secret' &&
    plugin.config.providers[1].name === 'primary' && plugin.config.providers[1].clientSecret === 'primary-row-secret');
  check('Non-secret plugin config changes are applied', plugin.config.label === 'updated');
  check('Template-list non-secret values are editable', plugin.config.providers[0].region === 'ca' && plugin.config.providers[1].region === 'jp');
  const configureJobResultJson = JSON.stringify(configureJob.body?.data?.result ?? {});
  check('Configure job results mask schema-defined custom secrets before storage',
    !configureJobResultJson.includes('nested-custom-secret') && !configureJobResultJson.includes('primary-row-secret') &&
    !configureJobResultJson.includes('backup-row-secret') && configureJobResultJson.includes('***'));
  response = await request(port, '/api/astrbot/plugins/demo', { method: 'PUT', headers, body: '{"enabled":false}' });
  const enabledJob = await pollJob(port, response.body?.data?.id);
  check('Plugin enablement changes also return a pollable configure job', response.status === 202 &&
    enabledJob.body?.data?.status === 'succeeded' && plugin.enabled === false && calls.configure === 2);
  response = await request(port, '/api/astrbot/plugins/demo', { method: 'PUT', headers, body: '{"enabled":false,"constructor":{}}' });
  check('Prototype-sensitive request keys are rejected without queuing a configure job',
    response.status === 400 && plugin.enabled === false && calls.configure === 2);

  response = await request(port, '/api/astrbot/plugins/demo/update', { method: 'POST', headers, body: '{}' });
  check('Plugin update accepts only its saved GitHub source and ref as a pollable install job', response.status === 202 &&
    response.body.data.id === 'job-1' && calls.install === 1 && calls.installInput.source === plugin.source && calls.installInput.ref === plugin.ref);
  response = await request(port, '/api/astrbot/plugins/demo/update', { method: 'POST', headers, body: '{"source":"https://github.com/attacker/plugin"}' });
  check('Plugin update does not accept caller-selected sources', response.status === 400 && calls.install === 1);

  response = await request(port, '/api/astrbot/plugins/demo/rollback', { method: 'POST', headers, body: '{}' });
  const rollbackJobId = response.body?.data?.id;
  const rollbackJob = await pollJob(port, rollbackJobId);
  check('Rollback reaches the manager through a pollable job', response.status === 202 && calls.rollback === 1 && rollbackJob.body?.data?.status === 'succeeded');

  response = await request(port, '/api/astrbot/plugins/demo', { method: 'DELETE', headers, body: '{}' });
  let uninstallJob = await pollJob(port, response.body?.data?.id);
  check('Uninstall preserves plugin data by default and returns a pollable job', response.status === 202 && calls.uninstall.at(-1).purgeData === false && uninstallJob.body?.data?.status === 'succeeded');
  response = await request(port, '/api/astrbot/plugins/demo', { method: 'DELETE', headers, body: '{"purgeData":true}' });
  uninstallJob = await pollJob(port, response.body?.data?.id);
  check('Data purge is an explicit option on the pollable uninstall job', response.status === 202 && calls.uninstall.at(-1).purgeData === true && uninstallJob.body?.data?.status === 'succeeded');

  response = await request(port, '/api/astrbot/install', { method: 'POST', headers, body: '{"source":"file:///C:/local/plugin"}' });
  check('Installation sources are restricted to GitHub repositories', response.status === 400 && calls.install === 1);
  response = await request(port, '/api/astrbot/install', { method: 'POST', headers, body: '{"source":"https://github.com/example/demo","ref":"main"}' });
  check('GitHub installation returns an accepted job for polling', response.status === 202 && response.body.data.id === 'job-1' && calls.install === 2);
  check('Job status can be polled without exposing installer internals', response.body.data.job.status === 'queued');
  response = await request(port, '/api/astrbot/jobs/missing');
  check('Missing jobs return 404', response.status === 404);
  const zipBase64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString('base64');
  response = await request(port, '/api/astrbot/install', { method: 'POST', headers, body: JSON.stringify({ source: 'upload.zip', zipBase64 }) });
  check('ZIP uploads are size-checked and forwarded as data', response.status === 202 && calls.installInput.zipBase64 === zipBase64);
  response = await request(port, '/api/astrbot/install', { method: 'POST', headers, body: '{"source":"https://github.com/example/demo","zipBase64":"bm90LXppcA=="}' });
  check('Invalid ZIP payloads do not reach the installer', response.status === 400 && calls.install === 3);

  response = await request(port, '/api/astrbot/runtime');
  check('Cross-origin reads are denied', response.status === 200 && !response.headers['access-control-allow-origin']);
  response = await request(port, '/api/astrbot/runtime', { headers: { Origin: 'https://untrusted.invalid' } });
  check('Untrusted runtime reads are refused', response.status === 403);
  response = await request(port, '/api/astrbot/unknown');
  check('Unknown AstrBot routes return 404', response.status === 404);

  const simulatedApi = createAstrbotApi({
    manager, policy, proxySecret,
    readBody: async (req) => req.body ?? '',
    ok: (res, data, status = 200) => { res.status = status; res.payload = { ok: true, data }; },
    fail: (res, status, error) => { res.status = status; res.payload = { ok: false, error }; },
  });
  const diagnosticLog = [];
  const loggingProbeApi = createAstrbotApi({
    manager: { ...manager, async status() { throw Object.assign(new Error('synthetic-secret-value'), { code: 'SENSITIVE_ERROR_CODE' }); } },
    policy, proxySecret,
    readBody: async () => '',
    ok: (res, data, status = 200) => { res.status = status; res.payload = { ok: true, data }; },
    fail: (res, status, error) => { res.status = status; res.payload = { ok: false, error }; },
    log: { warn: (message) => diagnosticLog.push(message) },
  });
  const loggingProbeResponse = {};
  await loggingProbeApi.route({ method: 'GET', url: '/api/astrbot/runtime', headers: { host: '127.0.0.1:5830' },
    socket: { remoteAddress: '127.0.0.1', localPort: 5830 } }, loggingProbeResponse, '/api/astrbot/runtime', 'GET');
  check('Failure logs include only the fixed operation label', diagnosticLog.length === 1 &&
    diagnosticLog[0] === 'astrbot_runtime_read_failed' && !JSON.stringify(diagnosticLog).includes('synthetic-secret-value') &&
    !JSON.stringify(diagnosticLog).includes('SENSITIVE_ERROR_CODE'));

  const gatewayHost = 'nas.example:5830';
  function simulatedProxyRequest(method, url, body = '') {
    return {
      method, url, body,
      headers: {
        host: gatewayHost,
        origin: `http://${gatewayHost}`,
        'x-qq-console-assertion': createProxyAssertion(proxySecret, { method, url, host: gatewayHost }),
      },
      socket: { remoteAddress: '172.22.0.3', localPort: 5830 },
    };
  }
  async function invokeSimulated(req, pathname) {
    const res = {};
    await simulatedApi.route(req, res, pathname, req.method);
    return res;
  }
  const remoteRead = simulatedProxyRequest('GET', '/api/astrbot/runtime');
  const remoteReadResult = await invokeSimulated(remoteRead, '/api/astrbot/runtime');
  check('Authenticated Docker gateway assertion admits a non-loopback console proxy', remoteReadResult.status === 200 && /^[a-f0-9]{64}$/.test(remoteReadResult.payload.data.csrfToken));
  const replayResult = await invokeSimulated(remoteRead, '/api/astrbot/runtime');
  check('A gateway assertion nonce cannot be replayed', replayResult.status === 403);
  const spoofedHost = {
    method: 'GET', url: '/api/astrbot/runtime',
    headers: { host: '127.0.0.1:5830' },
    socket: { remoteAddress: '172.22.0.3', localPort: 5830 },
  };
  const spoofedHostResult = await invokeSimulated(spoofedHost, '/api/astrbot/runtime');
  check('Remote clients cannot gain local trust by spoofing Host', spoofedHostResult.status === 403);
  const forgedAssertion = simulatedProxyRequest('GET', '/api/astrbot/runtime');
  forgedAssertion.headers['x-qq-console-assertion'] = 'client-forged';
  check('A remote request with an untrusted assertion is denied', (await invokeSimulated(forgedAssertion, '/api/astrbot/runtime')).status === 403);
  const remoteToken = remoteReadResult.payload.data.csrfToken;
  const remoteWrite = simulatedProxyRequest('PUT', '/api/astrbot/runtime', '{"enabled":true}');
  remoteWrite.headers['content-type'] = 'application/json';
  remoteWrite.headers['x-qq-astrbot-token'] = remoteToken;
  const remoteWriteResult = await invokeSimulated(remoteWrite, '/api/astrbot/runtime');
  check('The authenticated proxy can mutate runtime policy with the console CSRF token', remoteWriteResult.status === 200 && policyData.enabled === true);

  const remoteGrantRead = simulatedProxyRequest('GET', '/api/astrbot/outbound-grants');
  const remoteGrantReadResult = await invokeSimulated(remoteGrantRead, '/api/astrbot/outbound-grants');
  check('Authenticated proxy can read outbound grants', remoteGrantReadResult.status === 200 && Array.isArray(remoteGrantReadResult.payload.data));
  const remoteGrantCreate = simulatedProxyRequest('POST', '/api/astrbot/outbound-grants', JSON.stringify({
    pluginId: 'astrbot_plugin_weather', purpose: 'weather.daily', target: { kind: 'private', id: '789' },
  }));
  remoteGrantCreate.headers['content-type'] = 'application/json';
  remoteGrantCreate.headers['x-qq-astrbot-token'] = remoteToken;
  const remoteGrantCreateResult = await invokeSimulated(remoteGrantCreate, '/api/astrbot/outbound-grants');
  const remoteGrantId = remoteGrantCreateResult.payload?.data?.id;
  check('Authenticated proxy can create an outbound grant with the console CSRF token',
    remoteGrantCreateResult.status === 201 && typeof remoteGrantId === 'string');
  const remoteGrantRevoke = simulatedProxyRequest('DELETE', `/api/astrbot/outbound-grants/${remoteGrantId}`, '{}');
  remoteGrantRevoke.headers['content-type'] = 'application/json';
  remoteGrantRevoke.headers['x-qq-astrbot-token'] = remoteToken;
  const remoteGrantRevokeResult = await invokeSimulated(remoteGrantRevoke, `/api/astrbot/outbound-grants/${remoteGrantId}`);
  check('Authenticated proxy can revoke an outbound grant with the console CSRF token',
    remoteGrantRevokeResult.status === 200 && remoteGrantRevokeResult.payload.data.active === false);
} finally {
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} 项，失败 0 项`);
