/**
 * 控制台「自动化」页的关键词自动回复编辑器。
 * 只用 DOM API 拼界面（不往 innerHTML 塞用户内容），整份规则一起保存到 /api/keywords。
 */

const MATCH_LABELS = { contains: '包含', exact: '整句相同', regex: '正则' };
const SCOPE_LABELS = { all: '群聊和私聊', group: '只在群聊', private: '只在私聊' };
const DEFAULT_COOLDOWN = 30;

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

function select(id, labels, value) {
  const node = el('select', { class: 'select-field', id });
  for (const [key, label] of Object.entries(labels)) node.append(el('option', { value: key, text: label }));
  node.value = labels[value] ? value : Object.keys(labels)[0];
  return node;
}

function field(label, input) {
  return el('div', { class: 'keyword-rule__field' }, [el('label', { class: 'field-label', htmlFor: input.id, text: label }), input]);
}

function splitList(value) {
  return String(value ?? '').split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean);
}

/** 读编辑器里的一条规则（原样交给后端校验） */
function readRule(card) {
  const q = (name) => card.querySelector(`[data-field="${name}"]`);
  return {
    id: card.dataset.id,
    enabled: q('enabled').checked,
    keywords: splitList(q('keywords').value),
    match: q('match').value,
    scope: q('scope').value,
    reply: q('reply').value,
    image: q('image').value.trim(),
    groupIds: splitList(q('groupIds').value),
    cooldownSeconds: Number(q('cooldownSeconds').value || 0),
  };
}

function ruleCard(rule, index, { onRemove }) {
  const uid = `kw${index}-${Math.random().toString(36).slice(2, 7)}`;
  const tag = (node, name) => { node.dataset.field = name; return node; };
  const enabled = tag(el('input', { class: 'switch', type: 'checkbox', id: `${uid}-on`, checked: rule.enabled !== false }), 'enabled');
  const keywords = tag(el('input', { class: 'text-field', type: 'text', id: `${uid}-kw`, value: (rule.keywords ?? []).join('，'), placeholder: '早安，早上好' }), 'keywords');
  const match = tag(select(`${uid}-match`, MATCH_LABELS, rule.match), 'match');
  const scope = tag(select(`${uid}-scope`, SCOPE_LABELS, rule.scope), 'scope');
  const reply = tag(el('textarea', { class: 'text-field text-field--list', id: `${uid}-reply`, rows: 2, value: rule.reply ?? '', placeholder: '早呀！' }), 'reply');
  const image = tag(el('input', { class: 'text-field', type: 'text', id: `${uid}-img`, value: rule.image ?? '', placeholder: 'https://… 或 D:\\图片\\早安.png（可留空）' }), 'image');
  const groups = tag(el('input', { class: 'text-field', type: 'text', id: `${uid}-groups`, inputmode: 'numeric', value: (rule.groupIds ?? []).join('，'), placeholder: '留空 = 所有已授权的群' }), 'groupIds');
  const cooldown = tag(el('input', { class: 'text-field text-field--num', type: 'number', id: `${uid}-cd`, min: 0, max: 86400, step: 1, value: rule.cooldownSeconds ?? DEFAULT_COOLDOWN }), 'cooldownSeconds');
  const remove = el('button', { class: 'btn btn--text ripple', type: 'button', text: '删除' });
  const card = el('fieldset', { class: 'keyword-rule' }, [
    el('legend', { class: 'keyword-rule__legend', text: `规则 ${index + 1}` }),
    el('div', { class: 'keyword-rule__head' }, [
      el('label', { class: 'switch-row keyword-rule__switch' }, [el('span', { class: 'switch-row__text', text: '启用' }), enabled]),
      remove,
    ]),
    el('div', { class: 'keyword-rule__grid' }, [
      field('关键词（逗号或换行分隔）', keywords),
      field('匹配方式', match),
      field('生效范围', scope),
      field('冷却（秒，同一会话）', cooldown),
    ]),
    field('回复文字', reply),
    el('div', { class: 'keyword-rule__grid keyword-rule__grid--2' }, [field('图片（可选）', image), field('只在这些群（可选）', groups)]),
  ]);
  card.dataset.id = rule.id ?? '';
  remove.addEventListener('click', () => onRemove(card));
  return card;
}

export function initKeywordRules({ api, notify, confirm }) {
  const list = document.getElementById('keywordList');
  const status = document.getElementById('keywordStatus');
  const addBtn = document.getElementById('keywordAdd');
  const saveBtn = document.getElementById('keywordSave');
  if (!list || !addBtn || !saveBtn) return { load: async () => {} };
  let dirty = false;

  const setStatus = (text) => { if (status) status.textContent = text; };
  const cards = () => Array.from(list.querySelectorAll('.keyword-rule'));

  function renumber() {
    cards().forEach((card, i) => { card.querySelector('legend').textContent = `规则 ${i + 1}`; });
    if (!cards().length && !list.querySelector('.empty')) {
      list.append(el('p', { class: 'empty', text: '还没有规则，点「添加规则」开始。' }));
    }
  }

  async function removeCard(card) {
    const keywords = readRule(card).keywords.join('，') || '这条规则';
    if (!await confirm('删除规则', `删除「${keywords}」？保存后生效。`, { okText: '删除' })) return;
    card.remove();
    dirty = true;
    renumber();
    setStatus('有未保存的修改');
  }

  function render(rules) {
    list.replaceChildren();
    rules.forEach((rule, i) => list.append(ruleCard(rule, i, { onRemove: removeCard })));
    renumber();
  }

  async function load() {
    if (dirty) return;
    try {
      const data = await api('/api/keywords');
      render(data.rules ?? []);
      setStatus(data.rules?.length ? `共 ${data.rules.length} 条规则` : '');
    } catch (err) {
      setStatus(`读取失败：${err.message}`);
    }
  }

  addBtn.addEventListener('click', () => {
    list.querySelector('.empty')?.remove();
    const card = ruleCard({ match: 'contains', scope: 'all', cooldownSeconds: DEFAULT_COOLDOWN }, cards().length, { onRemove: removeCard });
    list.append(card);
    dirty = true;
    setStatus('有未保存的修改');
    card.querySelector('[data-field="keywords"]')?.focus();
  });

  list.addEventListener('input', () => { dirty = true; setStatus('有未保存的修改'); });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const data = await api('/api/keywords', { method: 'PUT', body: JSON.stringify({ rules: cards().map(readRule) }) });
      dirty = false;
      render(data.rules ?? []);
      setStatus(`已保存 ${data.rules?.length ?? 0} 条规则`);
      notify('关键词规则已保存');
    } catch (err) {
      setStatus(`没保存：${err.message}`);
      notify(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  return { load };
}
