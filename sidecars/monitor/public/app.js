(function () {
  'use strict';

  const sidecar = window.sidecar || { conversationId: '', fetch: window.fetch.bind(window), ui: {} };
  const state = {
    lang: 'zh',
    activeTab: 'session',
    hostConvId: sidecar.conversationId || '',
    convId: sidecar.conversationId || '',
    overview: null,
    sessions: null,
    usageByDays: {},
    usageDays: 31,
    models: null,
    calMonth: null,
    selectedCalDay: null,
    calAccount: 'all',
    detailsOpen: false,
    accountsOpen: false,
    pollTimer: null,
    loadingOverview: false,
    openFolds: new Set(),
    closedFolds: new Set(),
    inspectorTab: 'models', // 'models' | 'context' | 'steps' | 'tools' | 'subagents' | 'errors'
    modelSortBy: 'active', // 'active' | 'cost' | 'calls'
    costSubTab: 'families', // 'families' | 'accounts' | 'pricing'
    showAllSubagents: false,
    turnLimit: 10,
    turnFilter: 'all', // 'all' | 'checkpoint' | 'error'
    errCategoryFilter: 'all',
    sessionFilter: '',
    sessionStatusFilter: 'all', // 'all' | 'running'
    sessionSortBy: 'recent', // 'recent' | 'cost' | 'context'
    modelPoolFilter: 'all',
    tabError: {},
    lastSessionSig: '',
    lastSessionConvId: '',
  };

  const TABS = {
    session: ['当前会话', 'Session'],
    sessions: ['历史会话', 'Sessions'],
    cost: ['费用定价', 'Cost'],
    models: ['模型配额', 'Models'],
    calendar: ['用量日历', 'Calendar'],
    settings: ['账号设置', 'Accounts'],
  };

  const CHEV_SVG = '<svg class="chev-ico" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';

  const CTX_GROUP_COLORS = ['#5B9CF6', '#C5B9F2', '#34C3A4', '#F5B841', '#E0A3B8', '#84A2CF', '#8C98A9'];
  const ACCT_PALETTE = ['#5B9CF6', '#C5B9F2', '#34D399', '#F5B841', '#E0A3B8'];
  const UNATTRIBUTED_COLOR = '#8C98A9';
  const MODEL_BAR_COLORS = ['#5B9CF6', '#C5B9F2', '#34C3A4', '#F5B841', '#E0A3B8', '#84A2CF', '#6E8BB8', '#8C98A9'];
  const ERR_CAT_COLORS = {
    timeout: '#F87171',
    network: '#F59E0B',
    capacity: '#F5B841',
    format: '#A78BFA',
    interrupted: '#5B9CF6',
    api: '#F472B6',
    other: '#8C98A9',
  };

  // ── Formatters & Pure Utilities ──

  const bi = (zh, en) => (state.lang === 'en' ? en : state.lang === 'both' ? `${zh} / ${en}` : zh);

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const biHtml = (zh, en) => {
    if (state.lang === 'en') return esc(en);
    if (state.lang === 'both' && zh !== en) {
      return `<span class="bi-pri">${esc(zh)}</span><span class="bi-sep"> / </span><span class="bi-sec">${esc(en)}</span>`;
    }
    return esc(zh);
  };

  function fmtTok(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
    return `${sign}${Math.round(abs)}`;
  }

  const fmtSignedTok = (n) => (n > 0 ? `+${fmtTok(n)}` : fmtTok(n));

  function fmtCost(c) {
    const v = Number(c) || 0;
    if (v === 0) return '$0.00';
    return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  }

  function fmtBytes(b) {
    const v = Number(b) || 0;
    if (v >= 1048576) return `${(v / 1048576).toFixed(2)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
  }

  function fmtRate(v, short = false) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n) || n <= 0) return '--';
    return `${n.toFixed(1)} ${short ? 't/s' : 'tok/s'}`;
  }

  function fmtSec(v) {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n > 0 ? `${n.toFixed(1)}s` : '--';
  }

  function fmtTtft(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n) || n <= 0) return '--';
    if (n < 1) return `${Math.round(n * 1000)}ms`;
    return n < 10 ? `${n.toFixed(2)}s` : `${n.toFixed(1)}s`;
  }

  function fmtDuration(sec) {
    const s = Math.round(Number(sec) || 0);
    if (s <= 0) return '--';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM ? `${h}h${remM}m` : `${h}h`;
  }

  function fmtCountdown(iso) {
    if (!iso) return '--';
    const diff = Date.parse(iso) - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return bi('已重置', 'Ready');
    const mins = Math.floor(diff / 60000);
    const days = Math.floor(mins / 1440);
    const hrs = Math.floor((mins % 1440) / 60);
    const rem = mins % 60;
    if (days > 0) return `${days}d${hrs}h`;
    return hrs > 0 ? `${hrs}h${rem}m` : `${rem}m`;
  }

  function parseIsoMs(raw) {
    if (!raw) return NaN;
    return Date.parse(String(raw).trim().replace(' ', 'T'));
  }

  function fmtTimeShort(iso) {
    const ms = parseIsoMs(iso);
    return Number.isFinite(ms)
      ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
  }

  function fmtTimeHM(iso) {
    const ms = parseIsoMs(iso);
    return Number.isFinite(ms)
      ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
  }

  function fmtCycleRange(startTs, endTs) {
    const sMs = parseIsoMs(startTs);
    const eMs = parseIsoMs(endTs);
    if (!Number.isFinite(sMs)) return '';
    const p = (n) => String(n).padStart(2, '0');
    const sd = new Date(sMs);
    const ed = Number.isFinite(eMs) ? new Date(eMs) : null;
    const sameDay = ed
      && sd.getFullYear() === ed.getFullYear()
      && sd.getMonth() === ed.getMonth()
      && sd.getDate() === ed.getDate();
    if (sameDay) {
      return `${p(sd.getHours())}:${p(sd.getMinutes())}–${p(ed.getHours())}:${p(ed.getMinutes())}`;
    }
    const fmtMDHM = (d) => `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return ed ? `${fmtMDHM(sd)}–${fmtMDHM(ed)}` : fmtMDHM(sd);
  }

  function fmtLocalDateTime(iso) {
    const ms = parseIsoMs(iso);
    if (!Number.isFinite(ms)) return String(iso || '');
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtRelativeTime(iso) {
    const ms = parseIsoMs(iso);
    if (!Number.isFinite(ms)) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return bi('刚刚', 'just now');
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return bi(`${mins} 分钟前`, `${mins}m ago`);
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return bi(`${hrs} 小时前`, `${hrs}h ago`);
    const days = Math.floor(hrs / 24);
    if (days < 7) return bi(`${days} 天前`, `${days}d ago`);
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtModelLabel(name) {
    return !name || name === 'Unknown Model' || name === 'unknown'
      ? bi('历史未记录模型', 'Legacy (Unrecorded)')
      : name;
  }

  function errCategoryLabel(key) {
    return ({
      timeout: bi('超时', 'Timeout'),
      network: bi('网络异常', 'Network'),
      capacity: bi('限流/容量', 'Capacity'),
      format: bi('输出格式', 'Format'),
      interrupted: bi('流中断', 'Interrupted'),
      api: bi('API 异常', 'API Error'),
      other: bi('其他', 'Other'),
    })[key] || bi('其他', 'Other');
  }

  function pctColor(pct, invert = false) {
    if (invert) return pct <= 20 ? 'red' : pct < 50 ? 'amber' : 'green';
    return pct >= 80 ? 'red' : pct >= 65 ? 'amber' : 'accent';
  }

  function shortAccountName(key, accounts) {
    if (key === 'unattributed') return bi('未归属', 'Unattributed');
    const found = (accounts || []).find((a) => a.email === key);
    if (found?.name && found.name !== key) return found.name;
    return String(key).split('@')[0] || key;
  }

  function avatarInitial(name, email) {
    const src = String(name || email || '?').trim();
    return src ? src[0].toUpperCase() : '?';
  }

  function compactModelShort(model) {
    return String(model || '')
      .replace(/^Gemini\s+/i, 'G')
      .replace(/^Claude\s+/i, 'C ')
      .replace(/\s*\((XHigh|High|Medium|Low|Thinking|Tiered|Orchestrator)\)$/i, ' $1');
  }

  function summarizeToolsInline(tools) {
    if (!Array.isArray(tools) || !tools.length) return '';
    const counts = new Map();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    const parts = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
    return parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : '');
  }

  function localizeCtxGroup(key, name) {
    return ({
      TOKEN_TYPE_CHAT_MESSAGES: bi('对话消息', 'Chat Messages'),
      TOKEN_TYPE_TOOLS: bi('工具定义', 'Tools'),
      TOKEN_TYPE_SKILLS: bi('技能列表', 'Skills'),
      TOKEN_TYPE_SYSTEM_PROMPT: bi('系统提示词', 'System Prompt'),
      TOKEN_TYPE_SUBAGENTS: bi('子代理定义', 'Subagents'),
      TOKEN_TYPE_RULES: bi('用户规则', 'Rules'),
      TOKEN_TYPE_PLUGINS: bi('插件目录', 'Plugins'),
      TOKEN_TYPE_MCP_TOOLS: bi('MCP 工具', 'MCP Tools'),
      TOKEN_TYPE_FILES: bi('上下文文件', 'Files'),
      system_tools: bi('系统 · 规则与工具', 'System & Tools'),
      tool_results: bi('工具返回结果', 'Tool Results'),
      assistant: bi('模型回复与思考', 'Assistant & Thinking'),
      checkpoint: bi('历史压缩摘要', 'Compaction Summary'),
      user: bi('用户输入', 'User Messages'),
      system_messages: bi('系统消息与报错', 'System & Errors'),
    })[key] || name;
  }

  function localizeCtxChild(name) {
    return ({
      Thinking: bi('思考过程', 'Thinking'),
      'Assistant Reply': bi('回复正文', 'Assistant Reply'),
      'Tool Call Args': bi('工具调用参数', 'Tool Call Args'),
      'System Prompt': bi('系统提示词', 'System Prompt'),
    })[name] || name;
  }

  function modelSeriesGroup(label, modelId) {
    const s = `${label || ''} ${modelId || ''}`.toLowerCase();
    if (s.includes('gemini 4') || s.includes('orchestrator')) return 'gemini4';
    if (s.includes('gemini')) return 'gemini3';
    if (s.includes('claude')) return 'claude';
    return 'other';
  }

  function seriesGroupTitle(key) {
    return ({
      gemini4: bi('Gemini 4 系列', 'Gemini 4 Series'),
      gemini3: bi('Gemini 3 系列', 'Gemini 3 Series'),
      claude: bi('Claude 系列', 'Claude Series'),
      other: bi('其他模型', 'Other Models'),
    })[key] || key;
  }

  // ── HTTP & Shared UI Primitives ──

  async function apiGet(path) {
    const res = await sidecar.fetch(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await sidecar.fetch(path, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function isFoldOpen(key, defaultOpen = false) {
    if (state.openFolds.has(key)) return true;
    if (state.closedFolds.has(key)) return false;
    return defaultOpen;
  }

  function bindFoldPersistence(container) {
    container.querySelectorAll('details[data-fold-key]').forEach((d) => {
      d.addEventListener('toggle', () => {
        const key = d.getAttribute('data-fold-key');
        if (!key) return;
        if (d.open) {
          state.openFolds.add(key);
          state.closedFolds.delete(key);
        } else {
          state.openFolds.delete(key);
          state.closedFolds.add(key);
        }
      });
    });
  }

  function renderErrorBanner(el, label, msg, retryKey) {
    el.innerHTML = `
      <div class="err-banner">
        <span>${esc(label)}${esc(msg)}</span>
        <button class="icon-btn" type="button" data-retry="${esc(retryKey)}">${esc(bi('重试', 'Retry'))}</button>
      </div>`;
  }

  function renderSegmented(items, activeValue, attr) {
    return `<div class="seg-group">${items
      .map(([val, lbl]) => `<button class="seg-btn ${String(activeValue) === String(val) ? 'active' : ''}" type="button" ${attr}="${esc(val)}">${esc(lbl)}</button>`)
      .join('')}</div>`;
  }

  function renderRadialGauge(pct, colorName, size = 46) {
    const r = 18;
    const circ = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    const offset = circ * (1 - clamped / 100);
    return `
      <svg class="ring-svg" width="${size}" height="${size}" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="ring-track" cx="22" cy="22" r="${r}" />
        <circle class="ring-fill ${colorName}" cx="22" cy="22" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" />
      </svg>`;
  }

  function renderPoolMiniBars(pools) {
    if (!pools?.length) return '';
    return `<div class="pool-mini-list">${pools.map((p) => {
      const col = pctColor(p.remainingPercent, true);
      return `
        <div class="pool-mini-row">
          <div class="row-between fs-11">
            <span class="c-dim">${esc(p.poolKey === 'gemini' ? 'Gemini' : 'Premium')}</span>
            <span class="mono"><strong class="c-${col}">${p.remainingPercent}%</strong> <span class="c-dim">· ${esc(fmtCountdown(p.resetTime))}</span></span>
          </div>
          <div class="bar-track"><div class="bar-fill ${col}" style="width:${p.remainingPercent}%"></div></div>
        </div>`;
    }).join('')}</div>`;
  }

  function renderModelTokenTable(rows, { nameHeader = bi('模型', 'Model'), includeSpeed = false, includeShare = false, totalCost = 0, isModel = true } = {}) {
    if (!rows.length) return `<div class="empty">${esc(bi('无模型调用记录', 'No model calls'))}</div>`;
    const denom = totalCost > 0 ? totalCost : rows.reduce((s, r) => s + (r.cost || 0), 0);
    return `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>${esc(nameHeader)}</th>
          ${includeShare ? `<th class="num">${esc(bi('占比', 'Share'))}</th>` : ''}
          <th class="num">${esc(bi('调用', 'Calls'))}</th>
          <th class="num">${esc(bi('输入', 'In'))}</th>
          <th class="num">${esc(bi('缓存', 'Cache'))}</th>
          <th class="num">${esc(bi('输出', 'Out'))}</th>
          ${includeSpeed ? `<th class="num">${esc(bi('速率', 'Speed'))}</th>` : ''}
          <th class="num">${esc(bi('费用', 'Cost'))}</th>
        </tr></thead>
        <tbody>${rows.map((r, idx) => {
          const share = denom > 0 ? ((r.cost || 0) / denom) * 100 : 0;
          const dotHtml = r.dotColor ? `<span class="dot sm" style="background:${r.dotColor}"></span>` : (includeShare ? `<span class="dot sm" style="background:${MODEL_BAR_COLORS[idx % MODEL_BAR_COLORS.length]}"></span>` : '');
          return `
          <tr>
            <td class="tbl-name"><span class="row-flex gap-xs min-w-0">${dotHtml}<span class="truncate ${isModel ? 't-model' : 'c-fg'}">${esc(fmtModelLabel(r.name))}</span></span></td>
            ${includeShare ? `<td class="num c-dim">${share > 0 ? `${share.toFixed(1)}%` : '--'}</td>` : ''}
            <td class="num c-body">${r.calls.toLocaleString()}</td>
            <td class="num t-in">${fmtTok(r.inputTokens)}</td>
            <td class="num t-in"${r.cacheHitPercent != null ? ` title="${esc(`${bi('缓存命中率', 'Cache hit')}: ${r.cacheHitPercent}%`)}"` : ''}>${fmtTok(r.cacheReadTokens)}</td>
            <td class="num t-out">${fmtTok(r.outputTokens)}</td>
            ${includeSpeed ? `<td class="num ${r.outputTokensPerSec ? 't-speed fw-500' : 'c-faint'}"${r.avgLatencySec ? ` title="${esc(`${bi('单次平均耗时', 'Avg latency')}: ${fmtSec(r.avgLatencySec)}`)}"` : ''}>${esc(r.outputTokensPerSec ? `${r.outputTokensPerSec.toFixed(0)} t/s` : '--')}</td>` : ''}
            <td class="num ${r.priced === false ? 'c-faint' : 't-cost fw-500'}">${r.priced === false ? '--' : fmtCost(r.cost)}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;
  }

  function renderKvStrip(items) {
    return `<div class="kv-strip">${items.map((it) => `
      <div class="kv-cell"${it.tip ? ` title="${esc(it.tip)}"` : ''}>
        <div class="kv-lbl">${esc(it.label)}</div>
        <div class="kv-val ${it.cls || ''}">${it.val}</div>
        ${it.sub ? `<div class="kv-sub">${it.sub}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function renderModelPerfTable(models, { sortBy = 'calls', compact = false, liveModel = '', foldPrefix = 'model', autoExpandSingle = false } = {}) {
    if (!Array.isArray(models) || !models.length) {
      return `<div class="empty">${esc(bi('暂无模型调用明细', 'No model usage recorded'))}</div>`;
    }
    const sorted = [...models].sort((a, b) =>
      sortBy === 'cost'
        ? (b.cost || 0) - (a.cost || 0) || (b.calls || 0) - (a.calls || 0)
        : (b.calls || 0) - (a.calls || 0) || (b.cost || 0) - (a.cost || 0),
    );
    const totalCalls = Math.max(1, sorted.reduce((s, m) => s + (m.calls || 0), 0));
    const totalCost = sorted.reduce((s, m) => s + (m.cost || 0), 0);
    const useCostShare = sortBy === 'cost' && totalCost > 0;
    const maxVal = Math.max(
      0.0001,
      ...sorted.map((m) => (useCostShare ? (m.cost || 0) : (m.calls || 0))),
    );

    if (compact) {
      return `<div class="m-compact-list">${sorted.map((m, idx) => {
        const val = useCostShare ? (m.cost || 0) : (m.calls || 0);
        const barW = Math.max(4, (val / maxVal) * 100);
        const col = MODEL_BAR_COLORS[idx % MODEL_BAR_COLORS.length];
        return `
          <div class="m-compact-row" title="${esc(`${fmtModelLabel(m.model)} · ${m.calls} ${bi('次', 'calls')} · ${fmtRate(m.outputTokensPerSec, true)} · ${bi('缓存', 'Cache')} ${m.cacheHitPercent}%`)}">
            <span class="row-flex gap-xs min-w-0 t-model"><span class="dot sm" style="background:${col}"></span><span class="truncate">${esc(compactModelShort(fmtModelLabel(m.model)))}</span></span>
            <div class="m-row-bar"><div class="m-row-bar-fill" style="width:${barW.toFixed(1)}%;background:${col}"></div></div>
            <span class="r tnum c-dim">${m.calls}${esc(bi('次', 'c'))}</span>
            <span class="r tnum ${m.priced === false ? 'c-faint' : 't-cost fw-500'}">${m.priced === false ? '--' : fmtCost(m.cost)}</span>
          </div>`;
      }).join('')}</div>`;
    }

    const rowsHtml = sorted.map((m, idx) => {
      const sharePct = useCostShare ? ((m.cost || 0) / totalCost) * 100 : ((m.calls || 0) / totalCalls) * 100;
      const val = useCostShare ? (m.cost || 0) : (m.calls || 0);
      const barW = Math.max(3, (val / maxVal) * 100);
      const col = MODEL_BAR_COLORS[idx % MODEL_BAR_COLORS.length];
      const fk = `${foldPrefix}:${m.model}`;
      const isOpen = isFoldOpen(fk, autoExpandSingle && sorted.length === 1);
      const isLive = Boolean(liveModel && m.model === liveModel);
      const scopeSub = m.subagentCalls > 0 && m.mainCalls > 0
        ? bi(`主会话 ${m.mainCalls} · 子代理 ${m.subagentCalls}`, `Main ${m.mainCalls} · Sub ${m.subagentCalls}`)
        : m.subagentCalls > 0 ? bi('仅子代理调用', 'Subagents only') : bi('仅主会话调用', 'Main session');
      const speedVal = m.outputTokensPerSec
        ? `<span class="t-speed">${m.outputTokensPerSec.toFixed(1)}</span><span class="u">t/s</span>`
        : '<span class="c-faint">--</span>';
      const speedSub = [
        m.avgTtftSec ? `ttft ${fmtTtft(m.avgTtftSec)}` : '',
        m.avgLatencySec ? bi(`平均耗时 ${fmtSec(m.avgLatencySec)}`, `avg ${fmtSec(m.avgLatencySec)}`) : '',
      ].filter(Boolean).join(' · ') || bi('暂无耗时数据', 'No timing data');
      const speedTip = [
        m.outputTokensPerSec ? `${bi('输出速率', 'Speed')}: ${m.outputTokensPerSec.toFixed(1)} tok/s` : '',
        m.avgTtftSec ? `${bi('平均 TTFT', 'Avg TTFT')}: ${fmtTtft(m.avgTtftSec)}` : '',
        m.avgLatencySec ? `${bi('单次平均耗时', 'Avg latency')}: ${fmtSec(m.avgLatencySec)}` : '',
      ].filter(Boolean).join(' · ');
      const primaryHtml = useCostShare
        ? (m.priced === false ? '<span class="c-faint">--</span>' : `<span class="t-cost">${fmtCost(m.cost)}</span>`)
        : `<span class="c-fg">${m.calls.toLocaleString()}<span class="u">${esc(bi('次', 'c'))}</span></span>`;
      const totalIn = (m.inputTokens || 0) + (m.cacheReadTokens || 0);
      const inTip = `${bi('总输入', 'Total In')}: ${fmtTok(totalIn)} = ${bi('新增输入', 'Fresh')} ${fmtTok(m.inputTokens)} + ${bi('缓存读取', 'Cache Read')} ${fmtTok(m.cacheReadTokens)} (${m.cacheHitPercent}%)`;
      const inSub = m.cacheReadTokens > 0
        ? `${esc(bi('新增', 'fresh'))} <span class="t-in">${fmtTok(m.inputTokens)}</span> · ${esc(bi('缓存', 'cache'))} ${m.cacheHitPercent}%`
        : esc(bi('无缓存命中', 'No cache hits'));
      const callSub = [
        esc(scopeSub),
        !useCostShare && m.priced !== false ? `<span class="t-cost">${fmtCost(m.cost)}</span>` : '',
        m.totalDurationSec ? esc(fmtDuration(m.totalDurationSec)) : '',
      ].filter(Boolean).join(' · ');
      const outSub = m.avgOutputPerCall
        ? esc(bi(`平均输出 ${fmtTok(m.avgOutputPerCall)}`, `avg ${fmtTok(m.avgOutputPerCall)}/call`))
        : '<span class="c-faint">--</span>';
      const outTip = `${bi('总输出', 'Total Out')}: ${fmtTok(m.outputTokens)}${m.avgOutputPerCall ? ` · ${bi('单次平均输出', 'Avg/call')}: ${fmtTok(m.avgOutputPerCall)}` : ''}`;

      return `
        <details class="m-row" data-fold-key="${esc(fk)}" ${isOpen ? 'open' : ''}>
          <summary class="m-row-head" title="${esc(`${fmtModelLabel(m.model)} · ${m.calls} ${bi('次', 'calls')} · ${fmtRate(m.outputTokensPerSec, true)} · ${bi('点击展开详细指标', 'Click for details')}`)}">
            <span class="m-row-name">
              ${CHEV_SVG}
              <span class="dot sm" style="background:${col}"></span>
              <span class="truncate t-model">${esc(fmtModelLabel(m.model))}</span>
              ${isLive ? `<span class="m-live-tag">${esc(bi('当前', 'Live'))}</span>` : ''}
            </span>
            <div class="m-row-bar"><div class="m-row-bar-fill" style="width:${barW.toFixed(1)}%;background:${col}"></div></div>
            <span class="m-row-pri">${primaryHtml}</span>
            <span class="m-row-sec">${sharePct.toFixed(0)}%</span>
          </summary>
          <div class="m-row-body">
            ${renderKvStrip([
              { label: bi('调用', 'Calls'), val: `${m.calls.toLocaleString()}<span class="u">${esc(bi('次', 'c'))}</span>`, sub: callSub },
              { label: bi('输入', 'Input'), val: `<span class="t-in">↓${fmtTok(totalIn)}</span>`, sub: inSub, tip: inTip },
              { label: bi('输出', 'Output'), val: `<span class="t-out">↑${fmtTok(m.outputTokens)}</span>`, sub: outSub, tip: outTip },
              { label: bi('速率', 'Speed'), val: speedVal, sub: esc(speedSub), tip: speedTip },
            ])}
          </div>
        </details>`;
    }).join('');

    return `<div class="m-list">${rowsHtml}</div>`;
  }

  // ── Live Header & Popover Drawers ──

  function updateTabSlider() {
    const inner = document.getElementById('tabsInner');
    const slider = document.getElementById('tabSlider');
    const active = inner?.querySelector('.tab.active');
    if (!inner || !slider || !active) return;
    slider.style.left = `${active.offsetLeft}px`;
    slider.style.width = `${active.offsetWidth}px`;
  }

  function updateTabLabels() {
    document.querySelectorAll('#tabNav .tab').forEach((btn) => {
      const key = btn.dataset.tab;
      if (TABS[key]) btn.innerHTML = biHtml(TABS[key][0], TABS[key][1]);
      btn.classList.toggle('active', key === state.activeTab);
    });
    const detLbl = document.getElementById('btnDetailsLabel');
    if (detLbl) detLbl.textContent = bi('详情', 'Details');
    const eocEl = document.getElementById('eocText');
    if (eocEl) eocEl.innerHTML = biHtml('已到底', 'End of content');
    const detBtn = document.getElementById('btnDetails');
    if (detBtn) {
      detBtn.classList.toggle('active', state.detailsOpen);
      detBtn.title = bi('展开详情', 'Toggle details');
    }
    const acctBtn = document.getElementById('btnAccounts');
    if (acctBtn) {
      acctBtn.classList.toggle('active', state.accountsOpen);
      acctBtn.title = bi('账号与配额', 'Accounts & quotas');
    }
    const refBtn = document.getElementById('btnRefresh');
    if (refBtn) refBtn.title = bi('立即刷新', 'Refresh now');
    requestAnimationFrame(updateTabSlider);
  }

  function renderHudRingSvg(pct, col) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    const c = 2 * Math.PI * 6;
    const offset = c * (1 - clamped / 100);
    return `<svg class="hud-ring-svg" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="hud-ring-track" cx="8" cy="8" r="6"></circle>
      <circle class="hud-ring-fill ${col}" cx="8" cy="8" r="6" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
    </svg>`;
  }

  function renderLiveBar() {
    const ov = state.overview;
    if (!ov) return;
    const pillEl = document.getElementById('livePill');
    const ctxEl = document.getElementById('liveContext');
    const qEl = document.getElementById('liveQuota');
    const rEl = document.getElementById('liveReset');
    document.getElementById('liveAcctCount').textContent = String((ov.accounts || []).length);

    pillEl.classList.toggle('is-running', ov.session?.runState === 'RUN_STATE_RUNNING');
    pillEl.classList.toggle('is-offline', Boolean(ov.health && !ov.health.ok));

    if (ov.session) {
      const pct = ov.session.usagePercent || 0;
      const col = pctColor(pct, false);
      const valCls = col === 'accent' ? 't-ctx' : `c-${col}`;
      ctxEl.title = `${bi('主会话上下文', 'Main Context')}: ${fmtTok(ov.session.contextUsed)} / ${fmtTok(ov.session.contextLimit)} (${pct.toFixed(1)}%)`;
      ctxEl.innerHTML = `${renderHudRingSvg(pct, col)}<span class="${valCls}">${esc(fmtTok(ov.session.contextUsed))}</span><span class="c-dim fw-400">/${esc(fmtTok(ov.session.contextLimit))}</span>`;
    } else {
      ctxEl.title = '';
      ctxEl.innerHTML = `<span class="dot sm dim"></span><span class="c-dim">${esc(bi('无会话', 'Idle'))}</span>`;
    }

    const pools = ov.userStatus?.resetPools || [];
    if (ov.userStatus?.available && pools.length > 0) {
      const primary = pools.find((p) => p.poolKey === 'gemini') || pools[0];
      const qCol = pctColor(primary.remainingPercent, true);
      qEl.title = `${primary.poolKey === 'gemini' ? 'Gemini' : 'Premium'}: ${primary.remainingPercent}% · ${fmtCountdown(primary.resetTime)}`;
      qEl.innerHTML = `<span class="dot sm ${qCol}"></span><span class="c-dim fs-105">${esc(bi('配额', 'Quota'))}</span><span class="c-${qCol} fw-600">${primary.remainingPercent}%</span>`;
      rEl.textContent = fmtCountdown(primary.resetTime);
      rEl.classList.remove('hidden');
    } else {
      qEl.title = '';
      qEl.innerHTML = `<span class="dot sm dim"></span><span class="c-dim">${esc(bi('配额离线', 'Quota Offline'))}</span>`;
      rEl.classList.add('hidden');
    }
    renderDrawers();
  }

  function renderDrawers() {
    const det = document.getElementById('detailsDrawer');
    const acc = document.getElementById('accountsDrawer');
    const ov = state.overview;
    det.classList.toggle('hidden', !state.detailsOpen);
    acc.classList.toggle('hidden', !state.accountsOpen);
    if (!ov) return;

    if (state.detailsOpen) {
      const s = ov.session;
      const us = ov.userStatus || {};
      det.innerHTML = `<div class="drawer-inner">
        <div class="metric-band compact cols-auto">
          <div class="metric-item"><div class="metric-lbl">${esc(bi('当前模型', 'Model'))}</div><div class="metric-val fs-12 t-model">${esc(s ? fmtModelLabel(s.model) : '--')}</div></div>
          <div class="metric-item"><div class="metric-lbl">${esc(bi('上下文占用', 'Context'))}</div><div class="metric-val fs-12 t-ctx">${s ? `${fmtTok(s.contextUsed)} <span class="c-dim fw-400">/ ${fmtTok(s.contextLimit)} (${s.usagePercent.toFixed(1)}%)</span>` : '--'}</div></div>
          <div class="metric-item"><div class="metric-lbl">${esc(bi('速率 · 费用', 'Speed · Cost'))}</div><div class="metric-val fs-12">${s ? `<span class="t-speed">${esc(fmtRate(s.totals?.outputTokensPerSec, true))}</span> <span class="c-dim fw-400">${s.totals?.avgTtftSec ? `· ttft ${esc(fmtTtft(s.totals.avgTtftSec))} ` : ''}·</span> <span class="t-cost">${fmtCost(s.totals?.cost)}</span>` : '--'}</div></div>
          <div class="metric-item"><div class="metric-lbl">${esc(bi('账号 / 计划', 'Account / Plan'))}</div><div class="metric-val fs-12">${esc(us.available ? `${us.planName || us.tierName || 'Active'} · ⚡${(us.credits || 0).toLocaleString()}` : bi('未同步配额', 'Offline'))}</div></div>
        </div>
        ${(us.resetPools || []).length ? `<div class="drawer-pools mt-md">${renderPoolMiniBars(us.resetPools)}</div>` : ''}
      </div>`;
    }

    if (state.accountsOpen) {
      const accts = ov.accounts || [];
      acc.innerHTML = `<div class="drawer-inner">${accts.length
        ? `<div class="acct-grid">${accts.map((a) => `
            <div class="acct-tile ${a.isActive ? 'is-active' : ''}">
              <div class="row-between">
                <div class="row-flex gap-sm min-w-0">
                  <span class="acct-avatar ${a.isActive ? 'is-active' : ''}">${esc(avatarInitial(a.name, a.email))}</span>
                  <div class="min-w-0">
                    <div class="fw-600 fs-12 truncate">${esc(a.name || a.email)}</div>
                    <div class="card-sub truncate">${esc(a.email)}</div>
                  </div>
                </div>
                <span class="fs-11 shrink-0 ${a.isActive ? 'c-green fw-600' : 'c-dim'}">${esc(a.isActive ? bi('当前', 'Active') : bi('已保存', 'Saved'))}</span>
              </div>
              <div class="mt-sm">${renderPoolMiniBars(a.resetPools)}</div>
            </div>`).join('')}</div>`
        : `<div class="empty">${esc(bi('暂无已记录账号', 'No saved accounts yet'))}</div>`}</div>`;
    }
  }

  // ── Tab 1: Current Session (Hero + Timeline + 6-Tab Inspector) ──

  function getChartPlotWidth() {
    const mc = document.getElementById('mainContent');
    const avail = mc && mc.clientWidth > 0 ? mc.clientWidth - 68 : 660;
    return Math.max(340, Math.round(avail));
  }

  function renderContextSvg(points, limit) {
    if (!points || points.length < 2) {
      return `<div class="empty">${esc(bi('暂无足够上下文数据', 'Not enough context points yet'))}</div>`;
    }
    const W = getChartPlotWidth();
    const H = 216, padL = 46, padR = 14, padT = 16, padB = 26;
    const maxData = Math.max(...points.map((p) => p.contextTokens), 1);
    const yMax = Math.max(maxData * 1.12, Math.min(limit || 512000, maxData * 1.35), 64000);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xAt = (i) => padL + (i / Math.max(1, points.length - 1)) * plotW;
    const yAt = (val) => padT + plotH - Math.min(1, val / yMax) * plotH;

    const linePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.contextTokens).toFixed(1)}`).join(' ');
    const areaPts = `${padL},${padT + plotH} ${linePts} ${(padL + plotW).toFixed(1)},${padT + plotH}`;

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => {
      const v = yMax * r;
      const y = yAt(v).toFixed(1);
      return `<line class="chart-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />
              <text class="chart-label" x="${padL - 8}" y="${Number(y) + 3.5}" text-anchor="end">${esc(fmtTok(v))}</text>`;
    }).join('');

    const limitY = yAt(limit);
    const limitLine = limit > 0 && limit <= yMax
      ? `<line class="chart-limit" x1="${padL}" y1="${limitY.toFixed(1)}" x2="${W - padR}" y2="${limitY.toFixed(1)}" />
         <text class="chart-limit-lbl" x="${W - padR - 2}" y="${Math.max(padT + 10, limitY - 5).toFixed(1)}" text-anchor="end">${esc(bi('上限', 'Limit'))} ${esc(fmtTok(limit))}</text>`
      : '';

    const cpMarkers = points
      .map((p, i) => {
        if (!p.afterCheckpoint) return '';
        const x = xAt(i).toFixed(1);
        const y = yAt(p.contextTokens).toFixed(1);
        return `<line class="chart-cp" x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" />
                <circle class="chart-cp-dot" cx="${x}" cy="${y}" r="3.2"><title>${esc(bi(`压缩后 #${p.step}: ${fmtTok(p.contextTokens)}`, `Post-compaction #${p.step}: ${fmtTok(p.contextTokens)}`))}</title></circle>`;
      })
      .join('');

    const lastIdx = points.length - 1;
    const lx = xAt(lastIdx).toFixed(1);
    const ly = yAt(points[lastIdx].contextTokens).toFixed(1);
    const lastDot = `<circle class="chart-last-halo" cx="${lx}" cy="${ly}" r="6.5" /><circle class="chart-last-dot" cx="${lx}" cy="${ly}" r="3.2" />`;

    const tickSlots = W >= 560 ? 5 : 3;
    const xIndices = [];
    for (let k = 0; k < tickSlots; k++) {
      const idx = Math.round((k / Math.max(1, tickSlots - 1)) * lastIdx);
      if (!xIndices.includes(idx)) xIndices.push(idx);
    }
    const xTicks = xIndices
      .map((i, pos) => {
        const anchor = pos === 0 ? 'start' : pos === xIndices.length - 1 ? 'end' : 'middle';
        return `<text class="chart-label" x="${xAt(i).toFixed(1)}" y="${H - 7}" text-anchor="${anchor}">T${points[i].turn} · #${points[i].step}</text>`;
      })
      .join('');

    return `
      <div class="chart-box" id="ctxChartBox">
        <svg class="chart-svg" id="ctxChartSvg" viewBox="0 0 ${W} ${H}" data-w="${W}" data-h="${H}" data-padl="${padL}" data-padr="${padR}" data-padt="${padT}" data-padb="${padB}" data-ymax="${yMax}">
          <defs>
            <linearGradient id="ctxGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.24" />
              <stop offset="70%" stop-color="var(--accent)" stop-opacity="0.05" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          ${yTicks}
          ${limitLine}
          ${cpMarkers}
          <polygon class="chart-area" points="${areaPts}" />
          <polyline class="chart-line" points="${linePts}" />
          ${lastDot}
          <line class="chart-hover-line hidden" id="ctxHoverLine" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" />
          <circle class="chart-hover-dot hidden" id="ctxHoverDot" cx="0" cy="0" r="4" />
          ${xTicks}
        </svg>
        <div class="chart-tip hidden" id="ctxChartTip"></div>
      </div>`;
  }

  function bindContextChartHover(points, limit) {
    const svg = document.getElementById('ctxChartSvg');
    const tip = document.getElementById('ctxChartTip');
    const hLine = document.getElementById('ctxHoverLine');
    const hDot = document.getElementById('ctxHoverDot');
    if (!svg || !tip || !hLine || !hDot || !points || points.length < 2) return;

    const W = Number(svg.dataset.w), H = Number(svg.dataset.h);
    const padL = Number(svg.dataset.padl), padR = Number(svg.dataset.padr);
    const padT = Number(svg.dataset.padt), padB = Number(svg.dataset.padb);
    const yMax = Number(svg.dataset.ymax) || 1;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const hide = () => {
      tip.classList.add('hidden');
      hLine.classList.add('hidden');
      hDot.classList.add('hidden');
    };

    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      const ratio = Math.max(0, Math.min(1, (svgX - padL) / Math.max(1, plotW)));
      const idx = Math.round(ratio * (points.length - 1));
      const p = points[idx];
      if (!p) return;

      const cx = padL + (idx / Math.max(1, points.length - 1)) * plotW;
      const cy = padT + plotH - Math.min(1, p.contextTokens / yMax) * plotH;
      hLine.setAttribute('x1', cx.toFixed(1));
      hLine.setAttribute('x2', cx.toFixed(1));
      hDot.setAttribute('cx', cx.toFixed(1));
      hDot.setAttribute('cy', cy.toFixed(1));
      hLine.classList.remove('hidden');
      hDot.classList.remove('hidden');

      const pct = limit > 0 ? ((p.contextTokens / limit) * 100).toFixed(1) : '0.0';
      tip.innerHTML = `
        <div class="chart-tip-title">T${p.turn} · #${p.step} · ${fmtTok(p.contextTokens)} (${pct}%)${p.afterCheckpoint ? ` <span class="c-amber">⚡${esc(bi('压缩后', 'Compacted'))}</span>` : ''}</div>
        <div class="chart-tip-sub">↓${fmtTok(p.inputTokens)} · ⚡${fmtTok(p.cacheReadTokens)} · ↑${fmtTok(p.outputTokens)}${p.ts ? ` · ${esc(fmtTimeShort(p.ts))}` : ''}</div>`;
      tip.classList.remove('hidden');

      const px = (cx / W) * rect.width;
      const py = (cy / H) * rect.height;
      const tipW = tip.offsetWidth || 190;
      const left = px + 14 + tipW > rect.width ? Math.max(4, px - tipW - 14) : px + 14;
      const top = py < 62 ? Math.min(rect.height - 52, py + 16) : 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    });
    svg.addEventListener('mouseleave', hide);
  }

  function stepTotalDurationSec(st) {
    const dt = Number(st?.dtSec) || 0;
    if (dt > 0) return dt;
    const sum = (Number(st?.ttftSec) || 0) + (Number(st?.streamSec) || 0);
    return sum > 0 ? sum : 0;
  }

  function renderStepRow(st, maxDurSec = 0) {
    if (st.type === 'USER_INPUT') {
      return `
        <div class="wf-row is-user" title="${esc(st.snippet || '')}">
          <span class="wf-node"><span class="wf-dot is-user"></span></span>
          <span class="wf-num">#${st.step}</span>
          <span class="wf-desc wf-span"><span class="step-tag t-user">${esc(bi('用户', 'USER'))}</span><span class="c-fg truncate">${esc(st.snippet || bi('用户输入', 'User input'))}</span></span>
          <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
        </div>`;
    }
    if (st.type === 'CHECKPOINT') {
      const freed = st.beforeTokens > 0 && st.afterTokens > 0 ? st.beforeTokens - st.afterTokens : 0;
      const txt = st.beforeTokens > 0
        ? `${bi('上下文压缩', 'Compacted')}: ${fmtTok(st.beforeTokens)} → ${st.afterTokens > 0 ? fmtTok(st.afterTokens) : '--'}${freed > 0 ? ` (-${fmtTok(freed)})` : ''}`
        : bi('触发上下文压缩', 'Compaction checkpoint');
      return `
        <div class="wf-row is-cp" title="${esc(txt)}">
          <span class="wf-node"><span class="wf-dot is-cp"></span></span>
          <span class="wf-num">#${st.step}</span>
          <span class="wf-desc wf-span"><span class="step-tag t-cp">${esc(bi('压缩', 'CP'))}</span><span class="c-amber truncate">${esc(txt)}</span></span>
          <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
        </div>`;
    }
    if (st.type === 'ERROR_MESSAGE') {
      return `
        <div class="wf-row is-err" title="${esc(st.snippet || 'Error')}">
          <span class="wf-node"><span class="wf-dot is-err"></span></span>
          <span class="wf-num">#${st.step}</span>
          <span class="wf-desc wf-span"><span class="step-tag t-err">${esc(bi('报错', 'ERR'))}</span><span class="c-red truncate">${esc(st.snippet || 'Error')}</span></span>
          <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
        </div>`;
    }

    const toolText = summarizeToolsInline(st.tools);
    const mShort = compactModelShort(fmtModelLabel(st.model));
    const descMain = toolText
      ? `<span class="t-model shrink-0">${esc(mShort)}</span><span class="c-faint shrink-0">·</span><span class="t-tool mono fs-105 truncate">${esc(toolText)}</span>`
      : `<span class="t-model shrink-0">${esc(mShort)}</span>${st.snippet ? `<span class="c-faint shrink-0">·</span><span class="c-body truncate">${esc(st.snippet.slice(0, 64))}</span>` : ''}`;
    const sd = Number(st.contextDelta) || 0;
    const ctxCell = st.contextTokens ? `${fmtTok(st.contextTokens)}${sd ? ` ${fmtSignedTok(sd)}` : ''}` : '--';
    const ctxCls = sd > 20000 ? 'pos' : sd < 0 ? 'neg' : 't-ctx';

    const totalDur = stepTotalDurationSec(st);
    const ttft = Math.max(0, Number(st.ttftSec) || 0);
    const stream = Math.max(0, Number(st.streamSec) || 0);
    let wfBarHtml = '<span class="c-faint r flex-1">--</span>';
    if (totalDur > 0 && maxDurSec > 0) {
      const denom = Math.max(maxDurSec, totalDur, 0.1);
      const ttftPart = ttft > 0 ? Math.min(ttft, totalDur) : 0;
      const streamPart = ttft > 0
        ? (stream > 0 ? Math.min(stream, Math.max(0, totalDur - ttftPart)) : Math.max(0, totalDur - ttftPart))
        : totalDur;
      const ttftW = ttftPart > 0 ? Math.max(3, (ttftPart / denom) * 100) : 0;
      const rawStreamW = streamPart > 0 ? Math.max(3, (streamPart / denom) * 100) : 0;
      const streamW = Math.max(0, Math.min(rawStreamW, 100 - ttftW));
      wfBarHtml = `
        <div class="wf-track">
          ${ttftW > 0 ? `<span class="wf-seg wf-ttft ${ttftPart >= 15 ? 'is-slow' : ''}" style="width:${ttftW.toFixed(1)}%"></span>` : ''}
          ${streamW > 0 ? `<span class="wf-seg wf-stream" style="width:${streamW.toFixed(1)}%"></span>` : ''}
        </div>
        <span class="wf-dur">${esc(fmtSec(totalDur))}</span>`;
    } else if (ttft > 0) {
      wfBarHtml = `<span class="wf-dur c-dim">${esc(fmtTtft(ttft))}</span>`;
    }

    const rowTip = [
      `#${st.step} ${fmtModelLabel(st.model)} (${fmtTimeShort(st.ts)})`,
      `${bi('上下文', 'Context')}: ${fmtTok(st.contextTokens)}${sd ? ` (${fmtSignedTok(sd)})` : ''} · ↓${fmtTok(st.inputTokens)} ⚡${fmtTok(st.cacheReadTokens)} ↑${fmtTok(st.outputTokens)}`,
      [
        ttft > 0 ? `ttft ${fmtTtft(ttft)}` : '',
        stream > 0 ? `${bi('生成', 'Stream')} ${fmtSec(stream)}` : '',
        totalDur > 0 ? `${bi('总耗时', 'Total')} ${fmtSec(totalDur)}` : '',
        st.speedTokPerSec ? `${st.speedTokPerSec} tok/s` : '',
      ].filter(Boolean).join(' · '),
      st.tools?.length ? `${bi('工具', 'Tools')}: ${st.tools.join(', ')}` : '',
      st.snippet || '',
    ].filter(Boolean).join('\n');

    return `
      <div class="wf-row" title="${esc(rowTip)}">
        <span class="wf-node"><span class="wf-dot"></span></span>
        <span class="wf-num">#${st.step}</span>
        <span class="wf-desc">${descMain}</span>
        <span class="wf-ctx ${ctxCls}">${esc(ctxCell)}</span>
        <span class="wf-spd">${st.speedTokPerSec ? `${st.speedTokPerSec.toFixed(0)} t/s` : '<span class="c-faint">--</span>'}</span>
        <div class="wf-bar-cell">${wfBarHtml}</div>
      </div>`;
  }

  function renderInspectorModelsPanel(s) {
    const allModels = s.modelBreakdown || [];
    const seg = renderSegmented(
      [
        ['active', bi('正在使用', 'Active')],
        ['cost', bi('按费用', 'By Cost')],
        ['calls', bi('按调用', 'By Calls')],
      ],
      state.modelSortBy,
      'data-model-sort',
    );

    if (state.modelSortBy === 'active') {
      const activeModels = s.activeModelBreakdown || [];
      const ac = s.activeCycle || {};
      const rangeStr = fmtCycleRange(ac.startTs, ac.endTs);
      const cycleLabel = ac.source === 'fallback_5h'
        ? bi('近 5 小时', 'Last 5h')
        : (ac.matchedPools || []).length > 1
          ? bi('当前计费周期', 'Current billing cycle')
          : `${bi('本周期', 'Cycle')}${rangeStr ? ` ${rangeStr}` : ''}`;
      const poolsTip = (ac.pools || [])
        .map((p) => {
          const name = p.poolKey === 'gemini' ? 'Gemini' : 'Premium';
          const rng = fmtCycleRange(p.startTs, p.endTs);
          const rem = p.remainingPercent != null ? ` · ${bi('余量', 'left')} ${p.remainingPercent}%` : '';
          return `${name} (${p.periodHours >= 24 ? `${Math.round(p.periodHours / 24)}d` : `${p.periodHours}h`}): ${rng}${rem}`;
        })
        .join('\n');

      if (!activeModels.length) {
        return `
          <div class="stage-head">
            <div class="stage-meta tnum" title="${esc(poolsTip)}">${esc(cycleLabel)} · 0 ${esc(bi('个模型', 'models'))}</div>
            ${seg}
          </div>
          <div class="m-empty-box">
            <div>${esc(allModels.length
              ? bi(`当前计费周期内无模型调用（本会话历史共使用 ${allModels.length} 个模型）`, `No calls in the current billing cycle (${allModels.length} historical models in session)`)
              : bi('暂无模型调用明细', 'No model usage recorded'))}</div>
            ${allModels.length ? `<button class="link-btn" type="button" data-model-sort="cost">${esc(bi('查看会话全部模型 →', 'View all session models →'))}</button>` : ''}
          </div>`;
      }

      const activeDur = ac.totalDurationSec || 0;
      const activeCalls = ac.calls || activeModels.reduce((sum, m) => sum + (m.calls || 0), 0);
      return `
        <div class="stage-head">
          <div class="stage-meta tnum row-flex gap-xs wrap" title="${esc(poolsTip)}">
            <span class="dot sm green"></span>
            <span>${esc(cycleLabel)}</span>
            <span class="c-faint">·</span>
            <span>${activeModels.length} ${esc(bi('个模型', 'models'))}</span>
            <span class="c-faint">·</span>
            <span>${activeCalls.toLocaleString()} ${esc(bi('次调用', 'calls'))}</span>
            ${activeDur ? `<span class="c-faint">·</span><span>${esc(bi('累计', 'total'))} ${esc(fmtDuration(activeDur))}</span>` : ''}
          </div>
          ${seg}
        </div>
        ${renderModelPerfTable(activeModels, { sortBy: 'cost', liveModel: s.model, foldPrefix: 'active-model', autoExpandSingle: true })}`;
    }

    const totalDur = s.totals?.totalDurationSec || 0;
    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${allModels.length} ${esc(bi('个模型', 'models'))} · ${s.totals.calls.toLocaleString()} ${esc(bi('次调用', 'calls'))}${totalDur ? ` · ${esc(bi('累计', 'total'))} ${esc(fmtDuration(totalDur))}` : ''}</div>
        ${seg}
      </div>
      ${renderModelPerfTable(allModels, { sortBy: state.modelSortBy })}`;
  }

  function renderInspectorContextPanel(s) {
    const cb = s.contextBreakdown;
    if (!cb || !cb.totalUsed) {
      return `<div class="empty">${esc(bi('暂无上下文构成数据', 'No context breakdown available yet'))}</div>`;
    }
    const lim = Math.max(cb.limit || 1, cb.totalUsed || 1);
    const pctLim = (v) => ((v / lim) * 100).toFixed(1);
    const groups = cb.groups || [];
    const stackSegs = groups.map((g, idx) => {
      const w = Math.max(0.5, (g.tokens / lim) * 100);
      const col = CTX_GROUP_COLORS[idx % CTX_GROUP_COLORS.length];
      return `<div class="mix-seg" style="width:${w.toFixed(2)}%;background:${col}" title="${esc(`${localizeCtxGroup(g.key, g.name)}: ${fmtTok(g.tokens)} (${g.shareOfUsed}%)`)}"></div>`;
    }).join('');

    const rowsHtml = groups.map((g, idx) => {
      const col = CTX_GROUP_COLORS[idx % CTX_GROUP_COLORS.length];
      const label = localizeCtxGroup(g.key, g.name);
      const childFk = `ctx:${g.key || g.name}`;
      const hasChildren = g.children?.length > 0;
      const bodyRow = `
        <div class="ctx-grid" title="${esc(`${label}: ${fmtTok(g.tokens)} · ${bi('占已用', 'Used')} ${g.shareOfUsed}% · ${bi('占上限', 'Limit')} ${g.shareOfLimit}%`)}">
          <span class="row-flex gap-xs min-w-0 fw-500 fs-12 c-fg">
            ${hasChildren ? CHEV_SVG : '<span class="chev-pad"></span>'}
            <span class="dot sm" style="background:${col}"></span>
            <span class="truncate">${esc(label)}</span>
            ${hasChildren ? `<span class="c-dim fs-10 tnum">(${g.children.length})</span>` : ''}
          </span>
          <div class="ctx-inline-bar"><div class="ctx-group-bar-fill" style="width:${Math.max(2, g.shareOfUsed).toFixed(1)}%;background:${col}"></div></div>
          <span class="tnum fs-12 t-ctx r">${fmtTok(g.tokens)}</span>
          <span class="tnum fs-12 fw-500 c-fg r">${g.shareOfUsed}%</span>
        </div>`;

      if (!hasChildren) return `<div class="ctx-static-row">${bodyRow}</div>`;
      return `
        <details class="ctx-fold-row" data-fold-key="${esc(childFk)}" ${isFoldOpen(childFk) ? 'open' : ''}>
          <summary>${bodyRow}</summary>
          <div class="ctx-child-list">${g.children.map((c) => `
            <div class="ctx-child-row">
              <span class="ctx-child-name" title="${esc(localizeCtxChild(c.name))}">${esc(localizeCtxChild(c.name))}</span>
              <span class="ctx-child-val">${fmtTok(c.tokens)}</span>
              <span class="ctx-child-pct">${c.shareOfUsed}%</span>
            </div>`).join('')}
          </div>
        </details>`;
    }).join('');

    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${esc(cb.source === 'ls' ? bi('精确统计', 'Exact Breakdown') : bi('窗口估算', 'Estimated Breakdown'))} · ${fmtTok(s.contextUsed)} / ${fmtTok(s.contextLimit)} (${s.usagePercent.toFixed(1)}%)</div>
      </div>
      <div class="mix-bar lg">${stackSegs}</div>
      <div class="metric-band compact cols-4 mt-md">
        <div class="metric-item"><div class="metric-lbl">${esc(bi('缓存命中', 'Cached'))} · ${pctLim(cb.cacheReadTokens)}%</div><div class="metric-val fs-13 t-in">${fmtTok(cb.cacheReadTokens)}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('新增输入', 'Fresh In'))} · ${pctLim(cb.inputTokens)}%</div><div class="metric-val fs-13 t-in">${fmtTok(cb.inputTokens)}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('输出', 'Output'))} · ${pctLim(cb.outputTokens)}%</div><div class="metric-val fs-13 t-out">${fmtTok(cb.outputTokens)}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('剩余窗口', 'Remaining'))} · ${pctLim(cb.remainingTokens)}%</div><div class="metric-val fs-13 c-green">${fmtTok(cb.remainingTokens)}</div></div>
      </div>
      <div class="ctx-grid ctx-head-row mt-md">
        <span>${esc(bi('构成类别', 'Category'))}</span>
        <span>${esc(bi('占比分布', 'Share'))}</span>
        <span class="r">Tokens</span>
        <span class="r">${esc(bi('占比', 'Share'))}</span>
      </div>
      <div class="hairline-list">${rowsHtml}</div>`;
  }

  function renderInspectorStepsPanel(s) {
    const ss = s.stepSummary || {};
    const turns = Array.isArray(s.mainTurns) ? s.mainTurns : [];
    if (!turns.length && !(ss.total > 0)) {
      return `<div class="empty">${esc(bi('暂无对话轮次记录', 'No turns recorded yet'))}</div>`;
    }
    const cpTurnCount = turns.filter((tr) => tr.checkpoints > 0).length;
    const errTurnCount = turns.filter((tr) => tr.errors > 0).length;
    if (state.turnFilter === 'checkpoint' && cpTurnCount === 0) state.turnFilter = 'all';
    if (state.turnFilter === 'error' && errTurnCount === 0) state.turnFilter = 'all';

    const filteredTurns = state.turnFilter === 'checkpoint'
      ? turns.filter((tr) => tr.checkpoints > 0)
      : state.turnFilter === 'error'
        ? turns.filter((tr) => tr.errors > 0)
        : turns;

    const visibleTurns = filteredTurns.slice(0, state.turnLimit);
    const remaining = Math.max(0, filteredTurns.length - visibleTurns.length);

    const filterBtns = [];
    if (cpTurnCount > 0 || errTurnCount > 0) {
      filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'all' ? 'active' : ''}" type="button" data-turn-filter="all">${esc(bi('全部', 'All'))} <span class="mono">${turns.length}</span></button>`);
      if (cpTurnCount > 0) {
        filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'checkpoint' ? 'active' : ''}" type="button" data-turn-filter="checkpoint" title="${esc(bi(`会话累计 ${ss.checkpoint || cpTurnCount} 次压缩，最近 30 轮中 ${cpTurnCount} 轮触发`, `${ss.checkpoint || cpTurnCount} total compactions; ${cpTurnCount} in recent turns`))}"><span class="dot sm amber"></span>${esc(bi('压缩', 'CP'))} <span class="mono">${cpTurnCount}</span></button>`);
      }
      if (errTurnCount > 0) {
        filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'error' ? 'active' : ''}" type="button" data-turn-filter="error" title="${esc(bi(`主会话累计 ${ss.error || errTurnCount} 次报错，最近 30 轮中 ${errTurnCount} 轮出现`, `${ss.error || errTurnCount} total main errors; ${errTurnCount} in recent turns`))}"><span class="dot sm red"></span>${esc(bi('报错', 'Err'))} <span class="mono">${errTurnCount}</span></button>`);
      }
    }

    const isRunning = s.runState === 'RUN_STATE_RUNNING';
    const turnsHtml = visibleTurns.map((tr, idx) => {
      const turnFk = `turn:${s.conversationId}:${tr.turn}`;
      const steps = Array.isArray(tr.steps) ? tr.steps : [];
      const latest = steps[0] || null;
      const dVal = Number(tr.contextDelta) || 0;
      const maxDurSec = steps.reduce((mx, st) => Math.max(mx, st.type === 'PLANNER_RESPONSE' ? stepTotalDurationSec(st) : 0), 0);
      const hasTimedSteps = maxDurSec > 0;
      const stepRowsHtml = steps.map((st) => renderStepRow(st, maxDurSec)).join('');
      const rowTs = tr.lastTs || latest?.ts || tr.ts || '';
      const fullTs = rowTs ? fmtLocalDateTime(rowTs) : '';
      const isLatestOverall = idx === 0 && state.turnFilter === 'all';
      const nodeCls = isLatestOverall && isRunning
        ? 'is-live'
        : tr.errors > 0
          ? 'is-err'
          : tr.checkpoints > 0
            ? 'is-cp'
            : isLatestOverall
              ? 'is-latest'
              : '';

      const renderLatestHeadline = (st) => {
        if (!st) return `<span class="c-dim">${esc(bi(`第 ${tr.turn} 轮`, `Turn ${tr.turn}`))}</span>`;
        if (st.type === 'CHECKPOINT') {
          const freed = st.beforeTokens > 0 && st.afterTokens > 0 ? st.beforeTokens - st.afterTokens : 0;
          const cpTxt = st.beforeTokens > 0
            ? `${bi('上下文压缩', 'Compacted')} ${fmtTok(st.beforeTokens)} → ${st.afterTokens > 0 ? fmtTok(st.afterTokens) : '--'}${freed > 0 ? ` (-${fmtTok(freed)})` : ''}`
            : bi('触发上下文压缩', 'Compaction checkpoint');
          return `<span class="step-tag t-cp">${esc(bi('压缩', 'CP'))}</span><span class="c-amber truncate">${esc(cpTxt)}</span>`;
        }
        if (st.type === 'ERROR_MESSAGE') {
          return `<span class="step-tag t-err">${esc(bi('报错', 'ERR'))}</span><span class="c-red truncate">${esc(st.snippet || 'Error')}</span>`;
        }
        if (st.type === 'USER_INPUT') {
          return `<span class="step-tag t-user">${esc(bi('用户', 'USER'))}</span><span class="c-fg truncate">${esc(st.snippet || bi('用户输入', 'User input'))}</span>`;
        }
        const mShort = compactModelShort(fmtModelLabel(st.model));
        const toolText = summarizeToolsInline(st.tools);
        if (toolText) {
          return `<span class="t-model fw-500 shrink-0">${esc(mShort)}</span><span class="c-faint shrink-0">·</span><span class="t-tool mono fs-11 truncate">${esc(toolText)}</span>`;
        }
        return `<span class="t-model fw-500 shrink-0">${esc(mShort)}</span>${st.snippet ? `<span class="c-faint shrink-0">·</span><span class="c-body truncate">${esc(st.snippet.slice(0, 76))}</span>` : ''}`;
      };

      const latestTip = [
        `T${tr.turn}${latest?.step ? ` · #${latest.step}` : ''}`,
        tr.prompt ? `${bi('用户输入', 'Prompt')}: ${tr.prompt}` : '',
        latest?.tools?.length ? `${bi('最新工具', 'Latest tools')}: ${latest.tools.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const turnSummaryStrip = renderKvStrip([
        { label: bi('调用 / 工具', 'Calls / Tools'), val: `${tr.plannerCalls}<span class="u">${esc(bi('次', 'c'))}</span> · <span class="t-tool">${tr.toolExecs || 0}</span><span class="u">${esc(bi('工具', 't'))}</span>` },
        { label: bi('上下文', 'Context'), val: tr.endContextTokens ? `<span class="t-ctx">${fmtTok(tr.endContextTokens)}</span>` : '--', sub: dVal ? `<span class="${dVal < 0 ? 'c-green' : dVal >= 50000 ? 'c-amber' : ''}">${fmtSignedTok(dVal)}</span>` : '' },
        { label: bi('速率', 'Speed'), val: tr.avgSpeedTokPerSec ? `<span class="t-speed">${tr.avgSpeedTokPerSec.toFixed(0)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: tr.avgTtftSec ? `ttft ${esc(fmtTtft(tr.avgTtftSec))}` : (tr.plannerCalls > 0 && tr.totalDurationSec > 0 ? esc(bi(`平均耗时 ${fmtSec(tr.totalDurationSec / tr.plannerCalls)}`, `avg ${fmtSec(tr.totalDurationSec / tr.plannerCalls)}`)) : '') },
        { label: bi('费用', 'Cost'), val: tr.cost > 0 ? `<span class="t-cost">${fmtCost(tr.cost)}</span>` : '<span class="c-faint">--</span>', sub: tr.totalDurationSec ? esc(fmtDuration(tr.totalDurationSec)) : esc(fullTs.slice(11, 16)) },
      ]);

      const nonUserStepCount = steps.filter((x) => x.type !== 'USER_INPUT').length;
      const deltaCls = dVal < 0 ? 'c-green' : dVal >= 40000 ? 'c-amber' : 'c-dim';
      const ctxMetaHtml = tr.endContextTokens
        ? `<span class="t-ctx">${fmtTok(tr.endContextTokens)}</span>${dVal ? ` <span class="${deltaCls}">(${fmtSignedTok(dVal)})</span>` : ''}`
        : '';

      return `
        <details class="tl-turn ${tr.checkpoints ? 'has-cp' : ''}" data-fold-key="${esc(turnFk)}" ${isFoldOpen(turnFk) ? 'open' : ''}>
          <summary class="tl-turn-head" title="${esc(latestTip)}">
            <span class="tl-node ${nodeCls}"></span>
            <div class="tl-line1">
              <div class="tl-headline">
                ${CHEV_SVG}
                ${renderLatestHeadline(latest)}
              </div>
              <div class="tl-right">
                ${tr.cost > 0 ? `<span class="t-cost fw-500">${fmtCost(tr.cost)}</span>` : ''}
                <span class="tl-time" title="${esc(fullTs)}">${esc(fmtTimeHM(rowTs))}</span>
              </div>
            </div>
            <div class="tl-line2">
              <span class="tl-turn-id">T${tr.turn}</span>
              ${latest?.step ? `<span class="mono c-faint">#${latest.step}</span>` : ''}
              ${nonUserStepCount > 0 ? `<span class="tl-sep">·</span><span>${nonUserStepCount} ${esc(bi('步', 'steps'))}</span>` : ''}
              ${ctxMetaHtml ? `<span class="tl-sep">·</span><span>${ctxMetaHtml}</span>` : ''}
              ${tr.checkpoints && latest?.type !== 'CHECKPOINT' ? `<span class="turn-flag cp" title="${esc(bi(`本轮触发 ${tr.checkpoints} 次上下文压缩`, `${tr.checkpoints} compaction(s)`))}">⚡${esc(bi('压缩', 'CP'))}${tr.checkpoints > 1 ? ` ×${tr.checkpoints}` : ''}</span>` : ''}
              ${tr.errors && latest?.type !== 'ERROR_MESSAGE' ? `<span class="turn-flag err" title="${esc(bi(`本轮出现 ${tr.errors} 次报错`, `${tr.errors} error(s)`))}">${tr.errors} ${esc(bi('报错', 'err'))}</span>` : ''}
            </div>
          </summary>

          <div class="tl-turn-body">
            ${turnSummaryStrip}
            ${stepRowsHtml
              ? `<div class="wf-head">
                  <span>${esc(bi('步骤轨迹 · 倒序至用户输入', 'Step Trace · Newest → User'))}</span>
                  ${hasTimedSteps ? `<span class="wf-legend"><span class="wf-leg-chip"><span class="wf-leg-sw ttft"></span>TTFT</span><span class="wf-leg-chip"><span class="wf-leg-sw stream"></span>${esc(bi('生成', 'Stream'))}</span></span>` : ''}
                </div>
                <div class="wf-list">${stepRowsHtml}</div>`
              : `<div class="card-sub pad-xs mt-sm">${esc(bi('本轮暂无模型步骤记录', 'No steps recorded in this turn'))}</div>`}
          </div>
        </details>`;
    }).join('');

    const pagerHtml = remaining > 0
      ? `<div class="turn-pager"><button class="link-btn" type="button" data-action="more-turns">${esc(bi(`加载更多轮次（还有 ${remaining} 轮）`, `Load more turns (${remaining} remaining)`))}</button></div>`
      : (filteredTurns.length > 10 && state.turnLimit > 10
          ? `<div class="turn-pager"><button class="link-btn" type="button" data-action="reset-turns">${esc(bi('收起至最新 10 轮', 'Show latest 10 turns'))}</button></div>`
          : '');

    return `
      <div class="steps-toolbar">
        <div class="stage-meta tnum">
          <span class="c-fg fw-500">#${(ss.maxStep || ss.total || 0).toLocaleString()}</span> ${esc(bi('总步数', 'steps'))} ·
          ${esc(bi('本窗口', 'Window'))} <span class="c-body">${(ss.sinceCheckpoint || 0).toLocaleString()}</span>
        </div>
        ${filterBtns.length ? `<div class="row-flex gap-xs wrap">${filterBtns.join('')}</div>` : ''}
      </div>
      <div class="turn-timeline">${turnsHtml}</div>
      ${pagerHtml}`;
  }

  function renderInspectorToolsPanel(s) {
    const list = s.toolRanking || [];
    if (!list.length) {
      return `<div class="empty">${esc(bi('暂无工具调用记录', 'No tool calls recorded'))}</div>`;
    }
    const maxTool = list[0]?.count || 1;
    const totalTools = Math.max(1, s.totals.toolCalls || list.reduce((a, r) => a + r.count, 0));
    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${esc(bi('主会话 + 全部子代理合计', 'Main + All Subagents'))} · ${totalTools.toLocaleString()} ${esc(bi('次调用', 'calls'))} · ${list.length} ${esc(bi('种工具', 'tools'))}</div>
      </div>
      <div class="rank-list">${list.slice(0, 15).map((r, idx) => {
        const share = (r.count / totalTools) * 100;
        return `
          <div class="rank-row">
            <span class="rank-idx">${String(idx + 1).padStart(2, '0')}</span>
            <span class="rank-name" title="${esc(r.name)}">${esc(r.name)}</span>
            <div class="rank-bar-bg"><div class="rank-bar-fg" style="width:${Math.max(3, (r.count / maxTool) * 100).toFixed(1)}%"></div></div>
            <span class="rank-share">${share.toFixed(1)}%</span>
            <span class="rank-val">${r.count.toLocaleString()}</span>
          </div>`;
      }).join('')}</div>`;
  }

  function renderInspectorSubagentsPanel(s) {
    const subs = s.subagents || [];
    if (!subs.length) {
      return `<div class="empty">${esc(bi('当前会话未派生子代理', 'No subagents spawned in this session'))}</div>`;
    }
    const subCalls = subs.reduce((a, x) => a + (x.calls || 0), 0);
    const subCost = subs.reduce((a, x) => a + (x.cost || 0), 0);
    const runningCount = subs.filter((x) => x.runState === 'RUN_STATE_RUNNING').length;
    const SUB_LIMIT = 10;
    const visible = state.showAllSubagents ? subs : subs.slice(0, SUB_LIMIT);
    const hidden = Math.max(0, subs.length - visible.length);

    const headerRow = `
      <div class="sub-tbl-grid sub-tbl-head">
        <span>${esc(bi('子代理', 'Subagent'))}</span>
        <span>${esc(bi('上下文', 'Context'))}</span>
        <span class="r">${esc(bi('费用', 'Cost'))}</span>
        <span class="r"></span>
      </div>`;

    const rowsHtml = visible.map((sub) => {
      const isRunning = sub.runState === 'RUN_STATE_RUNNING';
      const ctxCol = pctColor(sub.usagePercent || 0, false);
      const pctCls = ctxCol === 'accent' ? 'c-dim' : `c-${ctxCol} fw-500`;
      const extraFk = `sub-extra:${sub.id}`;
      const modelShort = compactModelShort(fmtModelLabel(sub.model));
      const ctxTip = `${fmtTok(sub.contextUsed)} / ${fmtTok(sub.contextLimit)} (${sub.usagePercent.toFixed(1)}%)`;
      const subTotalIn = (sub.inputTokens || 0) + (sub.cacheReadTokens || 0);
      const subSpeedSub = [
        sub.avgTtftSec ? `ttft ${fmtTtft(sub.avgTtftSec)}` : '',
        sub.avgLatencySec ? bi(`平均耗时 ${fmtSec(sub.avgLatencySec)}`, `avg ${fmtSec(sub.avgLatencySec)}`) : '',
      ].filter(Boolean).join(' · ');
      const subStrip = renderKvStrip([
        { label: bi('上下文', 'Context'), val: `<span class="t-ctx">${fmtTok(sub.contextUsed)}</span><span class="u">/${fmtTok(sub.contextLimit)}</span>`, sub: `${sub.usagePercent.toFixed(1)}% · <span class="t-model">${esc(modelShort)}</span>` },
        { label: bi('调用 / 工具', 'Calls / Tools'), val: `${sub.calls}<span class="u">${esc(bi('次', 'c'))}</span> · <span class="t-tool">${sub.toolCount}</span><span class="u">${esc(bi('工具', 't'))}</span>`, sub: sub.agentType ? esc(sub.agentType) : '' },
        { label: bi('输入 / 输出', 'In / Out'), val: `<span class="t-in">↓${fmtTok(subTotalIn)}</span> <span class="c-faint">/</span> <span class="t-out">↑${fmtTok(sub.outputTokens)}</span>`, sub: sub.cacheHitPercent != null ? `${esc(bi('缓存', 'cache'))} ${sub.cacheHitPercent}%` : '' },
        { label: bi('速率', 'Speed'), val: sub.outputTokensPerSec ? `<span class="t-speed">${sub.outputTokensPerSec.toFixed(1)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: esc(subSpeedSub) },
      ]);

      return `
        <details class="sub-tbl-item ${isRunning ? 'is-running' : ''}" data-fold-key="${esc(extraFk)}" ${isFoldOpen(extraFk) ? 'open' : ''}>
          <summary>
            <div class="sub-tbl-grid sub-tbl-row">
              <div class="sess-title-line">
                ${CHEV_SVG}
                ${isRunning ? '<span class="dot sm green pulse-dot"></span>' : ''}
                <span class="sess-title" title="${esc(sub.title)}">${esc(sub.title)}</span>
                <span class="t-model fs-11 shrink-0">${esc(modelShort)}</span>
              </div>
              <div class="inline-gauge" title="${esc(ctxTip)}">
                <div class="inline-gauge-track"><div class="bar-fill ${ctxCol}" style="width:${Math.min(100, sub.usagePercent).toFixed(1)}%"></div></div>
                <span class="inline-gauge-pct ${pctCls}">${sub.usagePercent.toFixed(0)}%</span>
              </div>
              <div class="r tnum fs-125 ${sub.cost > 0 ? 't-cost fw-500' : 'c-faint'}">${sub.cost > 0 ? fmtCost(sub.cost) : '--'}</div>
              <div class="sess-acts">
                <button class="ghost-btn icon-sq" type="button" data-jump-conv="${esc(sub.id)}" title="${esc(bi('跳转到该子代理', 'Open subagent'))}">↗</button>
              </div>
            </div>
          </summary>
          <div class="sub-tbl-expand">
            ${subStrip}
            ${sub.modelBreakdown?.length > 1 ? `<div class="mt-sm">${renderModelPerfTable(sub.modelBreakdown, { compact: true })}</div>` : ''}
            ${sub.topTools?.length ? `<div class="sub-tools">${sub.topTools.map((x) => `<span class="quiet-chip mono"><span class="t-tool">${esc(x.name)}</span> ×${x.count}</span>`).join('')}</div>` : ''}
          </div>
        </details>`;
    }).join('');

    const moreBtn = subs.length > SUB_LIMIT
      ? `<button class="link-btn mt-sm" type="button" data-action="toggle-subs">${esc(
          state.showAllSubagents
            ? bi(`收起子代理列表（仅显示前 ${SUB_LIMIT} 个）`, `Show top ${SUB_LIMIT} subagents`)
            : bi(`展开其余 ${hidden} 个子代理（共 ${subs.length} 个）`, `Show ${hidden} more subagents (${subs.length} total)`),
        )}</button>`
      : '';

    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${runningCount ? `<span class="c-green fw-600">${runningCount} ${esc(bi('运行中', 'running'))}</span> · ` : ''}${subs.length} ${esc(bi('个子代理', 'subagents'))} · ${subCalls.toLocaleString()} ${esc(bi('次调用', 'calls'))}${subCost > 0 ? ` · <span class="t-cost fw-600">${fmtCost(subCost)}</span>` : ''}</div>
      </div>
      ${headerRow}
      <div class="hairline-list">${rowsHtml}</div>
      ${moreBtn}`;
  }

  function renderInspectorErrorsPanel(s) {
    const sum = s.errorSummary || { total: s.errors?.length || 0, mainCount: 0, subagentCount: 0, latestTs: s.errors?.[0]?.ts || '', byCategory: [] };
    if (!sum.total) {
      return `<div class="empty c-green">${esc(bi('本次会话运行平稳，暂无报错记录', 'Session is healthy — no errors recorded'))}</div>`;
    }
    const cats = sum.byCategory || [];
    if (state.errCategoryFilter !== 'all' && !cats.some((c) => c.key === state.errCategoryFilter)) {
      state.errCategoryFilter = 'all';
    }

    const mixSegs = cats.map((c) => {
      const share = (c.count / sum.total) * 100;
      const col = ERR_CAT_COLORS[c.key] || ERR_CAT_COLORS.other;
      return `<div class="mix-seg" style="width:${Math.max(1.5, share).toFixed(2)}%;background:${col}" title="${esc(`${errCategoryLabel(c.key)}: ${c.count} (${share.toFixed(0)}%)`)}"></div>`;
    }).join('');

    const filterPills = `
      <div class="err-filter-bar">
        <button class="filter-pill ${state.errCategoryFilter === 'all' ? 'active' : ''}" type="button" data-err-cat="all">${esc(bi('全部', 'All'))} <span class="mono">${sum.total}</span></button>
        ${cats.map((c) => {
          const col = ERR_CAT_COLORS[c.key] || ERR_CAT_COLORS.other;
          const share = Math.round((c.count / sum.total) * 100);
          return `<button class="filter-pill ${state.errCategoryFilter === c.key ? 'active' : ''}" type="button" data-err-cat="${esc(c.key)}">
            <span class="dot sm" style="background:${col}"></span>
            ${esc(errCategoryLabel(c.key))} <span class="mono">${c.count}</span> <span class="c-dim fs-10">${share}%</span>
          </button>`;
        }).join('')}
      </div>`;

    const visibleErrors = (s.errors || []).filter((e) => state.errCategoryFilter === 'all' || (e.category || 'other') === state.errCategoryFilter);
    const listHtml = visibleErrors.map((e) => {
      const errFk = `err:${e.convId || ''}:${e.step}:${e.ts || ''}`;
      const col = ERR_CAT_COLORS[e.category || 'other'] || ERR_CAT_COLORS.other;
      return `
        <details class="err-row" data-fold-key="${esc(errFk)}" ${isFoldOpen(errFk) ? 'open' : ''}>
          <summary>
            <span class="row-flex gap-xs min-w-0">
              ${CHEV_SVG}
              <span class="err-cat-tag" style="--cat-col:${col}">${esc(errCategoryLabel(e.category || 'other'))}</span>
              <span class="err-row-msg" title="${esc(e.message)}">${esc(e.message.replace(/\s+/g, ' ').slice(0, 110))}</span>
            </span>
            <span class="err-row-meta mono">${esc(fmtTimeShort(e.ts))} · #${e.step}</span>
          </summary>
          <div class="err-row-body">
            <div class="card-sub">${esc(bi('来源', 'Source'))}: ${esc(e.source)}${e.ts ? ` · ${esc(fmtLocalDateTime(e.ts))}` : ''}</div>
            <pre class="err-pre">${esc(e.message)}</pre>
          </div>
        </details>`;
    }).join('');

    return `
      <div class="stage-head">
        <div class="stage-meta tnum">
          <strong class="c-red">${sum.total} ${esc(bi('条报错', 'errors'))}</strong> ·
          ${esc(bi('主会话', 'Main'))} ${sum.mainCount} ·
          ${esc(bi('子代理', 'Sub'))} ${sum.subagentCount}
          ${sum.latestTs ? ` · ${esc(bi('最近', 'Last'))} ${esc(fmtTimeShort(sum.latestTs))}` : ''}
        </div>
      </div>
      <div class="mix-bar">${mixSegs}</div>
      ${filterPills}
      <div class="hairline-list">${listHtml}</div>`;
  }

  function renderSessionInspector(s) {
    const t = s.totals;
    const errTotal = s.errorSummary?.total ?? t.errorCount ?? 0;
    const ctxCol = pctColor(s.usagePercent, false);
    const runningSubs = t.runningSubagents || 0;

    const totalModels = (s.modelBreakdown || []).length;
    const activeModels = (s.activeModelBreakdown || []).length;
    const modelVal = activeModels > 0 && activeModels < totalModels ? `${activeModels}/${totalModels}` : `${totalModels}`;

    const tabs = [
      { id: 'models', label: bi('模型', 'Models'), val: modelVal, cls: '' },
      { id: 'context', label: bi('上下文', 'Context'), val: `${s.usagePercent.toFixed(0)}%`, cls: ctxCol === 'accent' ? '' : `c-${ctxCol}` },
      { id: 'steps', label: bi('轨迹', 'Trace'), val: `${s.turns}`, cls: '' },
      { id: 'tools', label: bi('工具', 'Tools'), val: fmtTok(t.toolCalls), cls: '' },
      { id: 'subagents', label: bi('子代理', 'Subagents'), val: `${t.subagentCount}`, cls: runningSubs ? 'c-green' : '', dot: runningSubs > 0 },
      { id: 'errors', label: bi('报错', 'Errors'), val: `${errTotal}`, cls: errTotal > 0 ? 'c-red' : 'c-dim' },
    ];

    const stageHtml = {
      models: () => renderInspectorModelsPanel(s),
      context: () => renderInspectorContextPanel(s),
      steps: () => renderInspectorStepsPanel(s),
      tools: () => renderInspectorToolsPanel(s),
      subagents: () => renderInspectorSubagentsPanel(s),
      errors: () => renderInspectorErrorsPanel(s),
    }[state.inspectorTab]?.() || renderInspectorModelsPanel(s);

    const isFlushStage = state.inspectorTab === 'steps';
    return `
      <section class="inspector">
        <div class="insp-nav" role="tablist">
          ${tabs.map((tb) => `
            <button class="insp-tab ${state.inspectorTab === tb.id ? 'active' : ''}" type="button" role="tab" data-insp-tab="${tb.id}">
              <span class="insp-tab-lbl">${tb.dot ? '<span class="dot sm green"></span>' : ''}${esc(tb.label)}</span>
              <span class="insp-tab-val ${tb.cls}">${esc(tb.val)}</span>
            </button>`).join('')}
        </div>
        <div class="insp-stage ${isFlushStage ? 'flush' : ''}">${stageHtml}</div>
      </section>`;
  }

  function renderSessionTab(el) {
    const ov = state.overview;
    if (!ov || !ov.session) {
      state.lastSessionSig = '';
      el.dataset.renderedTab = 'session';
      el.innerHTML = `<div class="card empty">${esc(bi('尚未定位到活跃会话。打开任意对话后将自动显示监控数据。', 'No active conversation detected yet.'))}</div>`;
      return;
    }
    const s = ov.session;
    const t = s.totals;
    if (s.conversationId !== state.lastSessionConvId) {
      state.lastSessionConvId = s.conversationId;
      state.showAllSubagents = false;
      state.turnLimit = 10;
      state.turnFilter = 'all';
      state.errCategoryFilter = 'all';
    }

    const sig = JSON.stringify([
      state.lang, state.inspectorTab, state.modelSortBy, state.showAllSubagents, state.turnLimit, state.turnFilter, state.errCategoryFilter,
      s.conversationId, s.runState, s.model, s.contextUsed, s.contextLimit, s.turns, s.checkpoints,
      s.stepSummary?.maxStep, s.stepSummary?.total, (s.mainTurns || []).length, s.mainTurns?.[0]?.endStep,
      s.contextBreakdown?.source, (s.contextBreakdown?.groups || []).length,
      t.calls, t.inputTokens, t.cacheReadTokens, t.outputTokens,
      t.outputTokensPerSec, t.avgTtftSec, t.avgLatencySec, Math.round((t.cost || 0) * 10000),
      t.errorCount, t.toolCalls, (s.modelBreakdown || []).length,
      s.activeCycle?.modelCount, s.activeCycle?.calls, Math.round((s.activeCycle?.cost || 0) * 10000), s.activeCycle?.endTs,
      (s.subagents || []).map((x) => [x.id, x.runState, x.model, x.calls, x.contextUsed, Math.round((x.cost || 0) * 100), x.outputTokensPerSec, x.avgTtftSec]),
      getChartPlotWidth(),
    ]);
    if (el.dataset.renderedTab === 'session' && state.lastSessionSig === sig) return;
    state.lastSessionSig = sig;
    el.dataset.renderedTab = 'session';

    const cacheTotal = t.inputTokens + t.cacheReadTokens;
    const cacheHit = cacheTotal > 0 ? ((t.cacheReadTokens / cacheTotal) * 100).toFixed(1) : '0.0';
    const ctxCol = pctColor(s.usagePercent, false);
    const peakCtx = (s.contextPoints || []).reduce((m, p) => Math.max(m, p.contextTokens || 0), s.contextUsed || 0);
    const isInspectingOther = Boolean(state.hostConvId && state.convId && state.convId !== state.hostConvId);
    const cpTip = s.lastCheckpointBeforeTokens > 0
      ? bi(`最近压缩：${fmtTok(s.lastCheckpointBeforeTokens)} → ${fmtTok(s.lastCheckpointAfterTokens)}`, `Last compaction: ${fmtTok(s.lastCheckpointBeforeTokens)} → ${fmtTok(s.lastCheckpointAfterTokens)}`)
      : '';
    const tokenTip = `${bi('总输入', 'Total In')}: ${fmtTok(cacheTotal)} (${bi('新增', 'fresh')} ${fmtTok(t.inputTokens)} + ${bi('缓存', 'cache')} ${fmtTok(t.cacheReadTokens)}, ${cacheHit}%) · ${bi('输出', 'Output')}: ${fmtTok(t.outputTokens)} (${bi('均', 'avg')} ${fmtTok(t.avgOutputPerCall)}/${bi('次', 'c')})`;
    const speedTip = bi(
      `端到端输出速率（含思考与 TTFT）${t.avgTtftSec ? `；平均 TTFT ${fmtTtft(t.avgTtftSec)}${t.lastTtftSec ? `，最新 ${fmtTtft(t.lastTtftSec)}` : ''}` : ''}${t.avgLatencySec ? `；单次平均耗时 ${fmtSec(t.avgLatencySec)}` : ''}`,
      `End-to-end output speed (incl. thinking & TTFT)${t.avgTtftSec ? `; avg TTFT ${fmtTtft(t.avgTtftSec)}${t.lastTtftSec ? `, last ${fmtTtft(t.lastTtftSec)}` : ''}` : ''}${t.avgLatencySec ? `; avg latency ${fmtSec(t.avgLatencySec)}/call` : ''}`,
    );
    const heroSpeedSub = [
      t.avgTtftSec ? `ttft ${fmtTtft(t.avgTtftSec)}` : '',
      t.avgLatencySec ? bi(`平均耗时 ${fmtSec(t.avgLatencySec)}`, `avg ${fmtSec(t.avgLatencySec)}`) : '',
    ].filter(Boolean).join(' · ') || '--';

    const prevScroll = window.scrollY;
    el.innerHTML = `
      ${isInspectingOther ? `
        <div class="inspect-banner">
          <span>${esc(bi('正在查看历史会话监控', 'Inspecting historical session'))}</span>
          <button class="icon-btn" type="button" data-action="back-active">${esc(bi('返回当前对话', 'Back to Active Chat'))}</button>
        </div>` : ''}

      <section class="card card-hero">
        <div class="card-head">
          <div class="min-w-0">
            <div class="session-title" title="${esc(s.title)}">${esc(s.title)}</div>
            <div class="card-sub mt-xs"><span class="t-model">${esc(fmtModelLabel(s.model))}</span> · ${s.turns} ${esc(bi('轮对话', 'turns'))}${s.checkpoints ? ` · <span class="c-amber" title="${esc(cpTip)}">${s.checkpoints} ${esc(bi('次压缩', 'compactions'))}</span>` : ''}${t.errorCount ? ` · <span class="c-red">${t.errorCount} ${esc(bi('报错', 'err'))}</span>` : ''}</div>
          </div>
          <span class="status-tag ${s.runState === 'RUN_STATE_RUNNING' ? 'running' : ''}">
            <span class="dot ${s.runState === 'RUN_STATE_RUNNING' ? 'green' : 'dim'}"></span>
            ${esc(s.runState === 'RUN_STATE_RUNNING' ? bi('运行中', 'Running') : bi('空闲', 'Idle'))}
          </span>
        </div>

        <div class="bar-wrap">
          <div class="hero-reading">
            <div class="hero-reading-main">
              <span class="hero-num ${ctxCol === 'accent' ? 't-ctx' : `c-${ctxCol}`}">${fmtTok(s.contextUsed)}</span>
              <span class="hero-den">/ ${fmtTok(s.contextLimit)} tokens</span>
            </div>
            <span class="hero-pct ${ctxCol === 'accent' ? 'c-fg' : `c-${ctxCol}`}">${s.usagePercent.toFixed(1)}%</span>
          </div>
          <div class="bar-wrap-wm">
            <div class="bar-track bar-lg"><div class="bar-fill ${ctxCol}" style="width:${Math.min(100, s.usagePercent).toFixed(1)}%"></div></div>
            ${s.contextLimit > 200000
              ? `<span class="wm-tick ${s.contextUsed >= 200000 ? 'exceeded' : ''}" tabindex="0" style="left:${((200000 / s.contextLimit) * 100).toFixed(2)}%"><span class="wm-tip">${esc(s.contextUsed >= 200000 ? bi(`200k 长上下文线 · 超出 ${fmtTok(s.contextUsed - 200000)}`, `200k tier · +${fmtTok(s.contextUsed - 200000)}`) : bi('200k 长上下文阶梯线', '200k long-context tier'))}</span></span>`
              : ''}
          </div>
        </div>

        <div class="metric-well mt-lg">
          <div class="metric-band cols-4">
            <div class="metric-item">
              <div class="metric-lbl">${esc(bi('总调用', 'Calls'))}</div>
              <div class="metric-val">${t.calls.toLocaleString()}</div>
              <div class="metric-sub">${t.subagentCount ? esc(bi(`主 ${s.mainCalls} · ${t.subagentCount} 子代理`, `M ${s.mainCalls} · ${t.subagentCount} sub`)) : esc(bi('仅主会话', 'Main only'))}</div>
            </div>
            <div class="metric-item" title="${esc(tokenTip)}">
              <div class="metric-lbl">${esc(bi('缓存命中', 'Cache Hit'))}</div>
              <div class="metric-val t-in">${cacheHit}<span class="u">%</span></div>
              <div class="metric-sub"><span class="t-in">↓${fmtTok(cacheTotal)}</span> · <span class="t-out">↑${fmtTok(t.outputTokens)}</span></div>
            </div>
            <div class="metric-item" title="${esc(speedTip)}">
              <div class="metric-lbl">${esc(bi('平均速率', 'Avg Speed'))}</div>
              <div class="metric-val t-speed">${t.outputTokensPerSec ? `${t.outputTokensPerSec.toFixed(1)}<span class="u">tok/s</span>` : '--'}</div>
              <div class="metric-sub">${esc(heroSpeedSub)}</div>
            </div>
            <div class="metric-item" title="${esc(t.unpricedCalls ? bi(`其中 ${t.unpricedCalls} 次历史调用未匹配到费率`, `${t.unpricedCalls} legacy calls unpriced`) : '')}">
              <div class="metric-lbl">${esc(bi('估算费用', 'Est. Cost'))}</div>
              <div class="metric-val t-cost">${fmtCost(t.cost)}</div>
              <div class="metric-sub">${t.unpricedCalls ? esc(bi(`未计费 ${t.unpricedCalls} 次`, `${t.unpricedCalls} unpriced`)) : (t.totalDurationSec ? esc(`${bi('累计', 'time')} ${fmtDuration(t.totalDurationSec)}`) : '--')}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">${esc(bi('上下文水位曲线', 'Context Timeline'))}</div>
          <span class="card-sub tnum">${esc(bi('峰值', 'Peak'))} ${fmtTok(peakCtx)}${s.checkpoints ? ` · <span class="c-amber">${s.checkpoints} ${esc(bi('次压缩', 'CP'))}</span>` : ''}</span>
        </div>
        ${renderContextSvg(s.contextPoints, s.contextLimit)}
      </section>

      ${renderSessionInspector(s)}`;

    bindFoldPersistence(el);
    bindContextChartHover(s.contextPoints, s.contextLimit);
    if (prevScroll > 0) window.scrollTo(0, prevScroll);
  }

  // ── Tab 2: Sessions Workspace ──

  function getFilteredSortedSessions(list) {
    const q = (state.sessionFilter || '').trim().toLowerCase();
    let arr = list.filter((s) => {
      if (state.sessionStatusFilter === 'running' && s.runState !== 'RUN_STATE_RUNNING') return false;
      if (!q) return true;
      return (
        String(s.title || '').toLowerCase().includes(q) ||
        String(s.model || '').toLowerCase().includes(q) ||
        (s.modelBreakdown || []).some((m) => String(m.model || '').toLowerCase().includes(q))
      );
    });
    if (state.sessionSortBy === 'cost') {
      arr = [...arr].sort((a, b) => (b.cost || 0) - (a.cost || 0) || (b.calls || 0) - (a.calls || 0));
    } else if (state.sessionSortBy === 'context') {
      arr = [...arr].sort((a, b) => (b.usagePercent || 0) - (a.usagePercent || 0) || (b.contextUsed || 0) - (a.contextUsed || 0));
    }
    return arr;
  }

  function renderSessionsRows(container, list) {
    const filtered = getFilteredSortedSessions(list);
    const runningAll = list.filter((s) => s.runState === 'RUN_STATE_RUNNING').length;

    const countEl = document.getElementById('sessionsCountLabel');
    if (countEl) {
      countEl.textContent = filtered.length === list.length
        ? `${list.length} ${bi('条', 'sessions')}`
        : `${filtered.length} / ${list.length} ${bi('条', 'matched')}`;
    }

    const summaryEl = document.getElementById('sessionsSummaryBand');
    if (summaryEl) {
      const sumCost = filtered.reduce((a, x) => a + (x.cost || 0), 0);
      const sumCalls = filtered.reduce((a, x) => a + (x.calls || 0), 0);
      const speedItems = filtered.filter((x) => x.outputTokensPerSec > 0);
      const avgSpeed = speedItems.length
        ? speedItems.reduce((a, x) => a + x.outputTokensPerSec, 0) / speedItems.length
        : null;
      const runningInView = filtered.filter((x) => x.runState === 'RUN_STATE_RUNNING').length;
      summaryEl.innerHTML = `
        <div class="metric-item"><div class="metric-lbl">${esc(bi(runningAll ? '运行中 / 总数' : '会话数', runningAll ? 'Running / Total' : 'Sessions'))}</div><div class="metric-val">${runningInView ? `<span class="c-green">${runningInView}</span><span class="c-dim fw-400">/${filtered.length}</span>` : filtered.length}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('合计费用', 'Total Cost'))}</div><div class="metric-val t-cost">${fmtCost(sumCost)}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('总调用', 'Total Calls'))}</div><div class="metric-val">${sumCalls.toLocaleString()}</div></div>
        <div class="metric-item"><div class="metric-lbl">${esc(bi('平均速率', 'Avg Speed'))}</div><div class="metric-val t-speed">${esc(fmtRate(avgSpeed, true))}</div></div>`;
    }

    if (!filtered.length) {
      container.innerHTML = `<div class="empty">${esc(bi('没有匹配的会话', 'No matching sessions'))}</div>`;
      return;
    }

    const headerRow = `
      <div class="sess-grid sess-head-row">
        <span>${esc(bi('会话', 'Session'))}</span>
        <span>${esc(bi('上下文', 'Context'))}</span>
        <span class="r">${esc(bi('费用', 'Cost'))}</span>
        <span class="r">${esc(bi('操作', 'Actions'))}</span>
      </div>`;

    const rowsHtml = filtered.map((s) => {
      const fk = `sess:${s.id}`;
      const isRunning = s.runState === 'RUN_STATE_RUNNING';
      const mCount = (s.modelBreakdown || []).length;
      const primaryModel = s.model ? compactModelShort(fmtModelLabel(s.model)) : '';
      const modelBrief = primaryModel ? `${primaryModel}${mCount > 1 ? ` +${mCount - 1}` : ''}` : (mCount ? `${mCount} ${bi('模型', 'models')}` : '--');
      const ctxCol = pctColor(s.usagePercent || 0, false);
      const pctCls = ctxCol === 'accent' ? 'c-dim' : `c-${ctxCol} fw-500`;
      const relTime = fmtRelativeTime(s.updateTime);
      const fullTime = fmtLocalDateTime(s.updateTime);
      const sessSpeedSub = [
        s.avgTtftSec ? `ttft ${fmtTtft(s.avgTtftSec)}` : '',
        s.avgLatencySec ? bi(`平均耗时 ${fmtSec(s.avgLatencySec)}`, `avg ${fmtSec(s.avgLatencySec)}`) : '',
      ].filter(Boolean).join(' · ');
      const sessStrip = renderKvStrip([
        { label: bi('调用', 'Calls'), val: s.calls ? `${s.calls.toLocaleString()}<span class="u">${esc(bi('次', 'c'))}</span>` : '--', sub: s.turns ? `${s.turns} ${esc(bi('轮对话', 'turns'))}` : '' },
        { label: bi('速率', 'Speed'), val: s.outputTokensPerSec ? `<span class="t-speed">${s.outputTokensPerSec.toFixed(1)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: esc(sessSpeedSub) },
        { label: bi('上下文', 'Context'), val: s.contextUsed ? `<span class="t-ctx">${fmtTok(s.contextUsed)}</span><span class="u">/${fmtTok(s.contextLimit)}</span>` : '--', sub: s.contextUsed ? `${s.usagePercent.toFixed(1)}%` : '' },
        { label: bi('子代理', 'Subagents'), val: `${s.subagentCount || 0}<span class="u">${esc(bi('个', ''))}</span>`, sub: fullTime ? esc(fullTime) : '' },
      ]);

      return `
        <details class="sess-item ${isRunning ? 'is-running' : ''}" data-fold-key="${esc(fk)}" ${isFoldOpen(fk) ? 'open' : ''}>
          <summary class="sess-grid sess-row">
            <div class="sess-main">
              <div class="sess-title-line">
                ${CHEV_SVG}
                ${isRunning ? '<span class="dot sm green pulse-dot"></span>' : ''}
                <span class="sess-title" title="${esc(s.title)}">${esc(s.title)}</span>
              </div>
              <div class="sess-sub-line">
                <span class="t-model">${esc(modelBrief)}</span>
                ${relTime ? `<span title="${esc(fullTime)}">· ${esc(relTime)}</span>` : ''}
              </div>
            </div>

            <div class="inline-gauge" title="${s.contextUsed ? esc(`${fmtTok(s.contextUsed)} / ${fmtTok(s.contextLimit)} (${s.usagePercent.toFixed(1)}%)`) : ''}">
              ${s.contextUsed
                ? `<div class="inline-gauge-track"><div class="bar-fill ${ctxCol}" style="width:${Math.min(100, s.usagePercent).toFixed(1)}%"></div></div>
                   <span class="inline-gauge-pct ${pctCls}">${s.usagePercent.toFixed(0)}%</span>`
                : `<span class="tnum c-faint fs-115">--</span>`}
            </div>

            <div class="r tnum fs-125 ${s.cost > 0 ? 't-cost fw-500' : 'c-faint'}">${s.cost > 0 ? fmtCost(s.cost) : '--'}</div>

            <div class="sess-acts">
              <button class="ghost-btn" type="button" data-inspect-conv="${esc(s.id)}" title="${esc(bi('在当前会话页查看完整监控', 'Inspect full metrics'))}">${esc(bi('监控', 'View'))}</button>
              <button class="ghost-btn icon-sq" type="button" data-open-conv="${esc(s.id)}" title="${esc(bi('在编辑器中打开会话', 'Open conversation'))}">↗</button>
            </div>
          </summary>

          <div class="sess-expand">
            ${sessStrip}
            ${mCount
              ? `<div class="mt-sm">${renderModelPerfTable(s.modelBreakdown, { sortBy: 'cost', compact: true })}</div>`
              : `<div class="card-sub pad-xs mt-sm">${esc(bi('该较早会话尚未预加载模型统计，点击右侧「监控」可按需加载完整数据。', 'Click "View" on the right to load full metrics for this older session on demand.'))}</div>`}
          </div>
        </details>`;
    }).join('');

    container.innerHTML = `${headerRow}<div class="sess-list">${rowsHtml}</div>`;
    bindFoldPersistence(container);
  }

  function renderSessionsTab(el) {
    el.dataset.renderedTab = 'sessions';
    if (state.tabError.sessions) {
      return renderErrorBanner(el, bi('会话列表加载失败：', 'Failed to load sessions: '), state.tabError.sessions, 'sessions');
    }
    if (!state.sessions) {
      el.innerHTML = `<div class="loading">${esc(bi('读取会话列表中…', 'Loading sessions…'))}</div>`;
      return;
    }
    const list = state.sessions.sessions || [];
    if (!list.length) {
      el.innerHTML = `<div class="card empty">${esc(bi('暂无会话记录', 'No sessions found'))}</div>`;
      return;
    }
    const runningCount = list.filter((s) => s.runState === 'RUN_STATE_RUNNING').length;
    if (runningCount === 0 && state.sessionStatusFilter === 'running') {
      state.sessionStatusFilter = 'all';
    }

    el.innerHTML = `
      <section class="card">
        <div class="sess-top-bar">
          <div class="row-flex gap-sm">
            <div class="card-title">${esc(bi('历史会话', 'Sessions'))}</div>
            <span class="card-sub tnum" id="sessionsCountLabel"></span>
          </div>
          <div class="row-flex gap-sm wrap">
            ${runningCount > 0 ? renderSegmented([['all', bi('全部', 'All')], ['running', `${bi('运行中', 'Running')} ${runningCount}`]], state.sessionStatusFilter, 'data-sess-status') : ''}
            ${renderSegmented([['recent', bi('最近', 'Recent')], ['cost', bi('费用', 'Cost')], ['context', bi('水位', 'Context')]], state.sessionSortBy, 'data-sess-sort')}
          </div>
        </div>
        <div class="metric-band cols-4 mt-md" id="sessionsSummaryBand"></div>
        <div class="search-row mt-md mb-0">
          <svg class="search-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 13.75 13.75" />
          </svg>
          <input class="search-input" id="sessionsSearchInput" type="search" value="${esc(state.sessionFilter)}" placeholder="${esc(bi('搜索会话标题或模型…', 'Filter by title or model…'))}" />
        </div>
      </section>

      <section class="card card-flush" id="sessionsListBody"></section>`;

    const bodyEl = document.getElementById('sessionsListBody');
    renderSessionsRows(bodyEl, list);
    const input = document.getElementById('sessionsSearchInput');
    input?.addEventListener('input', () => {
      state.sessionFilter = input.value;
      renderSessionsRows(bodyEl, list);
    });
  }

  // ── Tab 3: Cost & Pricing Studio ──

  function renderDailySpendBars(daysMap, sinceDays, todayKey) {
    if (sinceDays <= 1) return '';
    const entries = Object.values(daysMap || {})
      .filter((d) => d && d.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-Math.min(sinceDays, 31));
    if (entries.length < 2) return '';
    const maxCost = Math.max(...entries.map((d) => d.cost || 0), 0.01);
    const barsHtml = entries.map((d) => {
      const h = Math.max(4, ((d.cost || 0) / maxCost) * 100);
      const isToday = d.date === todayKey;
      const tip = `${d.date} · ${fmtCost(d.cost)} · ${d.calls.toLocaleString()} ${bi('次调用', 'calls')}`;
      return `<div class="spend-bar-col" title="${esc(tip)}">
        <div class="spend-bar-fill ${isToday ? 'is-today' : ''}" style="height:${h.toFixed(1)}%"></div>
      </div>`;
    }).join('');
    return `
      <div class="spend-chart-wrap mt-md">
        <div class="row-between fs-10 c-dim tnum mb-xs">
          <span>${esc(bi('每日花费趋势', 'Daily Spend'))} (${entries[0].date.slice(5)} → ${entries[entries.length - 1].date.slice(5)})</span>
          <span>${esc(bi('峰值', 'Peak'))} ${fmtCost(maxCost)}</span>
        </div>
        <div class="spend-bars">${barsHtml}</div>
      </div>`;
  }

  function renderCostTab(el) {
    el.dataset.renderedTab = 'cost';
    if (state.tabError.usage) {
      return renderErrorBanner(el, bi('费用统计加载失败：', 'Failed to load usage: '), state.tabError.usage, 'usage');
    }
    const u = state.usageByDays[state.usageDays];
    if (!u) {
      el.innerHTML = `<div class="loading">${esc(bi('正在统计本地用量与费用…', 'Calculating local usage & costs…'))}</div>`;
      return;
    }

    const today = u.days[u.todayKey] || { cost: 0, calls: 0 };
    const activeDays = Math.max(1, Object.keys(u.days || {}).length);
    const avgDaily = (u.totals.cost || 0) / activeDays;
    const totalPrompt = (u.totals.inputTokens || 0) + (u.totals.cacheReadTokens || 0);
    const cacheHit = totalPrompt > 0 ? ((u.totals.cacheReadTokens / totalPrompt) * 100).toFixed(1) : '0.0';
    const customCount = (u.pricingRows || []).filter((r) => r.isCustom).length;

    const acctEntries = Object.entries(u.accountTotals || {})
      .filter(([, v]) => v?.calls > 0)
      .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));

    if (state.costSubTab === 'accounts' && acctEntries.length === 0) {
      state.costSubTab = 'families';
    }

    const promoNote = (fam) => {
      if ((fam === 'gemini-4-carbon' || fam === 'gemini-4-argon') && u.todayKey <= '2026-11-30') {
        return `<span class="promo-tag" title="${esc(bi('2026-12-01 自动切标准价 $4/$20', 'Auto-switches to $4/$20 on 2026-12-01'))}">${esc(bi('推广至11-30', 'promo→11-30'))}</span>`;
      }
      if ((fam === 'gemini-3.8-flash' || fam === 'gemini-3.7-flash') && u.todayKey <= '2026-12-31') {
        return `<span class="promo-tag" title="${esc(bi('2027-01-01 自动切标准价 $1.50/$7.50', 'Auto-switches to $1.50/$7.50 on 2027-01-01'))}">${esc(bi('推广至12-31', 'promo→12-31'))}</span>`;
      }
      return '';
    };

    const renderFamiliesStage = () => {
      if (!u.models.length) return `<div class="empty">${esc(bi('该时间窗口内无调用数据', 'No calls in range'))}</div>`;
      const totCost = u.models.reduce((s, m) => s + (m.cost || 0), 0);
      const segs = totCost > 0
        ? u.models.map((m, idx) => {
            const share = ((m.cost || 0) / totCost) * 100;
            if (share <= 0) return '';
            return `<div class="mix-seg" style="width:${Math.max(1, share).toFixed(2)}%;background:${MODEL_BAR_COLORS[idx % MODEL_BAR_COLORS.length]}" title="${esc(`${fmtModelLabel(m.name)}: ${fmtCost(m.cost)} (${share.toFixed(1)}%)`)}"></div>`;
          }).join('')
        : '';
      const legend = totCost > 0
        ? u.models.slice(0, 4).map((m, idx) => {
            const share = ((m.cost || 0) / totCost) * 100;
            return `<span class="legend-item"><span class="dot sm" style="background:${MODEL_BAR_COLORS[idx % MODEL_BAR_COLORS.length]}"></span>${esc(fmtModelLabel(m.name))} <span class="mono">${share.toFixed(0)}%</span></span>`;
          }).join('')
        : '';
      const familyRows = u.models.map((m) => ({
        name: m.name,
        calls: m.calls,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        cacheHitPercent: m.cacheHitPercent,
        outputTokens: m.outputTokens,
        outputTokensPerSec: m.outputTokensPerSec,
        avgLatencySec: m.avgLatencySec,
        cost: m.cost,
        priced: Boolean(m.pricing),
      }));
      return `
        <div class="stage-head">
          <div class="stage-meta tnum">${u.models.length} ${esc(bi('个模型系列', 'series'))} · ${u.scannedFiles} ${esc(bi('个本地会话', 'sessions'))}</div>
        </div>
        ${segs ? `<div class="mix-wrap"><div class="mix-bar">${segs}</div><div class="legend-row">${legend}</div></div>` : ''}
        ${renderModelTokenTable(familyRows, { nameHeader: bi('模型系列', 'Series'), includeSpeed: true, includeShare: true, totalCost: totCost })}`;
    };

    const renderAccountsStage = () => {
      const totCost = acctEntries.reduce((s, [, v]) => s + (v.cost || 0), 0);
      const colorOf = (k, idx) => (k === 'unattributed' ? UNATTRIBUTED_COLOR : ACCT_PALETTE[idx % ACCT_PALETTE.length]);
      const segs = totCost > 0
        ? acctEntries.map(([k, v], idx) => {
            const share = ((v.cost || 0) / totCost) * 100;
            return `<div class="mix-seg" style="width:${Math.max(1, share).toFixed(2)}%;background:${colorOf(k, idx)}" title="${esc(`${shortAccountName(k, u.accounts)}: ${fmtCost(v.cost)} (${share.toFixed(1)}%)`)}"></div>`;
          }).join('')
        : '';
      const rows = acctEntries.map(([k, v], idx) => ({
        name: shortAccountName(k, u.accounts) + (k !== 'unattributed' && shortAccountName(k, u.accounts) !== k ? ` (${k})` : ''),
        dotColor: colorOf(k, idx),
        calls: v.calls,
        inputTokens: v.inputTokens,
        cacheReadTokens: v.cacheReadTokens,
        outputTokens: v.outputTokens,
        cost: v.cost,
        priced: true,
      }));
      return `
        <div class="stage-head">
          <div class="stage-meta tnum">${acctEntries.length} ${esc(bi('个账号', 'accounts'))}${u.accountTrackingSince ? ` · ${esc(bi('归属起点', 'tracking since'))} ${esc(fmtLocalDateTime(u.accountTrackingSince).slice(0, 16))}` : ''}</div>
        </div>
        ${segs ? `<div class="mix-wrap"><div class="mix-bar">${segs}</div></div>` : ''}
        ${renderModelTokenTable(rows, { nameHeader: bi('账号', 'Account'), includeShare: true, totalCost: totCost, isModel: false })}`;
    };

    const renderPricingStage = () => {
      const grouped = new Map([['gemini4', []], ['gemini3', []], ['claude', []], ['other', []]]);
      for (const r of u.pricingRows || []) {
        const gKey = modelSeriesGroup(r.label, r.family);
        grouped.get(gKey).push(r);
      }
      const sectionsHtml = [...grouped.entries()]
        .filter(([, rows]) => rows.length > 0)
        .map(([gKey, rows]) => `
          <div class="prc-group">
            <div class="group-subhead">${esc(seriesGroupTitle(gKey))}</div>
            ${rows.map((r) => `
              <div class="prc-row" data-family="${esc(r.family)}">
                <span class="prc-name t-model">${esc(r.label)} ${r.isCustom ? `<span class="quiet-chip c-amber">${esc(bi('自定义', 'Custom'))}</span>` : promoNote(r.family)}</span>
                <input class="prc-input ${r.effective.input !== r.default.input ? 'is-modified' : ''}" data-field="input" type="number" step="any" min="0" value="${r.effective.input}" data-default="${r.default.input}" />
                <input class="prc-input ${r.effective.output !== r.default.output ? 'is-modified' : ''}" data-field="output" type="number" step="any" min="0" value="${r.effective.output}" data-default="${r.default.output}" />
                <input class="prc-input ${r.effective.cacheRead !== r.default.cacheRead ? 'is-modified' : ''}" data-field="cacheRead" type="number" step="any" min="0" value="${r.effective.cacheRead}" data-default="${r.default.cacheRead}" />
              </div>`).join('')}
          </div>`)
        .join('');

      return `
        <div class="stage-head">
          <div class="stage-meta tnum">${esc(bi('单位：USD / 1M Tokens · 官方价更新', 'USD / 1M Tokens · Official updated'))} ${esc(u.pricingLastUpdated)}</div>
        </div>
        <div class="prc-row prc-head">
          <span>${esc(bi('模型系列', 'Series'))}</span>
          <span class="num">${esc(bi('输入', 'Input'))}</span>
          <span class="num">${esc(bi('输出', 'Output'))}</span>
          <span class="num">${esc(bi('缓存读取', 'Cache Read'))}</span>
        </div>
        ${sectionsHtml}
        <div class="actions">
          <button class="btn primary" type="button" data-action="save-pricing">${esc(bi('保存自定义单价', 'Save Custom'))}</button>
          <button class="btn" type="button" data-action="reset-pricing">${esc(bi('恢复官方默认', 'Reset Official'))}</button>
          <span class="card-sub" id="prcMsg"></span>
        </div>`;
    };

    const subTabs = [
      { id: 'families', label: bi('按模型', 'By Model'), val: `${u.models.length}` },
      ...(acctEntries.length > 0 ? [{ id: 'accounts', label: bi('按账号', 'By Account'), val: `${acctEntries.length}` }] : []),
      { id: 'pricing', label: bi('单价配置', 'Pricing'), val: customCount ? `${customCount} ${bi('自定', 'custom')}` : bi('官方价', 'Official'), cls: customCount ? 'c-amber' : 'c-dim' },
    ];

    const stageBody = state.costSubTab === 'accounts'
      ? renderAccountsStage()
      : state.costSubTab === 'pricing'
        ? renderPricingStage()
        : renderFamiliesStage();

    el.innerHTML = `
      <section class="card card-hero">
        <div class="card-head">
          <div class="card-title">${biHtml('费用概览', 'Cost Overview')}</div>
          ${renderSegmented([[1, bi('今日', '1d')], [7, '7d'], [31, '31d'], [90, '90d']], state.usageDays, 'data-days')}
        </div>
        <div class="hero-reading">
          <div class="hero-reading-main">
            <span class="hero-num t-cost">${fmtCost(u.totals.cost)}</span>
            <span class="hero-den">${esc(bi(`近 ${state.usageDays} 天累计`, `Last ${state.usageDays}d total`))}</span>
          </div>
          ${state.usageDays > 1 ? `<span class="hero-pct c-body">${esc(bi('日均', 'avg'))} <span class="t-cost">${fmtCost(avgDaily)}</span><span class="u">/${esc(bi('天', 'd'))}</span></span>` : ''}
        </div>
        <div class="metric-well mt-md">
          <div class="metric-band cols-4">
            <div class="metric-item">
              <div class="metric-lbl">${esc(bi('今日费用', 'Today'))}</div>
              <div class="metric-val t-cost">${fmtCost(today.cost)}</div>
              <div class="metric-sub">${(today.calls || 0).toLocaleString()} ${esc(bi('次调用', 'calls'))}</div>
            </div>
            <div class="metric-item">
              <div class="metric-lbl">${esc(bi('总调用', 'Total Calls'))}</div>
              <div class="metric-val">${u.totals.calls.toLocaleString()}</div>
              <div class="metric-sub">${esc(bi('活跃', 'Active'))} ${activeDays} ${esc(bi('天', 'd'))}</div>
            </div>
            <div class="metric-item">
              <div class="metric-lbl">${esc(bi('缓存命中', 'Cache Hit'))}</div>
              <div class="metric-val t-in">${cacheHit}<span class="u">%</span></div>
              <div class="metric-sub"><span class="t-in">↓${fmtTok(u.totals.inputTokens)}</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-lbl">${esc(bi('总 Token', 'Total Tokens'))}</div>
              <div class="metric-val">${fmtTok(u.totals.inputTokens + u.totals.cacheReadTokens + u.totals.outputTokens)}</div>
              <div class="metric-sub"><span class="t-out">↑${fmtTok(u.totals.outputTokens)}</span></div>
            </div>
          </div>
        </div>
        ${renderDailySpendBars(u.days, state.usageDays, u.todayKey)}
      </section>

      <section class="inspector">
        <div class="insp-nav cols-${subTabs.length}" role="tablist">
          ${subTabs.map((tb) => `
            <button class="insp-tab ${state.costSubTab === tb.id ? 'active' : ''}" type="button" role="tab" data-cost-tab="${tb.id}">
              <span class="insp-tab-lbl">${esc(tb.label)}</span>
              <span class="insp-tab-val ${tb.cls || ''}">${esc(tb.val)}</span>
            </button>`).join('')}
        </div>
        <div class="insp-stage">${stageBody}</div>
      </section>`;

    el.querySelectorAll('.prc-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        inp.classList.toggle('is-modified', Number(inp.value) !== Number(inp.dataset.default));
      });
    });
  }

  // ── Tab 4: Models & Quotas Console ──

  function renderModelsTab(el) {
    el.dataset.renderedTab = 'models';
    if (state.tabError.models) {
      return renderErrorBanner(el, bi('模型配额加载失败：', 'Failed to load models: '), state.tabError.models, 'models');
    }
    const m = state.models;
    if (!m) {
      el.innerHTML = `<div class="loading">${esc(bi('读取模型与配额中…', 'Loading models & quotas…'))}</div>`;
      return;
    }
    if (!m.available) {
      el.innerHTML = `<div class="banner-warn">${esc(bi('暂未获取到实时配额（不影响会话与费用统计）。原因：', 'Live model quotas are temporarily unavailable (session & cost tracking still works). Reason: '))}${esc(m.error || 'unavailable')}</div>`;
      return;
    }

    const geminiCount = m.models.filter((x) => x.pool === 'gemini').length;
    const premiumCount = m.models.filter((x) => x.pool === 'premium').length;
    const filtered = state.modelPoolFilter === 'all' ? m.models : m.models.filter((item) => item.pool === state.modelPoolFilter);

    const grouped = new Map([['gemini4', []], ['gemini3', []], ['claude', []], ['other', []]]);
    for (const item of filtered) {
      grouped.get(modelSeriesGroup(item.label, item.modelId)).push(item);
    }

    const poolCardsHtml = (m.resetPools || []).map((p) => {
      const col = pctColor(p.remainingPercent, true);
      const isSelected = state.modelPoolFilter === p.poolKey;
      const poolTitle = p.poolKey === 'gemini' ? bi('Gemini 额度池', 'Gemini Pool') : bi('Premium 额度池', 'Premium Pool');
      return `
        <button class="pool-hero-btn ${isSelected ? 'active' : ''}" type="button" data-pool-filter="${isSelected ? 'all' : esc(p.poolKey)}">
          <div class="pool-ring-wrap">
            ${renderRadialGauge(p.remainingPercent, col, 48)}
            <span class="pool-ring-pct c-${col}">${p.remainingPercent}%</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="row-between">
              <span class="fw-600 fs-13 c-fg">${esc(poolTitle)}</span>
              <span class="tnum fs-11 c-dim">${esc(bi('重置', 'Reset'))} ${esc(fmtCountdown(p.resetTime))}</span>
            </div>
            <div class="card-sub mt-xs">${p.modelCount} ${esc(bi('个模型共享此额度池', 'models share this quota pool'))}</div>
          </div>
        </button>`;
    }).join('');

    const groupsHtml = [...grouped.entries()]
      .filter(([, rows]) => rows.length > 0)
      .map(([gKey, rows]) => `
        <div class="spec-group">
          <div class="spec-group-head">
            <span>${esc(seriesGroupTitle(gKey))}</span>
            <span class="tnum c-dim">${rows.length}</span>
          </div>
          <div class="tbl-wrap"><table class="tbl spec-tbl">
            <thead><tr>
              <th>${esc(bi('模型', 'Model'))}</th>
              <th>${esc(bi('能力', 'Caps'))}</th>
              <th class="num">${esc(bi('压缩窗口', 'Compact'))}</th>
              <th class="num">${esc(bi('原生窗口', 'Native'))}</th>
              <th class="num">${esc(bi('配额余量', 'Quota'))}</th>
              <th class="num">${esc(bi('重置', 'Reset'))}</th>
            </tr></thead>
            <tbody>${rows.map((item) => {
              const pct = item.remainingPercent;
              const col = pctColor(pct ?? 100, true);
              const caps = [];
              if (item.supportsAdaptiveThinking) caps.push(bi('自适应思考', 'Adaptive'));
              else if (item.supportsThinking) caps.push(bi('思考', 'Thinking'));
              if (item.tagTitle) caps.push(item.tagTitle);
              return `
                <tr>
                  <td class="tbl-name">
                    <span class="row-flex gap-xs min-w-0">
                      <span class="dot sm ${item.pool === 'premium' ? 'fam-claude' : 'fam-neon'}"></span>
                      <span class="truncate t-model">${esc(item.label)}</span>
                    </span>
                  </td>
                  <td>${caps.length ? caps.slice(0, 2).map((c) => `<span class="scope-pill">${esc(c)}</span>`).join(' ') : '<span class="c-dim">--</span>'}</td>
                  <td class="num t-ctx">${fmtTok(item.cpLimit)}</td>
                  <td class="num c-dim">${item.maxTokens ? fmtTok(item.maxTokens) : '--'}</td>
                  <td class="num">
                    <span class="inline-quota">
                      <span class="inline-quota-track"><span class="bar-fill ${col}" style="width:${pct ?? 0}%"></span></span>
                      <span class="fw-600 c-${col}" style="min-width:34px;text-align:right">${pct !== null ? `${pct}%` : '--'}</span>
                    </span>
                  </td>
                  <td class="num c-dim">${esc(fmtCountdown(item.resetTime))}</td>
                </tr>`;
            }).join('')}</tbody>
          </table></div>
        </div>`)
      .join('');

    el.innerHTML = `
      <section class="pool-stage">${poolCardsHtml}</section>

      <section class="card card-flush">
        <div class="spec-toolbar">
          <div class="row-flex gap-sm">
            <span class="card-title">${esc(bi('模型规格与配额', 'Model Specs & Quotas'))}</span>
            <span class="card-sub tnum">${filtered.length} / ${m.models.length}</span>
          </div>
          ${renderSegmented([['all', `${bi('全部', 'All')} ${m.models.length}`], ['gemini', `Gemini ${geminiCount}`], ['premium', `Premium ${premiumCount}`]], state.modelPoolFilter, 'data-pool-filter')}
        </div>
        ${groupsHtml || `<div class="empty">${esc(bi('暂无匹配模型', 'No matching models'))}</div>`}
      </section>`;
  }

  // ── Tab 5: Usage Calendar (Per-Account Vertical Breakdown) ──

  function renderCalendarTab(el) {
    el.dataset.renderedTab = 'calendar';
    if (state.tabError.usage) {
      return renderErrorBanner(el, bi('日历数据加载失败：', 'Failed to load calendar: '), state.tabError.usage, 'usage');
    }
    const u = state.usageByDays[90];
    if (!u) {
      el.innerHTML = `<div class="loading">${esc(bi('加载日历数据中…', 'Loading calendar…'))}</div>`;
      return;
    }
    const todayKey = u.todayKey;
    const todayMonth = todayKey.slice(0, 7);
    if (!state.calMonth) state.calMonth = todayMonth;
    if (!state.selectedCalDay) state.selectedCalDay = todayKey;

    const accounts = u.accounts || [];
    const acctTotals = u.accountTotals || {};
    const acctKeys = [];
    for (const a of accounts) {
      if (a.email && !acctKeys.includes(a.email)) acctKeys.push(a.email);
    }
    for (const k of Object.keys(acctTotals)) {
      if (k !== 'unattributed' && !acctKeys.includes(k)) acctKeys.push(k);
    }
    if (acctTotals.unattributed?.calls > 0) acctKeys.push('unattributed');

    const acctColor = (key) => {
      if (key === 'unattributed') return UNATTRIBUTED_COLOR;
      const idx = acctKeys.indexOf(key);
      return ACCT_PALETTE[(idx >= 0 ? idx : 0) % ACCT_PALETTE.length];
    };
    if (state.calAccount !== 'all' && !acctKeys.includes(state.calAccount)) state.calAccount = 'all';

    const projectDay = (rawDay) => (!rawDay ? null : state.calAccount === 'all' ? rawDay : rawDay.byAccount?.[state.calAccount] || null);
    const [y, m] = state.calMonth.split('-').map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthPrefix = `${y}-${String(m).padStart(2, '0')}`;
    const monthDays = Object.entries(u.days).filter(([dk]) => dk.startsWith(monthPrefix)).map(([, d]) => projectDay(d)).filter(Boolean);
    const maxCost = Math.max(...monthDays.map((d) => d.cost), 1);
    const monthCost = monthDays.reduce((s, d) => s + d.cost, 0);
    const monthCalls = monthDays.reduce((s, d) => s + d.calls, 0);
    const activeDayCount = monthDays.filter((d) => d.calls > 0).length;

    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-cell empty-cell"></div>');
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${monthPrefix}-${String(d).padStart(2, '0')}`;
      const rawInfo = u.days[key];
      const info = projectDay(rawInfo);
      const ratio = info && info.cost > 0 ? info.cost / maxCost : 0;
      const heat = ratio <= 0 ? '' : ratio > 0.7 ? 'heat-4' : ratio > 0.4 ? 'heat-3' : ratio > 0.15 ? 'heat-2' : 'heat-1';
      const activeAccts = state.calAccount === 'all' && rawInfo?.byAccount
        ? Object.entries(rawInfo.byAccount).filter(([, v]) => v.calls > 0).map(([k]) => k)
        : [];
      const dotsHtml = activeAccts.length
        ? `<span class="cal-acct-dots">${activeAccts.slice(0, 4).map((ak) => `<span class="cal-acct-dot" style="background:${acctColor(ak)}" title="${esc(ak === 'unattributed' ? bi('未归属历史', 'Unattributed') : ak)}"></span>`).join('')}</span>`
        : '';
      const cellTip = info ? `${key} · ${fmtCost(info.cost)} · ${info.calls.toLocaleString()} ${bi('次调用', 'calls')}` : key;
      cells.push(`
        <div class="cal-cell ${heat} ${key === todayKey ? 'is-today' : ''} ${state.selectedCalDay === key ? 'selected' : ''}" data-cal-day="${key}" title="${esc(cellTip)}">
          <div class="cal-cell-top"><span class="cal-day">${d}</span>${dotsHtml}</div>
          ${info ? `<span class="cal-cost">${fmtCost(info.cost)}</span>` : ''}
        </div>`);
    }

    const rawSel = u.days[state.selectedCalDay];
    const sel = projectDay(rawSel);
    const dayAccountBlocks = (() => {
      if (!rawSel) return [];
      const entries = Object.entries(rawSel.byAccount || {}).filter(([, v]) => v?.calls > 0);
      if (state.calAccount !== 'all') return entries.filter(([ak]) => ak === state.calAccount);
      return entries.sort((a, b) => (a[0] === 'unattributed' ? 1 : 0) - (b[0] === 'unattributed' ? 1 : 0) || b[1].cost - a[1].cost || b[1].calls - a[1].calls);
    })();

    const toTableRows = (byModel) =>
      Object.entries(byModel || {})
        .sort((a, b) => b[1].cost - a[1].cost || b[1].calls - a[1].calls)
        .map(([name, st]) => ({ name, ...st, priced: true }));

    const filterPills = [
      `<button class="filter-pill ${state.calAccount === 'all' ? 'active' : ''}" type="button" data-cal-acct="all">${esc(bi('全部账号', 'All Accounts'))} <span class="mono">${fmtCost(u.totals?.cost || 0)}</span></button>`,
      ...acctKeys.map((ak) => {
        const at = acctTotals[ak];
        const tip = ak === 'unattributed' ? bi('早于账号切号时间线记录的历史调用', 'Historical calls recorded before account timeline tracking') : ak;
        return `<button class="filter-pill ${state.calAccount === ak ? 'active' : ''}" type="button" data-cal-acct="${esc(ak)}" title="${esc(tip)}">
          <span class="cal-acct-dot lg" style="background:${acctColor(ak)}"></span>
          ${esc(shortAccountName(ak, accounts))}${at ? ` <span class="mono">${fmtCost(at.cost)}</span>` : ''}
        </button>`;
      }),
    ].join('');

    const trackingHint = u.accountTrackingSince
      ? bi(
          `自 ${fmtLocalDateTime(u.accountTrackingSince).slice(0, 16)} 起自动按登录账号归属，更早记录归入「未归属」。`,
          `Per-account attribution tracks sign-in switches since ${fmtLocalDateTime(u.accountTrackingSince).slice(0, 16)}; earlier history is Unattributed.`,
        )
      : '';

    const dayMixHtml = dayAccountBlocks.length > 1 && sel?.cost > 0
      ? `<div class="mix-wrap">
          <div class="mix-bar">${dayAccountBlocks.map(([ak, av]) => {
            const share = (av.cost / sel.cost) * 100;
            return `<div class="mix-seg" style="width:${Math.max(1.5, share).toFixed(2)}%;background:${acctColor(ak)}" title="${esc(`${shortAccountName(ak, accounts)}: ${fmtCost(av.cost)} (${share.toFixed(1)}%)`)}"></div>`;
          }).join('')}</div>
        </div>`
      : '';

    const breakdownHtml = dayAccountBlocks.length
      ? `${dayMixHtml}<div class="cal-acct-sections">${dayAccountBlocks.map(([ak, av]) => {
          const dispName = shortAccountName(ak, accounts);
          const showEmail = ak !== 'unattributed' && dispName !== ak;
          const col = acctColor(ak);
          const sharePct = sel?.cost > 0 && dayAccountBlocks.length > 1 ? ` · ${((av.cost / sel.cost) * 100).toFixed(0)}%` : '';
          return `
            <div class="cal-acct-block" style="--acct-col:${col}">
              <div class="cal-acct-block-head">
                <div class="cal-acct-block-title">
                  <span class="cal-acct-dot xl" style="background:${col}"></span>
                  <span>${esc(dispName)}</span>
                  ${showEmail ? `<span class="cal-acct-block-email">${esc(ak)}</span>` : ''}
                </div>
                <div class="cal-acct-block-stats">
                  <span class="c-dim">${av.calls.toLocaleString()} ${esc(bi('次', 'c'))}${esc(sharePct)}</span>
                  <span class="t-cost fw-600">${fmtCost(av.cost)}</span>
                  ${state.calAccount === 'all' && dayAccountBlocks.length > 1
                    ? `<button class="ghost-btn" type="button" data-cal-acct="${esc(ak)}" title="${esc(bi('在日历中仅看此账号', 'Filter calendar to this account'))}">${esc(bi('仅看', 'Filter'))}</button>`
                    : ''}
                </div>
              </div>
              ${renderModelTokenTable(toTableRows(av.byModel), { includeShare: true, totalCost: av.cost })}
            </div>`;
        }).join('')}</div>`
      : sel
        ? renderModelTokenTable(toTableRows(sel.byModel), { includeShare: true, totalCost: sel.cost })
        : `<div class="empty">${esc(bi('当日无对话记录', 'No activity on this date'))}</div>`;

    const dows = state.lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六'];
    el.innerHTML = `
      <section class="card">
        <div class="card-head">
          <div class="row-flex gap-sm wrap">
            <div class="card-title tnum fs-14">${esc(state.calMonth)}</div>
            <span class="tnum fs-12 t-cost fw-600">${fmtCost(monthCost)}</span>
            <span class="card-sub tnum">${monthCalls.toLocaleString()} ${esc(bi('调用', 'calls'))} · ${activeDayCount} ${esc(bi('活跃天', 'active days'))}</span>
          </div>
          <div class="row-flex gap-xs">
            ${state.calMonth !== todayMonth ? `<button class="ghost-btn" type="button" data-action="cal-today">${esc(bi('今天', 'Today'))}</button>` : ''}
            <button class="ghost-btn icon-sq" type="button" data-action="cal-prev" aria-label="Previous month">◀</button>
            <button class="ghost-btn icon-sq" type="button" data-action="cal-next" aria-label="Next month">▶</button>
          </div>
        </div>

        <div class="cal-subbar">
          ${acctKeys.length ? `<div class="acct-filter-bar mb-0">${filterPills}</div>` : '<span></span>'}
          <div class="heat-legend">
            <span>${esc(bi('低', 'Less'))}</span>
            <span class="heat-sq"></span><span class="heat-sq h1"></span><span class="heat-sq h2"></span><span class="heat-sq h3"></span><span class="heat-sq h4"></span>
            <span>${esc(bi('高', 'More'))}</span>
          </div>
        </div>

        <div class="cal-grid mt-md">
          ${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells.join('')}
        </div>
        ${trackingHint ? `<div class="cal-note">${esc(trackingHint)}</div>` : ''}
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title mono">${esc(state.selectedCalDay)} ${esc(bi('明细', 'Breakdown'))}${state.calAccount !== 'all' ? ` · ${esc(shortAccountName(state.calAccount, accounts))}` : ''}</div>
          <span class="card-sub tnum">${sel ? `${sel.calls.toLocaleString()} ${bi('次', 'c')} · <span class="t-in">↓${fmtTok(sel.inputTokens)}</span> · <span class="t-out">↑${fmtTok(sel.outputTokens)}</span> · <strong class="t-cost">${fmtCost(sel.cost)}</strong>` : bi('当日无本地记录', 'No local records')}</span>
        </div>
        ${breakdownHtml}
      </section>`;
  }

  // ── Tab 6: Accounts & Preferences Console ──

  function renderSettingsTab(el) {
    el.dataset.renderedTab = 'settings';
    const ov = state.overview;
    if (!ov) return;
    const accts = ov.accounts || [];
    const st = ov.storage || {};
    const rt = ov.runtime || {};
    const quotaSynced = Boolean(ov.userStatus?.available);
    const quotaSyncTip = quotaSynced
      ? bi('已连接实时配额与 TTFT 延迟数据', 'Connected to live quota & TTFT telemetry')
      : bi('仅读取本地对话日志，实时配额暂不可用', 'Reading local conversation logs only; live quotas unavailable');

    el.innerHTML = `
      <section class="card">
        <div class="card-head">
          <div class="card-title">${esc(bi('账号与配额快照', 'Accounts & Quota Snapshots'))}</div>
          <span class="card-sub tnum">${accts.length} ${esc(bi('个账号', 'accounts'))}</span>
        </div>
        ${accts.length
          ? `<div class="acct-grid">${accts.map((a) => `
              <div class="acct-tile ${a.isActive ? 'is-active' : ''}">
                <div class="row-between">
                  <div class="row-flex gap-sm min-w-0">
                    <span class="acct-avatar ${a.isActive ? 'is-active' : ''}">${esc(avatarInitial(a.name, a.email))}</span>
                    <div class="min-w-0">
                      <div class="fw-600 fs-13 truncate">${esc(a.name || a.email)}</div>
                      <div class="card-sub truncate">${esc(a.email)}</div>
                    </div>
                  </div>
                  <div class="row-flex gap-xs shrink-0">
                    <span class="status-tag ${a.isActive ? 'running' : ''}">
                      <span class="dot sm ${a.isActive ? 'green' : 'dim'}"></span>
                      ${esc(a.isActive ? bi('当前', 'Active') : bi('离线', 'Offline'))}
                    </span>
                    ${!a.isActive ? `<button class="ghost-btn" type="button" data-remove-acct="${esc(a.email)}">${esc(bi('移除', 'Remove'))}</button>` : ''}
                  </div>
                </div>
                <div class="acct-meta-line tnum">
                  <span>${esc(a.tierName || a.planName || '--')}</span>
                  <span>· ⚡${(a.credits || 0).toLocaleString()}</span>
                  <span title="${esc(fmtLocalDateTime(a.lastSeen))}">· ${esc(fmtRelativeTime(a.lastSeen))}</span>
                </div>
                ${renderPoolMiniBars(a.resetPools)}
              </div>`).join('')}</div>`
          : `<div class="empty">${esc(bi('暂无已保存账号', 'No accounts saved'))}</div>`}
      </section>

      <section class="card card-flush">
        <div class="pref-row">
          <div>
            <div class="fw-600 fs-125">${esc(bi('界面显示语言', 'Display Language'))}</div>
            <div class="card-sub">${esc(bi('实时切换所有监控标签与表头文案', 'Switch labels across all views immediately'))}</div>
          </div>
          ${renderSegmented([['zh', '中文'], ['en', 'English'], ['both', '双语 / Both']], state.lang, 'data-set-lang')}
        </div>

        <div class="pref-row">
          <div class="min-w-0 flex-1">
            <div class="fw-600 fs-125">${esc(bi('本地轻量配置', 'Local Preferences File'))}</div>
            <div class="card-sub">${esc(bi('仅持久化账号快照与自定义单价，会话统计全部按需实时计算', 'Persists only account snapshots & custom rates; session stats are computed on demand'))}</div>
            <div class="path-row mt-sm">
              <code class="code-path" title="${esc(st.filePath || '')}">${esc((st.filePath || '--').replace(/^\/Users\/[^/]+\//, '~/'))}</code>
              <button class="ghost-btn" type="button" data-action="copy-path">${esc(bi('复制', 'Copy'))}</button>
            </div>
          </div>
        </div>

        <div class="pref-telemetry">
          <div class="metric-band compact cols-4">
            <div class="metric-item"><div class="metric-lbl">${esc(bi('配置体积', 'Config Size'))}</div><div class="metric-val fs-13">${fmtBytes(st.sizeBytes)}</div></div>
            <div class="metric-item"><div class="metric-lbl">${esc(bi('常驻内存', 'Memory'))}</div><div class="metric-val fs-13">${rt.rssMB || '--'} MB</div></div>
            <div class="metric-item"><div class="metric-lbl">${esc(bi('运行服务', 'Service'))}</div><div class="metric-val fs-13 ${ov.health?.ok ? 'c-green' : 'c-red'}">${esc(ov.health?.ok ? bi('已连接', 'Connected') : bi('离线', 'Offline'))}</div></div>
            <div class="metric-item" title="${esc(quotaSyncTip)}"><div class="metric-lbl">${esc(bi('配额同步', 'Quota Sync'))}</div><div class="metric-val fs-13 ${quotaSynced ? 'c-green' : 'c-amber'}">${esc(quotaSynced ? bi('实时同步', 'Live Sync') : bi('仅本地统计', 'Local Only'))}</div></div>
          </div>
        </div>
      </section>`;
  }

  // ── Tab Router & Data Loaders ──

  const TAB_RENDERERS = {
    session: renderSessionTab,
    sessions: renderSessionsTab,
    cost: renderCostTab,
    models: renderModelsTab,
    calendar: renderCalendarTab,
    settings: renderSettingsTab,
  };

  function renderCurrentTab() {
    const el = document.getElementById('mainContent');
    TAB_RENDERERS[state.activeTab]?.(el);
  }

  async function loadOverview(force = false) {
    if (state.loadingOverview) return;
    state.loadingOverview = true;
    try {
      const qs = new URLSearchParams();
      if (state.convId) qs.set('conv', state.convId);
      if (force) qs.set('force', '1');
      const data = await apiGet(`/api/overview?${qs.toString()}`);
      state.overview = data;
      if (data.language) state.lang = data.language;
      updateTabLabels();
      renderLiveBar();
      if (state.activeTab === 'session' || state.activeTab === 'settings') renderCurrentTab();
    } catch (err) {
      const ctxEl = document.getElementById('liveContext');
      if (ctxEl) {
        ctxEl.title = err.message || 'Connection error';
        ctxEl.innerHTML = `<span class="dot sm red"></span><span class="c-red">${esc(bi('连接异常', 'Error'))}</span>`;
      }
    } finally {
      state.loadingOverview = false;
    }
  }

  async function loadSessions(force = false) {
    try {
      state.tabError.sessions = '';
      state.sessions = await apiGet(`/api/sessions${force ? '?force=1' : ''}`);
    } catch (err) {
      state.tabError.sessions = err.message || 'Network error';
    }
    if (state.activeTab === 'sessions') renderCurrentTab();
  }

  async function loadUsage(daysOverride = null) {
    const days = daysOverride ?? (state.activeTab === 'calendar' ? 90 : state.usageDays);
    try {
      state.tabError.usage = '';
      state.usageByDays[days] = await apiGet(`/api/usage?days=${days}`);
    } catch (err) {
      state.tabError.usage = err.message || 'Network error';
    }
    if (state.activeTab === 'cost' || state.activeTab === 'calendar') renderCurrentTab();
  }

  async function loadModels(force = false) {
    try {
      state.tabError.models = '';
      state.models = await apiGet(`/api/models${force ? '?force=1' : ''}`);
    } catch (err) {
      state.tabError.models = err.message || 'Network error';
    }
    if (state.activeTab === 'models') renderCurrentTab();
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && state.activeTab === 'session') loadOverview(false);
    }, 4000);
  }

  // ── Delegated Event Wiring ──

  const mainEl = document.getElementById('mainContent');

  mainEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button, [data-cal-day]');
    if (!btn) return;

    const inspTab = btn.getAttribute('data-insp-tab');
    if (inspTab) {
      state.inspectorTab = inspTab;
      renderSessionTab(mainEl);
      return;
    }

    const costTab = btn.getAttribute('data-cost-tab');
    if (costTab) {
      state.costSubTab = costTab;
      renderCostTab(mainEl);
      return;
    }

    const modelSort = btn.getAttribute('data-model-sort');
    if (modelSort) {
      state.modelSortBy = modelSort;
      renderSessionTab(mainEl);
      return;
    }

    const sessStatus = btn.getAttribute('data-sess-status');
    if (sessStatus) {
      state.sessionStatusFilter = sessStatus;
      renderSessionsTab(mainEl);
      return;
    }

    const sessSort = btn.getAttribute('data-sess-sort');
    if (sessSort) {
      state.sessionSortBy = sessSort;
      renderSessionsTab(mainEl);
      return;
    }

    const jumpId = btn.getAttribute('data-jump-conv') || btn.getAttribute('data-open-conv');
    if (jumpId) {
      e.preventDefault();
      e.stopPropagation();
      if (sidecar.ui?.toggleConversation) sidecar.ui.toggleConversation(jumpId);
      return;
    }

    const inspectId = btn.getAttribute('data-inspect-conv');
    if (inspectId) {
      e.preventDefault();
      e.stopPropagation();
      state.convId = inspectId;
      state.lastSessionSig = '';
      state.activeTab = 'session';
      updateTabLabels();
      renderCurrentTab();
      loadOverview(true);
      return;
    }

    const daysAttr = btn.getAttribute('data-days');
    if (daysAttr) {
      state.usageDays = Number(daysAttr) || 31;
      renderCurrentTab();
      if (!state.usageByDays[state.usageDays]) loadUsage(state.usageDays);
      return;
    }

    const poolAttr = btn.getAttribute('data-pool-filter');
    if (poolAttr) {
      state.modelPoolFilter = poolAttr;
      renderModelsTab(mainEl);
      return;
    }

    const errCat = btn.getAttribute('data-err-cat');
    if (errCat) {
      state.errCategoryFilter = errCat;
      renderSessionTab(mainEl);
      return;
    }

    const turnFilter = btn.getAttribute('data-turn-filter');
    if (turnFilter) {
      state.turnFilter = turnFilter;
      state.turnLimit = 10;
      renderSessionTab(mainEl);
      return;
    }

    const calDay = btn.getAttribute('data-cal-day');
    if (calDay) {
      state.selectedCalDay = calDay;
      renderCalendarTab(mainEl);
      return;
    }

    const calAcct = btn.getAttribute('data-cal-acct');
    if (calAcct) {
      state.calAccount = calAcct;
      renderCalendarTab(mainEl);
      return;
    }

    const setLang = btn.getAttribute('data-set-lang');
    if (setLang) {
      await apiPost('/api/prefs', { language: setLang });
      state.lang = setLang;
      state.lastSessionSig = '';
      updateTabLabels();
      renderLiveBar();
      renderCurrentTab();
      return;
    }

    const remAcct = btn.getAttribute('data-remove-acct');
    if (remAcct) {
      await apiPost('/api/prefs', { removeAccount: remAcct });
      await loadOverview(true);
      return;
    }

    const retry = btn.getAttribute('data-retry');
    if (retry === 'sessions') return void loadSessions(true);
    if (retry === 'usage') return void loadUsage();
    if (retry === 'models') return void loadModels(true);

    const action = btn.getAttribute('data-action');
    if (!action) return;

    if (action === 'back-active') {
      state.convId = state.hostConvId;
      state.lastSessionSig = '';
      loadOverview(true);
    } else if (action === 'more-turns') {
      state.turnLimit += 10;
      renderSessionTab(mainEl);
    } else if (action === 'reset-turns') {
      state.turnLimit = 10;
      renderSessionTab(mainEl);
    } else if (action === 'toggle-subs') {
      state.showAllSubagents = !state.showAllSubagents;
      renderSessionTab(mainEl);
    } else if (action === 'cal-prev' || action === 'cal-next') {
      const [cy, cm] = (state.calMonth || '').split('-').map(Number);
      if (cy && cm) {
        const dt = new Date(cy, cm - 1 + (action === 'cal-prev' ? -1 : 1), 1);
        state.calMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        renderCalendarTab(mainEl);
      }
    } else if (action === 'cal-today' && state.usageByDays[90]?.todayKey) {
      const tk = state.usageByDays[90].todayKey;
      state.calMonth = tk.slice(0, 7);
      state.selectedCalDay = tk;
      renderCalendarTab(mainEl);
    } else if (action === 'save-pricing') {
      const custom = {};
      mainEl.querySelectorAll('.prc-row[data-family]').forEach((row) => {
        const fam = row.getAttribute('data-family');
        const inp = row.querySelector('[data-field="input"]');
        const out = row.querySelector('[data-field="output"]');
        const cac = row.querySelector('[data-field="cacheRead"]');
        const vIn = Number(inp.value), vOut = Number(out.value), vCac = Number(cac.value);
        if (vIn !== Number(inp.dataset.default) || vOut !== Number(out.dataset.default) || vCac !== Number(cac.dataset.default)) {
          custom[fam] = { input: vIn, output: vOut, cacheRead: vCac, thinking: vOut };
        }
      });
      await apiPost('/api/pricing', { pricing: custom });
      const msg = document.getElementById('prcMsg');
      if (msg) msg.textContent = bi('已保存', 'Saved');
      state.sessions = null;
      state.usageByDays = {};
      state.lastSessionSig = '';
      await Promise.all([loadUsage(state.usageDays), loadOverview(true)]);
    } else if (action === 'reset-pricing') {
      await apiPost('/api/pricing', { reset: true });
      const msg = document.getElementById('prcMsg');
      if (msg) msg.textContent = bi('已恢复官方默认价', 'Reset to defaults');
      state.sessions = null;
      state.usageByDays = {};
      state.lastSessionSig = '';
      await Promise.all([loadUsage(state.usageDays), loadOverview(true)]);
    } else if (action === 'copy-path') {
      const fullPath = state.overview?.storage?.filePath || '';
      if (!fullPath) return;
      try {
        await navigator.clipboard.writeText(fullPath);
        btn.textContent = bi('✓ 已复制', '✓ Copied');
        setTimeout(() => { btn.textContent = bi('复制', 'Copy'); }, 1500);
      } catch {
        btn.textContent = bi('复制失败', 'Failed');
      }
    }
  });

  document.getElementById('tabNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const prevTab = state.activeTab;
    state.activeTab = btn.dataset.tab;
    updateTabLabels();
    if (prevTab !== state.activeTab && mainEl) {
      mainEl.classList.remove('tab-enter');
      void mainEl.offsetWidth;
      mainEl.classList.add('tab-enter');
    }
    renderCurrentTab();
    if (state.activeTab === 'sessions' && !state.sessions) loadSessions();
    if (state.activeTab === 'cost' && !state.usageByDays[state.usageDays]) loadUsage(state.usageDays);
    if (state.activeTab === 'calendar' && !state.usageByDays[90]) loadUsage(90);
    if (state.activeTab === 'models' && !state.models) loadModels();
  });

  window.addEventListener('scroll', () => {
    const mh = document.getElementById('masthead');
    if (mh) mh.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });
  window.addEventListener('resize', updateTabSlider, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.detailsOpen || state.accountsOpen)) {
      state.detailsOpen = false;
      state.accountsOpen = false;
      updateTabLabels();
      renderDrawers();
    }
  });

  document.getElementById('btnDetails').addEventListener('click', () => {
    state.detailsOpen = !state.detailsOpen;
    if (state.detailsOpen) state.accountsOpen = false;
    updateTabLabels();
    renderDrawers();
  });

  document.getElementById('btnAccounts').addEventListener('click', () => {
    state.accountsOpen = !state.accountsOpen;
    if (state.accountsOpen) state.detailsOpen = false;
    updateTabLabels();
    renderDrawers();
  });

  document.getElementById('btnRefresh').addEventListener('click', async () => {
    const btn = document.getElementById('btnRefresh');
    btn.classList.add('spinning');
    try {
      state.lastSessionSig = '';
      const tasks = [loadOverview(true)];
      if (state.activeTab === 'sessions') tasks.push(loadSessions(true));
      if (state.activeTab === 'cost') {
        state.usageByDays = {};
        tasks.push(loadUsage(state.usageDays));
      }
      if (state.activeTab === 'calendar') {
        state.usageByDays = {};
        tasks.push(loadUsage(90));
      }
      if (state.activeTab === 'models') tasks.push(loadModels(true));
      await Promise.all(tasks);
    } finally {
      btn.classList.remove('spinning');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadOverview(false);
  });

  if (typeof ResizeObserver !== 'undefined' && mainEl) {
    let resizeTimer = null;
    new ResizeObserver(() => {
      if (state.activeTab !== 'session' || !state.overview?.session) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderSessionTab(mainEl), 120);
    }).observe(mainEl);
  }

  updateTabLabels();
  loadOverview(false);
  schedulePoll();
})();
