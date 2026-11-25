/**
 * 插件卡片折叠：「插件」页的 AstrBot 插件和 DSH 插件共用。
 *
 * 默认收起，只露出标题、版本、说明和启用开关；展开状态按「范围:插件 ID」记在本机，
 * 重新渲染（保存、刷新、切页）后保持不变。卡片用 innerHTML 整体重绘，所以展开状态在
 * 渲染时由 foldCard() 写进标记，点击则由 bindPluginFold() 在页面根节点上统一处理。
 */

const STORAGE_KEY = 'qq-console:plugins-expanded';
const MAX_REMEMBERED = 500;

const CHEVRON = '<svg class="plugin-fold__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.6 7.2 7l5 5-5 5 1.4 1.4 6.4-6.4z"/></svg>';

let fallbackExpanded = new Set();

function readExpanded() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((key) => typeof key === 'string') : []);
  } catch {
    return new Set(fallbackExpanded);
  }
}

function writeExpanded(expanded) {
  const keys = [...expanded].slice(-MAX_REMEMBERED);
  fallbackExpanded = new Set(keys);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch { /* 存不进去只是刷新后不记得 */ }
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function bodyIdFor(key) {
  return `plugin-fold-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * @param {string} key 形如 "astrbot:<id>" 或 "dsh:<name>"
 * @returns {boolean}
 */
export function isPluginExpanded(key) {
  return readExpanded().has(key);
}

/**
 * 生成一张可折叠插件卡片的 HTML。title / version / description / control / body / footer
 * 必须是已经转义过的 HTML；key 和 attrs 中的值由这里转义。
 * @param {{ key: string, title: string, version?: string, description?: string, control?: string, body: string, footer?: string, extraClass?: string, attrs?: Record<string, string> }} parts
 * @returns {string}
 */
export function foldCard({ key, title, version = '', description = '', control = '', body, footer = '', extraClass = '', attrs = {} }) {
  const open = isPluginExpanded(key);
  const bodyId = bodyIdFor(key);
  const extraAttrs = Object.entries(attrs).map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
  return `<section class="card plugin-fold${open ? ' is-open' : ''}${extraClass ? ` ${extraClass}` : ''}" data-fold-key="${escapeAttr(key)}"${extraAttrs}>
    <div class="plugin-fold__head">
      <button class="plugin-fold__toggle" type="button" data-fold-toggle aria-expanded="${open}" aria-controls="${bodyId}">
        ${CHEVRON}
        <span class="plugin-fold__heading"><span class="plugin-fold__title">${title}</span>${version ? `<span class="chip chip--tiny">${version}</span>` : ''}</span>
        ${description ? `<span class="plugin-fold__desc">${description}</span>` : ''}
      </button>
      ${control}
    </div>
    <div class="plugin-fold__body" id="${bodyId}"${open ? '' : ' hidden'}>${body}</div>
    ${footer}
  </section>`;
}

function setOpen(card, open, expanded) {
  const key = card.dataset.foldKey;
  if (!key) return;
  card.classList.toggle('is-open', open);
  card.querySelector(':scope > .plugin-fold__head [data-fold-toggle]')?.setAttribute('aria-expanded', String(open));
  const body = card.querySelector(':scope > .plugin-fold__body');
  if (body) body.hidden = !open;
  if (open) expanded.add(key);
  else expanded.delete(key);
}

/**
 * 在「插件」页根节点上接管折叠点击，以及「全部展开 / 全部收起」。重复调用无副作用。
 * @param {HTMLElement | null} root
 */
export function bindPluginFold(root) {
  if (!root || root.dataset.foldBound === 'true') return;
  root.dataset.foldBound = 'true';
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const toggle = target?.closest('[data-fold-toggle]');
    if (toggle && root.contains(toggle)) {
      const card = toggle.closest('[data-fold-key]');
      if (!card) return;
      const expanded = readExpanded();
      setOpen(card, !card.classList.contains('is-open'), expanded);
      writeExpanded(expanded);
      return;
    }
    const all = target?.closest('[data-fold-all]');
    if (all && root.contains(all)) {
      const open = all.dataset.foldAll === 'open';
      const expanded = readExpanded();
      for (const card of root.querySelectorAll('[data-fold-key]')) setOpen(card, open, expanded);
      writeExpanded(expanded);
    }
  });
}
