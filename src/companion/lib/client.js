// Browser half of the QQ-DSH console. The factory runs inside DSH's client
// module loader (Desktop and `dsh web` share that page). It does not iframe
// the standalone 5830 server.
globalThis.window.__ModuleLoader__.load({
  id: 'qq-bridge-companion',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;
    const PREFIX = '/qq-bridge';

    async function callBridge(action) {
      const response = await fetch(`${PREFIX}/api/bridge/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const payload = await response.json();
      if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      return payload.data;
    }

    function ConsolePage({ view }) {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      async function refresh() {
        const response = await fetch(`${PREFIX}/api/bridge`, { credentials: 'same-origin' });
        const payload = await response.json();
        if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        setStatus(payload.data);
      }

      useEffect(() => {
        if (view === 'summary') return undefined;
        refresh().catch((cause) => setError(String(cause?.message ?? cause)));
        return undefined;
      }, [view]);

      if (view === 'summary') return '配置、记忆、人格、表情、日志，以及桥接启停';

      async function act(action) {
        setBusy(true);
        setError('');
        try {
          setStatus(await callBridge(action));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }

      const running = status?.running === true;
      const label = !running
        ? '桥接未运行'
        : status.mode === 'embedded'
          ? `进程内运行中（${status.connected ? '已连接 NapCat' : '正在连接 NapCat'}${status.lastError ? `，最近错误：${status.lastError}` : ''}）`
          : `桥接运行中（pid ${status.pid}）`;
      return h('section', { 'data-qq-bridge-console': 'page', style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 640 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('strong', null, 'QQ-DSH 控制台'),
          h('span', null, label),
          h('button', { type: 'button', disabled: busy || running, onClick: () => act('start') }, '启动桥接'),
          h('button', { type: 'button', disabled: busy || !running, onClick: () => act('stop') }, '停止桥接'),
        ),
        error ? h('p', { role: 'alert' }, error) : null,
        h('iframe', {
          title: 'QQ-DSH 控制台',
          src: `${PREFIX}/`,
          style: { flex: 1, width: '100%', minHeight: 560, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 12, background: 'white' },
        }),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'qq-bridge-companion',
        order: 10,
      }, ConsolePage));
    }

    return { apply, inject: ['slots'] };
  },
});
