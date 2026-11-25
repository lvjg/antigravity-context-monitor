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
    inspectorTab: 'models', // 'models' | 'context' | 'steps' | 'tools' | 'sides' | 'subagents' | 'errors'
    modelSortBy: 'active', // 'active' | 'cost' | 'calls'
    costSubTab: 'families', // 'families' | 'accounts' | 'pricing'
    showAllSubagents: false,
    showAllSideQuestions: false,
    turnLimit: 10,
    turnFilter: 'all', // 'all' | 'checkpoint' | 'error' | 'signal'
    traceTimelineMode: 'sequence', // 'sequence' | 'duration'
    traceSearch: '',
    selectedTraceStep: '',
    errCategoryFilter: 'all',
    sessionFilter: '',
    sessionStatusFilter: 'all', // 'all' | 'running'
    sessionSortBy: 'recent', // 'recent' | 'cost' | 'context'
    modelPoolFilter: 'all',
    tabError: {},
    lastSessionSig: '',
    lastSessionConvId: '',
    overviewVersion: '',
    fetchedAt: { models: 0, sessions: 0, usage: {} },
    inflight: {},
    prefetched: false,
    lastAcctEmail: '',
  };

  const STORAGE_PREFIX = 'cwm2:';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const REVALIDATE_MS = { models: 15_000, sessions: 15_000, usage: 30_000 };
  const MAX_OV_CACHE = 4;
  const MAX_FOLD_ENTRIES = 400;
  const STORE = (() => {
    try { return window.localStorage; } catch {
      try { return window.sessionStorage; } catch { return null; }
    }
  })();

  function readCached(key, maxAgeMs = CACHE_TTL_MS) {
    if (!STORE) return null;
    try {
      const raw = STORE.getItem(`${STORAGE_PREFIX}${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.at !== 'number' || !('data' in parsed)) return null;
      if (maxAgeMs > 0 && Date.now() - parsed.at > maxAgeMs) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function readOvIndex() {
    if (!STORE) return {};
    try {
      const raw = STORE.getItem(`${STORAGE_PREFIX}ov_idx`);
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') return obj;
    } catch { /* ignore */ }
    const idx = {};
    try {
      for (let i = 0; i < STORE.length; i++) {
        const k = STORE.key(i);
        if (k && k.startsWith(`${STORAGE_PREFIX}ov:`)) idx[k.slice(STORAGE_PREFIX.length + 3)] = 0;
      }
    } catch { /* ignore */ }
    return idx;
  }

  function pruneOverviewCache(keepCount = MAX_OV_CACHE - 1, touchId = '') {
    if (!STORE) return;
    try {
      const idx = readOvIndex();
      if (touchId) idx[touchId] = Date.now();
      const sorted = Object.entries(idx).sort((a, b) => (b[1] || 0) - (a[1] || 0));
      const kept = {};
      for (let i = 0; i < sorted.length; i++) {
        const [cid, at] = sorted[i];
        if (i < Math.max(0, keepCount)) kept[cid] = at;
        else STORE.removeItem(`${STORAGE_PREFIX}ov:${cid}`);
      }
      STORE.setItem(`${STORAGE_PREFIX}ov_idx`, JSON.stringify(kept));
    } catch { /* ignore */ }
  }

  function writeCached(key, data) {
    if (!STORE) return;
    const payload = JSON.stringify({ at: Date.now(), data });
    try {
      STORE.setItem(`${STORAGE_PREFIX}${key}`, payload);
      if (key.startsWith('ov:')) pruneOverviewCache(MAX_OV_CACHE, key.slice(3));
    } catch {
      pruneOverviewCache(0);
      try {
        STORE.setItem(`${STORAGE_PREFIX}${key}`, payload);
        if (key.startsWith('ov:')) pruneOverviewCache(MAX_OV_CACHE, key.slice(3));
      } catch { /* ignore */ }
    }
  }

  function clearCachedKeys(prefix) {
    if (!STORE) return;
    try {
      const full = `${STORAGE_PREFIX}${prefix}`;
      const toRemove = [];
      for (let i = 0; i < STORE.length; i++) {
        const k = STORE.key(i);
        if (k && k.startsWith(full)) toRemove.push(k);
      }
      for (const k of toRemove) STORE.removeItem(k);
    } catch { /* ignore */ }
  }

  function hydrateFromStorage() {
    const langSnap = readCached('lang', 30 * 86_400_000);
    if (langSnap?.data) state.lang = langSnap.data;

    const mSnap = readCached('models');
    if (mSnap?.data && Array.isArray(mSnap.data.families)) {
      state.models = mSnap.data;
      state.fetchedAt.models = mSnap.at;
    }

    const sSnap = readCached('sessions');
    if (sSnap?.data) {
      state.sessions = sSnap.data;
      state.fetchedAt.sessions = sSnap.at;
    }

    for (const d of [1, 7, 31, 90]) {
      const uSnap = readCached(`usage:${d}`, 15 * 60 * 1000);
      if (uSnap?.data) {
        state.usageByDays[d] = uSnap.data;
        state.fetchedAt.usage[d] = uSnap.at;
      }
    }

    if (state.convId) {
      const ovSnap = readCached(`ov:${state.convId}`, 15 * 60 * 1000);
      if (ovSnap?.data) {
        state.overview = ovSnap.data;
        if (ovSnap.data.language) state.lang = ovSnap.data.language;
        if (ovSnap.data.userStatus?.email) state.lastAcctEmail = ovSnap.data.userStatus.email;
      }
    }
  }

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

  const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

  function fmtTimeShort(iso) {
    const ms = parseIsoMs(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtTimeHM(iso) {
    const ms = parseIsoMs(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

  function recordFoldState(key, isOpen) {
    if (!key) return;
    const addSet = isOpen ? state.openFolds : state.closedFolds;
    const delSet = isOpen ? state.closedFolds : state.openFolds;
    delSet.delete(key);
    addSet.delete(key);
    addSet.add(key);
    if (addSet.size > MAX_FOLD_ENTRIES) {
      addSet.delete(addSet.values().next().value);
    }
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

  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

  function fmtQuotaPct(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return '--';
    const n = Number(pct);
    return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
  }

  function fmtWindowReset(w, verbose = false) {
    if (!w) return '--';
    if (w.resetTime) {
      const cd = fmtCountdown(w.resetTime);
      return verbose && cd !== '--' && cd !== bi('已重置', 'Ready')
        ? bi(`${cd} 后重置`, `Resets in ${cd}`)
        : cd;
    }
    if ((w.remainingPercent ?? 0) >= 100) return bi('满额', 'Full');
    return '--';
  }

  function poolDisplayName(poolKey) {
    return poolKey === 'gemini' ? 'Gemini' : 'Claude / GPT';
  }

  function renderPoolMiniBars(pools) {
    if (!pools?.length) return '';
    return `<div class="pool-mini-list">${pools.map((p) => {
      const name = poolDisplayName(p.poolKey);
      const hasDual = Boolean(p.fiveHour || p.weekly);
      if (!hasDual) {
        const col = pctColor(p.remainingPercent, true);
        return `
          <div class="pool-mini-row">
            <div class="row-between fs-11">
              <span class="c-dim fw-500">${esc(name)}</span>
              <span class="mono"><strong class="c-${col}">${esc(fmtQuotaPct(p.remainingPercent))}</strong> <span class="c-dim">· ${esc(fmtCountdown(p.resetTime))}</span></span>
            </div>
            <div class="bar-track bar-xs"><div class="bar-fill ${col}" style="width:${clampPct(p.remainingPercent)}%"></div></div>
          </div>`;
      }
      const wins = [
        p.fiveHour ? { lbl: '5h', w: p.fiveHour } : null,
        p.weekly ? { lbl: bi('周限', 'Weekly'), w: p.weekly } : null,
      ].filter(Boolean);
      return `
        <div class="pool-mini-group">
          <div class="fs-11 fw-500 c-fg">${esc(name)}</div>
          ${wins.map(({ lbl, w }) => {
            const pct = w.remainingPercent ?? 0;
            const col = pctColor(pct, true);
            const tip = w.resetTime ? `${lbl}: ${fmtQuotaPct(pct)} · ${fmtLocalDateTime(w.resetTime)}` : `${lbl}: ${fmtQuotaPct(pct)}`;
            return `
              <div class="pool-mini-win" title="${esc(tip)}">
                <div class="row-between fs-105">
                  <span class="c-dim">${esc(lbl)}</span>
                  <span class="tnum"><strong class="c-${col}">${esc(fmtQuotaPct(pct))}</strong> <span class="c-dim">· ${esc(fmtWindowReset(w))}</span></span>
                </div>
                <div class="bar-track bar-xs"><div class="bar-fill ${col}" style="width:${clampPct(pct)}%"></div></div>
              </div>`;
          }).join('')}
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
      const scopeParts = [
        m.mainCalls > 0 ? bi(`主会话 ${m.mainCalls}`, `Main ${m.mainCalls}`) : '',
        m.sideQuestionCalls > 0 ? bi(`侧边 ${m.sideQuestionCalls}`, `Side ${m.sideQuestionCalls}`) : '',
        m.subagentCalls > 0 ? bi(`子代理 ${m.subagentCalls}`, `Sub ${m.subagentCalls}`) : '',
      ].filter(Boolean);
      const scopeSub = scopeParts.length > 1
        ? scopeParts.join(' · ')
        : m.subagentCalls > 0
          ? bi('仅子代理调用', 'Subagents only')
          : m.sideQuestionCalls > 0
            ? bi('仅侧边会话调用', 'Side chats only')
            : bi('仅主会话调用', 'Main session');
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
      const w5 = primary.fiveHour;
      const wW = primary.weekly;
      const qTip = pools
        .map((p) => {
          const nm = poolDisplayName(p.poolKey);
          if (p.fiveHour || p.weekly) {
            const parts = [];
            if (p.fiveHour) parts.push(`5h ${fmtQuotaPct(p.fiveHour.remainingPercent)} (${fmtWindowReset(p.fiveHour)})`);
            if (p.weekly) parts.push(`${bi('周限', 'Wk')} ${fmtQuotaPct(p.weekly.remainingPercent)} (${fmtWindowReset(p.weekly)})`);
            return `${nm}: ${parts.join(' · ')}`;
          }
          return `${nm}: ${fmtQuotaPct(p.remainingPercent)} (${fmtCountdown(p.resetTime)})`;
        })
        .join('\n');
      qEl.title = qTip;

      if (w5 && wW) {
        const c5 = pctColor(w5.remainingPercent ?? 100, true);
        const cW = pctColor(wW.remainingPercent ?? 100, true);
        const dotCol = pctColor(Math.min(w5.remainingPercent ?? 100, wW.remainingPercent ?? 100), true);
        qEl.innerHTML = `<span class="dot sm ${dotCol}"></span><span class="c-dim fs-105">5h</span><span class="c-${c5} fw-600">${esc(fmtQuotaPct(w5.remainingPercent))}</span><span class="c-faint">·</span><span class="c-dim fs-105">${esc(bi('周', 'Wk'))}</span><span class="c-${cW} fw-600">${esc(fmtQuotaPct(wW.remainingPercent))}</span>`;
        const resetSrc = w5.resetTime || wW.resetTime || primary.resetTime;
        rEl.textContent = fmtCountdown(resetSrc);
        rEl.classList.toggle('hidden', !resetSrc);
      } else {
        const qCol = pctColor(primary.remainingPercent, true);
        qEl.innerHTML = `<span class="dot sm ${qCol}"></span><span class="c-dim fs-105">${esc(bi('配额', 'Quota'))}</span><span class="c-${qCol} fw-600">${esc(fmtQuotaPct(primary.remainingPercent))}</span>`;
        rEl.textContent = fmtCountdown(primary.resetTime);
        rEl.classList.toggle('hidden', !primary.resetTime);
      }
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
    const limitLblY = limitY - padT < 14 ? limitY + 12 : limitY - 5;
    const limitLine = limit > 0 && limit <= yMax
      ? `<line class="chart-limit" x1="${padL}" y1="${limitY.toFixed(1)}" x2="${W - padR}" y2="${limitY.toFixed(1)}" />
         <text class="chart-limit-lbl" x="${W - padR - 2}" y="${limitLblY.toFixed(1)}" text-anchor="end">${esc(bi('上限', 'Limit'))} ${esc(fmtTok(limit))}</text>`
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

  const stepSearchCache = new WeakMap();
  const turnHeadSearchCache = new WeakMap();
  const traceLookup = {
    convId: '',
    turnsByNum: new Map(),
    stepsByKey: new Map(),
    maxDurByTurn: new Map(),
    matchedSteps: null,
    hasQuery: false,
  };

  function stepTotalDurationSec(st) {
    const dt = Number(st?.dtSec) || 0;
    if (dt > 0) return dt;
    const sum = (Number(st?.ttftSec) || 0) + (Number(st?.streamSec) || 0);
    return sum > 0 ? sum : 0;
  }

  function stepToolNames(st) {
    if (Array.isArray(st?.tools) && st.tools.length) return st.tools;
    if (Array.isArray(st?.toolCalls) && st.toolCalls.length) return st.toolCalls.map((tc) => tc.name);
    return [];
  }

  function stepInlineSnippet(st) {
    return st?.snippet || st?.reply || st?.thinking || '';
  }

  function traceSignalLabel(sig) {
    return ({
      slow: bi('慢耗时', 'Slow'),
      cache_drop: bi('缓存骤降', 'Cache Drop'),
      loop: bi('高频重复', 'Loop'),
    })[sig] || sig;
  }

  function getStepSearchText(st) {
    if (!st || typeof st !== 'object') return '';
    let cached = stepSearchCache.get(st);
    if (cached !== undefined) return cached;
    const parts = [`#${st.step}`, st.model, st.snippet, st.reply, st.thinking];
    if (Array.isArray(st.tools)) parts.push(...st.tools);
    if (Array.isArray(st.toolCalls)) {
      for (const tc of st.toolCalls) parts.push(tc.arg ? `${tc.name} ${tc.arg}` : tc.name);
    }
    cached = parts.filter(Boolean).join(' ').toLowerCase();
    stepSearchCache.set(st, cached);
    return cached;
  }

  function getTurnHeadSearchText(tr) {
    if (!tr || typeof tr !== 'object') return '';
    let cached = turnHeadSearchCache.get(tr);
    if (cached !== undefined) return cached;
    cached = `t${tr.turn} ${tr.prompt || ''} ${(tr.models || []).join(' ')}`.toLowerCase();
    turnHeadSearchCache.set(tr, cached);
    return cached;
  }

  function turnMatchesTraceQuery(tr, q) {
    if (!q) return { matched: true, matchedSteps: null };
    const matchedSteps = new Set();
    const headHit = getTurnHeadSearchText(tr).includes(q);
    for (const st of tr.steps || []) {
      if (getStepSearchText(st).includes(q)) matchedSteps.add(`${tr.turn}:${st.step}`);
    }
    return { matched: headHit || matchedSteps.size > 0, matchedSteps };
  }

  function getVisibleTraceTurns(s) {
    const turns = Array.isArray(s?.mainTurns) ? s.mainTurns : [];
    const q = (state.traceSearch || '').trim().toLowerCase();
    const hasQuery = q.length > 0;
    let filteredTurns = state.turnFilter === 'checkpoint'
      ? turns.filter((tr) => tr.checkpoints > 0)
      : state.turnFilter === 'error'
        ? turns.filter((tr) => tr.errors > 0)
        : state.turnFilter === 'signal'
          ? turns.filter((tr) => (tr.signals || []).length > 0)
          : turns;

    const matchedStepSet = new Set();
    if (hasQuery) {
      const next = [];
      for (const tr of filteredTurns) {
        const res = turnMatchesTraceQuery(tr, q);
        if (res.matched) {
          next.push(tr);
          for (const k of res.matchedSteps) matchedStepSet.add(k);
        }
      }
      filteredTurns = next;
    }

    const visibleTurns = hasQuery ? filteredTurns : filteredTurns.slice(0, state.turnLimit);
    const remaining = hasQuery ? 0 : Math.max(0, filteredTurns.length - visibleTurns.length);
    return { filteredTurns, visibleTurns, remaining, matchedStepSet, hasQuery };
  }

  function renderStepDetailCard(st) {
    if (st.type === 'USER_INPUT') {
      return `
        <div class="wf-detail">
          <div class="wf-detail-meta"><span>${esc(bi('用户输入', 'User Prompt'))} · #${st.step}</span><span>${esc(fmtLocalDateTime(st.ts))}</span></div>
          <div class="wf-text-blk">${esc(st.snippet || bi('（无文本内容）', '(empty prompt)'))}</div>
        </div>`;
    }
    if (st.type === 'CHECKPOINT') {
      const freed = st.beforeTokens > 0 && st.afterTokens > 0 ? st.beforeTokens - st.afterTokens : 0;
      return `
        <div class="wf-detail">
          ${renderKvStrip([
            { label: bi('压缩前上下文', 'Before'), val: st.beforeTokens ? `<span class="c-amber">${fmtTok(st.beforeTokens)}</span>` : '--' },
            { label: bi('压缩后上下文', 'After'), val: st.afterTokens ? `<span class="t-ctx">${fmtTok(st.afterTokens)}</span>` : '--' },
            { label: bi('释放空间', 'Freed'), val: freed > 0 ? `<span class="c-green">-${fmtTok(freed)}</span>` : '--' },
            { label: bi('触发时间', 'Time'), val: esc(fmtTimeShort(st.ts) || '--'), sub: `#${st.step}` },
          ])}
        </div>`;
    }
    if (st.type === 'ERROR_MESSAGE') {
      return `
        <div class="wf-detail">
          <div class="wf-detail-meta"><span class="c-red fw-500">${esc(bi('报错详情', 'Error Details'))} · #${st.step}</span><span>${esc(fmtLocalDateTime(st.ts))}</span></div>
          <pre class="err-pre">${esc(st.snippet || 'Error')}</pre>
        </div>`;
    }

    const totalIn = (st.inputTokens || 0) + (st.cacheReadTokens || 0);
    const cachePct = st.cacheHitPercent ?? (totalIn > 0 ? +((st.cacheReadTokens / totalIn) * 100).toFixed(1) : 0);
    const ttft = Math.max(0, Number(st.ttftSec) || 0);
    const stream = Math.max(0, Number(st.streamSec) || 0);
    const totalDur = stepTotalDurationSec(st);
    const timingSub = [
      ttft > 0 ? `ttft ${fmtTtft(ttft)}` : '',
      stream > 0 ? `${bi('生成', 'stream')} ${fmtSec(stream)}` : '',
    ].filter(Boolean).join(' · ') || bi('无分段计时', 'No timing split');

    const tcList = Array.isArray(st.toolCalls) && st.toolCalls.length
      ? st.toolCalls
      : stepToolNames(st).map((name) => ({ name, arg: '' }));

    const toolCallsHtml = tcList.length
      ? `<div class="wf-tc-section">
          <div class="wf-detail-meta">
            <span>${esc(bi('工具调用', 'Tool Calls'))}${tcList.length > 1 ? ` <span class="scope-pill">${esc(bi(`并行 ×${tcList.length}`, `Parallel ×${tcList.length}`))}</span>` : ''}</span>
            <span class="c-faint">${esc(fmtTimeShort(st.ts))}</span>
          </div>
          <div class="wf-tc-list">${tcList.map((tc, idx) => `
            <div class="wf-tc-row">
              <span class="wf-tc-idx">${String(idx + 1).padStart(2, '0')}</span>
              <span class="t-tool mono shrink-0">${esc(tc.name)}</span>
              ${tc.arg ? `<span class="wf-tc-arg mono truncate" title="${esc(tc.arg)}">${esc(tc.arg)}</span>` : '<span class="c-faint fs-105">--</span>'}
            </div>`).join('')}
          </div>
        </div>`
      : '';

    const thinkText = st.thinking || '';
    const replyText = st.reply || (!thinkText ? st.snippet || '' : '');

    return `
      <div class="wf-detail">
        ${renderKvStrip([
          { label: bi('输入 / 缓存', 'Input / Cache'), val: `<span class="t-in">↓${fmtTok(totalIn)}</span>`, sub: st.cacheReadTokens > 0 ? `${esc(bi('新增', 'fresh'))} ${fmtTok(st.inputTokens)} · ${esc(bi('缓存', 'cache'))} ${cachePct}%` : esc(bi('无缓存命中', 'No cache')) },
          { label: bi('输出', 'Output'), val: `<span class="t-out">↑${fmtTok(st.outputTokens)}</span>`, sub: st.contextTokens ? `${esc(bi('水位', 'ctx'))} ${fmtTok(st.contextTokens)}` : '' },
          { label: bi('耗时分布', 'Timing'), val: totalDur > 0 ? `<span class="t-speed">${esc(fmtSec(totalDur))}</span>${st.speedTokPerSec ? `<span class="u">· ${st.speedTokPerSec.toFixed(0)} t/s</span>` : ''}` : '<span class="c-faint">--</span>', sub: esc(timingSub) },
          { label: bi('单步费用', 'Step Cost'), val: st.cost > 0 ? `<span class="t-cost">${fmtCost(st.cost)}</span>` : '<span class="c-faint">--</span>', sub: `<span class="t-model">${esc(compactModelShort(fmtModelLabel(st.model)))}</span>` },
        ])}
        ${toolCallsHtml}
        ${thinkText ? `<div class="wf-text-wrap"><div class="wf-detail-meta"><span>${esc(bi('思考摘要', 'Thinking'))}</span></div><div class="wf-text-blk is-think">${esc(thinkText)}</div></div>` : ''}
        ${replyText ? `<div class="wf-text-wrap"><div class="wf-detail-meta"><span>${esc(bi('回复摘要', 'Reply'))}</span></div><div class="wf-text-blk">${esc(replyText)}</div></div>` : ''}
      </div>`;
  }

  function renderStepRow(st, maxDurSec = 0, convId = '', opts = {}) {
    const stepKey = `${st.turn || 0}:${st.step}`;
    const foldKey = `step:${convId}:${stepKey}`;
    const isSelected = opts.selectedKey === stepKey;
    const isMatch = Boolean(opts.isMatch);
    const isOpen = isFoldOpen(foldKey, isSelected);
    const extraCls = `${isSelected ? ' is-selected' : ''}${isMatch ? ' is-match' : ''}`;
    const detailSlot = isOpen
      ? renderStepDetailCard(st)
      : `<div data-lazy-step="${esc(stepKey)}"></div>`;

    if (st.type === 'USER_INPUT') {
      return `
        <details class="wf-step is-user${extraCls}" data-fold-key="${esc(foldKey)}" data-step-key="${esc(stepKey)}" ${isOpen ? 'open' : ''}>
          <summary class="wf-row is-user">
            <span class="wf-node"><span class="wf-dot is-user"></span></span>
            <span class="wf-num">#${st.step}</span>
            <span class="wf-desc wf-span"><span class="step-tag t-user">${esc(bi('用户', 'USER'))}</span><span class="c-fg truncate">${esc(st.snippet || bi('用户输入', 'User input'))}</span></span>
            <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
          </summary>
          ${detailSlot}
        </details>`;
    }
    if (st.type === 'CHECKPOINT') {
      const freed = st.beforeTokens > 0 && st.afterTokens > 0 ? st.beforeTokens - st.afterTokens : 0;
      const txt = st.beforeTokens > 0
        ? `${bi('上下文压缩', 'Compacted')}: ${fmtTok(st.beforeTokens)} → ${st.afterTokens > 0 ? fmtTok(st.afterTokens) : '--'}${freed > 0 ? ` (-${fmtTok(freed)})` : ''}`
        : bi('触发上下文压缩', 'Compaction checkpoint');
      return `
        <details class="wf-step is-cp${extraCls}" data-fold-key="${esc(foldKey)}" data-step-key="${esc(stepKey)}" ${isOpen ? 'open' : ''}>
          <summary class="wf-row is-cp">
            <span class="wf-node"><span class="wf-dot is-cp"></span></span>
            <span class="wf-num">#${st.step}</span>
            <span class="wf-desc wf-span"><span class="step-tag t-cp">${esc(bi('压缩', 'CP'))}</span><span class="c-amber truncate">${esc(txt)}</span></span>
            <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
          </summary>
          ${detailSlot}
        </details>`;
    }
    if (st.type === 'ERROR_MESSAGE') {
      return `
        <details class="wf-step is-err${extraCls}" data-fold-key="${esc(foldKey)}" data-step-key="${esc(stepKey)}" ${isOpen ? 'open' : ''}>
          <summary class="wf-row is-err">
            <span class="wf-node"><span class="wf-dot is-err"></span></span>
            <span class="wf-num">#${st.step}</span>
            <span class="wf-desc wf-span"><span class="step-tag t-err">${esc(bi('报错', 'ERR'))}</span><span class="c-red truncate">${esc(st.snippet || 'Error')}</span></span>
            <span class="wf-ts">${esc(fmtTimeShort(st.ts))}</span>
          </summary>
          ${detailSlot}
        </details>`;
    }

    const toolNames = stepToolNames(st);
    const tcList = Array.isArray(st.toolCalls) && st.toolCalls.length ? st.toolCalls : null;
    const toolText = summarizeToolsInline(toolNames);
    const firstArg = tcList?.length === 1 && tcList[0].arg ? tcList[0].arg : '';
    const mShort = compactModelShort(fmtModelLabel(st.model));
    const snippet = stepInlineSnippet(st);
    const descMain = toolText
      ? `<span class="t-model shrink-0">${esc(mShort)}</span><span class="c-faint shrink-0">·</span><span class="t-tool mono fs-105 shrink-0">${esc(toolText)}</span>${firstArg ? `<span class="c-dim mono fs-105 truncate">${esc(firstArg)}</span>` : ''}`
      : `<span class="t-model shrink-0">${esc(mShort)}</span>${snippet ? `<span class="c-faint shrink-0">·</span><span class="c-body truncate">${esc(snippet.slice(0, 72))}</span>` : ''}`;
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
          ${ttftW > 0 ? `<span class="wf-seg wf-ttft ${ttftPart >= 25 ? 'is-slow' : ''}" style="width:${ttftW.toFixed(1)}%"></span>` : ''}
          ${streamW > 0 ? `<span class="wf-seg wf-stream" style="width:${streamW.toFixed(1)}%"></span>` : ''}
        </div>
        <span class="wf-dur">${esc(fmtSec(totalDur))}</span>`;
    } else if (ttft > 0) {
      wfBarHtml = `<span class="wf-dur c-dim">${esc(fmtTtft(ttft))}</span>`;
    }

    return `
      <details class="wf-step${extraCls}" data-fold-key="${esc(foldKey)}" data-step-key="${esc(stepKey)}" ${isOpen ? 'open' : ''}>
        <summary class="wf-row">
          <span class="wf-node"><span class="wf-dot${toolNames.length ? ' has-tool' : ''}"></span></span>
          <span class="wf-num">#${st.step}</span>
          <span class="wf-desc">${descMain}</span>
          <span class="wf-ctx ${ctxCls}">${esc(ctxCell)}</span>
          <span class="wf-spd">${st.speedTokPerSec ? `${st.speedTokPerSec.toFixed(0)} t/s` : '<span class="c-faint">--</span>'}</span>
          <div class="wf-bar-cell">${wfBarHtml}</div>
        </summary>
        ${detailSlot}
      </details>`;
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

  function renderTraceOverviewBar(visibleTurns, matchedStepSet, hasQuery) {
    const chronoTurns = [...visibleTurns].reverse();
    const items = [];
    const turnMarks = [];
    const isDur = state.traceTimelineMode === 'duration';
    let cursor = 0;

    for (const tr of chronoTurns) {
      const steps = Array.isArray(tr.steps) ? tr.steps : [];
      if (!steps.length) continue;
      turnMarks.push({ turn: tr.turn, pos: cursor });
      for (const st of steps) {
        const dur = st.type === 'PLANNER_RESPONSE' ? stepTotalDurationSec(st) : 0;
        const w = isDur ? Math.max(0.8, dur || 0.8) : 1;
        const toolNames = st.type === 'PLANNER_RESPONSE' ? stepToolNames(st) : [];
        const hasTools = toolNames.length > 0;
        const ttft = Math.max(0, Number(st.ttftSec) || 0);
        const ttftPct = st.type === 'PLANNER_RESPONSE' && dur > 0 && ttft > 0 ? Math.min(92, Math.max(8, (ttft / dur) * 100)) : null;
        const key = `${tr.turn}:${st.step}`;
        const label = st.type === 'USER_INPUT'
          ? `${bi('用户', 'User')}: ${(st.snippet || '').slice(0, 60)}`
          : st.type === 'CHECKPOINT'
            ? `${bi('上下文压缩', 'Compaction')} ${st.beforeTokens ? `${fmtTok(st.beforeTokens)} → ${fmtTok(st.afterTokens)}` : ''}`
            : st.type === 'ERROR_MESSAGE'
              ? `${bi('报错', 'Error')}: ${(st.snippet || '').slice(0, 60)}`
              : `${compactModelShort(fmtModelLabel(st.model))}${hasTools ? ` · ${summarizeToolsInline(toolNames)}` : ''}`;
        const timingTxt = st.type === 'PLANNER_RESPONSE'
          ? [
              dur > 0 ? fmtSec(dur) : '',
              ttft > 0 ? `ttft ${fmtTtft(ttft)}` : '',
              st.speedTokPerSec ? `${st.speedTokPerSec.toFixed(0)} t/s` : '',
            ].filter(Boolean).join(' · ')
          : fmtTimeShort(st.ts);
        const isSlow = ttft >= 25 || dur >= 60;
        if (st.type === 'PLANNER_RESPONSE') {
          items.push({ key, turn: tr.turn, step: st.step, start: cursor, width: w, lane: 1, kind: 'model', ttftPct, isSlow, label, timingTxt });
          if (hasTools) {
            items.push({ key, turn: tr.turn, step: st.step, start: cursor, width: w, lane: 2, kind: 'tool', ttftPct: null, isSlow: false, label, timingTxt });
          }
        } else {
          const lane = st.type === 'ERROR_MESSAGE' ? 2 : 0;
          const kind = st.type === 'USER_INPUT' ? 'user' : st.type === 'CHECKPOINT' ? 'cp' : 'err';
          items.push({ key, turn: tr.turn, step: st.step, start: cursor, width: w, lane, kind, ttftPct: null, isSlow: false, label, timingTxt });
        }
        cursor += w;
      }
    }

    if (!items.length || cursor <= 0) return '';
    const total = cursor;
    let lastLblPct = -99;
    const boundariesHtml = turnMarks
      .map((tm, idx) => {
        const leftPct = (tm.pos / total) * 100;
        const showLbl = leftPct - lastLblPct >= 8.5 && leftPct <= 93;
        if (showLbl) lastLblPct = leftPct;
        if (idx === 0) return showLbl ? `<span class="tr-div-lbl" style="left:3px">T${tm.turn}</span>` : '';
        return `<span class="tr-div" style="left:${leftPct.toFixed(2)}%">${showLbl ? `<span class="tr-div-lbl">T${tm.turn}</span>` : ''}</span>`;
      })
      .join('');

    const spansHtml = items.map((it) => {
      const leftPct = (it.start / total) * 100;
      const widthPct = Math.max(0.55, (it.width / total) * 100);
      const isSelected = state.selectedTraceStep === it.key;
      const isMatch = hasQuery && matchedStepSet.has(it.key);
      const cls = [
        'tr-span',
        `k-${it.kind}`,
        it.isSlow ? 'is-slow' : '',
        isSelected ? 'is-selected' : '',
        hasQuery ? (isMatch ? 'is-match' : 'is-dim') : '',
      ].filter(Boolean).join(' ');
      const bgStyle = it.ttftPct != null && it.kind === 'model'
        ? `;--ttft-split:${it.ttftPct.toFixed(1)}%`
        : '';
      return `<button type="button" class="${cls}" data-trace-jump="${esc(it.key)}" data-tip-title="${esc(`T${it.turn} · #${it.step} · ${it.label}`)}" data-tip-sub="${esc(it.timingTxt || '')}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;--lane:${it.lane}${bgStyle}" aria-label="${esc(`T${it.turn} #${it.step}`)}"></button>`;
    }).join('');

    return `
      <div class="trace-overview" id="traceOverview">
        <div class="trace-lanes-axis">
          <span>${esc(bi('事件', 'Evt'))}</span>
          <span>${esc(bi('模型', 'LLM'))}</span>
          <span>${esc(bi('工具', 'Tool'))}</span>
        </div>
        <div class="trace-plot" id="tracePlot">
          <div class="trace-lane-rules" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="trace-divs" aria-hidden="true">${boundariesHtml}</div>
          <div class="trace-spans">${spansHtml}</div>
          <div class="chart-tip hidden" id="traceTip"></div>
        </div>
      </div>`;
  }

  function renderTurnBodyInner(tr, convId, maxDurSec, matchedStepSet, hasQuery) {
    const steps = Array.isArray(tr.steps) ? tr.steps : [];
    const dVal = Number(tr.contextDelta) || 0;
    const hasTimedSteps = maxDurSec > 0;
    const turnSummaryStrip = renderKvStrip([
      { label: bi('调用 / 工具', 'Calls / Tools'), val: `${tr.plannerCalls}<span class="u">${esc(bi('次', 'c'))}</span> · <span class="t-tool">${tr.toolExecs || 0}</span><span class="u">${esc(bi('工具', 't'))}</span>`, sub: tr.models?.length ? `<span class="t-model">${esc(compactModelShort(tr.models[0]))}${tr.models.length > 1 ? ` +${tr.models.length - 1}` : ''}</span>` : '' },
      { label: bi('上下文', 'Context'), val: tr.endContextTokens ? `<span class="t-ctx">${fmtTok(tr.endContextTokens)}</span>` : '--', sub: dVal ? `<span class="${dVal < 0 ? 'c-green' : dVal >= 50000 ? 'c-amber' : ''}">${fmtSignedTok(dVal)}</span>` : '' },
      { label: bi('速率', 'Speed'), val: tr.avgSpeedTokPerSec ? `<span class="t-speed">${tr.avgSpeedTokPerSec.toFixed(0)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: tr.avgTtftSec ? `ttft ${esc(fmtTtft(tr.avgTtftSec))}${tr.maxTtftSec && tr.maxTtftSec >= 10 ? ` (${esc(bi('峰值', 'max'))} ${esc(fmtTtft(tr.maxTtftSec))})` : ''}` : '' },
      { label: bi('费用 / 缓存', 'Cost / Cache'), val: tr.cost > 0 ? `<span class="t-cost">${fmtCost(tr.cost)}</span>` : '<span class="c-faint">--</span>', sub: `${tr.cacheHitPercent != null && (tr.inputTokens + tr.cacheReadTokens) > 0 ? `${esc(bi('缓存', 'cache'))} ${tr.cacheHitPercent}%` : ''}${tr.totalDurationSec ? `${(tr.inputTokens + tr.cacheReadTokens) > 0 ? ' · ' : ''}${esc(fmtDuration(tr.totalDurationSec))}` : ''}` },
    ]);
    const stepRowsHtml = steps
      .map((st) => renderStepRow(st, maxDurSec, convId, {
        selectedKey: state.selectedTraceStep,
        isMatch: hasQuery && matchedStepSet?.has(`${tr.turn}:${st.step}`),
      }))
      .join('');
    return `
      ${turnSummaryStrip}
      ${stepRowsHtml
        ? `<div class="wf-head">
            <span>${esc(bi('步骤轨迹 · 时间顺序 · 点击任意步骤查看参数与详情', 'Step Trace · Chronological · Click any step to inspect'))}</span>
            ${hasTimedSteps ? `<span class="wf-legend"><span class="wf-leg-chip"><span class="wf-leg-sw ttft"></span>TTFT</span><span class="wf-leg-chip"><span class="wf-leg-sw stream"></span>${esc(bi('生成', 'Stream'))}</span></span>` : ''}
          </div>
          <div class="wf-list">
            <div class="wf-row wf-cols" aria-hidden="true">
              <span></span>
              <span>${esc(bi('步骤', 'Step'))}</span>
              <span>${esc(bi('动作与工具', 'Action & Tools'))}</span>
              <span class="r">${esc(bi('上下文', 'Context'))}</span>
              <span class="r">${esc(bi('速率', 'Speed'))}</span>
              <span class="r">${esc(bi('耗时分布', 'Timing'))}</span>
            </div>
            ${stepRowsHtml}
          </div>`
        : `<div class="card-sub pad-xs mt-sm">${esc(bi('本轮暂无模型步骤记录', 'No steps recorded in this turn'))}</div>`}`;
  }

  function hydrateLazyTurn(turnEl) {
    const body = turnEl?.querySelector(':scope > .tl-turn-body[data-lazy-turn]');
    if (!body) return;
    const tNum = Number(body.getAttribute('data-lazy-turn'));
    body.removeAttribute('data-lazy-turn');
    const tr = traceLookup.turnsByNum.get(tNum);
    if (!tr) return;
    const maxDur = traceLookup.maxDurByTurn.get(tNum) || 0;
    body.innerHTML = renderTurnBodyInner(tr, traceLookup.convId, maxDur, traceLookup.matchedSteps, traceLookup.hasQuery);
  }

  function hydrateLazyStep(stepEl) {
    const slot = stepEl?.querySelector(':scope > [data-lazy-step]');
    if (!slot) return;
    const key = slot.getAttribute('data-lazy-step');
    const st = traceLookup.stepsByKey.get(key);
    if (!st) {
      slot.remove();
      return;
    }
    slot.outerHTML = renderStepDetailCard(st);
  }

  function syncTraceToggleButton(s) {
    const btn = document.querySelector('[data-action="toggle-all-turns"]');
    if (!btn || !s) return;
    const { visibleTurns } = getVisibleTraceTurns(s);
    const anyExpanded = visibleTurns.some((tr) => isFoldOpen(`turn:${s.conversationId}:${tr.turn}`));
    btn.textContent = anyExpanded ? bi('全部收起', 'Collapse') : bi('全部展开', 'Expand');
    btn.title = bi(anyExpanded ? '收起当前所有轮次' : '展开当前所有轮次', anyExpanded ? 'Collapse all turns' : 'Expand all turns');
  }

  function buildTraceBodyHtml(s) {
    const { filteredTurns, visibleTurns, remaining, matchedStepSet, hasQuery } = getVisibleTraceTurns(s);

    const searchStat = document.getElementById('traceSearchStat');
    if (searchStat) {
      searchStat.textContent = hasQuery
        ? bi(`命中 ${filteredTurns.length} 轮 · ${matchedStepSet.size} 步`, `${filteredTurns.length} turns · ${matchedStepSet.size} steps`)
        : '';
    }

    traceLookup.convId = s.conversationId || '';
    traceLookup.turnsByNum.clear();
    traceLookup.stepsByKey.clear();
    traceLookup.maxDurByTurn.clear();
    traceLookup.matchedSteps = hasQuery ? matchedStepSet : null;
    traceLookup.hasQuery = hasQuery;

    if (!visibleTurns.length) {
      return `<div class="empty">${esc(hasQuery ? bi('未匹配到相关轨迹步骤', 'No matching trace steps') : bi('当前筛选下无轮次记录', 'No turns match this filter'))}</div>`;
    }

    const overviewHtml = renderTraceOverviewBar(visibleTurns, matchedStepSet, hasQuery);
    const isRunning = s.runState === 'RUN_STATE_RUNNING';

    const turnsHtml = visibleTurns.map((tr, idx) => {
      const turnFk = `turn:${s.conversationId}:${tr.turn}`;
      const steps = Array.isArray(tr.steps) ? tr.steps : [];
      let nonUserCount = 0;
      let latest = null;
      let maxDurSec = 0;
      let hasMatchedStepsInTurn = false;
      for (const st of steps) {
        if (st.type !== 'USER_INPUT') {
          nonUserCount++;
          latest = st;
        }
        if (st.type === 'PLANNER_RESPONSE') {
          const d = stepTotalDurationSec(st);
          if (d > maxDurSec) maxDurSec = d;
        }
        const key = `${tr.turn}:${st.step}`;
        traceLookup.stepsByKey.set(key, st);
        if (hasQuery && !hasMatchedStepsInTurn && matchedStepSet.has(key)) hasMatchedStepsInTurn = true;
      }
      if (!latest && steps.length) latest = steps[steps.length - 1];
      traceLookup.turnsByNum.set(tr.turn, tr);
      traceLookup.maxDurByTurn.set(tr.turn, maxDurSec);

      const dVal = Number(tr.contextDelta) || 0;
      const isTurnOpen = isFoldOpen(turnFk, hasMatchedStepsInTurn || state.selectedTraceStep.startsWith(`${tr.turn}:`));

      const rowTs = tr.lastTs || latest?.ts || tr.ts || '';
      const fullTs = rowTs ? fmtLocalDateTime(rowTs) : '';
      const isLatestOverall = idx === 0 && state.turnFilter === 'all' && !hasQuery;
      const sigs = Array.isArray(tr.signals) ? tr.signals : [];
      const nodeCls = isLatestOverall && isRunning
        ? 'is-live'
        : tr.errors > 0
          ? 'is-err'
          : tr.checkpoints > 0
            ? 'is-cp'
            : isLatestOverall
              ? 'is-latest'
              : '';

      const latestSnip = stepInlineSnippet(latest);
      const headlineHtml = tr.prompt
        ? `<span class="tl-turn-pill">T${tr.turn}</span><span class="c-fg fw-500 truncate">${esc(tr.prompt)}</span>`
        : `<span class="tl-turn-pill">T${tr.turn}</span><span class="t-model fw-500 shrink-0">${esc(compactModelShort(fmtModelLabel(latest?.model)))}</span>${latestSnip ? `<span class="c-body truncate">${esc(latestSnip.slice(0, 76))}</span>` : ''}`;

      const topToolsInline = (tr.topTools || [])
        .slice(0, 3)
        .map((x) => (x.count > 1 ? `${x.name}×${x.count}` : x.name))
        .join(', ');

      const deltaCls = dVal < 0 ? 'c-green' : dVal >= 40000 ? 'c-amber' : 'c-dim';
      const ctxMetaHtml = tr.endContextTokens
        ? `<span class="t-ctx">${fmtTok(tr.endContextTokens)}</span>${dVal ? ` <span class="${deltaCls}">(${fmtSignedTok(dVal)})</span>` : ''}`
        : '';

      const bodyHtml = isTurnOpen
        ? `<div class="tl-turn-body">${renderTurnBodyInner(tr, s.conversationId, maxDurSec, matchedStepSet, hasQuery)}</div>`
        : `<div class="tl-turn-body" data-lazy-turn="${tr.turn}"></div>`;

      return `
        <details class="tl-turn ${tr.checkpoints ? 'has-cp' : ''}" data-fold-key="${esc(turnFk)}" data-turn-num="${tr.turn}" ${isTurnOpen ? 'open' : ''}>
          <summary class="tl-turn-head" title="${esc(tr.prompt || `T${tr.turn}`)}">
            <span class="tl-node ${nodeCls}"></span>
            <div class="tl-line1">
              <div class="tl-headline">
                ${CHEV_SVG}
                ${headlineHtml}
              </div>
              <div class="tl-right">
                ${tr.totalDurationSec ? `<span class="c-dim fs-11">${esc(fmtDuration(tr.totalDurationSec))}</span>` : ''}
                ${tr.cost > 0 ? `<span class="t-cost fw-500">${fmtCost(tr.cost)}</span>` : ''}
                <span class="tl-time" title="${esc(fullTs)}">${esc(fmtTimeHM(rowTs))}</span>
              </div>
            </div>
            <div class="tl-line2">
              ${nonUserCount > 0 ? `<span>${nonUserCount} ${esc(bi('步', 'steps'))}</span>` : ''}
              ${tr.toolExecs > 0 ? `<span class="tl-sep">·</span><span><span class="t-tool">${tr.toolExecs}</span> ${esc(bi('工具', 'tools'))}</span>` : ''}
              ${ctxMetaHtml ? `<span class="tl-sep">·</span><span>${ctxMetaHtml}</span>` : ''}
              ${topToolsInline ? `<span class="tl-sep">·</span><span class="mono fs-105 c-dim truncate" style="max-width:240px">${esc(topToolsInline)}</span>` : ''}
              ${tr.checkpoints ? `<span class="turn-flag cp" title="${esc(bi(`本轮触发 ${tr.checkpoints} 次上下文压缩`, `${tr.checkpoints} compaction(s)`))}">⚡${esc(bi('压缩', 'CP'))}${tr.checkpoints > 1 ? ` ×${tr.checkpoints}` : ''}</span>` : ''}
              ${tr.errors ? `<span class="turn-flag err" title="${esc(bi(`本轮出现 ${tr.errors} 次报错`, `${tr.errors} error(s)`))}">${tr.errors} ${esc(bi('报错', 'err'))}</span>` : ''}
              ${sigs.map((sg) => `<span class="turn-flag sig">${esc(traceSignalLabel(sg))}</span>`).join('')}
            </div>
          </summary>
          ${bodyHtml}
        </details>`;
    }).join('');

    const pagerHtml = remaining > 0
      ? `<div class="turn-pager"><button class="link-btn" type="button" data-action="more-turns">${esc(bi(`加载更多轮次（还有 ${remaining} 轮）`, `Load more turns (${remaining} remaining)`))}</button></div>`
      : (filteredTurns.length > 10 && state.turnLimit > 10 && !hasQuery
          ? `<div class="turn-pager"><button class="link-btn" type="button" data-action="reset-turns">${esc(bi('收起至最新 10 轮', 'Show latest 10 turns'))}</button></div>`
          : '');

    return `${overviewHtml}<div class="turn-timeline">${turnsHtml}</div>${pagerHtml}`;
  }

  function renderInspectorStepsPanel(s) {
    const ss = s.stepSummary || {};
    const turns = Array.isArray(s.mainTurns) ? s.mainTurns : [];
    if (!turns.length && !(ss.total > 0)) {
      return `<div class="empty">${esc(bi('暂无对话轮次记录', 'No turns recorded yet'))}</div>`;
    }
    const cpTurnCount = turns.filter((tr) => tr.checkpoints > 0).length;
    const errTurnCount = turns.filter((tr) => tr.errors > 0).length;
    const sigTurnCount = turns.filter((tr) => (tr.signals || []).length > 0).length;
    if (state.turnFilter === 'checkpoint' && cpTurnCount === 0) state.turnFilter = 'all';
    if (state.turnFilter === 'error' && errTurnCount === 0) state.turnFilter = 'all';
    if (state.turnFilter === 'signal' && sigTurnCount === 0) state.turnFilter = 'all';

    const filterBtns = [];
    if (cpTurnCount > 0 || errTurnCount > 0 || sigTurnCount > 0) {
      filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'all' ? 'active' : ''}" type="button" data-turn-filter="all">${esc(bi('全部', 'All'))} <span class="mono">${turns.length}</span></button>`);
      if (cpTurnCount > 0) {
        filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'checkpoint' ? 'active' : ''}" type="button" data-turn-filter="checkpoint" title="${esc(bi(`会话累计 ${ss.checkpoint || cpTurnCount} 次压缩，最近 30 轮中 ${cpTurnCount} 轮触发`, `${ss.checkpoint || cpTurnCount} total compactions; ${cpTurnCount} in recent turns`))}"><span class="dot sm amber"></span>${esc(bi('压缩', 'CP'))} <span class="mono">${cpTurnCount}</span></button>`);
      }
      if (errTurnCount > 0) {
        filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'error' ? 'active' : ''}" type="button" data-turn-filter="error" title="${esc(bi(`主会话累计 ${ss.error || errTurnCount} 次报错，最近 30 轮中 ${errTurnCount} 轮出现`, `${ss.error || errTurnCount} total main errors; ${errTurnCount} in recent turns`))}"><span class="dot sm red"></span>${esc(bi('报错', 'Err'))} <span class="mono">${errTurnCount}</span></button>`);
      }
      if (sigTurnCount > 0) {
        filterBtns.push(`<button class="filter-pill ${state.turnFilter === 'signal' ? 'active' : ''}" type="button" data-turn-filter="signal" title="${esc(bi('包含慢耗时、缓存骤降或高频重复调用的轮次', 'Turns with slow latency, cache drop, or repeated tool loops'))}"><span class="dot sm accent"></span>${esc(bi('异常', 'Signals'))} <span class="mono">${sigTurnCount}</span></button>`);
      }
    }

    const { visibleTurns, filteredTurns, matchedStepSet, hasQuery } = getVisibleTraceTurns(s);
    const anyExpanded = visibleTurns.some((tr) => isFoldOpen(`turn:${s.conversationId}:${tr.turn}`));
    const initialSearchStat = hasQuery
      ? bi(`命中 ${filteredTurns.length} 轮 · ${matchedStepSet.size} 步`, `${filteredTurns.length} turns · ${matchedStepSet.size} steps`)
      : '';

    return `
      <div class="trace-toolbar">
        <div class="trace-toolbar-top">
          <div class="row-flex gap-sm wrap">
            <div class="stage-meta tnum">
              <span class="c-fg fw-500">#${(ss.maxStep || ss.total || 0).toLocaleString()}</span> ${esc(bi('总步数', 'steps'))} ·
              ${esc(bi('本窗口', 'Window'))} <span class="c-body">${(ss.sinceCheckpoint || 0).toLocaleString()}</span>
            </div>
            ${filterBtns.length ? `<div class="row-flex gap-xs wrap">${filterBtns.join('')}</div>` : ''}
          </div>
          <div class="row-flex gap-xs shrink-0">
            ${renderSegmented([['sequence', bi('顺序', 'Seq')], ['duration', bi('耗时', 'Dur')]], state.traceTimelineMode, 'data-trace-mode')}
            <button class="ghost-btn" type="button" data-action="toggle-all-turns" title="${esc(bi(anyExpanded ? '收起当前所有轮次' : '展开当前所有轮次', anyExpanded ? 'Collapse all turns' : 'Expand all turns'))}">${esc(anyExpanded ? bi('全部收起', 'Collapse') : bi('全部展开', 'Expand'))}</button>
          </div>
        </div>
        <div class="trace-search-row">
          <div class="search-row mb-0 flex-1">
            <svg class="search-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 13.75 13.75" />
            </svg>
            <input class="search-input trace-search-input" id="traceSearchInput" type="search" value="${esc(state.traceSearch)}" placeholder="${esc(bi('搜索轨迹：用户输入、工具名、参数、模型或报错…', 'Search trace: prompts, tools, args, models, errors…'))}" />
          </div>
          <span class="card-sub tnum shrink-0" id="traceSearchStat">${esc(initialSearchStat)}</span>
        </div>
      </div>
      <div id="traceBody">${buildTraceBodyHtml(s)}</div>`;
  }

  function renderInspectorToolsPanel(s) {
    const list = s.toolRanking || [];
    if (!list.length) {
      return `<div class="empty">${esc(bi('暂无工具调用记录', 'No tool calls recorded'))}</div>`;
    }
    const maxTool = list[0]?.count || 1;
    const totalTools = Math.max(1, s.totals.toolCalls || list.reduce((a, r) => a + r.count, 0));
    const toolScopeLabel = s.totals?.sideQuestionCount > 0
      ? bi('主会话 + 侧边会话 + 子代理合计', 'Main + Side Chats + Subagents')
      : bi('主会话 + 全部子代理合计', 'Main + All Subagents');
    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${esc(toolScopeLabel)} · ${totalTools.toLocaleString()} ${esc(bi('次调用', 'calls'))} · ${list.length} ${esc(bi('种工具', 'tools'))}</div>
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

  /** Shared expandable list renderer for both Side Chats and Subagents inspector tabs. */
  function renderChildConversationsPanel(items, {
    emptyText,
    gridCls,
    col1Label,
    col4Label = '',
    countUnit,
    foldPrefix,
    showAll,
    toggleAction,
    toggleLessText,
    toggleMoreText,
    showRunningHead = false,
    renderTitleCell,
    renderCallsSub,
    renderActions,
  }) {
    if (!items.length) return `<div class="empty">${esc(emptyText)}</div>`;
    const totalCalls = items.reduce((a, x) => a + (x.calls || 0), 0);
    const totalCost = items.reduce((a, x) => a + (x.cost || 0), 0);
    const runningCount = showRunningHead ? items.filter((x) => x.runState === 'RUN_STATE_RUNNING').length : 0;
    const LIMIT = 10;
    const visible = showAll ? items : items.slice(0, LIMIT);
    const hidden = Math.max(0, items.length - visible.length);

    const headerRow = `
      <div class="${gridCls} sub-tbl-head">
        <span>${esc(col1Label)}</span>
        <span>${esc(bi('上下文', 'Context'))}</span>
        <span class="r">${esc(bi('费用', 'Cost'))}</span>
        <span class="r">${esc(col4Label)}</span>
      </div>`;

    const rowsHtml = visible.map((item) => {
      const isRunning = item.runState === 'RUN_STATE_RUNNING';
      const ctxCol = pctColor(item.usagePercent || 0, false);
      const pctCls = ctxCol === 'accent' ? 'c-dim' : `c-${ctxCol} fw-500`;
      const extraFk = `${foldPrefix}:${item.id}`;
      const modelShort = compactModelShort(fmtModelLabel(item.model));
      const ctxTip = item.contextUsed ? `${fmtTok(item.contextUsed)} / ${fmtTok(item.contextLimit)} (${item.usagePercent.toFixed(1)}%)` : '';
      const totalIn = (item.inputTokens || 0) + (item.cacheReadTokens || 0);
      const speedSub = [
        item.avgTtftSec ? `ttft ${fmtTtft(item.avgTtftSec)}` : '',
        item.avgLatencySec ? bi(`平均耗时 ${fmtSec(item.avgLatencySec)}`, `avg ${fmtSec(item.avgLatencySec)}`) : '',
      ].filter(Boolean).join(' · ');
      const strip = renderKvStrip([
        { label: bi('上下文', 'Context'), val: item.contextUsed ? `<span class="t-ctx">${fmtTok(item.contextUsed)}</span><span class="u">/${fmtTok(item.contextLimit)}</span>` : '--', sub: `${item.usagePercent.toFixed(1)}% · <span class="t-model">${esc(modelShort)}</span>` },
        { label: bi('调用 / 工具', 'Calls / Tools'), val: `${item.calls}<span class="u">${esc(bi('次', 'c'))}</span> · <span class="t-tool">${item.toolCount}</span><span class="u">${esc(bi('工具', 't'))}</span>`, sub: esc(renderCallsSub(item)) },
        { label: bi('输入 / 输出', 'In / Out'), val: `<span class="t-in">↓${fmtTok(totalIn)}</span> <span class="c-faint">/</span> <span class="t-out">↑${fmtTok(item.outputTokens)}</span>`, sub: item.cacheHitPercent != null && totalIn > 0 ? `${esc(bi('缓存', 'cache'))} ${item.cacheHitPercent}%` : '' },
        { label: bi('速率', 'Speed'), val: item.outputTokensPerSec ? `<span class="t-speed">${item.outputTokensPerSec.toFixed(1)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: esc(speedSub) },
      ]);

      return `
        <details class="sub-tbl-item ${isRunning ? 'is-running' : ''}" data-fold-key="${esc(extraFk)}" ${isFoldOpen(extraFk) ? 'open' : ''}>
          <summary>
            <div class="${gridCls} sub-tbl-row">
              ${renderTitleCell(item, { isRunning, modelShort })}
              <div class="inline-gauge" title="${esc(ctxTip)}">
                ${item.contextUsed
                  ? `<div class="inline-gauge-track"><div class="bar-fill ${ctxCol}" style="width:${Math.min(100, item.usagePercent).toFixed(1)}%"></div></div>
                     <span class="inline-gauge-pct ${pctCls}">${item.usagePercent.toFixed(0)}%</span>`
                  : `<span class="tnum c-faint fs-115">--</span>`}
              </div>
              <div class="r tnum fs-125 ${item.cost > 0 ? 't-cost fw-500' : 'c-faint'}">${item.cost > 0 ? fmtCost(item.cost) : '--'}</div>
              <div class="sess-acts">${renderActions(item)}</div>
            </div>
          </summary>
          <div class="sub-tbl-expand">
            ${strip}
            ${item.modelBreakdown?.length > 1 ? `<div class="mt-sm">${renderModelPerfTable(item.modelBreakdown, { compact: true })}</div>` : ''}
            ${item.topTools?.length ? `<div class="sub-tools">${item.topTools.map((x) => `<span class="quiet-chip mono"><span class="t-tool">${esc(x.name)}</span> ×${x.count}</span>`).join('')}</div>` : ''}
          </div>
        </details>`;
    }).join('');

    const moreBtn = items.length > LIMIT
      ? `<button class="link-btn mt-sm" type="button" data-action="${toggleAction}">${esc(showAll ? toggleLessText(LIMIT) : toggleMoreText(hidden, items.length))}</button>`
      : '';

    return `
      <div class="stage-head">
        <div class="stage-meta tnum">${runningCount ? `<span class="c-green fw-600">${runningCount} ${esc(bi('运行中', 'running'))}</span> · ` : ''}${items.length} ${esc(countUnit)} · ${totalCalls.toLocaleString()} ${esc(bi('次调用', 'calls'))}${totalCost > 0 ? ` · <span class="t-cost fw-600">${fmtCost(totalCost)}</span>` : ''}</div>
      </div>
      ${headerRow}
      <div class="hairline-list">${rowsHtml}</div>
      ${moreBtn}`;
  }

  function renderInspectorSideQuestionsPanel(s) {
    return renderChildConversationsPanel(s.sideQuestions || [], {
      emptyText: bi('当前会话暂无侧边会话', 'No side chats in this session'),
      gridCls: 'sess-grid',
      col1Label: bi('侧边会话', 'Side Chat'),
      col4Label: bi('操作', 'Actions'),
      countUnit: bi('个侧边会话', 'side chats'),
      foldPrefix: 'side-extra',
      showAll: state.showAllSideQuestions,
      toggleAction: 'toggle-sides',
      toggleLessText: (lim) => bi(`收起侧边会话列表（仅显示前 ${lim} 个）`, `Show top ${lim} side chats`),
      toggleMoreText: (h, tot) => bi(`展开其余 ${h} 个侧边会话（共 ${tot} 个）`, `Show ${h} more side chats (${tot} total)`),
      renderTitleCell: (sq, { modelShort }) => {
        const relTime = fmtRelativeTime(sq.updateTime);
        return `
          <div class="sess-main">
            <div class="sess-title-line">
              ${CHEV_SVG}
              <span class="sess-title" title="${esc(sq.title)}">${esc(sq.title)}</span>
              ${sq.subagentCount ? `<span class="scope-pill">+${sq.subagentCount} ${esc(bi('子代理', 'sub'))}</span>` : ''}
            </div>
            <div class="sess-sub-line">
              <span class="t-model">${esc(modelShort)}</span>
              ${relTime ? `<span title="${esc(fmtLocalDateTime(sq.updateTime))}">· ${esc(relTime)}</span>` : ''}
            </div>
          </div>`;
      },
      renderCallsSub: (sq) => [
        sq.turns ? `${sq.turns} ${bi('轮对话', 'turns')}` : '',
        sq.subagentCount ? `+${sq.subagentCount} ${bi('子代理', 'sub')}` : '',
      ].filter(Boolean).join(' · '),
      renderActions: (sq) => `
        <button class="ghost-btn" type="button" data-inspect-conv="${esc(sq.id)}" title="${esc(bi('查看该侧边会话的独立上下文与轨迹', 'Inspect side chat context & trace'))}">${esc(bi('监控', 'View'))}</button>
        <button class="ghost-btn icon-sq" type="button" data-jump-conv="${esc(sq.id)}" title="${esc(bi('在编辑器中打开该侧边会话', 'Open side chat'))}">↗</button>`,
    });
  }

  function renderInspectorSubagentsPanel(s) {
    return renderChildConversationsPanel(s.subagents || [], {
      emptyText: bi('当前会话未派生子代理', 'No subagents spawned in this session'),
      gridCls: 'sub-tbl-grid',
      col1Label: bi('子代理', 'Subagent'),
      countUnit: bi('个子代理', 'subagents'),
      foldPrefix: 'sub-extra',
      showAll: state.showAllSubagents,
      toggleAction: 'toggle-subs',
      toggleLessText: (lim) => bi(`收起子代理列表（仅显示前 ${lim} 个）`, `Show top ${lim} subagents`),
      toggleMoreText: (h, tot) => bi(`展开其余 ${h} 个子代理（共 ${tot} 个）`, `Show ${h} more subagents (${tot} total)`),
      showRunningHead: true,
      renderTitleCell: (sub, { isRunning, modelShort }) => `
        <div class="sess-title-line">
          ${CHEV_SVG}
          ${isRunning ? '<span class="dot sm green pulse-dot"></span>' : ''}
          <span class="sess-title" title="${esc(sub.title)}">${esc(sub.title)}</span>
          <span class="t-model fs-11 shrink-0">${esc(modelShort)}</span>
        </div>`,
      renderCallsSub: (sub) => [
        sub.agentType || '',
        sub.parentSideId ? bi(`侧边: ${sub.parentSideTitle || sub.parentSideId.slice(0, 8)}`, `side: ${sub.parentSideTitle || sub.parentSideId.slice(0, 8)}`) : '',
      ].filter(Boolean).join(' · '),
      renderActions: (sub) => `
        <button class="ghost-btn icon-sq" type="button" data-jump-conv="${esc(sub.id)}" title="${esc(bi('跳转到该子代理', 'Open subagent'))}">↗</button>`,
    });
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
          ${esc(bi('主会话', 'Main'))} ${sum.mainCount}
          ${sum.sideQuestionCount > 0 ? ` · ${esc(bi('侧边', 'Side'))} ${sum.sideQuestionCount}` : ''}
          · ${esc(bi('子代理', 'Sub'))} ${sum.subagentCount}
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
    const sideCount = t.sideQuestionCount ?? (s.sideQuestions || []).length;
    const showSidesTab = !s.isSideQuestion || sideCount > 0;
    if (!showSidesTab && state.inspectorTab === 'sides') state.inspectorTab = 'models';

    const totalModels = (s.modelBreakdown || []).length;
    const activeModels = (s.activeModelBreakdown || []).length;
    const modelVal = activeModels > 0 && activeModels < totalModels ? `${activeModels}/${totalModels}` : `${totalModels}`;

    const tabs = [
      { id: 'models', label: bi('模型', 'Models'), val: modelVal, cls: '' },
      { id: 'context', label: bi('上下文', 'Context'), val: `${s.usagePercent.toFixed(0)}%`, cls: ctxCol === 'accent' ? '' : `c-${ctxCol}` },
      { id: 'steps', label: bi('轨迹', 'Trace'), val: `${s.turns}`, cls: '' },
      { id: 'tools', label: bi('工具', 'Tools'), val: fmtTok(t.toolCalls), cls: '' },
      ...(showSidesTab ? [{ id: 'sides', label: bi('侧边', 'Side'), val: `${sideCount}`, cls: sideCount > 0 ? '' : 'c-dim' }] : []),
      { id: 'subagents', label: bi('子代理', 'Subagents'), val: `${t.subagentCount}`, cls: runningSubs ? 'c-green' : '', dot: runningSubs > 0 },
      { id: 'errors', label: bi('报错', 'Errors'), val: `${errTotal}`, cls: errTotal > 0 ? 'c-red' : 'c-dim' },
    ];

    const stageHtml = {
      models: () => renderInspectorModelsPanel(s),
      context: () => renderInspectorContextPanel(s),
      steps: () => renderInspectorStepsPanel(s),
      tools: () => renderInspectorToolsPanel(s),
      sides: () => renderInspectorSideQuestionsPanel(s),
      subagents: () => renderInspectorSubagentsPanel(s),
      errors: () => renderInspectorErrorsPanel(s),
    }[state.inspectorTab]?.() || renderInspectorModelsPanel(s);

    const isFlushStage = state.inspectorTab === 'steps';
    return `
      <section class="inspector" id="inspectorHost">
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

  function computeSessionSig(s) {
    const t = s.totals;
    return JSON.stringify([
      state.lang, state.inspectorTab, state.modelSortBy, state.showAllSubagents, state.showAllSideQuestions, state.turnLimit, state.turnFilter,
      state.traceTimelineMode, state.selectedTraceStep, state.errCategoryFilter,
      s.conversationId, s.isSideQuestion, s.parentSession?.id, s.runState, s.model, s.contextUsed, s.contextLimit, s.turns, s.checkpoints,
      s.stepSummary?.maxStep, s.stepSummary?.total, (s.mainTurns || []).length, s.mainTurns?.[0]?.endStep,
      s.contextBreakdown?.source, (s.contextBreakdown?.groups || []).length,
      t.calls, t.inputTokens, t.cacheReadTokens, t.outputTokens,
      t.outputTokensPerSec, t.avgTtftSec, t.avgLatencySec, Math.round((t.cost || 0) * 10000),
      t.errorCount, t.toolCalls, t.sideQuestionCount, (s.modelBreakdown || []).length,
      s.activeCycle?.modelCount, s.activeCycle?.calls, Math.round((s.activeCycle?.cost || 0) * 10000), s.activeCycle?.endTs,
      (s.sideQuestions || []).map((x) => [x.id, x.title, x.calls, x.contextUsed, Math.round((x.cost || 0) * 100)]),
      (s.subagents || []).map((x) => [x.id, x.runState, x.model, x.calls, x.contextUsed, Math.round((x.cost || 0) * 100), x.outputTokensPerSec, x.avgTtftSec]),
      getChartPlotWidth(),
    ]);
  }

  /** Surgically re-render only the Inspector card without rebuilding Hero or Context Timeline SVG. */
  function rerenderInspectorSection() {
    const s = state.overview?.session;
    const host = document.getElementById('inspectorHost');
    if (!s || !host) {
      renderSessionTab(mainEl);
      return;
    }
    const hadTraceFocus = document.activeElement?.id === 'traceSearchInput';
    const traceCaret = hadTraceFocus ? document.activeElement.selectionStart : null;
    host.outerHTML = renderSessionInspector(s);
    state.lastSessionSig = computeSessionSig(s);
    if (hadTraceFocus && state.inspectorTab === 'steps') {
      const inp = document.getElementById('traceSearchInput');
      if (inp) {
        inp.focus();
        if (traceCaret != null) inp.setSelectionRange(traceCaret, traceCaret);
      }
    }
  }

  /** Surgically re-render only `#traceBody` without touching Hero, SVG, or search input. */
  function rerenderTraceBody() {
    const s = state.overview?.session;
    const bodyEl = document.getElementById('traceBody');
    if (!s || !bodyEl) {
      rerenderInspectorSection();
      return;
    }
    bodyEl.innerHTML = buildTraceBodyHtml(s);
    syncTraceToggleButton(s);
    state.lastSessionSig = computeSessionSig(s);
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
      state.showAllSideQuestions = false;
      state.turnLimit = 10;
      state.turnFilter = 'all';
      state.traceSearch = '';
      state.selectedTraceStep = '';
      state.errCategoryFilter = 'all';
    }

    const sig = computeSessionSig(s);
    if (el.dataset.renderedTab === 'session' && state.lastSessionSig === sig) return;
    const hadTraceFocus = document.activeElement?.id === 'traceSearchInput';
    const traceCaret = hadTraceFocus ? document.activeElement.selectionStart : null;
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

    const sideBannerHtml = s.isSideQuestion && s.parentSession
      ? `<div class="inspect-banner">
          <span class="truncate">${esc(bi('正在查看侧边会话', 'Inspecting side chat'))}${s.parentSession.title ? ` · <span class="c-dim">${esc(bi('所属主会话', 'Parent'))}: ${esc(s.parentSession.title)}</span>` : ''}</span>
          <div class="row-flex gap-xs shrink-0">
            <button class="icon-btn" type="button" data-inspect-conv="${esc(s.parentSession.id)}">${esc(bi('返回所属主会话', 'Parent Session'))}</button>
            ${isInspectingOther && state.hostConvId !== s.parentSession.id ? `<button class="ghost-btn" type="button" data-action="back-active">${esc(bi('返回当前对话', 'Active Chat'))}</button>` : ''}
          </div>
        </div>`
      : isInspectingOther
        ? `<div class="inspect-banner">
            <span>${esc(bi('正在查看历史会话监控', 'Inspecting historical session'))}</span>
            <button class="icon-btn" type="button" data-action="back-active">${esc(bi('返回当前对话', 'Back to Active Chat'))}</button>
          </div>`
        : '';

    const callsBreakdownSub = t.sideQuestionCount || t.subagentCount
      ? [
          bi(`主 ${s.mainCalls}`, `M ${s.mainCalls}`),
          t.sideQuestionCount ? bi(`${t.sideQuestionCount} 侧边`, `${t.sideQuestionCount} side`) : '',
          t.subagentCount ? bi(`${t.subagentCount} 子代理`, `${t.subagentCount} sub`) : '',
        ].filter(Boolean).join(' · ')
      : s.isSideQuestion ? bi('仅当前侧边会话', 'Side chat only') : bi('仅主会话', 'Main only');

    const prevScroll = window.scrollY;
    el.innerHTML = `
      ${sideBannerHtml}

      <section class="card card-hero">
        <div class="card-head">
          <div class="min-w-0">
            <div class="session-title" title="${esc(s.title)}">${esc(s.title)}</div>
            <div class="card-sub mt-xs">${s.isSideQuestion ? `<span class="scope-pill">${esc(bi('侧边会话', 'Side Chat'))}</span> · ` : ''}<span class="t-model">${esc(fmtModelLabel(s.model))}</span> · ${s.turns} ${esc(bi('轮对话', 'turns'))}${s.checkpoints ? ` · <span class="c-amber" title="${esc(cpTip)}">${s.checkpoints} ${esc(bi('次压缩', 'compactions'))}</span>` : ''}${t.errorCount ? ` · <span class="c-red">${t.errorCount} ${esc(bi('报错', 'err'))}</span>` : ''}</div>
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
              <div class="metric-sub">${esc(callsBreakdownSub)}</div>
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

    bindContextChartHover(s.contextPoints, s.contextLimit);
    if (state.inspectorTab === 'steps' && hadTraceFocus) {
      const inp = document.getElementById('traceSearchInput');
      if (inp) {
        inp.focus();
        if (traceCaret != null) inp.setSelectionRange(traceCaret, traceCaret);
      }
    }
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
      const childCellLabel = s.sideQuestionCount > 0 && s.subagentCount > 0
        ? bi('侧边 / 子代理', 'Side / Sub')
        : s.sideQuestionCount > 0
          ? bi('侧边会话', 'Side Chats')
          : bi('子代理', 'Subagents');
      const childCellVal = s.sideQuestionCount > 0 && s.subagentCount > 0
        ? `${s.sideQuestionCount}<span class="u">${esc(bi('侧', 's'))}</span> · ${s.subagentCount}<span class="u">${esc(bi('子', 'a'))}</span>`
        : `${(s.sideQuestionCount || s.subagentCount || 0)}<span class="u">${esc(bi('个', ''))}</span>`;
      const sessStrip = renderKvStrip([
        { label: bi('调用', 'Calls'), val: s.calls ? `${s.calls.toLocaleString()}<span class="u">${esc(bi('次', 'c'))}</span>` : '--', sub: s.turns ? `${s.turns} ${esc(bi('轮对话', 'turns'))}` : '' },
        { label: bi('速率', 'Speed'), val: s.outputTokensPerSec ? `<span class="t-speed">${s.outputTokensPerSec.toFixed(1)}</span><span class="u">t/s</span>` : '<span class="c-faint">--</span>', sub: esc(sessSpeedSub) },
        { label: bi('上下文', 'Context'), val: s.contextUsed ? `<span class="t-ctx">${fmtTok(s.contextUsed)}</span><span class="u">/${fmtTok(s.contextLimit)}</span>` : '--', sub: s.contextUsed ? `${s.usagePercent.toFixed(1)}%` : '' },
        { label: childCellLabel, val: childCellVal, sub: fullTime ? esc(fullTime) : '' },
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
                ${s.sideQuestionCount ? `<span>· ${s.sideQuestionCount} ${esc(bi('侧边', 'side'))}</span>` : ''}
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

  // ── Tab 4: Models & Quotas Console (Aggregated by Model Family + 5h & Weekly Dual Windows) ──

  function renderQuotaWindowCell(w, fallbackPct = null, fallbackReset = '') {
    const hasWin = Boolean(w && w.remainingPercent != null);
    const pct = hasWin ? w.remainingPercent : fallbackPct;
    const resetTime = hasWin ? (w.resetTime || '') : fallbackReset;
    if (pct == null) return '<div class="fam-win"><span class="c-faint fs-11">--</span></div>';
    const col = pctColor(pct, true);
    const cd = hasWin ? fmtWindowReset(w) : (resetTime ? fmtCountdown(resetTime) : (pct >= 100 ? bi('满额', 'Full') : '--'));
    const tip = resetTime ? `${fmtQuotaPct(pct)} · ${bi('重置时间', 'Resets')}: ${fmtLocalDateTime(resetTime)}` : fmtQuotaPct(pct);
    return `
      <div class="fam-win" title="${esc(tip)}">
        <div class="fam-win-top">
          <span class="fw-600 c-${col} tnum">${esc(fmtQuotaPct(pct))}</span>
          <span class="c-dim fs-105 tnum truncate">${esc(cd)}</span>
        </div>
        <div class="bar-track bar-xs"><div class="bar-fill ${col}" style="width:${clampPct(pct)}%"></div></div>
      </div>`;
  }

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

    const families = Array.isArray(m.families) ? m.families : [];
    const geminiFams = families.filter((x) => x.pool === 'gemini');
    const premiumFams = families.filter((x) => x.pool === 'premium');
    const filtered = state.modelPoolFilter === 'all' ? families : families.filter((item) => item.pool === state.modelPoolFilter);
    const filteredVariants = filtered.reduce((sum, f) => sum + (f.members?.length || 1), 0);

    const famCountByPool = { gemini: geminiFams.length, premium: premiumFams.length };
    const poolCardsHtml = (m.resetPools || []).map((p) => {
      const isSelected = state.modelPoolFilter === p.poolKey;
      const poolTitle = p.poolKey === 'gemini' ? bi('Gemini 额度池', 'Gemini Pool') : bi('Claude / GPT 额度池', 'Claude / GPT Pool');
      const famCnt = famCountByPool[p.poolKey] || 0;
      const dotCls = p.poolKey === 'premium' ? 'fam-claude' : 'fam-neon';
      const wins = [
        p.fiveHour ? { lbl: bi('5h 限额', '5-Hour Limit'), w: p.fiveHour } : null,
        p.weekly ? { lbl: bi('周限', 'Weekly Limit'), w: p.weekly } : null,
      ].filter(Boolean);
      if (!wins.length) {
        wins.push({
          lbl: bi('配额余量', 'Quota Remaining'),
          w: { remainingPercent: p.remainingPercent, resetTime: p.resetTime },
        });
      }
      return `
        <button class="pool-card ${isSelected ? 'active' : ''}" type="button" data-pool-filter="${isSelected ? 'all' : esc(p.poolKey)}">
          <div class="pool-card-head">
            <span class="row-flex gap-xs fw-600 fs-13 c-fg"><span class="dot sm ${dotCls}"></span>${esc(poolTitle)}</span>
            <span class="tnum fs-11 c-dim">${famCnt} ${esc(bi('家族', 'fam'))} · ${p.modelCount} ${esc(bi('规格', 'tiers'))}</span>
          </div>
          <div class="pool-dual-grid ${wins.length === 1 ? 'single' : ''}">
            ${wins.map(({ lbl, w }) => {
              const pct = w.remainingPercent ?? 0;
              const col = pctColor(pct, true);
              const tip = w.resetTime ? `${lbl}: ${fmtQuotaPct(pct)} · ${fmtLocalDateTime(w.resetTime)}` : `${lbl}: ${fmtQuotaPct(pct)}`;
              return `
                <div class="pool-win" title="${esc(tip)}">
                  <div class="pool-win-head">
                    <span class="pool-win-lbl">${esc(lbl)}</span>
                    <span class="pool-win-pct c-${col}">${esc(fmtQuotaPct(pct))}</span>
                  </div>
                  <div class="bar-track"><div class="bar-fill ${col}" style="width:${clampPct(pct)}%"></div></div>
                  <div class="pool-win-reset">${esc(fmtWindowReset(w, true))}</div>
                </div>`;
            }).join('')}
          </div>
        </button>`;
    }).join('');

    const grouped = new Map([['gemini4', []], ['gemini3', []], ['claude', []], ['other', []]]);
    for (const fam of filtered) {
      grouped.get(modelSeriesGroup(fam.familyLabel, fam.familyKey)).push(fam);
    }

    const groupsHtml = [...grouped.entries()]
      .filter(([, rows]) => rows.length > 0)
      .map(([gKey, rows]) => `
        <div class="spec-group">
          <div class="spec-group-head">
            <span>${esc(seriesGroupTitle(gKey))}</span>
            <span class="tnum c-dim">${rows.length} ${esc(bi('个家族', 'families'))}</span>
          </div>
          <div class="fam-list">
            ${rows.map((fam) => {
              const fk = `fam:${fam.pool}:${fam.familyKey}`;
              const members = fam.members || [];
              const dotCls = fam.pool === 'premium' ? 'fam-claude' : 'fam-neon';
              const variantSummary = (fam.variants || []).length
                ? fam.variants.join(' · ')
                : `${members.length} ${bi('规格', 'tier')}`;
              const thinkCap = fam.supportsAdaptiveThinking
                ? bi('自适应思考', 'Adaptive')
                : fam.supportsThinking ? bi('思考', 'Thinking') : '';
              const ctxTip = [
                fam.cpLimit ? `${bi('压缩上限', 'Compaction')}: ${fmtTok(fam.cpLimit)}` : '',
                fam.maxTokens ? `${bi('原生上下文', 'Native')}: ${fmtTok(fam.maxTokens)}` : '',
                fam.maxOutputTokens ? `${bi('最大输出', 'Max Output')}: ${fmtTok(fam.maxOutputTokens)}` : '',
              ].filter(Boolean).join(' · ');

              const fiveCell = renderQuotaWindowCell(fam.fiveHour, fam.remainingPercent, fam.resetTime);
              const weekCell = renderQuotaWindowCell(fam.weekly);

              const memberRowsHtml = members.map((mb) => {
                const mCol = pctColor(mb.remainingPercent ?? 100, true);
                const cpStr = mb.cpLimit ? fmtTok(mb.cpLimit) : '--';
                const maxStr = mb.maxTokens ? fmtTok(mb.maxTokens) : '--';
                const outStr = mb.maxOutputTokens ? fmtTok(mb.maxOutputTokens) : '--';
                return `
                  <tr>
                    <td class="tbl-name">
                      <span class="row-flex gap-xs min-w-0">
                        <span class="t-model truncate">${esc(mb.label)}</span>
                        ${mb.tagTitle ? `<span class="scope-pill">${esc(mb.tagTitle)}</span>` : ''}
                      </span>
                    </td>
                    <td class="mono fs-105 c-dim truncate" title="${esc(mb.slug || mb.modelId)}">${esc(mb.slug || mb.modelId || '--')}</td>
                    <td class="num fs-11 tnum"><span class="t-ctx">${esc(cpStr)}</span> <span class="c-faint">/</span> <span class="c-dim">${esc(maxStr)} / ${esc(outStr)}</span></td>
                    <td class="num fs-11 tnum">
                      <span class="c-${mCol} fw-600">${esc(fmtQuotaPct(mb.remainingPercent))}</span>
                      ${mb.resetTime ? `<span class="c-dim"> · ${esc(fmtCountdown(mb.resetTime))}</span>` : ''}
                    </td>
                  </tr>`;
              }).join('');

              return `
                <details class="fam-item" data-fold-key="${esc(fk)}" ${isFoldOpen(fk) ? 'open' : ''}>
                  <summary class="fam-grid fam-row">
                    <div class="fam-main">
                      <div class="fam-title-line">
                        ${CHEV_SVG}
                        <span class="dot sm ${dotCls}"></span>
                        <span class="t-model fw-500 truncate">${esc(fam.familyLabel)}</span>
                        ${(fam.tags || []).slice(0, 2).map((t) => `<span class="scope-pill">${esc(t)}</span>`).join('')}
                      </div>
                      <div class="fam-sub-line">
                        <span class="truncate">${esc(variantSummary)}</span>
                        ${thinkCap ? `<span class="c-faint">·</span><span>${esc(thinkCap)}</span>` : ''}
                      </div>
                    </div>
                    <div class="fam-ctx tnum" title="${esc(ctxTip)}">
                      <span class="t-ctx">${fmtTok(fam.cpLimit)}</span><span class="c-faint"> / </span><span class="c-dim">${fam.maxTokens ? fmtTok(fam.maxTokens) : '--'}</span>
                    </div>
                    ${fiveCell}
                    ${weekCell}
                  </summary>
                  <div class="fam-expand">
                    <div class="tbl-wrap"><table class="tbl fam-member-tbl">
                      <thead><tr>
                        <th>${esc(bi('档位 / 规格', 'Tier / Variant'))}</th>
                        <th>${esc(bi('模型标识', 'Model ID'))}</th>
                        <th class="num">${esc(bi('压缩 / 原生 / 最大输出', 'Compact / Native / Max Out'))}</th>
                        <th class="num">${esc(bi('单模型读数', 'Model Reading'))}</th>
                      </tr></thead>
                      <tbody>${memberRowsHtml}</tbody>
                    </table></div>
                  </div>
                </details>`;
            }).join('')}
          </div>
        </div>`)
      .join('');

    el.innerHTML = `
      <section class="pool-stage">${poolCardsHtml}</section>

      <section class="card card-flush">
        <div class="spec-toolbar">
          <div class="row-flex gap-sm">
            <span class="card-title">${esc(bi('模型家族与配额', 'Model Families & Quotas'))}</span>
            <span class="card-sub tnum">${filtered.length} ${esc(bi('个家族', 'families'))} · ${filteredVariants} ${esc(bi('个规格', 'tiers'))}</span>
          </div>
          ${renderSegmented([
            ['all', `${bi('全部', 'All')} ${families.length}`],
            ['gemini', `Gemini ${geminiFams.length}`],
            ['premium', `Claude/GPT ${premiumFams.length}`],
          ], state.modelPoolFilter, 'data-pool-filter')}
        </div>
        ${groupsHtml
          ? `<div class="fam-grid fam-head">
              <span>${esc(bi('模型家族', 'Model Family'))}</span>
              <span class="r" title="${esc(bi('压缩窗口上限 / 原生上下文上限', 'Compaction limit / Native context limit'))}">${esc(bi('压缩 / 原生', 'Compact / Native'))}</span>
              <span>${esc(bi('5h 限额', '5-Hour'))}</span>
              <span>${esc(bi('周限', 'Weekly'))}</span>
            </div>${groupsHtml}`
          : `<div class="empty">${esc(bi('暂无匹配模型', 'No matching models'))}</div>`}
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

  function syncHostConversation() {
    const liveId = sidecar.conversationId || '';
    if (liveId && liveId !== state.hostConvId) {
      const wasFollowingHost = !state.convId || state.convId === state.hostConvId;
      state.hostConvId = liveId;
      if (wasFollowingHost) {
        state.convId = liveId;
        state.lastSessionSig = '';
        state.overviewVersion = '';
        const cachedOv = readCached(`ov:${liveId}`, 15 * 60 * 1000);
        if (cachedOv?.data) {
          state.overview = cachedOv.data;
          renderLiveBar();
          if (state.activeTab === 'session') renderCurrentTab();
        }
      }
    }
  }

  function isStale(kind, days = null) {
    const ttl = REVALIDATE_MS[kind] || 15_000;
    const at = kind === 'usage' ? (state.fetchedAt.usage[days] || 0) : (state.fetchedAt[kind] || 0);
    return !at || Date.now() - at > ttl;
  }

  function scheduleIdlePrefetch() {
    if (state.prefetched) return;
    state.prefetched = true;
    setTimeout(async () => {
      if (document.visibilityState === 'hidden') return;
      const stage1 = [];
      if (!state.models || isStale('models')) stage1.push(loadModels(false));
      if (!state.sessions || isStale('sessions')) stage1.push(loadSessions(false));
      if (!state.usageByDays[90] || isStale('usage', 90)) stage1.push(loadUsage(90, false));
      if (stage1.length) await Promise.allSettled(stage1);
      if (!state.usageByDays[31] || isStale('usage', 31)) await loadUsage(31, false);
    }, 60);
  }

  async function loadOverview(force = false) {
    syncHostConversation();
    if (state.loadingOverview) return;
    state.loadingOverview = true;
    const reqConvId = state.convId;
    const prevVersion = state.overviewVersion;
    try {
      const qs = new URLSearchParams();
      if (reqConvId) qs.set('conv', reqConvId);
      if (force) qs.set('force', '1');
      else if (prevVersion && state.overview) qs.set('v', prevVersion);
      const data = await apiGet(`/api/overview?${qs.toString()}`);
      if (reqConvId !== state.convId) return;
      if (data?.unchanged) {
        scheduleIdlePrefetch();
        return;
      }
      state.overview = data;
      state.overviewVersion = data.v || '';
      if (data.language) {
        state.lang = data.language;
        writeCached('lang', data.language);
      }
      const resolvedConv = data.session?.conversationId || reqConvId;
      if (resolvedConv && (!data.v || data.v !== prevVersion)) {
        writeCached(`ov:${resolvedConv}`, data);
      }

      const newEmail = data.userStatus?.email || '';
      const accountSwitched = Boolean(newEmail && state.lastAcctEmail && newEmail !== state.lastAcctEmail);
      if (newEmail) state.lastAcctEmail = newEmail;

      updateTabLabels();
      renderLiveBar();
      if (state.activeTab === 'session' || state.activeTab === 'settings') renderCurrentTab();
      if (accountSwitched) {
        state.fetchedAt.models = 0;
        state.fetchedAt.usage = {};
        if (state.activeTab === 'models') void loadModels(true);
        if (state.activeTab === 'cost') void loadUsage(state.usageDays, true);
        if (state.activeTab === 'calendar') void loadUsage(90, true);
      }
      scheduleIdlePrefetch();
    } catch (err) {
      if (!state.overview) {
        const ctxEl = document.getElementById('liveContext');
        if (ctxEl) {
          ctxEl.title = err.message || 'Connection error';
          ctxEl.innerHTML = `<span class="dot sm red"></span><span class="c-red">${esc(bi('连接异常', 'Error'))}</span>`;
        }
      }
    } finally {
      state.loadingOverview = false;
    }
  }

  function fetchCachedResource({ key, url, force, errKey, hasData, onData, shouldRender }) {
    if (!force && state.inflight[key]) return state.inflight[key];
    const p = (async () => {
      try {
        state.tabError[errKey] = '';
        const data = await apiGet(url);
        onData(data);
        writeCached(key, data);
      } catch (err) {
        if (!hasData()) state.tabError[errKey] = err.message || 'Network error';
      } finally {
        delete state.inflight[key];
      }
      if (shouldRender()) renderCurrentTab();
    })();
    state.inflight[key] = p;
    return p;
  }

  function loadSessions(force = false) {
    return fetchCachedResource({
      key: 'sessions',
      url: `/api/sessions${force ? '?force=1' : ''}`,
      force,
      errKey: 'sessions',
      hasData: () => Boolean(state.sessions),
      onData: (data) => { state.sessions = data; state.fetchedAt.sessions = Date.now(); },
      shouldRender: () => state.activeTab === 'sessions',
    });
  }

  function loadUsage(daysOverride = null, force = false) {
    const days = daysOverride ?? (state.activeTab === 'calendar' ? 90 : state.usageDays);
    return fetchCachedResource({
      key: `usage:${days}`,
      url: `/api/usage?days=${days}${force ? '&force=1' : ''}`,
      force,
      errKey: 'usage',
      hasData: () => Boolean(state.usageByDays[days]),
      onData: (data) => { state.usageByDays[days] = data; state.fetchedAt.usage[days] = Date.now(); },
      shouldRender: () => (state.activeTab === 'cost' && days === state.usageDays) || (state.activeTab === 'calendar' && days === 90),
    });
  }

  function loadModels(force = false) {
    return fetchCachedResource({
      key: 'models',
      url: `/api/models${force ? '?force=1' : ''}`,
      force,
      errKey: 'models',
      hasData: () => Boolean(state.models),
      onData: (data) => { state.models = data; state.fetchedAt.models = Date.now(); },
      shouldRender: () => state.activeTab === 'models',
    });
  }

  async function refreshAfterPricingChange() {
    clearCachedKeys('sessions');
    clearCachedKeys('usage:');
    state.fetchedAt.sessions = 0;
    state.fetchedAt.usage = {};
    state.lastSessionSig = '';
    state.overviewVersion = '';
    await Promise.all([loadUsage(state.usageDays, true), loadOverview(true)]);
    if (state.usageDays !== 90) void loadUsage(90, true);
    void loadSessions(true);
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
      if (state.inspectorTab !== inspTab) {
        state.inspectorTab = inspTab;
        rerenderInspectorSection();
      }
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
      rerenderInspectorSection();
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
      state.overviewVersion = '';
      state.activeTab = 'session';
      updateTabLabels();
      renderCurrentTab();
      loadOverview(true);
      return;
    }

    const daysAttr = btn.getAttribute('data-days');
    if (daysAttr) {
      const nextDays = Number(daysAttr) || 31;
      state.usageDays = nextDays;
      if (state.usageByDays[nextDays]) {
        renderCurrentTab();
        if (isStale('usage', nextDays)) void loadUsage(nextDays, false);
      } else {
        mainEl.querySelectorAll('[data-days]').forEach((b) => {
          b.classList.toggle('active', Number(b.getAttribute('data-days')) === nextDays);
        });
        void loadUsage(nextDays, false);
      }
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
      rerenderInspectorSection();
      return;
    }

    const turnFilter = btn.getAttribute('data-turn-filter');
    if (turnFilter) {
      state.turnFilter = turnFilter;
      state.turnLimit = 10;
      rerenderInspectorSection();
      return;
    }

    const traceMode = btn.getAttribute('data-trace-mode');
    if (traceMode) {
      if (state.traceTimelineMode !== traceMode) {
        state.traceTimelineMode = traceMode;
        mainEl.querySelectorAll('[data-trace-mode]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-trace-mode') === traceMode);
        });
        rerenderTraceBody();
      }
      return;
    }

    const traceJump = btn.getAttribute('data-trace-jump');
    if (traceJump) {
      const s = state.overview?.session;
      const [tNum] = traceJump.split(':');
      state.selectedTraceStep = traceJump;
      if (s?.conversationId) {
        recordFoldState(`turn:${s.conversationId}:${tNum}`, true);
        recordFoldState(`step:${s.conversationId}:${traceJump}`, true);
      }
      const turnEl = mainEl.querySelector(`details.tl-turn[data-turn-num="${CSS.escape(tNum)}"]`);
      if (turnEl) {
        mainEl.querySelectorAll('.tr-span.is-selected').forEach((el) => el.classList.remove('is-selected'));
        mainEl.querySelectorAll(`.tr-span[data-trace-jump="${CSS.escape(traceJump)}"]`).forEach((el) => el.classList.add('is-selected'));
        mainEl.querySelectorAll('details.wf-step.is-selected').forEach((el) => el.classList.remove('is-selected'));
        if (!turnEl.open) turnEl.open = true;
        hydrateLazyTurn(turnEl);
        const stepEl = turnEl.querySelector(`details.wf-step[data-step-key="${CSS.escape(traceJump)}"]`);
        if (stepEl) {
          stepEl.classList.add('is-selected');
          if (!stepEl.open) stepEl.open = true;
          hydrateLazyStep(stepEl);
          stepEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        syncTraceToggleButton(s);
        if (s) state.lastSessionSig = computeSessionSig(s);
      } else {
        rerenderTraceBody();
        requestAnimationFrame(() => {
          const target = mainEl.querySelector(`details.wf-step[data-step-key="${CSS.escape(traceJump)}"]`);
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
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
      writeCached('lang', setLang);
      state.lastSessionSig = '';
      state.overviewVersion = '';
      updateTabLabels();
      renderLiveBar();
      renderCurrentTab();
      return;
    }

    const remAcct = btn.getAttribute('data-remove-acct');
    if (remAcct) {
      await apiPost('/api/prefs', { removeAccount: remAcct });
      state.overviewVersion = '';
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
      state.overviewVersion = '';
      loadOverview(true);
    } else if (action === 'more-turns') {
      state.turnLimit += 10;
      rerenderTraceBody();
    } else if (action === 'reset-turns') {
      state.turnLimit = 10;
      rerenderTraceBody();
    } else if (action === 'toggle-all-turns') {
      const s = state.overview?.session;
      if (!s) return;
      const { visibleTurns } = getVisibleTraceTurns(s);
      const anyOpen = visibleTurns.some((tr) => isFoldOpen(`turn:${s.conversationId}:${tr.turn}`));
      for (const tr of visibleTurns) {
        recordFoldState(`turn:${s.conversationId}:${tr.turn}`, !anyOpen);
      }
      rerenderTraceBody();
    } else if (action === 'toggle-subs') {
      state.showAllSubagents = !state.showAllSubagents;
      rerenderInspectorSection();
    } else if (action === 'toggle-sides') {
      state.showAllSideQuestions = !state.showAllSideQuestions;
      rerenderInspectorSection();
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
      await refreshAfterPricingChange();
    } else if (action === 'reset-pricing') {
      await apiPost('/api/pricing', { reset: true });
      const msg = document.getElementById('prcMsg');
      if (msg) msg.textContent = bi('已恢复官方默认价', 'Reset to defaults');
      await refreshAfterPricingChange();
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

  // Single capture-phase toggle listener handles fold persistence & lazy turn/step hydration across all tabs
  mainEl.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    const key = d.getAttribute('data-fold-key');
    if (key) recordFoldState(key, d.open);
    if (d.open) {
      if (d.classList.contains('tl-turn')) hydrateLazyTurn(d);
      else if (d.classList.contains('wf-step')) hydrateLazyStep(d);
    }
    if (d.classList.contains('tl-turn')) syncTraceToggleButton(state.overview?.session);
  }, true);

  // Delegated 3-lane trace timeline hover tooltip (zero per-render listener rebinding)
  mainEl.addEventListener('mouseover', (e) => {
    const sp = e.target.closest?.('.tr-span');
    if (!sp) return;
    const plot = sp.closest('#tracePlot');
    const tip = plot?.querySelector('#traceTip');
    if (!plot || !tip) return;
    tip.innerHTML = `<div class="chart-tip-title">${esc(sp.dataset.tipTitle || '')}</div>${sp.dataset.tipSub ? `<div class="chart-tip-sub">${esc(sp.dataset.tipSub)}</div>` : ''}`;
    tip.classList.remove('hidden');
    const pRect = plot.getBoundingClientRect();
    const sRect = sp.getBoundingClientRect();
    const cx = sRect.left - pRect.left + sRect.width / 2;
    const tipW = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(4, Math.min(pRect.width - tipW - 4, cx - tipW / 2))}px`;
    tip.style.top = '64px';
  });
  mainEl.addEventListener('mouseout', (e) => {
    const plot = e.target.closest?.('#tracePlot');
    if (!plot) return;
    if (e.relatedTarget && plot.contains(e.relatedTarget)) return;
    plot.querySelector('#traceTip')?.classList.add('hidden');
  });

  // Delegated debounced + IME-safe live search for Trace tab
  let traceSearchTimer = null;
  let traceComposing = false;
  const commitTraceSearch = (val) => {
    if (traceSearchTimer) { clearTimeout(traceSearchTimer); traceSearchTimer = null; }
    state.traceSearch = val;
    rerenderTraceBody();
  };
  mainEl.addEventListener('compositionstart', (e) => {
    if (e.target?.id === 'traceSearchInput') traceComposing = true;
  });
  mainEl.addEventListener('compositionend', (e) => {
    if (e.target?.id === 'traceSearchInput') {
      traceComposing = false;
      commitTraceSearch(e.target.value);
    }
  });
  mainEl.addEventListener('input', (e) => {
    if (e.target?.id !== 'traceSearchInput') return;
    const val = e.target.value;
    state.traceSearch = val;
    if (traceComposing) return;
    if (traceSearchTimer) clearTimeout(traceSearchTimer);
    traceSearchTimer = setTimeout(() => commitTraceSearch(val), 60);
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
    if (state.activeTab === 'sessions' && (!state.sessions || isStale('sessions'))) void loadSessions(false);
    if (state.activeTab === 'cost' && (!state.usageByDays[state.usageDays] || isStale('usage', state.usageDays))) void loadUsage(state.usageDays, false);
    if (state.activeTab === 'calendar' && (!state.usageByDays[90] || isStale('usage', 90))) void loadUsage(90, false);
    if (state.activeTab === 'models' && (!state.models || isStale('models'))) void loadModels(false);
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
      state.overviewVersion = '';
      const tasks = [loadOverview(true)];
      if (state.activeTab === 'sessions') tasks.push(loadSessions(true));
      if (state.activeTab === 'cost') {
        state.fetchedAt.usage = {};
        tasks.push(loadUsage(state.usageDays, true));
      }
      if (state.activeTab === 'calendar') {
        state.fetchedAt.usage = {};
        tasks.push(loadUsage(90, true));
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

  hydrateFromStorage();
  updateTabLabels();
  if (state.overview) {
    renderLiveBar();
    renderCurrentTab();
  }
  loadOverview(false);
  schedulePoll();
})();
