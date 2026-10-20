import { OneBot, normalizeMessage } from '../src/onebot.js';
import assert from 'node:assert/strict';

const start = Date.now();
const reconnects = [];
const log = {
  info: () => {},
  warn: (...a) => { if (String(a[0]).includes('重连')) reconnects.push(Date.now() - start); },
  error: () => {},
  debug: () => {},
};
const c = new OneBot({ url: 'ws://127.0.0.1:9/x', log });
c.connect();
await new Promise((r) => setTimeout(r, 8200));
c.close();
console.log('重连时间点(ms):', reconnects);
assert.equal(reconnects.length, 4, '应有 4 次调度');
const gaps = reconnects.slice(1).map((t, i) => t - reconnects[i]);
console.log('间隔(ms):', gaps);
assert.ok(gaps[0] >= 700 && gaps[0] <= 1400, `首次退避应约 1s，实际 ${gaps[0]}`);
assert.ok(gaps[1] >= 1500 && gaps[1] <= 2600, `第二次退避应约 2s，实际 ${gaps[1]}`);
assert.ok(gaps[2] >= 3300 && gaps[2] <= 4600, `第三次退避应约 4s，实际 ${gaps[2]}`);

// reconnect:false
const logs = [];
const log2 = { info: () => {}, warn: (...a) => logs.push(a.join(' ')), error: () => {}, debug: () => {} };
const c2 = new OneBot({ url: 'ws://127.0.0.1:9/x', log: log2, reconnect: false });
c2.connect();
await new Promise((r) => setTimeout(r, 1500));
c2.close();
returned_try: {
  assert.ok(!logs.some((l) => l.includes('重连')), 'reconnect:false 不应重连: ' + logs.join(' | '));
}
console.log('reconnect:false 日志条数 =', logs.length, '无重连 OK');

// number/字符串 id 兼容
assert.equal(normalizeMessage({ message_type: 'group', group_id: '555666777', user_id: '123456789', message: [] }).groupId, 555666777);
assert.equal(normalizeMessage({ message_type: 'group', group_id: '555666777', user_id: '123456789', message: [] }).userId, 123456789);
console.log('字符串 id 归一化 OK');
process.exit(0);
