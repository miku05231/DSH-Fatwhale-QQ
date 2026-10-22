import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Cron } from './third-party/croner/croner.js';
import { createBilibiliAdapter, canonicalItemKey, formatFeedSummary } from './platforms/bilibili.js';

const MAX_DAILY_COMMENTS = 3;
const MIN_COMMENT_GAP_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_STATUSES = new Set(['pending', 'published', 'failed', 'uncertain', 'cancelled']);
const COOKIE_EXTRACTOR_ERRORS = new Set([
  'cookie_database_locked', 'cookie_app_bound_unsupported', 'bilibili_login_not_found',
  'cookie_crypto_unavailable', 'cookie_decryption_failed', 'browser_profile_not_found',
  'cookie_database_unreadable',
]);
const SAFE_REASONS = new Set([
  'bilibili_login_required', 'bilibili_api_rejected', 'bilibili_invalid_response',
  'bilibili_http_error', 'bilibili_request_failed', 'bilibili_invalid_mention',
  'bilibili_invalid_comment', 'bilibili_comment_uncertain', 'bilibili_publication_cancelled',
  'previous_publication_uncertain', 'publication_uncertain', 'publication_cancelled',
  'cron_invalid', 'config_invalid', 'state_invalid', 'boolean_invalid', 'mention_uid_invalid',
  'keywords_invalid', 'upUsers_invalid', 'targets_invalid', 'sources_targets_required',
  'comment_acceptance_required', 'cookie_extractor_failed', 'cookie_extractor_invalid_output',
]);

// Croner supplies calendar/DST semantics; the console accepts five fields only.
export function parseCron(expression) {
  const value = String(expression ?? '').trim();
  if (value.split(/\s+/).length !== 5 || !/^[\d*,/\s-]+$/.test(value)) return null;
  try { return new Cron(value, { paused: true }); } catch { return null; }
}

export function cronMatches(expression, date = new Date()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  return Boolean(cron?.match(date));
}

export function nextCronRun(expression, now = new Date()) {
  return parseCron(expression)?.nextRun(now) ?? null;
}

export function normalizeAutomationConfig(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('config_invalid');
  for (const key of ['enabled', 'commentEnabled', 'commentApproved']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') throw new Error('boolean_invalid');
  }
  function strings(key, limit, validate) {
    const values = source[key] ?? [];
    if (!Array.isArray(values) || values.length > limit) throw new Error(`${key}_invalid`);
    if (values.some((x) => typeof x !== 'string' || !validate(x.trim()))) throw new Error(`${key}_invalid`);
    return [...new Set(values.map((x) => x.trim()))];
  }
  const cron = source.cron ?? '0 9 * * *';
  if (typeof cron !== 'string' || !parseCron(cron)) throw new Error('cron_invalid');
  const mentionUid = source.mentionUid ?? '';
  if (typeof mentionUid !== 'string' || (mentionUid && (!/^[1-9]\d{0,15}$/.test(mentionUid) || !Number.isSafeInteger(Number(mentionUid))))) throw new Error('mention_uid_invalid');
  const config = {
    enabled: source.enabled ?? false,
    cron: cron.trim(),
    keywords: strings('keywords', 50, (x) => Boolean(x) && x.length <= 100),
    upUsers: strings('upUsers', 100, (x) => /^[1-9]\d{0,15}$/.test(x) && Number.isSafeInteger(Number(x))),
    targets: strings('targets', 30, (x) => /^(?:g:)?[1-9]\d{0,15}$/.test(x) && Number.isSafeInteger(Number(x.replace(/^g:/, '')))),
    mentionUid,
    commentEnabled: source.commentEnabled ?? false,
    commentApproved: source.commentApproved ?? false,
  };
  if (config.commentEnabled && (!config.commentApproved || !config.mentionUid)) throw new Error('comment_acceptance_required');
  if (config.enabled && ((!config.keywords.length && !config.upUsers.length) || !config.targets.length)) throw new Error('sources_targets_required');
  return config;
}

function localDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function commentBudget(audit, now = new Date()) {
  const attempts = audit.filter((entry) => ['pending', 'published', 'failed', 'uncertain'].includes(entry.status));
  const todayComments = attempts.filter((entry) => localDay(entry.at) === localDay(now)).length;
  const lastAt = attempts.reduce((latest, entry) => Math.max(latest, Date.parse(entry.at) || 0), 0);
  return {
    todayComments,
    allowed: todayComments < MAX_DAILY_COMMENTS && now.getTime() - lastAt >= MIN_COMMENT_GAP_MS,
    reason: todayComments >= MAX_DAILY_COMMENTS ? 'daily_limit' : now.getTime() - lastAt < MIN_COMMENT_GAP_MS ? 'cooldown' : '',
  };
}

export function parseCommentDecision(value) {
  try {
    const parsed = typeof value === 'object' ? value : JSON.parse(String(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    if (parsed?.relevant !== true || !text || text.length > 300 || /[@\u0000-\u001f]/.test(text)) return null;
    return text;
  } catch { return null; }
}

export function mergePlatformItems(items) {
  const merged = new Map();
  for (const item of items) {
    if (!item || !String(item.id ?? '')) continue;
    const key = canonicalItemKey(item);
    const previous = merged.get(key);
    const keepDynamic = previous?.kind === 'dynamic' && item.kind !== 'dynamic';
    merged.set(key, { ...previous, ...item, ...(keepDynamic ? previous : {}), key,
      title: item.title || previous?.title || '', text: item.text || previous?.text || '',
      origins: [...new Set([...(previous?.origins ?? []), ...(item.origins ?? [])])] });
  }
  return [...merged.values()];
}

async function atomicJson(file, value, { canCommit, onCommit } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (canCommit && canCommit() !== true) throw new Error('qrcode_session_invalid');
    onCommit?.();
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export function readBrowserCookies(script, browser, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(process.env.QQ_PYTHON || 'python', [script, browser, '--json'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { reject(new Error('cookie_extractor_unavailable')); return; }
    let output = '';
    let timedOut = false;
    let oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.stdout.on('data', (chunk) => {
      if (oversized) return;
      output += chunk.toString();
      if (output.length > 64 * 1024) { oversized = true; output = ''; child.kill(); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('cookie_extractor_unavailable')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('cookie_extractor_timeout'));
      if (oversized) return reject(new Error('cookie_extractor_failed'));
      let parsed;
      try { parsed = JSON.parse(output); }
      catch { reject(new Error(code !== 0 ? 'cookie_extractor_failed' : 'cookie_extractor_invalid_output')); return; }
      if (COOKIE_EXTRACTOR_ERRORS.has(parsed?.error)) return reject(new Error(parsed.error));
      if (code !== 0 || parsed?.error) return reject(new Error('cookie_extractor_failed'));
      resolve(parsed);
    });
  });
}

export function createPlatformScheduler({
  configPath, stateDir, projectRoot = path.dirname(configPath), log, sendTarget, generate,
  adapterFactory = createBilibiliAdapter, fetchImpl = globalThis.fetch, cookieExtractor = readBrowserCookies,
  now = () => new Date(), intervalMs = 30_000,
} = {}) {
  const stateFile = path.join(stateDir, 'bilibili-state.json');
  const cookieFile = path.join(stateDir, 'bilibili-cookie.json');
  const queuedFile = path.join(stateDir, 'bilibili-run-now.json');
  const lockFile = path.join(stateDir, 'bilibili-scheduler.lock');
  let timer = null;
  let busy = false;
  let stopped = false;

  async function readConfig() {
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return normalizeAutomationConfig(raw?.automation?.bilibili ?? {});
  }

  async function readState() {
    let state;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('state_invalid');
      state = {};
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state_invalid');
    for (const key of ['seen', 'pending', 'audit']) {
      if (state[key] !== undefined && !Array.isArray(state[key])) throw new Error('state_invalid');
      state[key] ??= [];
    }
    if (state.seen.some((key) => typeof key !== 'string') ||
        state.audit.some((entry) => !entry || !AUDIT_STATUSES.has(entry.status) ||
          !/^[1-9]\d*$/.test(String(entry.dynamicId ?? '')) || !Number.isFinite(Date.parse(entry.at))) ||
        state.pending.some((entry) => !entry?.item || !Array.isArray(entry.targets) || !Array.isArray(entry.sent) ||
          entry.targets.some((target) => typeof target !== 'string') || entry.sent.some((target) => typeof target !== 'string'))) {
      throw new Error('state_invalid');
    }
    // A process may have died after a request was accepted. Never replay that write.
    if (state.audit.some((entry) => entry.status === 'pending')) state.commentBlock = 'previous_publication_uncertain';
    return state;
  }

  async function cookie() {
    try {
      const saved = JSON.parse(await fs.readFile(cookieFile, 'utf8'));
      const values = Object.entries(saved.cookies ?? {}).filter(([name, value]) =>
        /^[A-Za-z0-9_]+$/.test(name) && typeof value === 'string' && !/[\r\n;]/.test(value));
      return values.map(([name, value]) => `${name}=${value}`).join('; ');
    } catch { return ''; }
  }

  async function acquireLock() {
    await fs.mkdir(stateDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const nonce = randomUUID();
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
        await handle.close();
        return async () => {
          try {
            const held = JSON.parse(await fs.readFile(lockFile, 'utf8'));
            if (held.nonce === nonce) await fs.rm(lockFile, { force: true });
          } catch { /* A replaced lock belongs to its new owner. */ }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const held = JSON.parse(await fs.readFile(lockFile, 'utf8'));
          if (!Number.isInteger(held.pid) || held.pid < 1) return null;
          try { process.kill(held.pid, 0); return null; }
          catch (probe) { if (probe.code !== 'ESRCH') return null; }
          await fs.rm(lockFile, { force: true });
        } catch { return null; }
      }
    }
    return null;
  }

  async function extractBrowserCookie(browser = 'edge') {
    if (!['edge', 'chrome'].includes(browser)) throw new Error('browser_invalid');
    const release = await acquireLock();
    if (!release) throw new Error('busy');
    try {
      const parsed = await cookieExtractor(path.join(projectRoot, 'tools', 'bili_cookies.py'), browser);
      await persistLoginCookies(parsed?.cookies, browser);
      return { imported: true, browser };
    } finally { await release(); }
  }

  async function persistLoginCookies(cookies, browser, canSave = () => true, onCommit) {
    if (canSave() !== true) throw new Error('qrcode_session_invalid');
    if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies) || !cookies.SESSDATA || !cookies.bili_jct) {
      throw new Error('cookie_extractor_invalid_output');
    }
    const accepted = {};
    for (const key of ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      if (cookies[key] === undefined) continue;
      if (typeof cookies[key] !== 'string' || /[\r\n;\x00]/.test(cookies[key]) || cookies[key].length > 8192) {
        throw new Error('cookie_extractor_invalid_output');
      }
      accepted[key] = cookies[key];
    }
    const header = Object.entries(accepted).map(([key, value]) => `${key}=${value}`).join('; ');
    if (header.length > 32768) throw new Error('cookie_extractor_invalid_output');
    const adapter = adapterFactory({ cookie: header, fetchImpl });
    if (typeof adapter.validateLogin !== 'function') throw new Error('cookie_extractor_invalid_output');
    await adapter.validateLogin();
    if (canSave() !== true) throw new Error('qrcode_session_invalid');
    const state = await readState();
    for (const entry of state.audit) {
      if (entry.status === 'pending') { entry.status = 'uncertain'; entry.reason = 'previous_publication_uncertain'; }
    }
    await atomicJson(cookieFile, { browser, cookies: accepted }, { canCommit: canSave, onCommit });
    delete state.commentBlock;
    // The login is committed; a failed audit update must not report it as cancelled.
    try { await atomicJson(stateFile, state); }
    catch { log?.warn?.('B站登录态已保存，发布暂停状态未能更新，请重新登录后恢复'); }
  }

  async function importLoginCookies(cookies, { canSave = () => true, onCommit } = {}) {
    if (typeof canSave !== 'function' || canSave() !== true ||
        (onCommit !== undefined && typeof onCommit !== 'function')) throw new Error('qrcode_session_invalid');
    const release = await acquireLock();
    if (!release) throw new Error('busy');
    try {
      await persistLoginCookies(cookies, 'qrcode', canSave, onCommit);
      return { imported: true };
    } finally { await release(); }
  }

  async function queueManualRun() {
    await atomicJson(queuedFile, { queuedAt: now().toISOString() });
    return { queued: true };
  }

  async function runComments(state, cfg, items, adapter) {
    if (!cfg.enabled || !cfg.commentEnabled || !cfg.commentApproved || state.commentBlock) return;
    if (typeof generate !== 'function') return;
    for (const item of items) {
      if (stopped || (item.kind ?? item.source) !== 'dynamic' || !item.commentOid || !item.commentType) continue;
      const dynamicId = String(item.id);
      if (state.audit.some((entry) => entry.dynamicId === dynamicId)) continue;
      if (!commentBudget(state.audit, now()).allowed) break;
      const text = parseCommentDecision(await generate({ kind: 'comment', item, keywords: cfg.keywords, mentionUid: cfg.mentionUid }));
      if (!text) continue;
      const current = await readConfig();
      if (stopped || JSON.stringify(current) !== JSON.stringify(cfg) || !commentBudget(state.audit, now()).allowed) return;
      const entry = { dynamicId, targetUid: cfg.mentionUid, text, at: now().toISOString(), status: 'pending' };
      state.audit.push(entry);
      await atomicJson(stateFile, state);
      let result;
      try {
        result = await adapter.publishComment(item, text, cfg.mentionUid, {
          beforePublish: async ({ message } = {}) => {
            const latest = await readConfig();
            if (stopped || JSON.stringify(latest) !== JSON.stringify(cfg) ||
                !commentBudget(state.audit.filter((row) => row !== entry), now()).allowed) return false;
            entry.at = now().toISOString();
            if (typeof message === 'string') entry.text = message.slice(0, 500);
            await atomicJson(stateFile, state);
            return true;
          },
        });
      }
      catch { result = { published: false, uncertain: true, reason: 'publication_uncertain' }; }
      entry.status = result?.published === true ? 'published' : result?.reason === 'bilibili_publication_cancelled' ? 'cancelled' : result?.uncertain ? 'uncertain' : 'failed';
      entry.reason = entry.status === 'published' ? '' : SAFE_REASONS.has(result?.reason) ? result.reason : 'bilibili_api_rejected';
      if (result?.published && typeof result.message === 'string') entry.text = result.message.slice(0, 500);
      if (!['published', 'cancelled'].includes(entry.status)) state.commentBlock = entry.reason;
      await atomicJson(stateFile, state);
      // The gap also applies to attempts that timed out or were refused.
      break;
    }
  }

  async function tick({ force = false } = {}) {
    if (stopped || busy) return { ok: false, reason: 'busy' };
    busy = true;
    let release;
    let state;
    try {
      release = await acquireLock();
      if (!release) return { ok: false, reason: 'busy' };
      try { await fs.access(queuedFile); force = true; await fs.rm(queuedFile, { force: true }); } catch {}
      const cfg = await readConfig();
      if (!cfg.enabled && !force) return { ok: false, reason: 'disabled' };
      const at = now();
      const minute = Math.floor(at.getTime() / 60_000) * 60_000;
      state = await readState();
      const cron = parseCron(cfg.cron);
      const due = cron.previousRuns(1, new Date(minute + 60_000))[0]?.getTime() ?? 0;
      const from = Math.max(Number(state.lastScheduledAt) || at.getTime() - DAY_MS, at.getTime() - DAY_MS);
      if (!force && (due <= from || state.lastScheduledAt === due)) return { ok: false, reason: 'not_due' };
      state.lastRun = { status: 'running', at: at.toISOString() };
      await atomicJson(stateFile, state);
      const adapter = adapterFactory({ cookie: await cookie(), fetchImpl });
      const results = [];
      for (const keyword of cfg.keywords) results.push(...(await adapter.search(keyword)).map((item) => ({ ...item, origins: [`keyword:${keyword}`] })));
      for (const uid of cfg.upUsers) results.push(...(await adapter.dynamics(uid)).map((item) => ({ ...item, origins: [`up:${uid}`] })));
      const items = mergePlatformItems(results);
      const permittedOrigins = new Set([...cfg.keywords.map((value) => `keyword:${value}`), ...cfg.upUsers.map((value) => `up:${value}`)]);
      state.pending = state.pending.filter((entry) => !entry.item.origins?.length || entry.item.origins.some((origin) => permittedOrigins.has(origin)));
      const seen = new Set(state.seen);
      const newItems = items.filter((item) => !seen.has(item.key));
      for (const item of newItems) {
        seen.add(item.key);
        state.pending.push({ item, targets: [...cfg.targets], sent: [] });
      }
      state.seen = [...seen].slice(-5000);
      // Commit the schedule with its queued reads; transient reads remain due.
      state.lastScheduledAt = due;
      await atomicJson(stateFile, state);
      let pushFailures = 0;
      const summaryCache = new Map();
      for (const target of cfg.targets) {
        const pending = state.pending.filter((entry) => entry.targets.includes(target) && !entry.sent.includes(target));
        if (!pending.length) continue;
        // Each delivery names every included item; do not mark undisplayed overflow as sent.
        for (let offset = 0; offset < pending.length; offset += 8) {
          const batch = pending.slice(offset, offset + 8);
          const summaryKey = JSON.stringify(batch.map((entry) => entry.item.key));
          let summary = summaryCache.get(summaryKey);
          if (!summary) {
            summary = formatFeedSummary(batch.map((entry) => entry.item));
            if (typeof generate === 'function') {
              try {
                const generated = await generate({ kind: 'summary', items: batch.map((entry) => entry.item) });
                if (typeof generated === 'string' && generated.trim()) summary = generated.trim().slice(0, 3500);
              } catch { log?.warn?.('B站摘要模型失败，使用内容摘要'); }
            }
            summaryCache.set(summaryKey, summary);
          }
          try {
            const current = await readConfig();
            if (stopped || JSON.stringify(current) !== JSON.stringify(cfg)) break;
            if (typeof sendTarget !== 'function') throw new Error('transport_unavailable');
            if (await sendTarget(target, summary) === false) throw new Error('push_failed');
            for (const entry of batch) entry.sent.push(target);
            await atomicJson(stateFile, state);
          } catch { pushFailures += 1; break; }
        }
      }
      state.pending = state.pending.filter((entry) => entry.targets.some((target) => cfg.targets.includes(target) && !entry.sent.includes(target)));
      const auditStart = state.audit.length;
      await runComments(state, cfg, items, adapter);
      state.lastRun = { status: pushFailures ? 'partial' : 'ok', at: at.toISOString(), found: newItems.length, pushFailures,
        published: state.audit.slice(auditStart).filter((entry) => entry.status === 'published').length };
      await atomicJson(stateFile, state);
      log?.info?.(`B站自动化完成：新增 ${newItems.length} 条，推送失败 ${pushFailures} 个目标`);
      return { ok: !pushFailures, found: newItems.length, published: state.lastRun.published, reason: pushFailures ? 'push_failed' : '' };
    } catch (error) {
      const reason = SAFE_REASONS.has(error?.message) ? error.message : 'platform_error';
      if (state) {
        state.lastRun = { status: 'error', at: now().toISOString(), reason };
        if (reason === 'bilibili_login_required') state.commentBlock = reason;
        await atomicJson(stateFile, state).catch(() => {});
      }
      log?.warn?.(`B站自动化失败（${reason}）`);
      return { ok: false, reason };
    } finally { busy = false; await release?.(); }
  }

  async function snapshot() {
    const cfg = await readConfig();
    const state = await readState();
    const budget = commentBudget(state.audit, now());
    return { config: cfg, cookieAvailable: Boolean(await cookie()), busy,
      nextRunAt: cfg.enabled ? nextCronRun(cfg.cron, now())?.toISOString() ?? null : null,
      lastRun: state.lastRun ?? null, audit: state.audit.slice(-100).reverse(), todayComments: budget.todayComments,
      blockedReason: state.commentBlock || budget.reason, commentPublicationAvailable: true, requiresAcceptance: !cfg.commentApproved };
  }

  function start() {
    if (timer) return;
    stopped = false;
    const safelyTick = () => { void tick().catch(() => log?.warn?.('B站自动化调度失败')); };
    timer = setInterval(safelyTick, Math.max(10_000, Number(intervalMs) || 30_000));
    timer.unref?.();
    safelyTick();
  }

  function stop() { stopped = true; clearInterval(timer); timer = null; }

  async function saveConfig(config) {
    const normalized = normalizeAutomationConfig(config);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    raw.automation = raw.automation && typeof raw.automation === 'object' ? raw.automation : {};
    raw.automation.bilibili = normalized;
    await atomicJson(configPath, raw);
    return normalized;
  }

  return { start, stop, tick, snapshot, saveConfig, extractBrowserCookie, importLoginCookies, queueManualRun };
}

export const PLATFORM_AUTOMATION_LIMITS = Object.freeze({ maxDailyComments: MAX_DAILY_COMMENTS, minCommentGapMs: MIN_COMMENT_GAP_MS });
