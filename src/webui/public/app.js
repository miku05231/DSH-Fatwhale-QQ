/**
 * 大肥鱼控制台 —— 前端逻辑
 * 零依赖 ES module。所有请求走 /api/*，统一 { ok, data } / { ok, error } 信封。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATE = {
  page: 'overview',
  overview: null,
  logName: 'napcat',
  busy: new Set(),
  expanded: new Set(),
  stickers: null,
  stickerTag: '',
  stickerItems: new Map(),
  personas: null,
};

/* ------------------------------------------------------------------ 工具 */

/** 统一请求：返回 data，失败抛错（错误文案已脱敏） */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`服务端返回了非 JSON（HTTP ${res.status}）`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 相对时间：3 秒前 / 5 分钟前 / 2 小时前 / 10-20 14:03 */
function relTime(value) {
  if (!value) return '—';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function clockTime(value) {
  const t = value ? Date.parse(value) : Date.now();
  const d = new Date(Number.isFinite(t) ? t : Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

function humanUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* -------------------------------------------------------------- 提示条 */

let snackTimer = 0;

function snackbar(message, { action, onAction, duration = 3200 } = {}) {
  const box = $('#snackbar');
  const label = $('#snackbarText');
  const btn = $('#snackbarAction');
  if (!box || !label || !btn) return;

  label.textContent = message;
  if (action && typeof onAction === 'function') {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => {
      hideSnackbar();
      try {
        onAction();
      } catch (err) {
        console.warn(err);
      }
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }

  box.classList.add('is-visible');
  window.clearTimeout(snackTimer);
  snackTimer = window.setTimeout(hideSnackbar, Math.max(1600, duration));
}

function hideSnackbar() {
  $('#snackbar')?.classList.remove('is-visible');
}

/* -------------------------------------------------------------- 对话框 */

let dialogResolve = null;

function confirmDialog(title, body, { okText = '确定', danger = true } = {}) {
  const scrim = $('#dialogScrim');
  const okBtn = $('#dialogOk');
  if (!scrim || !okBtn) return Promise.resolve(window.confirm(body || title));

  $('#dialogTitle').textContent = title;
  $('#dialogBody').textContent = body || '';
  okBtn.textContent = okText;
  okBtn.classList.toggle('btn--danger', Boolean(danger));
  okBtn.classList.toggle('btn--filled', !danger);
  scrim.hidden = false;

  return new Promise((resolve) => {
    dialogResolve = (value) => {
      dialogResolve = null;
      scrim.hidden = true;
      resolve(value);
    };
  });
}

function closeDialog(value) {
  if (typeof dialogResolve === 'function') dialogResolve(value);
  else $('#dialogScrim') && ($('#dialogScrim').hidden = true);
}

/* 输入型对话框：新建人格之类只需要一个名字的地方，别用 window.prompt（样式对不上） */
let promptResolve = null;

function closePrompt(value) {
  if (typeof promptResolve === 'function') promptResolve(value);
  else if ($('#promptScrim')) $('#promptScrim').hidden = true;
}

function promptDialog(title, { body = '', placeholder = '', value = '', okText = '确定', hint = '' } = {}) {
  const scrim = $('#promptScrim');
  if (!scrim) {
    const answer = window.prompt(title, value);
    return Promise.resolve(answer == null ? null : answer.trim());
  }
  const titleNode = $('#promptTitle');
  const bodyNode = $('#promptBody');
  const input = $('#promptInput');
  const hintNode = $('#promptHint');
  if (titleNode) titleNode.textContent = title;
  if (bodyNode) {
    bodyNode.textContent = body;
    bodyNode.hidden = !body;
  }
  if (input) {
    input.value = value;
    input.placeholder = placeholder;
  }
  if (hintNode) {
    hintNode.textContent = hint;
    hintNode.hidden = !hint;
  }
  const okBtn = $('#promptOk');
  if (okBtn) okBtn.textContent = okText;
  scrim.hidden = false;
  window.setTimeout(() => {
    input?.focus();
    input?.select();
  }, 30);

  return new Promise((resolve) => {
    promptResolve = (answer) => {
      promptResolve = null;
      scrim.hidden = true;
      resolve(answer);
    };
  });
}

function submitPrompt() {
  const input = $('#promptInput');
  const value = (input?.value ?? '').trim();
  if (!value) {
    snackbar('名字不能为空');
    input?.focus();
    return;
  }
  closePrompt(value);
}

/* ---------------------------------------------------------------- 涟漪 */

function attachRipple(node) {
  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const rect = node.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const wave = document.createElement('span');
    wave.className = 'ripple__wave';
    wave.style.width = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left = `${event.clientX - rect.left - size / 2}px`;
    wave.style.top = `${event.clientY - rect.top - size / 2}px`;
    node.appendChild(wave);
    window.setTimeout(() => wave.remove(), 560);
  });
}

function initRipples(root = document) {
  $$('.ripple', root).forEach((node) => {
    if (node.__rippleBound) return;
    node.__rippleBound = true;
    attachRipple(node);
  });
}

/* ------------------------------------------------------------ 顶部栏 / 导航 */

const PAGES = {
  overview: { title: '概览', subtitle: '大肥鱼 · QQ 桥接控制台' },
  memory: { title: '记忆', subtitle: 'Obsidian 风格 Markdown 记忆库' },
  stickers: { title: '表情包', subtitle: '自动收集、自动打标签，随时能找到想发的那张' },
  persona: { title: '人格', subtitle: '存多套人格，随时切换；每个群还能单独指定' },
  sessions: { title: '会话', subtitle: '群聊与私聊的 DSH 会话' },
  model: { title: '模型', subtitle: '跟随 DSH 桌面端，或在这里手动指定' },
  plugins: { title: '插件', subtitle: '开关与配置，扩展点不用改主流程' },
  system: { title: '系统', subtitle: '运行信息、日志与行为设置' },
};

function setPage(name, { push = true } = {}) {
  if (!PAGES[name]) return;
  STATE.page = name;

  $$('.page').forEach((el) => el.classList.toggle('is-active', el.dataset.page === name));
  $$('.nav-item').forEach((el) => {
    const active = el.dataset.page === name;
    el.classList.toggle('is-active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  $('#appTitle').textContent = PAGES[name].title;
  $('#appSubtitle').textContent = PAGES[name].subtitle;
  document.title = `${PAGES[name].title} · 大肥鱼控制台`;

  if (push && location.hash !== `#${name}`) {
    history.replaceState(null, '', `#${name}`);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  refreshPage(name).catch((err) => snackbar(err.message));
}

function currentPage() {
  return STATE.page;
}

async function refreshPage(name = currentPage()) {
  if (name === 'overview') return loadOverview();
  if (name === 'memory') return loadMemory();
  if (name === 'stickers') return loadStickers();
  if (name === 'persona') return loadPersonas();
  if (name === 'sessions') return loadSessions();
  if (name === 'model') return loadModel();
  if (name === 'plugins') return loadPlugins();
  if (name === 'system') return loadSystem();
}

/* ---------------------------------------------------------------- 概览 */

function statusTone(overview) {
  if (!overview) return { state: 'unknown', text: '连接中' };
  const { napcat, bridge, dsh } = overview;
  if (!napcat.running) return { state: 'bad', text: 'NapCat 未运行' };
  if (!dsh.running) return { state: 'warn', text: 'DSH 未运行' };
  if (!bridge.running) return { state: 'warn', text: '桥接未运行' };
  if (!bridge.connected) return { state: 'warn', text: '桥接未连接' };
  if (bridge.inFlight > 0) return { state: 'busy', text: '正在思考' };
  if (bridge.queueDepth > 0) return { state: 'busy', text: '排队中' };
  return { state: 'ok', text: '一切正常' };
}

function serviceCard({ key, name, running, badge, tone, meta, actions }) {
  const card = document.createElement('div');
  card.className = 'svc';
  card.dataset.service = key;
  card.innerHTML = `
    <div class="svc__top">
      <span class="status-dot" data-state="${tone}"></span>
      <span class="svc__name">${escapeHtml(name)}</span>
      <span class="svc__badge" data-tone="${tone}">${escapeHtml(badge)}</span>
    </div>
    <div class="svc__meta">${meta}</div>
    <div class="svc__actions"></div>
  `;
  const box = $('.svc__actions', card);
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ripple ${action.kind === 'primary' ? 'btn--tonal' : 'btn--text'}`;
    btn.textContent = action.label;
    btn.disabled = Boolean(action.disabled);
    btn.addEventListener('click', () => runServiceAction(key, action.action, name));
    box.appendChild(btn);
  }
  if (!running) card.querySelector('.status-dot')?.setAttribute('data-state', 'bad');
  return card;
}

function renderServiceCards(overview) {
  const host = $('#serviceCards');
  if (!host) return;
  host.textContent = '';

  const { napcat, bridge, dsh } = overview;

  host.appendChild(
    serviceCard({
      key: 'napcat',
      name: 'NapCat',
      running: napcat.running,
      badge: napcat.running ? (napcat.portOpen ? '已就绪' : '运行中') : '未运行',
      tone: napcat.running ? (napcat.portOpen ? 'ok' : 'warn') : 'bad',
      meta: `OneBot 端口 ${overview.ports.onebot}${napcat.qqRunning ? ' · QQ 在线' : ''}<br>WebUI ${escapeHtml(overview.ports.napcatWebui)}`,
      actions: [
        napcat.running
          ? { label: '停止', action: 'stop' }
          : { label: '启动', action: 'start', kind: 'primary' },
        { label: '重启', action: 'restart' },
      ],
    }),
  );

  host.appendChild(
    serviceCard({
      key: 'bridge',
      name: '桥接',
      running: bridge.running,
      badge: bridge.running ? (bridge.connected ? '已连接' : '未连接') : '未运行',
      tone: bridge.running ? (bridge.connected ? 'ok' : 'warn') : 'bad',
      meta: `PID ${bridge.pid || '—'} · 会话 ${bridge.sessions} · 队列 ${bridge.queueDepth}${bridge.inFlight ? ` · 处理中 ${bridge.inFlight}` : ''}`,
      actions: [
        bridge.running
          ? { label: '停止', action: 'stop' }
          : { label: '启动', action: 'start', kind: 'primary' },
        { label: '重启', action: 'restart' },
      ],
    }),
  );

  host.appendChild(
    serviceCard({
      key: 'dsh',
      name: 'DSH',
      running: dsh.running,
      badge: dsh.running ? '运行中' : '未运行',
      tone: dsh.running ? 'ok' : 'bad',
      meta: `${escapeHtml(dsh.processName)}<br>控制台启动于 ${humanUptime(overview.uptimeSeconds)}前`,
      actions: [
        dsh.running ? { label: '停止', action: 'stop' } : { label: '启动', action: 'start', kind: 'primary' },
        { label: '重启', action: 'restart' },
      ],
    }),
  );
}

async function runServiceAction(name, action, label) {
  const busyKey = `${name}:${action}`;
  if (STATE.busy.has(busyKey)) return;
  STATE.busy.add(busyKey);

  const card = $(`.svc[data-service="${name}"]`);
  card?.classList.add('is-busy');
  $$('.svc__actions .btn', card || document).forEach((b) => (b.disabled = true));

  const verb = { start: '启动', stop: '停止', restart: '重启' }[action] || action;
  snackbar(`${label} ${verb}中…`, { duration: 1200 });

  try {
    const result = await api(`/api/service/${name}/${action}`, { method: 'POST' });
    snackbar(result?.message || `${label} ${verb}完成`);
  } catch (err) {
    snackbar(`${label} ${verb}失败：${err.message}`, { duration: 5200 });
  } finally {
    STATE.busy.delete(busyKey);
    card?.classList.remove('is-busy');
    await loadOverview().catch(() => {});
  }
}

function setStatusChip(overview) {
  const tone = statusTone(overview);
  const dot = $('#statusDot');
  const text = $('#statusText');
  if (dot) dot.dataset.state = tone.state;
  if (text) text.textContent = tone.text;
}

async function loadOverview() {
  const data = await api('/api/overview');
  STATE.overview = data;
  setStatusChip(data);
  renderServiceCards(data);

  // 注意：overview 里的 memory 是 memoryResult('stats') 的原始信封 { ok, data } / { ok:false, error }
  const rawMem = data.memory;
  const mem = rawMem && rawMem.ok === true && rawMem.data ? rawMem.data : rawMem?.files !== undefined ? rawMem : null;
  const memFiles = mem ? Number(mem.files) || 0 : 0;
  const stat = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  stat('#statMemory', String(memFiles));
  stat('#statMessages', String(Number(data.today?.messages) || 0));
  stat('#statSessions', String(Number(data.bridge?.sessions) || 0));
  stat('#overviewTime', clockTime(data.now));

  // 概览页底部迷你日志
  try {
    const logs = await api('/api/logs?name=bridge&lines=12');
    const box = $('#overviewLog');
    if (box) {
      box.textContent = logs.missing || !logs.lines?.length ? '暂时没有日志' : logs.lines.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  } catch {
    /* 日志失败不影响概览 */
  }

  return data;
}

/* ---------------------------------------------------------------- 记忆 */

function renderMemoryStats(mem) {
  const hint = $('#memoryRootHint');
  if (hint) hint.textContent = mem?.root ? humanBytes(mem.totalBytes) : '—';

  const host = $('#memoryStats');
  if (!host) return;
  host.textContent = '';

  const cells = [['合计', Number(mem?.files) || 0]];
  const byDir = mem?.byDir && typeof mem.byDir === 'object' ? mem.byDir : {};
  for (const [label, count] of Object.entries(byDir)) cells.push([label, Number(count) || 0]);

  for (const [label, value] of cells) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = `<span class="stat__value">${value}</span><span class="stat__label">${escapeHtml(label)}</span>`;
    host.appendChild(el);
  }
}

function renderMemoryResults(payload) {
  const host = $('#memoryResults');
  if (!host) return;
  host.textContent = '';

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    host.innerHTML = '<p class="empty">没有找到相关记忆，换个关键词试试</p>';
    return;
  }

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'hit';
    card.dataset.path = item.path;

    const score = Number(item.score) || 0;
    card.innerHTML = `
      <div class="hit__head">
        <span class="hit__title">${escapeHtml(item.title || item.path)}</span>
        <span class="hit__score">${score > 0 ? score.toFixed(2) : '—'}</span>
      </div>
      <div class="hit__path">${escapeHtml(item.path)}</div>
      <div class="hit__snippet">${escapeHtml(item.snippet || '（无摘要）')}</div>
      <div class="row-end"><button class="btn btn--text ripple" type="button">展开全文</button></div>
    `;

    const btn = $('button', card);
    btn?.addEventListener('click', () => toggleNote(card, item.path, btn));
    host.appendChild(card);
  }
  initRipples(host);
}

async function toggleNote(card, relPath, btn) {
  const existing = $('.hit__body', card);
  if (existing) {
    existing.remove();
    btn.textContent = '展开全文';
    STATE.expanded.delete(relPath);
    return;
  }

  btn.disabled = true;
  btn.textContent = '载入中…';
  try {
    const note = await api(`/api/memory/note?path=${encodeURIComponent(relPath)}`);
    const body = document.createElement('div');
    body.className = 'hit__body';
    body.textContent = note.body || '（空笔记）';
    card.appendChild(body);
    btn.textContent = '收起';
    STATE.expanded.add(relPath);
  } catch (err) {
    btn.textContent = '展开全文';
    snackbar(`打开失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function searchMemory(query) {
  const q = String(query || '').trim();
  const host = $('#memoryResults');
  if (!q) {
    if (host) host.innerHTML = '<p class="empty">输入关键词，或点上面的标签开始检索</p>';
    return;
  }
  if (host) host.innerHTML = '<p class="empty">检索中…</p>';
  try {
    const payload = await api(`/api/memory/search?q=${encodeURIComponent(q)}&limit=8`);
    renderMemoryResults(payload);
    if (payload.count === 0) snackbar(`没有命中「${q}」`);
  } catch (err) {
    if (host) host.innerHTML = `<p class="empty">检索失败：${escapeHtml(err.message)}</p>`;
    snackbar(`检索失败：${err.message}`);
  }
}

async function loadMemory() {
  const [stats, reflect] = await Promise.all([
    api('/api/memory/stats').catch(() => null),
    api('/api/reflect').catch(() => null),
  ]);
  if (stats) renderMemoryStats(stats);
  if (reflect) renderReflect(reflect);
  const q = $('#memoryQuery')?.value?.trim() || '';
  if (q) await searchMemory(q);
}

/* ------------------------------------------------------- 记忆反思 */

let reflectPollTimer = null;

/** 「今天 04:00」「10月21日 04:00」这种给人看的时间 */
function formatWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function renderReflect(s) {
  if (!s) return;
  STATE.reflect = s;

  const settings = s.settings || {};
  const paper = s.reflection || {};

  const week = $('#reflectWeek');
  if (week) {
    week.textContent = paper.name
      ? `${paper.name.replace(/\.md$/, '')}${paper.exists ? ` · ${humanBytes(paper.bytes)}` : ' · 还没生成'}`
      : '—';
  }

  const daily = $('#reflectDaily');
  if (daily) daily.checked = settings.daily !== false;
  const time = $('#reflectTime');
  if (time && document.activeElement !== time) time.value = String(settings.time || '04:00');
  const backup = $('#reflectBackup');
  if (backup) backup.checked = settings.backup !== false;

  const hint = $('#reflectHint');
  if (hint) {
    const parts = [];
    if (s.running) {
      const who = s.runningTrigger === 'manual' ? '手动' : s.runningTrigger === 'daily' ? '定时' : '自动';
      parts.push(`正在反思（${who}，${s.startedAt ? relTime(s.startedAt) : '刚刚'}开始），要调一次模型，通常一两分钟`);
    } else if (s.lastRunAt) {
      parts.push(`上次 ${relTime(s.lastRunAt)}${s.lastOk === false ? '失败' : '完成'}`);
      if (s.lastBackup) parts.push('已备份旧稿');
    } else {
      parts.push('还没反思过');
    }
    if (s.nextAt) parts.push(`下次 ${formatWhen(s.nextAt)}`);
    else if (settings.daily === false) parts.push('每天定时已关闭');
    hint.textContent = parts.join(' · ');
  }

  const now = $('#reflectNow');
  if (now) {
    now.disabled = Boolean(s.running);
    now.textContent = s.running ? '反思中…' : '立即反思';
  }

  const log = $('#reflectLog');
  if (log) {
    const lines = Array.isArray(s.lines) ? s.lines : [];
    if (lines.length > 0) {
      log.textContent = lines.slice(-8).join('\n');
    } else if (s.running) {
      log.textContent = '正在准备素材…';
    } else if (s.lastMessage) {
      log.textContent = s.lastMessage;
    } else {
      log.textContent = '还没有跑过。点「立即反思」手动跑一次，或者打开每天定时。';
    }
  }

  // 打开页面时如果桥接那边正好在跑（每天定时那次），也跟着看进度
  if (s.running && !reflectPollTimer) startReflectPoll();
}

function stopReflectPoll() {
  if (reflectPollTimer) {
    window.clearInterval(reflectPollTimer);
    reflectPollTimer = null;
  }
}

/** 反思是一次真实的模型调用，跑的时候每隔几秒看一眼进度 */
function startReflectPoll() {
  stopReflectPoll();
  let ticks = 0;
  reflectPollTimer = window.setInterval(async () => {
    ticks += 1;
    let snapshot = null;
    try {
      snapshot = await api('/api/reflect');
    } catch {
      /* 控制台刚好在重启，下一拍再看 */
    }
    if (snapshot) {
      renderReflect(snapshot);
      if (!snapshot.running) {
        stopReflectPoll();
        if (snapshot.lastOk === false) {
          snackbar(`反思失败：${snapshot.lastMessage || '看下面的日志'}`, { duration: 6000 });
        } else {
          snackbar('这一周的反思写好了');
          loadMemory().catch(() => {});
        }
        return;
      }
    }
    // 10 分钟还没完就别再轮询了（模型偶尔很慢，但不能无限问）
    if (ticks > 240) stopReflectPoll();
  }, 2500);
}

async function loadReflect() {
  try {
    renderReflect(await api('/api/reflect'));
  } catch (err) {
    snackbar(`读取反思状态失败：${err.message}`);
  }
}

async function runReflectNow() {
  const snapshot = STATE.reflect;
  if (snapshot?.reflection?.exists && snapshot?.settings?.backup === false) {
    const sure = await confirmDialog(
      '会覆盖本周的反思',
      '你关掉了「重写前备份」，这一篇会被直接覆盖，找不回来。仍然继续？',
      { okText: '仍然重写' },
    );
    if (!sure) return;
  }

  const btn = $('#reflectNow');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '启动中…';
  }
  try {
    await api('/api/reflect', { method: 'POST', body: JSON.stringify({ force: true }) });
    snackbar('开始反思这一周，跑完这里会自己刷新', { duration: 4200 });
    startReflectPoll();
  } catch (err) {
    snackbar(err.message, { duration: 5600 });
    await loadReflect();
  }
}

async function saveReflectSettings() {
  const btn = $('#reflectSave');
  const raw = String($('#reflectTime')?.value ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(raw)) {
    snackbar('时间要填 HH:MM，例如 04:00', { duration: 4200 });
    return;
  }
  const [hour, minute] = raw.split(':');
  const timeText = `${hour.padStart(2, '0')}:${minute}`;

  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        memory: {
          reflectDaily: Boolean($('#reflectDaily')?.checked),
          reflectTime: timeText,
          reflectBackup: Boolean($('#reflectBackup')?.checked),
        },
      }),
    });
    const count = Object.keys(data?.applied || {}).length;
    snackbar(count > 0 ? '反思设置已保存（桥接每分钟读一次，不用重启）' : '没有改动');
    await loadReflect();
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存设置';
    }
  }
}

