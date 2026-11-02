// Bounded live QQ acceptance runner. Opt in with ASTRBOT_QQ_LIVE_TEST=1.
// It dispatches only real OneBot events from the two approved destinations and
// records metadata only; message bodies and credentials are never logged.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OPT_IN = process.env.ASTRBOT_QQ_LIVE_TEST === '1';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_STATE_DIR = path.resolve('/app/state');
const CONFIG_PATH = path.resolve('/run/qq-live-config.json');
const CALLBACK_URL = 'http://qq-acceptance:5832/rpc/callback';
const CALLBACK_HOST = '0.0.0.0';
const CALLBACK_PORT = 5832;
const WAIT_MS = 15 * 60 * 1000;
const MAX_QQ_MEDIA_BYTES = 8 * 1024 * 1024;
const MEDIA_TRANSPORT = 'isolated-cache-to-base64';
const PRIVATE_ID = String(process.env.ASTRBOT_QQ_PRIVATE_ID || '').trim();
const GROUP_ID = String(process.env.ASTRBOT_QQ_GROUP_ID || '').trim();
const FIXTURE_ID = 'qq_boundary_fixture';
const FIXTURE_MAIN_PATH = path.join(APP_ROOT, 'tests', 'fixtures', 'astrbot_plugin_boundary', 'main.py');
const FIXTURE_METADATA_PATH = path.join(APP_ROOT, 'tests', 'fixtures', 'astrbot_plugin_boundary', 'metadata.yaml');
const MARKER_PATH = path.join(EXPECTED_STATE_DIR, '.astrbot-acceptance-only');
const JOURNAL_PATH = path.join(EXPECTED_STATE_DIR, 'qq-live-result.json');
const FIXTURE_MAIN_SHA256 = 'ea8590d3cef39dc7ff928d4f00cfc998f5ad3359e1534b70aeee9210741a6a96';
const FIXTURE_METADATA_SHA256 = '43effbb0555a0ac9327fb6d3377bc7a1a46151ce7b80a9a053099b004a11d3b2';
const FIXTURE_ARCHIVE_SHA256 = 'b9dacc725d74d7970ff2b00a3d979465653a01a97361bf35b23e8b33644528c2';
const COMMANDS = ['ast_echo', 'ast_image', 'ast_voice', 'ast_timer'];
const CHANNELS = {
  private: { id: PRIVATE_ID, action: 'send_private_msg', targetField: 'user_id' },
  group: { id: GROUP_ID, action: 'send_group_msg', targetField: 'group_id' },
};
const REQUIRED_RECEIPTS = {
  ast_echo: ['reply'],
  ast_image: ['image'],
  ast_voice: ['record'],
  ast_timer: ['scheduled', 'fired'],
};
const SAFE_ONEBOT_NETWORK_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'EPROTO', 'ETIMEDOUT',
  'ERR_INVALID_URL', 'ERR_SOCKET_BAD_PORT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const SAFE_ERROR_CLASSES = new Set([
  'AbortError', 'DOMException', 'Error', 'NetworkError', 'SyntaxError',
  'TimeoutError', 'TypeError',
]);

function acceptanceError(code) {
  return Object.assign(new Error(code), { code });
}

function requireThat(value, code) {
  if (!value) throw acceptanceError(code);
}

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(code)
    ? code : 'ASTRBOT_QQ_LIVE_OPERATION_FAILED';
}

function safeOneBotFailure(event, error) {
  const errorClass = String(error?.name || '');
  const closeCodeMatch = typeof error?.message === 'string'
    ? /^WebSocket 连接已关闭（code=(\d{3})）$/.exec(error.message) : null;
  return {
    event,
    at: isoNow(),
    errorClass: SAFE_ERROR_CLASSES.has(errorClass) ? errorClass : null,
    nativeCode: safeOneBotNetworkCode(error),
    closeCode: closeCodeMatch ? Number(closeCodeMatch[1]) : null,
  };
}

function safeOneBotNetworkCode(error) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; current && depth < 5 && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = String(current.code || '');
    if (SAFE_ONEBOT_NETWORK_CODES.has(code)) return code;
    current = current.cause;
  }
  return null;
}

