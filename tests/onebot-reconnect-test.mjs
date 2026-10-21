// The child has no keepalive timer or IPC channel: OneBot must own its retry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createFakeNapCat } from './ws-harness.mjs';

const source = new URL('../src/onebot.js', import.meta.url).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(25);
  }
  throw new Error('Timed out waiting for OneBot');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(port, closeOnError = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { OneBot } from ${JSON.stringify(source)};
    const bot = new OneBot({ url: 'ws://127.0.0.1:${port}' });
    bot.on('error', () => {
      console.log('ERROR');
      if (${closeOnError}) { bot.close(); console.log('CLOSED'); }
    });
    bot.on('ready', () => { console.log('READY'); bot.close(); });
    bot.connect();
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  return { child, exited, output: () => output };
}

const fake = createFakeNapCat();
let worker;
let listening = false;
try {
  const port = await freePort();
  worker = start(port);
  await until(() => worker.output().includes('ERROR'));
  await pause(200);
  assert.equal(worker.child.exitCode, null, 'error-only failure must keep a retry alive');
  await fake.listen(port);
  listening = true;
  await until(() => worker.output().includes('READY'));
  const [code] = await worker.exited;
  assert.equal(code, 0, worker.output());
  assert.equal(fake.state.connections, 1);
  console.log('PASS error-only failure keeps process alive, then reconnects and closes');
} finally {
  if (worker?.child.exitCode === null) worker.child.kill();
  if (listening) await fake.close();
}

worker = start(await freePort(), true);
try {
  await until(() => worker.child.exitCode !== null);
  assert.equal(worker.child.exitCode, 0, worker.output());
  assert.ok(worker.output().includes('CLOSED'));
  assert.equal((worker.output().match(/ERROR/g) || []).length, 1);
  console.log('PASS close during error handling cancels reconnection');
} finally {
  if (worker.child.exitCode === null) worker.child.kill();
}

const nativeWebSocket = globalThis.WebSocket;
const sockets = [];
class ErrorOnlyWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  constructor() { super(); sockets.push(this); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = ErrorOnlyWebSocket;
const { OneBot } = await import(`${source}?error-only-regression`);
const client = new OneBot({ url: 'ws://127.0.0.1:39009' });
try {
  client.connect();
  const old = sockets[0];
  const error = new Event('error');
  error.message = 'synthetic error without close';
  old.dispatchEvent(error);
  await until(() => sockets.length === 2);
  sockets[1].readyState = ErrorOnlyWebSocket.OPEN;
  sockets[1].dispatchEvent(new Event('open'));
  assert.equal(client.connected, true);
  old.dispatchEvent(new Event('close'));
  assert.equal(client.connected, true, 'late close from failed socket must not close its replacement');
  client.close();
  await pause(1200);
  assert.equal(sockets.length, 2, 'close must cancel all remaining retries');
  console.log('PASS late close from old socket is ignored; explicit close stops retries');
} finally {
  client.close();
  globalThis.WebSocket = nativeWebSocket;
}
