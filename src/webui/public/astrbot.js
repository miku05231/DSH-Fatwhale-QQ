const BASE = '/api/astrbot';
const GROUP_ID = /^[1-9]\d{0,19}$/;
const PLUGIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const WEATHER_PLUGIN_ID = 'astrbot_plugin_weather';
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const OUTBOUND_GRANT_REASONS = {
  revoked: '授权版本或策略已变化，当前授权失效，需要重新授权。',
  'plugin-changed': '插件配置或版本已变化，需要重新创建授权。',
  invalid: '授权记录无效，需要重新创建授权。',
  unavailable: '暂时无法验证授权状态，请稍后重新读取。',
  'plugin-disabled': '天气插件已停用；启用后会重新检查授权。',
  'runtime-disabled': 'AstrBot 消息入口已关闭；开启后会重新检查授权。',
  'target-blocked': '该目标当前被安全策略阻止。',
  'target-not-authorized': '该群聊目标当前未获准发送天气消息。',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pluginItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.plugins)) return result.plugins;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

function pluginId(plugin) {
  return String(plugin?.id ?? plugin?.pluginId ?? plugin?.name ?? '');
}

function pluginTitle(plugin) {
  return String(plugin?.displayName ?? plugin?.display_name ?? plugin?.metadata?.name ?? plugin?.name ?? pluginId(plugin));
}

function pluginConfig(plugin) {
  for (const value of [plugin?.config, plugin?.configuration, plugin?.configValues, plugin?.config_values]) {
    if (object(value)) return value;
  }
  return {};
}

function schemaOf(plugin) {
  return plugin?.configSchema ?? plugin?.config_schema ?? plugin?.confSchema ?? plugin?.conf_schema ??
    plugin?._conf_schema ?? plugin?.metadata?.configSchema ?? plugin?.metadata?.config_schema ??
    plugin?.metadata?.conf_schema ?? plugin?.metadata?._conf_schema ?? null;
}

function isSecret(field, key) {
  const type = String(field?.type ?? field?.datatype ?? field?.dataType ?? '').toLowerCase();
  return field?.secret === true || field?.sensitive === true || ['secret', 'password', 'passwd'].includes(type) ||
    String(field?.format ?? '').toLowerCase() === 'password' ||
    /secret|password|passwd|credential|authorization|access.?token|refresh.?token|api.?key|private.?key/i.test(key);
}

function schemaEntries(schema) {
  if (Array.isArray(schema)) return schema.map((field) => ({
    key: String(field?.key ?? field?.name ?? field?.id ?? ''), field,
  })).filter((entry) => entry.key);
  if (!object(schema)) return [];
  if (Array.isArray(schema.fields)) return schemaEntries(schema.fields);
  const properties = object(schema.properties) ? schema.properties
    : String(schema.type ?? '').toLowerCase() === 'object' && object(schema.items) ? schema.items : schema;
  return Object.entries(properties).filter(([key]) => !RESERVED.has(key)).map(([key, field]) => ({ key, field }));
}

function fieldType(field, key = '') {
  const type = String(field?.type ?? field?.datatype ?? field?.dataType ?? '').toLowerCase();
  if (field?.properties || field?.schema || field?.children || type === 'object') return 'object';
  if (type === 'bool' || type === 'boolean') return 'boolean';
  if (type === 'int' || type === 'integer' || type === 'float' || type === 'number') return 'number';
  if (Array.isArray(field?.options) || Array.isArray(field?.enum)) return 'select';
  const secret = isSecret(field, key);
  if (['array', 'list', 'dict', 'template_list'].includes(type)) return secret ? 'secret-json' : 'json';
  if (type === 'text') return 'text';
  return secret ? 'secret' : 'string';
}

function getPath(root, keys) {
  let value = root;
  for (const key of keys) value = object(value) ? value[key] : undefined;
  return value;
}

