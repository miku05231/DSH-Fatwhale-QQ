// 测试夹具：一个最小的 WebSocket 服务端，用来冒充 NapCat 的 OneBot 服务端。
// 零依赖，只用 node:http + 手写帧编解码。

import http from 'node:http';
import crypto from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
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

export function drainFrames(state) {
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

/**
 * 起一个假 NapCat。
 * @param {object} opts
 * @param {string|null} opts.token 要求客户端携带的 access token
 * @param {(call: {action: string, params: any, echo: any, reply: (data:any)=>void}) => void} [opts.onCall]
 *        收到客户端 API 调用时回调；默认对任何 action 回 {status:'ok', retcode:0, data:null}
 */
export function createFakeNapCat({ token = null, onCall = null, respondToClose = true } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });
  const sockets = [];
  const state = { connections: 0, headers: [], lastSocket: null, calls: [], texts: [] };

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
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString('utf8');
          state.texts.push(text);
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          const call = {
            action: parsed.action,
            params: parsed.params ?? {},
            echo: parsed.echo,
            reply: (data = null) => {
              socket.write(
                encodeFrame(0x1, JSON.stringify({ status: 'ok', retcode: 0, data, echo: parsed.echo })),
              );
            },
          };
          state.calls.push(call);
          if (onCall) onCall(call);
          else call.reply(null);
        } else if (frame.opcode === 0x8) {
          if (respondToClose) socket.end(encodeFrame(0x8));
        } else if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
        }
      }
    });
    socket.on('error', () => {});
  });

  return {
    state,
    /** 像 NapCat 那样推一个事件给客户端 */
    sendJson(obj) {
      state.lastSocket?.write(encodeFrame(0x1, JSON.stringify(obj)));
    },
    /** 投递一条私聊消息事件 */
    sendPrivateMessage({ userId, text, selfId = 10000, messageId = 1 }) {
      this.sendJson({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        self_id: selfId,
        user_id: userId,
        message_id: messageId,
        raw_message: text,
        message: [{ type: 'text', data: { text } }],
      });
    },
    /**
     * 投递一条群消息事件。
     * atSelf=true 时在 message 段里塞一个 at，data.qq 填机器人自己的号，
     * 这样 checkGroupAllowed 的 isAtSelf 才会成立。
     */
    sendGroupMessage({ groupId, userId, text, selfId = 10000, messageId = 2, nickname = '', atSelf = false }) {
      const message = [];
      if (atSelf) message.push({ type: 'at', data: { qq: String(selfId) } });
      if (text) message.push({ type: 'text', data: { text: ` ${text}` } });
      this.sendJson({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: selfId,
        group_id: groupId,
        user_id: userId,
        message_id: messageId,
        raw_message: (atSelf ? `[CQ:at,qq=${selfId}] ` : '') + (text ?? ''),
        sender: { user_id: userId, nickname: nickname || String(userId) },
        message,
      });
    },
    destroy() {
      state.lastSocket?.destroy();
    },
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
