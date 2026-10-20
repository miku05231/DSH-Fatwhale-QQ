/**
 * ui-probe.mjs —— 连上已经在跑的 Edge 调试端口，执行任意 JS 表达式。
 *
 * 配合 `node tests/ui-cdp.mjs --keep` 使用：ui-cdp 会留下一个调试浏览器。
 *
 * 用法：
 *   node tests/ui-probe.mjs "document.title"
 *   node tests/ui-probe.mjs --port 9333 "JSON.stringify(getComputedStyle(document.body).background)"
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 9333;
const expressions = argv.filter((_, i) => i !== portIndex && i !== portIndex + 1);

if (expressions.length === 0) {
  console.error('用法：node tests/ui-probe.mjs "<JS 表达式>" [更多表达式...]');
  process.exit(2);
}

async function json(url) {
  const res = await fetch(url);
  return JSON.parse(await res.text());
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const item = this.pending.get(msg.id);
      if (!item) return;
      this.pending.delete(msg.id);
      msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('无法连接调试端口')));
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const main = async () => {
  const targets = await json(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面目标');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  for (const expression of expressions) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        console.log(`ERR  ${result.exceptionDetails.text}`);
        continue;
      }
      const value = result.result?.value;
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    } catch (err) {
      console.log(`ERR  ${err.message}`);
    }
  }
  process.exit(0);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
