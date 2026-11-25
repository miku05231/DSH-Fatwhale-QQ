import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'qq-console:plugins-expanded';

function installStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
  return data;
}

installStorage();
const { bindPluginFold, foldCard, isPluginExpanded } = await import('../src/webui/public/plugin-fold.js');

/** 最小 DOM 替身：只实现 bindPluginFold / setOpen 用到的接口。 */
function fakeCard(key, open) {
  const classes = new Set(open ? ['is-open'] : []);
  const toggle = { attrs: { 'aria-expanded': String(open) }, setAttribute(name, value) { this.attrs[name] = value; } };
  const body = { hidden: !open };
  const card = {
    dataset: { foldKey: key },
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
    },
    querySelector: (selector) => (selector.includes('[data-fold-toggle]') ? toggle : selector.includes('__body') ? body : null),
  };
  toggle.closest = (selector) => (selector === '[data-fold-toggle]' ? toggle : selector === '[data-fold-key]' ? card : null);
  return { card, toggle, body };
}

function fakeRoot(cards, extra = []) {
  let handler;
  const nodes = new Set([...cards.map((c) => c.toggle), ...extra]);
  return {
    dataset: {},
    addEventListener: (type, fn) => { assert.equal(type, 'click'); handler = fn; },
    contains: (node) => nodes.has(node),
    querySelectorAll: () => cards.map((c) => c.card),
    click: (target) => handler({ target }),
  };
}

test('默认收起，展开状态按 key 记住，标记里带对应的 aria 和 hidden', () => {
  installStorage({ [STORAGE_KEY]: JSON.stringify(['astrbot:open_one']) });
  assert.equal(isPluginExpanded('astrbot:open_one'), true);
  assert.equal(isPluginExpanded('dsh:other'), false);

  const closed = foldCard({ key: 'dsh:other', title: '标题', body: '<p>内容</p>' });
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /class="plugin-fold__body" id="plugin-fold-dsh_other" hidden>/);
  assert.doesNotMatch(closed, /is-open/);

  const open = foldCard({ key: 'astrbot:open_one', title: 'T', version: 'v1', description: 'D', body: 'B', control: '<input>' });
  assert.match(open, /plugin-fold is-open/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<span class="chip chip--tiny">v1<\/span>/);
  assert.match(open, /plugin-fold__desc">D</);
  assert.doesNotMatch(open, / hidden>/);
});

test('key 和附加属性会被转义，id 只保留安全字符', () => {
  installStorage();
  const html = foldCard({ key: 'astrbot:a"b<c>.d', title: 'T', body: '', attrs: { 'data-plugin-id': 'x"><script>' } });
  assert.match(html, /data-fold-key="astrbot:a&#34;b&#60;c&#62;.d"/);
  assert.match(html, /data-plugin-id="x&#34;&#62;&#60;script&#62;"/);
  assert.match(html, /id="plugin-fold-astrbot_a_b_c__d"/);
  assert.doesNotMatch(html, /<script>/);
});

test('点击切换单张卡片并写回存储；全部展开 / 全部收起', () => {
  const data = installStorage();
  const a = fakeCard('astrbot:a', false);
  const b = fakeCard('dsh:b', false);
  const openAll = { dataset: { foldAll: 'open' }, closest: (s) => (s === '[data-fold-all]' ? openAll : null) };
  const closeAll = { dataset: { foldAll: 'close' }, closest: (s) => (s === '[data-fold-all]' ? closeAll : null) };
  const root = fakeRoot([a, b], [openAll, closeAll]);
  globalThis.Element = Object;
  bindPluginFold(root);
  bindPluginFold(root); // 重复绑定不生效

  root.click(a.toggle);
  assert.equal(a.card.classList.contains('is-open'), true);
  assert.equal(a.toggle.attrs['aria-expanded'], 'true');
  assert.equal(a.body.hidden, false);
  assert.deepEqual(JSON.parse(data.get(STORAGE_KEY)), ['astrbot:a']);

  root.click(a.toggle);
  assert.equal(a.body.hidden, true);
  assert.deepEqual(JSON.parse(data.get(STORAGE_KEY)), []);

  root.click(openAll);
  assert.equal(a.body.hidden, false);
  assert.equal(b.body.hidden, false);
  assert.deepEqual(JSON.parse(data.get(STORAGE_KEY)).sort(), ['astrbot:a', 'dsh:b']);

  root.click(closeAll);
  assert.equal(a.body.hidden, true);
  assert.equal(b.body.hidden, true);
  assert.deepEqual(JSON.parse(data.get(STORAGE_KEY)), []);
});

test('存储不可用或内容损坏时退回内存状态，不抛错', () => {
  installStorage({ [STORAGE_KEY]: '{not json' });
  assert.equal(isPluginExpanded('astrbot:x'), false);
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  const a = fakeCard('astrbot:x', false);
  const root = fakeRoot([a]);
  bindPluginFold(root);
  root.click(a.toggle);
  assert.equal(a.body.hidden, false);
  assert.equal(isPluginExpanded('astrbot:x'), true, '本次页面内仍记得');
});