async function openReflection() {
  try {
    const data = await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'reflection' }) });
    snackbar(data.selected ? `已请求定位：${data.path}` : `已请求打开：${data.path}`, { duration: 3600 });
  } catch (err) {
    snackbar(err.message, { duration: 5200 });
  }
}

/* -------------------------------------------------------------- 表情包 */

const STICKER_PAGE_SIZE = 60;

function renderStickerStats(s) {
  const host = $('#stickerStats');
  if (host) {
    const rows = [
      ['合计', `${s.count ?? 0}`],
      ['动图', `${s.animated ?? 0}`],
      ['占用', humanBytes(s.bytes)],
      ['标签', `${(s.tags || []).length}`],
    ];
    host.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="stat"><span class="stat__value">${escapeHtml(value)}</span><span class="stat__label">${label}</span></div>`,
      )
      .join('');
  }

  const rootHint = $('#stickerRootHint');
  if (rootHint) rootHint.textContent = s.root || '—';
  const count = $('#stickerCount');
  if (count) count.textContent = s.count ? `${s.count} 张` : '空库';
  const storeHint = $('#stickerStoreHint');
  if (storeHint) {
    storeHint.textContent = s.rootExists ? '目录就绪' : '目录还没建，收第一张时自动建';
  }

  const gridHint = $('#stickerGridHint');
  if (gridHint) {
    const shown = (s.items || []).length;
    const parts = [`显示 ${shown} / ${s.total ?? shown} 张`];
    if ((s.total ?? 0) > shown) parts.push('用搜索或标签缩小范围');
    if (s.lastAt) parts.push(`最近收图 ${relTime(s.lastAt)}`);
    gridHint.textContent = parts.join(' · ');
  }

  const tagsHost = $('#stickerTags');
  if (tagsHost) {
    const top = (s.tags || []).slice(0, 14);
    const chips = [`<button class="chip ripple${STATE.stickerTag ? '' : ' is-active'}" type="button" data-tag="">全部</button>`];
    for (const entry of top) {
      const active = STATE.stickerTag === entry.tag ? ' is-active' : '';
      chips.push(
        `<button class="chip ripple${active}" type="button" data-tag="${escapeHtml(entry.tag)}">${escapeHtml(entry.tag)}<span class="chip__count">${entry.count}</span></button>`,
      );
    }
    tagsHost.innerHTML = chips.join('');
    initRipples(tagsHost);
  }
}

function fillStickerSettings(s) {
  const settings = s.settings || {};
  const root = $('#stickerRoot');
  if (root && document.activeElement !== root) root.value = settings.root || '';
  const autoCollect = $('#stickerAutoCollect');
  if (autoCollect) autoCollect.checked = settings.autoCollect !== false;
  const autoTag = $('#stickerAutoTag');
  if (autoTag) autoTag.checked = settings.autoTag !== false;
  const probability = $('#stickerSendProbability');
  if (probability && document.activeElement !== probability) {
    probability.value = String(settings.sendProbability ?? 1);
  }
  updateStickerSendProbability();
  const perMinute = $('#stickerPerMinute');
  if (perMinute && document.activeElement !== perMinute) perMinute.value = String(settings.perMinute ?? 20);
  const maxPerMessage = $('#stickerMaxPerMessage');
  if (maxPerMessage && document.activeElement !== maxPerMessage) {
    maxPerMessage.value = String(settings.maxPerMessage ?? 3);
  }
}

function updateStickerSendProbability() {
  const probability = $('#stickerSendProbability')?.valueAsNumber;
  const output = $('#stickerSendProbabilityValue');
  if (output && Number.isFinite(probability)) output.textContent = probability.toFixed(2);
}

function stickerTile(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sticker-tile ripple';
  btn.dataset.id = item.id;
  btn.title = (item.tags || []).join(' · ') || item.file || '';
  const img = document.createElement('img');
  img.src = item.url;
  img.alt = (item.tags || []).slice(0, 2).join(' ') || '表情包';
  img.loading = 'lazy';
  btn.appendChild(img);
  btn.addEventListener('click', () => openStickerDetail(item.id));
  return btn;
}

function renderStickers(s) {
  STATE.stickers = s;
  STATE.stickerItems = new Map((s.items || []).map((item) => [item.id, item]));
  renderStickerStats(s);
  fillStickerSettings(s);

  const host = $('#stickerGrid');
  const empty = $('#stickerEmpty');
  if (host) {
    host.innerHTML = '';
    for (const item of s.items || []) host.appendChild(stickerTile(item));
  }
  if (empty) empty.hidden = (s.items || []).length > 0;
}

async function loadStickers() {
  const params = new URLSearchParams({ limit: String(STICKER_PAGE_SIZE) });
  const q = String($('#stickerQuery')?.value ?? '').trim();
  if (q) params.set('q', q);
  if (STATE.stickerTag) params.set('tag', STATE.stickerTag);
  try {
    renderStickers(await api(`/api/stickers?${params.toString()}`));
  } catch (err) {
    snackbar(`读表情包库失败：${err.message}`);
  }
}

/* ---- 详情弹层 ---- */

function currentSticker() {
  return STATE.stickerItems.get(STATE.stickerOpenId) || null;
}

function renderStickerDetail() {
  const item = currentSticker();
  if (!item) return closeStickerDetail();

  const img = $('#stickerDetailImg');
  if (img) img.src = item.url;
  const size = $('#stickerDetailSize');
  if (size) {
    const dims = item.width && item.height ? `${item.width}×${item.height} · ` : '';
    size.textContent = `${dims}${item.animated ? '动图' : '静态'} · ${humanBytes(item.bytes)}`;
  }

  const tagsHost = $('#stickerDetailTags');
  if (tagsHost) {
    const tags = item.tags || [];
    tagsHost.innerHTML = tags.length
      ? tags
          .map(
            (tag) =>
              `<button class="chip chip--remove ripple" type="button" data-tag="${escapeHtml(tag)}" title="点一下删掉这个标签">${escapeHtml(tag)}<span class="chip__x">×</span></button>`,
          )
          .join('')
      : '<span class="card__hint">还没有标签</span>';
    initRipples(tagsHost);
  }

  const hint = $('#stickerDetailHint');
  if (hint) {
    const who = item.source?.nickname ? ` · ${item.source.nickname} 发的` : '';
    const where = item.source?.groupId ? `（群 ${item.source.groupId}）` : '';
    const parts = [`${relTime(item.firstAt)}收进来${who}${where}`];
    if (item.seen > 1) parts.push(`见过 ${item.seen} 次`);
    if (item.text) parts.push(`当时在聊：${String(item.text).slice(0, 40)}`);
    hint.textContent = parts.join(' · ');
  }

  const input = $('#stickerTagInput');
  if (input) input.value = '';
}

function openStickerDetail(id) {
  STATE.stickerOpenId = id;
  const scrim = $('#stickerScrim');
  if (scrim) scrim.hidden = false;
  renderStickerDetail();
}

function closeStickerDetail() {
  const scrim = $('#stickerScrim');
  if (scrim) scrim.hidden = true;
  STATE.stickerOpenId = null;
}

async function addStickerTags() {
  const item = currentSticker();
  if (!item) return;
  const raw = String($('#stickerTagInput')?.value ?? '').trim();
  if (!raw) return snackbar('先写几个标签，用逗号分开');
  const add = raw.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
  if (add.length === 0) return snackbar('先写几个标签，用逗号分开');
  try {
    const data = await api('/api/stickers/tag', {
      method: 'POST',
      body: JSON.stringify({ id: item.id, add }),
    });
    STATE.stickerItems.set(item.id, { ...item, ...data.item });
    renderStickerDetail();
    snackbar(`加了 ${add.length} 个标签`);
    await loadStickers();
  } catch (err) {
    snackbar(`加标签失败：${err.message}`, { duration: 5200 });
  }
}

async function removeStickerTag(tag) {
  const item = currentSticker();
  if (!item || !tag) return;
  try {
    const data = await api('/api/stickers/tag', {
      method: 'POST',
      body: JSON.stringify({ id: item.id, remove: [tag] }),
    });
    STATE.stickerItems.set(item.id, { ...item, ...data.item });
    renderStickerDetail();
    await loadStickers();
  } catch (err) {
    snackbar(`删标签失败：${err.message}`, { duration: 5200 });
  }
}

async function deleteSticker() {
  const item = currentSticker();
  if (!item) return;
  const sure = await confirmDialog('删掉这张表情', '图片文件和索引里这一条都会删掉，找不回来。', { okText: '删除' });
  if (!sure) return;
  const btn = $('#stickerDelete');
  if (btn) btn.disabled = true;
  try {
    await api('/api/stickers/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) });
    closeStickerDetail();
    snackbar('已从库里删掉');
    await loadStickers();
  } catch (err) {
    snackbar(`删除失败：${err.message}`, { duration: 5200 });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---- 页面按钮 ---- */

async function rebuildStickers() {
  const btn = $('#stickerRebuild');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '重扫中…';
  }
  try {
    const data = await api('/api/stickers/rebuild', { method: 'POST' });
    snackbar(`重扫完成：${data.scanned} 个文件，保留 ${data.kept} 张、新收 ${data.added} 张`, { duration: 5200 });
    await loadStickers();
  } catch (err) {
    snackbar(`重建索引失败：${err.message}`, { duration: 5200 });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重建索引';
    }
  }
}

async function migrateStickers() {
  const to = String($('#stickerRoot')?.value ?? '').trim();
  if (!to) return snackbar('先在上面填好新目录');
  const current = STATE.stickers?.root || '';
  if (current && to.replace(/[\\/]+$/, '').toLowerCase() === current.replace(/[\\/]+$/, '').toLowerCase()) {
    return snackbar('新目录和现在的一样，不用搬');
  }
  const count = STATE.stickers?.count ?? 0;
  const sure = await confirmDialog(
    '把表情包搬到新目录',
    `会把 ${count} 张复制到 ${to}，逐张校验；旧目录（${current}）留着不删，确认没问题你再自己删。搬完自动改配置，不用重启。`,
    { okText: '开始搬家' },
  );
  if (!sure) return;

  const btn = $('#stickerMigrate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '搬迁中…';
  }
  try {
    const data = await api('/api/stickers/migrate', { method: 'POST', body: JSON.stringify({ to }) });
    snackbar(`搬好了：${data.copied} 张 / ${humanBytes(data.bytes)} → ${data.to}`, { duration: 6000 });
    await loadStickers();
  } catch (err) {
    snackbar(`搬家失败：${err.message}`, { duration: 6000 });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '迁移到新目录';
    }
  }
}

async function saveStickerSettings() {
  const perMinute = Number($('#stickerPerMinute')?.value);
  const maxPerMessage = Number($('#stickerMaxPerMessage')?.value);
  const sendProbability = $('#stickerSendProbability')?.valueAsNumber;
  if (!Number.isFinite(sendProbability) || sendProbability < 0 || sendProbability > 1) {
    return snackbar('表情发送概率要在 0–1 之间');
  }
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 200) {
    return snackbar('每分钟上限要填 1–200 的整数');
  }
  if (!Number.isInteger(maxPerMessage) || maxPerMessage < 1 || maxPerMessage > 9) {
    return snackbar('每条最多收几张要填 1–9 的整数');
  }
  const btn = $('#stickerSave');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        stickers: {
          root: String($('#stickerRoot')?.value ?? '').trim(),
          autoCollect: Boolean($('#stickerAutoCollect')?.checked),
          autoTag: Boolean($('#stickerAutoTag')?.checked),
          sendProbability,
          perMinute,
          maxPerMessage,
        },
      }),
    });
    snackbar('表情包设置已保存（桥接 15 秒内自动跟上，不用重启）', { duration: 4600 });
    await loadStickers();
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存设置';
    }
  }
}

async function openStickersDir() {
  try {
    const data = await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'stickers' }) });
    snackbar(`已请求打开：${data.path}`, { duration: 3600 });
  } catch (err) {
    snackbar(err.message, { duration: 5200 });
  }
}

/* ---------------------------------------------------------------- 人格 */

let personaDirty = false;
let personaEditing = '';

/** 人格名的首字（列表左侧的小方块用） */
function personaInitial(name) {
  const value = String(name ?? '').trim();
  return value ? value.slice(0, 1) : '?';
}

function renderPersonaList(items) {
  const host = $('#personaList');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<p class="empty">人格库还是空的。点「新建人格」建一套，或者「把当前人格导入库」先把手头这份收进来。</p>';
    return;
  }
  host.textContent = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'persona-row';
    row.innerHTML = `
      <div class="persona-row__icon">${escapeHtml(personaInitial(item.name))}</div>
      <div class="persona-row__main">
        <div class="persona-row__title">
          ${escapeHtml(item.name)}
          ${item.active ? '<span class="tag">当前</span>' : ''}
        </div>
        <div class="persona-row__sub">${escapeHtml(item.preview || '（空人格）')}${item.size ? ` · ${humanBytes(item.size)}` : ''}</div>
      </div>
      <div class="persona-row__actions">
        <button class="btn btn--text ripple" type="button" data-act="use">${item.active ? '已在使用' : '用这套'}</button>
        <button class="btn btn--text ripple" type="button" data-act="edit">编辑</button>
        <button class="session__del ripple" type="button" data-act="del" aria-label="删除这套人格">
          <svg class="icon icon--xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;
    row.querySelector('[data-act="use"]')?.addEventListener('click', () => activatePersona(item.name));
    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => loadPersona({ name: item.name }));
    row.querySelector('[data-act="del"]')?.addEventListener('click', () => removePersona(item.name));
    host.appendChild(row);
  }
  initRipples(host);
}

