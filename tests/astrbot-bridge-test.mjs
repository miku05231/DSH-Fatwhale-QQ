import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAstrbotPolicy, astrbotAdmission } from '../src/astrbot-policy.mjs';
import { createAstrbotBridge } from '../src/astrbot-bridge.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-astrbot-boundary-'));
const cfg = { stateDir: 'state', security: { allowGroups: true, allowGroupIds: ['123'],
  adminUserIds: ['456'], allowFrom: ['456'], denyFrom: [], allowGroupMembers: false },
  astrbot: { enabled: true } };
const readConfig = () => cfg;
const policy = createAstrbotPolicy({ root, readConfig });
let bridge;
let checks = 0;
function check(value) { assert.ok(value); checks++; }
const msg = (id = '1', userId = '789') => ({ messageType: 'group', groupId: '123', userId,
  text: '/test', raw: { message_id: id, message: [{ type: 'text', data: { text: '/test' } }], sender: { role: 'owner' } } });
let ids = [{ id: 'test_plugin', enabled: true }], mode, origin, calls = 0, listHook;
const sends = [];
const manager = {
  listPlugins: async () => { await listHook?.(); return ids; }, getToken: async () => 'isolated-fixture-token', start: async () => {},
  runtimeRpc: async (method, params) => {
    if (method === 'cancel') return {};
    calls++; origin = params.contextId;
    if (mode) await mode(params);
    return { handled: false, status: 'unhandled' };
  },
};
const makeBridge = () => createAstrbotBridge({ root, readConfig, manager, policy, port: 0,
  send: async (action, params) => { sends.push({ action, params }); return { message_id: sends.length }; },
  generate: async () => ({ choices: [{ message: { content: 'fixture' } }] }),
});
const invoke = (method, params, contextId = origin, pluginId = 'test_plugin') =>
  bridge.callback({ version: 1, method, contextId, pluginId, params });
