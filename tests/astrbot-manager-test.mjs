import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAstrbotManager } from '../src/astrbot-manager.mjs';
import {
  assertAstrbotScheduledOrigin, astrbotScheduledOriginEpochs, createAstrbotOutbound,
} from '../src/astrbot-outbound.mjs';

const roots = [];
const checks = [];
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
async function pathExists(file) {
  try { await fs.lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
const dshSecretName = 'DSH_ASTRBOT_LEGACY_SECRET';
const originalDshSecret = process.env[dshSecretName];

function fixtureCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files) {
  const localParts = [];
  const directoryParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const contents = Buffer.from(file.contents, 'utf8');
    const crc = fixtureCrc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    directoryParts.push(central, name);
    offset += local.length + name.length + contents.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

async function createFixture({ installManagedPython, pythonReady = false, runtimeMode = 'managed', externalOnline = false, platform = 'win32', stateDir = 'state', pluginMetadataName = 'sample-plugin' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-astrbot-manager-'));
  roots.push(root);
  const stateRoot = path.resolve(root, stateDir, 'astrbot');
  await fs.mkdir(path.join(root, 'runtime', 'astrbot'), { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'runtime', 'astrbot-lock.json'), JSON.stringify({
    schemaVersion: 1, python: { version: '3.12.10' },
  }));
  await fs.writeFile(path.join(stateRoot, 'policy.json'), JSON.stringify({ enabled: true }));
  if (pythonReady) {
    const privateBasePython = path.join(stateRoot, 'runtime', 'python', 'python.exe');
    const privateVenvPython = path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
    await fs.mkdir(path.dirname(privateBasePython), { recursive: true });
    await fs.mkdir(path.dirname(privateVenvPython), { recursive: true });
    await fs.writeFile(privateBasePython, 'fixture-base-python');
    await fs.writeFile(privateVenvPython, 'fixture-venv-python');
  }
  const events = [];
  const logs = [];
  const generationCalls = [];
  const spawnCalls = [];
  let runtimeOnline = false;
  let runtimeRunning = false;
  if (externalOnline) {
    runtimeOnline = true;
    await fs.writeFile(path.join(stateRoot, 'rpc-token'), 'fixture-external-token-0123456789012345');
  }
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options: { ...options, env: { ...options.env } } });
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.unref = () => {};
    child.kill = (signal) => {
      events.push(`kill:${signal}`);
      child.killed = true;
      child.exitCode = 0;
      runtimeOnline = false;
      runtimeRunning = false;
      setImmediate(() => child.emit('exit', 0, signal));
      return true;
    };
    events.push(`spawn:${events.filter((item) => item.startsWith('spawn:')).length + 1}`);
    runtimeOnline = true;
    runtimeRunning = true;
    return child;
  };
  const fetchImpl = async (_url, options) => {
    if (!runtimeOnline) {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5831'), { code: 'ECONNREFUSED' });
    }
    const request = JSON.parse(options.body);
    generationCalls.push(request);
    let result = request.method === 'health'
      ? { healthy: true, running: runtimeRunning, status: runtimeRunning ? 'running' : 'idle' }
      : { ok: true };
    if (request.method === 'runtime.start') {
      runtimeRunning = true;
      result = { running: true };
    }
    if (request.method === 'runtime.stop') {
      runtimeRunning = false;
      result = { running: false };
    }
    if (request.method === 'generation.freeze') result = { frozen: true };
    if (request.method === 'generation.inspect') {
      const candidate = path.join(stateRoot, ...request.params.candidatePath.split('/'));
      await fs.stat(candidate);
      result = {
        metadataParsed: true,
        astrbotVersion: '4.29.3',
        metadata: {
          name: pluginMetadataName, version: '3.1.5', author: 'fixture',
          display_name: 'Sample plugin', desc: 'fixture plugin',
        },
      };
    }
    if (request.method === 'generation.prepare') {
      const stage = path.join(stateRoot, ...request.params.stagePath.split('/'));
      const staged = JSON.parse(await fs.readFile(path.join(stage, 'manager', 'plugins.json'), 'utf8'));
      result = {
        valid: true,
        metadataParsed: true,
        dependenciesInstalled: true,
        nativeValidated: true,
        coreValidated: true,
        astrbotVersion: '4.29.3',
        dependencySHA256: 'e'.repeat(64),
        pluginCount: Object.keys(staged.plugins).length,
      };
    }
    if (request.method === 'generation.activate') result = { active: true };
    if (request.method === 'generation.resume') result = { resumed: true };
    return new Response(JSON.stringify({ version: 1, id: request.id, result }), { status: 200 });
  };
  const manager = createAstrbotManager({
    projectRoot: root,
    configPath: path.join(root, 'config.json'),
    readConfig: () => ({ stateDir, astrbot: { runtimeUrl: 'http://127.0.0.1:5831', runtimeMode } }),
    logger: (message) => logs.push(String(message)),
    fetchImpl,
    spawnImpl,
    installManagedPython: installManagedPython || (async ({ stateRoot: runtimeState }) => {
      const privateBasePython = path.join(runtimeState, 'runtime', 'python', 'python.exe');
      const privateVenvPython = path.join(runtimeState, 'runtime', 'venv', 'Scripts', 'python.exe');
      await fs.mkdir(path.dirname(privateBasePython), { recursive: true });
      await fs.mkdir(path.dirname(privateVenvPython), { recursive: true });
      await fs.writeFile(privateBasePython, 'fixture-base-python');
      await fs.writeFile(privateVenvPython, 'fixture-venv-python');
    }),
    platform,
    now: (() => { let tick = 0; return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(); })(),
  });
  return { root, stateRoot, manager, events, logs, generationCalls, spawnCalls };
}

