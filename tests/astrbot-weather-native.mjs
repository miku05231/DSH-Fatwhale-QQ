if (process.env.ASTRBOT_WEATHER_NATIVE_TEST !== '1') {
  console.log('AstrBot weather acceptance skipped; set ASTRBOT_WEATHER_NATIVE_TEST=1 to opt in.');
} else {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dns = await import('node:dns/promises');
  const net = await import('node:net');
  const http = await import('node:http');
  const { createHash, randomUUID } = await import('node:crypto');
  const { inflateRawSync } = await import('node:zlib');

  const APP_ROOT_ENV = process.env.ASTRBOT_SAMPLE_APP_ROOT;
  const STATE_DIR_ENV = process.env.ASTRBOT_SAMPLE_STATE_DIR;
  const CALLBACK_URL_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_URL;
  const CALLBACK_HOST_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_HOST;
  const CALLBACK_PORT_ENV = process.env.ASTRBOT_SAMPLE_CALLBACK_PORT;
  const RUNTIME_URL = process.env.ASTRBOT_RUNTIME_URL || 'http://weather-runtime-v2:5831';
  const FIXTURE_URL_ENV = process.env.ASTRBOT_WEATHER_FIXTURE_BASE_URL;
  const FIXTURE_HOST_ENV = process.env.ASTRBOT_WEATHER_FIXTURE_HOST;
  const FIXTURE_PORT_ENV = process.env.ASTRBOT_WEATHER_FIXTURE_PORT;

  const GROUP_ID = '123';
  const USER_ID = '456';
  const REPOSITORY = 'https://github.com/zzby-poi/astrbot_plugin_weather';
  const MARKER_NAME = '.astrbot-acceptance-only';
  const FIXTURE_ROUTE = '/api/v1/misc/weather';
  const PUBLIC_API_ENDPOINT = 'https://uapis.cn/api/v1/misc/weather';
  const PUBLIC_TEST = process.env.ASTRBOT_WEATHER_PUBLIC_TEST === '1';
  const OUTBOUND_GRANT = process.env.ASTRBOT_WEATHER_OUTBOUND_GRANT === '1';
  const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
  const MAX_MAIN_BYTES = 4 * 1024 * 1024;
  const INSTALL_TIMEOUT_MS = boundedTimeout(process.env.ASTRBOT_WEATHER_INSTALL_TIMEOUT_MS);
  const DAILY_PUSH_WAIT_MS = 160_000;

  let APP_ROOT;
  let STATE_DIR;
  let CALLBACK_URL;
  let CALLBACK_HOST;
  let CALLBACK_PORT;
  let FIXTURE_HOST;
  let FIXTURE_PORT;
  let FIXTURE_URL;
  let MARKER_PATH;
  let SAMPLES_DIR;
  let MANIFEST_PATH;

  function boundedTimeout(raw) {
    if (raw === undefined || raw === '') return 10 * 60 * 1000;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 30_000 && value <= 20 * 60 * 1000
      ? value : 10 * 60 * 1000;
  }

  function acceptanceError(code) { return Object.assign(new Error(code), { code }); }
  function requireThat(value, code) { if (!value) throw acceptanceError(code); }
  function safeErrorCode(error) {
    const value = String(error?.code || '');
    return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(value) ? value : 'ASTRBOT_WEATHER_ACCEPTANCE_UNEXPECTED_ERROR';
  }
  function safeErrorDetails(error) {
    const rawName = typeof error?.name === 'string' ? error.name : '';
    const errorClass = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(rawName) ? rawName : 'Error';
    const rawCode = typeof error?.code === 'string' ? error.code : '';
    const nativeNodeCode = /^(?:ERR_[A-Z0-9_]{1,60}|E[A-Z0-9_]{1,31}|ABORT_ERR|UND_ERR_[A-Z0-9_]{1,60})$/
      .test(rawCode) ? rawCode : null;
    let sourceLocation = null;
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    for (const frame of stack.split(/\r?\n/).slice(1)) {
      const match = frame.match(/([A-Za-z0-9_.-]+\.(?:mjs|cjs|js)):(\d+):(\d+)/);
      if (match) {
        sourceLocation = `${match[1]}:${match[2]}:${match[3]}`;
        break;
      }
    }
    return { errorClass, nativeNodeCode, sourceLocation };
  }
  function addFailure(result, code) {
    const safe = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(code || ''))
      ? String(code) : 'ASTRBOT_WEATHER_ACCEPTANCE_UNEXPECTED_ERROR';
    if (!result.failureCodes.includes(safe)) result.failureCodes.push(safe);
  }

  function deriveOverallStatus(result) {
    const failed = result.failureCodes.length > 0
      || result.errorDetails !== null
      || result.cleanupFailureCodes.length > 0
      || result.lockedSourceHashes?.finalCheckPassed !== true
      || result.controlledFixture?.status !== 'passed'
      || result.localModel?.status !== 'passed'
      || result.nativeQuery?.status !== 'passed'
      || result.scheduledDailyPush?.status !== 'passed'
      || (result.outboundGrant?.optIn
        ? result.outboundGrant.status !== 'passed'
        : result.outboundGrant?.status !== 'skipped')
      || (result.publicApi?.optIn
        ? result.publicApi.status !== 'passed'
        : result.publicApi?.status !== 'skipped');
    result.status = failed ? 'failed' : 'passed';
    return result.status;
  }

  function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

  async function requireOutboundDenied(operation, code) {
    try { await operation(); } catch (error) {
      if (error?.code === 'ASTRBOT_OUTBOUND_PERMISSION_DENIED') return true;
      throw error;
    }
    throw acceptanceError(code);
  }

  async function requireOutboundCallbackDenied(bridge, body, sends, code) {
    const before = sends.length;
    await requireOutboundDenied(() => bridge.callback(body), code);
    requireThat(sends.length === before, 'ASTRBOT_WEATHER_DENIED_CALLBACK_REACHED_COLLECTOR');
    return true;
  }

  function httpStatusFromReply(text) {
    const match = String(text || '').match(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|天气接口错误\s*)([1-5]\d\d)\b/i);
    return match ? Number(match[1]) : null;
  }

  function parsePublicWeatherReply(value, allowedLocations) {
    const reply = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const match = reply.match(/^(?<location>[\u4e00-\u9fff·]{1,16}?)当前(?<weather>[\u4e00-\u9fff·]{1,24}?)，(?<temperature>-?\d+(?:\.\d+)?)摄氏度，湿度(?<humidity>\d+(?:\.\d+)?)%/);
    if (!match) {
      return {
        observedLocation: null, locationObserved: false, publicReplySnippet: null,
        weatherValue: null, weatherObserved: false, temperatureValue: null,
        temperatureObserved: false, humidityValue: null, humidityObserved: false,
      };
    }
    const { location, weather, temperature, humidity } = match.groups;
    const temperatureValue = Number(temperature);
    const humidityValue = Number(humidity);
    return {
      observedLocation: location,
      locationObserved: Array.isArray(allowedLocations) && allowedLocations.includes(location),
      publicReplySnippet: match[0].slice(0, 320),
      weatherValue: weather,
      weatherObserved: weather !== '未知天气',
      temperatureValue,
      temperatureObserved: Number.isFinite(temperatureValue) && temperatureValue >= -100
        && temperatureValue <= 100,
      humidityValue,
      humidityObserved: Number.isFinite(humidityValue) && humidityValue >= 0 && humidityValue <= 100,
    };
  }

  async function diagnosticPublicHttpStatus() {
    const url = new URL(PUBLIC_API_ENDPOINT);
    url.searchParams.set('adcode', '110000');
    url.searchParams.set('lang', 'zh');
    try {
      const response = await fetch(url, {
        method: 'GET', redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const status = Number(response.status);
      await response.body?.cancel().catch(() => {});
      return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    } catch {
      return null;
    }
  }

  function absoluteDirectory(raw, code) {
    requireThat(typeof raw === 'string' && raw.length > 0 && raw.trim() === raw, code);
    if (process.platform === 'win32') {
      const root = path.win32.parse(raw).root.replaceAll('/', '\\');
      const drive = root.length >= 3 && root[1] === ':' && root[2] === '\\';
      const unc = root.charCodeAt(0) === 92 && root.charCodeAt(1) === 92
        && root.slice(2).split('\\').filter(Boolean).length >= 2;
      requireThat(path.win32.isAbsolute(raw) && (drive || unc), code);
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

  function validCallbackUrl(raw) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw acceptanceError('ASTRBOT_WEATHER_CALLBACK_URL_INVALID'); }
    requireThat(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname
      && !parsed.username && !parsed.password && parsed.pathname === '/rpc/callback'
      && !parsed.search && !parsed.hash,
    'ASTRBOT_WEATHER_CALLBACK_URL_INVALID');
    return raw;
  }

  function comparable(value) {
    return process.platform === 'win32' ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
  }

  function privateAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
      const octets = address.split('.').map(Number);
      return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    }
    if (family === 6) {
      const lower = address.toLowerCase();
      if (lower === '::1' || lower === '::') return true;
      if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(lower)) {
        return privateAddress(lower.slice('::ffff:'.length));
      }
      return lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower);
    }
    return false;
  }

  async function requireLocalHost(host, code) {
    const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
    const trustedServiceNames = new Set([
      'localhost', 'host.docker.internal', 'host.containers.internal', 'weather-runtime',
      'weather-runtime-v2', 'weather-acceptance', 'callbackweather-acceptance-v2',
      'astrbot', 'acceptance',
    ]);
    if (trustedServiceNames.has(lower) || lower.endsWith('.localhost')) return;
    if (net.isIP(lower)) {
      requireThat(privateAddress(lower), code);
      return;
    }
    let records;
    try { records = await dns.lookup(lower, { all: true, verbatim: true }); }
    catch { throw acceptanceError(code); }
    requireThat(records.length > 0 && records.every((record) => privateAddress(record.address)), code);
  }

  function configurePaths() {
    if (process.platform === 'win32') {
      requireThat(APP_ROOT_ENV && STATE_DIR_ENV && CALLBACK_URL_ENV,
        'ASTRBOT_WEATHER_WINDOWS_OVERRIDES_REQUIRED');
    }
    APP_ROOT = absoluteDirectory(APP_ROOT_ENV ?? '/app', 'ASTRBOT_WEATHER_APP_ROOT_INVALID');
    STATE_DIR = absoluteDirectory(STATE_DIR_ENV ?? '/app/state', 'ASTRBOT_WEATHER_STATE_ROOT_INVALID');
    requireThat(comparable(APP_ROOT) !== comparable(STATE_DIR), 'ASTRBOT_WEATHER_STATE_ROOT_INVALID');
    CALLBACK_URL = validCallbackUrl(CALLBACK_URL_ENV ?? 'http://callbackweather-acceptance-v2:5832/rpc/callback');
    CALLBACK_HOST = CALLBACK_HOST_ENV ?? '0.0.0.0';
    requireThat(typeof CALLBACK_HOST === 'string' && CALLBACK_HOST.length <= 255
      && CALLBACK_HOST.trim() === CALLBACK_HOST && !/[\s/?#\\]/.test(CALLBACK_HOST),
    'ASTRBOT_WEATHER_CALLBACK_HOST_INVALID');
    CALLBACK_PORT = boundedPort(CALLBACK_PORT_ENV, 5832, 'ASTRBOT_WEATHER_CALLBACK_PORT_INVALID');
    FIXTURE_HOST = FIXTURE_HOST_ENV ?? '0.0.0.0';
    requireThat(['0.0.0.0', '::', '127.0.0.1', '::1'].includes(FIXTURE_HOST)
      || (net.isIP(FIXTURE_HOST) && privateAddress(FIXTURE_HOST)),
    'ASTRBOT_WEATHER_FIXTURE_BIND_HOST_INVALID');
    FIXTURE_PORT = boundedPort(FIXTURE_PORT_ENV, 5833, 'ASTRBOT_WEATHER_FIXTURE_PORT_INVALID');
    MARKER_PATH = path.join(STATE_DIR, MARKER_NAME);
    SAMPLES_DIR = path.join(STATE_DIR, 'samples');
    MANIFEST_PATH = path.join(APP_ROOT, 'runtime', 'astrbot-samples.json');

    const fixtureServiceHost = process.platform === 'win32'
      ? 'host.docker.internal' : 'callbackweather-acceptance-v2';
    let fixtureUrl;
    try {
      fixtureUrl = new URL(FIXTURE_URL_ENV
        ?? `http://${fixtureServiceHost}:${FIXTURE_PORT}${FIXTURE_ROUTE}`);
    } catch { throw acceptanceError('ASTRBOT_WEATHER_FIXTURE_URL_INVALID'); }
    requireThat(fixtureUrl.protocol === 'http:' && !fixtureUrl.username && !fixtureUrl.password
      && fixtureUrl.pathname === FIXTURE_ROUTE && !fixtureUrl.search && !fixtureUrl.hash
      && Number(fixtureUrl.port || 80) === FIXTURE_PORT,
    'ASTRBOT_WEATHER_FIXTURE_URL_INVALID');
    FIXTURE_URL = fixtureUrl;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function decodeUtf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw acceptanceError('ASTRBOT_WEATHER_ARCHIVE_INVALID'); }
  }

  function zipEntries(archive) {
    requireThat(Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= MAX_ARCHIVE_BYTES,
      'ASTRBOT_WEATHER_ARCHIVE_SIZE_INVALID');
    const start = Math.max(0, archive.length - 22 - 0xffff);
    let eocd = -1;
    for (let offset = archive.length - 22; offset >= start; offset -= 1) {
      if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    requireThat(eocd >= 0 && eocd + 22 <= archive.length, 'ASTRBOT_WEATHER_ARCHIVE_INVALID');
    const disk = archive.readUInt16LE(eocd + 4);
    const directoryDisk = archive.readUInt16LE(eocd + 6);
    const entriesOnDisk = archive.readUInt16LE(eocd + 8);
    const count = archive.readUInt16LE(eocd + 10);
    const size = archive.readUInt32LE(eocd + 12);
    const directoryOffset = archive.readUInt32LE(eocd + 16);
    const commentLength = archive.readUInt16LE(eocd + 20);
    requireThat(disk === 0 && directoryDisk === 0 && entriesOnDisk === count && count > 0
      && count <= 10_000 && size !== 0xffffffff && directoryOffset !== 0xffffffff
      && eocd + 22 + commentLength === archive.length && directoryOffset + size <= eocd,
    'ASTRBOT_WEATHER_ARCHIVE_LAYOUT_UNSUPPORTED');
    const entries = [];
    let offset = directoryOffset;
    for (let index = 0; index < count; index += 1) {
      requireThat(offset + 46 <= directoryOffset + size && archive.readUInt32LE(offset) === 0x02014b50,
        'ASTRBOT_WEATHER_ARCHIVE_INVALID');
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
      requireThat(nameLength > 0 && end <= directoryOffset + size && compressedSize !== 0xffffffff
        && expandedSize !== 0xffffffff && localOffset !== 0xffffffff && diskStart === 0
        && (flags & 1) === 0 && [0, 8].includes(method), 'ASTRBOT_WEATHER_ARCHIVE_ENTRY_UNSUPPORTED');
      const name = decodeUtf8(archive.subarray(offset + 46, offset + 46 + nameLength));
      entries.push({ name, flags, method, expectedCrc, compressedSize, expandedSize, localOffset });
      offset = end;
    }
    requireThat(offset === directoryOffset + size, 'ASTRBOT_WEATHER_ARCHIVE_INVALID');
    const roots = new Set(entries.map((entry) => entry.name.split('/')[0]));
    requireThat(roots.size === 1 && ![...roots][0].includes('\\'), 'ASTRBOT_WEATHER_ARCHIVE_ROOT_INVALID');
    return { root: [...roots][0], entries };
  }

  function readZipEntry(archive, entry, maxBytes) {
    requireThat(entry && entry.expandedSize <= maxBytes, 'ASTRBOT_WEATHER_ARCHIVE_ENTRY_TOO_LARGE');
    const offset = entry.localOffset;
    requireThat(offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50,
      'ASTRBOT_WEATHER_ARCHIVE_INVALID');
    const localFlags = archive.readUInt16LE(offset + 6);
    const localMethod = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameEnd = offset + 30 + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    requireThat(nameEnd <= archive.length && dataEnd <= archive.length
      && localFlags === entry.flags && localMethod === entry.method
      && decodeUtf8(archive.subarray(offset + 30, nameEnd)) === entry.name,
    'ASTRBOT_WEATHER_ARCHIVE_INVALID');
    let expanded;
    try {
      const compressed = archive.subarray(dataStart, dataEnd);
      expanded = entry.method === 0 ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch { throw acceptanceError('ASTRBOT_WEATHER_ARCHIVE_ENTRY_INVALID'); }
    requireThat(expanded.length === entry.expandedSize && crc32(expanded) === entry.expectedCrc,
      'ASTRBOT_WEATHER_ARCHIVE_ENTRY_INVALID');
    return expanded;
  }

  function metadataPluginName(bytes) {
    const text = decodeUtf8(bytes);
    const match = text.match(/^name:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))/m);
    const name = match?.[1] || match?.[2] || match?.[3] || '';
    requireThat(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name),
      'ASTRBOT_WEATHER_PLUGIN_NAME_INVALID');
    return name;
  }

  async function preflight(lockEntries) {
    const expected = lockEntries.find((entry) => entry.repository === REPOSITORY);
    requireThat(expected && /^[a-f0-9]{40}$/i.test(expected.commit)
      && /^[a-f0-9]{64}$/i.test(expected.archiveSHA256)
      && /^[a-f0-9]{64}$/i.test(expected.mainPySHA256), 'ASTRBOT_WEATHER_LOCK_ENTRY_MISSING');
    const archivePath = path.join(SAMPLES_DIR, 'weather.zip');
    const archiveStat = await fs.lstat(archivePath).catch(() => null);
    requireThat(archiveStat?.isFile() && !archiveStat.isSymbolicLink(), 'ASTRBOT_WEATHER_SAMPLE_ARCHIVE_REQUIRED');
    const archive = await fs.readFile(archivePath);
    const archiveHash = sha256(archive);
    requireThat(archiveHash === expected.archiveSHA256.toLowerCase(), 'ASTRBOT_WEATHER_ARCHIVE_HASH_MISMATCH');
    const directory = zipEntries(archive);
    const mains = directory.entries.filter((entry) => entry.name.endsWith('/main.py')
      && entry.name.split('/').length === 2);
    const metadata = directory.entries.filter((entry) => entry.name === `${directory.root}/metadata.yaml`);
    requireThat(mains.length === 1 && mains[0].name === `${directory.root}/main.py` && metadata.length === 1,
      'ASTRBOT_WEATHER_ARCHIVE_LAYOUT_INVALID');
    const mainHash = sha256(readZipEntry(archive, mains[0], MAX_MAIN_BYTES));
    requireThat(mainHash === expected.mainPySHA256.toLowerCase(), 'ASTRBOT_WEATHER_MAIN_HASH_MISMATCH');
    return { archive, expected, pluginId: metadataPluginName(readZipEntry(archive, metadata[0], 128 * 1024)),
      archiveHash, mainHash };
  }

  function nextShanghaiDailySlot() {
    const slotEpoch = (Math.floor(Date.now() / 60_000) + 2) * 60_000;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(slotEpoch));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { at: slotEpoch, value: `${values.hour}:${values.minute}` };
  }

  function weatherPayload() {
    return {
      province: '北京市', city: '北京', district: '海淀区', adcode: '110000',
      weather: '晴', weather_icon: '100', temperature: 24,
      wind_direction: '北风', wind_power: '2级', humidity: 35,
      report_time: '2026-11-01 09:00:00',
    };
  }

  function startWeatherFixture() {
    const requests = [];
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_url' }));
        return;
      }
      const authorized = Boolean(req.headers.authorization);
      const record = {
        method: req.method || '', path: url.pathname,
        city: url.searchParams.get('city') || '', adcode: url.searchParams.get('adcode') || '',
        lang: url.searchParams.get('lang') || '', authorizationPresent: authorized,
      };
      if (requests.length < 100) requests.push(record);
      if (req.method !== 'GET' || url.pathname !== FIXTURE_ROUTE) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'fixture_requires_no_authorization' }));
        return;
      }
      if ((!record.city && !record.adcode) || (record.city && !['北京', '北京市'].includes(record.city))
        || (record.adcode && record.adcode !== '110000') || record.lang !== 'zh') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unexpected_fixture_query' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(weatherPayload()));
    });
    return { server, requests };
  }

  function resultText(item) {
    const value = item?.params?.message;
    if (typeof value === 'string') return value;
    return (Array.isArray(value) ? value : [])
      .filter((part) => part?.type === 'text' && typeof part?.data?.text === 'string')
      .map((part) => part.data.text).join('');
  }

  function controlledReplyDiagnostic({ command, messageId, response, sendStart, fixtureStart,
    sends, fixture, observedDispatches, intentClassificationCalls,
    expectedLocation = '', intentCallsBefore = 0 }) {
    const outbound = sends.slice(sendStart);
    const groupReplies = outbound.filter((item) => item?.action === 'send_group_msg'
      && String(item?.params?.group_id) === GROUP_ID);
    const replyTexts = groupReplies.map(resultText);
    const requests = fixture?.requests.slice(fixtureStart) || [];
    const snippets = outbound.slice(0, 4).map((item) => ({
      action: /^[a-z0-9_]{1,40}$/.test(String(item?.action || '')) ? item.action : 'other',
      text: resultText(item).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320),
    }));
    const cityRequestObserved = requests.some((request) => request.path === FIXTURE_ROUTE
      && request.city === '北京');
    const adcodeRequestObserved = requests.some((request) => request.path === FIXTURE_ROUTE
      && request.adcode === '110000');
    return {
      command,
      dispatchStatus: ['handled', 'failed', 'duplicate', 'unhandled'].includes(response?.status)
        ? response.status : 'unknown',
      dispatchHandled: response?.status === 'handled',
      dispatchObserved: observedDispatches.includes(messageId),
      outboundActionCount: outbound.length,
      replySnippets: snippets,
      fixtureRequests: requests.slice(0, 8).map((request) => ({
        method: request.method, path: request.path, city: request.city, adcode: request.adcode,
        lang: request.lang, authorizationPresent: request.authorizationPresent,
      })),
      fixtureResponseFields: Object.keys(weatherPayload()),
      signalFlags: {
        groupReplyCaptured: groupReplies.length > 0,
        acknowledgementObserved: replyTexts.some((text) => text.includes('已记录你的所在地：')),
        expectedLocationObserved: Boolean(expectedLocation)
          && replyTexts.some((text) => text.includes(expectedLocation)),
        pushHintObserved: replyTexts.some((text) => text.includes('之后会按配置给你推送天气。')),
        cityFixtureRequestObserved: cityRequestObserved,
        adcodeFixtureRequestObserved: adcodeRequestObserved,
        fixtureAuthorizationPresent: requests.some((request) => request.authorizationPresent),
        localIntentClassificationCalled: intentClassificationCalls > intentCallsBefore,
      },
    };
  }

  function message(messageId, text) {
    return {
      messageType: 'group', groupId: GROUP_ID, userId: USER_ID, text,
      raw: {
        message_id: messageId,
        message: [{ type: 'text', data: { text } }],
        sender: { role: 'owner', nickname: 'astrbot-weather-acceptance' },
      },
    };
  }

  async function waitForJob(manager, id) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const job = await manager.job(id);
      requireThat(job && typeof job === 'object', 'ASTRBOT_WEATHER_INSTALL_JOB_MISSING');
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed') {
        const code = String(job.error?.code || '');
        throw acceptanceError(/^ASTRBOT_[A-Z0-9_]{1,64}$/.test(code)
          ? code : 'ASTRBOT_WEATHER_INSTALL_FAILED');
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw acceptanceError('ASTRBOT_WEATHER_INSTALL_TIMEOUT');
  }

  async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return Boolean(predicate());
  }

  async function installedMainHash(pluginId, generationId) {
    requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(String(pluginId || ''))
      && /^[A-Za-z0-9_-]{1,128}$/.test(String(generationId || '')),
    'ASTRBOT_WEATHER_GENERATION_INVALID');
    const generationRoot = path.resolve(STATE_DIR, 'astrbot', 'generations', generationId);
    const filename = path.resolve(generationRoot, 'data', 'plugins', pluginId, 'main.py');
    requireThat(filename.startsWith(generationRoot + path.sep), 'ASTRBOT_WEATHER_SOURCE_PATH_INVALID');
    const stat = await fs.lstat(filename).catch(() => null);
    requireThat(stat?.isFile() && !stat.isSymbolicLink(), 'ASTRBOT_WEATHER_INSTALLED_SOURCE_REQUIRED');
    return sha256(await fs.readFile(filename));
  }

  async function main() {
    const runId = randomUUID();
    const result = {
      type: 'astrbot-weather-acceptance-summary', runId, status: 'failed', runtime: 'external',
      controlledFixture: { status: 'not-run', route: FIXTURE_ROUTE, requests: 0, cityQueries: 0,
        adcodeQueries: 0, authorizationPresent: false },
      localModel: { status: 'not-run', intentClassificationCalls: 0, intent: 'query_weather' },
      controlledDiagnostics: { setCity: null, naturalQuery: null },
      nativeQuery: { status: 'not-run', dispatchObserved: false, capturedGroupReply: false },
      scheduledDailyPush: { status: 'not-run', capturedPrivateReply: false },
      outboundGrant: { optIn: OUTBOUND_GRANT, status: OUTBOUND_GRANT ? 'not-run' : 'skipped',
        noGrantDenied: false, grantCreated: false, authorizedBeforeSlot: false,
        actualScheduledDeliveryCaptured: false, explicitRevokeDenied: false,
        revokedCallbackDenied: false, replacementGrantAuthorized: false,
        sameConfigInvalidated: false, configuredCallbackDenied: false,
        rollbackRestoredPreviousGeneration: false, rollbackDidNotRevive: false,
        rollbackCallbackDenied: false, revokedRecordsInactive: false, failureCode: null },
      publicApi: { optIn: PUBLIC_TEST, status: 'not-run', endpoint: PUBLIC_TEST ? PUBLIC_API_ENDPOINT : null,
        configured: false, apiKeyConfigured: false, dailyPushEnabled: false, monitorEnabled: false,
        localIntentModel: 'astrbot-weather-local-model-stub', nativeDispatchObserved: false,
        nativeDispatchHandled: false,
        capturedGroupReply: false, parsedSuccessfulReply: false, expectedLocation: '海淀',
        observedLocation: null, locationObserved: false, publicReplySnippet: null,
        weatherValue: null, temperatureValue: null, humidityValue: null,
        weatherObserved: false, temperatureObserved: false, humidityObserved: false,
        intentClassificationCalls: 0, pluginReplyHttpStatus: null, diagnosticHttpStatus: null,
        diagnosticStatusSource: null, failureCode: null },
      lockedSourceHashes: { finalCheckPassed: false },
      failureCodes: [], cleanupFailureCodes: [], QQ: 'not-connected',
      errorDetails: null,
      actualUapi: PUBLIC_TEST ? 'opt-in-native-plugin-phase' : 'not-tested-by-this-harness',
    };
    let manager;
    let policy;
    let bridge;
    let bridgeStarted = false;
    let policySnapshot;
    let fixture;
    let fixtureStarted = false;
    let runtimeStarted = false;
    let pendingInstall;
    let installedId;
    let originalRuntimeRpc;
    const ownedPluginIds = new Set();
    const ownedGrantIds = new Set();
    const sends = [];
    const observedDispatches = [];
    const cleanupCodes = result.cleanupFailureCodes;
    let intentClassificationCalls = 0;
    let scheduledSlot;

    try {
      configurePaths();
      await requireLocalHost(RUNTIME_URL ? new URL(RUNTIME_URL).hostname : '',
        'ASTRBOT_WEATHER_RUNTIME_HOST_NOT_LOCAL');
      await requireLocalHost(FIXTURE_URL.hostname, 'ASTRBOT_WEATHER_FIXTURE_HOST_NOT_LOCAL');
      await requireLocalHost(new URL(CALLBACK_URL).hostname, 'ASTRBOT_WEATHER_CALLBACK_HOST_NOT_LOCAL');
      const runtimeUrl = new URL(RUNTIME_URL);
      requireThat(['http:', 'https:'].includes(runtimeUrl.protocol) && !runtimeUrl.username
        && !runtimeUrl.password && !runtimeUrl.search && !runtimeUrl.hash,
      'ASTRBOT_WEATHER_RUNTIME_URL_INVALID');
      requireThat(!process.env.ASTRBOT_RUNTIME_MODE || process.env.ASTRBOT_RUNTIME_MODE === 'external',
        'ASTRBOT_WEATHER_EXTERNAL_MODE_REQUIRED');

      const stateStat = await fs.lstat(STATE_DIR).catch(() => null);
      const marker = await fs.lstat(path.join(STATE_DIR, MARKER_NAME)).catch(() => null);
      const samplesStat = await fs.lstat(SAMPLES_DIR).catch(() => null);
      requireThat(stateStat?.isDirectory() && !stateStat.isSymbolicLink(),
        'ASTRBOT_WEATHER_STATE_ROOT_REQUIRED');
      requireThat(marker?.isFile() && !marker.isSymbolicLink(), 'ASTRBOT_WEATHER_ACCEPTANCE_MARKER_REQUIRED');
      requireThat(samplesStat?.isDirectory() && !samplesStat.isSymbolicLink(),
        'ASTRBOT_WEATHER_SAMPLE_DIRECTORY_REQUIRED');
      const manifestStat = await fs.lstat(MANIFEST_PATH).catch(() => null);
      requireThat(manifestStat?.isFile() && !manifestStat.isSymbolicLink(), 'ASTRBOT_WEATHER_LOCK_REQUIRED');
      const manifestBytes = await fs.readFile(MANIFEST_PATH);
      requireThat(manifestBytes.length <= 1024 * 1024, 'ASTRBOT_WEATHER_LOCK_INVALID');
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      requireThat(manifest?.schemaVersion === 1 && Array.isArray(manifest.samples)
        && manifest.samples.filter((entry) => entry.repository === REPOSITORY).length === 1,
      'ASTRBOT_WEATHER_LOCK_INVALID');
      const prepared = await preflight(manifest.samples);
      result.lockedSourceHashes = {
        archiveBefore: prepared.archiveHash,
        mainPyBefore: prepared.mainHash,
        manifestBefore: sha256(manifestBytes),
      };

      const [{ createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge }] = await Promise.all([
        import('../src/astrbot-manager.mjs'),
        import('../src/astrbot-policy.mjs'),
        import('../src/astrbot-bridge.mjs'),
      ]);
      const cfg = {
        stateDir: STATE_DIR,
        security: {
          allowGroups: true, allowGroupIds: [GROUP_ID], allowFrom: [USER_ID], denyFrom: [],
          adminUserIds: [USER_ID], allowGroupMembers: false,
        },
        astrbot: {
          enabled: true, runtimeMode: 'external', runtimeUrl: RUNTIME_URL, callbackUrl: CALLBACK_URL,
        },
      };
      const readConfig = () => cfg;
      manager = createAstrbotManager({
        projectRoot: APP_ROOT,
        configPath: path.join(STATE_DIR, 'astrbot-weather-native-config.json'),
        readConfig,
        logger: () => {},
      });
      policy = createAstrbotPolicy({ root: APP_ROOT, readConfig });
      fixture = startWeatherFixture();
      await new Promise((resolve, reject) => {
        fixture.server.once('error', reject);
        fixture.server.listen(FIXTURE_PORT, FIXTURE_HOST, resolve);
      });
      fixtureStarted = true;
      result.controlledFixture.status = 'running';

      bridge = createAstrbotBridge({
        root: APP_ROOT, readConfig, manager, policy, host: CALLBACK_HOST, port: CALLBACK_PORT,
        // All native AstrBot sends end here; no QQ connection is created by this harness.
        send: async (action, params) => {
          sends.push({ at: Date.now(), action, params: structuredClone(params) });
          return { message_id: `weather-acceptance-${sends.length}` };
        },
        generate: async (params) => {
          const serialized = JSON.stringify(params ?? {});
          if (serialized.includes('天气插件意图分类') || serialized.includes('query_weather')) {
            intentClassificationCalls += 1;
          }
          return {
            id: 'astrbot-weather-local-model-stub', object: 'chat.completion', created: 0,
            model: 'astrbot-weather-local-model-stub',
            choices: [{ index: 0, message: { role: 'assistant',
              content: '{"use_plugin":true,"intent":"query_weather","location":"","confidence":0.99}' },
            finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
        logger: () => {},
      });

      // Never create a missing shared RPC token; all manager state and config stay under marked STATE_DIR.
      await manager.getToken({ create: false });
      const beforeRuntime = await manager.status();
      policySnapshot = await policy.get();
      await policy.setEnabled(false);
      const original = manager.runtimeRpc.bind(manager);
      originalRuntimeRpc = original;
      manager.runtimeRpc = async (method, params, options) => {
        if (method === 'dispatch') observedDispatches.push(String(params?.event?.messageId || ''));
        return original(method, params, options);
      };
      const startResult = await manager.start();
      runtimeStarted = startResult?.running === true && beforeRuntime?.running !== true;
      requireThat(startResult?.running === true && startResult?.external === true,
        'ASTRBOT_WEATHER_EXTERNAL_RUNTIME_START_FAILED');
      // Wait for runtime health before exposing the bridge send collector.
      await bridge.start();
      bridgeStarted = true;

      const existing = await manager.listPlugins();
      requireThat(!existing.some((plugin) => plugin.id === prepared.pluginId
        || plugin.metadata?.name === prepared.pluginId), 'ASTRBOT_WEATHER_PLUGIN_ALREADY_PRESENT');
      const install = await manager.install({ zipBase64: prepared.archive.toString('base64') });
      pendingInstall = install.id;
      console.log(JSON.stringify({ type: 'astrbot-weather-install-queued' }));
      const job = await waitForJob(manager, install.id);
      pendingInstall = null;
      requireThat(job.status === 'succeeded' && typeof job.plugin === 'string',
        'ASTRBOT_WEATHER_INSTALL_FAILED');
      installedId = job.plugin;
      ownedPluginIds.add(installedId);
      const initialPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
      requireThat(initialPlugin && initialPlugin.enabled === false, 'ASTRBOT_WEATHER_DEFAULT_MUST_BE_DISABLED');
      requireThat(initialPlugin.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && initialPlugin.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && job.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && await installedMainHash(installedId, initialPlugin.generationId)
          === prepared.expected.mainPySHA256.toLowerCase(),
      'ASTRBOT_WEATHER_INSTALLED_HASH_MISMATCH');

      scheduledSlot = nextShanghaiDailySlot();
      requireThat(scheduledSlot.at - Date.now() >= 55_000,
        'ASTRBOT_WEATHER_DAILY_SLOT_TOO_SOON');
      const pluginConfig = {
        api_settings: {
          api_base_url: FIXTURE_URL.toString(), api_key: '', timeout_seconds: 5, lang: 'zh',
        },
        push_settings: {
          enable_daily_push: true, daily_push_times: [scheduledSlot.value],
          enable_llm_message: false, user_id_whitelist: [USER_ID], daily_extensions: {},
        },
        monitor_settings: { enable_monitor: false },
        query_settings: { enable_ai_intent_detection: true },
      };
      await manager.configure(installedId, { enabled: true, config: pluginConfig });
      const activePlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
      requireThat(activePlugin?.enabled === true, 'ASTRBOT_WEATHER_ENABLE_FAILED');
      requireThat(activePlugin.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && activePlugin.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && await installedMainHash(installedId, activePlugin.generationId)
          === prepared.expected.mainPySHA256.toLowerCase(),
      'ASTRBOT_WEATHER_SOURCE_CHANGED_AFTER_ENABLE');

      await policy.setGroup(GROUP_ID, { pluginIds: [installedId], chatMode: 'dsh' });
      await policy.setEnabled(true);

      const setCityId = `${runId}-set-city`;
      const setCityStart = sends.length;
      const setCityFixtureStart = fixture.requests.length;
      const setCityResponse = await bridge.dispatch(message(setCityId, '/天气 设置城市 北京'));
      const setCityExpectedAck = '已记录你的所在地：海淀。之后会按配置给你推送天气。';
      const setCityReply = sends.slice(setCityStart).some((item) => item.action === 'send_group_msg'
        && String(item.params?.group_id) === GROUP_ID && resultText(item).includes(setCityExpectedAck));
      const setCityCall = fixture.requests.slice(setCityFixtureStart).some((request) =>
        request.city === '北京' && request.path === FIXTURE_ROUTE && !request.authorizationPresent);
      if (setCityResponse?.status !== 'handled' || !observedDispatches.includes(setCityId)
        || !setCityReply || !setCityCall) {
        result.controlledDiagnostics.setCity = controlledReplyDiagnostic({
          command: '/天气 设置城市 北京', messageId: setCityId, response: setCityResponse,
          sendStart: setCityStart, fixtureStart: setCityFixtureStart,
          sends, fixture, observedDispatches, intentClassificationCalls, expectedLocation: '海淀',
        });
      }
      requireThat(setCityResponse?.status === 'handled' && observedDispatches.includes(setCityId),
        'ASTRBOT_WEATHER_SET_CITY_DISPATCH_FAILED');
      requireThat(setCityReply, 'ASTRBOT_WEATHER_SET_CITY_REPLY_MISSING');
      requireThat(setCityCall, 'ASTRBOT_WEATHER_CITY_FIXTURE_CALL_MISSING');

      const queryId = `${runId}-natural-query`;
      const queryStart = sends.length;
      const queryFixtureStart = fixture.requests.length;
      const intentCallsBeforeQuery = intentClassificationCalls;
      const queryResponse = await bridge.dispatch(message(queryId, '今天的天气怎么样？'));
      const queryReply = sends.slice(queryStart).some((item) => item.action === 'send_group_msg'
        && String(item.params?.group_id) === GROUP_ID
        && resultText(item).includes('晴') && resultText(item).includes('24'));
      const intentCalledForQuery = intentClassificationCalls > intentCallsBeforeQuery;
      const queryCall = fixture.requests.slice(queryFixtureStart).some((request) =>
        request.adcode === '110000' && request.path === FIXTURE_ROUTE && !request.authorizationPresent);
      if (queryResponse?.status !== 'handled' || !observedDispatches.includes(queryId)
        || !queryReply || !intentCalledForQuery || !queryCall) {
        result.controlledDiagnostics.naturalQuery = controlledReplyDiagnostic({
          command: '今天的天气怎么样？', messageId: queryId, response: queryResponse,
          sendStart: queryStart, fixtureStart: queryFixtureStart,
          sends, fixture, observedDispatches, intentClassificationCalls, expectedLocation: '海淀',
          intentCallsBefore: intentCallsBeforeQuery,
        });
      }
      requireThat(queryResponse?.status === 'handled' && observedDispatches.includes(queryId),
        'ASTRBOT_WEATHER_NATURAL_QUERY_DISPATCH_FAILED');
      requireThat(queryReply, 'ASTRBOT_WEATHER_NATURAL_QUERY_REPLY_MISSING');
      requireThat(intentCalledForQuery, 'ASTRBOT_WEATHER_LOCAL_INTENT_CALL_MISSING');
      requireThat(queryCall, 'ASTRBOT_WEATHER_ADCODE_FIXTURE_CALL_MISSING');
      result.nativeQuery.status = 'passed';
      result.nativeQuery.dispatchObserved = true;
      result.nativeQuery.capturedGroupReply = true;
      result.localModel.status = 'passed';
      result.localModel.intentClassificationCalls = intentClassificationCalls;

      const targetTime = scheduledSlot.at;
      const dailyPushFixtureStart = fixture.requests.length;
      const dailyPushSendStart = sends.length;
      let dailyFixtureAdcodeQuery = false;
      result.scheduledDailyPush.localTime = scheduledSlot.value;
      const grantInput = { pluginId: installedId, purpose: 'weather.daily',
        target: { kind: 'private', id: USER_ID } };
      const grantRequest = { ...grantInput, sourceSHA256: prepared.archiveHash };
      // A negative callback never contains the daily reply signature and cannot
      // satisfy the native scheduler assertion, even if the guard regresses.
      const outboundCallback = { version: 1, method: 'outbound.send', pluginId: installedId,
        params: { purpose: grantInput.purpose, sourceSHA256: prepared.archiveHash,
          target: grantInput.target,
          message: [{ type: 'text', data: { text: 'controlled revoked weather callback probe' } }] } };
      let dailyGrant;
      // Keep scheduler observation independent so its failure cannot skip the public query.
      try {
        if (OUTBOUND_GRANT) {
          result.outboundGrant.status = 'running';
          requireThat(typeof policy.createOutboundGrant === 'function'
            && typeof policy.authorizeOutbound === 'function'
            && typeof policy.revokeOutboundGrant === 'function'
            && typeof policy.listOutboundGrants === 'function',
          'ASTRBOT_WEATHER_OUTBOUND_API_UNAVAILABLE');
          result.outboundGrant.noGrantDenied = await requireOutboundDenied(
            () => policy.authorizeOutbound(grantRequest), 'ASTRBOT_WEATHER_NO_GRANT_UNEXPECTEDLY_ALLOWED');
          // All configuration and policy setup precedes this grant. Nothing
          // mutates either until the actual scheduled callback has been observed.
          dailyGrant = await policy.createOutboundGrant(grantInput);
          ownedGrantIds.add(dailyGrant.id);
          requireThat(dailyGrant.active === true, 'ASTRBOT_WEATHER_OUTBOUND_GRANT_INACTIVE');
          result.outboundGrant.grantCreated = true;
          const allowed = await policy.authorizeOutbound(grantRequest);
          requireThat(allowed.grantId === dailyGrant.id, 'ASTRBOT_WEATHER_OUTBOUND_GRANT_NOT_SELECTED');
          result.outboundGrant.authorizedBeforeSlot = true;
        }
        requireThat(Date.now() < targetTime, 'ASTRBOT_WEATHER_DAILY_SLOT_ELAPSED');
        const pushed = await waitFor(() => sends.slice(dailyPushSendStart).some((item) => item.at >= targetTime
          && item.action === 'send_private_msg'
          && String(item.params?.user_id) === USER_ID
          && resultText(item).includes('晴') && resultText(item).includes('24')),
        Math.min(DAILY_PUSH_WAIT_MS, Math.max(1, targetTime - Date.now() + 35_000)));
        requireThat(pushed, 'ASTRBOT_WEATHER_SCHEDULED_PUSH_NOT_CAPTURED');
        result.scheduledDailyPush.capturedPrivateReply = true;
        dailyFixtureAdcodeQuery = fixture.requests.slice(dailyPushFixtureStart).some((request) =>
          request.adcode === '110000' && request.path === FIXTURE_ROUTE && !request.authorizationPresent);
        requireThat(dailyFixtureAdcodeQuery, 'ASTRBOT_WEATHER_SCHEDULED_PUSH_FIXTURE_QUERY_MISSING');
        result.scheduledDailyPush.status = 'passed';
        if (OUTBOUND_GRANT) result.outboundGrant.actualScheduledDeliveryCaptured = true;
      } catch (error) {
        result.scheduledDailyPush.status = 'failed';
        result.scheduledDailyPush.failureCode = safeErrorCode(error);
        addFailure(result, result.scheduledDailyPush.failureCode);
        result.status = 'failed';
      }
      dailyFixtureAdcodeQuery ||= fixture.requests.slice(dailyPushFixtureStart).some((request) =>
        request.adcode === '110000' && request.path === FIXTURE_ROUTE && !request.authorizationPresent);
      result.scheduledDailyPush.fixtureAdcodeQuery = dailyFixtureAdcodeQuery;

      if (OUTBOUND_GRANT) {
        try {
          requireThat(dailyGrant?.id, 'ASTRBOT_WEATHER_OUTBOUND_GRANT_NOT_CREATED');
          const revoked = await policy.revokeOutboundGrant(dailyGrant.id);
          requireThat(revoked.active === false && revoked.reason === 'revoked',
            'ASTRBOT_WEATHER_EXPLICIT_REVOKE_INEFFECTIVE');
          result.outboundGrant.explicitRevokeDenied = await requireOutboundDenied(
            () => policy.authorizeOutbound(grantRequest), 'ASTRBOT_WEATHER_REVOKED_GRANT_ALLOWED');
          result.outboundGrant.revokedCallbackDenied = await requireOutboundCallbackDenied(
            bridge, outboundCallback, sends, 'ASTRBOT_WEATHER_REVOKED_CALLBACK_ALLOWED');

          const replacement = await policy.createOutboundGrant(grantInput);
          ownedGrantIds.add(replacement.id);
          requireThat(replacement.active === true && replacement.id !== dailyGrant.id
            && (await policy.authorizeOutbound(grantRequest)).grantId === replacement.id,
          'ASTRBOT_WEATHER_REPLACEMENT_GRANT_INACTIVE');
          result.outboundGrant.replacementGrantAuthorized = true;
          await manager.configure(installedId, { config: pluginConfig });
          result.outboundGrant.sameConfigInvalidated = await requireOutboundDenied(
            () => policy.authorizeOutbound(grantRequest), 'ASTRBOT_WEATHER_CONFIGURED_GRANT_REVIVED');
          result.outboundGrant.configuredCallbackDenied = await requireOutboundCallbackDenied(
            bridge, outboundCallback, sends, 'ASTRBOT_WEATHER_CONFIGURED_CALLBACK_ALLOWED');

          // Use the actual manager rollback path; never rewrite generation files.
          const rolledBack = await manager.rollback(installedId);
          requireThat(rolledBack.rolledBack === true && rolledBack.installed === true
            && rolledBack.generationId === activePlugin.generationId,
          'ASTRBOT_WEATHER_EXPECTED_ROLLBACK_NOT_RESTORED');
          result.outboundGrant.rollbackRestoredPreviousGeneration = true;
          result.outboundGrant.rollbackDidNotRevive = await requireOutboundDenied(
            () => policy.authorizeOutbound(grantRequest), 'ASTRBOT_WEATHER_ROLLBACK_GRANT_REVIVED');
          result.outboundGrant.rollbackCallbackDenied = await requireOutboundCallbackDenied(
            bridge, outboundCallback, sends, 'ASTRBOT_WEATHER_ROLLBACK_CALLBACK_ALLOWED');
          const records = await policy.listOutboundGrants();
          result.outboundGrant.revokedRecordsInactive = [...ownedGrantIds].every((id) =>
            records.some((record) => record.id === id && record.active === false && record.reason === 'revoked'));
          requireThat(result.outboundGrant.revokedRecordsInactive, 'ASTRBOT_WEATHER_REVOKED_RECORD_ACTIVE');
          requireThat(result.outboundGrant.actualScheduledDeliveryCaptured,
            'ASTRBOT_WEATHER_GRANTED_SCHEDULED_DELIVERY_MISSING');
          result.outboundGrant.status = 'passed';
        } catch (error) {
          result.outboundGrant.status = 'failed';
          result.outboundGrant.failureCode = safeErrorCode(error);
          addFailure(result, result.outboundGrant.failureCode);
        }
      }

      result.controlledFixture.requests = fixture.requests.length;
      result.controlledFixture.cityQueries = fixture.requests.filter((request) => request.city).length;
      result.controlledFixture.adcodeQueries = fixture.requests.filter((request) => request.adcode).length;
      result.controlledFixture.authorizationPresent = fixture.requests.some((request) => request.authorizationPresent);
      requireThat(result.controlledFixture.cityQueries >= 1 && result.controlledFixture.adcodeQueries >= 1
        && !result.controlledFixture.authorizationPresent, 'ASTRBOT_WEATHER_FIXTURE_ASSERTIONS_FAILED');
      result.controlledFixture.status = 'passed';

      if (PUBLIC_TEST) {
        result.publicApi.status = 'running';
        try {
          const publicPluginConfig = {
            api_settings: {
              api_base_url: PUBLIC_API_ENDPOINT, api_key: '', timeout_seconds: 10, lang: 'zh',
            },
            push_settings: {
              enable_daily_push: false, daily_push_times: [], enable_llm_message: false,
              user_id_whitelist: [], daily_extensions: {},
            },
            monitor_settings: { enable_monitor: false },
            query_settings: { enable_ai_intent_detection: true },
          };
          await manager.configure(installedId, { config: publicPluginConfig });
          const publicPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
          requireThat(publicPlugin?.enabled === true, 'ASTRBOT_WEATHER_PUBLIC_PLUGIN_NOT_ENABLED');
          requireThat(publicPlugin.config?.api_settings?.api_base_url === PUBLIC_API_ENDPOINT
            && publicPlugin.config?.api_settings?.api_key === ''
            && publicPlugin.config?.push_settings?.enable_daily_push === false
            && publicPlugin.config?.monitor_settings?.enable_monitor === false,
          'ASTRBOT_WEATHER_PUBLIC_CONFIG_MISMATCH');
          requireThat(publicPlugin.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && publicPlugin.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
            && await installedMainHash(installedId, publicPlugin.generationId)
              === prepared.expected.mainPySHA256.toLowerCase(),
          'ASTRBOT_WEATHER_PUBLIC_SOURCE_HASH_MISMATCH');
          result.publicApi.configured = true;
          result.publicApi.apiKeyConfigured = false;
          result.publicApi.dailyPushEnabled = false;
          result.publicApi.monitorEnabled = false;

          const publicQueryId = `${runId}-public-native-query`;
          const publicQueryStart = sends.length;
          const intentCallsBeforePublic = intentClassificationCalls;
          let publicDispatchResponse;
          try {
            publicDispatchResponse = await bridge.dispatch(message(publicQueryId, '今天的天气怎么样？'));
          } catch (error) {
            result.publicApi.failureCode = safeErrorCode(error);
          }
          result.publicApi.nativeDispatchObserved = observedDispatches.includes(publicQueryId);
          result.publicApi.nativeDispatchHandled = publicDispatchResponse?.status === 'handled';
          const publicReplies = sends.slice(publicQueryStart).filter((item) => item.action === 'send_group_msg'
            && String(item.params?.group_id) === GROUP_ID).map(resultText);
          result.publicApi.capturedGroupReply = publicReplies.length > 0;
          const publicReply = publicReplies.join('\n');
          const parsedWeatherReply = parsePublicWeatherReply(publicReply,
            ['海淀', '海淀区', '北京', '北京市']);
          Object.assign(result.publicApi, parsedWeatherReply);
          result.publicApi.pluginReplyHttpStatus = httpStatusFromReply(publicReply);
          result.publicApi.intentClassificationCalls = intentClassificationCalls - intentCallsBeforePublic;
          result.publicApi.parsedSuccessfulReply = result.publicApi.nativeDispatchObserved
            && result.publicApi.nativeDispatchHandled
            && result.publicApi.locationObserved && result.publicApi.weatherObserved
            && result.publicApi.temperatureObserved && result.publicApi.humidityObserved
            && result.publicApi.intentClassificationCalls > 0;

          if (result.publicApi.parsedSuccessfulReply) {
            result.publicApi.status = 'passed';
          } else {
            result.publicApi.status = 'failed';
            result.publicApi.failureCode ||= !result.publicApi.nativeDispatchObserved
              ? 'ASTRBOT_WEATHER_PUBLIC_NATIVE_DISPATCH_FAILED'
              : !result.publicApi.nativeDispatchHandled
                ? 'ASTRBOT_WEATHER_PUBLIC_NATIVE_QUERY_NOT_HANDLED'
                : 'ASTRBOT_WEATHER_PUBLIC_PARSED_REPLY_MISSING';
            if (result.publicApi.nativeDispatchObserved && result.publicApi.pluginReplyHttpStatus === null) {
              result.publicApi.diagnosticHttpStatus = await diagnosticPublicHttpStatus();
              result.publicApi.diagnosticStatusSource = 'separate-post-failure-status-only-GET';
            }
          }
        } catch (error) {
          result.publicApi.status = 'failed';
          result.publicApi.failureCode ||= safeErrorCode(error);
        }
        if (result.publicApi.status !== 'passed') {
          addFailure(result, result.publicApi.failureCode || 'ASTRBOT_WEATHER_PUBLIC_TEST_FAILED');
          result.status = 'failed';
        }
      } else {
        result.publicApi.status = 'skipped';
      }

      const finalPlugin = (await manager.listPlugins()).find((plugin) => plugin.id === installedId);
      requireThat(finalPlugin?.archiveSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && finalPlugin.sourceSHA256 === prepared.expected.archiveSHA256.toLowerCase()
        && await installedMainHash(installedId, finalPlugin.generationId)
          === prepared.expected.mainPySHA256.toLowerCase(),
      'ASTRBOT_WEATHER_SOURCE_CHANGED_AFTER_DISPATCH');
      const [archiveAfter, manifestAfter] = await Promise.all([
        fs.readFile(path.join(SAMPLES_DIR, 'weather.zip')), fs.readFile(MANIFEST_PATH),
      ]);
      result.lockedSourceHashes.archiveAfter = sha256(archiveAfter);
      result.lockedSourceHashes.manifestAfter = sha256(manifestAfter);
      result.lockedSourceHashes.installedMainPy = await installedMainHash(installedId, finalPlugin.generationId);
      requireThat(result.lockedSourceHashes.archiveAfter === prepared.archiveHash
        && result.lockedSourceHashes.manifestAfter === result.lockedSourceHashes.manifestBefore
        && result.lockedSourceHashes.installedMainPy === prepared.mainHash,
      'ASTRBOT_WEATHER_LOCKED_SOURCE_CHANGED');
      result.lockedSourceHashes.finalCheckPassed = true;
    } catch (error) {
      addFailure(result, safeErrorCode(error));
      result.errorDetails = safeErrorDetails(error);
      result.status = 'failed';
    } finally {
      if (policy && ownedGrantIds.size) {
        for (const id of ownedGrantIds) {
          try { await policy.revokeOutboundGrant(id); }
          catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
      }
      if (policy) {
        try { await policy.setEnabled(false); }
        catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        if (policySnapshot) {
          try {
            if (Object.hasOwn(policySnapshot.groups || {}, GROUP_ID)) {
              await policy.setGroup(GROUP_ID, policySnapshot.groups[GROUP_ID]);
            } else {
              await policy.removeGroup(GROUP_ID);
            }
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
      }
      if (manager && pendingInstall) {
        try {
          const job = await waitForJob(manager, pendingInstall);
          if (job.status === 'succeeded' && typeof job.plugin === 'string') {
            installedId = job.plugin;
            ownedPluginIds.add(installedId);
          }
          pendingInstall = null;
        } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
      }
      if (manager) {
        if (installedId) {
          try {
            const plugin = (await manager.listPlugins()).find((item) => item.id === installedId);
            if (plugin?.enabled) await manager.configure(installedId, { enabled: false });
            const disabled = (await manager.listPlugins()).find((item) => item.id === installedId);
            if (disabled?.enabled !== false) cleanupCodes.push('ASTRBOT_WEATHER_DISABLE_CLEANUP_FAILED');
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
        for (const pluginId of ownedPluginIds) {
          try {
            const plugin = (await manager.listPlugins()).find((item) => item.id === pluginId);
            if (plugin?.enabled) await manager.configure(pluginId, { enabled: false });
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
        if (runtimeStarted) {
          try {
            const stopped = await manager.stop();
            if (stopped?.stopped !== true) cleanupCodes.push('ASTRBOT_WEATHER_RUNTIME_STOP_FAILED');
          } catch (error) { cleanupCodes.push(safeErrorCode(error)); }
        }
      }
      if (bridge && bridgeStarted) {
        try { await bridge.stop(); }
        catch (error) { cleanupCodes.push(safeErrorCode(error)); }
      }
      if (manager && originalRuntimeRpc) manager.runtimeRpc = originalRuntimeRpc;
      if (fixture && fixtureStarted) {
        try { await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
        catch (error) { cleanupCodes.push(safeErrorCode(error)); }
      }
    }

    result.controlledFixture.requests = fixture?.requests.length || result.controlledFixture.requests;
    result.controlledFixture.cityQueries = fixture?.requests.filter((request) => request.city).length
      || result.controlledFixture.cityQueries;
    result.controlledFixture.adcodeQueries = fixture?.requests.filter((request) => request.adcode).length
      || result.controlledFixture.adcodeQueries;
    result.controlledFixture.authorizationPresent = Boolean(fixture?.requests.some((request) => request.authorizationPresent));
    result.localModel.intentClassificationCalls = intentClassificationCalls;
    result.cleanupFailureCodes = cleanupCodes;
    deriveOverallStatus(result);
    console.log(JSON.stringify(result));
    if (result.status !== 'passed') process.exitCode = 1;
  }

  await main();
}
