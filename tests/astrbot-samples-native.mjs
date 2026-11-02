if (process.env.ASTRBOT_NATIVE_TEST !== '1') {
  console.log('AstrBot locked-sample acceptance skipped; set ASTRBOT_NATIVE_TEST=1 to opt in.');
} else {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const { inflateRawSync } = await import('node:zlib');

  const APP_ROOT_ENV = process.env.ASTRBOT_SAMPLE_APP_ROOT;
  const STATE_DIR_ENV = process.env.ASTRBOT_SAMPLE_STATE_DIR;
  const CALLBACK_URL_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_URL;
  const CALLBACK_HOST_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_HOST;
  const CALLBACK_PORT_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_PORT;
  let APP_ROOT;
  let STATE_DIR;
  let CALLBACK_URL;
  let CALLBACK_HOST;
  let CALLBACK_PORT;
  let MARKER_PATH;
  let SAMPLES_DIR;
  let MANIFEST_PATH;
  const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
  const MAX_MAIN_BYTES = 4 * 1024 * 1024;
  const MAX_METADATA_BYTES = 128 * 1024;
  const GROUP_ID = '123';
  const PROJECT_ADMIN_ID = '456';
  const GROUP_MEMBER_ID = '789';
  const RUNTIME_URL = process.env.ASTRBOT_RUNTIME_URL || 'http://astrbot:5831';

  const INSTALL_TIMEOUT_MS = boundedTimeout(process.env.ASTRBOT_SAMPLE_INSTALL_TIMEOUT_MS);
  const SAMPLE_SPECS = [
    { key: 'helloworld', repository: 'https://github.com/Soulter/helloworld', commands: ['/helloworld'] },
    { key: 'randommeme', repository: 'https://github.com/konley/astrbot_plugin_randommeme',
      commands: ['/表情 帮助', '/表情 列表'] },
    { key: 'reminder', repository: 'https://github.com/Foolllll-J/astrbot_plugin_reminder',
      commands: ['/查看任务', '/查看提醒'] },
    { key: 'weather', repository: 'https://github.com/zzby-poi/astrbot_plugin_weather',
      commands: ['/天气 查询 北京'] },
  ];
  const WEATHER_CONFIG = {
    api_settings: {
      api_base_url: 'http://127.0.0.1:9/api/v1/misc/weather',
      api_key: '',
      timeout_seconds: 2,
      lang: 'zh',
    },
    push_settings: {
      enable_daily_push: false,
      enable_llm_message: false,
    },
    monitor_settings: { enable_monitor: false },
    query_settings: { enable_ai_intent_detection: false },
  };

  function boundedTimeout(raw) {
    if (raw === undefined || raw === '') return 10 * 60 * 1000;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 30_000 || value > 20 * 60 * 1000) {
      return 10 * 60 * 1000;
    }
    return value;
  }

  function acceptanceError(code) {
    return Object.assign(new Error(code), { code });
  }

  function requireThat(value, code) {
    if (!value) throw acceptanceError(code);
  }

  function absoluteDirectory(raw, code) {
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.trim() === raw, code);
    if (process.platform === 'win32') {
      const root = path.win32.parse(raw).root.replaceAll('/', '\\');
      const driveQualified = root.length >= 3 && root[1] === ':' && root[2] === '\\';
      const uncQualified = root.charCodeAt(0) === 92 && root.charCodeAt(1) === 92
        && root.slice(2).split('\\').filter(Boolean).length >= 2;
      const fullyQualified = driveQualified || uncQualified;
      requireThat(path.win32.isAbsolute(raw) && fullyQualified, code);
      return path.win32.resolve(raw);
    }
    requireThat(path.isAbsolute(raw), code);
    return path.resolve(raw);
  }

  function boundedPort(raw, fallback, code) {
    if (raw === undefined) return fallback;
    requireThat(typeof raw === 'string' && /^\d{1,5}$/.test(raw), code);
    const value = Number(raw);
    requireThat(Number.isSafeInteger(value) && value >= 1 && value <= 65535, code);
    return value;
  }

  function callbackUrl(raw) {
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.trim() === raw
      && raw.length <= 2048, 'ASTRBOT_SAMPLE_CALLBACK_URL_INVALID');
    let parsed;
    try { parsed = new URL(raw); }
    catch { throw acceptanceError('ASTRBOT_SAMPLE_CALLBACK_URL_INVALID'); }
    requireThat(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.length > 0
      && !parsed.username && !parsed.password && parsed.pathname === '/rpc/callback'
      && !parsed.search && !parsed.hash,
    'ASTRBOT_SAMPLE_CALLBACK_URL_INVALID');
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
    requireThat(Number.isSafeInteger(port) && port >= 1 && port <= 65535,
      'ASTRBOT_SAMPLE_CALLBACK_URL_INVALID');
    return raw;
  }

  function callbackHost(raw) {
    const hasInvalidCharacter = typeof raw === 'string' && [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || code === 0x2f
        || code === 0x5c || code === 0x3f || code === 0x23;
    });
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.length <= 255
      && raw.trim() === raw && !hasInvalidCharacter,
    'ASTRBOT_SAMPLE_CALLBACK_HOST_INVALID');
    return raw;
  }

  function configureSamplePaths() {
    if (process.platform === 'win32') {
      requireThat(typeof APP_ROOT_ENV === 'string' && APP_ROOT_ENV.length > 0
        && typeof STATE_DIR_ENV === 'string' && STATE_DIR_ENV.length > 0
        && typeof CALLBACK_URL_ENV === 'string' && CALLBACK_URL_ENV.length > 0,
      'ASTRBOT_SAMPLE_WINDOWS_OVERRIDES_REQUIRED');
    }
    APP_ROOT = absoluteDirectory(APP_ROOT_ENV ?? '/app', 'ASTRBOT_SAMPLE_APP_ROOT_INVALID');
    STATE_DIR = absoluteDirectory(STATE_DIR_ENV ?? '/app/state', 'ASTRBOT_SAMPLE_STATE_DIR_INVALID');
    const comparablePath = (value) => process.platform === 'win32'
      ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
    requireThat(comparablePath(APP_ROOT) !== comparablePath(STATE_DIR),
      'ASTRBOT_SAMPLE_STATE_ROOT_INVALID');
    CALLBACK_URL = callbackUrl(CALLBACK_URL_ENV ?? 'http://acceptance:5832/rpc/callback');
    CALLBACK_HOST = callbackHost(CALLBACK_HOST_ENV ?? '0.0.0.0');
    CALLBACK_PORT = boundedPort(CALLBACK_PORT_ENV, 5832, 'ASTRBOT_SAMPLE_CALLBACK_PORT_INVALID');
    MARKER_PATH = path.join(STATE_DIR, '.astrbot-acceptance-only');
    SAMPLES_DIR = path.join(STATE_DIR, 'samples');
    MANIFEST_PATH = path.join(APP_ROOT, 'runtime', 'astrbot-samples.json');
  }

  function safeErrorCode(error) {
    const value = String(error?.code || '');
    return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(value) ? value : 'ASTRBOT_SAMPLE_UNEXPECTED_ERROR';
  }

  function addFailure(result, code) {
    const safe = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(code || ''))
      ? String(code) : 'ASTRBOT_SAMPLE_UNEXPECTED_ERROR';
    if (!result.failureCodes.includes(safe)) result.failureCodes.push(safe);
  }

  function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function decodeUtf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw acceptanceError('ASTRBOT_SAMPLE_ARCHIVE_INVALID'); }
  }

  function zipEntries(archive) {
    requireThat(Buffer.isBuffer(archive) && archive.length >= 22
      && archive.length <= MAX_ARCHIVE_BYTES, 'ASTRBOT_SAMPLE_ARCHIVE_SIZE_INVALID');
    const searchStart = Math.max(0, archive.length - 22 - 0xffff);
    let eocd = -1;
    for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
      if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    requireThat(eocd >= 0 && eocd + 22 <= archive.length,
      'ASTRBOT_SAMPLE_ARCHIVE_INVALID');

    const diskNumber = archive.readUInt16LE(eocd + 4);
    const directoryDisk = archive.readUInt16LE(eocd + 6);
    const entriesOnDisk = archive.readUInt16LE(eocd + 8);
    const entryCount = archive.readUInt16LE(eocd + 10);
    const directorySize = archive.readUInt32LE(eocd + 12);
    const directoryOffset = archive.readUInt32LE(eocd + 16);
    const commentLength = archive.readUInt16LE(eocd + 20);
    requireThat(diskNumber === 0 && directoryDisk === 0 && entriesOnDisk === entryCount
      && entryCount > 0 && entryCount <= 10_000
      && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff
      && eocd + 22 + commentLength === archive.length
      && directoryOffset + directorySize <= eocd,
    'ASTRBOT_SAMPLE_ARCHIVE_LAYOUT_UNSUPPORTED');

    const entries = [];
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      requireThat(offset + 46 <= directoryOffset + directorySize
        && archive.readUInt32LE(offset) === 0x02014b50,
      'ASTRBOT_SAMPLE_ARCHIVE_INVALID');
      const flags = archive.readUInt16LE(offset + 8);
      const method = archive.readUInt16LE(offset + 10);
      const expectedCrc = archive.readUInt32LE(offset + 16);
      const compressedSize = archive.readUInt32LE(offset + 20);
      const expandedSize = archive.readUInt32LE(offset + 24);
      const nameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentSize = archive.readUInt16LE(offset + 32);
      const diskStart = archive.readUInt16LE(offset + 34);
      const localOffset = archive.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentSize;
      requireThat(nameLength > 0 && end <= directoryOffset + directorySize
        && compressedSize !== 0xffffffff && expandedSize !== 0xffffffff
        && localOffset !== 0xffffffff && diskStart === 0
        && (flags & 1) === 0 && [0, 8].includes(method),
      'ASTRBOT_SAMPLE_ARCHIVE_ENTRY_UNSUPPORTED');
      const name = decodeUtf8(archive.subarray(offset + 46, offset + 46 + nameLength));
      entries.push({ name, flags, method, expectedCrc, compressedSize, expandedSize, localOffset });
      offset = end;
    }
    requireThat(offset === directoryOffset + directorySize,
      'ASTRBOT_SAMPLE_ARCHIVE_INVALID');
    const roots = new Set(entries.map((entry) => entry.name.split('/')[0]));
    requireThat(roots.size === 1 && ![...roots][0].includes('\\'),
      'ASTRBOT_SAMPLE_ARCHIVE_ROOT_INVALID');
    return { root: [...roots][0], entries };
  }

  function readZipEntry(archive, entry, maxBytes) {
    requireThat(entry && entry.expandedSize <= maxBytes,
      'ASTRBOT_SAMPLE_ARCHIVE_ENTRY_TOO_LARGE');
    const offset = entry.localOffset;
    requireThat(offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50,
      'ASTRBOT_SAMPLE_ARCHIVE_INVALID');
    const localFlags = archive.readUInt16LE(offset + 6);
    const localMethod = archive.readUInt16LE(offset + 8);
    const localNameLength = archive.readUInt16LE(offset + 26);
    const localExtraLength = archive.readUInt16LE(offset + 28);
    const localNameEnd = offset + 30 + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    requireThat(localNameEnd <= archive.length && dataStart <= archive.length
      && dataEnd <= archive.length && localFlags === entry.flags && localMethod === entry.method
      && decodeUtf8(archive.subarray(offset + 30, localNameEnd)) === entry.name,
    'ASTRBOT_SAMPLE_ARCHIVE_INVALID');
    const compressed = archive.subarray(dataStart, dataEnd);
    let expanded;
    try {
      expanded = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch {
      throw acceptanceError('ASTRBOT_SAMPLE_ARCHIVE_ENTRY_INVALID');
    }
    requireThat(expanded.length === entry.expandedSize && crc32(expanded) === entry.expectedCrc,
      'ASTRBOT_SAMPLE_ARCHIVE_ENTRY_INVALID');
    return expanded;
  }

  function pluginNameFromMetadata(metadataBytes) {
    const text = decodeUtf8(metadataBytes);
    const match = text.match(/^name:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))/m);
    const name = match?.[1] || match?.[2] || match?.[3] || '';
    requireThat(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name)
      && !['__ai__', '__proto__', 'constructor', 'prototype'].includes(name),
    'ASTRBOT_SAMPLE_PLUGIN_NAME_INVALID');
    return name;
  }

  async function preflightSample(spec, lockEntries) {
    const expected = lockEntries.find((item) => item.repository === spec.repository);
    requireThat(expected && /^[a-f0-9]{64}$/i.test(expected.archiveSHA256)
      && /^[a-f0-9]{64}$/i.test(expected.mainPySHA256),
    'ASTRBOT_SAMPLE_LOCK_ENTRY_MISSING');
    const archivePath = path.join(SAMPLES_DIR, `${spec.key}.zip`);
    const stat = await fs.lstat(archivePath).catch(() => null);
    requireThat(stat?.isFile() && !stat.isSymbolicLink(), 'ASTRBOT_SAMPLE_ARCHIVE_REQUIRED');
    const archive = await fs.readFile(archivePath);
    requireThat(sha256(archive) === expected.archiveSHA256.toLowerCase(),
      'ASTRBOT_SAMPLE_ARCHIVE_HASH_MISMATCH');
    const directory = zipEntries(archive);
    const mains = directory.entries.filter((entry) => entry.name.endsWith('/main.py')
      && entry.name.split('/').length === 2);
    const metadata = directory.entries.filter((entry) => entry.name === `${directory.root}/metadata.yaml`);
    requireThat(mains.length === 1 && mains[0].name === `${directory.root}/main.py`
      && metadata.length === 1, 'ASTRBOT_SAMPLE_ARCHIVE_LAYOUT_INVALID');
    const mainBytes = readZipEntry(archive, mains[0], MAX_MAIN_BYTES);
    requireThat(sha256(mainBytes) === expected.mainPySHA256.toLowerCase(),
      'ASTRBOT_SAMPLE_MAIN_HASH_MISMATCH');
    const pluginId = pluginNameFromMetadata(readZipEntry(archive, metadata[0], MAX_METADATA_BYTES));
    return { archive, archivePath, expected, pluginId };
  }

  function createSampleResult(spec) {
    return {
      sample: spec.key,
      status: 'not-run',
      pluginId: null,
      installed: false,
      default_installed_off: false,
      enabled: false,
      hashes: { preInstall: false, installedMainPy: false, preservedAfterEnable: false },
      loaded: false,
      dispatched: [],
      external_api: 'not-tested',
      QQ: 'not-tested',
      failureCodes: [],
      cleanup: { disabledAtEnd: false },
    };
  }

  function message(messageId, text) {
    return {
      messageType: 'group',
      groupId: GROUP_ID,
      userId: GROUP_MEMBER_ID,
      text,
      raw: {
        message_id: messageId,
        message: [{ type: 'text', data: { text } }],
        // QQ group role is deliberately non-authoritative; project admin is 456.
        sender: { role: 'owner', nickname: 'astrbot-sample-acceptance' },
      },
    };
  }

  function sentText(item) {
    const messageValue = item?.params?.message;
    if (typeof messageValue === 'string') return messageValue;
    const parts = Array.isArray(messageValue) ? messageValue : [];
    return parts.filter((part) => part?.type === 'text' && typeof part?.data?.text === 'string')
      .map((part) => part.data.text).join('');
  }

  async function waitForJob(manager, id, timeoutMs = INSTALL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await manager.job(id);
      requireThat(job && typeof job === 'object', 'ASTRBOT_SAMPLE_JOB_NOT_FOUND');
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed') {
        const code = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(job.error?.code || ''))
          ? job.error.code : 'ASTRBOT_SAMPLE_INSTALL_FAILED';
        throw acceptanceError(code);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw acceptanceError('ASTRBOT_SAMPLE_INSTALL_TIMEOUT');
  }

  async function installedMainHash(pluginId, generationId) {
    requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(String(pluginId || ''))
      && /^[A-Za-z0-9_-]{1,128}$/.test(String(generationId || '')),
    'ASTRBOT_SAMPLE_GENERATION_INVALID');
    const generationRoot = path.resolve(STATE_DIR, 'astrbot', 'generations', generationId);
    const filename = path.resolve(generationRoot, 'data', 'plugins', pluginId, 'main.py');
    requireThat(filename.startsWith(generationRoot + path.sep),
      'ASTRBOT_SAMPLE_SOURCE_PATH_INVALID');
    const stat = await fs.lstat(filename).catch(() => null);
    requireThat(stat?.isFile() && !stat.isSymbolicLink(), 'ASTRBOT_SAMPLE_SOURCE_REQUIRED');
    return sha256(await fs.readFile(filename));
  }

  async function checkDispatch({ bridge, sends, observedDispatches, result, sample, command, runId, sequence }) {
    const messageId = `${runId}-${sample}-${sequence}`;
    const sendStart = sends.length;
    const dispatchStart = observedDispatches.length;
    const dispatch = { command, messageId, status: 'failed', runtime_dispatch: false, collector_send: false };
    try {
      const response = await bridge.dispatch(message(messageId, command));
      dispatch.status = String(response?.status || 'unknown');
      dispatch.runtime_dispatch = observedDispatches.slice(dispatchStart).includes(messageId);
      const outputs = sends.slice(sendStart).filter((item) => item?.action === 'send_group_msg'
        && String(item?.params?.group_id) === GROUP_ID && sentText(item).trim().length > 0);
      dispatch.collector_send = outputs.length > 0;
      if (response?.status !== 'handled') addFailure(result, 'ASTRBOT_SAMPLE_COMMAND_NOT_HANDLED');
      if (!dispatch.runtime_dispatch) addFailure(result, 'ASTRBOT_SAMPLE_RUNTIME_DISPATCH_MISSING');
      if (!dispatch.collector_send) addFailure(result, 'ASTRBOT_SAMPLE_MEANINGFUL_SEND_MISSING');
    } catch (error) {
      addFailure(result, safeErrorCode(error));
    }
    result.dispatched.push(dispatch);
  }

  async function main() {
    const results = SAMPLE_SPECS.map(createSampleResult);
    const runId = randomUUID();
    const cleanupCodes = [];
    const globalCodes = [];
    const ownedPluginIds = new Set();
    let manager;
    let policy;
    let bridge;
    let bridgeStarted = false;
    let policySnapshot;
    let observedDispatches = [];
    let originalRuntimeRpc;
    let pendingInstall = null;
    let modelRequests = 0;
    let stopMatrixAfterTimeout = false;

    try {
      configureSamplePaths();
      const stateRootStat = await fs.lstat(STATE_DIR).catch(() => null);
      requireThat(stateRootStat?.isDirectory() && !stateRootStat.isSymbolicLink(),
        'ASTRBOT_SAMPLE_STATE_ROOT_REQUIRED');
      const marker = await fs.lstat(MARKER_PATH).catch(() => null);
      requireThat(marker?.isFile() && !marker.isSymbolicLink(),
        'ASTRBOT_ACCEPTANCE_MARKER_REQUIRED');
      const samplesStat = await fs.lstat(SAMPLES_DIR).catch(() => null);
      requireThat(samplesStat?.isDirectory() && !samplesStat.isSymbolicLink(),
        'ASTRBOT_SAMPLE_DIRECTORY_REQUIRED');
      requireThat(!process.env.ASTRBOT_RUNTIME_MODE || process.env.ASTRBOT_RUNTIME_MODE === 'external',
        'ASTRBOT_ACCEPTANCE_EXTERNAL_MODE_REQUIRED');
      requireThat(/^https?:\/\//i.test(RUNTIME_URL), 'ASTRBOT_ACCEPTANCE_RUNTIME_URL_INVALID');
      const manifestStat = await fs.lstat(MANIFEST_PATH).catch(() => null);
      requireThat(manifestStat?.isFile() && !manifestStat.isSymbolicLink(),
        'ASTRBOT_SAMPLE_LOCK_REQUIRED');
      const manifestBytes = await fs.readFile(MANIFEST_PATH);
      requireThat(manifestBytes.length <= 1024 * 1024, 'ASTRBOT_SAMPLE_LOCK_INVALID');
      const lock = JSON.parse(manifestBytes.toString('utf8'));
      requireThat(lock?.schemaVersion === 1 && Array.isArray(lock.samples)
        && lock.samples.length === SAMPLE_SPECS.length,
      'ASTRBOT_SAMPLE_LOCK_INVALID');
      const lockEntries = lock.samples;
      for (const spec of SAMPLE_SPECS) {
        requireThat(lockEntries.filter((item) => item.repository === spec.repository).length === 1,
          'ASTRBOT_SAMPLE_LOCK_ENTRY_MISSING');
      }

      const [{ createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge }] = await Promise.all([
        import('../src/astrbot-manager.mjs'),
        import('../src/astrbot-policy.mjs'),
        import('../src/astrbot-bridge.mjs'),
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
        configPath: path.join(STATE_DIR, 'astrbot-samples-native-config.json'),
        readConfig,
        logger: () => {},
      });
      policy = createAstrbotPolicy({ root: APP_ROOT, readConfig });
      const sends = [];
      bridge = createAstrbotBridge({
        root: APP_ROOT,
        readConfig,
        manager,
        policy,
        host: CALLBACK_HOST,
        port: CALLBACK_PORT,
        // This collector is the only message sink; no QQ connection is created.
        send: async (action, params) => {
          sends.push({ action, params: structuredClone(params) });
          return { message_id: `sample-acceptance-${sends.length}` };
        },
        generate: async () => {
          modelRequests += 1;
          return {
            id: 'astrbot-sample-local-model-stub',
            object: 'chat.completion',
            created: 0,
            model: 'astrbot-sample-local-model-stub',
            choices: [{ index: 0, message: { role: 'assistant', content: 'controlled-local-response' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
        logger: () => {},
      });

      // Never create a missing shared token. Snapshot group 123 so cleanup can restore it.
      await manager.getToken({ create: false });
      policySnapshot = await policy.get();
      await bridge.start();
      bridgeStarted = true;
      await policy.setEnabled(false);
      originalRuntimeRpc = manager.runtimeRpc.bind(manager);
      manager.runtimeRpc = async (method, params, options) => {
        if (method === 'dispatch') observedDispatches.push(params?.event?.messageId);
        return originalRuntimeRpc(method, params, options);
      };

      let sequence = 0;
      for (const spec of SAMPLE_SPECS) {
        const result = results.find((item) => item.sample === spec.key);
        console.log(JSON.stringify({ type: 'astrbot-sample-start', sample: spec.key }));
        if (stopMatrixAfterTimeout) {
          result.status = 'blocked';
          addFailure(result, 'ASTRBOT_SAMPLE_PREVIOUS_INSTALL_STILL_ACTIVE');
          continue;
        }
        let installedId = null;
        const modelCallsBeforeSample = modelRequests;
        try {
          const prepared = await preflightSample(spec, lockEntries);
          result.hashes.preInstall = true;
          result.hashes.archiveSHA256 = prepared.expected.archiveSHA256.toLowerCase();
          result.hashes.mainPySHA256 = prepared.expected.mainPySHA256.toLowerCase();
          const current = await manager.listPlugins();
          requireThat(!current.some((plugin) => plugin.id === prepared.pluginId
            || plugin.metadata?.name === prepared.pluginId),
          'ASTRBOT_SAMPLE_PLUGIN_ALREADY_PRESENT');

          const install = await manager.install({ zipBase64: prepared.archive.toString('base64') });
          pendingInstall = { id: install.id, sample: spec.key };
          console.log(JSON.stringify({ type: 'astrbot-sample-install-queued', sample: spec.key }));
          let job;
          try {
            job = await waitForJob(manager, install.id);
            pendingInstall = null;
          } catch (error) {
            if (safeErrorCode(error) !== 'ASTRBOT_SAMPLE_INSTALL_TIMEOUT') pendingInstall = null;
            throw error;
          }
          requireThat(job.status === 'succeeded' && typeof job.plugin === 'string',
            'ASTRBOT_SAMPLE_INSTALL_FAILED');
          installedId = job.plugin;
          result.pluginId = installedId;
          ownedPluginIds.add(installedId);
          result.installed = true;
          const afterInstall = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
          requireThat(afterInstall && afterInstall.enabled === false,
            'ASTRBOT_SAMPLE_PLUGIN_MUST_DEFAULT_OFF');
          result.default_installed_off = afterInstall.enabled === false;
          requireThat(afterInstall.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && afterInstall.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && job.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase(),
          'ASTRBOT_SAMPLE_ARCHIVE_HASH_AFTER_INSTALL_MISMATCH');
          requireThat(await installedMainHash(installedId, afterInstall.generationId)
            === prepared.expected.mainPySHA256.toLowerCase(),
          'ASTRBOT_SAMPLE_MAIN_HASH_AFTER_INSTALL_MISMATCH');
          result.hashes.installedMainPy = true;

          const config = spec.key === 'weather' ? WEATHER_CONFIG : undefined;
          await manager.configure(installedId, {
            enabled: true,
            ...(config ? { config } : {}),
          });
          const enabledPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
          requireThat(enabledPlugin?.enabled === true, 'ASTRBOT_SAMPLE_PLUGIN_ENABLE_FAILED');
          result.enabled = true;
          result.loaded = true;
          requireThat(enabledPlugin.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && enabledPlugin.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && await installedMainHash(installedId, enabledPlugin.generationId)
              === prepared.expected.mainPySHA256.toLowerCase(),
          'ASTRBOT_SAMPLE_SOURCE_CHANGED_AFTER_ENABLE');
          result.hashes.preservedAfterEnable = true;

          await policy.setGroup(GROUP_ID, { pluginIds: [installedId], chatMode: 'dsh' });
          await policy.setEnabled(true);
          for (const command of spec.commands) {
            sequence += 1;
            await checkDispatch({
              bridge,
              sends,
              observedDispatches,
              result,
              sample: spec.key,
              command,
              runId,
              sequence,
            });
          }
          if (spec.key === 'weather') {
            result.local_api_probe = 'loopback-port-9-no-key';
            if (modelRequests !== modelCallsBeforeSample) {
              addFailure(result, 'ASTRBOT_SAMPLE_WEATHER_MODEL_DISABLED_FAILED');
            }
          }
          if (!result.dispatched.some((item) => item.runtime_dispatch && item.collector_send)) {
            addFailure(result, 'ASTRBOT_SAMPLE_NO_MEANINGFUL_SEND');
          }
        } catch (error) {
          addFailure(result, safeErrorCode(error));
          if (safeErrorCode(error) === 'ASTRBOT_SAMPLE_INSTALL_TIMEOUT') stopMatrixAfterTimeout = true;
        } finally {
          try { await policy.setEnabled(false); }
          catch (error) { addFailure(result, safeErrorCode(error)); }
          if (installedId) {
            try {
              const currentPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
              if (currentPlugin?.enabled) await manager.configure(installedId, { enabled: false });
              const disabledPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
              result.cleanup.disabledAtEnd = disabledPlugin?.enabled === false;
              result.enabled = disabledPlugin?.enabled === true;
              if (!result.cleanup.disabledAtEnd) addFailure(result, 'ASTRBOT_SAMPLE_DISABLE_CLEANUP_FAILED');
            } catch (error) {
              addFailure(result, safeErrorCode(error));
            }
          }
          if (spec.key === 'weather') result.model_stub_calls = modelRequests - modelCallsBeforeSample;
          result.status = result.failureCodes.length === 0 ? 'passed' : 'failed';
          console.log(JSON.stringify({ type: 'astrbot-sample', ...result }));
        }
      }
    } catch (error) {
      globalCodes.push(safeErrorCode(error));
    } finally {
      if (policy) {
        try { await policy.setEnabled(false); }
        catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        if (policySnapshot) {
          try {
            if (Object.hasOwn(policySnapshot.groups, GROUP_ID)) {
              await policy.setGroup(GROUP_ID, policySnapshot.groups[GROUP_ID]);
            } else {
              await policy.removeGroup(GROUP_ID);
            }
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
          try {
            const finalPolicy = await policy.get();
            if (finalPolicy.enabled !== false) cleanupCodes.push('ASTRBOT_SAMPLE_POLICY_NOT_OFF');
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
      }
      if (manager) {
        if (pendingInstall) {
          try {
            const settledJob = await waitForJob(manager, pendingInstall.id, 3 * 60 * 1000);
            if (settledJob.status === 'succeeded' && typeof settledJob.plugin === 'string') {
              ownedPluginIds.add(settledJob.plugin);
              const result = results.find((item) => item.sample === pendingInstall.sample);
              if (result && !result.pluginId) result.pluginId = settledJob.plugin;
            }
            pendingInstall = null;
          } catch (error) {
            const code = safeErrorCode(error);
            cleanupCodes.push(code === 'ASTRBOT_SAMPLE_INSTALL_TIMEOUT'
              ? 'ASTRBOT_SAMPLE_INSTALL_STILL_ACTIVE' : code);
            if (code !== 'ASTRBOT_SAMPLE_INSTALL_TIMEOUT') pendingInstall = null;
          }
        }
        // Ensure every plugin installed by this run is disabled before stopping the external runtime.
        for (const pluginId of ownedPluginIds) {
          try {
            const plugin = (await manager.listPlugins()).find((item) => item.id === pluginId);
            if (plugin?.enabled) await manager.configure(pluginId, { enabled: false });
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
        try {
          const stopped = await manager.stop();
          if (stopped?.stopped !== true) cleanupCodes.push('ASTRBOT_SAMPLE_RUNTIME_STOP_FAILED');
        } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
      }
      if (bridge && bridgeStarted) {
        try { await bridge.stop(); }
        catch (error) { cleanupCodes.push(safeErrorCode(error)); }
      }
      if (manager && originalRuntimeRpc) manager.runtimeRpc = originalRuntimeRpc;
    }

    if (globalCodes.length) {
      for (const result of results) {
        if (result.status === 'not-run') {
          result.status = 'blocked';
          for (const code of globalCodes) addFailure(result, code);
        }
      }
    }
    if (cleanupCodes.length) {
      for (const code of cleanupCodes) {
        if (!globalCodes.includes(code)) globalCodes.push(code);
      }
    }
    const passed = results.length === SAMPLE_SPECS.length
      && results.every((result) => result.status === 'passed') && globalCodes.length === 0;
    console.log(JSON.stringify({
      type: 'astrbot-samples-summary',
      runId,
      status: passed ? 'passed' : 'failed',
      runtime: 'external',
      projectAdmin: PROJECT_ADMIN_ID,
      groupId: GROUP_ID,
      memberId: GROUP_MEMBER_ID,
      external_api: 'not-tested',
      QQ: 'not-tested',
      globalFailureCodes: globalCodes,
      cleanupFailureCodes: cleanupCodes,
      samples: results,
    }));
    if (!passed) process.exitCode = 1;
  }

  await main();
}
