// Real Docker checks. QQ traffic is synthetic; real DSH is optional.
// Run: node tests/docker-runtime-test.mjs [image]
// Optional: DSH_VERIFY_RUNTIME_VOLUME and DSH_VERIFY_CREDENTIALS_FILE.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.argv[2] || 'qq-dsh-bridge:verify';
const prefix = `qq-dsh-check-${process.pid}`;
const homeVolume = `${prefix}-home`;
const runtimeVolume = process.env.DSH_VERIFY_RUNTIME_VOLUME;
const credentialsFile = process.env.DSH_VERIFY_CREDENTIALS_FILE;
if (runtimeVolume) assert.ok(credentialsFile, 'DSH_VERIFY_CREDENTIALS_FILE is required with a real runtime');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-docker-'));
const containers = new Set();
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function docker(...args) {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr || run.stdout);
  return run.stdout.trim();
}
function run(name, args) {
  containers.add(name);
  return docker('run', '-d', '--name', name, '--label', 'qq-dsh-verification=runtime', ...args);
}
function remove(name) {
  docker('stop', '-t', '10', name);
  docker('rm', name);
  containers.delete(name);
}
function inside(name, code) {
  return docker('exec', name, 'node', '--input-type=module', '-e', code);
}
async function until(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(200);
  }
  throw new Error(`Timed out: ${last?.message || 'condition not met'}`);
}
async function check(name, fn) {
  try {
    const evidence = await fn();
    results.push({ name, passed: true, evidence });
    console.log(`PASS ${name}: ${evidence || ''}`);
  } catch (error) {
    results.push({ name, passed: false, evidence: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
for (const dir of ['config', 'state', 'logs', 'workspace', 'memory', 'fixtures']) {
  fs.mkdirSync(path.join(temp, dir));
  fs.chmodSync(path.join(temp, dir), 0o777);
}
fs.writeFileSync(path.join(temp, 'fixtures', 'dsh.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--patch' && !fs.statSync(args[++i]).isFile()) {
    console.error('patch must be a file'); process.exit(2);
  }
}
console.log(JSON.stringify({type:'session',sessionId:'session-docker-fixture'}));
console.log(JSON.stringify({type:'final',text:'DOCKER_OK'}));
`);
fs.writeFileSync(path.join(temp, 'fixtures', 'model.yml'), '[]\n');
const helper = `${prefix}-onebot`;
const bridge = `${prefix}-bridge`;
const helperCode = `
import http from 'node:http';
import {createFakeNapCat} from '/verify-tests/ws-harness.mjs';
const fake = createFakeNapCat();
await fake.listen(39001);
http.createServer((req,res)=>{
  if (req.url === '/send') fake.sendPrivateMessage({userId:10001,text:'Only reply DOCKER_OK. Do not call any tools.',messageId:Date.now()});
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({connections:fake.state.connections,calls:fake.state.calls}));
}).listen(39002,'0.0.0.0');
`;
const common = [
  '--init',
  '--network', `container:${helper}`, '-e', 'QQ_CONFIG=/config/config.json',
  '-e', 'OWNER_QQ=10001', '-e', 'ADMIN_QQ_IDS=10001',
  '-e', `DSH_COMMAND=${runtimeVolume ? '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' : '/fixtures/dsh.mjs'}`,
  '-e', 'ONE_BOT_URL=ws://127.0.0.1:39001',
  '-e', 'REFLECT_DAILY=false',
  '--mount', `type=volume,source=${homeVolume},target=/home/bridge/.dsh`,
  ...['config', 'state', 'logs', 'memory'].flatMap((dir) => [
    '--mount', `type=bind,source=${path.join(temp, dir)},target=${dir === 'config' ? '/config' : `/app/${dir}`}`,
  ]),
  '--mount', `type=bind,source=${path.join(temp, 'workspace')},target=/app/qq-workspace`,
  '--mount', `type=bind,source=${path.join(temp, 'fixtures')},target=/fixtures,readonly`,
];
const runtimeArgs = runtimeVolume ? [
  '--mount', `type=volume,source=${runtimeVolume},target=/opt/dsh,readonly`,
  '--mount', `type=bind,source=${credentialsFile},target=/run/dsh-credentials.yaml,readonly`,
  '-e', 'DSH_CREDENTIALS_FILE=/run/dsh-credentials.yaml',
  image,
] : [image];
try {
  docker('image', 'inspect', image);
  docker('volume', 'create', '--label', 'qq-dsh-verification=runtime', homeVolume);
  run(helper, ['-p', '127.0.0.1::5830', '-p', '127.0.0.1::39002',
    '--mount', `type=bind,source=${path.join(root, 'tests')},target=/verify-tests,readonly`,
    '--entrypoint', 'node', image, '--input-type=module', '-e', helperCode]);
  const port = (target) => docker('port', helper, `${target}/tcp`).split(':').at(-1);
  const consoleUrl = `http://127.0.0.1:${port(5830)}`;
  const controlUrl = `http://127.0.0.1:${port(39002)}`;
  await until(async () => (await fetch(controlUrl)).ok);
  run(bridge, [...common, ...runtimeArgs]);
  await until(async () => (await (await fetch(controlUrl)).json()).connections > 0);
  await check('container HTTP health endpoint', () => {
    const status = inside(bridge, "console.log((await fetch('http://127.0.0.1:5830/api/overview')).status)");
    assert.equal(status, '200'); return 'HTTP 200 inside container';
  });
  await check('published console port reachable from host', async () => {
    const response = await fetch(`${consoleUrl}/api/overview`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); return consoleUrl;
  });
  await check('bridge state uses the mounted state directory', () => {
    assert.ok(fs.existsSync(path.join(temp, 'state', 'status.json')),
      `/app/state/status.json absent; /config/state/status.json exists=${fs.existsSync(path.join(temp, 'config', 'state', 'status.json'))}`);
    return '/app/state/status.json';
  });
  await check('console reports the connected bridge', () => {
    const overview = JSON.parse(inside(bridge, "console.log(await (await fetch('http://127.0.0.1:5830/api/overview')).text())"));
    assert.equal(overview.data.bridge.connected, true); return 'bridge.connected=true';
  });
  await check('documented JS entry path works without a shell prefix', () => {
    const plan = JSON.parse(inside(bridge, "import {resolveCommandPlan} from './src/dsh.js';console.log(JSON.stringify(resolveCommandPlan('/fixtures/dsh.mjs','/app')))"));
    assert.ok(!plan.error, plan.error); return JSON.stringify(plan);
  });
  await check('default configuration actually disables patches', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(temp, 'config', 'config.json')));
    assert.equal(cfg.dsh.patchPath, '');
    assert.equal(cfg.dsh.mode, 'headless');
    assert.equal(cfg.dsh.companion, false);
    return 'empty patch; subsequent message exercises the real index.js call path';
  });
  await check('container loads bundled plugins from the image', () => {
    const status = JSON.parse(fs.readFileSync(path.join(temp, 'state', 'status.json')));
    assert.equal(status.plugins, 1);
    return 'bundled ping plugin loaded with config outside /app';
  });
  // ponytail: the default fixture needs no credentials; opt in to real model calls.
  await check(`message to bridge to ${runtimeVolume ? 'real' : 'fixture'} DSH to OneBot`, async () => {
    await fetch(`${controlUrl}/send`);
    await until(async () => (await (await fetch(controlUrl)).json()).calls
      .some((call) => call.action === 'send_private_msg' && JSON.stringify(call.params).includes('DOCKER_OK')), 120_000);
    return 'isolated synthetic sender received DOCKER_OK; no real QQ message';
  });
  await check('bridge session bindings persist across container recreation', async () => {
    await until(() => fs.existsSync(path.join(temp, 'state', 'sessions.json')));
    const before = fs.readFileSync(path.join(temp, 'state', 'sessions.json'), 'utf8');
    remove(bridge);
    run(bridge, [...common, ...runtimeArgs]);
    await until(async () => (await (await fetch(controlUrl)).json()).connections >= 2);
    assert.equal(fs.readFileSync(path.join(temp, 'state', 'sessions.json'), 'utf8'), before);
    return before.trim();
  });
  if (runtimeVolume) {
    await check('real DSH conversation resumes after container recreation', async () => {
      const sessions = fs.readFileSync(path.join(temp, 'state', 'sessions.json'), 'utf8');
      const before = (await (await fetch(controlUrl)).json()).calls.length;
      await fetch(`${controlUrl}/send`);
      await until(async () => {
        const calls = (await (await fetch(controlUrl)).json()).calls.slice(before);
        const reply = calls.find((call) => call.action === 'send_private_msg'
          && JSON.stringify(call.params).includes('DOCKER_OK'));
        return Boolean(reply);
      }, 120_000);
      assert.notEqual(sessions.trim(), '{}');
      assert.equal(fs.readFileSync(path.join(temp, 'state', 'sessions.json'), 'utf8'), sessions);
      return 'real model replied using the same persisted session binding';
    });
  }
  await check('DSH home is retained in a Docker volume', () => {
    const mounts = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', bridge));
    assert.ok(mounts.some((mount) => mount.Name === homeVolume && mount.Destination === '/home/bridge/.dsh'));
    if (runtimeVolume) {
      const mode = inside(bridge, "import fs from 'node:fs';console.log((fs.statSync('/home/bridge/.dsh/.credentials.yaml').mode & 0o777).toString(8))");
      assert.equal(mode, '600');
    }
    return runtimeVolume ? 'named volume; credentials mode 600' : 'named volume';
  });
  await check('SIGTERM stops both processes without SIGKILL', () => {
    docker('stop', '-t', '10', bridge);
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', bridge));
    assert.equal(state.ExitCode, 0); return `exit=${state.ExitCode}`;
  });
  await check('bridge stays alive while OneBot is unavailable', async () => {
    const name = `${prefix}-offline`;
    run(name, ['-e', 'OWNER_QQ=10001', '-e', 'ONE_BOT_URL=ws://127.0.0.1:39009',
      '-e', 'REFLECT_DAILY=false', image]);
    await pause(3000);
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.ok(state.Running, `Running=${state.Running}, ExitCode=${state.ExitCode}`);
    return 'still running after connection failure';
  });
  for (const [name, file] of [['console', '/app/src/webui/server.mjs'], ['bridge', '/app/src/index.js']]) {
    await check(`${name} failure stops the container`, async () => {
      docker('start', bridge);
      await until(() => inside(bridge, "console.log((await fetch('http://127.0.0.1:5830/api/overview')).status)") === '200');
      inside(bridge, `
        import fs from 'node:fs';
        const pid = fs.readdirSync('/proc').filter((entry) => /^\\d+$/.test(entry)).find((entry) => {
          try { return fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\\0').includes(${JSON.stringify(file)}); }
          catch { return false; }
        });
        if (!pid) throw new Error('${name} process not found');
        process.kill(Number(pid), 'SIGKILL');
      `);
      await until(() => !JSON.parse(docker('inspect', '--format', '{{json .State}}', bridge)).Running);
      assert.equal(JSON.parse(docker('inspect', '--format', '{{json .State}}', bridge)).ExitCode, 137);
      return 'entrypoint observes either child exiting';
    });
  }
  await check('Linux bind permissions fail clearly instead of running as root', () => {
    const result = spawnSync('docker', ['run', '--rm', '--user', '0', '--entrypoint', 'sh', image, '-c',
      'chmod 755 /config; chown 0:0 /config; su -s /bin/sh bridge -c "QQ_CONFIG=/config/config.json /app/docker/entrypoint.sh"'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uid 10001/);
    return 'uid 10001 receives an actionable write-permission error';
  });
} finally {
  for (const name of containers) {
    try { docker('rm', '-f', name); } catch (error) { console.error(`Cleanup ${name}: ${error.message}`); }
  }
  try { docker('volume', 'rm', homeVolume); } catch (error) { console.error(`Cleanup volume: ${error.message}`); }
  const output = path.join(root, 'state', runtimeVolume ? 'docker-runtime-results.json' : 'docker-fixture-results.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ image, realDsh: Boolean(runtimeVolume), temp, results }, null, 2) + '\n');
  console.log(`Results: ${output}`);
}
console.log(`${results.filter((row) => row.passed).length} passed; ${results.filter((row) => !row.passed).length} failed`);
process.exitCode = results.every((row) => row.passed) ? 0 : 1;