async function loadPersonas({ select = '' } = {}) {
  try {
    const data = await api('/api/personas');
    STATE.personas = data;
    const chip = $('#personaActiveChip');
    if (chip) chip.textContent = data.active ? `当前：${data.active}` : '默认文件模式';
    const dirHint = $('#personaDirHint');
    if (dirHint) dirHint.textContent = data.dir;
    const seedBtn = $('#personaSeed');
    if (seedBtn) seedBtn.hidden = (data.items || []).length > 0;
    renderPersonaList(data.items || []);

    const chats = Object.keys(data.chats || {});
    const libHint = $('#personaLibHint');
    if (libHint) {
      const base = '切哪套就立刻生效，不用重启桥接。群里发 /人格 名字 只改那个群。';
      libHint.textContent = chats.length ? `${base} 另有 ${chats.length} 个会话单独指定了人格。` : base;
    }

    const target = select || personaEditing || data.active || (data.items[0]?.name ?? '');
    if (target) await loadPersona({ name: target, force: true, quiet: true });
    else await loadPersona({ name: '', force: true, quiet: true });
  } catch (err) {
    const host = $('#personaList');
    if (host) host.innerHTML = `<p class="empty">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

async function loadPersona({ name = personaEditing, force = false, quiet = false } = {}) {
  const body = $('#personaBody');
  if (!body) return;
  if (personaDirty && !force) {
    const ok = await confirmDialog('放弃未保存的修改？', '你修改过人格，切换或重新载入会丢掉这些改动。', {
      okText: '放弃修改',
    });
    if (!ok) return;
  }

  try {
    const query = name ? `?name=${encodeURIComponent(name)}` : '';
    const data = await api(`/api/persona${query}`);
    personaEditing = data.mode === 'library' ? data.name || name : '';
    body.value = data.body || '';
    personaDirty = false;

    const title = $('#personaEditorTitle');
    if (title) title.textContent = personaEditing ? `人格：${personaEditing}` : '人格内容（默认文件）';
    const editorPath = $('#personaEditorPath');
    if (editorPath) editorPath.textContent = data.path || '';
    const meta = $('#personaMeta');
    if (meta) meta.textContent = data.missing ? '尚未创建' : humanBytes(data.size);
    const hint = $('#personaHint');
    if (hint) {
      const backup = personaEditing ? `state/persona-backup/${personaEditing}-时间戳.md` : 'state/persona-backup/';
      hint.textContent = data.updatedAt
        ? `上次保存：${relTime(data.updatedAt)} · 旧版本自动备份到 ${backup}`
        : `旧版本自动备份到 ${backup}`;
    }
    if (!data.missing && data.size === 0 && data.mode === 'library') {
      body.placeholder = '这套人格还是空的，直接写内容再点保存就行';
    } else {
      body.placeholder = '正在加载人格文件…';
    }
  } catch (err) {
    if (!quiet) snackbar(`载入人格失败：${err.message}`);
  }
}

async function savePersona() {
  const body = $('#personaBody');
  const btn = $('#personaSave');
  if (!body || !btn) return;
  if (!body.value.trim()) {
    const ok = await confirmDialog('人格是空的', '空人格等于没有设定，仍然保存吗？', { okText: '仍然保存' });
    if (!ok) return;
  }

  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const payload = { body: body.value };
    if (personaEditing) payload.name = personaEditing;
    const data = await api('/api/persona', { method: 'PUT', body: JSON.stringify(payload) });
    personaDirty = false;
    const meta = $('#personaMeta');
    if (meta) meta.textContent = humanBytes(data.bytes);
    snackbar(data.backup ? `已保存，旧版本备份在 ${data.backup}` : '已保存人格', { duration: 4600 });
    await loadPersonas({ select: personaEditing });
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function activatePersona(name) {
  try {
    await api('/api/personas/active', { method: 'PUT', body: JSON.stringify({ name }) });
    snackbar(`以后默认用「${name}」了`);
    await loadPersonas({ select: name });
  } catch (err) {
    snackbar(`切换失败：${err.message}`, { duration: 5200 });
  }
}

async function newPersona() {
  const name = await promptDialog('新建人格', {
    body: '起个名字，会建一套空白人格（说话风格 + 人设两段），建完直接编辑。',
    placeholder: '例如：客服小助手',
    okText: '新建',
    hint: '名字最多 40 个字，不能带 \\ / : * ? " < > |',
  });
  if (!name) return;
  try {
    const data = await api('/api/personas', { method: 'POST', body: JSON.stringify({ name }) });
    await api('/api/personas/active', { method: 'PUT', body: JSON.stringify({ name: data.name }) });
    snackbar(`建好了「${data.name}」，已经切过去`);
    await loadPersonas({ select: data.name });
  } catch (err) {
    snackbar(`新建失败：${err.message}`, { duration: 5200 });
  }
}

async function removePersona(name) {
  const ok = await confirmDialog('删除这套人格？', `「${name}」会被直接删掉（文件也会删）。用它的会话会自动回到默认人格。`, {
    okText: '删除',
  });
  if (!ok) return;
  try {
    await api(`/api/personas?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (personaEditing === name) personaEditing = '';
    snackbar(`已删除「${name}」`);
    await loadPersonas();
  } catch (err) {
    snackbar(`删除失败：${err.message}`, { duration: 5200 });
  }
}