function attachOneBotDiagnostics(bot, journal) {
  const diagnostics = journal.onebot;
  bot.on('ready', () => {
    diagnostics.readyEvents += 1;
    diagnostics.connected = Boolean(bot.connected);
    if (diagnostics.connected) {
      diagnostics.lastReadyAt = isoNow();
      journal.readiness.onebotWebSocket = true;
    }
  });
  bot.on('error', (error) => {
    diagnostics.errorEvents += 1;
    diagnostics.connected = Boolean(bot.connected);
    diagnostics.lastFailure = safeOneBotFailure('error', error);
  });
  bot.on('disconnect', (error) => {
    diagnostics.disconnectEvents += 1;
    diagnostics.connected = Boolean(bot.connected);
    if (!diagnostics.connected) journal.readiness.onebotWebSocket = false;
    diagnostics.lastDisconnect = safeOneBotFailure('disconnect', error);
    if (error) diagnostics.lastFailure = diagnostics.lastDisconnect;
  });
}

function isoNow() {
  return new Date().toISOString();
}

function newTestCases() {
  const result = {};
  for (const channel of Object.keys(CHANNELS)) {
    for (const command of COMMANDS) {
      result[channel + '/' + command] = {
        status: 'waiting_for_incoming',
        incomingCount: 0,
        exactTimerCount: 0,
        handledCount: 0,
        dispatchStatus: 'not_seen',
        receipts: [],
      };
    }
  }
  return result;
}