function renderSchema(schema, config, pathParts = []) {
  const entries = schemaEntries(schema);
  if (!entries.length) return '';
  return entries.map(({ key, field }) => {
    const parts = [...pathParts, key];
    const pathValue = JSON.stringify(parts);
    const type = fieldType(field, key);
    const label = String(field?.label ?? field?.title ?? field?.display_name ?? key);
    const description = String(field?.description ?? field?.desc ?? '');
    const value = getPath(config, parts);
    const help = description ? `<small class="card__hint">${escapeHtml(description)}</small>` : '';
    if (type === 'object') {
      const nested = field?.properties ?? field?.schema ?? field?.children ?? field?.items ?? field;
      return `<fieldset class="astrbot-nested"><legend>${escapeHtml(label)}</legend>${renderSchema(nested, config, parts)}</fieldset>`;
    }
    if (type === 'boolean') {
      return `<label class="astrbot-check"><input type="checkbox" data-config-path="${escapeHtml(pathValue)}" ${value === true ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>${help}`;
    }
    if (type === 'select') {
      const options = field.options ?? field.enum ?? [];
      return `<div class="astrbot-field"><label>${escapeHtml(label)}<select class="astrbot-select" data-config-path="${escapeHtml(pathValue)}">${options.map((option) => {
        const optionValue = object(option) ? (option.value ?? option.id ?? option.name) : option;
        const optionLabel = object(option) ? (option.label ?? option.name ?? option.value ?? option.id) : option;
        return `<option value="${escapeHtml(optionValue)}" ${String(optionValue) === String(value ?? '') ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`;
      }).join('')}</select></label>${help}</div>`;
    }
    if (type === 'json' || type === 'secret-json') {
      const secret = type === 'secret-json';
      const current = secret ? (Array.isArray(value) ? value : [])
        : value === undefined ? (field.default ?? (String(field?.type).toLowerCase() === 'template_list' ? [] : {})) : value;
      const hint = secret ? '留空可保留已保存的密钥列表。'
        : String(field?.type).toLowerCase() === 'template_list'
          ? '模板行需保留 __template_key；密钥项留空或保留 *** 会维持已保存值。' : '';
      const placeholder = secret ? '留空以保留已保存的密钥列表' : '';
      return `<div class="astrbot-field"><label>${escapeHtml(label)}<textarea class="astrbot-textarea" data-config-path="${escapeHtml(pathValue)}" data-json-value="true" ${secret ? 'data-secret="true"' : ''} spellcheck="false" placeholder="${escapeHtml(placeholder)}">${escapeHtml(JSON.stringify(current, null, 2))}</textarea></label>${help}${hint ? `<small class="card__hint">${escapeHtml(hint)}</small>` : ''}</div>`;
    }
    if (type === 'text') {
      const shown = value ?? field?.default ?? '';
      return `<div class="astrbot-field"><label>${escapeHtml(label)}<textarea class="astrbot-textarea" data-config-path="${escapeHtml(pathValue)}" spellcheck="false">${escapeHtml(shown)}</textarea></label>${help}</div>`;
    }
    const secret = type === 'secret';
    const inputType = secret ? 'password' : type === 'number' ? 'number' : 'text';
    const shown = secret ? '' : (value ?? field?.default ?? '');
    const placeholder = secret ? '留空则保留现有密钥' : (field?.placeholder ?? '');
    const step = type === 'number' && (fieldType(field) === 'number') ? (field?.step ?? (String(field?.type).toLowerCase() === 'int' ? '1' : 'any')) : undefined;
    return `<div class="astrbot-field"><label>${escapeHtml(label)}<input class="astrbot-input" type="${inputType}" data-config-path="${escapeHtml(pathValue)}" ${secret ? 'data-secret="true" autocomplete="new-password"' : ''} ${step ? `step="${escapeHtml(step)}"` : ''} value="${escapeHtml(shown)}" placeholder="${escapeHtml(placeholder)}"></label>${help}</div>`;
  }).join('');
}

function pluginConfigFields(plugin) {
  const config = pluginConfig(plugin);
  const schema = schemaOf(plugin);
  return schemaEntries(schema).length
    ? renderSchema(schema, config)
    : `<div class="astrbot-field"><label>插件配置 JSON<textarea class="astrbot-textarea" data-config-json spellcheck="false">${escapeHtml(JSON.stringify(config, null, 2))}</textarea></label><small class="card__hint">未提供可识别的配置结构时，使用 JSON 编辑；密钥字段留空或保留 *** 会维持现有值。</small></div>`;
}

function safeJsonTree(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 16 || state.nodes > 10_000) throw new Error('配置 JSON 过大或嵌套过深');
  if (Array.isArray(value)) {
    for (const item of value) safeJsonTree(item, depth + 1, state);
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (RESERVED.has(key)) throw new Error('配置 JSON 含非法字段');
      safeJsonTree(item, depth + 1, state);
    }
  }
}