async function seedPersonas() {
  try {
    const data = await api('/api/personas/seed', { method: 'POST', body: JSON.stringify({}) });
    snackbar(`已经把当前人格导入库：${data.name}`);
    await loadPersonas({ select: data.name });
  } catch (err) {
    snackbar(`导入失败：${err.message}`, { duration: 5200 });
  }
}

/* ---------------------------------------------------------------- 会话 */

async function loadSessions() {
  const host = $('#sessionList');
  if (!host) return;
  host.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const data = await api('/api/sessions');
    host.textContent = '';
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      host.innerHTML = '<p class="empty">还没有会话，等它在 QQ 里回一次话就会自动创建</p>';
      return;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'session';
      const isGroup = item.kind === 'group';
      const initial = isGroup ? '群' : '私';
      const sources = Array.isArray(item.sources) ? item.sources.join(' · ') : '';
      row.innerHTML = `
        <div class="session__icon">${initial}</div>
        <div class="session__main">
          <div class="session__title">
            ${escapeHtml(item.qq)}
            <span class="tag">${isGroup ? '群聊' : '私聊'}</span>
          </div>
          <div class="session__sub">${escapeHtml(item.sessionId || '（尚未建立）')}${sources ? ` · ${escapeHtml(sources)}` : ''}</div>
        </div>
        <button class="session__del ripple" type="button" aria-label="清除该会话">
          <svg class="icon icon--xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      `;
      $('.session__del', row)?.addEventListener('click', () => removeSession(item.qq));
      host.appendChild(row);
    }
    initRipples(host);
  } catch (err) {
    host.innerHTML = `<p class="empty">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

async function removeSession(key) {
  const ok = await confirmDialog(
    '清除会话映射？',
    `清掉 ${key} 之后，它下一次说话会开启一个全新会话，之前的上下文就接不上了。`,
    { okText: '清除' },
  );
  if (!ok) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' });
    snackbar(`已清除 ${key} 的会话`);
    await loadSessions();
    await loadOverview().catch(() => {});
  } catch (err) {
    snackbar(`清除失败：${err.message}`, { duration: 5200 });
  }
}

/* ---------------------------------------------------------------- 模型 */

function fillSelect(node, values, selected) {
  if (!node) return;
  node.textContent = '';
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    if (value === selected) opt.selected = true;
    node.appendChild(opt);
  }
  if (values.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（没有可选项）';
    node.appendChild(opt);
  }
}

function renderModel(data) {
  if (!data || data.error) {
    const tip = data?.error || '读取失败';
    $('#modelCurrent').textContent = tip;
    $('#modelDesktop').textContent = '—';
    $('#modelSourceHint').textContent = '检查桥接是否在运行，或稍后重试';
    return;
  }

  const mode = data.mode === 'manual' ? 'manual' : 'follow';
  const effective = data.effective;
  const desktop = data.desktop;

  $('#modelCurrent').textContent = effective ? `${effective.provider}/${effective.model}` : '未确定（将使用基础 patch）';
  $('#modelModeChip').textContent = mode === 'manual' ? '手动' : '跟随 DSH';
  $('#modelDesktop').textContent = desktop
    ? `桌面端当前：${desktop.provider}/${desktop.model}`
    : '桌面端没有可读的当前模型';

  if (data.reason) {
    $('#modelSourceHint').textContent = `注意：${data.reason}`;
  } else {
    const source = mode === 'manual' ? '控制台手动指定' : '跟随 DSH 桌面端';
    const when = data.generatedAt ? ` · 配置生成于${relTime(data.generatedAt)}` : '';
    $('#modelSourceHint').textContent = `来源：${source} · 思考强度 ${effective?.reasoningEffort ?? '—'}${when}`;
  }

  // 模式开关
  $$('#modelModeSwitch .segmented__item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });

  // 手动区
  const card = $('#modelManualCard');
  const manual = data.manual || desktop || { provider: '', model: '' };
  const providers = Array.isArray(data.providers) ? data.providers : [];
  fillSelect(
    $('#modelProvider'),
    providers.map((p) => p.id),
    manual.provider,
  );
  const currentProvider = providers.find((p) => p.id === manual.provider) || providers[0];
  fillSelect($('#modelModel'), currentProvider ? currentProvider.models : [], manual.model);
  fillSelect($('#modelEffort'), Array.isArray(data.efforts) ? data.efforts : ['off', 'high', 'max'], manual.reasoningEffort || 'max');

  const editable = mode === 'manual';
  for (const node of $$('#modelManualCard .select-field')) node.disabled = !editable;
  const save = $('#modelSave');
  if (save) {
    save.disabled = !editable;
    save.textContent = '保存';
  }
  if (card) card.classList.toggle('is-muted', !editable);
  $('#modelHint').textContent = editable
    ? '改完下一条 QQ 消息就会用新模型，不需要重启桥接。'
    : '当前是「跟随 DSH」模式：去桌面端换模型即可；想在这里固定，请先切到手动指定。';
  $('#modelUpdated').textContent = data.updatedAt ? `更新于${relTime(data.updatedAt)}` : '还未手动设置过';
}

async function loadModel() {
  try {
    const data = await api('/api/model');
    STATE.model = data;
    renderModel(data);
  } catch (err) {
    renderModel({ error: `读取失败：${err.message}` });
  }
}

async function setModelMode(mode) {
  try {
    const data = await api('/api/model', { method: 'PUT', body: JSON.stringify({ mode }) });
    STATE.model = data;
    renderModel(data);
    snackbar(mode === 'manual' ? '已切到手动指定' : '已切回跟随 DSH 桌面端');
  } catch (err) {
    snackbar(`切换失败：${err.message}`, { duration: 5200 });
  }
}

async function saveModel() {
  const btn = $('#modelSave');
  if (!btn) return;
  const provider = $('#modelProvider')?.value;
  const model = $('#modelModel')?.value;
  const reasoningEffort = $('#modelEffort')?.value || 'max';
  if (!provider || !model) {
    snackbar('请先选供应商和模型');
    return;
  }

  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const data = await api('/api/model', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'manual', manual: { provider, model, reasoningEffort } }),
    });
    STATE.model = data;
    renderModel(data);
    snackbar('已保存，下一条 QQ 消息生效');
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

/* ---------------------------------------------------------------- 插件 */

function pluginFieldHtml(plugin, field) {
  const value = plugin.config?.[field.key];
  const key = escapeHtml(field.key);
  const label = escapeHtml(field.label || field.key);

  if (field.type === 'bool') {
    return `<label class="switch-row">
        <span class="switch-row__text">${label}</span>
        <input class="switch" type="checkbox" data-plugin-field="${key}" ${value ? 'checked' : ''} />
      </label>`;
  }
  if (field.type === 'select') {
    const options = (field.options || [])
      .map((opt) => {
        const v = typeof opt === 'string' ? opt : opt?.value;
        const l = typeof opt === 'string' ? opt : (opt?.label ?? opt?.value);
        const sel = String(v) === String(value) ? ' selected' : '';
        return `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(l)}</option>`;
      })
      .join('');
    return `<label class="field-label">${label}</label><select class="select-field" data-plugin-field="${key}">${options}</select>`;
  }
  if (field.type === 'text') {
    return `<label class="field-label">${label}</label><textarea class="text-field text-field--area" data-plugin-field="${key}">${escapeHtml(value ?? '')}</textarea>`;
  }
  if (field.type === 'int') {
    return `<label class="switch-row">
        <span class="switch-row__text">${label}</span>
        <input class="text-field text-field--num" type="number" data-plugin-field="${key}" value="${escapeHtml(value ?? 0)}" />
      </label>`;
  }
  return `<label class="field-label">${label}</label><input class="text-field" type="text" data-plugin-field="${key}" value="${escapeHtml(value ?? '')}" />`;
}

function renderPlugins(data) {
  const list = $('#pluginsList');
  if (!list) return;

  const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  STATE.plugins = data;
  $('#pluginsSummary').textContent = plugins.length
    ? `${plugins.length} 个插件 · ${plugins.filter((p) => p.enabled).length} 个已启用`
    : '还没有插件';

  const failures = Array.isArray(data?.failures) ? data.failures : [];
  const failBox = $('#pluginsFailures');
  if (failBox) {
    failBox.hidden = failures.length === 0;
    if (failures.length) {
      failBox.textContent = `加载失败：${failures.map((f) => `${f.file}（${f.message}）`).join('；')}`;
    }
  }

  if (!plugins.length) {
    list.innerHTML = `<section class="card card--pad"><p class="card__hint">把 .js 文件放进 <code>src/plugins/</code>，这里就会出现它的卡片。</p></section>`;
    return;
  }

  list.innerHTML = plugins
    .map((plugin) => {
      const fields = (plugin.configSchema || []).map((field) => pluginFieldHtml(plugin, field)).join('');
      return `<section class="card card--pad plugin-card" data-plugin="${escapeHtml(plugin.name)}">
        <div class="row-between">
          <div class="card__head card__head--flush">
            <h2 class="card__title">${escapeHtml(plugin.displayName)} <span class="chip chip--tiny">v${escapeHtml(plugin.version)}</span></h2>
            <p class="card__sub">${escapeHtml(plugin.description || '（没有写说明）')}</p>
          </div>
          <label class="switch-row switch-row--tight">
            <span class="switch-row__text">启用</span>
            <input class="switch" type="checkbox" data-role="enabled" ${plugin.enabled ? 'checked' : ''} />
          </label>
        </div>
        <p class="card__hint">钩子：${plugin.hooks.map((h) => `<code>${escapeHtml(h)}</code>`).join(' · ')}</p>
        ${fields ? `<div class="plugin-card__fields">${fields}</div>
        <div class="row-end"><button class="btn btn--text ripple" type="button" data-role="save-config">保存配置</button></div>` : ''}
      </section>`;
    })
    .join('');

  $$('#pluginsList .plugin-card').forEach((card) => {
    const name = card.dataset.plugin;
    card.querySelector('[data-role="enabled"]')?.addEventListener('change', (event) => {
      setPluginEnabled(name, event.target.checked);
    });
    card.querySelector('[data-role="save-config"]')?.addEventListener('click', () => {
      savePluginConfig(card, name);
    });
  });
}

async function loadPlugins() {
  try {
    const data = await api('/api/plugins');
    renderPlugins(data);
  } catch (err) {
    const list = $('#pluginsList');
    if (list) list.innerHTML = `<section class="card card--pad"><p class="card__hint">读取失败：${escapeHtml(err.message)}</p></section>`;
  }
}

async function setPluginEnabled(name, enabled) {
  try {
    const data = await api(`/api/plugins/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    renderPlugins(data.snapshot);
    snackbar(`${enabled ? '已启用' : '已停用'} ${name}，重启桥接后生效`);
  } catch (err) {
    snackbar(`切换失败：${err.message}`, { duration: 5200 });
    await loadPlugins();
  }
}

