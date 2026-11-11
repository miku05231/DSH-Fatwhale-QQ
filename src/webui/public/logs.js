/** A single cancellable poll loop, shared by entry, tab changes and refresh. */
export function createLogView({ api, getName, isActive, getBox, getStatus,
  getAutoFollow, setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date() }) {
  let timer;
  let controller;
  let sequence = 0;
  let displayedName;
  const sources = new Map();

  function sourceState(name) {
    if (!sources.has(name)) sources.set(name, { snapshot: null, cleared: false, visible: [] });
    return sources.get(name);
  }

  function appended(previous, next) {
    const lines = next.lines || [];
    if (!previous || previous.file !== next.file || previous.source !== next.source) return lines;
    if (!previous.truncated && !next.truncated && Number.isInteger(previous.total)
      && Number.isInteger(next.total) && next.total >= previous.total) {
      const count = next.total - previous.total;
      return count ? lines.slice(-count) : [];
    }
    const before = previous.lines || [];
    for (let overlap = Math.min(before.length, lines.length); overlap > 0; overlap -= 1) {
      if (before.slice(-overlap).every((line, i) => line === lines[i])) return lines.slice(overlap);
    }
    return lines;
  }

  function stop() {
    sequence += 1;
    clearTimer(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }

  async function refresh() {
    stop();
    if (!isActive()) return;
    const box = getBox();
    if (!box) return;
    const name = getName();
    const id = sequence;
    const request = new AbortController();
    controller = request;
    const changed = displayedName !== name;
    if (changed) {
      box.textContent = '加载中…';
      const status = getStatus();
      if (status) status.textContent = '正在读取日志…';
    }
    const current = () => id === sequence && getName() === name && isActive();
    try {
      const data = await api(`/api/logs?name=${encodeURIComponent(name)}&lines=240`, {
        signal: request.signal, cache: 'no-store',
      });
      if (!current()) return;
      displayedName = name;
      const state = sourceState(name);
      const autoFollow = getAutoFollow?.();
      const follow = typeof autoFollow === 'boolean' ? autoFollow
        : changed || box.scrollHeight - box.clientHeight - box.scrollTop < 48;
      if (state.cleared) {
        const added = state.snapshot ? appended(state.snapshot, data) : [];
        state.visible = [...state.visible, ...added].slice(-240);
      }
      state.snapshot = { ...data, lines: [...(data.lines || [])] };
      const content = data.missing
        ? (data.message || '尚无日志，请确认对应服务已启动并开启日志。')
        : state.cleared ? state.visible.join('\n')
          : data.lines?.length ? data.lines.join('\n') : (data.message || '日志是空的');
      if (box.textContent !== content) box.textContent = content;
      if (follow) box.scrollTop = box.scrollHeight;
      const status = getStatus();
      const labels = { 'bridge-daily': '桥接运行日志', 'launcher-console': '启动器输出', 'napcat-webui': 'NapCat 实时日志（连接后）' };
      if (status) status.textContent = `${labels[data.source] || '运行日志'} · 本次读取 ${now().toLocaleTimeString()}${data.updatedAt ? ` · 最近更新 ${new Date(data.updatedAt).toLocaleString()}` : ''} · 每 3 秒刷新`;
    } catch (error) {
      if (!current() || request.signal.aborted) return;
      box.textContent = `读取日志失败：${error.message}`;
      const status = getStatus();
      if (status) status.textContent = '本次读取失败，3 秒后重试';
    } finally {
      if (id === sequence) {
        controller = undefined;
        if (isActive()) timer = setTimer(() => { void refresh(); }, 3000);
      }
    }
  }

  async function clearDisplay() {
    stop();
    const state = sourceState(getName());
    state.cleared = true;
    state.visible = [];
    const box = getBox();
    if (box) box.textContent = '';
    if (isActive()) await refresh();
  }

  function getText() { return getBox()?.textContent || ''; }

  async function copy(writeText) {
    const write = writeText ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
    if (typeof write !== 'function') throw new Error('当前环境无法复制，请手动选择日志');
    await write(getText());
  }

  return { refresh, stop, clearDisplay, getText, copy };
}
