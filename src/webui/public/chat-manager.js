/**
 * 控制台「会话」页的会话管理：每个群 / 私聊一行，
 * 显示最后活跃时间、今日群发言、当前会话数，可以单独换人格、重置上下文。
 * 只用 DOM API 拼界面（不往 innerHTML 塞用户内容）。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** 「3 分钟前」这种相对时间；超过一周显示日期 */
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '暂无记录';
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按类型和关键词筛选会话行 */
export function filterChats(items, { kind = 'all', query = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (!q) return true;
    return [item.id, item.name, item.persona].some((v) => String(v ?? '').toLowerCase().includes(q));
  });
}

function subtitle(item) {
  const parts = [`${item.kind === 'group' ? '群' : 'QQ'} ${item.id}`, `最后活跃 ${relativeTime(item.lastAt)}`];
  if (item.kind === 'group' && item.todayMessages) parts.push(`今日发言 ${item.todayMessages}`);
  parts.push(item.sessions ? `会话 ${item.sessions} 个` : '暂无会话');
  return parts.join(' · ');
}

export function initChatManager({ api, notify, confirm, onReset }) {
  const list = document.getElementById('chatList');
  const summary = document.getElementById('chatSummary');
  const search = document.getElementById('chatSearch');
  const refresh = document.getElementById('chatRefresh');
  const kindButtons = Array.from(document.querySelectorAll('[data-chat-kind]'));
  if (!list) return { load: async () => {} };
  const state = { items: [], personas: [], active: '', kind: 'all', query: '' };

  function personaSelect(item) {
    const select = el('select', { class: 'select-field chat-row__persona', 'aria-label': `${item.name || item.id} 的人格` });
    select.append(el('option', { value: '', text: state.active ? `跟随全局（${state.active}）` : '跟随全局' }));
    const names = new Set(state.personas);
    if (item.persona && !names.has(item.persona)) names.add(item.persona);
    for (const name of names) select.append(el('option', { value: name, text: name }));
    select.value = item.persona || '';
    select.disabled = !state.personas.length;
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await api('/api/personas/chat', { method: 'PUT', body: JSON.stringify({ chatKey: item.key, name: select.value }) });
        item.persona = select.value;
        notify(select.value ? `${item.name || item.key} 改用「${select.value}」` : `${item.name || item.key} 回到全局人格`);
      } catch (err) {
        select.value = item.persona || '';
        notify(`换人格失败：${err.message}`);
      } finally {
        select.disabled = false;
      }
    });
    return select;
  }

  async function reset(item, button) {
    const label = item.name || item.key;
    if (!await confirm('重置会话？', `重置 ${label} 之后，下一条消息会开一个全新会话，之前的上下文接不上了。`, { okText: '重置' })) return;
    button.disabled = true;
    try {
      const data = await api(`/api/chats/${encodeURIComponent(item.key)}/session`, { method: 'DELETE' });
      notify(data.removed?.length ? `已重置 ${label}` : `${label} 本来就没有会话`);
      await load();
      await onReset?.();
    } catch (err) {
      notify(`重置失败：${err.message}`);
      button.disabled = false;
    }
  }

  function row(item) {
    const resetBtn = el('button', { class: 'btn btn--text ripple', type: 'button', text: '重置会话', disabled: !item.sessions });
    resetBtn.addEventListener('click', () => reset(item, resetBtn));
    return el('div', { class: 'session chat-row' }, [
      el('div', { class: 'session__icon', text: item.kind === 'group' ? '群' : '私', 'aria-hidden': 'true' }),
      el('div', { class: 'session__main' }, [
        el('div', { class: 'session__title', text: item.name || item.id }),
        el('div', { class: 'session__sub', text: subtitle(item) }),
      ]),
      el('div', { class: 'chat-row__actions' }, [personaSelect(item), resetBtn]),
    ]);
  }

  function render() {
    const items = filterChats(state.items, state);
    list.replaceChildren();
    if (!state.items.length) {
      list.append(el('p', { class: 'empty', text: '还没有会话记录。群里有人说话或私聊它之后会出现在这里。' }));
      return;
    }
    if (!items.length) {
      list.append(el('p', { class: 'empty', text: '没有符合条件的会话' }));
      return;
    }
    for (const item of items) list.append(row(item));
  }

  async function load() {
    try {
      const data = await api('/api/chats');
      state.items = Array.isArray(data.items) ? data.items : [];
      state.personas = Array.isArray(data.personas) ? data.personas : [];
      state.active = data.activePersona || '';
      if (summary) {
        const groups = data.counts?.group ?? 0;
        summary.textContent = `共 ${state.items.length} 个会话（群聊 ${groups} · 私聊 ${state.items.length - groups}）`;
      }
      render();
    } catch (err) {
      list.replaceChildren(el('p', { class: 'empty', text: `加载失败：${err.message}` }));
    }
  }

  for (const button of kindButtons) {
    button.addEventListener('click', () => {
      state.kind = button.dataset.chatKind;
      for (const b of kindButtons) {
        const active = b === button;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      }
      render();
    });
  }
  search?.addEventListener('input', () => { state.query = search.value; render(); });
  refresh?.addEventListener('click', () => { void load(); });

  return { load };
}
