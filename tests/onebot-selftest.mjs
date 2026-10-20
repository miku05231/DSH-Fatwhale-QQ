// 临时自测脚本（验证完删除，不入库）
// 说明：Node 内置没有 WebSocket 服务端，这里用 node:http 的 upgrade 事件实现最小握手 + 帧编解码。
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { OneBot, normalizeMessage } from '../src/onebot.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let passed = 0;
function ok(name, detail = '') {
  passed += 1;
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 最小 WS 服务端
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function drainFrames(state) {
  const frames = [];
  let offset = 0;
  while (state.buffer.length - offset >= 2) {
    const b1 = state.buffer[offset];
    const b2 = state.buffer[offset + 1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (state.buffer.length < p + 2) break;
      len = state.buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (state.buffer.length < p + 8) break;
      len = Number(state.buffer.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (state.buffer.length < p + 4) break;
      mask = state.buffer.subarray(p, p + 4);
      p += 4;
    }
    if (state.buffer.length < p + len) break;
    const payload = Buffer.from(state.buffer.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    offset = p + len;
  }
  state.buffer = state.buffer.subarray(offset);
  return frames;
}

function createMiniServer({ token = null } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });
  const sockets = [];
  const state = { connections: 0, headers: [], lastSocket: null, onText: null };

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    state.connections += 1;
    state.headers.push(req.headers);
    state.lastSocket = socket;
    sockets.push(socket);

    const frameState = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      frameState.buffer = Buffer.concat([frameState.buffer, chunk]);
      for (const frame of drainFrames(frameState)) {
        if (frame.opcode === 0x1) state.onText?.(frame.payload.toString('utf8'));
        else if (frame.opcode === 0x8) socket.end(encodeFrame(0x8));
        else if (frame.opcode === 0x9) socket.write(encodeFrame(0xa, frame.payload));
      }
    });
    socket.on('error', () => {});
  });

  return {
    state,
    send(text) {
      state.lastSocket?.write(encodeFrame(0x1, text));
    },
    sendJson(obj) {
      this.send(JSON.stringify(obj));
    },
    destroy() {
      state.lastSocket?.destroy();
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function waitEvent(emitter, name, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, handler);
      reject(new Error(`等待事件 ${name} 超时（${timeout}ms）`));
    }, timeout);
    function handler(...args) {
      clearTimeout(timer);
      emitter.off(name, handler);
      resolve(args);
    }
    emitter.on(name, handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG') };
}