function setPath(root, keys, value) {
  let target = root;
  for (const key of keys.slice(0, -1)) {
    if (!object(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function statusText(runtime) {
  const candidate = runtime?.runtime ?? runtime?.process ?? runtime;
  const raw = candidate?.state ?? candidate?.status ?? candidate?.phase ?? candidate?.runtimeStatus ?? candidate?.runtime_status;
  if (typeof raw === 'string') return raw;
  if (candidate?.running === true) return '运行中';
  if (candidate?.running === false) return '已停止';
  return '状态未知';
}

function isTerminal(job) {
  const state = String(job?.status ?? job?.state ?? job?.phase ?? '').toLowerCase();
  return Boolean(job?.done) || ['success', 'succeeded', 'complete', 'completed', 'failed', 'error', 'cancelled', 'canceled'].includes(state);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function initAstrbot({ notify = () => {}, confirm = async () => window.confirm('确定继续？') } = {}) {
  const root = document.querySelector('#astrbotPanel');
  if (!root) return { async load() {} };
  const state = {
    token: '', runtime: null, plugins: [], policy: { enabled: false, groups: {} },
    outboundGrants: [], outboundGrantError: '',
    polls: new Map(), pollCallbacks: new Map(), configurePending: new Set(),
  };

  async function request(path, { method = 'GET', payload } = {}) {
    const headers = {};
    const options = { method, credentials: 'same-origin', cache: 'no-store', headers };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['X-QQ-Astrbot-Token'] = state.token;
      options.body = JSON.stringify(payload ?? {});
    }
    const response = await fetch(`${globalThis.__QQ_BRIDGE_BASE__ || ''}${path}`, options);
    let envelope;
    try { envelope = await response.json(); }
    catch { throw new Error(`服务端返回了非 JSON（HTTP ${response.status}）`); }
    if (!envelope?.ok) throw new Error(envelope?.error || `请求失败（HTTP ${response.status}）`);
    return envelope.data;
  }

  function renderUnavailable(message) {
    if (state.polls.size > 0) return;
    root.innerHTML = `<section class="card card--pad"><h2 class="card__title">AstrBot</h2><p class="card__hint">${escapeHtml(message)}</p><button class="btn btn--text ripple" type="button" data-action="reload">重新读取</button></section>`;
  }

  function renderRuntime() {
    const status = statusText(state.runtime);
    return `<section class="card card--pad">
      <div class="row-between"><div><h2 class="card__title">AstrBot 管理</h2><p class="card__sub">AstrBot 运行时与 AstrBot Python 插件；与本页下方的 DSH 插件分开管理。</p></div>
        <label class="switch-row"><span class="switch-row__text">允许消息进入 AstrBot 插件</span><input class="switch" type="checkbox" data-action="runtime-enabled" ${state.policy.enabled ? 'checked' : ''}></label>
      </div>
      <div class="astrbot-meta"><span>运行状态：${escapeHtml(status)}</span>${state.runtime?.version ? `<span>版本：${escapeHtml(state.runtime.version)}</span>` : ''}${state.runtime?.runtimeVersion ? `<span>运行时：${escapeHtml(state.runtime.runtimeVersion)}</span>` : ''}</div>
      <p class="card__hint">私聊仍只允许现有管理员准入；群聊还受控制台原有群聊放行策略约束。这里的群插件名单不会修改 DSH 的群成员白名单。</p>
      <div class="astrbot-actions"><button class="btn btn--text ripple" type="button" data-action="runtime" data-value="start">启动</button><button class="btn btn--text ripple" type="button" data-action="runtime" data-value="stop">停止</button><button class="btn btn--text ripple" type="button" data-action="runtime" data-value="restart">重启</button></div>
      <div data-runtime-job></div>
    </section>`;
  }

  function renderInstall() {
    return `<section class="card card--pad">
      <div class="card__head"><h2 class="card__title">安装 AstrBot 插件</h2><p class="card__sub">从 GitHub 仓库安装，或上传不超过 16 MiB 的 ZIP。</p></div>
      <form data-action="install" class="astrbot-grid">
        <div class="astrbot-field"><label>GitHub 仓库<input class="astrbot-input" name="source" placeholder="owner/repository 或 GitHub URL"></label></div>
        <div class="astrbot-field"><label>分支或版本（可选）<input class="astrbot-input" name="ref" maxlength="200" placeholder="main、tag 或 commit"></label></div>
        <div class="astrbot-field"><label>ZIP 文件（可选）<input class="astrbot-input" name="zip" type="file" accept=".zip,application/zip"></label></div>
        <div class="astrbot-actions"><button class="btn btn--filled ripple" type="submit">开始安装</button></div>
      </form>
      <div data-job-area></div>
    </section>`;
  }

  function renderPlugins() {
    if (!state.plugins.length) return `<section class="card card--pad"><h2 class="card__title">已安装 AstrBot 插件</h2><p class="card__hint">当前没有已安装插件。</p></section>`;
    return state.plugins.map((plugin) => {
      const id = pluginId(plugin);
      if (!PLUGIN_ID.test(id) || RESERVED.has(id)) return '';
      const fields = pluginConfigFields(plugin);
      const version = plugin?.version ?? plugin?.metadata?.version ?? '未知';
      const versionLabel = `v${String(version).replace(/^v+/i, '')}`;
      const source = plugin?.source ?? plugin?.repo ?? plugin?.repository ?? plugin?.url ?? '';
      const sourceRef = String(plugin?.ref ?? plugin?.commit ?? '').trim();
      const shortSourceRef = sourceRef.length > 12 ? `${sourceRef.slice(0, 12)}…` : sourceRef;
      const compatibility = plugin?.compatibility ?? plugin?.compatibilityStatus ?? plugin?.compatibility_status ?? plugin?.compatibilityMessage ?? '';
      const compatibilityText = compatibility === '' || compatibility === null || compatibility === undefined
        ? '未验证（管理器未提供插件级兼容性状态）'
        : typeof compatibility === 'string' ? compatibility : JSON.stringify(compatibility);
      const description = plugin?.description ?? plugin?.metadata?.description ?? '';
      const enabled = plugin?.enabled === true;
      const canUpdate = Boolean(String(source).trim()) && !['zip-upload', 'upload.zip'].includes(String(source).trim());
      return `<section class="card card--pad astrbot-plugin" data-plugin-id="${escapeHtml(id)}">
        <div class="row-between"><div><h3 class="card__title">${escapeHtml(pluginTitle(plugin))} <span class="chip chip--tiny">${escapeHtml(versionLabel)}</span></h3><p class="card__sub">${escapeHtml(description)}</p></div>
          <label class="switch-row switch-row--tight"><span class="switch-row__text">启用</span><input class="switch" type="checkbox" data-action="plugin-enabled" ${enabled ? 'checked' : ''}></label>
        </div>
        <div class="astrbot-meta"><span>ID：<code>${escapeHtml(id)}</code></span>${source ? `<span>来源：${escapeHtml(source)}</span>` : ''}${sourceRef ? `<span>安装引用：<code title="${escapeHtml(sourceRef)}">${escapeHtml(shortSourceRef)}</code></span>` : ''}<span>兼容性：${escapeHtml(compatibilityText)}</span></div>
        <div class="astrbot-grid" data-config-fields>${fields}</div>
        <div class="astrbot-actions"><button class="btn btn--text ripple" type="button" data-action="plugin-save">保存配置</button><button class="btn btn--text ripple" type="button" data-action="update" ${canUpdate ? '' : 'disabled title="插件没有可用的 GitHub 更新来源"'}>更新</button><button class="btn btn--text ripple" type="button" data-action="rollback">回滚版本</button><button class="btn btn--text ripple" type="button" data-action="uninstall">卸载</button><label class="astrbot-check"><input type="checkbox" data-purge><span>同时删除插件数据</span></label></div>
        <div data-plugin-job></div>
      </section>`;
    }).join('');
  }

  function renderGroups() {
    const entries = object(state.policy?.groups) ? Object.entries(state.policy.groups).sort(([a], [b]) => a.localeCompare(b)) : [];
    const chips = entries.map(([id, value]) => `<button class="btn btn--text ripple" type="button" data-action="select-group" data-group-id="${escapeHtml(id)}">群 ${escapeHtml(id)} · ${escapeHtml(value.chatMode)}</button>`).join('');
    const choices = state.plugins.map((plugin) => {
      const id = pluginId(plugin);
      if (!PLUGIN_ID.test(id) || RESERVED.has(id)) return '';
      return `<label class="astrbot-check"><input type="checkbox" data-group-plugin value="${escapeHtml(id)}"><span>${escapeHtml(pluginTitle(plugin))} <code>${escapeHtml(id)}</code></span></label>`;
    }).join('');
    return `<section class="card card--pad"><div class="card__head"><h2 class="card__title">群聊插件策略</h2><p class="card__sub">每个群单独选择 AstrBot 插件和聊天模式。私聊没有单独策略入口，继续使用现有管理员规则。</p></div>
      <div class="chips">${chips || '<span class="card__hint">还没有单独配置的群聊。</span>'}</div>
      <div class="astrbot-grid"><div class="astrbot-field"><label>群号<input class="astrbot-input" inputmode="numeric" maxlength="20" data-group-id placeholder="输入正整数群号"></label></div>
        <div class="astrbot-field"><label for="astrbot-chat-mode">聊天模式</label><select id="astrbot-chat-mode" class="astrbot-select" data-chat-mode><option value="dsh">DSH</option><option value="astrbot">AstrBot</option></select></div></div>
      <p class="card__hint">已选插件最多 128 个；插件名单只控制 AstrBot 插件 lane，不会更改 security.allowGroupMembers。</p>
      <div class="astrbot-checklist">${choices || '<span class="card__hint">安装插件后可在这里选择。</span>'}</div>
      <div class="astrbot-actions"><button class="btn btn--text ripple" type="button" data-action="group-clear">清空选择</button><button class="btn btn--text ripple" type="button" data-action="group-delete">删除此群策略</button><button class="btn btn--filled ripple" type="button" data-action="group-save">保存群策略</button></div>
    </section>`;
  }

  function renderOutboundGrants() {
    const weatherPlugin = state.plugins.find((plugin) => pluginId(plugin) === WEATHER_PLUGIN_ID);
    const grants = state.outboundGrants.map((grant) => {
      const id = String(grant?.id ?? '');
      const targetKind = grant?.target?.kind === 'private' ? '私聊' : grant?.target?.kind === 'group' ? '群聊' : '未知目标';
      const targetId = String(grant?.target?.id ?? '');
      const revoked = Boolean(grant?.revokedAt);
      const active = !revoked && grant?.active === true;
      const reason = String(grant?.reason ?? '').trim();
      const stale = !revoked && !active && ['revoked', 'plugin-changed', 'invalid'].includes(reason);
      const status = revoked ? '已撤销' : active ? '有效' : stale ? '已失效，需重新授权' : '暂不可用';
      const inactiveReason = reason ? (revoked && reason === 'revoked' ? '授权已由管理员撤销。'
        : Object.hasOwn(OUTBOUND_GRANT_REASONS, reason) ? OUTBOUND_GRANT_REASONS[reason] : reason)
        : (!active ? '授权状态无效或尚未验证，请重新读取后确认。' : '');
      const mayRevoke = !revoked && /^[A-Za-z0-9_-]{1,128}$/.test(id);
      return `<article class="card card--pad astrbot-grant" data-grant-id="${escapeHtml(id)}">
        <div class="row-between"><div><strong>${escapeHtml(status)}</strong><span class="card__hint">${escapeHtml(targetKind)}目标：<code>${escapeHtml(targetId)}</code></span></div>
          ${mayRevoke ? `<button class="btn btn--text ripple" type="button" data-action="outbound-revoke" data-grant-id="${escapeHtml(id)}">撤销授权</button>` : ''}</div>
        <div class="astrbot-meta"><span>用途：${escapeHtml(grant?.purpose ?? 'weather.daily')}</span><span>插件：${escapeHtml(pluginTitle(weatherPlugin) || WEATHER_PLUGIN_ID)}</span>${grant?.createdAt ? `<span>创建：${escapeHtml(grant.createdAt)}</span>` : ''}${grant?.revokedAt ? `<span>撤销：${escapeHtml(grant.revokedAt)}</span>` : ''}</div>
        ${inactiveReason ? `<p class="card__hint">原因：${escapeHtml(inactiveReason)}</p>` : ''}
      </article>`;
    }).join('');
    const createForm = !weatherPlugin ? '<p class="card__hint">仅安装已知天气插件后，才能为明确的私聊或群聊目标创建授权。</p>'
      : weatherPlugin.enabled !== true ? '<p class="card__hint">请先启用已安装的天气插件，再创建发送授权。</p>'
        : `<form data-action="outbound-grant-create" class="astrbot-grid">
      <div class="astrbot-field"><label>目标类型<select class="astrbot-select" name="kind"><option value="private">私聊</option><option value="group">群聊</option></select></label></div>
      <div class="astrbot-field"><label>私聊账号或群号<input class="astrbot-input" name="targetId" type="text" inputmode="numeric" maxlength="20" pattern="[1-9][0-9]{0,19}" placeholder="输入明确的目标 ID" required></label></div>
      <div class="astrbot-actions"><button class="btn btn--filled ripple" type="submit">创建每日天气发送授权</button></div>
    </form>`;
    return `<section class="card card--pad" data-outbound-grant-panel><div class="card__head"><h2 class="card__title">每日天气发送授权</h2>
      <p class="card__sub">仅允许 <code>${WEATHER_PLUGIN_ID}</code> 按 weather.daily 用途向指定目标发送消息。此授权只允许发送，不授予管理员、工具调用或模型能力。</p></div>
      <p class="card__hint">修改插件配置或版本后需要重新创建授权；撤销记录会保留，回滚不会恢复已撤销的授权。</p>
      ${state.outboundGrantError ? `<p class="card__hint">授权列表读取失败：${escapeHtml(state.outboundGrantError)}。请重新读取后再操作。</p><button class="btn btn--text ripple" type="button" data-action="reload">重新读取</button>` : ''}
      <div class="astrbot-panel">${grants || (!state.outboundGrantError ? '<p class="card__hint">当前没有已保存的发送授权。</p>' : '')}</div>
      ${state.outboundGrantError ? '' : createForm}
    </section>`;
  }

  function render() {
    if (state.polls.size > 0) return;
    root.innerHTML = `<div class="astrbot-panel">${renderRuntime()}${renderInstall()}<section class="astrbot-panel">${renderPlugins()}</section>${renderGroups()}${renderOutboundGrants()}</div>`;
  }

  function renderOutboundGrantPanel() {
    const panel = root.querySelector('[data-outbound-grant-panel]');
    if (panel) panel.outerHTML = renderOutboundGrants();
  }

  function setConfigurePending(card, id, pending) {
    if (pending) state.configurePending.add(id);
    else state.configurePending.delete(id);
    for (const control of card?.querySelectorAll('[data-action="plugin-save"], [data-action="plugin-enabled"]') ?? []) {
      control.disabled = pending;
    }
  }

  async function refreshPluginCard(id, card, job, failed) {
    let plugin = null;
    if (!failed && object(job?.result) && pluginId(job.result) === id) {
      plugin = job.result;
      state.plugins = state.plugins.map((item) => pluginId(item) === id ? plugin : item);
    } else {
      try {
        state.plugins = pluginItems(await request(`${BASE}/plugins`));
      } catch { /* restore from the last known state below */ }
      plugin = state.plugins.find((item) => pluginId(item) === id) ?? null;
    }
    if (plugin && card?.isConnected) {
      const fields = card.querySelector('[data-config-fields]');
      if (fields) fields.innerHTML = pluginConfigFields(plugin);
      const enabled = card.querySelector('[data-action="plugin-enabled"]');
      if (enabled) enabled.checked = plugin.enabled === true;
    }
    setConfigurePending(card, id, false);
  }

  async function load() {
    try {
      const runtime = await request(`${BASE}/runtime`);
      if (!runtime?.csrfToken || typeof runtime.csrfToken !== 'string') throw new Error('AstrBot 控制台令牌无效，请刷新页面');
      state.token = runtime.csrfToken;
      state.runtime = runtime;
      const [plugins, policy] = await Promise.all([request(`${BASE}/plugins`), request(`${BASE}/groups`)]);
      state.plugins = pluginItems(plugins);
      state.policy = object(policy) ? policy : { enabled: false, groups: {} };
      await loadOutboundGrants();
      render();
    } catch (error) {
      renderUnavailable(error.message);
    }
  }

  async function loadOutboundGrants() {
    state.outboundGrantError = '';
    try {
      const grants = await request(`${BASE}/outbound-grants`);
      state.outboundGrants = Array.isArray(grants) ? grants : [];
    } catch (error) {
      state.outboundGrants = [];
      state.outboundGrantError = error.message;
    }
  }

  async function pollJob(id, area, { label = 'AstrBot 插件安装', timeoutMs = 30 * 60 * 1000, onTerminal } = {}) {
    if (!area) return;
    if (typeof onTerminal === 'function') state.pollCallbacks.set(id, onTerminal);
    const terminalHandler = state.pollCallbacks.get(id);
    const version = Symbol(id);
    state.polls.set(id, version);
    const active = () => state.polls.get(id) === version;
    const retry = `<button class="btn btn--text ripple" type="button" data-action="job-retry" data-job-id="${escapeHtml(id)}" data-job-label="${escapeHtml(label)}" data-timeout-ms="${timeoutMs}">继续查看任务</button>`;
    for (const existing of area.querySelectorAll('[data-astrbot-job-id]')) {
      if (existing.dataset.astrbotJobId === id) existing.remove();
    }
    const jobArea = document.createElement('div');
    jobArea.dataset.astrbotJobId = id;
    jobArea.className = 'astrbot-job';
    area.appendChild(jobArea);
    jobArea.innerHTML = `<p class="card__hint">任务 ${escapeHtml(id)}：正在排队…</p><progress></progress>`;
    const deadline = Date.now() + timeoutMs;
    let first = true;
    while (Date.now() < deadline && active()) {
      if (!first) await new Promise((resolve) => window.setTimeout(resolve, 1000));
      first = false;
      try {
        const job = await request(`${BASE}/jobs/${encodeURIComponent(id)}`);
        if (!active()) return;
        const progress = Number(job?.progress?.percent ?? job?.progress ?? job?.percent);
        const pct = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
        const message = job?.message ?? job?.detail ?? job?.statusText ?? job?.status ?? job?.state ?? '处理中';
        jobArea.innerHTML = `<p class="card__hint">任务 ${escapeHtml(id)}：${escapeHtml(message)}</p>${pct === null ? '<progress></progress>' : `<progress max="100" value="${pct}"></progress>`}`;
        if (isTerminal(job)) {
          const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(job?.status ?? job?.state ?? '').toLowerCase());
          notify(`${label}${failed ? '失败' : '已完成'}`);
          if (terminalHandler) {
            try { await terminalHandler(job, { failed }); } catch { /* status refresh is best effort */ }
          }
          state.pollCallbacks.delete(id);
          state.polls.delete(id);
          if (state.polls.size === 0) await load();
          return;
        }
      } catch (error) {
        jobArea.innerHTML = `<p class="card__hint">任务状态读取失败：${escapeHtml(error.message)}</p>${retry}`;
        return;
      }
    }
    if (active()) jobArea.innerHTML = `<p class="card__hint">任务 ${escapeHtml(id)} 仍在运行；可以继续查看。</p>${retry}`;
  }

  function selectedGroup(id) {
    const group = state.policy?.groups?.[id];
    root.querySelector('[data-group-id]:not(button)').value = id;
    root.querySelector('[data-chat-mode]').value = group?.chatMode === 'astrbot' ? 'astrbot' : 'dsh';
    const selected = new Set(Array.isArray(group?.pluginIds) ? group.pluginIds : []);
    root.querySelectorAll('[data-group-plugin]').forEach((input) => { input.checked = selected.has(input.value); });
  }

  function readPluginConfig(card) {
    const fallback = card.querySelector('[data-config-json]');
    if (fallback) {
      let parsed;
      try { parsed = JSON.parse(fallback.value); }
      catch { throw new Error('插件配置不是有效 JSON'); }
      if (!object(parsed)) throw new Error('插件配置 JSON 顶层必须是对象');
      safeJsonTree(parsed);
      return parsed;
    }
    const result = {};
    for (const input of card.querySelectorAll('[data-config-path]')) {
      const keys = JSON.parse(input.dataset.configPath);
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || RESERVED.has(key))) throw new Error('配置字段路径无效');
      if (input.dataset.secret === 'true' && !input.value.trim()) continue;
      let value;
      if (input.dataset.jsonValue === 'true') {
        try { value = JSON.parse(input.value); } catch { throw new Error(`「${keys.join('.')}」不是有效 JSON`); }
        safeJsonTree(value);
      } else if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'number') {
        if (input.value.trim() === '') continue;
        value = Number(input.value);
        if (!Number.isFinite(value)) throw new Error(`「${keys.join('.')}」不是有效数字`);
      } else value = input.value;
      setPath(result, keys, value);
    }
    return result;
  }

  root.addEventListener('submit', async (event) => {
    if (event.target?.dataset.action !== 'install') return;
    event.preventDefault();
    const form = event.target;
    const source = form.elements.source.value.trim();
    const ref = form.elements.ref.value.trim();
    const file = form.elements.zip.files?.[0];
    if (file && source) { notify('请只选择 GitHub 来源或 ZIP 文件'); return; }
    if (!file && !source) { notify('请填写 GitHub 来源或选择 ZIP 文件'); return; }
    if (file && file.size > 16 * 1024 * 1024) { notify('ZIP 文件不能超过 16 MiB'); return; }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const payload = file
        ? { source: 'upload.zip', zipBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }
        : { source, ...(ref ? { ref } : {}) };
      const result = await request(`${BASE}/install`, { method: 'POST', payload });
      const id = String(result?.id ?? result?.job?.id ?? '');
      if (!id) throw new Error('安装任务没有返回编号');
      form.reset();
      await pollJob(id, root.querySelector('[data-job-area]'));
    } catch (error) { notify(`安装请求失败：${error.message}`, { duration: 5200 }); }
    finally { button.disabled = false; }
  });

  root.addEventListener('submit', async (event) => {
    if (event.target?.dataset.action !== 'outbound-grant-create') return;
    event.preventDefault();
    const form = event.target;
    const targetId = String(form.elements.targetId.value ?? '').trim();
    const kind = form.elements.kind.value;
    if (!['private', 'group'].includes(kind) || !GROUP_ID.test(targetId)) {
      notify('请输入有效的私聊账号或群号');
      return;
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await request(`${BASE}/outbound-grants`, {
        method: 'POST',
        payload: { pluginId: WEATHER_PLUGIN_ID, purpose: 'weather.daily', target: { kind, id: targetId } },
      });
      form.reset();
      notify('每日天气发送授权已创建');
      await loadOutboundGrants();
      renderOutboundGrantPanel();
    } catch (error) { notify(`创建发送授权失败：${error.message}`, { duration: 5200 }); }
    finally { button.disabled = false; }
  });

  root.addEventListener('change', async (event) => {
    const node = event.target;
    if (node?.dataset.action === 'runtime-enabled') {
      node.disabled = true;
      try {
        state.runtime = await request(`${BASE}/runtime`, { method: 'PUT', payload: { enabled: node.checked } });
        state.policy.enabled = node.checked;
        notify(node.checked ? 'AstrBot 消息入口已开启' : 'AstrBot 消息入口已关闭');
      } catch (error) { notify(`保存失败：${error.message}`); node.checked = !node.checked; }
      finally { node.disabled = false; }
    }
    if (node?.dataset.action === 'plugin-enabled') {
      const card = node.closest('[data-plugin-id]');
      const id = card.dataset.pluginId;
      if (state.configurePending.has(id)) {
        node.checked = state.plugins.find((item) => pluginId(item) === id)?.enabled === true;
        return;
      }
      node.disabled = true;
      setConfigurePending(card, id, true);
      try {
        const result = await request(`${BASE}/plugins/${encodeURIComponent(id)}`, { method: 'PUT', payload: { enabled: node.checked } });
        const jobId = String(result?.id ?? result?.job?.id ?? '');
        if (!jobId) throw new Error('插件设置任务没有返回编号');
        notify('AstrBot 插件设置任务已排队');
        void pollJob(jobId, card.querySelector('[data-plugin-job]'), {
          label: 'AstrBot 插件设置保存',
          onTerminal: (job, { failed }) => refreshPluginCard(id, card, job, failed),
        });
      } catch (error) {
        setConfigurePending(card, id, false);
        node.checked = state.plugins.find((item) => pluginId(item) === id)?.enabled === true;
        notify(`保存失败：${error.message}`);
      } finally {
        if (!state.configurePending.has(id)) node.disabled = false;
      }
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'reload') { await load(); return; }
    if (action === 'outbound-revoke') {
      const id = button.dataset.grantId;
      const grant = state.outboundGrants.find((item) => String(item?.id ?? '') === id);
      if (!grant || grant.revokedAt || !/^[A-Za-z0-9_-]{1,128}$/.test(id || '')) return;
      const kind = grant.target?.kind === 'group' ? '群聊' : '私聊';
      const targetId = String(grant.target?.id ?? '');
      if (!await confirm('撤销每日天气发送授权', `撤销向${kind}目标「${targetId}」发送消息的授权？`)) return;
      button.disabled = true;
      try {
        await request(`${BASE}/outbound-grants/${encodeURIComponent(id)}`, { method: 'DELETE', payload: {} });
        notify('发送授权已撤销');
        await loadOutboundGrants();
        renderOutboundGrantPanel();
      } catch (error) { notify(`撤销发送授权失败：${error.message}`, { duration: 5200 }); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'job-retry') {
      const area = button.closest('[data-job-area], [data-runtime-job], [data-plugin-job]');
      const timeoutMs = Number(button.dataset.timeoutMs) || 30 * 60 * 1000;
      void pollJob(button.dataset.jobId, area, { label: button.dataset.jobLabel || 'AstrBot 操作', timeoutMs });
      return;
    }
    if (action === 'select-group') { selectedGroup(button.dataset.groupId); return; }
    if (action === 'group-clear') {
      root.querySelector('[data-group-id]:not(button)').value = '';
      root.querySelectorAll('[data-group-plugin]').forEach((input) => { input.checked = false; });
      root.querySelector('[data-chat-mode]').value = 'dsh';
      return;
    }
    if (action === 'runtime') {
      button.disabled = true;
      try {
        const result = await request(`${BASE}/runtime`, { method: 'POST', payload: { action: button.dataset.value } });
        if (button.dataset.value === 'start' || button.dataset.value === 'restart') {
          const id = String(result?.id ?? result?.job?.id ?? '');
          if (!id) throw new Error('运行任务没有返回编号');
          notify(`AstrBot ${button.dataset.value === 'start' ? '启动' : '重启'}任务已排队`);
          void pollJob(id, root.querySelector('[data-runtime-job]'), { label: 'AstrBot 运行操作', timeoutMs: 20 * 60 * 1000 });
        } else {
          state.runtime = result;
          notify('AstrBot 已停止');
          await load();
        }
      } catch (error) { notify(`AstrBot 操作失败：${error.message}`); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'plugin-save') {
      const card = button.closest('[data-plugin-id]');
      const id = card.dataset.pluginId;
      if (state.configurePending.has(id)) { notify('此插件仍在保存设置'); return; }
      button.disabled = true;
      try {
        const config = readPluginConfig(card);
        setConfigurePending(card, id, true);
        const result = await request(`${BASE}/plugins/${encodeURIComponent(id)}`, { method: 'PUT', payload: { config } });
        const jobId = String(result?.id ?? result?.job?.id ?? '');
        if (!jobId) throw new Error('插件设置任务没有返回编号');
        notify('AstrBot 插件配置任务已排队');
        void pollJob(jobId, card.querySelector('[data-plugin-job]'), {
          label: 'AstrBot 插件配置保存',
          onTerminal: (job, { failed }) => refreshPluginCard(id, card, job, failed),
        });
      } catch (error) {
        setConfigurePending(card, id, false);
        notify(`保存失败：${error.message}`, { duration: 5200 });
      } finally {
        if (!state.configurePending.has(id)) button.disabled = false;
      }
      return;
    }
    if (action === 'update') {
      const card = button.closest('[data-plugin-id]');
      const id = card.dataset.pluginId;
      const plugin = state.plugins.find((item) => pluginId(item) === id);
      const title = pluginTitle(plugin);
      if (!await confirm('更新 AstrBot 插件', `从「${plugin?.source ?? '已记录来源'}」重新安装「${title}」？`)) return;
      button.disabled = true;
      try {
        const result = await request(`${BASE}/plugins/${encodeURIComponent(id)}/update`, { method: 'POST', payload: {} });
        const jobId = String(result?.id ?? result?.job?.id ?? '');
        if (!jobId) throw new Error('更新任务没有返回编号');
        notify('AstrBot 插件更新任务已排队');
        void pollJob(jobId, card.querySelector('[data-plugin-job]'), { label: 'AstrBot 插件更新' });
      } catch (error) { notify(`更新失败：${error.message}`, { duration: 5200 }); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'rollback') {
      const card = button.closest('[data-plugin-id]');
      if (!await confirm('回滚整个 AstrBot 环境', `这会将整个 AstrBot 环境恢复到所选插件的上一个快照。「${pluginTitle(state.plugins.find((item) => pluginId(item) === card.dataset.pluginId))}」以外的插件、共享依赖、配置和插件数据也可能一并回退。`)) return;
      button.disabled = true;
      try {
        const result = await request(`${BASE}/plugins/${encodeURIComponent(card.dataset.pluginId)}/rollback`, { method: 'POST', payload: {} });
        const jobId = String(result?.id ?? result?.job?.id ?? '');
        if (!jobId) throw new Error('回滚任务没有返回编号');
        notify('AstrBot 插件回滚任务已排队');
        void pollJob(jobId, card.querySelector('[data-plugin-job]'), { label: 'AstrBot 插件回滚' });
      } catch (error) { notify(`回滚失败：${error.message}`); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'uninstall') {
      const card = button.closest('[data-plugin-id]');
      const id = card.dataset.pluginId;
      const title = pluginTitle(state.plugins.find((item) => pluginId(item) === id));
      if (!await confirm('卸载 AstrBot 插件', `卸载「${title}」？插件数据会保留。`)) return;
      const purgeData = Boolean(card.querySelector('[data-purge]')?.checked);
      if (purgeData && !await confirm('确认删除插件数据？', `这会永久删除「${title}」的数据目录，且无法通过回滚恢复。`)) return;
      button.disabled = true;
      try {
        const result = await request(`${BASE}/plugins/${encodeURIComponent(id)}`, { method: 'DELETE', payload: { purgeData } });
        const jobId = String(result?.id ?? result?.job?.id ?? '');
        if (!jobId) throw new Error('卸载任务没有返回编号');
        notify('AstrBot 插件卸载任务已排队');
        void pollJob(jobId, card.querySelector('[data-plugin-job]'), {
          label: purgeData ? 'AstrBot 插件及数据卸载' : 'AstrBot 插件卸载',
        });
      } catch (error) { notify(`卸载失败：${error.message}`); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'group-save') {
      const groupId = root.querySelector('[data-group-id]:not(button)').value.trim();
      const pluginIds = Array.from(root.querySelectorAll('[data-group-plugin]:checked'), (input) => input.value);
      const chatMode = root.querySelector('[data-chat-mode]').value;
      if (!GROUP_ID.test(groupId)) { notify('群号必须是正整数'); return; }
      if (pluginIds.length > 128 || pluginIds.some((id) => !PLUGIN_ID.test(id) || RESERVED.has(id))) { notify('插件名单无效'); return; }
      button.disabled = true;
      try {
        state.policy = await request(`${BASE}/groups/${encodeURIComponent(groupId)}`, { method: 'PUT', payload: { pluginIds, chatMode } });
        notify(`群 ${groupId} 的 AstrBot 策略已保存`);
        render();
        selectedGroup(groupId);
      } catch (error) { notify(`保存群策略失败：${error.message}`); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'group-delete') {
      const groupId = root.querySelector('[data-group-id]:not(button)').value.trim();
      if (!GROUP_ID.test(groupId)) { notify('请先输入要删除策略的正整数群号'); return; }
      if (!state.policy?.groups?.[groupId]) { notify('这个群还没有单独策略'); return; }
      if (!await confirm('删除群聊策略', `删除群 ${groupId} 的 AstrBot 策略？`)) return;
      button.disabled = true;
      try {
        state.policy = await request(`${BASE}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE', payload: {} });
        notify(`群 ${groupId} 的 AstrBot 策略已删除`);
        render();
      } catch (error) { notify(`删除群策略失败：${error.message}`); }
      finally { button.disabled = false; }
    }
  });

  return { load };
}
