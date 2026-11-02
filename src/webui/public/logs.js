/** A single cancellable poll loop, shared by entry, tab changes and refresh. */
export function createLogView({ api, getName, isActive, getBox, getStatus,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date() }) {
  let timer;
  let controller;
  let sequence = 0;
  let displayedName;

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
      const follow = changed || box.scrollHeight - box.clientHeight - box.scrollTop < 48;
      const content = data.missing
        ? (data.message || '尚无日志，请确认对应服务已启动并开启日志。')
        : data.lines?.length ? data.lines.join('\n') : (data.message || '日志是空的');
      if (box.textContent !== content) box.textContent = content;
      if (follow) box.scrollTop = box.scrollHeight;
      const status = getStatus();
      const sources = { 'bridge-daily': '桥接运行日志', 'launcher-console': '启动器输出', 'napcat-webui': 'NapCat 实时日志（连接后）' };
      if (status) status.textContent = `${sources[data.source] || '运行日志'} · 本次读取 ${now().toLocaleTimeString()}${data.updatedAt ? ` · 最近更新 ${new Date(data.updatedAt).toLocaleString()}` : ''} · 每 3 秒刷新`;
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

  return { refresh, stop };
}
