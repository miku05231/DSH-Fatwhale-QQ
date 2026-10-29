const STATUS = {
  created: '准备中', submitting: '正在提交', queued: '排队中', running: '生成中', paused: '等待已暂停',
  unknown: '提交结果待确认', completed: '已完成', failed: '失败', cancelled: '已取消', released: '已解除占用',
};
const BUSY = new Set(['created', 'submitting', 'queued', 'running', 'paused', 'unknown']);
const ACTIVE = new Set(['created', 'submitting', 'queued', 'running']);

export function initImagegen({ api, notify, confirm }) {
  const $ = (id) => document.getElementById(id);
  let token = '';
  let loaded = false;
  let selected = false;
  let loading = false;
  let submitting = false;
  let jobs = [];
  let providers = {};
  let settings = {};
  const previews = new Map();

  const call = (url, options = {}) => api(`/api/imagegen${url}`, {
    ...options, headers: { 'Content-Type': 'application/json', 'X-QQ-Imagegen-Token': token },
  });
  const hint = (value) => { $('imagegenHint').textContent = value; };

  function settingsDirty() {
    return $('imagegenProvider').value !== settings.provider || $('imagegenBaseUrl').value.trim() !== settings.baseUrl ||
      $('imagegenModel').value.trim() !== settings.model || $('imagegenEnabled').checked !== settings.enabled ||
      Boolean($('imagegenApiKey').value) || $('imagegenNoKey').checked === Boolean(settings.hasApiKey);
  }

  function clearKey() {
    $('imagegenApiKey').value = '';
    $('imagegenApiKey').placeholder = '留空表示不鉴权';
    $('imagegenNoKey').checked = true;
  }

  function platformFields() {
    const provider = $('imagegenProvider').value;
    $('imagegenModelField').hidden = provider === 'comfyui';
    const advanced = ['comfyui', 'siliconflow'].includes(provider);
    for (const name of ['Seed', 'Steps', 'Cfg']) {
      $(`imagegen${name}Field`).hidden = !advanced;
      $(`imagegen${name}`).disabled = !advanced;
    }
    const model = $('imagegenModel').value;
    const dimensions = provider === 'openai'
      ? model === 'dall-e-3' ? [[1024, 1024], [1792, 1024], [1024, 1792]] : [[1024, 1024], [1536, 1024], [1024, 1536]]
      : [[1024, 1024], [1344, 768], [768, 1344]];
    [...$('imagegenPreset').options].forEach((option, index) => {
      option.textContent = `${['方图', '横图', '竖图'][index]} ${dimensions[index].join(' × ')}`;
      option.disabled = provider === 'openai' && model === 'dall-e-2' && index !== 0;
    });
    if ($('imagegenPreset').selectedOptions[0]?.disabled) $('imagegenPreset').value = 'square';
  }

  function applySettings(value) {
    settings = value;
    $('imagegenEnabled').checked = value.enabled;
    $('imagegenProvider').value = value.provider;
    $('imagegenBaseUrl').value = value.baseUrl;
    $('imagegenModel').value = value.model;
    clearKey();
    $('imagegenNoKey').checked = !value.hasApiKey;
    if (value.hasApiKey) $('imagegenApiKey').placeholder = '已保存；留空保留原密钥';
    platformFields();
  }

  function select(generate) {
    selected = generate;
    $('imagegenView').hidden = !generate;
    $('stickerLibraryView').hidden = generate;
    for (const [id, active] of [['imagegenTab', generate], ['stickerLibraryTab', !generate]]) {
      $(id).classList.toggle('is-active', active);
      $(id).setAttribute('aria-selected', String(active));
      $(id).tabIndex = active ? 0 : -1;
    }
    if (generate) void load().catch((error) => notify(error.message));
  }

  async function preview(job, img, link) {
    try {
      let url = previews.get(job.id);
      if (!url) {
        const response = await fetch(`/api/imagegen/jobs/${job.id}/image`, { headers: { 'X-QQ-Imagegen-Token': token } });
        if (!response.ok) throw new Error('图片预览加载失败');
        url = URL.createObjectURL(await response.blob());
        previews.set(job.id, url);
      }
      img.src = url;
      link.href = url;
    } catch { img.alt = '图片暂不可用'; }
  }

  function render() {
    const baseUrl = String(settings.baseUrl ?? '').replace(/\/$/, '');
    $('imagegenGenerate').disabled = submitting || settingsDirty() ||
      jobs.some((job) => job.baseUrl === baseUrl && BUSY.has(job.status)) || !settings.enabled;
    const container = $('imagegenJobs');
    container.replaceChildren();
    if (!jobs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有生成任务';
      container.append(empty);
    }
    for (const job of jobs) {
      const row = document.createElement('article');
      row.className = 'imagegen-job';
      row.dataset.jobId = job.id;
      const info = document.createElement('div');
      info.className = 'imagegen-job-info';
      const status = document.createElement('strong');
      status.textContent = `${STATUS[job.status] ?? job.status} · ${job.mode === 'sticker' ? '表情包' : '图片'} · ${providers[job.provider]?.label ?? job.provider}`;
      const prompt = document.createElement('p');
      prompt.className = 'imagegen-job-prompt';
      prompt.textContent = job.prompt;
      const detail = document.createElement('p');
      detail.className = 'card__hint';
      detail.textContent = [new Date(job.createdAt).toLocaleString(), job.seed ? `种子 ${job.seed}` : '',
        job.sticker ? '已入表情库' : '', job.delivery?.state === 'skipped' ? '本次未命中表情发送概率' : '',
        ['sending', 'unknown'].includes(job.delivery?.state) ? 'QQ 交付结果待确认' : '', job.error || ''].filter(Boolean).join(' · ');
      info.append(status, prompt, detail);
      row.append(info);
      if (job.status === 'completed' && job.artifact) {
        const link = document.createElement('a');
        link.className = 'imagegen-preview';
        link.download = `imagegen-${job.id}.${job.artifact.file.split('.').at(-1)}`;
        link.title = '下载图片';
        const img = document.createElement('img');
        img.alt = job.prompt.slice(0, 100);
        img.width = job.artifact.width;
        img.height = job.artifact.height;
        link.append(img);
        row.prepend(link);
        void preview(job, img, link);
      }
      if (['created', 'paused', 'unknown'].includes(job.status)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--tonal';
        button.textContent = job.status === 'created' ? '取消准备' : job.status === 'paused' ? '继续等待' : '解除占用';
        button.addEventListener('click', () => void act(button, async () => {
          if (job.status === 'unknown' && !await confirm('解除生图占用？', '请先到生图服务确认该任务已经结束。解除后不会重新提交或取消远端任务。', { okText: '已确认，解除' })) return;
          await call(`/jobs/${job.id}/${job.status === 'unknown' ? 'release' : 'resume'}`, {
            method: 'POST', body: JSON.stringify(job.status === 'unknown' ? { confirmed: true } : {}),
          });
          await refresh();
        }));
        info.append(button);
      }
      container.append(row);
    }
    const visible = new Set(jobs.map((job) => job.id));
    for (const [id, url] of previews) if (!visible.has(id)) { URL.revokeObjectURL(url); previews.delete(id); }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const result = await call('/jobs');
      jobs = result.jobs;
      render();
      const current = jobs[0];
      if (current) hint(`${STATUS[current.status] ?? current.status}${current.error ? `：${current.error}` : ''}`);
    } finally { loading = false; }
  }

  async function load() {
    if (!loaded) {
      const result = await api('/api/imagegen');
      token = result.imagegenToken;
      providers = result.providers;
      $('imagegenProvider').replaceChildren(...Object.entries(providers).map(([value, p]) => new Option(p.label, value)));
      applySettings(result.settings);
      $('imagegenSettings').open = !result.settings.enabled || !result.settings.baseUrl;
      loaded = true;
    }
    await refresh();
  }

  async function act(button, fn) {
    button.disabled = true;
    try { await fn(); }
    catch (error) { hint(error.message); notify(error.message); }
    finally { button.disabled = false; render(); }
  }

  $('imagegenTab').addEventListener('click', () => select(true));
  $('stickerLibraryTab').addEventListener('click', () => select(false));
  for (const id of ['imagegenTab', 'stickerLibraryTab']) $(id).addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); select(!selected); $(selected ? 'imagegenTab' : 'stickerLibraryTab').focus(); }
  });
  $('imagegenSave').addEventListener('click', () => void act($('imagegenSave'), async () => {
    const input = { enabled: $('imagegenEnabled').checked, provider: $('imagegenProvider').value,
      baseUrl: $('imagegenBaseUrl').value.trim(), model: $('imagegenModel').value.trim() };
    if ($('imagegenNoKey').checked) input.apiKey = '';
    else if ($('imagegenApiKey').value.trim()) input.apiKey = $('imagegenApiKey').value.trim();
    const result = await call('/settings', { method: 'PUT', body: JSON.stringify(input) });
    applySettings(result.settings);
    $('imagegenConnection').textContent = '未检测';
    notify('生图设置已保存');
  }));
  $('imagegenProvider').addEventListener('change', () => {
    const preset = providers[$('imagegenProvider').value];
    $('imagegenBaseUrl').value = preset.baseUrl;
    $('imagegenModel').value = preset.model;
    if ($('imagegenProvider').value === settings.provider) {
      $('imagegenBaseUrl').value = settings.baseUrl;
      $('imagegenModel').value = settings.model;
    }
    clearKey();
    platformFields();
    render();
    $('imagegenConnection').textContent = '未检测';
  });
  $('imagegenModel').addEventListener('input', () => { platformFields(); render(); });
  $('imagegenBaseUrl').addEventListener('input', () => { clearKey(); render(); });
  $('imagegenApiKey').addEventListener('input', () => { $('imagegenNoKey').checked = !$('imagegenApiKey').value.trim(); render(); });
  $('imagegenNoKey').addEventListener('change', () => { if ($('imagegenNoKey').checked) clearKey(); render(); });
  $('imagegenEnabled').addEventListener('change', render);
  $('imagegenCheck').addEventListener('click', () => void act($('imagegenCheck'), async () => {
    if (settingsDirty()) throw new Error('请先保存生图服务设置');
    await call('/check', { method: 'POST', body: '{}' });
    $('imagegenConnection').textContent = '已连接';
    notify('生图服务连接正常');
  }));
  $('imagegenRefresh').addEventListener('click', () => void act($('imagegenRefresh'), refresh));
  $('imagegenForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (settingsDirty()) { hint('请先保存生图服务设置'); return; }
    if (submitting) return;
    submitting = true;
    void act($('imagegenGenerate'), async () => {
      try {
        const input = { prompt: $('imagegenPrompt').value, mode: $('imagegenMode').value, preset: $('imagegenPreset').value };
        if ($('imagegenNegative').value) input.negative_prompt = $('imagegenNegative').value;
        if (!$('imagegenSeed').disabled && $('imagegenSeed').value) input.seed = $('imagegenSeed').value;
        for (const [key, id] of [['steps', 'imagegenSteps'], ['cfg', 'imagegenCfg']]) if (!$(id).disabled && $(id).value !== '') input[key] = Number($(id).value);
        if (input.mode === 'sticker' && $('imagegenTags').value.trim()) input.tags = $('imagegenTags').value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
        const created = await call('/jobs', { method: 'POST', body: JSON.stringify(input) });
        jobs = [created, ...jobs.filter((job) => job.id !== created.id)];
        render();
        await refresh();
      } finally { submitting = false; }
    });
  });
  window.setInterval(() => {
    if (selected && loaded && document.visibilityState === 'visible' && $('page-stickers').classList.contains('is-active') && jobs.some((job) => ACTIVE.has(job.status))) {
      void refresh().catch((error) => hint(error.message));
    }
  }, 1500);
  window.addEventListener('pagehide', () => { for (const url of previews.values()) URL.revokeObjectURL(url); previews.clear(); });
  return { load: async () => { if (selected) await load(); } };
}
