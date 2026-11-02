if (process.env.ASTRBOT_REMINDER_TEST !== '1') {
  console.log('AstrBot reminder acceptance skipped; set ASTRBOT_REMINDER_TEST=1 to opt in.');
} else {
  const fs = await import('node:fs/promises');
  const { constants: fsConstants } = await import('node:fs');
  const path = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');

  const GROUP_ID = '123';
  const CROSS_GROUP_ID = '124';
  const CREATOR_ID = '789';
  const OUTSIDER_ID = '999';
  const PROJECT_ADMIN_ID = '456';
  const PLUGIN_REPOSITORY = 'https://github.com/Foolllll-J/astrbot_plugin_reminder';
  const PLUGIN_ID = 'astrbot_plugin_reminder';
  const ARCHIVE_RELATIVE_PATH = path.join('samples', 'reminder.zip');
  const MARKER_NAME = '.astrbot-acceptance-only';
  const SEND_DIAGNOSTICS_NAME = 'reminder-send-diagnostics.json';
  const SEND_DIAGNOSTICS_SCHEMA = 'astrbot-reminder-active-send-diagnostics-v1';
  const SEND_DIAGNOSTIC_STATUSES = new Set(['sent', 'unrouted', 'failed', 'cancelled']);
  const SEND_DIAGNOSTIC_ERROR_CODES = new Set([
    'ASTRBOT_SEND_PROVENANCE_MISSING',
    'ASTRBOT_SEND_PERMISSION_DENIED',
    'ASTRBOT_SEND_SESSION_INVALID',
    'ASTRBOT_SEND_TIMEOUT',
    'ASTRBOT_PERMISSION_DENIED',
    'ASTRBOT_CONTEXT_CANCELLED',
    'ASTRBOT_CALLBACK_UNAVAILABLE',
    'ASTRBOT_CALLBACK_FAILED',
    'ASTRBOT_SEND_FAILED',
    'ASTRBOT_SEND_PLATFORM_UNMATCHED',
    'ASTRBOT_CANCELLED',
  ]);
  const MAX_DIAGNOSTIC_GENERATION_ENTRIES = 128;
  const MAX_DIAGNOSTIC_GENERATIONS = 32;
  const MAX_DIAGNOSTIC_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_DIAGNOSTIC_TOTAL_BYTES = 8 * 1024 * 1024;
  const MAX_DIAGNOSTIC_ROWS = 4096;
  const MAX_DIAGNOSTIC_LINE_BYTES = 8192;
  const MAX_DIAGNOSTIC_OUTPUT_BYTES = 4 * 1024 * 1024;
  const INSTALL_TIMEOUT_MS = boundedTimeout(process.env.ASTRBOT_REMINDER_INSTALL_TIMEOUT_MS, 10 * 60 * 1000);
  const EVENT_TIMEOUT_MS = boundedTimeout(process.env.ASTRBOT_REMINDER_EVENT_TIMEOUT_MS, 4 * 60 * 1000);
  const COLD_RESTORE = process.env.ASTRBOT_REMINDER_COLD_RESTORE === '1';

  let APP_ROOT;
  let STATE_DIR;
  let STATE_ROOT;
  let CONFIG_PATH;
  let MARKER_PATH;
  let RUNTIME_URL;
  let CALLBACK_URL;
  let CALLBACK_HOST;
  let CALLBACK_PORT;
  let EXPECTED_ARCHIVE_HASH;
  let EXPECTED_MAIN_HASH;

  const result = {
    type: 'astrbot-reminder-native-summary',
    status: 'blocked',
    runtime: 'external',
    runtimeHealthReadyBeforeCollector: false,
    runtimeWorkerStartedAfterCollector: false,
    commandContext: { messageType: 'group', groupId: GROUP_ID, senderRole: 'member' },
    commandDiagnostics: {
      reminderCreate: blankCommandDiagnostic(),
      crossGroupCreate: blankCommandDiagnostic(),
    },
    archiveLocked: false,
    archiveUnchanged: false,
    installedDefaultOff: false,
    pluginEnabled: false,
    creatorWhitelistAllowed: false,
    outsiderDenied: false,
    adminBypassDeleted: false,
    creatorAdminControl: { status: 'not-run', creatorIsNonAdmin: false,
      adminViewAllowed: false, originalCreatorContextUnchanged: false },
    coldRestore: { required: true, optIn: COLD_RESTORE, status: 'not-run',
      noDispatchBeforeFirstRestoredTimer: false },
    lifecycleRevocation: { status: 'not-run', method: 'original-context-callback',
      additionalNativeTimerTested: false, originalContextAuthorizedBeforeMutation: false,
      sameConfigEpochDenied: false, sameConfigCallbackDenied: false,
      disableReenableEpochDenied: false, disableReenableCallbackDenied: false,
      freshContextAllowedAfterReenable: false, bridgeDenialCode: null },
    group123ScheduledDeliveryAfterRestart: false,
    restorePhaseDiagnostics: {
      restartJobSucceeded: false,
      runtimeHealthyAfterRestart: false,
      runtimeWorkerRunningAfterRestart: false,
      reminderVisibleAfterRestart: false,
      creatorRetainedAfterRestart: false,
      group123RetainedAfterRestart: false,
      cronRetainedAfterRestart: false,
      runtimeStatusProbeFailureCode: null,
      reminderViewProbeFailureCode: null,
      runtimeProcessChanged: undefined,
    },
    crossGroupAttemptObserved: false,
    noCrossGroupCollectorDelivery: false,
    crossGroupPhaseStatus: 'not-run',
    syntheticEventPhaseStatus: 'not-tested',
    unexpectedModelCalls: 0,
    installedMainHashAtInstall: null,
    installedMainHashBeforeCleanup: null,
    installedMainHashMatchesLockAtInstall: false,
    installedMainHashMatchesLockBeforeCleanup: false,
    installedMainHashCaptureFailureCode: null,
    pluginMainHashPreserved: false,
    sendDiagnosticsSnapshot: {
      written: false,
      sourceFilesRead: 0,
      recordsIncluded: 0,
      recordsDropped: 0,
      unsafeEntriesSkipped: 0,
      truncated: false,
      failureCode: null,
    },
    failureCodes: [],
    cleanupFailureCodes: [],
    cleanup: {
      reminderPluginUninstalled: false,
      reminderDataPurged: false,
      runtimeWorkerStopped: false,
      callbackStopped: false,
      isolatedStateRemoved: false,
      priorBlockedPolicyArtifactRemoved: false,
    },
  };

  let sends;
  const observedDispatches = new Set();
  let lastDispatchedContextId;
  let manager;
  let policy;
  let bridge;
  let originalRuntimeRpc;
  let priorRuntimeMode;
  let priorRuntimeUrl;
  let runtimeEnvOverridden = false;
  let policyTouched = false;
  let testStarted = false;
  let pendingInstall;
  let installedPluginId;
  let initialArchiveHash;
  let markerContent;

  function boundedTimeout(raw, fallback) {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 30_000 && value <= 20 * 60 * 1000
      ? value : fallback;
  }

  function fail(code) {
    return Object.assign(new Error(code), { code });
  }

  function requireThat(value, code) {
    if (!value) throw fail(code);
  }

  function blankCommandDiagnostic() {
    return {
      cronFieldsSent: 0,
      executionLimit: 0,
      targetGroupId: GROUP_ID,
      replyReceived: false,
      responseHandled: false,
      runtimeDispatchObserved: false,
      successAcknowledgement: false,
      permissionDenied: false,
      missingParameters: false,
      cronNeedsFiveFields: false,
      invalidCron: false,
      emptyReminderContent: false,
      duplicateName: false,
      targetSessionUnrecognized: false,
      pluginReportedError: false,
      otherReply: false,
      replySnippet: '',
    };
  }

  function safeCode(error) {
    const code = String(error?.code || '');
    return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(code)
      ? code : 'ASTRBOT_REMINDER_UNEXPECTED_ERROR';
  }

  function addFailure(code, cleanup = false) {
    const safe = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(code || ''))
      ? String(code) : 'ASTRBOT_REMINDER_UNEXPECTED_ERROR';
    const target = cleanup ? result.cleanupFailureCodes : result.failureCodes;
    if (!target.includes(safe)) target.push(safe);
  }

  function absoluteDirectory(raw, code) {
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.trim() === raw, code);
    if (process.platform === 'win32') {
      const root = path.win32.parse(raw).root.replaceAll('/', '\\');
      const driveQualified = root.length >= 3 && root[1] === ':' && root[2] === '\\';
      const uncQualified = root.charCodeAt(0) === 92 && root.charCodeAt(1) === 92
        && root.slice(2).split('\\').filter(Boolean).length >= 2;
      requireThat(path.win32.isAbsolute(raw) && (driveQualified || uncQualified), code);
      return path.win32.resolve(raw);
    }
    requireThat(path.isAbsolute(raw), code);
    return path.resolve(raw);
  }

  function comparable(value) {
    const resolved = process.platform === 'win32' ? path.win32.resolve(value) : path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function within(parent, child) {
    const api = process.platform === 'win32' ? path.win32 : path;
    const rel = api.relative(comparable(parent), comparable(child));
    return rel === '' || (!api.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${api.sep}`));
  }

  function overlaps(left, right) {
    return within(left, right) || within(right, left);
  }

  function parseHttpUrl(raw, requiredPath, code) {
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.trim() === raw && raw.length <= 2048, code);
    let parsed;
    try { parsed = new URL(raw); } catch { throw fail(code); }
    requireThat(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.length > 0
      && !parsed.username && !parsed.password && parsed.pathname === requiredPath
      && !parsed.search && !parsed.hash, code);
    return raw;
  }

  function configurePaths() {
    APP_ROOT = absoluteDirectory(process.env.ASTRBOT_REMINDER_APP_ROOT, 'ASTRBOT_REMINDER_APP_ROOT_REQUIRED');
    STATE_DIR = absoluteDirectory(process.env.ASTRBOT_REMINDER_STATE_DIR, 'ASTRBOT_REMINDER_STATE_DIR_REQUIRED');
    const liveState = path.resolve(APP_ROOT, 'state');
    const dedicatedStateMount = process.platform !== 'win32'
      && comparable(STATE_DIR) === comparable(liveState);
    requireThat(!overlaps(APP_ROOT, STATE_DIR) || dedicatedStateMount,
      'ASTRBOT_REMINDER_STATE_ROOT_OVERLAPS_APP');
    requireThat(dedicatedStateMount || !overlaps(liveState, STATE_DIR),
      'ASTRBOT_REMINDER_LIVE_STATE_FORBIDDEN');

    STATE_ROOT = path.join(STATE_DIR, 'astrbot');
    CONFIG_PATH = path.join(STATE_DIR, 'astrbot-reminder-native-config.json');
    MARKER_PATH = path.join(STATE_DIR, MARKER_NAME);
    RUNTIME_URL = parseHttpUrl(process.env.ASTRBOT_REMINDER_RUNTIME_URL, '/', 'ASTRBOT_REMINDER_RUNTIME_URL_INVALID');
    CALLBACK_URL = parseHttpUrl(process.env.ASTRBOT_REMINDER_CALLBACK_URL, '/rpc/callback', 'ASTRBOT_REMINDER_CALLBACK_URL_INVALID');
    CALLBACK_HOST = process.env.ASTRBOT_REMINDER_CALLBACK_HOST;
    requireThat(typeof CALLBACK_HOST === 'string' && CALLBACK_HOST.length > 0
      && CALLBACK_HOST.trim() === CALLBACK_HOST && CALLBACK_HOST.length <= 255
      && ![...CALLBACK_HOST].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 0x20 || code === 0x7f || '/\\?#'.includes(char);
      }), 'ASTRBOT_REMINDER_CALLBACK_HOST_INVALID');
    const portText = process.env.ASTRBOT_REMINDER_CALLBACK_PORT;
    requireThat(typeof portText === 'string' && /^\d{1,5}$/.test(portText),
      'ASTRBOT_REMINDER_CALLBACK_PORT_REQUIRED');
    CALLBACK_PORT = Number(portText);
    requireThat(Number.isSafeInteger(CALLBACK_PORT) && CALLBACK_PORT >= 1 && CALLBACK_PORT <= 65535,
      'ASTRBOT_REMINDER_CALLBACK_PORT_INVALID');
  }

  async function hashFile(filename) {
    return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  }

  async function assertRegularFile(filename, code) {
    const stat = await fs.lstat(filename).catch(() => null);
    requireThat(stat?.isFile() && !stat.isSymbolicLink(), code);
  }

  async function removeKnownBlockedPolicyArtifact() {
    const filename = path.join(STATE_ROOT, 'policy.json');
    const stat = await fs.lstat(filename).catch(() => null);
    if (!stat) return false;
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024,
      'ASTRBOT_REMINDER_RUNTIME_STATE_NOT_FRESH');
    let data;
    try { data = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch { throw fail('ASTRBOT_REMINDER_RUNTIME_STATE_NOT_FRESH'); }
    const keys = data && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data).sort() : [];
    const groups = data?.groups;
    requireThat(keys.join(',') === 'enabled,groups,revision'
      && data.enabled === false
      && typeof data.revision === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.revision)
      && groups && typeof groups === 'object' && !Array.isArray(groups)
      && Object.keys(groups).length === 0,
    'ASTRBOT_REMINDER_RUNTIME_STATE_NOT_FRESH');
    await fs.rm(filename);
    return true;
  }

  async function assertRegularTree(directory) {
    const stat = await fs.lstat(directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'ASTRBOT_REMINDER_UNSAFE_STATE_TREE');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const child = await fs.lstat(filename);
      requireThat(!child.isSymbolicLink(), 'ASTRBOT_REMINDER_UNSAFE_STATE_TREE');
      if (child.isDirectory()) await assertRegularTree(filename);
      else requireThat(child.isFile(), 'ASTRBOT_REMINDER_UNSAFE_STATE_TREE');
    }
  }

  function isWithinDirectory(parent, child) {
    const api = process.platform === 'win32' ? path.win32 : path;
    const relative = api.relative(parent, child);
    return relative === '' || (!api.isAbsolute(relative)
      && relative !== '..' && !relative.startsWith('..' + api.sep));
  }

  async function checkedRealDirectory(directory, boundaryReal, missingIsOk = false) {
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat) {
      if (missingIsOk) return null;
      throw fail('ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return null;
    }
    const real = await fs.realpath(directory).catch(() => null);
    if (!real || !isWithinDirectory(boundaryReal, real)) return null;
    const after = await fs.lstat(directory).catch(() => null);
    if (!after?.isDirectory() || after.isSymbolicLink()
      || (stat.ino && after.ino && (stat.ino !== after.ino || stat.dev !== after.dev))) return null;
    return { stat, real };
  }

  async function readBoundedHandle(handle, limit) {
    const parts = [];
    const chunk = Buffer.alloc(64 * 1024);
    let length = 0;
    let overflow = false;
    while (true) {
      const requested = Math.min(chunk.length, limit - length + 1);
      if (requested <= 0) {
        overflow = true;
        break;
      }
      const { bytesRead } = await handle.read(chunk, 0, requested, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > limit) {
        overflow = true;
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return { bytes: Buffer.concat(parts, Math.min(length, limit)), overflow };
  }

  async function validateExistingSendDiagnosticsArtifact(filename) {
    const stat = await fs.lstat(filename).catch(() => null);
    if (!stat) return false;
    requireThat(stat.isFile() && !stat.isSymbolicLink()
      && stat.size <= MAX_DIAGNOSTIC_OUTPUT_BYTES,
    'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
    const parentPath = path.dirname(filename);
    const parentStat = await fs.lstat(parentPath).catch(() => null);
    requireThat(parentStat?.isDirectory() && !parentStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
    const parentReal = await fs.realpath(parentPath);
    const resolvedBefore = await fs.realpath(filename).catch(() => null);
    requireThat(resolvedBefore && isWithinDirectory(parentReal, resolvedBefore),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
    let handle;
    try {
      handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      const current = await fs.lstat(filename).catch(() => null);
      const resolvedAfter = await fs.realpath(filename).catch(() => null);
      const sameIdentity = current && (!current.ino || !opened.ino
        || (current.ino === opened.ino && current.dev === opened.dev));
      requireThat(opened.isFile() && current?.isFile() && !current.isSymbolicLink()
        && sameIdentity && resolvedAfter === resolvedBefore
        && isWithinDirectory(parentReal, resolvedAfter),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
      const bytes = await readBoundedHandle(handle, MAX_DIAGNOSTIC_OUTPUT_BYTES);
      requireThat(!bytes.overflow, 'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
      const value = JSON.parse(bytes.bytes.toString('utf8'));
      requireThat(value?.schema === SEND_DIAGNOSTICS_SCHEMA
        && Array.isArray(value.events)
        && Number.isSafeInteger(value.sourceFilesRead)
        && Number.isSafeInteger(value.recordsIncluded),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
      return true;
    } catch (error) {
      if (String(error?.code || '').startsWith('ASTRBOT_')) throw error;
      throw fail('ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function validateSendDiagnosticsWorkspace() {
    const stateStat = await fs.lstat(STATE_DIR).catch(() => null);
    requireThat(stateStat?.isDirectory() && !stateStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
    const stateReal = await fs.realpath(STATE_DIR);
    const markerStat = await fs.lstat(MARKER_PATH).catch(() => null);
    const currentMarker = await fs.readFile(MARKER_PATH).catch(() => null);
    requireThat(markerStat?.isFile() && !markerStat.isSymbolicLink()
      && Buffer.isBuffer(currentMarker) && currentMarker.equals(markerContent),
    'ASTRBOT_REMINDER_MARKER_CHANGED');
    const entries = new Set(await fs.readdir(STATE_DIR));
    const allowed = new Set([
      MARKER_NAME, 'samples', path.basename(STATE_ROOT), path.basename(CONFIG_PATH),
      SEND_DIAGNOSTICS_NAME,
    ]);
    requireThat(entries.has(MARKER_NAME) && entries.has('samples')
      && [...entries].every((entry) => allowed.has(entry)),
    'ASTRBOT_REMINDER_STATE_DIR_NOT_FRESH');
    const samples = await checkedRealDirectory(path.join(STATE_DIR, 'samples'), stateReal);
    requireThat(samples, 'ASTRBOT_REMINDER_SAMPLE_DIRECTORY_CHANGED');
    await validateExistingSendDiagnosticsArtifact(path.join(STATE_DIR, SEND_DIAGNOSTICS_NAME));
    return stateReal;
  }

  async function readSafeSendDiagnosticFile(filename, rootReal, budget) {
    const before = await fs.lstat(filename).catch(() => null);
    if (!before) return { skipped: false, bytes: null, unsafe: false, truncated: false };
    if (!before.isFile() || before.isSymbolicLink()) {
      return { skipped: false, bytes: null, unsafe: true, truncated: false };
    }
    if (before.size > MAX_DIAGNOSTIC_FILE_BYTES
      || budget.totalBytes + before.size > MAX_DIAGNOSTIC_TOTAL_BYTES) {
      return { skipped: false, bytes: null, unsafe: false, truncated: true };
    }
    const resolvedBefore = await fs.realpath(filename).catch(() => null);
    if (!resolvedBefore || !isWithinDirectory(rootReal, resolvedBefore)) {
      return { skipped: false, bytes: null, unsafe: true, truncated: false };
    }
    let handle;
    try {
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
      handle = await fs.open(filename, flags);
      const opened = await handle.stat();
      const current = await fs.lstat(filename).catch(() => null);
      const resolvedAfter = await fs.realpath(filename).catch(() => null);
      const sameIdentity = current && (!current.ino || !opened.ino
        || (current.ino === opened.ino && current.dev === opened.dev));
      if (!opened.isFile() || !current?.isFile() || current.isSymbolicLink()
        || !sameIdentity || !resolvedAfter || !isWithinDirectory(rootReal, resolvedAfter)
        || resolvedBefore !== resolvedAfter) {
        return { skipped: false, bytes: null, unsafe: true, truncated: false };
      }
      if (opened.size > MAX_DIAGNOSTIC_FILE_BYTES
        || budget.totalBytes + opened.size > MAX_DIAGNOSTIC_TOTAL_BYTES) {
        return { skipped: false, bytes: null, unsafe: false, truncated: true };
      }
      const read = await readBoundedHandle(handle, MAX_DIAGNOSTIC_FILE_BYTES);
      if (read.overflow) {
        return { skipped: false, bytes: null, unsafe: false, truncated: true };
      }
      budget.totalBytes += read.bytes.length;
      return { skipped: false, bytes: read.bytes, unsafe: false, truncated: false };
    } catch {
      return { skipped: false, bytes: null, unsafe: true, truncated: false };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function sanitizeActiveSendRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.stage !== 'active-send'
      || !SEND_DIAGNOSTIC_STATUSES.has(record.status)
      || typeof record.principalPresent !== 'boolean') return null;
    const clean = {
      stage: 'active-send',
      status: record.status,
      principalPresent: record.principalPresent,
    };
    if (Number.isSafeInteger(record.at) && record.at >= 0) clean.at = record.at;
    if (typeof record.errorCode === 'string'
      && SEND_DIAGNOSTIC_ERROR_CODES.has(record.errorCode)) {
      clean.errorCode = record.errorCode;
    }
    if (Array.isArray(record.plugins)) {
      const plugins = [...new Set(record.plugins.filter((plugin) => plugin === PLUGIN_ID))].slice(0, 1);
      if (plugins.length) clean.plugins = plugins;
    }
    return clean;
  }

  async function collectSendDiagnostics() {
    const summary = {
      schema: SEND_DIAGNOSTICS_SCHEMA,
      capturedAt: new Date().toISOString(),
      captureStatus: 'no-events',
      sourceFilesRead: 0,
      recordsIncluded: 0,
      recordsDropped: 0,
      unsafeEntriesSkipped: 0,
      truncated: false,
      events: [],
    };
    const stateReal = await validateSendDiagnosticsWorkspace();
    const rootStat = await fs.lstat(STATE_ROOT).catch(() => null);
    if (!rootStat) return summary;
    requireThat(rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
    const rootReal = await fs.realpath(STATE_ROOT);
    requireThat(isWithinDirectory(stateReal, rootReal),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
    const generations = await checkedRealDirectory(path.join(STATE_ROOT, 'generations'), rootReal, true);
    if (!generations) {
      const generationStat = await fs.lstat(path.join(STATE_ROOT, 'generations')).catch(() => null);
      if (generationStat) summary.unsafeEntriesSkipped += 1;
      return summary;
    }

    const budget = { totalBytes: 0 };
    let generationEntries = 0;
    let generationDirectories = 0;
    let rowsSeen = 0;
    const directory = await fs.opendir(path.join(STATE_ROOT, 'generations')).catch(() => null);
    if (!directory) {
      summary.unsafeEntriesSkipped += 1;
      return summary;
    }
    for await (const entry of directory) {
      generationEntries += 1;
      if (generationEntries > MAX_DIAGNOSTIC_GENERATION_ENTRIES) {
        summary.truncated = true;
        break;
      }
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      if (generationDirectories >= MAX_DIAGNOSTIC_GENERATIONS) {
        summary.truncated = true;
        break;
      }
      generationDirectories += 1;
      const generationPath = path.join(STATE_ROOT, 'generations', entry.name);
      const generation = await checkedRealDirectory(generationPath, rootReal);
      if (!generation) {
        summary.unsafeEntriesSkipped += 1;
        continue;
      }
      const managerPath = path.join(generationPath, 'manager');
      const managerDirectory = await checkedRealDirectory(managerPath, rootReal, true);
      if (!managerDirectory) {
        const managerStat = await fs.lstat(managerPath).catch(() => null);
        if (managerStat) summary.unsafeEntriesSkipped += 1;
        continue;
      }
      const logPath = path.join(managerPath, 'runtime.jsonl');
      const read = await readSafeSendDiagnosticFile(logPath, rootReal, budget);
      if (read.unsafe) summary.unsafeEntriesSkipped += 1;
      if (read.truncated) summary.truncated = true;
      if (!read.bytes) continue;
      summary.sourceFilesRead += 1;
      const lines = read.bytes.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        rowsSeen += 1;
        if (rowsSeen > MAX_DIAGNOSTIC_ROWS) {
          summary.truncated = true;
          break;
        }
        if (Buffer.byteLength(line, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
          summary.recordsDropped += 1;
          summary.truncated = true;
          continue;
        }
        let record;
        try { record = JSON.parse(line); }
        catch {
          summary.recordsDropped += 1;
          continue;
        }
        if (record?.stage !== 'active-send') continue;
        const clean = sanitizeActiveSendRecord(record);
        if (!clean) {
          summary.recordsDropped += 1;
          continue;
        }
        summary.events.push(clean);
      }
      if (rowsSeen > MAX_DIAGNOSTIC_ROWS) break;
    }
    summary.events.sort((left, right) => (left.at || 0) - (right.at || 0));
    summary.recordsIncluded = summary.events.length;
    if (summary.truncated) summary.captureStatus = 'truncated';
    else if (summary.events.length) summary.captureStatus = 'captured';
    return summary;
  }

  async function writeSendDiagnosticsSnapshot() {
    const snapshot = await collectSendDiagnostics();
    const outputPath = path.join(STATE_DIR, SEND_DIAGNOSTICS_NAME);
    const outputBytes = Buffer.from(JSON.stringify(snapshot) + '\n', 'utf8');
    requireThat(outputBytes.length <= MAX_DIAGNOSTIC_OUTPUT_BYTES,
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_OUTPUT_TOO_LARGE');
    const stateStat = await fs.lstat(STATE_DIR).catch(() => null);
    const stateReal = await fs.realpath(STATE_DIR);
    requireThat(stateStat?.isDirectory() && !stateStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
    const temporaryPath = path.join(STATE_DIR, '.' + SEND_DIAGNOSTICS_NAME + '.' + randomUUID() + '.tmp');
    let temporaryCreated = false;
    try {
      await validateExistingSendDiagnosticsArtifact(outputPath);
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW || 0);
      const handle = await fs.open(temporaryPath, flags, 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(outputBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const tempStat = await fs.lstat(temporaryPath);
      const tempReal = await fs.realpath(temporaryPath);
      const currentStateStat = await fs.lstat(STATE_DIR).catch(() => null);
      const currentStateReal = await fs.realpath(STATE_DIR).catch(() => null);
      requireThat(currentStateStat?.isDirectory() && !currentStateStat.isSymbolicLink()
        && currentStateReal === stateReal
        && tempStat.isFile() && !tempStat.isSymbolicLink()
        && isWithinDirectory(stateReal, tempReal),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_TREE_UNSAFE');
      await validateExistingSendDiagnosticsArtifact(outputPath);
      await fs.rename(temporaryPath, outputPath);
      temporaryCreated = false;
      const outputStat = await fs.lstat(outputPath);
      const outputReal = await fs.realpath(outputPath);
      requireThat(outputStat.isFile() && !outputStat.isSymbolicLink()
        && outputStat.size <= MAX_DIAGNOSTIC_OUTPUT_BYTES
        && isWithinDirectory(stateReal, outputReal),
      'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_PATH_UNSAFE');
    } finally {
      if (temporaryCreated) {
        const tempStat = await fs.lstat(temporaryPath).catch(() => null);
        if (tempStat?.isFile() && !tempStat.isSymbolicLink()) {
          await fs.rm(temporaryPath, { force: true }).catch(() => {});
        }
      }
    }
    result.sendDiagnosticsSnapshot = {
      written: true,
      sourceFilesRead: snapshot.sourceFilesRead,
      recordsIncluded: snapshot.recordsIncluded,
      recordsDropped: snapshot.recordsDropped,
      unsafeEntriesSkipped: snapshot.unsafeEntriesSkipped,
      truncated: snapshot.truncated,
      failureCode: null,
    };
  }

  async function preflight() {
    requireThat(COLD_RESTORE, 'ASTRBOT_REMINDER_COLD_RESTORE_REQUIRED');
    configurePaths();
    const stateStat = await fs.lstat(STATE_DIR).catch(() => null);
    requireThat(stateStat?.isDirectory() && !stateStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_STATE_DIR_REQUIRED');
    await assertRegularFile(MARKER_PATH, 'ASTRBOT_REMINDER_MARKER_REQUIRED');
    markerContent = await fs.readFile(MARKER_PATH);
    const directEntries = new Set(await fs.readdir(STATE_DIR));
    const allowedStateEntries = new Set([
      MARKER_NAME, 'samples', 'astrbot', path.basename(CONFIG_PATH), SEND_DIAGNOSTICS_NAME,
    ]);
    requireThat(directEntries.has(MARKER_NAME) && directEntries.has('samples')
      && directEntries.has('astrbot')
      && [...directEntries].every((entry) => allowedStateEntries.has(entry)),
    'ASTRBOT_REMINDER_STATE_DIR_NOT_FRESH');
    const samplesPath = path.join(STATE_DIR, 'samples');
    const samplesStat = await fs.lstat(samplesPath).catch(() => null);
    requireThat(samplesStat?.isDirectory() && !samplesStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SAMPLE_DIRECTORY_REQUIRED');
    await validateExistingSendDiagnosticsArtifact(path.join(STATE_DIR, SEND_DIAGNOSTICS_NAME));
    requireThat(!(await fs.lstat(CONFIG_PATH).catch(() => null)),
      'ASTRBOT_REMINDER_CONFIG_PATH_ALREADY_EXISTS');

    const stateRootStat = await fs.lstat(STATE_ROOT).catch(() => null);
    requireThat(stateRootStat?.isDirectory() && !stateRootStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_RUNTIME_STATE_REQUIRED');
    await assertRegularFile(path.join(STATE_ROOT, 'rpc-token'), 'ASTRBOT_REMINDER_SHARED_TOKEN_REQUIRED');
    let runtimeEntries = await fs.readdir(STATE_ROOT);
    if (runtimeEntries.length === 2 && runtimeEntries.includes('rpc-token')
        && runtimeEntries.includes('policy.json')) {
      result.cleanup.priorBlockedPolicyArtifactRemoved = await removeKnownBlockedPolicyArtifact();
      runtimeEntries = await fs.readdir(STATE_ROOT);
    }
    requireThat(runtimeEntries.length === 1 && runtimeEntries[0] === 'rpc-token',
      'ASTRBOT_REMINDER_RUNTIME_STATE_NOT_FRESH');
    requireThat(!process.env.ASTRBOT_RUNTIME_MODE || process.env.ASTRBOT_RUNTIME_MODE === 'external',
      'ASTRBOT_REMINDER_EXTERNAL_MODE_REQUIRED');

    const manifestPath = path.join(APP_ROOT, 'runtime', 'astrbot-samples.json');
    await assertRegularFile(manifestPath, 'ASTRBOT_REMINDER_LOCK_REQUIRED');
    const manifestBytes = await fs.readFile(manifestPath);
    requireThat(manifestBytes.length <= 1024 * 1024, 'ASTRBOT_REMINDER_LOCK_INVALID');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch { throw fail('ASTRBOT_REMINDER_LOCK_INVALID'); }
    const entries = manifest?.samples?.filter((item) => item.repository === PLUGIN_REPOSITORY) || [];
    requireThat(manifest?.schemaVersion === 1 && entries.length === 1
      && /^[a-f0-9]{64}$/i.test(entries[0].archiveSHA256)
      && /^[a-f0-9]{64}$/i.test(entries[0].mainPySHA256), 'ASTRBOT_REMINDER_LOCK_ENTRY_MISSING');
    EXPECTED_ARCHIVE_HASH = entries[0].archiveSHA256.toLowerCase();
    EXPECTED_MAIN_HASH = entries[0].mainPySHA256.toLowerCase();

    const archivePath = path.join(STATE_DIR, ARCHIVE_RELATIVE_PATH);
    await assertRegularFile(archivePath, 'ASTRBOT_REMINDER_LOCKED_ARCHIVE_REQUIRED');
    initialArchiveHash = await hashFile(archivePath);
    requireThat(initialArchiveHash === EXPECTED_ARCHIVE_HASH, 'ASTRBOT_REMINDER_ARCHIVE_HASH_MISMATCH');
    result.archiveLocked = true;
  }

  function sentText(item) {
    const value = item?.params?.message;
    if (typeof value === 'string') return value;
    return (Array.isArray(value) ? value : [])
      .filter((part) => part?.type === 'text' && typeof part?.data?.text === 'string')
      .map((part) => part.data.text).join('');
  }

  async function originSnapshot(contextId) {
    requireThat(typeof contextId === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(contextId),
    'ASTRBOT_REMINDER_CREATION_CONTEXT_MISSING');
    const filename = path.join(STATE_ROOT, 'contexts', `${contextId}.json`);
    await assertRegularFile(filename, 'ASTRBOT_REMINDER_CREATION_CONTEXT_MISSING');
    requireThat((await fs.lstat(filename)).size <= 128 * 1024,
      'ASTRBOT_REMINDER_CREATION_CONTEXT_INVALID');
    let context;
    try { context = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch { throw fail('ASTRBOT_REMINDER_CREATION_CONTEXT_INVALID'); }
    // Exclude mutable effect/status fields and never include message bodies.
    return { id: context.id, userId: context.userId, isAdmin: context.isAdmin,
      isGroup: context.isGroup, groupId: context.groupId, pluginIds: context.pluginIds,
      scheduledAuthorization: context.scheduledAuthorization };
  }

  async function requireCodeDenied(operation, expectedCode, allowedCode) {
    try { await operation(); } catch (error) {
      if (error?.code === expectedCode) return true;
      throw error;
    }
    throw fail(allowedCode);
  }

  async function requireOriginalContextDenied(contextId, assertOrigin) {
    const context = await originSnapshot(contextId);
    const epochDenied = await requireCodeDenied(() => assertOrigin({ root: STATE_ROOT,
      pluginId: installedPluginId, context }), 'ASTRBOT_SCHEDULED_ORIGIN_REVOKED',
    'ASTRBOT_REMINDER_OLD_EPOCH_ALLOWED');
    const count = sends.length;
    // The bridge deliberately presents epoch failures as generic permission
    // denial. Test the exact epoch separately, then the real callback boundary.
    const callbackDenied = await requireCodeDenied(() => bridge.callback({ version: 1,
      method: 'send', contextId, pluginId: installedPluginId, params: {
        target: { isGroup: true, groupId: GROUP_ID },
        message: [{ type: 'text', data: { text: 'controlled revoked reminder callback probe' } }],
      } }), 'ASTRBOT_PERMISSION_DENIED', 'ASTRBOT_REMINDER_OLD_CONTEXT_CALLBACK_ALLOWED');
    requireThat(sends.length === count, 'ASTRBOT_REMINDER_DENIED_CALLBACK_REACHED_COLLECTOR');
    return { epochDenied, callbackDenied };
  }

  function recordCommandDiagnostic(key, response, text, messageId, expectedName, redactValues = []) {
    const diagnostic = result.commandDiagnostics[key];
    if (!diagnostic) return;
    const reply = String(text || '');
    diagnostic.replyReceived = reply.trim().length > 0;
    diagnostic.responseHandled = response?.status === 'handled';
    diagnostic.runtimeDispatchObserved = observedDispatches.has(messageId);
    diagnostic.successAcknowledgement = reply.includes(`提醒 '${expectedName}' 添加成功`);
    diagnostic.permissionDenied = reply.includes('没有权限');
    diagnostic.missingParameters = reply.includes('参数缺失');
    diagnostic.cronNeedsFiveFields = reply.includes('需要5段');
    diagnostic.invalidCron = reply.includes('cron表达式无效') || reply.includes('cron表达式格式错误');
    diagnostic.emptyReminderContent = reply.includes('提醒内容不能为空');
    diagnostic.duplicateName = reply.includes(`已存在名为 '${expectedName}'`);
    diagnostic.targetSessionUnrecognized = reply.includes('无法识别当前平台信息');
    diagnostic.pluginReportedError = reply.includes('添加提醒失败:');
    const knownSignal = diagnostic.successAcknowledgement || diagnostic.permissionDenied
      || diagnostic.missingParameters || diagnostic.cronNeedsFiveFields || diagnostic.invalidCron
      || diagnostic.emptyReminderContent || diagnostic.duplicateName
      || diagnostic.targetSessionUnrecognized || diagnostic.pluginReportedError;
    diagnostic.otherReply = diagnostic.replyReceived && !knownSignal;
    let snippet = reply.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const value of [expectedName, ...redactValues, CREATOR_ID, GROUP_ID, CROSS_GROUP_ID]) {
      if (value) snippet = snippet.split(String(value)).join('[redacted]');
    }
    diagnostic.replySnippet = diagnostic.successAcknowledgement ? '' : snippet.slice(0, 240);
  }

  function makeMessage(messageId, senderId, text) {
    return {
      messageType: 'group',
      groupId: GROUP_ID,
      userId: senderId,
      text,
      raw: {
        message_id: messageId,
        message: [{ type: 'text', data: { text } }],
        // Every sender uses a non-admin QQ role; only project config grants ADMIN to 456.
        sender: { role: 'member', nickname: 'astrbot-reminder-acceptance' },
      },
    };
  }

  async function dispatchCommand(senderId, command, diagnostic = null) {
    const messageId = `reminder-acceptance-${randomUUID()}`;
    const start = sends.length;
    const response = await bridge.dispatch(makeMessage(messageId, senderId, command));
    const text = sends.slice(start).filter((item) => item?.action === 'send_group_msg'
      && String(item?.params?.group_id) === GROUP_ID).map(sentText).join('\n');
    if (diagnostic) {
      recordCommandDiagnostic(diagnostic.key, response, text, messageId,
        diagnostic.expectedName, diagnostic.redactValues);
    }
    requireThat(response?.status === 'handled', 'ASTRBOT_REMINDER_COMMAND_NOT_HANDLED');
    requireThat(observedDispatches.has(messageId), 'ASTRBOT_REMINDER_RUNTIME_DISPATCH_MISSING');
    requireThat(text.length > 0, 'ASTRBOT_REMINDER_COMMAND_RESPONSE_MISSING');
    return text;
  }

  async function waitForJob(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await manager.job(id);
      requireThat(job && typeof job === 'object', 'ASTRBOT_REMINDER_JOB_NOT_FOUND');
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed') {
        const code = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(job.error?.code || ''))
          ? job.error.code : 'ASTRBOT_REMINDER_JOB_FAILED';
        throw fail(code);
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw fail('ASTRBOT_REMINDER_JOB_TIMEOUT');
  }

  async function installedMainHash(pluginId, generationId) {
    requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(String(pluginId || ''))
      && /^[A-Za-z0-9_-]{1,128}$/.test(String(generationId || '')),
    'ASTRBOT_REMINDER_GENERATION_INVALID');
    const generationRoot = path.resolve(STATE_ROOT, 'generations', generationId);
    const filename = path.resolve(generationRoot, 'data', 'plugins', pluginId, 'main.py');
    const api = process.platform === 'win32' ? path.win32 : path;
    const rel = api.relative(generationRoot, filename);
    requireThat(rel && !api.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${api.sep}`),
      'ASTRBOT_REMINDER_SOURCE_PATH_INVALID');
    await assertRegularFile(filename, 'ASTRBOT_REMINDER_INSTALLED_SOURCE_REQUIRED');
    return hashFile(filename);
  }

  async function captureInstalledMainHashBeforeCleanup(pluginId) {
    const current = (await manager.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!current) return false;
    const hash = await installedMainHash(pluginId, current.generationId);
    result.installedMainHashBeforeCleanup = hash;
    result.installedMainHashMatchesLockBeforeCleanup = hash === EXPECTED_MAIN_HASH
      && current.archiveSHA256 === EXPECTED_ARCHIVE_HASH
      && current.sourceSHA256 === EXPECTED_ARCHIVE_HASH;
    if (!result.installedMainHashAtInstall) {
      result.installedMainHashAtInstall = hash;
      result.installedMainHashMatchesLockAtInstall = result.installedMainHashMatchesLockBeforeCleanup;
    }
    result.pluginMainHashPreserved = result.installedMainHashMatchesLockAtInstall
      && result.installedMainHashMatchesLockBeforeCleanup
      && result.installedMainHashAtInstall === result.installedMainHashBeforeCleanup;
    return true;
  }

  async function waitUntil(predicate, timeoutMs, code) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw fail(code);
  }

  async function removeOwnedState() {
    const currentMarker = await fs.readFile(MARKER_PATH).catch(() => null);
    requireThat(Buffer.isBuffer(currentMarker) && currentMarker.equals(markerContent),
      'ASTRBOT_REMINDER_MARKER_CHANGED');
    const markerStat = await fs.lstat(MARKER_PATH);
    requireThat(markerStat.isFile() && !markerStat.isSymbolicLink(), 'ASTRBOT_REMINDER_MARKER_CHANGED');
    const directEntries = (await fs.readdir(STATE_DIR)).sort();
    const allowed = new Set([
      MARKER_NAME, 'samples', path.basename(CONFIG_PATH), path.basename(STATE_ROOT), SEND_DIAGNOSTICS_NAME,
    ]);
    requireThat(directEntries.includes(MARKER_NAME) && directEntries.includes('samples')
      && directEntries.every((entry) => allowed.has(entry)), 'ASTRBOT_REMINDER_UNEXPECTED_STATE_ENTRY');
    const samplesStat = await fs.lstat(path.join(STATE_DIR, 'samples'));
    requireThat(samplesStat.isDirectory() && !samplesStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_SAMPLE_DIRECTORY_CHANGED');
    await validateExistingSendDiagnosticsArtifact(path.join(STATE_DIR, SEND_DIAGNOSTICS_NAME));
    const configStat = await fs.lstat(CONFIG_PATH).catch(() => null);
    if (configStat) requireThat(configStat.isFile() && !configStat.isSymbolicLink(),
      'ASTRBOT_REMINDER_CONFIG_PATH_UNSAFE');
    const rootStat = await fs.lstat(STATE_ROOT).catch(() => null);
    if (rootStat) await assertRegularTree(STATE_ROOT);
    if (rootStat) await fs.rm(STATE_ROOT, { recursive: true, force: true });
    if (configStat) await fs.rm(CONFIG_PATH, { force: true });
    const remaining = await fs.readdir(STATE_DIR);
    requireThat(remaining.length === 2 + Number(remaining.includes(SEND_DIAGNOSTICS_NAME))
      && remaining.includes(MARKER_NAME) && remaining.includes('samples')
      && remaining.every((entry) => [MARKER_NAME, 'samples', SEND_DIAGNOSTICS_NAME].includes(entry)),
      'ASTRBOT_REMINDER_STATE_CLEANUP_INCOMPLETE');
    result.cleanup.isolatedStateRemoved = true;
  }

  async function main() {
    let phase = 'preflight';
    let modelRequests = 0;
    try {
      await preflight();
      phase = 'runtime';

      const [{ createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge },
        { assertAstrbotScheduledOrigin }] = await Promise.all([
        import('../src/astrbot-manager.mjs'),
        import('../src/astrbot-policy.mjs'),
        import('../src/astrbot-bridge.mjs'),
        import('../src/astrbot-outbound.mjs'),
      ]);
      const cfg = {
        stateDir: STATE_DIR,
        security: {
          allowGroups: true,
          allowGroupIds: [GROUP_ID],
          allowFrom: [PROJECT_ADMIN_ID],
          denyFrom: [],
          adminUserIds: [PROJECT_ADMIN_ID],
          allowGroupMembers: false,
        },
        astrbot: {
          enabled: true,
          runtimeMode: 'external',
          runtimeUrl: RUNTIME_URL,
          callbackUrl: CALLBACK_URL,
        },
      };
      const readConfig = () => cfg;
      manager = createAstrbotManager({
        projectRoot: APP_ROOT,
        configPath: CONFIG_PATH,
        readConfig,
        logger: () => {},
      });
      policy = createAstrbotPolicy({ root: APP_ROOT, readConfig });

      // Keep the manager pointed at the explicitly supplied isolated external runtime.
      priorRuntimeMode = process.env.ASTRBOT_RUNTIME_MODE;
      priorRuntimeUrl = process.env.ASTRBOT_RUNTIME_URL;
      process.env.ASTRBOT_RUNTIME_MODE = 'external';
      process.env.ASTRBOT_RUNTIME_URL = RUNTIME_URL;
      runtimeEnvOverridden = true;
      await manager.getToken({ create: false });
      const runtimeStatus = await manager.status();
      requireThat(runtimeStatus.runtimeMode === 'external' && runtimeStatus.externalHealth === true,
        'ASTRBOT_REMINDER_RUNTIME_HEALTH_NOT_READY');
      result.runtimeHealthReadyBeforeCollector = true;

      sends = [];
      bridge = createAstrbotBridge({
        root: APP_ROOT,
        readConfig,
        manager,
        policy,
        host: CALLBACK_HOST,
        port: CALLBACK_PORT,
        // The only outbound sink is this in-memory collector. No QQ client is created.
        send: async (action, params) => {
          sends.push({ at: Date.now(), action, params: structuredClone(params) });
          return { message_id: `reminder-acceptance-${sends.length}` };
        },
        generate: async () => {
          modelRequests += 1;
          throw fail('ASTRBOT_REMINDER_UNEXPECTED_MODEL_CALL');
        },
        logger: () => {},
      });
      await bridge.start();
      testStarted = true;
      await manager.start();
      const startedStatus = await manager.status();
      requireThat(startedStatus.runtimeMode === 'external' && startedStatus.externalHealth === true
        && startedStatus.running === true, 'ASTRBOT_REMINDER_RUNTIME_START_FAILED');
      result.runtimeWorkerStartedAfterCollector = true;

      originalRuntimeRpc = manager.runtimeRpc.bind(manager);
      manager.runtimeRpc = async (method, params, options) => {
        if (method === 'dispatch' && typeof params?.event?.messageId === 'string') {
          observedDispatches.add(params.event.messageId);
          lastDispatchedContextId = params.contextId;
        }
        return originalRuntimeRpc(method, params, options);
      };

      const archivePath = path.join(STATE_DIR, ARCHIVE_RELATIVE_PATH);
      const archive = await fs.readFile(archivePath);
      const install = await manager.install({ zipBase64: archive.toString('base64') });
      pendingInstall = install.id;
      const installedJob = await waitForJob(install.id, INSTALL_TIMEOUT_MS);
      pendingInstall = null;
      installedPluginId = installedJob.plugin;
      requireThat(installedPluginId === PLUGIN_ID, 'ASTRBOT_REMINDER_PLUGIN_ID_MISMATCH');

      const installedDefault = (await manager.listPlugins()).find((plugin) => plugin.id === installedPluginId);
      requireThat(installedDefault?.enabled === false, 'ASTRBOT_REMINDER_DEFAULT_NOT_DISABLED');
      result.installedDefaultOff = true;
      result.installedMainHashAtInstall = await installedMainHash(
        installedPluginId, installedDefault.generationId,
      );
      result.installedMainHashMatchesLockAtInstall = result.installedMainHashAtInstall === EXPECTED_MAIN_HASH;
      requireThat(installedDefault.archiveSHA256 === EXPECTED_ARCHIVE_HASH
        && installedDefault.sourceSHA256 === EXPECTED_ARCHIVE_HASH
        && result.installedMainHashMatchesLockAtInstall,
      'ASTRBOT_REMINDER_INSTALLED_SOURCE_HASH_MISMATCH');

      const enabled = await manager.configure(installedPluginId, {
        enabled: true,
        config: { whitelist: [CREATOR_ID] },
      });
      requireThat(enabled.enabled === true, 'ASTRBOT_REMINDER_ENABLE_FAILED');
      const enabledPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedPluginId);
      requireThat(enabledPlugin?.config?.whitelist?.length === 1
        && String(enabledPlugin.config.whitelist[0]) === CREATOR_ID,
      'ASTRBOT_REMINDER_WHITELIST_CONFIG_FAILED');
      result.pluginEnabled = true;
      policyTouched = true;
      await policy.setGroup(GROUP_ID, { pluginIds: [installedPluginId], chatMode: 'dsh' });
      await policy.setEnabled(true);

      const runTag = randomUUID().replaceAll('-', '').slice(0, 12);
      const reminderName = `native_${runTag}`;
      const reminderPayload = `native_reminder_${runTag}`;
      const reminderCron = '* * * * *';
      result.commandDiagnostics.reminderCreate.cronFieldsSent = reminderCron.split(/\s+/).length;
      result.commandDiagnostics.reminderCreate.executionLimit = 100;
      const addText = await dispatchCommand(CREATOR_ID,
        `/添加提醒 ${reminderName} [-100] ${reminderCron} ${reminderPayload}`,
        { key: 'reminderCreate', expectedName: reminderName, redactValues: [reminderPayload] });
      requireThat(addText.includes(`提醒 '${reminderName}' 添加成功`),
        'ASTRBOT_REMINDER_CREATE_NOT_CONFIRMED');
      const originalCreationContextId = lastDispatchedContextId;
      const creatorOrigin = await originSnapshot(originalCreationContextId);
      result.creatorAdminControl.status = 'running';
      requireThat(creatorOrigin.userId === CREATOR_ID && creatorOrigin.isAdmin === false
        && creatorOrigin.isGroup === true && creatorOrigin.groupId === GROUP_ID
        && creatorOrigin.pluginIds?.includes(installedPluginId)
        && creatorOrigin.scheduledAuthorization?.plugins?.[installedPluginId],
      'ASTRBOT_REMINDER_CREATOR_ORIGIN_INVALID');
      result.creatorAdminControl.creatorIsNonAdmin = true;

      const creatorView = await dispatchCommand(CREATOR_ID, `/查看提醒 ${reminderName}`);
      requireThat(creatorView.includes(`创建者ID: ${CREATOR_ID}`),
        'ASTRBOT_REMINDER_CREATOR_RECORD_MISSING');
      result.creatorWhitelistAllowed = true;

      const deniedText = await dispatchCommand(OUTSIDER_ID, `/删除提醒 ${reminderName}`);
      requireThat(deniedText.includes('没有权限'), 'ASTRBOT_REMINDER_OUTSIDER_NOT_DENIED');
      result.outsiderDenied = true;

      const adminView = await dispatchCommand(PROJECT_ADMIN_ID, `/查看提醒 ${reminderName}`);
      requireThat(adminView.includes(`提醒详情: ${reminderName}`)
        && adminView.includes(`创建者ID: ${CREATOR_ID}`),
      'ASTRBOT_REMINDER_ADMIN_VIEW_CHANGED_CREATOR');
      result.creatorAdminControl.adminViewAllowed = true;
      requireThat(JSON.stringify(await originSnapshot(originalCreationContextId)) === JSON.stringify(creatorOrigin),
        'ASTRBOT_REMINDER_ADMIN_CHANGED_ORIGINAL_CONTEXT');
      result.creatorAdminControl.originalCreatorContextUnchanged = true;
      result.creatorAdminControl.status = 'passed';

      phase = 'cold-restore';
      result.coldRestore.status = 'running';
      let workerPidBeforeRestart;
      if (COLD_RESTORE) {
        const beforeRestartHealth = await manager.runtimeRpc('health', {});
        workerPidBeforeRestart = beforeRestartHealth?.workerPid;
        requireThat(Number.isInteger(workerPidBeforeRestart),
          'ASTRBOT_REMINDER_WORKER_PID_UNAVAILABLE');
      }

      const dispatchCountBeforeRestart = observedDispatches.size;
      const restart = await manager.scheduleRuntime({ action: 'restart' });
      await waitForJob(restart.id, INSTALL_TIMEOUT_MS);
      result.restorePhaseDiagnostics.restartJobSucceeded = true;
      const restartCompletedAt = Date.now();

      if (COLD_RESTORE) {
        const afterRestartHealth = await manager.runtimeRpc('health', {});
        const workerPidAfterRestart = afterRestartHealth?.workerPid;
        requireThat(Number.isInteger(workerPidAfterRestart),
          'ASTRBOT_REMINDER_WORKER_PID_UNAVAILABLE');
        result.restorePhaseDiagnostics.runtimeProcessChanged =
          workerPidBeforeRestart !== workerPidAfterRestart;
        requireThat(result.restorePhaseDiagnostics.runtimeProcessChanged,
          'ASTRBOT_REMINDER_COLD_RESTART_PID_UNCHANGED');
      }

      try {
        const restartedStatus = await manager.status();
        result.restorePhaseDiagnostics.runtimeHealthyAfterRestart =
          restartedStatus.runtimeMode === 'external' && restartedStatus.externalHealth === true;
        result.restorePhaseDiagnostics.runtimeWorkerRunningAfterRestart =
          restartedStatus.runtimeMode === 'external' && restartedStatus.running === true;
      } catch (error) {
        result.restorePhaseDiagnostics.runtimeStatusProbeFailureCode = safeCode(error);
      }

      // A read-only group command distinguishes persisted reminder data from
      // an actual scheduled send blocked at the bridge provenance boundary.
      const probeRestoredReminder = async () => {
        try {
          const restoredView = await dispatchCommand(CREATOR_ID, `/查看提醒 ${reminderName}`);
          result.restorePhaseDiagnostics.reminderVisibleAfterRestart =
            restoredView.includes(`提醒详情: ${reminderName}`);
          result.restorePhaseDiagnostics.creatorRetainedAfterRestart =
            restoredView.includes(`创建者ID: ${CREATOR_ID}`);
          result.restorePhaseDiagnostics.group123RetainedAfterRestart =
            restoredView.includes(`👥 群聊 ${GROUP_ID}`);
          result.restorePhaseDiagnostics.cronRetainedAfterRestart =
            restoredView.includes(`定时规则: ${reminderCron}`);
        } catch (error) {
          result.restorePhaseDiagnostics.reminderViewProbeFailureCode = safeCode(error);
        }
      };
      await waitUntil(() => sends.some((item) => item.at >= restartCompletedAt
        && item.action === 'send_group_msg'
        && String(item.params?.group_id) === GROUP_ID
        && sentText(item).includes(reminderPayload)),
      EVENT_TIMEOUT_MS, 'ASTRBOT_REMINDER_RESTORE_EVENT_MISSING');
      result.group123ScheduledDeliveryAfterRestart = true;
      requireThat(observedDispatches.size === dispatchCountBeforeRestart,
        'ASTRBOT_REMINDER_COLD_RESTORE_WARMED_BY_DISPATCH');
      result.coldRestore.noDispatchBeforeFirstRestoredTimer = true;
      result.coldRestore.status = 'passed';
      await probeRestoredReminder();

      result.crossGroupPhaseStatus = 'running';
      const crossName = `cross_${runTag}`;
      const crossPayload = `native_cross_${runTag}`;
      const crossCron = '* * * * *';
      result.commandDiagnostics.crossGroupCreate.cronFieldsSent = crossCron.split(/\s+/).length;
      result.commandDiagnostics.crossGroupCreate.executionLimit = 1;
      result.commandDiagnostics.crossGroupCreate.targetGroupId = CROSS_GROUP_ID;
      const crossAddText = await dispatchCommand(CREATOR_ID,
        `/添加提醒 ${crossName} [-1] #${CROSS_GROUP_ID} ${crossCron} ${crossPayload}`,
        { key: 'crossGroupCreate', expectedName: crossName, redactValues: [crossPayload] });
      requireThat(crossAddText.includes(`提醒 '${crossName}' 添加成功`),
        'ASTRBOT_REMINDER_CROSS_GROUP_CREATE_NOT_CONFIRMED');

      let crossAttemptObserved = false;
      const crossDeadline = Date.now() + EVENT_TIMEOUT_MS;
      while (Date.now() < crossDeadline && !crossAttemptObserved) {
        const check = await dispatchCommand(CREATOR_ID, `/查看提醒 ${crossName}`);
        if (check.includes(`未找到名为 '${crossName}' 的提醒`)) {
          crossAttemptObserved = true;
          break;
        }
        requireThat(check.includes(`提醒详情: ${crossName}`),
          'ASTRBOT_REMINDER_CROSS_GROUP_STATE_UNREADABLE');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      requireThat(crossAttemptObserved, 'ASTRBOT_REMINDER_CROSS_GROUP_ATTEMPT_UNOBSERVED');
      result.crossGroupAttemptObserved = true;
      const leaked = sends.some((item) => item.action === 'send_group_msg'
        && String(item.params?.group_id) === CROSS_GROUP_ID
        && sentText(item).includes(crossPayload));
      requireThat(!leaked, 'ASTRBOT_REMINDER_CROSS_GROUP_DELIVERY_LEAK');
      result.noCrossGroupCollectorDelivery = true;
      result.crossGroupPhaseStatus = 'passed';

      phase = 'lifecycle-revocation';
      result.lifecycleRevocation.status = 'running';
      const originalPermission = await bridge.callback({ version: 1, method: 'tools.authorize',
        contextId: originalCreationContextId, pluginId: installedPluginId,
        params: { name: 'scheduled_acceptance_origin_probe', recordUse: false } });
      requireThat(originalPermission?.allowed === true, 'ASTRBOT_REMINDER_ORIGINAL_CONTEXT_NOT_AUTHORIZED');
      result.lifecycleRevocation.originalContextAuthorizedBeforeMutation = true;
      await manager.configure(installedPluginId, { config: enabledPlugin.config });
      const configuredDenial = await requireOriginalContextDenied(
        originalCreationContextId, assertAstrbotScheduledOrigin);
      result.lifecycleRevocation.sameConfigEpochDenied = configuredDenial.epochDenied;
      result.lifecycleRevocation.sameConfigCallbackDenied = configuredDenial.callbackDenied;
      await manager.configure(installedPluginId, { enabled: false });
      await manager.configure(installedPluginId, { enabled: true, config: enabledPlugin.config });
      const reenabledDenial = await requireOriginalContextDenied(
        originalCreationContextId, assertAstrbotScheduledOrigin);
      result.lifecycleRevocation.disableReenableEpochDenied = reenabledDenial.epochDenied;
      result.lifecycleRevocation.disableReenableCallbackDenied = reenabledDenial.callbackDenied;
      result.lifecycleRevocation.bridgeDenialCode = 'ASTRBOT_PERMISSION_DENIED';
      const freshView = await dispatchCommand(CREATOR_ID, `/查看提醒 ${reminderName}`);
      requireThat(freshView.includes(`提醒详情: ${reminderName}`)
        && freshView.includes(`创建者ID: ${CREATOR_ID}`)
        && JSON.stringify(await originSnapshot(originalCreationContextId)) === JSON.stringify(creatorOrigin),
      'ASTRBOT_REMINDER_REENABLED_FRESH_CONTEXT_FAILED');
      result.lifecycleRevocation.freshContextAllowedAfterReenable = true;
      result.lifecycleRevocation.status = 'passed';

      const adminDeleteText = await dispatchCommand(PROJECT_ADMIN_ID, `/删除提醒 ${reminderName}`);
      requireThat(adminDeleteText.includes(`提醒 '${reminderName}' 已删除`),
        'ASTRBOT_REMINDER_ADMIN_BYPASS_FAILED');
      result.adminBypassDeleted = true;

      const finalInstalled = (await manager.listPlugins()).find((plugin) => plugin.id === installedPluginId);
      result.installedMainHashBeforeCleanup = await installedMainHash(
        installedPluginId, finalInstalled?.generationId,
      );
      result.installedMainHashMatchesLockBeforeCleanup = result.installedMainHashBeforeCleanup === EXPECTED_MAIN_HASH
        && finalInstalled?.archiveSHA256 === EXPECTED_ARCHIVE_HASH
        && finalInstalled?.sourceSHA256 === EXPECTED_ARCHIVE_HASH;
      requireThat(finalInstalled?.enabled === true
        && finalInstalled.archiveSHA256 === EXPECTED_ARCHIVE_HASH
        && finalInstalled.sourceSHA256 === EXPECTED_ARCHIVE_HASH
        && result.installedMainHashMatchesLockBeforeCleanup
        && result.installedMainHashBeforeCleanup === result.installedMainHashAtInstall,
      'ASTRBOT_REMINDER_SOURCE_CHANGED_DURING_RUN');
      result.pluginMainHashPreserved = true;
      result.archiveUnchanged = await hashFile(archivePath) === initialArchiveHash;
      requireThat(result.archiveUnchanged, 'ASTRBOT_REMINDER_ARCHIVE_CHANGED_DURING_RUN');
    } catch (error) {
      addFailure(safeCode(error));
      for (const state of [result.creatorAdminControl, result.coldRestore, result.lifecycleRevocation]) {
        if (state.status === 'running') state.status = 'failed';
      }
      if (result.crossGroupPhaseStatus === 'running') {
        result.crossGroupPhaseStatus = 'failed';
      }
      if (phase === 'preflight') result.status = 'blocked';
    } finally {
      result.unexpectedModelCalls = modelRequests;
      if (modelRequests > 0) addFailure('ASTRBOT_REMINDER_UNEXPECTED_MODEL_CALL');

      if (Buffer.isBuffer(markerContent) && STATE_DIR && STATE_ROOT) {
        try { await writeSendDiagnosticsSnapshot(); }
        catch { result.sendDiagnosticsSnapshot.failureCode = 'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_CAPTURE_FAILED'; }
      } else {
        result.sendDiagnosticsSnapshot.failureCode = 'ASTRBOT_REMINDER_SEND_DIAGNOSTIC_CAPTURE_NOT_SAFE';
      }

      if (manager && installedPluginId) {
        try { await captureInstalledMainHashBeforeCleanup(installedPluginId); }
        catch (error) { result.installedMainHashCaptureFailureCode = safeCode(error); }
      }

      if (policy && policyTouched) {
        try { await policy.setEnabled(false); }
        catch (error) { addFailure(safeCode(error), true); }
        try { await policy.removeGroup(GROUP_ID); }
        catch (error) { addFailure(safeCode(error), true); }
      }

      if (manager && installedPluginId) {
        try {
          const current = (await manager.listPlugins()).find((plugin) => plugin.id === installedPluginId);
          if (current?.enabled) await manager.configure(installedPluginId, { enabled: false });
          const removed = await manager.uninstall(installedPluginId, { purgeData: true });
          result.cleanup.reminderPluginUninstalled = removed?.uninstalled === true;
          result.cleanup.reminderDataPurged = removed?.dataPurged === true;
          if (!result.cleanup.reminderPluginUninstalled || !result.cleanup.reminderDataPurged) {
            addFailure('ASTRBOT_REMINDER_PLUGIN_CLEANUP_INCOMPLETE', true);
          }
        } catch (error) { addFailure(safeCode(error), true); }
      }

      if (manager && pendingInstall) {
        try {
          const settled = await waitForJob(pendingInstall, 3 * 60 * 1000);
          pendingInstall = null;
          if (settled.status === 'succeeded' && typeof settled.plugin === 'string') {
            installedPluginId = settled.plugin;
            try { await captureInstalledMainHashBeforeCleanup(installedPluginId); }
            catch (error) { result.installedMainHashCaptureFailureCode = safeCode(error); }
            const current = (await manager.listPlugins()).find((plugin) => plugin.id === installedPluginId);
            if (current?.enabled) await manager.configure(installedPluginId, { enabled: false });
            const removed = await manager.uninstall(installedPluginId, { purgeData: true });
            result.cleanup.reminderPluginUninstalled = removed?.uninstalled === true;
            result.cleanup.reminderDataPurged = removed?.dataPurged === true;
          }
        } catch (error) {
          addFailure(safeCode(error) === 'ASTRBOT_REMINDER_JOB_TIMEOUT'
            ? 'ASTRBOT_REMINDER_INSTALL_STILL_ACTIVE' : safeCode(error), true);
        }
      }

      if (manager && testStarted) {
        try {
          const stopped = await manager.stop();
          result.cleanup.runtimeWorkerStopped = stopped?.stopped === true;
          if (!result.cleanup.runtimeWorkerStopped) addFailure('ASTRBOT_REMINDER_RUNTIME_STOP_FAILED', true);
        } catch (error) { addFailure(safeCode(error), true); }
      }
      if (bridge) {
        try {
          await bridge.stop();
          result.cleanup.callbackStopped = true;
        } catch (error) { addFailure(safeCode(error), true); }
      }
      if (manager && originalRuntimeRpc) manager.runtimeRpc = originalRuntimeRpc;

      if (result.cleanup.runtimeWorkerStopped && result.cleanup.callbackStopped && !pendingInstall
        && Buffer.isBuffer(markerContent) && STATE_DIR && STATE_ROOT) {
        try { await removeOwnedState(); }
        catch (error) { addFailure(safeCode(error), true); }
      }
      if (runtimeEnvOverridden) {
        if (priorRuntimeMode === undefined) delete process.env.ASTRBOT_RUNTIME_MODE;
        else process.env.ASTRBOT_RUNTIME_MODE = priorRuntimeMode;
        if (priorRuntimeUrl === undefined) delete process.env.ASTRBOT_RUNTIME_URL;
        else process.env.ASTRBOT_RUNTIME_URL = priorRuntimeUrl;
      }

      if (MARKER_PATH && Buffer.isBuffer(markerContent)) {
        try {
          const archivePath = path.join(STATE_DIR, ARCHIVE_RELATIVE_PATH);
          await assertRegularFile(archivePath, 'ASTRBOT_REMINDER_ARCHIVE_PATH_CHANGED');
          result.archiveUnchanged = typeof initialArchiveHash === 'string'
            && await hashFile(archivePath) === initialArchiveHash;
        } catch { result.archiveUnchanged = false; }
      }
      if (testStarted && result.unexpectedModelCalls === 0 && !result.pluginMainHashPreserved) {
        addFailure('ASTRBOT_REMINDER_SOURCE_PRESERVATION_UNVERIFIED');
      }
    }

    if (result.failureCodes.length || result.cleanupFailureCodes.length) {
      result.status = result.status === 'blocked' && !testStarted
        && result.cleanupFailureCodes.length === 0 ? 'blocked' : 'failed';
    } else {
      result.status = 'passed';
    }
    if (result.status === 'passed' && (!result.runtimeHealthReadyBeforeCollector
      || !result.runtimeWorkerStartedAfterCollector
      || !result.archiveLocked || !result.archiveUnchanged
      || !result.installedDefaultOff || !result.pluginEnabled || !result.creatorWhitelistAllowed
      || !result.outsiderDenied || !result.adminBypassDeleted
      || result.creatorAdminControl.status !== 'passed'
      || result.coldRestore.status !== 'passed' || !result.coldRestore.optIn
      || !result.coldRestore.noDispatchBeforeFirstRestoredTimer
      || result.restorePhaseDiagnostics.runtimeProcessChanged !== true
      || !result.restorePhaseDiagnostics.runtimeHealthyAfterRestart
      || !result.restorePhaseDiagnostics.runtimeWorkerRunningAfterRestart
      || !result.restorePhaseDiagnostics.reminderVisibleAfterRestart
      || !result.restorePhaseDiagnostics.creatorRetainedAfterRestart
      || !result.restorePhaseDiagnostics.group123RetainedAfterRestart
      || !result.restorePhaseDiagnostics.cronRetainedAfterRestart
      || result.lifecycleRevocation.status !== 'passed'
      || !result.group123ScheduledDeliveryAfterRestart || !result.crossGroupAttemptObserved
      || !result.noCrossGroupCollectorDelivery || !result.pluginMainHashPreserved
      || result.unexpectedModelCalls !== 0 || !result.cleanup.reminderPluginUninstalled
      || !result.cleanup.reminderDataPurged || !result.cleanup.runtimeWorkerStopped
      || !result.cleanup.callbackStopped || !result.cleanup.isolatedStateRemoved)) {
      addFailure('ASTRBOT_REMINDER_ACCEPTANCE_INCOMPLETE');
      result.status = 'failed';
    }
    if (result.status !== 'passed') process.exitCode = 1;
    console.log(JSON.stringify(result));
  }

  await main();
}