async function waitForJob(manager, id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await manager.job(id);
    if (['succeeded', 'failed'].includes(current?.status)) return current;
    await delay();
  }
  throw new Error(`Timed out waiting for AstrBot manager job ${id}`);
}

try {
  let releaseInstall;
  let notifyInstall;
  const installGate = new Promise((resolve) => { releaseInstall = resolve; });
  const installStarted = new Promise((resolve) => { notifyInstall = resolve; });
  const delayed = await createFixture({ installManagedPython: async ({ stateRoot }) => {
    notifyInstall();
    await installGate;
    const privateBasePython = path.join(stateRoot, 'runtime', 'python', 'python.exe');
    const privateVenvPython = path.join(stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
    await fs.mkdir(path.dirname(privateBasePython), { recursive: true });
    await fs.mkdir(path.dirname(privateVenvPython), { recursive: true });
    await fs.writeFile(privateBasePython, 'fixture-base-python');
    await fs.writeFile(privateVenvPython, 'fixture-venv-python');
  } });
  process.env[dshSecretName] = 'must-not-be-inherited';
  const scheduled = delayed.manager.scheduleRuntime({ action: 'start' });
  check('Runtime scheduling returns a job ID synchronously', typeof scheduled?.id === 'string' && !('then' in scheduled));
  check('The scheduled runtime job is immediately pollable', (await delayed.manager.job(scheduled.id))?.status === 'queued');
  await installStarted;
  check('The job stays running while Python setup is pending', (await delayed.manager.job(scheduled.id))?.status === 'running');
  releaseInstall();
  const started = await waitForJob(delayed.manager, scheduled.id);
  check('Runtime start job reaches successful terminal state', started.status === 'succeeded' && started.state === 'succeeded');
  try {
    check('Windows supervisor spawns private base Python with the venv launcher',
      delayed.spawnCalls[0]?.command === path.join(delayed.stateRoot, 'runtime', 'python', 'python.exe')
        && delayed.spawnCalls[0]?.args.join(' ') === '-m qq_astrbot'
        && delayed.spawnCalls[0]?.options.env.__PYVENV_LAUNCHER__
          === path.join(delayed.stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe'));
    check('Windows supervisor does not inherit legacy DSH secrets',
      !Object.hasOwn(delayed.spawnCalls[0]?.options.env || {}, 'DSH_ASTRBOT_LEGACY_SECRET'));
  } finally {
    if (originalDshSecret === undefined) delete process.env[dshSecretName];
    else process.env[dshSecretName] = originalDshSecret;
  }
  check('Runtime job publishes progress, message, and timestamps', started.progress === 100 && Boolean(started.message) && Boolean(started.createdAt && started.startedAt && started.finishedAt));
  let persisted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      persisted = JSON.parse(await fs.readFile(path.join(delayed.root, 'state', 'astrbot', 'jobs', `${scheduled.id}.json`), 'utf8'));
      if (persisted.status === 'succeeded') break;
    } catch { /* the manager persists each job transition atomically */ }
    await delay();
  }
  check('Terminal runtime job is persisted for polling', persisted.status === 'succeeded' && persisted.finishedAt === started.finishedAt);
  await delayed.manager.stop();
  check('Runtime start and stop leave scheduled authorization epochs untouched',
    !(await pathExists(path.join(delayed.stateRoot, 'scheduled-revocations'))));

  const failed = await createFixture({ installManagedPython: async () => {
    throw new Error('bearer secret-value-must-not-leak');
  } });
  const failedJob = failed.manager.scheduleRuntime({ action: 'start' });
  const failure = await waitForJob(failed.manager, failedJob.id);
  check('Python setup failure reaches failed terminal state', failure.status === 'failed');
  check('Public job fields and logs do not expose setup exception text', !JSON.stringify(failure).includes('secret-value-must-not-leak') && failed.logs.every((line) => !line.includes('secret-value-must-not-leak')));

  const restart = await createFixture({ pythonReady: true });
  await restart.manager.start();
  const restartJob = restart.manager.scheduleRuntime({ action: 'restart' });
  const restarted = await waitForJob(restart.manager, restartJob.id);
  check('Runtime restart job reaches successful terminal state', restarted.status === 'succeeded');
  check('Restart stops the prior child before starting a replacement', restart.events.join(',') === 'spawn:1,kill:SIGTERM,spawn:2');
  await restart.manager.stop();
  check('Runtime restart leaves scheduled authorization epochs untouched',
    !(await pathExists(path.join(restart.stateRoot, 'scheduled-revocations'))));

  const missingBase = await createFixture({ pythonReady: true });
  await fs.rm(path.join(missingBase.stateRoot, 'runtime', 'python', 'python.exe'));
  await assert.rejects(missingBase.manager.start(), (error) => error?.code === 'ASTRBOT_RUNTIME_UNAVAILABLE');
  check('Windows managed startup fails closed when its private base Python is missing', missingBase.spawnCalls.length === 0);

  const nonWindows = await createFixture({ pythonReady: true, platform: 'linux' });
  await nonWindows.manager.start();
  check('Non-Windows managed startup keeps using the private venv interpreter',
    nonWindows.spawnCalls[0]?.command === path.join(nonWindows.stateRoot, 'runtime', 'venv', 'Scripts', 'python.exe')
      && !Object.hasOwn(nonWindows.spawnCalls[0]?.options.env || {}, '__PYVENV_LAUNCHER__'));
  await nonWindows.manager.stop();

  const readonly = await createFixture();
  const readonlyState = path.join(readonly.root, 'state', 'astrbot');
  const beforeListing = (await fs.readdir(readonlyState)).sort();
  check('Listing plugins on a fresh state is read-only',
    (await readonly.manager.listPlugins()).length === 0
      && JSON.stringify((await fs.readdir(readonlyState)).sort()) === JSON.stringify(beforeListing));

  const catalog = await createFixture();
  const catalogState = path.join(catalog.root, 'state', 'astrbot');
  const pluginRoot = path.join(catalogState, 'plugins', 'schema-plugin');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, '_conf_schema.json'), JSON.stringify({
    properties: { api_key: { type: 'password', default: 'must-not-be-returned' }, enabled: { type: 'boolean' } },
  }));
  await fs.writeFile(path.join(catalogState, 'plugins.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'schema-plugin': {
        id: 'schema-plugin', source: 'owner/repo', ref: 'v1.2.3',
        sourceSHA256: 'a'.repeat(64), archiveSHA256: 'b'.repeat(64),
        treeSHA256: 'c'.repeat(64), dependencySHA256: 'd'.repeat(64),
        installedAt: '2026-10-30T00:00:00.000Z', enabled: false,
        metadata: { name: 'schema-plugin', version: '1.2.3', author: 'fixture', display_name: 'Schema plugin', desc: 'fixture' },
        config: { api_key: 'stored-secret', enabled: true },
      },
    },
    history: {},
  }));
  const listed = await catalog.manager.listPlugins();
  check('Plugin listing includes bounded parsed schema and safe metadata hashes',
    listed[0]?.configSchema?.properties?.api_key?.type === 'password'
      && !Object.hasOwn(listed[0].configSchema.properties.api_key, 'default')
      && listed[0]?.version === '1.2.3' && listed[0]?.state === 'disabled'
      && listed[0]?.sourceSHA256 === 'a'.repeat(64) && listed[0]?.dependencySHA256 === 'd'.repeat(64));

  const external = await createFixture({ runtimeMode: 'external', externalOnline: true });
  const externalIdleStatus = await external.manager.status();
  check('Healthy idle external supervisor stays available while runtime status remains idle',
    externalIdleStatus.externalHealth === true && externalIdleStatus.running === false
      && externalIdleStatus.external === true);
  const externalStart = await external.manager.start();
  check('Healthy idle external supervisor starts without spawning managed Python',
    externalStart.running === true && externalStart.external === true
      && !external.events.some((event) => event.startsWith('spawn:'))
      && external.generationCalls.some((request) => request.method === 'runtime.start'));
  const externalRunningStatus = await external.manager.status();
  check('External runtime status follows the native running health flag',
    externalRunningStatus.externalHealth === true && externalRunningStatus.running === true
      && externalRunningStatus.external === true);
  await external.manager.stop();
  const externalStoppedStatus = await external.manager.status();
  check('Stopping external runtime clears running while preserving supervisor health',
    externalStoppedStatus.externalHealth === true && externalStoppedStatus.running === false
      && externalStoppedStatus.external === true);

  const generations = await createFixture();
  const oldData = path.join(generations.stateRoot, 'plugin_data', 'legacy', 'preserved.json');
  await fs.mkdir(path.dirname(oldData), { recursive: true });
  await fs.writeFile(oldData, JSON.stringify({ retained: true }));
  const archive = createStoredZip([
    { name: 'sample-plugin/main.py', contents: 'PLUGIN_VERSION = "3.1.5"\n' },
    {
      name: 'sample-plugin/_conf_schema.json',
      contents: JSON.stringify({ properties: { api_key: { type: 'password', default: 'schema-secret' } } }),
    },
  ]);
  const installJob = await generations.manager.install({ zipBase64: archive.toString('base64') });
  const installed = await waitForJob(generations.manager, installJob.id);
  const generationMethods = generations.generationCalls.map((request) => request.method);
  check('Install validates and activates a complete staged generation before succeeding',
    installed.status === 'succeeded'
      && generationMethods.indexOf('generation.freeze') < generationMethods.indexOf('generation.inspect')
      && generationMethods.indexOf('generation.inspect') < generationMethods.indexOf('generation.prepare')
      && generationMethods.indexOf('generation.prepare') < generationMethods.indexOf('generation.activate')
      && generationMethods.indexOf('generation.activate') < generationMethods.indexOf('generation.resume'));
  let pointer = JSON.parse(await fs.readFile(path.join(generations.stateRoot, 'plugins.json'), 'utf8'));
  let activeRoot = path.join(generations.stateRoot, 'generations', pointer.activeGeneration);
  let activeManifest = JSON.parse(await fs.readFile(path.join(activeRoot, 'manager', 'plugins.json'), 'utf8'));
  check('New 3.1.5 plugins default off and retain staged legacy plugin data',
    activeManifest.plugins['sample-plugin']?.metadata?.version === '3.1.5'
      && activeManifest.plugins['sample-plugin']?.enabled === false
      && JSON.parse(await fs.readFile(path.join(activeRoot, 'data', 'plugin_data', 'legacy', 'preserved.json'), 'utf8')).retained === true);

  const configured = await generations.manager.configure('sample-plugin', {
    enabled: true, config: { api_key: 'stored-secret-value', enabled: true },
  });
  pointer = JSON.parse(await fs.readFile(path.join(generations.stateRoot, 'plugins.json'), 'utf8'));
  activeRoot = path.join(generations.stateRoot, 'generations', pointer.activeGeneration);
  activeManifest = JSON.parse(await fs.readFile(path.join(activeRoot, 'manager', 'plugins.json'), 'utf8'));
  check('Configure creates a new validated generation and preserves stored plugin secrets',
    configured.enabled === true && activeManifest.plugins['sample-plugin']?.enabled === true
      && activeManifest.plugins['sample-plugin']?.config?.api_key === 'stored-secret-value'
      && activeManifest.plugins['sample-plugin']?.dependencySHA256 === 'e'.repeat(64));
  const configuredListing = await generations.manager.listPlugins();
  check('Plugin schema output omits secret defaults while preserving the saved config value',
    !Object.hasOwn(configuredListing[0]?.configSchema?.properties?.api_key || {}, 'default')
      && configuredListing[0]?.config?.api_key === 'stored-secret-value');

  const removed = await generations.manager.uninstall('sample-plugin');
  pointer = JSON.parse(await fs.readFile(path.join(generations.stateRoot, 'plugins.json'), 'utf8'));
  activeRoot = path.join(generations.stateRoot, 'generations', pointer.activeGeneration);
  activeManifest = JSON.parse(await fs.readFile(path.join(activeRoot, 'manager', 'plugins.json'), 'utf8'));
  check('Uninstall stages dependency validation and keeps plugin data unless purge is requested',
    removed.uninstalled === true && Object.keys(activeManifest.plugins).length === 0
      && JSON.parse(await fs.readFile(path.join(activeRoot, 'data', 'plugin_data', 'legacy', 'preserved.json'), 'utf8')).retained === true);
  const invalidationRoot = await createFixture({ stateDir: 'configured-state', pluginMetadataName: 'astrbot_plugin_weather' });
  const weatherId = 'astrbot_plugin_weather';
  const weatherArchive = createStoredZip([
    { name: `${weatherId}/main.py`, contents: 'PLUGIN_VERSION = "3.1.5"\n' },
  ]);
  const weatherInstallJob = await invalidationRoot.manager.install({ zipBase64: weatherArchive.toString('base64') });
  const weatherInstalled = await waitForJob(invalidationRoot.manager, weatherInstallJob.id);
  check('Install writes a targeted authorization epoch under the configured state/astrbot root',
    weatherInstalled.status === 'succeeded'
      && JSON.parse(await fs.readFile(path.join(invalidationRoot.stateRoot, 'scheduled-revocations', `${weatherId}.json`), 'utf8')).reason === 'install'
      && !(await pathExists(path.join(invalidationRoot.root, 'state', 'astrbot', 'scheduled-revocations'))));
  let weatherPointer = JSON.parse(await fs.readFile(path.join(invalidationRoot.stateRoot, 'plugins.json'), 'utf8'));
  let weatherGenerationRoot = path.join(invalidationRoot.stateRoot, 'generations', weatherPointer.activeGeneration);
  let weatherManifest = JSON.parse(await fs.readFile(path.join(weatherGenerationRoot, 'manager', 'plugins.json'), 'utf8'));
  const weatherDigest = 'd149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30';
  weatherManifest.plugins[weatherId].sourceSHA256 = weatherDigest;
  weatherManifest.plugins[weatherId].archiveSHA256 = weatherDigest;
  await fs.writeFile(path.join(weatherGenerationRoot, 'manager', 'plugins.json'), JSON.stringify(weatherManifest, null, 2));
  await invalidationRoot.manager.configure(weatherId, { enabled: true });
  check('Configure records its targeted invalidation reason',
    JSON.parse(await fs.readFile(path.join(invalidationRoot.stateRoot, 'scheduled-revocations', `${weatherId}.json`), 'utf8')).reason === 'configure');
  const outbound = createAstrbotOutbound({
    root: invalidationRoot.stateRoot,
    readConfig: () => ({ security: { denyFrom: [] } }),
    getPolicy: async () => ({ enabled: true, groups: {} }),
  });
  const privateTarget = { kind: 'private', id: '10001' };
  const weatherEpochs = await astrbotScheduledOriginEpochs(invalidationRoot.stateRoot, [weatherId]);
  const firstGrant = await outbound.create({ pluginId: weatherId, purpose: 'weather.daily', target: privateTarget });
  check('A new weather grant and reminder origin are initially authorized', firstGrant.active
    && (await outbound.authorize({ pluginId: weatherId, purpose: 'weather.daily', target: privateTarget, sourceSHA256: weatherDigest })).grantId === firstGrant.id
    && await assertAstrbotScheduledOrigin({ root: invalidationRoot.stateRoot, pluginId: weatherId, context: { scheduledAuthorization: weatherEpochs } }) === undefined);
  await invalidationRoot.manager.configure(weatherId, { enabled: false });
  const firstGrantAfterDisable = (await outbound.list()).find((grant) => grant.id === firstGrant.id);
  await assert.rejects(assertAstrbotScheduledOrigin({
    root: invalidationRoot.stateRoot, pluginId: weatherId, context: { scheduledAuthorization: weatherEpochs },
  }), (error) => error?.code === 'ASTRBOT_SCHEDULED_ORIGIN_REVOKED');
  check('Disabling a plugin permanently revokes its existing grant and reminder context',
    firstGrantAfterDisable?.reason === 'revoked');
  await invalidationRoot.manager.configure(weatherId, { enabled: true });
  const firstGrantAfterReenable = (await outbound.list()).find((grant) => grant.id === firstGrant.id);
  await assert.rejects(outbound.authorize({
    pluginId: weatherId, purpose: 'weather.daily', target: privateTarget, sourceSHA256: weatherDigest,
  }), (error) => error?.code === 'ASTRBOT_OUTBOUND_PERMISSION_DENIED');
  check('Re-enabling the plugin does not revive an old weather grant', firstGrantAfterReenable?.reason === 'revoked');
  const rollbackEpochs = await astrbotScheduledOriginEpochs(invalidationRoot.stateRoot, [weatherId]);
  const rollbackGrant = await outbound.create({ pluginId: weatherId, purpose: 'weather.daily', target: privateTarget });
  check('A fresh grant is authorized before full-environment rollback', rollbackGrant.active);
  await invalidationRoot.manager.rollback(weatherId);
  const rollbackMarker = JSON.parse(await fs.readFile(
    path.join(invalidationRoot.stateRoot, 'scheduled-revocations', '__all__.json'), 'utf8'));
  const rolledBackGrants = await outbound.list();
  const rollbackGrantAfter = rolledBackGrants.find((grant) => grant.id === rollbackGrant.id);
  weatherPointer = JSON.parse(await fs.readFile(path.join(invalidationRoot.stateRoot, 'plugins.json'), 'utf8'));
  weatherGenerationRoot = path.join(invalidationRoot.stateRoot, 'generations', weatherPointer.activeGeneration);
  await assert.rejects(assertAstrbotScheduledOrigin({
    root: invalidationRoot.stateRoot, pluginId: weatherId, context: { scheduledAuthorization: rollbackEpochs },
  }), (error) => error?.code === 'ASTRBOT_SCHEDULED_ORIGIN_REVOKED');
  check('Rollback leaves a global revocation epoch outside restored generation snapshots',
    rollbackMarker.reason === 'rollback' && rollbackGrantAfter?.reason === 'revoked'
      && await pathExists(path.join(invalidationRoot.stateRoot, 'outbound-grants', `${rollbackGrant.id}.json`))
      && !(await pathExists(path.join(weatherGenerationRoot, 'scheduled-revocations'))));
  await invalidationRoot.manager.configure(weatherId, { enabled: true });
  const uninstallEpochs = await astrbotScheduledOriginEpochs(invalidationRoot.stateRoot, [weatherId]);
  const uninstallGrant = await outbound.create({ pluginId: weatherId, purpose: 'weather.daily', target: privateTarget });
  const weatherRemoved = await invalidationRoot.manager.uninstall(weatherId);
  await assert.rejects(assertAstrbotScheduledOrigin({
    root: invalidationRoot.stateRoot, pluginId: weatherId, context: { scheduledAuthorization: uninstallEpochs },
  }), (error) => error?.code === 'ASTRBOT_SCHEDULED_ORIGIN_REVOKED');
  check('Uninstall permanently revokes plugin grants before removing the plugin',
    weatherRemoved.uninstalled === true
      && JSON.parse(await fs.readFile(path.join(invalidationRoot.stateRoot, 'scheduled-revocations', `${weatherId}.json`), 'utf8')).reason === 'uninstall'
      && (await outbound.list()).find((grant) => grant.id === uninstallGrant.id)?.reason === 'revoked');

  const failClosed = await createFixture({ pluginMetadataName: weatherId });
  const failClosedJob = await failClosed.manager.install({ zipBase64: weatherArchive.toString('base64') });
  check('Fail-closed fixture installs its isolated plugin', (await waitForJob(failClosed.manager, failClosedJob.id)).status === 'succeeded');
  await failClosed.manager.configure(weatherId, { enabled: true });
  const beforeFailClosed = await fs.readFile(path.join(failClosed.stateRoot, 'plugins.json'), 'utf8');
  const freezeCountBeforeInvalidationFailure = failClosed.generationCalls.filter((request) => request.method === 'generation.freeze').length;
  const revocationsDirectory = path.join(failClosed.stateRoot, 'scheduled-revocations');
  await fs.rm(revocationsDirectory, { recursive: true, force: true });
  await fs.writeFile(revocationsDirectory, 'blocked storage path');
  await assert.rejects(failClosed.manager.configure(weatherId, { enabled: false }));
  check('Authorization storage errors fail closed before freezing or changing the generation',
    await fs.readFile(path.join(failClosed.stateRoot, 'plugins.json'), 'utf8') === beforeFailClosed
      && failClosed.generationCalls.filter((request) => request.method === 'generation.freeze').length === freezeCountBeforeInvalidationFailure);
  await assert.rejects(generations.manager.configure('__ai__', {}),
    (error) => error?.code === 'ASTRBOT_BAD_PLUGIN_ID');
  await assert.rejects(generations.manager.configure('__all__', {}),
    (error) => error?.code === 'ASTRBOT_BAD_PLUGIN_ID');
  check('Reserved internal plugin identifiers are rejected', true);
  console.log(`AstrBot manager lifecycle checks ${checks.length}, fail 0`);
} finally {
  if (originalDshSecret === undefined) delete process.env[dshSecretName];
  else process.env[dshSecretName] = originalDshSecret;
  for (const root of roots) {
    const resolved = await fs.realpath(root);
    assert.ok(path.relative(os.tmpdir(), resolved).startsWith('qq-astrbot-manager-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
}