const target = { isGroup: true, groupId: '123' };
const text = [{ type: 'text', data: { text: 'fixture' } }];
try {
  bridge = makeBridge();
  check((await policy.get()).enabled === false); // Missing persisted policy stays off despite legacy config.
  check((await bridge.dispatch(msg())).handled === false && calls === 0);
  await policy.setEnabled(true);
  await policy.setGroup('123', { pluginIds: ['test_plugin'], chatMode: 'dsh' });
  assert.throws(() => policy.setGroup('__proto__', { pluginIds: [], chatMode: 'dsh' })); checks++;
  assert.throws(() => policy.setGroup('123', { pluginIds: ['__proto__'], chatMode: 'dsh' })); checks++;
  const admitted = astrbotAdmission(msg(), cfg, await policy.get(), ['test_plugin']);
  check(admitted && !admitted.isAdmin); // QQ owner role cannot promote identity.
  mode = async (p) => { check(p.event.isAdmin === false); await invoke('send', { target, message: text }); };
  check((await bridge.dispatch(msg())).handled === true && sends.length === 1);
  check((await bridge.dispatch(msg())).status === 'duplicate' && sends.length === 1 && calls === 1);
  await assert.rejects(() => invoke('send', { target: { isGroup: true, groupId: '999' }, message: text }), /PERMISSION_DENIED/); checks++;
  await assert.rejects(() => invoke('send', { target, message: [{ type: 'image', data: { file: 'file:///C:/private.txt' } }] }), /HANDLE_REQUIRED/); checks++;
  await assert.rejects(() => invoke('send', { target, message: [{ type: 'at', data: { qq: 'all' } }] }), /UNSUPPORTED/); checks++;
  check((await invoke('tools.authorize', { name: 'test_tool', recordUse: false })).allowed);
  const discovered = JSON.parse(await fs.readFile(path.join(root, 'state/astrbot/contexts', `${origin}.json`)));
  check(discovered.toolUsed === false);
  check((await invoke('tools.authorize', { name: 'test_tool' })).allowed);
  const savedOrigin = origin;
  const abort = new AbortController();
  let authCalls = 0;
  listHook = async () => { if (++authCalls === 2) abort.abort(); };
  await assert.rejects(() => bridge.callback({ version: 1, method: 'send', contextId: savedOrigin,
    pluginId: 'test_plugin', params: { target, message: text } }, { signal: abort.signal }), /RPC_ABORTED/); checks++;
  check(sends.length === 1);
  listHook = null;
  await assert.rejects(() => bridge.callback({ version: 1, method: 'tools.authorize', contextId: savedOrigin,
    pluginId: 'test_plugin', params: { name: 'test_tool' } }, { signal: abort.signal }), /RPC_ABORTED/); checks++;
  // Pending verification: revocation during the durable tool-effect write must
  // be observed before the runtime receives permission to execute the tool.
  authCalls = 0;
  listHook = async () => { if (++authCalls === 2) ids[0].enabled = false; };
  await assert.rejects(() => invoke('tools.authorize', { name: 'test_tool' }, savedOrigin), /PERMISSION_DENIED/); checks++;
  ids[0].enabled = true;
  listHook = null;
  const media = path.join(root, 'state/astrbot/media');
  await fs.mkdir(media, { recursive: true });
  const picture = path.join(media, 'fixture.png');
  await fs.writeFile(picture, Buffer.from([137, 80, 78, 71]));
  mode = async (p) => { check(p.event.message[0].data.file === 'base64://iVBORw=='); };
  const incoming = msg('media-local');
  incoming.raw.message = [{ type: 'image', data: { file: pathToFileURL(picture).href } }];
  check((await bridge.dispatch(incoming)).status === 'unhandled');
  mode = async (p) => { check(p.event.message[0].data.file === 'https://image.invalid/fixture'); };
  incoming.raw.message_id = 'media-url';
  incoming.raw.message = [{ type: 'image', data: { file: 'qq-image-id', url: 'https://image.invalid/fixture' } }];
  await bridge.dispatch(incoming);
  await fs.writeFile(path.join(root, 'state/secret-fixture.txt'), 'never-transfer');
  incoming.raw.message_id = 'media-outside';
  incoming.raw.message = [{ type: 'record', data: { file: path.join(root, 'state/secret-fixture.txt') } }];
  check((await bridge.dispatch(incoming)).status === 'failed');
  await bridge.stop(); bridge = makeBridge();
  // A durable origin survives a bridge restart, without storing message text.
  check((await invoke('send', { target, message: text }, savedOrigin)).message_id === 2);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'state/astrbot/contexts', `${savedOrigin}.json`)));
  check(stored.sent && stored.toolUsed && !Object.hasOwn(stored, 'text'));
  await policy.setGroup('123', { pluginIds: [], chatMode: 'dsh' });
  await assert.rejects(() => invoke('send', { target, message: text }, savedOrigin), /PERMISSION_DENIED/); checks++;
  await policy.setGroup('123', { pluginIds: ['test_plugin'], chatMode: 'astrbot' });
  mode = null;
  check((await bridge.dispatch(msg('2'), { isWake: true })).handled);
  check((await invoke('llm', { messages: [] }, origin, '__ai__')).choices.length === 1);
  await assert.rejects(() => invoke('tools.authorize', { name: 'desktop_tool' }, origin, '__ai__'), /PERMISSION_DENIED/); checks++;
  await bridge.dispatch(msg('3'), { isWake: false });
  await assert.rejects(() => invoke('llm', {}, origin, '__ai__'), /PERMISSION_DENIED/); checks++;
  ids[0].enabled = false;
  await assert.rejects(() => invoke('llm', {}, savedOrigin), /PERMISSION_DENIED/); checks++;
  ids[0].enabled = true;
  await bridge.dispatch(msg('4', '456'));
  cfg.security.adminUserIds = [];
  await assert.rejects(() => invoke('send', { target, message: text }), /PERMISSION_DENIED/); checks++;
  cfg.security.adminUserIds = ['456'];
  const address = await bridge.start();
  const url = `http://127.0.0.1:${address.port}/rpc/callback`;
  check((await fetch(url, { method: 'POST', body: '{}' })).status === 403);
  check((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer isolated-fixture-token', Origin: 'http://evil.invalid' }, body: '{}' })).status === 403);
  mode = async () => { await invoke('send', { target, message: text }); throw new Error('lost acknowledgement'); };
  const before = sends.length;
  check((await bridge.dispatch(msg('5'))).status === 'failed' && sends.length === before + 1);
  check((await bridge.dispatch(msg('5'))).status === 'duplicate' && sends.length === before + 1);
  cfg.security.denyFrom = ['789'];
  check((await bridge.dispatch(msg('6'))).handled === false);
  cfg.security.denyFrom = [];
  await policy.setEnabled(false);
  await assert.rejects(() => invoke('send', { target, message: text }, savedOrigin), /PERMISSION_DENIED/); checks++;
  console.log(`AstrBot boundary checks ${checks}, fail 0`);
} finally {
  await bridge?.stop();
  const resolved = await fs.realpath(root);
  assert.ok(path.relative(os.tmpdir(), resolved).startsWith('qq-astrbot-boundary-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 });
}