// ---------------------------------------------------------------- 1. normalizeMessage
function testNormalize() {
  // 样例 1：私聊纯文本
  const privatePlain = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time: 1760890001,
    self_id: 10000,
    user_id: 123456789,
    message_id: 1234,
    message: [{ type: 'text', data: { text: '你好，帮我查下天气' } }],
    raw_message: '你好，帮我查下天气',
    sender: { user_id: 123456789, nickname: '小明' },
  };
  const m1 = normalizeMessage(privatePlain);
  assert.equal(m1.messageType, 'private');
  assert.equal(m1.userId, 123456789);
  assert.equal(m1.groupId, null);
  assert.equal(m1.text, '你好，帮我查下天气');
  assert.equal(m1.raw, privatePlain);
  ok('normalize 1/私聊纯文本', JSON.stringify({ messageType: m1.messageType, userId: m1.userId, groupId: m1.groupId, text: m1.text }));

  // 样例 2：私聊含 at + 图片（图片应被忽略，并记 debug）
  const privateAtImage = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time: 1760890002,
    self_id: 10000,
    user_id: 987654321,
    message_id: 1235,
    message: [
      { type: 'at', data: { qq: '10000', name: '机器人' } },
      { type: 'text', data: { text: ' 看一下这张图 ' } },
      { type: 'image', data: { file: 'abc.jpg', url: 'https://gchat.qpic.cn/abc.jpg' } },
      { type: 'text', data: { text: '谢谢' } },
    ],
    raw_message: '[CQ:at,qq=10000] 看一下这张图 [CQ:image,file=abc.jpg]谢谢',
    sender: { user_id: 987654321, nickname: '小红' },
  };
  const log2 = createLog();
  const m2 = normalizeMessage(privateAtImage, log2);
  assert.equal(m2.messageType, 'private');
  assert.equal(m2.userId, 987654321);
  assert.equal(m2.groupId, null);
  assert.equal(m2.text, '@机器人 看一下这张图 谢谢');
  assert.ok(
    log2.lines.some((l) => l.startsWith('DEBUG') && l.includes('image')),
    '应记录 image 片段的 debug 日志',
  );
  ok('normalize 2/私聊 at+图片', JSON.stringify({ messageType: m2.messageType, userId: m2.userId, groupId: m2.groupId, text: m2.text }));

  // 样例 3：群聊（含 at 机器人 + face，face 应被忽略）
  const groupMsg = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    time: 1760890003,
    self_id: 10000,
    group_id: 555666777,
    user_id: 123456789,
    message_id: 1236,
    message: [
      { type: 'at', data: { qq: '10000', name: '机器人' } },
      { type: 'text', data: { text: ' 群里问个事' } },
      { type: 'face', data: { id: '14' } },
    ],
    raw_message: '[CQ:at,qq=10000] 群里问个事[CQ:face,id=14]',
    sender: { user_id: 123456789, nickname: '小明', card: '小明同学' },
  };
  const m3 = normalizeMessage(groupMsg);
  assert.equal(m3.messageType, 'group');
  assert.equal(m3.userId, 123456789);
  assert.equal(m3.groupId, 555666777);
  assert.equal(m3.text, '@机器人 群里问个事');
  ok('normalize 3/群聊', JSON.stringify({ messageType: m3.messageType, userId: m3.userId, groupId: m3.groupId, text: m3.text }));

  // 边界：at 无昵称、@全体、字符串 message、非法入参
  assert.equal(normalizeMessage({ message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'at', data: { qq: '10001' } }] }).text, '@10001');
  assert.equal(normalizeMessage({ message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 开会' } }] }).text, '@全体成员 开会');
  assert.equal(normalizeMessage({ message_type: 'private', user_id: 2, message: '纯字符串消息' }).text, '纯字符串消息');
  assert.equal(normalizeMessage(null), null);
  assert.equal(normalizeMessage([]), null);
  ok('normalize 边界/at 无昵称、@全体、字符串 message、非法入参');
}

// ---------------------------------------------------------------- 2. 连不上时进入重连而非崩溃
async function testDeadPort() {
  const log = createLog();
  const client = new OneBot({ url: 'ws://127.0.0.1:9/onebot', log });
  assert.equal(client.connected, false);
  let uncaught = null;
  const onUncaught = (err) => {
    uncaught = err;
  };
  process.once('uncaughtException', onUncaught);

  client.connect(); // 端口 9 无服务，必须不抛同步异常
  await sleep(400);
  assert.equal(uncaught, null, `不应有未捕获异常：${uncaught?.message}`);
  assert.equal(client.connected, false);
  assert.ok(log.lines.some((l) => l.includes('正在连接')), '应有连接尝试日志');
  assert.ok(log.lines.some((l) => l.includes('重连')), '应进入重连退避日志');
  const pending = client.call('get_status').then(
    () => ({ resolved: true }),
    (err) => ({ resolved: false, message: err.message }),
  );
  const rejected = await pending;
  assert.equal(rejected.resolved, false);
  ok('dead-port/connect 不抛未捕获异常且进入重连', rejected.message);
  client.close();
  process.removeListener('uncaughtException', onUncaught);
  await sleep(100);
}

// ---------------------------------------------------------------- 3. 真实连接：握手头 / call / message / 超时 / 断线清理 / 重连
async function testLive() {
  const token = 'test-token-123';
  const server = createMiniServer({ token });
  const port = await server.listen();
  const url = `ws://127.0.0.1:${port}`;
  const log = createLog();
  const client = new OneBot({ url, accessToken: token, log });

  server.state.onText = (text) => {
    const req = JSON.parse(text);
    if (req.action === 'get_login_info') {
      server.sendJson({ status: 'ok', retcode: 0, data: { user_id: 10000, nickname: '桥接机器人' }, echo: req.echo });
    } else if (req.action === 'send_private_msg') {
      server.sendJson({ status: 'failed', retcode: 1404, data: null, message: '目标账号不存在', echo: req.echo });
    }
    // slow_* 故意不响应
  };

  const ready1 = waitEvent(client, 'ready');
  client.connect();
  await ready1;
  assert.equal(client.connected, true);
  assert.equal(server.state.connections, 1);
  assert.equal(server.state.headers[0].authorization, `Bearer ${token}`);
  ok('live/握手成功并携带 Authorization 头', `connections=${server.state.connections}`);

  // echo 关联 + resolve data
  const info = await client.call('get_login_info');
  assert.deepEqual(info, { user_id: 10000, nickname: '桥接机器人' });
  ok('live/call 按 echo 关联并 resolve data', JSON.stringify(info));

  // 失败响应 reject
  await assert.rejects(() => client.call('send_private_msg', { user_id: 1, message: 'x' }), /目标账号不存在/);
  ok('live/call 失败响应 reject 且带服务端 message');

  // 超时 reject
  const startedAt = Date.now();
  await assert.rejects(() => client.call('slow_timeout', {}, { timeoutMs: 150 }), /超时/);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 130 && elapsed < 1200, `超时时间异常: ${elapsed}ms`);
  ok('live/call 超时 reject', `${elapsed}ms`);

  // 服务端下发群消息 → 'message' 归一化
  const msgPromise = waitEvent(client, 'message');
  server.sendJson({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 10000,
    group_id: 555666777,
    user_id: 123456789,
    message_id: 9001,
    message: [
      { type: 'at', data: { qq: '10000', name: '机器人' } },
      { type: 'text', data: { text: ' 在吗' } },
      { type: 'image', data: { file: 'x.jpg' } },
    ],
    sender: { user_id: 123456789, nickname: '小明' },
  });
  const [msg] = await msgPromise;
  assert.equal(msg.messageType, 'group');
  assert.equal(msg.groupId, 555666777);
  assert.equal(msg.userId, 123456789);
  assert.equal(msg.text, '@机器人 在吗');
  ok('live/服务端事件 → message 归一化', JSON.stringify({ messageType: msg.messageType, groupId: msg.groupId, userId: msg.userId, text: msg.text }));

  // 自身消息（message_sent）必须被忽略，否则会形成回复回环
  let leaked = null;
  const onLeak = (m) => {
    leaked = m;
  };
  client.on('message', onLeak);
  server.sendJson({
    post_type: 'message_sent',
    message_type: 'group',
    self_id: 10000,
    group_id: 555666777,
    user_id: 10000,
    message: [{ type: 'text', data: { text: '机器人自己的回复' } }],
    sender: { user_id: 10000, nickname: '桥接机器人' },
  });
  await sleep(250);
  client.off('message', onLeak);
  assert.equal(leaked, null, 'message_sent 不应触发 message 事件');
  ok('live/message_sent 自身消息被忽略（防回环）');

  // 断线：挂起中的 call 必须被 reject，同时 emit 'disconnect'
  const disconnectPromise = waitEvent(client, 'disconnect');
  const hanging = client.call('slow_hanging', {}, { timeoutMs: 10000 });
  await sleep(50);
  server.destroy();
  const [disconnectErr] = await disconnectPromise;
  assert.ok(disconnectErr instanceof Error, 'disconnect 应带错误对象');
  await assert.rejects(() => hanging, /连接已断开/);
  assert.equal(client.connected, false);
  ok('live/断线时挂起 call 全部 reject 并 emit disconnect', disconnectErr.message);

  // 重连：1s 后第二次 ready，且新连接仍带 token
  const ready2 = waitEvent(client, 'ready', 5000);
  await ready2;
  assert.equal(server.state.connections, 2);
  assert.equal(server.state.headers[1].authorization, `Bearer ${token}`);
  assert.equal(client.connected, true);
  ok('live/断线后自动重连并再次 ready', `connections=${server.state.connections}`);

  // 重连后 call 仍可用
  const info2 = await client.call('get_login_info');
  assert.equal(info2.nickname, '桥接机器人');
  ok('live/重连后 call 仍可用');

  // 主动 close：不再重连，之后 call 立即 reject
  client.close();
  assert.equal(client.connected, false);
  await assert.rejects(() => client.call('get_status'), /尚未连接/);
  await sleep(1600);
  assert.equal(server.state.connections, 2, 'close() 后不应重连');
  ok('live/close() 后不再重连，call 立即 reject');

  // close 后无挂起 Promise 泄漏：pending 内部应为空（通过行为验证——再次 close 不报错）
  client.close();
  await server.close();
}

// ---------------------------------------------------------------- 主流程
(async () => {
  try {
    testNormalize();
    await testDeadPort();
    await testLive();
    console.log(`\n全部通过：${passed} 项断言组`);
    process.exit(0);
  } catch (err) {
    console.error('\nFAIL:', err?.stack || err);
    process.exit(1);
  }
})();
