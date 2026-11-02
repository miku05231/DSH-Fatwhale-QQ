import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAstrbotPolicy, atomicAstrbotJson } from '../src/astrbot-policy.mjs';
import { createAstrbotBridge } from '../src/astrbot-bridge.mjs';
import { astrbotScheduledOriginEpochs, assertAstrbotScheduledOrigin,
  invalidateAstrbotScheduledAuthorization } from '../src/astrbot-outbound.mjs';

const ARCHIVE = 'd149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30';
const PLUGIN = 'astrbot_plugin_weather';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-astrbot-outbound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state', 'astrbot');
  const config = { security: { allowGroups: true, allowGroupIds: ['123'], denyFrom: [] } };
  const policy = createAstrbotPolicy({ root, readConfig: () => config });
  const filename = path.join(state, 'generations', 'generation-1', 'manager', 'plugins.json');
  const plugin = { id: PLUGIN, enabled: true, archiveSHA256: ARCHIVE, treeSHA256: 'a'.repeat(64),
    installedAt: '2026-01-01T00:00:00.000Z', config: { city: 'test-city' } };
  await atomicAstrbotJson(path.join(state, 'plugins.json'), { schemaVersion: 2, activeGeneration: 'generation-1' });
  await atomicAstrbotJson(filename, { schemaVersion: 1, plugins: { [PLUGIN]: plugin } });
  await policy.setEnabled(true);
  await policy.setGroup('123', { pluginIds: [PLUGIN], chatMode: 'dsh' });
  const input = { pluginId: PLUGIN, purpose: 'weather.daily', target: { kind: 'private', id: '789' } };
  const request = { ...input, sourceSHA256: ARCHIVE };
  return { root, state, filename, config, plugin, policy, input, request };
}

test('outbound weather starts denied and grants one exact target and purpose', async (t) => {
  const x = await fixture(t);
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  const granted = await x.policy.createOutboundGrant(x.input);
  assert.equal(granted.active, true);
  assert.equal((await x.policy.authorizeOutbound(x.request)).grantId, granted.id);
  await assert.rejects(x.policy.authorizeOutbound({ ...x.request, target: { kind: 'private', id: '790' } }), /PERMISSION_DENIED/);
  await assert.rejects(x.policy.authorizeOutbound({ ...x.request, purpose: 'llm' }), /PERMISSION_DENIED/);
  await assert.rejects(x.policy.authorizeOutbound({ ...x.request, sourceSHA256: 'b'.repeat(64) }), /PERMISSION_DENIED/);
  await assert.rejects(x.policy.createOutboundGrant({ ...x.input, target: { kind: 'private', id: '99999999999999999999' } }), /TARGET_INVALID/);
});

test('explicit revoke cannot be reversed by restoring an environment manifest', async (t) => {
  const x = await fixture(t);
  const grant = await x.policy.createOutboundGrant(x.input);
  const snapshot = await fs.readFile(x.filename);
  await x.policy.revokeOutboundGrant(grant.id);
  await fs.writeFile(x.filename, snapshot);
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  assert.equal((await x.policy.listOutboundGrants())[0].reason, 'revoked');
});

test('lifecycle invalidation revokes both grant and original creator context', async (t) => {
  const x = await fixture(t);
  await x.policy.createOutboundGrant(x.input);
  const context = { scheduledAuthorization: await astrbotScheduledOriginEpochs(x.state, [PLUGIN]) };
  await assertAstrbotScheduledOrigin({ root: x.state, pluginId: PLUGIN, context });
  await invalidateAstrbotScheduledAuthorization({ root: x.state, pluginIds: [PLUGIN], reason: 'configure' });
  await assert.rejects(assertAstrbotScheduledOrigin({ root: x.state, pluginId: PLUGIN, context }), /ORIGIN_REVOKED/);
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  const next = { scheduledAuthorization: await astrbotScheduledOriginEpochs(x.state, [PLUGIN]) };
  await assertAstrbotScheduledOrigin({ root: x.state, pluginId: PLUGIN, context: next });
});

test('global off/on and removing/readding a group cannot revive grants', async (t) => {
  const x = await fixture(t);
  await x.policy.createOutboundGrant(x.input);
  await x.policy.setEnabled(false);
  await x.policy.setEnabled(true);
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  await x.policy.createOutboundGrant(x.input);
  await x.policy.removeGroup('123');
  await x.policy.setGroup('123', { pluginIds: [PLUGIN], chatMode: 'dsh' });
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
});

test('source/config/disabled state and target blocks are checked at send time', async (t) => {
  const x = await fixture(t);
  await x.policy.createOutboundGrant(x.input);
  x.config.security.denyFrom = ['789'];
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  x.config.security.denyFrom = [];
  await atomicAstrbotJson(x.filename, { plugins: { [PLUGIN]: { ...x.plugin, config: { city: 'changed' } } } });
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
  await atomicAstrbotJson(x.filename, { plugins: { [PLUGIN]: { ...x.plugin, enabled: false } } });
  await assert.rejects(x.policy.authorizeOutbound(x.request), /PERMISSION_DENIED/);
});

test('outbound callback has no inbound identity and accepts text only', async (t) => {
  const x = await fixture(t), sends = [];
  const bridge = createAstrbotBridge({ root: x.root, readConfig: () => x.config, policy: x.policy,
    manager: { listPlugins: async () => [x.plugin] }, send: async (...args) => { sends.push(args); return { message_id: 1 }; } });
  const body = { version: 1, method: 'outbound.send', pluginId: PLUGIN, params: {
    purpose: x.request.purpose, sourceSHA256: ARCHIVE, target: x.input.target,
    message: [{ type: 'text', data: { text: 'controlled weather' } }],
  } };
  await assert.rejects(bridge.callback(body), /PERMISSION_DENIED/);
  const grant = await x.policy.createOutboundGrant(x.input);
  await bridge.callback(body);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], 'send_private_msg');
  await assert.rejects(bridge.callback({ ...body, contextId: 'a-fake-context' }), /PERMISSION_DENIED/);
  await assert.rejects(bridge.callback({ ...body, params: { ...body.params,
    message: [{ type: 'at', data: { qq: 'all' } }] } }), /PERMISSION_DENIED/);
  await x.policy.revokeOutboundGrant(grant.id);
  await assert.rejects(bridge.callback(body), /PERMISSION_DENIED/);
  assert.equal(sends.length, 1);
});

test('independent invalidations preserve revocation for both plugins', async (t) => {
  const x = await fixture(t), ids = [PLUGIN, 'astrbot_plugin_reminder'];
  const context = { scheduledAuthorization: await astrbotScheduledOriginEpochs(x.state, ids) };
  await Promise.all(ids.map((id) => invalidateAstrbotScheduledAuthorization({ root: x.state, pluginIds: [id] })));
  for (const id of ids) await assert.rejects(assertAstrbotScheduledOrigin({ root: x.state, pluginId: id, context }), /ORIGIN_REVOKED/);
});
