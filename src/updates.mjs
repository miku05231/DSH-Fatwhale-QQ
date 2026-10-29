import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const REPOSITORY = 'miku05231/DSH-Fatwhale-QQ';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const ACTIVE_PHASES = new Set(['downloading', 'installing']);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 250 * 1024 * 1024;
const executeFile = promisify(execFile);

async function defaultRunGit(args, { cwd }) {
  const { stdout } = await executeFile('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return stdout.trim();
}

function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { value, numbers: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw failure('UPDATE_BAD_VERSION', '版本号必须是有效的 SemVer。');
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function assetUrl(tag, name) {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function isAssetUrl(value, expected) {
  const url = safeUrl(value);
  return Boolean(url && url.href === expected);
}

function allowedRedirect(value, original) {
  const url = safeUrl(value);
  return Boolean(url && (url.href === original || DOWNLOAD_HOSTS.has(url.hostname)));
}

async function readSmallJson(file, maxBytes = 32 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid JSON file.');
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function defaultLaunchInstaller({ scriptPath, jobPath, cwd }) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  // Start-Process resolves these provider paths as wildcard patterns, even quoted.
  const providerPath = value => `([System.Management.Automation.WildcardPattern]::Escape(${literal(value)}))`;
  // Start-Process creates an independent hidden console. DETACHED_PROCESS makes
  // Windows PowerShell exit before -File; a shared console dies with the WebUI.
  const argumentsLine = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -JobPath "${jobPath}"`;
  const command = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(argumentsLine)} -WorkingDirectory ${providerPath(cwd)} -WindowStyle Hidden -RedirectStandardOutput ${providerPath(path.join(cwd, 'installer.stdout.log'))} -RedirectStandardError ${providerPath(path.join(cwd, 'installer.stderr.log'))} -ErrorAction Stop | Out-Null`;
  await executeFile(executable, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
}

/**
 * Update checks never run application code from a release. Installation is
 * delegated to a copy of the currently installed, trusted PowerShell helper.
 */
export function createUpdateManager({
  projectRoot,
  stateDir = path.join(projectRoot, 'state'),
  configFile = path.join(projectRoot, 'config.json'),
  log = () => {},
  fetchImpl = globalThis.fetch,
  launchInstaller = defaultLaunchInstaller,
  runGit = defaultRunGit,
  platform = process.platform,
  isDocker = Boolean(process.env.container || process.env.DOCKER_CONTAINER) || existsSync('/.dockerenv'),
  now = Date.now,
  jobIdFactory = randomUUID,
  checkCacheMs = 60_000,
  initialDelayMs = 20_000,
  checkIntervalMs = 6 * 60 * 60 * 1000,
  requestTimeoutMs = 20_000,
  downloadTimeoutMs = 120_000,
  installationTimeoutMs = 5 * 60 * 1000,
  maxPackageBytes = MAX_PACKAGE_BYTES,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required.');
  let root = path.resolve(projectRoot);
  let dataRoot = path.resolve(stateDir);
  let configurationPath = path.resolve(configFile);
  let updatesRoot = path.join(dataRoot, 'updates');
  let settingsFile = path.join(updatesRoot, 'settings.json');
  let resultFile = path.join(updatesRoot, 'result.json');
  let lockFile = path.join(updatesRoot, 'install.lock');
  const normalized = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  let initialization;
  let currentVersion = 'unknown';
  let latestRelease = null;
  let eligibility = { allowed: false, reason: '正在确认安装环境。' };
  let checkPromise = null;
  let installPromise = null;
  let settingsQueue = Promise.resolve();
  let lastCheckAttempt = null;
  let timer = null;
  let started = false;
  let activeJobId = null;
  let pendingRestartJob = null;
  let installationStartedAt = null;
  let lockPresent = false;
  let lastResultKey = null;
  const controllers = new Set();
  const state = {
    latestVersion: null,
    phase: 'idle',
    automatic: true,
    checkedAt: null,
    releaseUrl: RELEASES_URL,
    releaseNotes: '',
    publishedAt: null,
    progress: null,
    error: null,
  };

  async function assertUnlinkedPath(value) {
    for (let probe = path.resolve(value); ; probe = path.dirname(probe)) {
      try {
        if ((await lstat(probe)).isSymbolicLink()) {
          throw failure('UPDATE_UNSAFE_PATH', '更新路径包含符号链接或 junction，请手动更新。');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (path.dirname(probe) === probe) return;
    }
  }

  // Windows realpath expands ordinary 8.3 names as well as resolving links.
  // Reject links explicitly before comparing canonical path identities.
  async function canonicalPath(value) {
    await assertUnlinkedPath(value);
    const missing = [];
    for (let probe = path.resolve(value); ; probe = path.dirname(probe)) {
      try {
        return path.join(await realpath(probe), ...missing);
      } catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(probe) === probe) throw error;
        missing.unshift(path.basename(probe));
      }
    }
  }

  async function pathIdentity(value) {
    return normalized(await canonicalPath(value));
  }

  function report(message) {
    try {
      const result = typeof log === 'function' ? log(message) : log?.info?.(message);
      result?.catch?.(() => {});
    } catch { /* Logging must not interrupt the bridge. */ }
  }

  function publicError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('UPDATE_')
      ? error.message
      : '更新操作失败，请稍后重试或前往 GitHub 发布页手动更新。';
  }

  function snapshot() {
    const available = latestRelease && compareVersions(latestRelease.version, currentVersion) > 0;
    let reason = eligibility.reason;
    if (eligibility.allowed) {
      if (ACTIVE_PHASES.has(state.phase)) reason = state.phase === 'downloading' ? '正在下载更新。' : '正在安装更新。';
      else if (lockPresent) reason = '存在未完成的更新任务，已暂停应用内安装，请到发布页手动更新。';
      else if (!available) reason = '尚未发现可安装的新版。';
      else reason = eligibility.mode === 'source' ? null : latestRelease.installReason;
    }
    return {
      currentVersion,
      ...state,
      installMode: eligibility.mode || null,
      canInstall: Boolean(eligibility.allowed && available && (eligibility.mode === 'source' || latestRelease.installable)
        && !lockPresent && !ACTIVE_PHASES.has(state.phase)),
      installReason: reason || null,
    };
  }

  const git = (...args) => runGit(args, { cwd: root });

  async function inspectSource() {
    try {
      const top = await git('rev-parse', '--show-toplevel');
      if (await pathIdentity(top) !== await pathIdentity(root)) throw new Error('Nested checkout.');
      const gitDir = await lstat(path.join(root, '.git'));
      if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) throw new Error('Linked checkout.');
      await assertUnlinkedPath(path.join(root, '.git'));
      await git('symbolic-ref', '--quiet', 'HEAD');
      if (await git('status', '--porcelain', '--untracked-files=no')) {
        return { allowed: false, mode: 'source', reason: '源码有未提交的修改，请先提交或自行保存修改，再检查更新。' };
      }
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
        if (existsSync(path.join(root, '.git', marker))) throw new Error('Git operation in progress.');
      }
      for (const relative of ['scripts/install-update.ps1', 'launcher/bootstrap.ps1', 'launcher/Launcher.ps1', 'src/index.js', 'src/webui/server.mjs']) {
        const file = path.join(root, relative);
        await assertUnlinkedPath(file);
        if (!(await lstat(file)).isFile()) throw new Error('Incomplete checkout.');
      }
      return { allowed: true, mode: 'source', reason: null };
    } catch {
      return { allowed: false, mode: 'source', reason: '无法确认完整、空闲的 Git 分支，请安装 Git 并使用 git pull 手动更新。' };
    }
  }

  async function inspectEnvironment() {
    if (platform !== 'win32' || isDocker) return { allowed: false, reason: '此环境请前往 GitHub 发布页手动更新。' };
    if (!parseVersion(currentVersion)) return { allowed: false, reason: '当前版本号无效，请手动安装完整便携包。' };
    try {
      if (await pathIdentity(dataRoot) !== await pathIdentity(path.join(root, 'state'))) {
        return { allowed: false, reason: '自定义状态目录请手动更新，保留现有配置和数据。' };
      }
      if (await pathIdentity(configurationPath) !== await pathIdentity(path.join(root, 'config.json'))) {
        return { allowed: false, reason: '自定义配置路径请手动更新，保留现有配置和数据。' };
      }
    } catch {
      return { allowed: false, reason: '安装路径包含链接或无法确认，请手动更新。' };
    }
    for (let directory = root; ; directory = path.dirname(directory)) {
      try {
        await lstat(path.join(directory, '.git'));
        if (normalized(directory) === normalized(root)) return inspectSource();
        return { allowed: false, reason: '源码目录请使用 git pull 更新。' };
      } catch (error) {
        if (error.code !== 'ENOENT') return { allowed: false, reason: '无法确认安装目录，请手动更新。' };
      }
      if (path.dirname(directory) === directory) break;
    }
    try {
      const [launcher, helper] = await Promise.all([
        lstat(path.join(root, 'qq-bridge.exe')),
        lstat(path.join(root, 'scripts', 'install-update.ps1')),
      ]);
      if (!launcher.isFile() || launcher.isSymbolicLink() || !helper.isFile() || helper.isSymbolicLink()) throw new Error('Not a portable package.');
      await assertUnlinkedPath(path.join(root, 'scripts', 'install-update.ps1'));
      for (const dir of [dataRoot, updatesRoot]) {
        try {
          const info = await lstat(dir);
          if (!info.isDirectory()) throw new Error('Not an update directory.');
          await assertUnlinkedPath(dir);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return { allowed: true, mode: 'portable', reason: null };
    } catch {
      return { allowed: false, reason: '请安装完整 Windows 便携包后使用应用内更新。' };
    }
  }

  async function readResult({ initial = false } = {}) {
    try {
      const result = await readSmallJson(resultFile);
      const expectedJobId = activeJobId || pendingRestartJob?.jobId;
      if (result.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(result.jobId ?? '')
        || !parseVersion(result.version) || !['complete', 'error'].includes(result.phase)
        || (expectedJobId && result.jobId !== expectedJobId)
        || (!initial && !expectedJobId)
        || (pendingRestartJob && result.version !== pendingRestartJob.version)) return;
      if (result.phase === 'complete' && result.version !== currentVersion) return;
      if (result.phase === 'error' && compareVersions(result.version, currentVersion) < 0) return;
      if (!initial && ['checking', 'available', 'downloading'].includes(state.phase)) return;
      const key = `${result.jobId}:${result.phase}:${result.completedAt ?? result.at ?? ''}`;
      if (key === lastResultKey) return;
      lastResultKey = key;
      pendingRestartJob = null;
      if (result.phase === 'complete') {
        state.phase = 'complete';
        state.progress = 100;
        state.error = null;
      } else {
        state.phase = 'error';
        state.progress = null;
        state.error = String(result.error || result.message || '安装未完成，已保留原版本。').slice(0, 1000);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') report('[updates] 无法读取上次更新结果。');
    }
  }

  async function refreshLock() {
    try {
      await lstat(lockFile);
      lockPresent = true;
    } catch (error) {
      lockPresent = error.code !== 'ENOENT';
    }
  }

  /**
   * A previous release installer can exit without clearing its lock (for
   * example when the app was closed or the process was killed). If the lock
   * belongs to this installation and no update job is still running, the job
   * directory and lock are stale. Clear only that exact pair:
   *   - a result file must not report an in-progress phase;
   *   - the lock must name the current project;
   *   - the job must not be owned by a live process.
   */
  async function recoverStaleLock() {
    try {
      const lock = await readSmallJson(lockFile);
      if (lock.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(lock.jobId ?? '')
          || typeof lock.projectRoot !== 'string'
          || await pathIdentity(lock.projectRoot) !== await pathIdentity(root)) return;
      const jobDir = path.join(updatesRoot, lock.jobId);
      let result = null;
      try { result = await readSmallJson(path.join(jobDir, 'result.json')); } catch { /* 没有结果就是上次未完成 */ }
      if (result && ['downloading', 'installing', 'verifying', 'applying'].includes(result.phase)) return;
      try {
        const pid = Number(lock.consolePid);
        // Older lock files have no owner PID. Keep them so a late completion
        // result can still be consumed instead of deleting it immediately.
        if (!Number.isInteger(pid) || pid <= 0) return;
        try {
          process.kill(pid, 0);
          return; // 同 PID 的更新进程仍在线，保留锁。
        } catch (error) {
          if (error.code !== 'ESRCH') return; // 无法确认就保守保留。
        }
        await assertUnlinkedPath(lockFile);
        await rm(lockFile, { force: true });
        await rm(jobDir, { recursive: true, force: true }).catch(() => {});
        lockPresent = false;
        pendingRestartJob = null;
      } catch {
        /* 清理失败时保持锁，后续状态继续显示需要人工处理。 */
      }
    } catch {
      /* 无锁或锁内容不可读，交给后续安装保护处理。 */
    }
  }

  async function releaseLock(jobId) {
    try {
      await assertUnlinkedPath(lockFile);
      const lock = await readSmallJson(lockFile);
      if (lock.jobId !== jobId) return;
      await rm(lockFile);
      lockPresent = false;
    } catch (error) {
      if (error.code === 'ENOENT') lockPresent = false;
      else report('[updates] 更新任务锁未能释放，请检查上次安装结果。');
    }
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        try {
          const paths = await Promise.all([canonicalPath(root), canonicalPath(dataRoot), canonicalPath(configurationPath)]);
          [root, dataRoot, configurationPath] = paths;
          updatesRoot = path.join(dataRoot, 'updates');
          settingsFile = path.join(updatesRoot, 'settings.json');
          resultFile = path.join(updatesRoot, 'result.json');
          lockFile = path.join(updatesRoot, 'install.lock');
        } catch { /* Eligibility and write operations independently reject unsafe paths. */ }
        try {
          const pkg = await readSmallJson(path.join(root, 'package.json'));
          if (parseVersion(pkg.version)) currentVersion = pkg.version;
        } catch { report('[updates] 无法读取当前应用版本。'); }
        try {
          const settings = await readSmallJson(settingsFile);
          if (typeof settings.automatic === 'boolean') state.automatic = settings.automatic;
        } catch (error) {
          if (error.code !== 'ENOENT') report('[updates] 更新设置无效，使用默认设置。');
        }
        eligibility = await inspectEnvironment();
        await refreshLock();
        if (lockPresent) await recoverStaleLock();
        if (lockPresent) {
          try {
            const lock = await readSmallJson(lockFile);
            if (lock.schemaVersion === 1 && /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(lock.jobId ?? '')
              && parseVersion(lock.version) && parseVersion(currentVersion)
              && compareVersions(lock.version, currentVersion) >= 0
              && typeof lock.projectRoot === 'string' && await pathIdentity(lock.projectRoot) === await pathIdentity(root)) {
              pendingRestartJob = { jobId: lock.jobId, version: lock.version };
            }
          } catch { /* An unreadable lock still prevents a second installer. */ }
        }
        await readResult({ initial: true });
      })();
    }
    await initialization;
  }

  async function requestBytes(url, {
    api = false, maxBytes, file = null, expectedSize = null, onProgress = () => {},
    timeoutMs = requestTimeoutMs, allowNotFound = false,
  }) {
    const controller = new AbortController();
    controllers.add(controller);
    let timeout;
    let reader;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(failure('UPDATE_TIMEOUT', '连接 GitHub 超时，请稍后重试。', 504));
        controller.abort();
      }, timeoutMs);
    });
    const within = (promise) => Promise.race([promise, deadline]);
    let response;
    try {
      let target = url;
      for (let redirects = 0; ; redirects += 1) {
        response = await within(fetchImpl(target, {
          redirect: 'manual',
          signal: controller.signal,
          headers: api ? {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': `qq-bridge/${currentVersion}`,
          } : { Accept: 'application/octet-stream', 'User-Agent': `qq-bridge/${currentVersion}` },
        }));
        if (response.redirected) throw failure('UPDATE_UNTRUSTED_URL', '更新下载发生了未经核验的跳转。');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          let next;
          try { next = new URL(location, target).href; } catch { /* Rejected below. */ }
          void response.body?.cancel().catch(() => {});
          if (api || !location || redirects >= 3 || !allowedRedirect(next, url)) {
            throw failure('UPDATE_UNTRUSTED_URL', '更新下载地址不受信任，请前往发布页手动更新。');
          }
          target = next;
          continue;
        }
        break;
      }
      if (allowNotFound && response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw failure('UPDATE_HTTP', response.status === 403 || response.status === 429
          ? 'GitHub 暂时限制了更新检查，请稍后重试。'
          : 'GitHub 发布服务暂时不可用，请稍后重试。', 502);
      }
      const declaredText = response.headers.get('content-length');
      const declared = declaredText && /^\d+$/.test(declaredText) ? Number(declaredText) : null;
      if (declared !== null && (!Number.isSafeInteger(declared) || declared > maxBytes)) {
        throw failure('UPDATE_TOO_LARGE', '更新文件超过允许的大小。');
      }
      if (file && expectedSize !== null && declared !== null && declared !== expectedSize) {
        throw failure('UPDATE_SIZE_MISMATCH', '更新文件大小与发布信息不一致。');
      }
      if (!response.body?.getReader) throw failure('UPDATE_EMPTY_RESPONSE', 'GitHub 返回了无效的更新文件。');
      reader = response.body.getReader();
      const chunks = [];
      const hash = createHash('sha256');
      let total = 0;
      for (;;) {
        const { done, value } = await within(reader.read());
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes || (expectedSize !== null && total > expectedSize)) {
          throw failure('UPDATE_TOO_LARGE', '更新文件超过允许的大小。');
        }
        hash.update(chunk);
        if (file) await within(file.writeFile(chunk));
        else chunks.push(chunk);
        onProgress(expectedSize ? Math.min(99, Math.floor(total / expectedSize * 100)) : null);
      }
      if (!total || (expectedSize !== null && total !== expectedSize)) {
        throw failure('UPDATE_SIZE_MISMATCH', '更新文件不完整，请重新下载。');
      }
      return { buffer: file ? null : Buffer.concat(chunks, total), bytes: total, sha256: hash.digest('hex') };
    } finally {
      clearTimeout(timeout);
      controller.abort();
      controllers.delete(controller);
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  function parseRelease(release) {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    const parsed = parseVersion(version);
    if (!parsed || parsed.prerelease.length || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
      throw failure('UPDATE_INVALID_RELEASE', '发布信息不是有效稳定版本，请前往发布页检查。');
    }
    const packageName = `qq-bridge-${version}-portable-win64.zip`;
    const matching = (name) => release.assets.filter((asset) => asset?.name === name);
    const packages = matching(packageName);
    const checksums = matching('SHA256SUMS.txt');
    const validAsset = (asset, name, maxBytes) => asset && Number.isSafeInteger(asset.size) && asset.size > 0
      && asset.size <= maxBytes && isAssetUrl(asset.browser_download_url, assetUrl(tag, name));
    const installable = packages.length === 1 && checksums.length === 1
      && validAsset(packages[0], packageName, maxPackageBytes)
      && validAsset(checksums[0], 'SHA256SUMS.txt', MAX_CHECKSUM_BYTES);
    return {
      version, tag, packageName, package: packages[0], checksums: checksums[0], installable,
      installReason: installable ? null : '发布版本缺少可信的完整便携包或 SHA256SUMS.txt，请手动更新。',
      url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
      notes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '',
      publishedAt: typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at))
        ? new Date(release.published_at).toISOString() : null,
    };
  }

  async function check() {
    await initialize();
    if (ACTIVE_PHASES.has(state.phase)) return snapshot();
    if (checkPromise) return checkPromise;
    if (lastCheckAttempt !== null && now() - lastCheckAttempt < checkCacheMs) return snapshot();
    lastCheckAttempt = now();
    state.phase = 'checking';
    state.error = null;
    state.progress = null;
    checkPromise = (async () => {
      try {
        eligibility = await inspectEnvironment();
        const response = await requestBytes(LATEST_URL, { api: true, maxBytes: MAX_JSON_BYTES, allowNotFound: true });
        if (!response) {
          latestRelease = null;
          state.latestVersion = null;
          state.releaseUrl = RELEASES_URL;
          state.releaseNotes = '';
          state.publishedAt = null;
          state.phase = 'current';
        } else {
          let release;
          try { release = JSON.parse(response.buffer.toString('utf8')); } catch {
            throw failure('UPDATE_INVALID_RELEASE', 'GitHub 返回了无效的发布信息。');
          }
          const candidate = parseRelease(release);
          if (!parseVersion(currentVersion)) throw failure('UPDATE_BAD_VERSION', '无法确认当前版本，请手动检查更新。');
          latestRelease = candidate;
          state.latestVersion = candidate.version;
          state.releaseUrl = candidate.url;
          state.releaseNotes = candidate.notes;
          state.publishedAt = candidate.publishedAt;
          state.phase = compareVersions(candidate.version, currentVersion) > 0 ? 'available' : 'current';
        }
      } catch (error) {
        state.phase = 'error';
        state.error = publicError(error);
        report(`[updates] ${state.error}`);
      } finally {
        state.checkedAt = new Date(now()).toISOString();
        checkPromise = null;
      }
      return snapshot();
    })();
    return checkPromise;
  }

  async function ensureUpdatesDirectory() {
    await assertUnlinkedPath(updatesRoot);
    await mkdir(updatesRoot, { recursive: true, mode: 0o700 });
    for (const dir of [dataRoot, updatesRoot]) {
      const info = await lstat(dir);
      if (!info.isDirectory()) throw failure('UPDATE_UNSAFE_PATH', '更新路径不是目录，请手动更新。');
      await assertUnlinkedPath(dir);
    }
  }

  async function prepareSource(release, jobId) {
    const originalCommit = await git('rev-parse', '--verify', 'HEAD');
    const branch = await git('symbolic-ref', '--quiet', 'HEAD');
    const sourceRef = `refs/qq-bridge-updates/${jobId}`;
    try {
      await git('fetch', '--no-tags', '--no-recurse-submodules',
        `https://github.com/${REPOSITORY}.git`, `refs/tags/${release.tag}:${sourceRef}`);
      const targetCommit = await git('rev-parse', '--verify', `${sourceRef}^{commit}`);
      await git('merge-base', '--is-ancestor', originalCommit, targetCommit);
      const pkg = JSON.parse(await git('show', `${targetCommit}:package.json`));
      if (pkg.name !== 'qq-bridge' || pkg.version !== release.version) {
        throw failure('UPDATE_SOURCE_VERSION', '发布标签中的应用版本不匹配，已取消更新。');
      }
      return { mode: 'source', originalCommit, targetCommit, branch, sourceRef };
    } catch (error) {
      await git('update-ref', '-d', sourceRef).catch(() => {});
      if (error?.code?.startsWith?.('UPDATE_')) throw error;
      throw failure('UPDATE_SOURCE_FETCH', '源码更新拉取失败或当前分支与发布版本已分叉，请检查网络或使用 git pull 手动处理。');
    }
  }

  async function performInstall(release) {
    let jobDir;
    let installerStarted = false;
    let source;
    try {
      eligibility = await inspectEnvironment();
      if (!eligibility.allowed) throw failure('UPDATE_MANUAL_ONLY', eligibility.reason);
      await ensureUpdatesDirectory();
      const jobId = String(jobIdFactory());
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(jobId)) throw failure('UPDATE_BAD_JOB', '无法创建更新任务。');
      let lock;
      try {
        lock = await open(lockFile, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') {
          lockPresent = true;
          throw failure('UPDATE_LOCKED', '已有更新任务正在进行，请先确认其安装结果。', 409);
        }
        throw error;
      }
      activeJobId = jobId;
      pendingRestartJob = null;
      lockPresent = true;
      try {
        await lock.writeFile(`${JSON.stringify({
          schemaVersion: 1, jobId, version: release.version, projectRoot: root,
          consolePid: process.pid, createdAt: new Date(now()).toISOString(),
        }, null, 2)}\n`, 'utf8');
      } finally {
        await lock.close();
      }
      jobDir = path.join(updatesRoot, jobId);
      await mkdir(jobDir, { mode: 0o700 });
      if (eligibility.mode === 'source') source = await prepareSource(release, jobId);
      let packagePath;
      let expectedSha256;
      if (!source) {
        const checksum = await requestBytes(release.checksums.browser_download_url, { maxBytes: MAX_CHECKSUM_BYTES });
        const entries = checksum.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line) => {
          const match = /^([a-fA-F0-9]{64})[ \t]+[*]?(.+?)\s*$/.exec(line);
          return match && match[2] === release.packageName ? [match[1].toLowerCase()] : [];
        });
        if (entries.length !== 1) throw failure('UPDATE_BAD_CHECKSUM', '校验和文件缺少唯一的便携包记录。');
        packagePath = path.join(jobDir, release.packageName);
        const partialPath = `${packagePath}.part`;
        const output = await open(partialPath, 'wx', 0o600);
        let downloaded;
        try {
          downloaded = await requestBytes(release.package.browser_download_url, {
            maxBytes: maxPackageBytes,
            file: output,
            expectedSize: release.package.size,
            timeoutMs: downloadTimeoutMs,
            onProgress: (progress) => { state.progress = progress; },
          });
        } finally {
          await output.close();
        }
        if (downloaded.sha256 !== entries[0]) throw failure('UPDATE_HASH_MISMATCH', '便携包 SHA-256 校验失败，已取消安装。');
        await rename(partialPath, packagePath);
        expectedSha256 = entries[0];
      }
      const scriptPath = path.join(jobDir, 'install-update.ps1');
      const jobPath = path.join(jobDir, 'job.json');
      const job = {
        schemaVersion: 1, jobId, projectRoot: root, packagePath,
        expectedSha256, version: release.version, ...source,
        consolePid: process.pid, resultPath: resultFile,
      };
      await copyFile(path.join(root, 'scripts', 'install-update.ps1'), scriptPath);
      await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      state.progress = 100;
      await launchInstaller({ scriptPath, jobPath, job, cwd: jobDir });
      installerStarted = true;
      installationStartedAt = now();
      state.phase = 'installing';
      report(`[updates] ${release.version} 已通过校验，正在安装。`);
    } catch (error) {
      state.phase = 'error';
      state.progress = null;
      state.error = publicError(error);
      report(`[updates] ${state.error}`);
      if (source && !installerStarted) await git('update-ref', '-d', source.sourceRef).catch(() => {});
      if (jobDir && !installerStarted && path.dirname(jobDir) === updatesRoot) {
        await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      }
      if (!installerStarted && activeJobId) await releaseLock(activeJobId);
    }
  }

  async function install({ version } = {}) {
    await initialize();
    if (checkPromise) await checkPromise;
    if (!parseVersion(version) || !latestRelease || version !== latestRelease.version
      || compareVersions(version, currentVersion) <= 0) {
      throw failure('UPDATE_NOT_AVAILABLE', '请先检查更新，并确认安装当前检测到的新版。', 409);
    }
    if (ACTIVE_PHASES.has(state.phase) || installPromise) return snapshot();
    if (!eligibility.allowed || (eligibility.mode !== 'source' && !latestRelease.installable)) {
      throw failure('UPDATE_MANUAL_ONLY', eligibility.reason || latestRelease.installReason, 409);
    }
    if (lockPresent) throw failure('UPDATE_LOCKED', '已有更新任务正在进行，请先确认其安装结果。', 409);
    state.phase = 'downloading';
    state.progress = 0;
    state.error = null;
    installPromise = performInstall(latestRelease).finally(() => { installPromise = null; });
    return snapshot();
  }

  function cancelTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }

  function schedule(delay) {
    cancelTimer();
    if (!started || !state.automatic) return;
    timer = setTimeoutImpl(async () => {
      timer = null;
      try { await check(); } catch { report('[updates] 后台更新检查失败。'); }
      if (started && state.automatic) schedule(checkIntervalMs);
    }, delay);
    timer?.unref?.();
  }

  async function setAutomatic(enabled) {
    if (typeof enabled !== 'boolean') throw failure('UPDATE_BAD_SETTINGS', 'automatic 必须是布尔值。');
    await initialize();
    const operation = settingsQueue.then(async () => {
      let tempPath;
      try {
        await ensureUpdatesDirectory();
        tempPath = path.join(updatesRoot, `settings-${randomUUID()}.tmp`);
        await writeFile(tempPath, `${JSON.stringify({ schemaVersion: 1, automatic: enabled }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(tempPath, settingsFile);
      } catch (error) {
        if (error?.code?.startsWith('UPDATE_')) throw error;
        throw failure('UPDATE_SETTINGS_WRITE', '无法保存更新设置，请检查应用目录权限。', 500);
      } finally {
        if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
      }
      state.automatic = enabled;
      if (started) schedule(initialDelayMs);
      return snapshot();
    });
    settingsQueue = operation.catch(() => {});
    return operation;
  }

  return {
    async status() {
      await initialize();
      if (activeJobId || pendingRestartJob) await readResult();
      if (installationStartedAt !== null) {
        if (state.phase === 'installing' && now() - installationStartedAt >= installationTimeoutMs) {
          state.phase = 'error';
          state.error = '安装器尚未报告结果，已暂停重复安装。请先确认上次安装已结束，再到发布页手动更新。';
          state.progress = null;
        }
      }
      await refreshLock();
      return snapshot();
    },
    check,
    setAutomatic,
    install,
    async start() {
      try {
        await initialize();
        if (!started) {
          started = true;
          schedule(initialDelayMs);
        }
      } catch { report('[updates] 自动更新初始化失败，桥接继续运行。'); }
      return snapshot();
    },
    stop() {
      started = false;
      cancelTimer();
      for (const controller of controllers) controller.abort();
    },
  };
}
