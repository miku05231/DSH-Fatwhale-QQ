// Browser half of the QQ-DSH console. The factory runs inside DSH's client
// module loader (Desktop and `dsh web` share that page). It does not iframe
// the standalone 5830 server.
globalThis.window.__ModuleLoader__.load({
  id: 'qq-bridge-companion',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useEffect, useState, useRef } = React;
    const PREFIX = '/qq-bridge';

    function ConsolePage({ view }) {
      const frame = useRef(null);
      const [height, setHeight] = useState(560);

      useEffect(() => {
        if (view === 'summary') return undefined;
        const resize = (event) => {
          if (!frame.current || event.source !== frame.current.contentWindow) return;
          const data = event.data;
          if (!data || data.type !== 'qq-bridge:resize' || typeof data.height !== 'number' ||
              !Number.isFinite(data.height) || data.height < 240 || data.height > 12000) return;
          setHeight(Math.ceil(data.height));
        };
        window.addEventListener('message', resize);
        return () => window.removeEventListener('message', resize);
      }, [view]);

      if (view === 'summary') return '链路状态、人格、模型与表情快捷切换；完整配置在浏览器打开';

      return h('section', { 'data-qq-bridge-console': 'page', style: { minWidth: 0 } },
        h('iframe', {
          ref: frame,
          title: 'QQ-DSH 控制台',
          src: `${PREFIX}/?mode=embed`,
          scrolling: 'no',
          style: { display: 'block', width: '100%', height, minHeight: 240, border: 0, borderRadius: 12 },
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
