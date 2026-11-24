/**
 * 控制台「自动化」页的每日群聊总结设置：开关、时间、门槛、指定群，以及最近几次运行结果。
 * 设置走已有的 PUT /api/settings（groupSummary 组），运行记录读 GET /api/group-summary。
 */

const RUNS_SHOWN = 6;

/** 把文本框里的群号拆成数组（逗号、空格、换行都行） */
export function parseGroupIds(text) {
  return [...new Set(String(text ?? '').split(/[\s,，]+/).map((s) => s.trim()).filter((s) => /^\d{4,12}$/.test(s)))];
}

/** 一条运行记录的展示文字 */
export function describeRun(run) {
  const when = run?.at ? new Date(run.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const head = `群 ${run?.groupId ?? '?'}${when ? ` · ${when}` : ''}`;
  if (run?.skipped) return `${head} · 跳过：${run.skipped}`;
  if (run?.ok) return `${head} · 已发送（${run.messages ?? 0} 条消息）`;
  return `${head} · 失败：${run?.error || '未知原因'}`;
}

export function initSummarySettings({ api, notify }) {
  const $ = (id) => document.getElementById(id);
  const fields = {
    enabled: $('summaryEnabled'), ranking: $('summaryRanking'), time: $('summaryTime'),
    min: $('summaryMin'), groups: $('summaryGroups'),
  };
  const status = $('summaryStatus');
  const runs = $('summaryRuns');
  const save = $('summarySave');
  if (!save || !fields.enabled) return { load: async () => {} };

  function renderRuns(list) {
    if (!runs) return;
    runs.replaceChildren();
    for (const run of (Array.isArray(list) ? list : []).slice(0, RUNS_SHOWN)) {
      const p = document.createElement('p');
      p.className = `summary-run${run.ok ? '' : ' summary-run--bad'}`;
      p.textContent = describeRun(run);
      runs.append(p);
    }
  }

  async function load() {
    try {
      const data = await api('/api/group-summary');
      const s = data.settings ?? {};
      fields.enabled.checked = Boolean(s.enabled);
      fields.ranking.checked = s.ranking !== false;
      fields.time.value = s.time || '22:00';
      fields.min.value = String(s.minMessages ?? 20);
      fields.groups.value = (s.groupIds ?? []).join('\n');
      if (status) status.textContent = data.lastDate ? `最近一次定时总结：${data.lastDate}` : '还没有定时总结过';
      renderRuns(data.runs);
    } catch (err) {
      if (status) status.textContent = `读取失败：${err.message}`;
    }
  }

  save.addEventListener('click', async () => {
    const time = String(fields.time.value || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      notify('请填一个有效的时间，比如 22:00');
      return;
    }
    const [h, m] = time.split(':');
    const min = Math.trunc(Number(fields.min.value));
    save.disabled = true;
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          groupSummary: {
            enabled: fields.enabled.checked,
            ranking: fields.ranking.checked,
            time: `${h.padStart(2, '0')}:${m}`,
            minMessages: Number.isFinite(min) && min >= 1 ? Math.min(500, min) : 20,
            groupIds: parseGroupIds(fields.groups.value),
          },
        }),
      });
      notify('总结设置已保存（桥接每分钟读一次，不用重启）');
      await load();
    } catch (err) {
      notify(`保存失败：${err.message}`);
    } finally {
      save.disabled = false;
    }
  });

  return { load };
}