async function savePluginConfig(card, name) {
  const plugin = (STATE.plugins?.plugins || []).find((p) => p.name === name);
  if (!plugin) return;
  const config = {};
  for (const field of plugin.configSchema || []) {
    const node = card.querySelector(`[data-plugin-field="${field.key}"]`);
    if (!node) continue;
    if (field.type === 'bool') config[field.key] = node.checked;
    else if (field.type === 'int') config[field.key] = Number(node.value);
    else config[field.key] = node.value;
  }
  try {
    const data = await api(`/api/plugins/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
    renderPlugins(data.snapshot);
    snackbar('配置已保存，重启桥接后生效');
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  }
}

/* -------------------------------------------------------------- 应用更新 */

const UPDATE_UI = {
  status: null,
  unavailable: false,
  pending: '',
  reading: null,
  timer: 0,
  waitingVersion: '',
  previousVersion: '',
  disconnected: false,
  notified: new Set(),
};

try {
  const versions = JSON.parse(localStorage.getItem('qq-update-notified') || '[]');
  if (Array.isArray(versions)) versions.slice(-20).forEach((version) => UPDATE_UI.notified.add(version));
} catch { /* Some browsers disable local storage. */ }

function updateInProgress() {
  return Boolean(UPDATE_UI.waitingVersion)
    || ['downloading', 'installing'].includes(UPDATE_UI.status?.phase);
}

function updateReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'github.com'
      && !url.username && !url.password
      && /^\/miku05231\/DSH-Fatwhale-QQ\/releases(?:\/|$)/.test(url.pathname)) return url.href;
  } catch { /* Untrusted release metadata must never become an executable link. */ }
  return '';
}

function renderUpdates() {
  const status = UPDATE_UI.status;
  const unavailable = UPDATE_UI.unavailable;
  const installing = updateInProgress();
  const busy = Boolean(UPDATE_UI.pending) || installing || status?.phase === 'checking';
  const versions = $('#updatesVersions');
  if (!versions) return;

  versions.textContent = status
    ? `当前 ${status.currentVersion || '未知'}${status.latestVersion ? ` · 最新 ${status.latestVersion}` : ''}`
    : '版本信息暂不可用';
  let message;
  if (installing && unavailable) message = '控制台正在重启，正在等待重新连接…';
  else if (unavailable) message = '暂时无法读取更新状态，请稍后重试。旧版本控制台可能尚未提供更新功能。';
  else if (UPDATE_UI.pending === 'checking' || status?.phase === 'checking') message = '正在检查新版本…';
  else if (status?.phase === 'downloading') message = `正在下载更新${Number.isFinite(status.progress) ? ` · ${Math.round(status.progress)}%` : ''}…`;
  else if (status?.phase === 'installing' || (installing && status?.phase === 'complete')) message = '正在安装并重启，请稍候…';
  else if (status?.phase === 'available') message = `发现新版本 ${status.latestVersion || ''}`;
  else if (status?.phase === 'current') message = status.latestVersion ? '已是最新版本' : 'GitHub 上暂时没有正式发布版本';
  else if (status?.phase === 'error') message = `更新失败：${status.error || '请稍后重试'}`;
  else if (status?.phase === 'complete') message = '更新已完成';
  else message = '尚未检查更新';
  $('#updatesStatus').textContent = message;
  $('#updatesStatus').dataset.error = String(!installing && (unavailable || status?.phase === 'error'));

  const progress = $('#updatesProgress');
  progress.hidden = !installing;
  if (!unavailable && status?.phase === 'downloading' && Number.isFinite(status.progress)) {
    progress.value = Math.min(100, Math.max(0, status.progress));
  } else progress.removeAttribute('value');

  const hint = $('#updatesHint');
  if (installing) hint.textContent = '配置、人格和记忆会保留。桥接与托盘重启期间暂时离线，DSH 保持运行。';
  else if (!status || unavailable) hint.textContent = '可先下载 GitHub Release，按原运行方式手动更新。';
  else {
    const checked = status.checkedAt ? `上次检查：${relTime(status.checkedAt)}` : '开启后会在后台定期检查，有新版时提醒。';
    const manual = status.canInstall === false && /手动|源码|git pull|Docker|容器|便携包/.test(status.installReason || '');
    hint.textContent = manual
      ? `${status.installReason || '当前运行方式需手动更新。'} 源码版拉取代码；Docker 版更新镜像后重建容器，沿用原配置和数据卷。${status.checkedAt ? ` ${checked}` : ''}`
      : checked;
  }

  const automatic = $('#updatesAutomatic');
  automatic.checked = Boolean(status?.automatic);
  automatic.disabled = busy || unavailable || !status?.updateToken;
  $('#updatesCheck').disabled = busy;
  $('#updatesCheckLabel').textContent = UPDATE_UI.pending === 'checking' || status?.phase === 'checking' ? '检查中…' : '检查更新';
  const install = $('#updatesInstall');
  install.hidden = !(status?.latestVersion && (installing || (status.canInstall
    && ['available', 'error'].includes(status.phase) && status.latestVersion !== status.currentVersion)));
  install.disabled = busy || unavailable || !status?.updateToken;
  $('#updatesInstallLabel').textContent = installing ? '更新中…' : status?.phase === 'error' ? '重试安装并重启' : '安装并重启';

  const url = updateReleaseUrl(status?.releaseUrl);
  const release = $('#updatesRelease');
  release.hidden = !url;
  if (url) release.href = url;
  else release.removeAttribute('href');
  const notes = typeof status?.releaseNotes === 'string' ? status.releaseNotes : '';
  $('#updatesReleaseNotes').textContent = notes;
  $('#updatesNotes').hidden = !notes;
}

function acceptUpdateStatus(status) {
  if (!status || typeof status !== 'object') throw new Error('更新状态格式不正确');
  UPDATE_UI.status = status;
  UPDATE_UI.unavailable = false;
  if (UPDATE_UI.waitingVersion && status.currentVersion
    && status.currentVersion !== UPDATE_UI.previousVersion) {
    UPDATE_UI.waitingVersion = '';
    window.location.reload();
    return;
  }
  if (status.phase === 'error' || (UPDATE_UI.disconnected
    && ['idle', 'available', 'current'].includes(status.phase))) {
    UPDATE_UI.waitingVersion = '';
    UPDATE_UI.disconnected = false;
  } else if (['downloading', 'installing'].includes(status.phase) && !UPDATE_UI.waitingVersion) {
    UPDATE_UI.waitingVersion = status.latestVersion || 'pending';
    UPDATE_UI.previousVersion = status.currentVersion;
  }
  renderUpdates();

  if (status.phase === 'available' && status.latestVersion && !UPDATE_UI.notified.has(status.latestVersion)) {
    UPDATE_UI.notified.add(status.latestVersion);
    try {
      localStorage.setItem('qq-update-notified', JSON.stringify([...UPDATE_UI.notified].slice(-20)));
    } catch { /* The current page still remembers notified versions. */ }
    snackbar(`发现新版本 ${status.latestVersion}`, {
      action: '查看更新',
      duration: 8000,
      onAction: () => {
        setPage('system');
        $('#updatesTitle')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
    });
  }
}

function scheduleUpdateStatus() {
  window.clearTimeout(UPDATE_UI.timer);
  UPDATE_UI.timer = window.setTimeout(() => {
    if (document.visibilityState === 'visible' || updateInProgress()) loadUpdates();
    else scheduleUpdateStatus();
  }, updateInProgress() || UPDATE_UI.status?.phase === 'checking' ? 2000 : 30000);
}

function loadUpdates() {
  if (UPDATE_UI.reading) return UPDATE_UI.reading;
  UPDATE_UI.reading = api('/api/updates', { signal: AbortSignal.timeout(8000) })
    .then((status) => {
      acceptUpdateStatus(status);
      return status;
    })
    .catch(() => {
      UPDATE_UI.unavailable = true;
      if (updateInProgress()) UPDATE_UI.disconnected = true;
      renderUpdates();
      return null;
    })
    .finally(() => {
      UPDATE_UI.reading = null;
      scheduleUpdateStatus();
    });
  return UPDATE_UI.reading;
}

async function writeUpdate(path, method, body, beforeWrite) {
  const status = await loadUpdates();
  if (!status?.updateToken) throw new Error('暂时无法连接更新服务，请稍后重试');
  beforeWrite?.();
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-QQ-Update-Token': status.updateToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}

async function checkUpdates() {
  if (UPDATE_UI.pending || updateInProgress()) return;
  UPDATE_UI.pending = 'checking';
  renderUpdates();
  try {
    acceptUpdateStatus(await writeUpdate('/api/updates/check', 'POST', {}));
  } catch (err) {
    snackbar(`检查更新失败：${err.message}`, { duration: 5200 });
  } finally {
    UPDATE_UI.pending = '';
    renderUpdates();
    scheduleUpdateStatus();
  }
}

async function setUpdateAutomatic(automatic) {
  if (UPDATE_UI.pending || updateInProgress()) return;
  UPDATE_UI.pending = 'settings';
  renderUpdates();
  try {
    acceptUpdateStatus(await writeUpdate('/api/updates/settings', 'PUT', { automatic }));
    snackbar(automatic ? '已开启自动检查更新' : '已关闭自动检查更新');
  } catch (err) {
    snackbar(`更新设置保存失败：${err.message}`, { duration: 5200 });
  } finally {
    UPDATE_UI.pending = '';
    renderUpdates();
  }
}

async function installUpdate() {
  const status = UPDATE_UI.status;
  if (UPDATE_UI.pending || updateInProgress() || !status?.canInstall || !status.latestVersion) return;
  const version = status.latestVersion;
  UPDATE_UI.pending = 'confirm';
  renderUpdates();
  const answer = confirmDialog(
    `安装 ${version} 并重启？`,
    '配置、人格和记忆会保留。更新会重启桥接与托盘，期间暂时离线；DSH 保持运行。确认后开始下载并安装。',
    { okText: '安装并重启', danger: false },
  );
  $('#dialogCancel')?.focus();
  const sure = await answer;
  if (!sure) {
    UPDATE_UI.pending = '';
    renderUpdates();
    $('#updatesInstall')?.focus();
    return;
  }
  UPDATE_UI.pending = 'install';
  renderUpdates();
  let submitted = false;
  try {
    acceptUpdateStatus(await writeUpdate('/api/updates/install', 'POST', { version }, () => {
      submitted = true;
      UPDATE_UI.previousVersion = status.currentVersion;
      UPDATE_UI.waitingVersion = version;
      renderUpdates();
    }));
  } catch (err) {
    // A restart can close this request after the server has accepted installation.
    if (submitted) await loadUpdates();
    if (!submitted || (!UPDATE_UI.unavailable && !['downloading', 'installing', 'complete'].includes(UPDATE_UI.status?.phase))) {
      UPDATE_UI.waitingVersion = '';
      snackbar(`安装更新失败：${err.message}`, { duration: 6000 });
    }
  } finally {
    UPDATE_UI.pending = '';
    renderUpdates();
    scheduleUpdateStatus();
  }
}

/* ---------------------------------------------------------------- 系统 */

function renderSystemInfo(overview) {
  const host = $('#systemInfo');
  if (!host || !overview) return;
  host.textContent = '';

  const rows = [
    ['版本', overview.version],
    ['控制台已运行', humanUptime(overview.uptimeSeconds)],
    ['控制台端口', String(overview.ports?.webui ?? '—')],
    ['OneBot 端口', String(overview.ports?.onebot ?? '—')],
    ['NapCat WebUI', String(overview.ports?.napcatWebui ?? '—')],
    ['桥接 PID', String(overview.bridge?.pid || '—')],
    ['最近消息', overview.bridge?.lastMessageAt ? relTime(overview.bridge.lastMessageAt) : '—'],
    [
      '最近忽略',
      overview.bridge?.lastDrop
        ? `${overview.bridge.lastDrop}${overview.bridge.lastDropAt ? `（${relTime(overview.bridge.lastDropAt)}）` : ''}`
        : '无',
    ],
    ['最近错误', overview.bridge?.lastError || '无'],
    ['Node', overview.runtime?.node ?? '—'],
    ['平台', overview.runtime?.platform ?? '—'],
    ['记忆目录', overview.runtime?.memoryRoot ?? '—'],
    ['配置文件', overview.runtime?.configPath ?? '—'],
  ];

  const rawMem = overview.memory;
  const mem = rawMem && rawMem.ok === true && rawMem.data ? rawMem.data : rawMem?.files !== undefined ? rawMem : null;
  if (mem?.root) {
    rows.splice(10, 0, ['记忆条目', `${Number(mem.files) || 0} 篇 · ${humanBytes(mem.totalBytes)}`]);
    rows.splice(11, 0, ['记忆最近更新', mem.lastUpdated ? relTime(mem.lastUpdated) : '—']);
  }

  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value ?? '—');
    host.append(dt, dd);
  }
}

async function loadLogs() {
  const box = $('#logBox');
  if (!box) return;
  try {
    const data = await api(`/api/logs?name=${encodeURIComponent(STATE.logName)}&lines=240`);
    if (data.missing) {
      box.textContent = `日志文件还没生成：${data.file}`;
    } else if (!data.lines?.length) {
      box.textContent = '日志是空的';
    } else {
      box.textContent = data.lines.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  } catch (err) {
    box.textContent = `读取日志失败：${err.message}`;
  }
}

/** 把 textarea 里的 QQ 号/群号解析成数字数组（逗号、空格、换行都认） */
function parseIdList(value) {
  return String(value ?? '')
    .split(/[\s,，;；、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
}

/** 把数字数组写回 textarea，一行一个，方便看 */
function fillIdList(node, list) {
  if (!node) return;
  node.value = Array.isArray(list) ? list.join('\n') : '';
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    const behavior = data?.behavior || {};
    const security = data?.security || {};
    const showErrors = $('#setShowErrors');
    const context = $('#setGroupContext');
    const sessionWindow = $('#setSessionWindowMinutes');
    const wake = $('#setWakeWord');
    const wakeAnywhere = $('#setWakeAnywhere');
    const allowMembers = $('#setAllowGroupMembers');
    const allowGroups = $('#setAllowGroups');
    const privatePolicy = $('#setPrivatePolicy');
    if (showErrors) showErrors.checked = Boolean(behavior.showErrors);
    if (context) context.value = String(Number(behavior.groupContextCount) || 0);
    if (sessionWindow && document.activeElement !== sessionWindow) {
      sessionWindow.value = String(behavior.sessionWindowMinutes ?? 180);
    }
    if (wake) wake.value = behavior.wakeWord ?? '';
    if (wakeAnywhere) wakeAnywhere.checked = String(behavior.wakeWordMatch ?? 'prefix').toLowerCase() === 'contains';
    if (allowMembers) allowMembers.checked = Boolean(security.allowGroupMembers);
    if (allowGroups) allowGroups.checked = Boolean(security.allowGroups);
    if (privatePolicy) privatePolicy.value = String(security.privatePolicy ?? 'allowlist') === 'blacklist' ? 'blacklist' : 'allowlist';
    fillIdList($('#setAdminUserIds'), security.adminUserIds);
    fillIdList($('#setAllowFrom'), security.allowFrom);
    fillIdList($('#setDenyFrom'), security.denyFrom);
    fillIdList($('#setAllowGroupIds'), security.allowGroupIds);
    fillIdList($('#setDenyGroupIds'), security.denyGroupIds);
  } catch (err) {
    snackbar(`读取设置失败：${err.message}`);
  }
}

async function saveSettings() {
  const btn = $('#settingsSave');
  if (!btn) return;
  const sessionWindowMinutes = $('#setSessionWindowMinutes')?.valueAsNumber;
  if (!Number.isSafeInteger(sessionWindowMinutes) || sessionWindowMinutes < 0 ||
      !Number.isSafeInteger(sessionWindowMinutes * 60000)) {
    snackbar('新建会话间隔必须是有效的非负整数分钟');
    return;
  }
  const adminUserIds = String($('#setAdminUserIds')?.value ?? '')
    .split(/[\s,，;；]+/).filter(Boolean);
  if (!adminUserIds.every((id) => /^[1-9]\d*$/.test(id))) {
    snackbar('电脑操作管理员只能填写完整的纯数字 QQ 号');
    return;
  }
  const payload = {
    behavior: {
      showErrors: Boolean($('#setShowErrors')?.checked),
      groupContextCount: Number($('#setGroupContext')?.value) || 0,
      sessionWindowMinutes,
      wakeWord: String($('#setWakeWord')?.value ?? ''),
      wakeWordMatch: $('#setWakeAnywhere')?.checked ? 'contains' : 'prefix',
    },
    security: {
      adminUserIds,
      allowGroupMembers: Boolean($('#setAllowGroupMembers')?.checked),
      allowGroups: Boolean($('#setAllowGroups')?.checked),
      privatePolicy: String($('#setPrivatePolicy')?.value ?? 'allowlist'),
      allowFrom: parseIdList($('#setAllowFrom')?.value),
      denyFrom: parseIdList($('#setDenyFrom')?.value),
      allowGroupIds: parseIdList($('#setAllowGroupIds')?.value),
      denyGroupIds: parseIdList($('#setDenyGroupIds')?.value),
    },
  };

  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    const count = Object.keys(data?.applied || {}).length;
    snackbar(count > 0 ? `已保存 ${count} 项设置（会话间隔与管理员权限立即生效，其余设置重启桥接后生效）` : '没有改动');
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    btn.disabled = false;
    btn.textContent = '保存设置';
  }
}

async function loadSystem() {
  const overview = await api('/api/overview');
  STATE.overview = overview;
  setStatusChip(overview);
  renderSystemInfo(overview);
  await Promise.all([loadLogs(), loadSettings(), loadAutostart(), loadPaths(), loadUpdates()]);
}

/* ------------------------------------------------------------ 路径 */

function pathHint(data, kind) {
  if (!data) return '—';
  const exists = data.exists ? (data.isDir ? '目录存在' : data.isFile ? '文件存在' : '存在') : '还不存在';
  const size = data.isFile && data.bytes ? ` · ${humanBytes(data.bytes)}` : '';
  const enabled = data.enabled === false ? ' · 已停用' : '';
  return `解析为：${data.resolved}（${exists}${size}${enabled}）`;
}

function renderPaths(data) {
  STATE.paths = data;
  const persona = $('#setPersonaPath');
  const memory = $('#setMemoryRoot');
  const workspace = $('#setWorkspaceCwd');
  if (persona && document.activeElement !== persona) persona.value = data.persona?.raw ?? '';
  if (memory && document.activeElement !== memory) memory.value = data.memory?.raw ?? '';
  if (workspace && document.activeElement !== workspace) workspace.value = data.workspace?.raw ?? '';
  const ph = $('#personaPathHint');
  const mh = $('#memoryRootHint');
  const wh = $('#workspaceCwdHint');
  if (ph) ph.textContent = pathHint(data.persona, 'file');
  if (mh) mh.textContent = pathHint(data.memory, 'dir');
  if (wh) wh.textContent = pathHint(data.workspace, 'dir');
}

async function loadPaths() {
  try {
    renderPaths(await api('/api/paths'));
  } catch (err) {
    for (const id of ['#personaPathHint', '#memoryRootHint', '#workspaceCwdHint']) {
      const node = $(id);
      if (node) node.textContent = `读取失败：${err.message}`;
    }
  }
}

/** 边输入边问后端「这路径解析成什么、存不存在」 */
async function checkPathField(input, hint) {
  if (!input || !hint) return;
  const raw = input.value.trim();
  if (!raw) {
    hint.textContent = '留空 = 用默认位置';
    return;
  }
  try {
    const data = await api('/api/paths/check', { method: 'POST', body: JSON.stringify({ path: raw }) });
    hint.textContent = pathHint(data);
  } catch (err) {
    hint.textContent = `这个路径有问题：${err.message}`;
  }
}

async function savePaths({ restart = false } = {}) {
  const btn = restart ? $('#pathsSaveRestart') : $('#pathsSave');
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    const body = {
      persona: { path: $('#setPersonaPath')?.value ?? '' },
      memory: { root: $('#setMemoryRoot')?.value ?? '' },
      dsh: { cwd: $('#setWorkspaceCwd')?.value ?? '' },
    };
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    await loadPaths();
    const applied = Object.keys(result.applied ?? {}).length;
    snackbar(applied > 0 ? `已保存 ${applied} 个路径（重启桥接后生效）` : '没有改动');
    if (restart) {
      await api('/api/service/bridge/restart', { method: 'POST' });
      snackbar('已保存并重启桥接');
      setTimeout(() => refreshPage('system').catch(() => {}), 2500);
    }
  } catch (err) {
    snackbar(`保存失败：${err.message}`, { duration: 5200 });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || '保存路径';
    }
  }
}

/** 开机自启：读写的是启动文件夹里的快捷方式（和托盘菜单原来那个是同一个文件） */
async function loadAutostart() {
  const box = $('#setAutostart');
  const hint = $('#autostartHint');
  if (!box) return;
  try {
    const data = await api('/api/autostart');
    STATE.autostart = data;
    box.checked = Boolean(data.enabled);
    box.disabled = false;
    if (hint) {
      hint.textContent = data.available
        ? data.enabled
          ? `已启用：${data.shortcutPath}`
          : '未启用（不影响当前正在运行的服务）'
        : `缺少引导脚本：${data.bootstrapPath || 'launcher\\bootstrap.ps1'}`;
    }
  } catch (err) {
    box.disabled = true;
    if (hint) hint.textContent = `读取失败：${err.message}`;
  }
}

async function setAutostart(enabled) {
  const box = $('#setAutostart');
  if (box) box.disabled = true;
  try {
    const data = await api('/api/autostart', { method: 'PUT', body: JSON.stringify({ enabled }) });
    STATE.autostart = data.snapshot;
    if (box) box.checked = Boolean(data.snapshot?.enabled);
    const hint = $('#autostartHint');
    if (hint && data.snapshot) {
      hint.textContent = data.snapshot.enabled ? `已启用：${data.snapshot.shortcutPath}` : '未启用（不影响当前正在运行的服务）';
    }
    snackbar(enabled ? '已设为开机自启' : '已关闭开机自启');
  } catch (err) {
    if (box) box.checked = !enabled;
    snackbar(`设置失败：${err.message}`, { duration: 5200 });
  } finally {
    if (box) box.disabled = false;
  }
}

/* ------------------------------------------------------------ 下拉刷新 */

function initPullToRefresh() {
  const ptr = $('#ptr');
  const label = $('#ptrLabel');
  if (!ptr) return;

  let startY = 0;
  let pulling = false;
  let distance = 0;
  const THRESHOLD = 68;

  const reset = () => {
    pulling = false;
    distance = 0;
    ptr.classList.remove('is-visible', 'is-refreshing');
  };

  window.addEventListener(
    'touchstart',
    (event) => {
      if (window.scrollY > 4 || event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      pulling = true;
      distance = 0;
    },
    { passive: true },
  );

  window.addEventListener(
    'touchmove',
    (event) => {
      if (!pulling || ptr.classList.contains('is-refreshing')) return;
      distance = event.touches[0].clientY - startY;
      if (distance <= 0) {
        ptr.classList.remove('is-visible');
        return;
      }
      ptr.classList.add('is-visible');
      if (label) label.textContent = distance >= THRESHOLD ? '松开刷新' : '下拉刷新';
    },
    { passive: true },
  );

  window.addEventListener(
    'touchend',
    async () => {
      if (!pulling) return;
      if (distance < THRESHOLD) {
        reset();
        return;
      }
      pulling = false;
      ptr.classList.add('is-refreshing');
      if (label) label.textContent = '刷新中…';
      try {
        await refreshPage();
        snackbar('已刷新');
      } catch (err) {
        snackbar(`刷新失败：${err.message}`);
      } finally {
        reset();
      }
    },
    { passive: true },
  );
}

/* -------------------------------------------------------------- 初始化 */

function initEvents() {
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => setPage(item.dataset.page));
  });

  $('#statusChip')?.addEventListener('click', async () => {
    try {
      await loadOverview();
      snackbar('状态已刷新');
    } catch (err) {
      snackbar(`刷新失败：${err.message}`);
    }
  });

  $('#fab')?.addEventListener('click', async () => {
    const fab = $('#fab');
    fab?.classList.add('is-spinning');
    try {
      await refreshPage();
      snackbar('已刷新');
    } catch (err) {
      snackbar(`刷新失败：${err.message}`);
    } finally {
      window.setTimeout(() => fab?.classList.remove('is-spinning'), 480);
    }
  });

  // 记忆
  $('#memoryForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    searchMemory($('#memoryQuery')?.value);
  });
  $$('#memoryQuick .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.q || chip.textContent || '';
      const input = $('#memoryQuery');
      if (input) input.value = q;
      searchMemory(q);
    });
  });

  // 记忆反思：手动按键 + 每天定时 + 打开本周那一篇
  $('#reflectNow')?.addEventListener('click', runReflectNow);
  $('#reflectSave')?.addEventListener('click', saveReflectSettings);
  $('#reflectOpen')?.addEventListener('click', openReflection);
  $('#reflectDaily')?.addEventListener('change', () => {
    const time = $('#reflectTime');
    if (time && !time.value) time.value = '04:00';
  });

  // 表情包
  $('#stickerForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadStickers();
  });
  $('#stickerTags')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    STATE.stickerTag = chip.dataset.tag || '';
    loadStickers();
  });
  $('#stickerRebuild')?.addEventListener('click', rebuildStickers);
  $('#stickerMigrate')?.addEventListener('click', migrateStickers);
  $('#stickerSave')?.addEventListener('click', saveStickerSettings);
  $('#stickerSendProbability')?.addEventListener('input', updateStickerSendProbability);
  $('#stickerOpen')?.addEventListener('click', openStickersDir);
  $('#stickerDetailClose')?.addEventListener('click', closeStickerDetail);
  $('#stickerDetailTags')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip?.dataset.tag) removeStickerTag(chip.dataset.tag);
  });
  $('#stickerTagAdd')?.addEventListener('click', addStickerTags);
  $('#stickerTagInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addStickerTags();
    }
  });
  $('#stickerDelete')?.addEventListener('click', deleteSticker);
  $('#stickerScrim')?.addEventListener('click', (event) => {
    if (event.target === $('#stickerScrim')) closeStickerDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#stickerScrim')?.hidden) closeStickerDetail();
  });

  // 人格
  $('#personaSave')?.addEventListener('click', savePersona);
  $('#personaReload')?.addEventListener('click', () => loadPersona({ force: true }));
  $('#personaNew')?.addEventListener('click', newPersona);
  $('#personaSeed')?.addEventListener('click', seedPersonas);
  $('#personaBody')?.addEventListener('input', () => {
    personaDirty = true;
  });
  window.addEventListener('beforeunload', (event) => {
    if (!personaDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // 会话
  $('#sessionsRefresh')?.addEventListener('click', () => loadSessions().catch((e) => snackbar(e.message)));

  // 模型
  $$('#modelModeSwitch .segmented__item').forEach((btn) => {
    btn.addEventListener('click', () => setModelMode(btn.dataset.mode));
  });
  $('#modelProvider')?.addEventListener('change', () => {
    const providers = Array.isArray(STATE.model?.providers) ? STATE.model.providers : [];
    const provider = providers.find((p) => p.id === $('#modelProvider')?.value) || providers[0];
    fillSelect($('#modelModel'), provider ? provider.models : [], STATE.model?.manual?.model);
  });
  $('#modelReload')?.addEventListener('click', () => loadModel());
  $('#modelSave')?.addEventListener('click', () => saveModel());

  // 插件
  $('#pluginsReload')?.addEventListener('click', () => loadPlugins());

  // 日志切换
  $$('#logSwitch .segmented__item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      $$('#logSwitch .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      STATE.logName = btn.dataset.log || 'napcat';
      await loadLogs();
    });
  });
  $('#logReload')?.addEventListener('click', () => loadLogs());

  $('#openNapcat')?.addEventListener('click', async () => {
    // 地址由后端归一化好（…/webui/），这里用系统默认浏览器打开，避免 Edge --app 窗口拦 window.open
    const url = STATE.overview?.ports?.napcatWebui || 'http://127.0.0.1:6099/webui/';
    try {
      const data = await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'napcat-webui' }) });
      const hint = data.tokenAttached ? '已带上登录 token' : '没找到 token，可能需要手动输入';
      snackbar(`已请求打开 NapCat WebUI（${hint}）：${data.path ?? url}`, { duration: 4200 });
    } catch (err) {
      window.open(url, '_blank', 'noopener');
      snackbar(`没能自动打开，请手动复制：${url}`, { duration: 6000 });
    }
  });

  // 设置
  $('#settingsSave')?.addEventListener('click', saveSettings);
  $('#setAutostart')?.addEventListener('change', (event) => setAutostart(Boolean(event.target.checked)));
  $('#updatesCheck')?.addEventListener('click', checkUpdates);
  $('#updatesAutomatic')?.addEventListener('change', (event) => setUpdateAutomatic(Boolean(event.target.checked)));
  $('#updatesInstall')?.addEventListener('click', installUpdate);

  // 路径（人格 / 记忆库 / 工作区）
  $('#pathsRefresh')?.addEventListener('click', () => loadPaths());
  $('#pathsSave')?.addEventListener('click', () => savePaths({ restart: false }));
  $('#pathsSaveRestart')?.addEventListener('click', () => savePaths({ restart: true }));
  $('#pathsOpen')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'workspace' }) });
      snackbar(`已请求打开：${data.path}`, { duration: 3200 });
    } catch (err) {
      snackbar(`打开失败：${err.message}`, { duration: 4800 });
    }
  });
  for (const [inputId, hintId] of [
    ['#setPersonaPath', '#personaPathHint'],
    ['#setMemoryRoot', '#memoryRootHint'],
    ['#setWorkspaceCwd', '#workspaceCwdHint'],
  ]) {
    const input = $(inputId);
    const hint = $(hintId);
    input?.addEventListener('blur', () => checkPathField(input, hint));
  }

  // 记忆库：原来在托盘菜单里，菜单精简后搬到这里
  $('#memoryOpenDir')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'memory' }) });
      snackbar(`已请求打开：${data.path}`, { duration: 3200 });
    } catch (err) {
      snackbar(`打开失败：${err.message}`, { duration: 5200 });
    }
  });
  $('#memoryOpenObsidian')?.addEventListener('click', async () => {
    try {
      await api('/api/open', { method: 'POST', body: JSON.stringify({ target: 'memory-obsidian' }) });
      snackbar('已请求在 Obsidian 中打开记忆库');
    } catch (err) {
      snackbar(`打开失败：${err.message}`, { duration: 5200 });
    }
  });

  // 对话框
  $('#dialogCancel')?.addEventListener('click', () => closeDialog(false));
  $('#dialogOk')?.addEventListener('click', () => closeDialog(true));
  $('#dialogScrim')?.addEventListener('click', (event) => {
    if (event.target === $('#dialogScrim')) closeDialog(false);
  });
  // 输入型对话框（新建人格）
  $('#promptOk')?.addEventListener('click', submitPrompt);
  $('#promptCancel')?.addEventListener('click', () => closePrompt(null));
  $('#promptInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitPrompt();
    }
  });
  $('#promptScrim')?.addEventListener('click', (event) => {
    if (event.target === $('#promptScrim')) closePrompt(null);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#promptScrim')?.hidden) closePrompt(null);
      else if (!$('#dialogScrim')?.hidden) closeDialog(false);
      else hideSnackbar();
    }
  });

  // 顶栏阴影
  window.addEventListener(
    'scroll',
    () => {
      $('.top-app-bar')?.classList.toggle('is-scrolled', window.scrollY > 2);
    },
    { passive: true },
  );

  // 前后跳转
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace(/^#/, '');
    if (PAGES[name] && name !== STATE.page) setPage(name, { push: false });
  });
}

function init() {
  initEvents();
  initRipples();
  initPullToRefresh();

  const initial = location.hash.replace(/^#/, '');
  setPage(PAGES[initial] ? initial : 'overview', { push: false });
  loadUpdates();

  // 概览状态每 8 秒悄悄刷新一次（只在概览页）
  window.setInterval(() => {
    if (STATE.page === 'overview' && document.visibilityState === 'visible') {
      loadOverview().catch(() => {});
    }
  }, 8000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