async function main() {
  let journal = null;
  let journalQueue = Promise.resolve();
  let policy = null;
  let bridge = null;
  let manager = null;
  let bot = null;
  let onMessage = null;
  let dispatchQueue = Promise.resolve();
  let activeDispatchChannel = null;
  let controller = new AbortController();
  let managerMayBeRunning = false;
  let accepting = false;
  let stopReason = null;
  let timedOut = false;
  let stateDir = EXPECTED_STATE_DIR;

  function persistJournal() {
    if (!journal) return Promise.resolve();
    const operation = journalQueue.catch(() => {}).then(async () => {
      const temporary = JOURNAL_PATH + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(journal), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, JOURNAL_PATH);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    journalQueue = operation;
    return operation;
  }

  function recordSendFailure(stage, channel, error) {
    if (!journal) return Promise.resolve();
    const failure = {
      stage,
      channel: ['private', 'group'].includes(channel) ? channel : null,
      code: safeErrorCode(error),
      nativeCode: safeOneBotNetworkCode(error),
      at: isoNow(),
    };
    if (journal.sendFailures.length < 256) journal.sendFailures.push(failure);
    else journal.sendFailureOverflow += 1;
    return persistJournal();
  }

  function stop(signalName) {
    if (stopReason) return;
    stopReason = signalName;
    accepting = false;
    controller.abort(acceptanceError('ASTRBOT_QQ_LIVE_STOP_REQUESTED'));
  }

  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  try {
    requireThat(/^[1-9][0-9]{4,19}$/.test(PRIVATE_ID)
      && /^[1-9][0-9]{4,19}$/.test(GROUP_ID), 'ASTRBOT_QQ_LIVE_TARGET_INVALID');
    const configuredState = requiredEnv('ASTRBOT_QQ_STATE_DIR');
    stateDir = path.resolve(configuredState);
    requireThat(stateDir === EXPECTED_STATE_DIR, 'ASTRBOT_QQ_LIVE_STATE_DIR_INVALID');
    const configPath = requiredEnv('ASTRBOT_QQ_CONFIG');
    requireThat(path.resolve(configPath) === CONFIG_PATH, 'ASTRBOT_QQ_LIVE_CONFIG_PATH_INVALID');
    requireThat(requiredEnv('ASTRBOT_RUNTIME_MODE') === 'external', 'ASTRBOT_QQ_LIVE_EXTERNAL_MODE_REQUIRED');
    const runtimeUrl = validateRuntimeUrl(requiredEnv('ASTRBOT_RUNTIME_URL'));

    await validateRegularFile(MARKER_PATH, 'ASTRBOT_QQ_LIVE_MARKER_REQUIRED');
    await validateRegularFile(FIXTURE_MAIN_PATH, 'ASTRBOT_QQ_LIVE_FIXTURE_MAIN_REQUIRED');
    await validateRegularFile(FIXTURE_METADATA_PATH, 'ASTRBOT_QQ_LIVE_FIXTURE_METADATA_REQUIRED');
    const fixtureMain = await readVerifiedFixtureSource(
      FIXTURE_MAIN_PATH, FIXTURE_MAIN_SHA256, 'ASTRBOT_QQ_LIVE_FIXTURE_MAIN_HASH_INVALID');
    const fixtureMetadata = await readVerifiedFixtureSource(
      FIXTURE_METADATA_PATH, FIXTURE_METADATA_SHA256, 'ASTRBOT_QQ_LIVE_FIXTURE_METADATA_HASH_INVALID');
    const fixture = buildFixtureZip(fixtureMain, fixtureMetadata);
    const fixtureHash = createHash('sha256').update(fixture).digest('hex');
    requireThat(fixture.length === 13036 && fixtureHash === FIXTURE_ARCHIVE_SHA256,
      'ASTRBOT_QQ_LIVE_FIXTURE_ARCHIVE_INVALID');
    const existingJournal = await fs.lstat(JOURNAL_PATH).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw acceptanceError('ASTRBOT_QQ_LIVE_JOURNAL_UNREADABLE');
    });
    requireThat(!existingJournal || (existingJournal.isFile() && !existingJournal.isSymbolicLink()),
      'ASTRBOT_QQ_LIVE_JOURNAL_UNSAFE');

    const productionConfig = await readProductionConfig(configPath);
    requireThat(Array.isArray(productionConfig.security?.adminUserIds)
      && productionConfig.security.adminUserIds.some((id) => String(id) === PRIVATE_ID),
    'ASTRBOT_QQ_LIVE_PRIVATE_ADMIN_REQUIRED');
    const [{ isAdministrator, isAllowed, isGroupWatched }, { OneBot },
      { createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge }] = await Promise.all([
      import('../src/security.js'),
      import('../src/onebot.js'),
      import('../src/astrbot-manager.mjs'),
      import('../src/astrbot-policy.mjs'),
      import('../src/astrbot-bridge.mjs'),
    ]);
    requireThat(isAdministrator(PRIVATE_ID, productionConfig)
      && isAllowed(PRIVATE_ID, productionConfig), 'ASTRBOT_QQ_LIVE_PRIVATE_NOT_ALLOWED');
    requireThat(productionConfig.security?.allowGroups === true
      && isGroupWatched(GROUP_ID, productionConfig), 'ASTRBOT_QQ_LIVE_GROUP_NOT_ALLOWED');
    requireThat(productionConfig.onebot && typeof productionConfig.onebot.url === 'string'
      && /^wss?:\/\//i.test(productionConfig.onebot.url), 'ASTRBOT_QQ_LIVE_ONEBOT_URL_INVALID');
    requireThat(productionConfig.onebot.accessToken === undefined
      || typeof productionConfig.onebot.accessToken === 'string', 'ASTRBOT_QQ_LIVE_ONEBOT_TOKEN_INVALID');

    const config = structuredClone(productionConfig);
    config.stateDir = stateDir;
    config.files = {
      ...(config.files || {}),
      mappings: [],
      allowedRoots: [],
      napcatStateDir: stateDir,
    };
    if (config.stickers && typeof config.stickers === 'object' && !Array.isArray(config.stickers)) {
      config.stickers = { ...config.stickers, allowedRoots: [] };
    }
    config.astrbot = {
      ...(config.astrbot || {}),
      runtimeMode: 'external',
      runtimeUrl,
      callbackUrl: CALLBACK_URL,
    };
    delete config.astrbot.token;
    const readConfig = () => config;

    journal = {
      schemaVersion: 1,
      runStatus: 'starting',
      ready: false,
      startedAt: isoNow(),
      readyAt: null,
      readiness: { runtime: false, callback: false, onebotWebSocket: false, loginIdentity: false },
      onebot: {
        connected: false,
        readyEvents: 0,
        errorEvents: 0,
        disconnectEvents: 0,
        lastReadyAt: null,
        lastFailure: null,
        lastDisconnect: null,
      },
      fixture: {
        pluginId: FIXTURE_ID,
        sourceSha256: { main: FIXTURE_MAIN_SHA256, metadata: FIXTURE_METADATA_SHA256 },
        archiveSha256: fixtureHash,
        archiveBytes: fixture.length,
        verified: true,
        installed: false,
      },
      model: { implementation: 'node-controlled-fixture-stub', realDshProof: false },
      mediaTransport: MEDIA_TRANSPORT,
      incoming: [],
      incomingOverflow: 0,
      sends: [],
      sendOverflow: 0,
      sendFailures: [],
      sendFailureOverflow: 0,
      testCases: newTestCases(),
      missingTests: [],
      errorCode: null,
      cleanup: {
        onebotClosed: false,
        policyDisabled: false,
        runtimeStopped: false,
        bridgeStopped: false,
        errors: [],
      },
    };
    await persistJournal();

    policy = createAstrbotPolicy({ root: APP_ROOT, readConfig });
    manager = createAstrbotManager({
      projectRoot: APP_ROOT,
      configPath,
      readConfig,
      logger: () => {},
    });
    await policy.setEnabled(false);
    await manager.getToken({ create: false });

    bridge = createAstrbotBridge({
      root: APP_ROOT,
      readConfig,
      policy,
      manager,
      host: CALLBACK_HOST,
      port: CALLBACK_PORT,
      logger: {
        warn(message) {
          const match = /^AstrBot callback: (ASTRBOT_[A-Z0-9_]{1,64})$/.exec(String(message));
          if (match) {
            void recordSendFailure('bridge-callback', activeDispatchChannel,
              Object.assign(new Error(match[1]), { code: match[1] })).catch(() => {});
          }
        },
        info() {},
        error() {},
      },
      send: (action, params) => sendThroughOneBot(action, params, true),
      generate: async () => ({
        id: 'qq-live-controlled-stub',
        object: 'chat.completion',
        created: 0,
        model: 'qq-live-controlled-stub',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'controlled-qq-live-fixture-stub' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const callbackAddress = await bridge.start();
    requireThat(callbackAddress?.address === CALLBACK_HOST && callbackAddress.port === CALLBACK_PORT,
      'ASTRBOT_QQ_LIVE_CALLBACK_BIND_INVALID');
    journal.readiness.callback = true;

    managerMayBeRunning = true;
    const started = await manager.start();
    requireThat(started?.running === true && started?.external === true,
      'ASTRBOT_QQ_LIVE_RUNTIME_START_FAILED');
    journal.readiness.runtime = true;

    const existingPlugins = await manager.listPlugins();
    requireThat(existingPlugins.every((item) => item.id === FIXTURE_ID || item.enabled !== true),
      'ASTRBOT_QQ_LIVE_UNEXPECTED_PLUGIN_ENABLED');
    const previous = existingPlugins.find((item) => item.id === FIXTURE_ID);
    if (previous?.enabled === true) await manager.configure(FIXTURE_ID, { enabled: false });
    const install = await manager.install({ zipBase64: fixture.toString('base64') });
    await waitForInstall(manager, install.id);
    const installed = (await manager.listPlugins()).find((item) => item.id === FIXTURE_ID);
    requireThat(installed && installed.enabled === false, 'ASTRBOT_QQ_LIVE_FIXTURE_INSTALL_INVALID');
    await manager.configure(FIXTURE_ID, { enabled: true });
    const enabled = (await manager.listPlugins()).find((item) => item.id === FIXTURE_ID);
    requireThat(enabled?.enabled === true, 'ASTRBOT_QQ_LIVE_FIXTURE_ENABLE_FAILED');
    journal.fixture.installed = true;

    await policy.setGroup(GROUP_ID, { pluginIds: [FIXTURE_ID], chatMode: 'dsh' });
    await policy.setEnabled(true);

    bot = new OneBot({
      url: productionConfig.onebot.url,
      accessToken: productionConfig.onebot.accessToken || '',
      reconnect: true,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    attachOneBotDiagnostics(bot, journal);
    await waitForOneBot(bot, 30_000);
    requireThat(bot.connected, 'ASTRBOT_QQ_LIVE_ONEBOT_DISCONNECTED');
    journal.readiness.onebotWebSocket = true;
    const login = await bot.call('get_login_info', {}, { timeoutMs: 15_000 });
    const selfId = String(login?.user_id ?? '');
    requireThat(/^[1-9]\d{0,19}$/.test(selfId), 'ASTRBOT_QQ_LIVE_LOGIN_ID_INVALID');
    journal.readiness.loginIdentity = true;

    onMessage = (message) => {
      if (!accepting || !message || typeof message !== 'object'
          || message.raw?.post_type !== 'message'
          || !['private', 'group'].includes(message.raw?.message_type)) return;
      const channel = message.raw.message_type === 'group' ? 'group' : 'private';
      if (message.messageType !== channel) return;
      const targetId = String(channel === 'group' ? message.groupId : message.userId);
      if (targetId !== CHANNELS[channel].id) return;
      const senderId = String(message.userId);
      if (senderId === selfId || (channel === 'group' && senderId !== PRIVATE_ID)) return;
      const text = typeof message.text === 'string' ? message.text : '';
      if (!text.startsWith('/ast_')) return;

      const commandMatch = /^\/(ast_[A-Za-z0-9_]{1,48})(?:$|\s)/.exec(text);
      const command = commandMatch ? commandMatch[1].toLowerCase() : 'ast_other';
      const known = COMMANDS.includes(command);
      const exactTimer = command === 'ast_timer' && /^\/ast_timer\s+3\s+qq-test\s*$/.test(text);
      if (journal.incoming.length < 256) {
        journal.incoming.push({ type: channel, command, at: isoNow() });
      } else {
        journal.incomingOverflow += 1;
      }
      const testCase = known ? journal.testCases[channel + '/' + command] : null;
      if (testCase) {
        testCase.incomingCount += 1;
        if (exactTimer) testCase.exactTimerCount += 1;
        refreshCaseStatus(testCase, command);
      }
      void persistJournal();

    dispatchQueue = dispatchQueue.catch(() => {}).then(async () => {
        if (controller.signal.aborted) return;
      activeDispatchChannel = channel;
        try {
          const result = await bridge.dispatch(message, { signal: controller.signal });
          if (testCase) {
            const status = ['handled', 'failed', 'unhandled', 'duplicate'].includes(result?.status)
              ? result.status : 'invalid';
            testCase.dispatchStatus = status;
            if (status === 'handled') {
              testCase.handledCount += 1;
            }
            refreshCaseStatus(testCase, command);
          }
        } catch (error) {
          if (testCase) {
            testCase.dispatchStatus = 'error';
            testCase.lastErrorCode = safeErrorCode(error);
            refreshCaseStatus(testCase, command);
          }
        } finally {
        if (activeDispatchChannel === channel) activeDispatchChannel = null;
        }
        await persistJournal();
      });
    };
    bot.on('message', onMessage);

    journal.ready = true;
    journal.runStatus = 'ready';
    journal.readyAt = isoNow();
    await persistJournal();
    console.log(JSON.stringify({
      event: 'READY',
      privateTarget: PRIVATE_ID,
      groupTarget: GROUP_ID,
      listenMinutes: 15,
      commands: ['/ast_echo', '/ast_image', '/ast_voice', '/ast_timer 3 qq-test'],
      modelStub: true,
      realDshProof: false,
      mediaTransport: MEDIA_TRANSPORT,
    }));
    accepting = true;

    const deadline = Date.now() + WAIT_MS;
    while (!stopReason && !allCasesPassed(journal) && Date.now() < deadline) {
      await delay(Math.min(500, Math.max(1, deadline - Date.now())));
    }
    accepting = false;
    if (!stopReason && !allCasesPassed(journal)) {
      timedOut = true;
      stopReason = 'TIMEOUT';
      controller.abort(acceptanceError('ASTRBOT_QQ_LIVE_TIMEOUT'));
    }
    await dispatchQueue.catch(() => {});
    journal.missingTests = missingTests(journal);
    if (allCasesPassed(journal)) {
      journal.runStatus = 'passed';
    } else if (timedOut) {
      journal.runStatus = 'incomplete';
    } else {
      journal.runStatus = 'interrupted';
    }
    journal.finishedAt = isoNow();
    await persistJournal();
  } catch (error) {
    if (journal) {
      journal.runStatus = stopReason ? 'interrupted' : 'failed';
      journal.errorCode = safeErrorCode(error);
      journal.missingTests = missingTests(journal);
      journal.finishedAt = isoNow();
      await persistJournal().catch(() => {});
    }
    const sourceLocation = String(error?.stack ?? '').match(/astrbot-qq-live\.mjs:(\d+):(\d+)/);
    console.log(JSON.stringify({ event: 'FAILED', code: safeErrorCode(error),
      errorClass: SAFE_ERROR_CLASSES.has(String(error?.name || '')) ? error.name : null,
      nativeCode: safeOneBotNetworkCode(error),
      readiness: journal?.readiness || null,
      onebot: journal?.onebot || null,
      sourceLocation: sourceLocation ? `${sourceLocation[1]}:${sourceLocation[2]}` : null }));
  } finally {
    accepting = false;
    if (bot && onMessage) bot.off('message', onMessage);
    if (bot) {
      try { bot.close(); } catch { /* Cleanup continues. */ }
      if (journal) journal.cleanup.onebotClosed = true;
    }
    if (!controller.signal.aborted) controller.abort(acceptanceError('ASTRBOT_QQ_LIVE_CLEANUP'));
    await dispatchQueue.catch(() => {});

    if (policy) {
      try {
        await policy.setEnabled(false);
        if (journal) journal.cleanup.policyDisabled = true;
      } catch (error) {
        recordCleanupError(journal, error);
      }
    }
    if (manager && managerMayBeRunning) {
      try {
        const stopped = await manager.stop();
        if (journal) journal.cleanup.runtimeStopped = stopped?.stopped === true;
      } catch (error) {
        recordCleanupError(journal, error);
      }
    }
    if (bridge) {
      try {
        await bridge.stop();
        if (journal) journal.cleanup.bridgeStopped = true;
      } catch (error) {
        recordCleanupError(journal, error);
      }
    }

    if (journal) {
      journal.missingTests = missingTests(journal);
      if (journal.cleanup.errors.length && journal.runStatus === 'passed') {
        journal.runStatus = 'failed';
        journal.errorCode = 'ASTRBOT_QQ_LIVE_CLEANUP_FAILED';
      }
      await persistJournal().catch(() => {});
      console.log(JSON.stringify({
        event: 'RESULT',
        status: journal.runStatus,
        missingTests: journal.missingTests,
        cleanupErrors: journal.cleanup.errors,
        modelStub: true,
        realDshProof: false,
        mediaTransport: MEDIA_TRANSPORT,
        journal: JOURNAL_PATH,
      }));
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    if (journal?.runStatus !== 'passed') process.exitCode = 1;
  }

  async function sendThroughOneBot(action, params, classify) {
    let channel;
    let stage = 'action-validation';
    try {
      requireThat(bot && bot.connected, 'ASTRBOT_QQ_LIVE_ONEBOT_DISCONNECTED');
      if (action === 'send_private_msg') channel = 'private';
      else if (action === 'send_group_msg') channel = 'group';
      else throw acceptanceError('ASTRBOT_QQ_LIVE_OUTBOUND_ACTION_DENIED');
      const spec = CHANNELS[channel];
      requireThat(String(params?.[spec.targetField] ?? '') === spec.id,
        'ASTRBOT_QQ_LIVE_OUTBOUND_TARGET_DENIED');
      requireThat(params && typeof params === 'object' && !Array.isArray(params)
        && Object.keys(params).every((key) => key === spec.targetField || key === 'message'),
      'ASTRBOT_QQ_LIVE_OUTBOUND_TARGET_DENIED');

      const parts = Array.isArray(params.message) ? params.message
        : typeof params.message === 'string' ? [{ type: 'text', data: { text: params.message } }] : null;
      requireThat(parts && parts.length > 0, 'ASTRBOT_QQ_LIVE_OUTBOUND_MESSAGE_INVALID');
      stage = 'media-adapter';
      const adapted = await adaptOutboundSegments(parts, stateDir);
      const segmentTypes = adapted.message.map((part) => part.type);
      const text = adapted.message.filter((part) => part.type === 'text')
        .map((part) => part.data.text).join('');
      stage = 'onebot-send';
      const acknowledgment = await bot.call(action, {
        ...params,
        message: adapted.message,
      }, { timeoutMs: 30_000 });
      stage = 'ack-validation';
      const rawId = acknowledgment?.message_id;
      const validId = typeof rawId === 'number'
        ? Number.isSafeInteger(rawId) && rawId !== 0
        : typeof rawId === 'string' && /^-?[0-9]{1,32}$/.test(rawId) && !/^-?0+$/.test(rawId);
      requireThat(validId, 'ASTRBOT_QQ_LIVE_SEND_ACK_INVALID');
      const id = String(rawId);

      if (journal.sends.length < 512) {
        journal.sends.push({
          id,
          target: spec.id,
          type: channel,
          segmentTypes,
          mediaMimes: adapted.mediaMimes,
          mediaTransport: adapted.mediaMimes.length ? MEDIA_TRANSPORT : null,
        });
      } else {
        journal.sendOverflow += 1;
      }
      if (classify) classifyReceipt(journal, channel, text, segmentTypes);
      await persistJournal();
      return acknowledgment;
    } catch (error) {
      await recordSendFailure(stage, channel, error).catch(() => {});
      throw error;
    }
  }
}

async function adaptOutboundSegments(parts, stateDir) {
  requireThat(Array.isArray(parts) && parts.length > 0 && parts.length <= 100,
    'ASTRBOT_QQ_LIVE_OUTBOUND_MESSAGE_INVALID');
  const stateRoot = await fs.realpath(stateDir).catch(() => {
    throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_ROOT_UNAVAILABLE');
  });
  let mediaRoot = null;
  const message = [];
  const mediaMimes = [];
  let totalMediaBytes = 0;

  for (const part of parts) {
    const data = part?.data;
    if (part?.type === 'text') {
      requireThat(data && typeof data.text === 'string' && data.text.length <= 16000,
        'ASTRBOT_QQ_LIVE_OUTBOUND_MESSAGE_INVALID');
      message.push({ type: 'text', data: { text: data.text } });
      continue;
    }

    requireThat(part?.type === 'image' || part?.type === 'record',
      'ASTRBOT_QQ_LIVE_OUTBOUND_SEGMENT_UNSUPPORTED');
    requireThat(data && typeof data.file === 'string', 'ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED');

    if (!mediaRoot) {
      try { mediaRoot = await fs.realpath(path.join(stateRoot, 'astrbot', 'media')); }
      catch { throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_ROOT_UNAVAILABLE'); }
      requireThat(isDescendantPath(stateRoot, mediaRoot), 'ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED');
    }

    let fileUrl;
    let localPath;
    try {
      fileUrl = new URL(data.file);
      requireThat(fileUrl.protocol === 'file:' && fileUrl.hostname === ''
        && !fileUrl.username && !fileUrl.password && !fileUrl.search && !fileUrl.hash,
      'ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED');
      localPath = fileURLToPath(fileUrl);
    } catch {
      throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED');
    }

    let realFile;
    try { realFile = await fs.realpath(localPath); }
    catch { throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED'); }
    requireThat(isDescendantPath(mediaRoot, realFile), 'ASTRBOT_QQ_LIVE_MEDIA_PATH_DENIED');

    let handle;
    try { handle = await fs.open(realFile, 'r'); }
    catch { throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_UNAVAILABLE'); }
    let bytes;
    try {
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.size > 0 && stat.size <= MAX_QQ_MEDIA_BYTES,
        'ASTRBOT_QQ_LIVE_MEDIA_TOO_LARGE');
      requireThat(totalMediaBytes + stat.size <= MAX_QQ_MEDIA_BYTES,
        'ASTRBOT_QQ_LIVE_MEDIA_TOO_LARGE');
      const buffer = Buffer.alloc(MAX_QQ_MEDIA_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      requireThat(offset === stat.size && offset <= MAX_QQ_MEDIA_BYTES,
        'ASTRBOT_QQ_LIVE_MEDIA_TOO_LARGE');
      bytes = buffer.subarray(0, offset);
    } catch (error) {
      if (/^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(error?.code || ''))) throw error;
      throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_UNAVAILABLE');
    } finally {
      await handle.close().catch(() => {});
    }

    totalMediaBytes += bytes.length;
    requireThat(totalMediaBytes <= MAX_QQ_MEDIA_BYTES, 'ASTRBOT_QQ_LIVE_MEDIA_TOO_LARGE');
    const mime = fixtureMediaMime(part.type, realFile, bytes);
    mediaMimes.push(mime);
    message.push({
      type: part.type,
      data: {
        file: `base64://${bytes.toString('base64')}`,
        ...(part.type === 'image' && data.sub_type === 1 ? { sub_type: 1 } : {}),
      },
    });
  }

  return { message, mediaMimes };
}

function isDescendantPath(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && !path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function fixtureMediaMime(segmentType, filename, bytes) {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (segmentType === 'image' && extension === 'png' && bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (segmentType === 'record' && extension === 'wav' && bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  throw acceptanceError('ASTRBOT_QQ_LIVE_MEDIA_MIME_UNSUPPORTED');
}

function requiredEnv(name) {
  const value = process.env[name];
  requireThat(typeof value === 'string' && value.trim() !== '', 'ASTRBOT_QQ_LIVE_ENV_MISSING');
  return value.trim();
}

function validateRuntimeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw acceptanceError('ASTRBOT_QQ_LIVE_RUNTIME_URL_INVALID'); }
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash, 'ASTRBOT_QQ_LIVE_RUNTIME_URL_INVALID');
  return url.toString().replace(/\/$/, '');
}

async function validateRegularFile(filename, code) {
  const info = await fs.lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw acceptanceError(code);
  });
  requireThat(info?.isFile() && !info.isSymbolicLink(), code);
}

async function readProductionConfig(filename) {
  await validateRegularFile(filename, 'ASTRBOT_QQ_LIVE_CONFIG_REQUIRED');
  const info = await fs.stat(filename).catch(() => null);
  requireThat(info && info.size > 0 && info.size <= 1024 * 1024,
    'ASTRBOT_QQ_LIVE_CONFIG_INVALID');
  let value;
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw acceptanceError('ASTRBOT_QQ_LIVE_CONFIG_INVALID'); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value),
    'ASTRBOT_QQ_LIVE_CONFIG_INVALID');
  return value;
}

async function readVerifiedFixtureSource(filename, expectedHash, errorCode) {
  let source;
  try { source = await fs.readFile(filename, 'utf8'); }
  catch { throw acceptanceError(errorCode); }
  const normalized = Buffer.from(source.replace(/\r\n?/g, '\n'), 'utf8');
  requireThat(createHash('sha256').update(normalized).digest('hex') === expectedHash, errorCode);
  return normalized;
}

function buildFixtureZip(main, metadata) {
  return zipStored([
    { name: 'astrbot_plugin_boundary/', data: Buffer.alloc(0) },
    { name: 'astrbot_plugin_boundary/main.py', data: main },
    { name: 'astrbot_plugin_boundary/metadata.yaml', data: metadata },
  ]);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function waitForOneBot(bot, timeoutMs) {
  if (bot.connected) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(acceptanceError('ASTRBOT_QQ_LIVE_ONEBOT_CONNECT_TIMEOUT')), timeoutMs);
    const onReady = () => finish(bot.connected
      ? null : acceptanceError('ASTRBOT_QQ_LIVE_ONEBOT_READY_STATE_INVALID'));
    const finish = (error) => {
      clearTimeout(timer);
      bot.off('ready', onReady);
      if (error) reject(error);
      else resolve();
    };
    bot.once('ready', onReady);
    bot.connect();
  });
}

async function waitForInstall(manager, id) {
  requireThat(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    'ASTRBOT_QQ_LIVE_INSTALL_JOB_INVALID');
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await manager.job(id);
    requireThat(job && typeof job === 'object', 'ASTRBOT_QQ_LIVE_INSTALL_JOB_NOT_FOUND');
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      const code = String(job.error?.code || '');
      throw acceptanceError(/^ASTRBOT_[A-Z0-9_]{1,64}$/.test(code)
        ? code : 'ASTRBOT_QQ_LIVE_FIXTURE_INSTALL_FAILED');
    }
    await delay(1000);
  }
  throw acceptanceError('ASTRBOT_QQ_LIVE_INSTALL_TIMEOUT');
}

function classifyReceipt(journal, channel, text, segmentTypes) {
  for (const command of COMMANDS) {
    const testCase = journal.testCases[channel + '/' + command];
    if (!testCase || testCase.incomingCount < 1) continue;
    if (command === 'ast_echo' && text.startsWith('echo:')) addReceipt(testCase, 'reply');
    if (command === 'ast_image' && segmentTypes.includes('image')) addReceipt(testCase, 'image');
    if (command === 'ast_voice' && segmentTypes.includes('record')) addReceipt(testCase, 'record');
    if (command === 'ast_timer' && text.startsWith('timer-scheduled:qq-test;')) addReceipt(testCase, 'scheduled');
    if (command === 'ast_timer' && text === 'timer-fired:qq-test') addReceipt(testCase, 'fired');
    refreshCaseStatus(testCase, command);
  }
}

function addReceipt(testCase, receipt) {
  if (!testCase.receipts.includes(receipt)) testCase.receipts.push(receipt);
}

function refreshCaseStatus(testCase, command) {
  const exactTimerSeen = command !== 'ast_timer' || testCase.exactTimerCount > 0;
  const complete = exactTimerSeen && testCase.incomingCount > 0 && testCase.handledCount > 0
    && REQUIRED_RECEIPTS[command].every((receipt) => testCase.receipts.includes(receipt));
  testCase.status = complete ? 'passed'
    : testCase.incomingCount === 0 ? 'waiting_for_incoming'
        : testCase.handledCount === 0
          ? ['failed', 'unhandled', 'duplicate', 'error', 'invalid'].includes(testCase.dispatchStatus)
            ? 'dispatch_failed' : 'waiting_for_dispatch'
        : 'waiting_for_send_receipts';
}

function allCasesPassed(journal) {
  return Object.values(journal.testCases).every((testCase) => testCase.status === 'passed');
}

function missingTests(journal) {
  if (!journal) return [];
  const missing = [];
  for (const [name, testCase] of Object.entries(journal.testCases)) {
    if (testCase.status === 'passed') continue;
    const command = name.slice(name.indexOf('/') + 1);
    if (testCase.incomingCount === 0) {
      missing.push({ testCase: name, missing: 'incoming command not observed' });
      continue;
    }
    if (command === 'ast_timer' && testCase.exactTimerCount === 0) {
      missing.push({ testCase: name, missing: 'exact /ast_timer 3 qq-test not observed' });
    }
    if (testCase.handledCount === 0) {
      missing.push({ testCase: name, missing: 'bridge dispatch status: ' + testCase.dispatchStatus });
    }
    for (const receipt of REQUIRED_RECEIPTS[command]) {
      if (!testCase.receipts.includes(receipt)) {
        missing.push({ testCase: name, missing: receipt + ' send receipt not observed' });
      }
    }
  }
  return missing;
}

function recordCleanupError(journal, error) {
  if (!journal) return;
  journal.cleanup.errors.push(safeErrorCode(error));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!OPT_IN) {
  console.log('AstrBot QQ live acceptance skipped; set ASTRBOT_QQ_LIVE_TEST=1 to opt in.');
} else {
  await main();
}

export { buildFixtureZip, readVerifiedFixtureSource };
