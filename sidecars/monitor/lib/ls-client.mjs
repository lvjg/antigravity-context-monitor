/**
 * Upgrade-resilient, layered Antigravity Language Server client.
 *
 * Layer 1 (Official Stable Contract):
 *   - ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN env vars
 *   - GET /healthz liveness check
 *   - product.v1.ConversationService (ListConversations, GetConversation)
 *
 * Layer 2 (Optional Enhancement, independently fault-isolated):
 *   - LanguageServerService/GetUserStatus (live account, credits, model quotas)
 *   - LanguageServerService/GetAvailableModels (live checkpointer cpLimit overrides)
 *   - LanguageServerService/GetCascadeTrajectoryGeneratorMetadata (TTFT, streaming & exact token breakdown)
 *
 * Sends BOTH x-antigravity-csrf-token and x-codeium-csrf-token for forward/backward compatibility.
 * Never performs background polling; uses short TTL in-memory caching for on-demand requests.
 */
import http from 'node:http';
import https from 'node:https';
import { resolveQuotaPool } from './pricing.mjs';

const CONV_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;
const MAX_BACKFILL_CACHE = 2000;
const LS_METADATA = Object.freeze({ metadata: { ideName: 'antigravity', extensionName: 'antigravity' } });
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000, rejectUnauthorized: false });

function parseValidResetMs(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function formatQuotaPercent(frac) {
  if (frac === null || !Number.isFinite(frac)) return null;
  if (frac <= 0) return 0;
  if (frac >= 1) return 100;
  const pct = frac * 100;
  if (pct < 1) return Math.max(0.1, Math.floor(pct * 10) / 10);
  if (pct > 99) return Math.floor(pct * 10) / 10;
  return Math.round(pct);
}

/**
 * Resolve remaining quota fraction from a proto3 quota object.
 * Proto3 omits float 0.0: omitted fraction + valid non-epoch resetTime => 0.0 (exhausted);
 * omitted fraction + missing/epoch-0 resetTime => 1.0 (untouched).
 */
function resolveQuotaFraction(obj, resetMs) {
  if (obj?.remainingFraction != null) {
    const n = Number(obj.remainingFraction);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  }
  if (obj?.resetTime == null || (typeof obj.resetTime === 'string' && !obj.resetTime.trim())) return 1;
  if (resetMs === null || resetMs < 0) return null;
  return resetMs === 0 ? 1 : 0;
}

function inferSummaryPool(displayName, buckets) {
  const ids = buckets.map((b) => String(b.bucketId || '').toLowerCase());
  if (ids.some((id) => id.startsWith('gemini')) || /\bgemini\b/i.test(displayName)) return 'gemini';
  if (ids.some((id) => id.startsWith('3p') || id.startsWith('claude') || id.startsWith('gpt'))
    || /\b(?:claude|gpt)\b/i.test(displayName)) return 'premium';
  return '';
}

function parseUserQuotaSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw.response && typeof raw.response === 'object' ? raw.response : raw;
  const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
  const byPool = {};

  for (const rec of rawGroups) {
    if (!rec || typeof rec !== 'object') continue;
    const displayName = String(rec.displayName || '').trim();
    const rawBuckets = Array.isArray(rec.buckets) ? rec.buckets : [];
    const buckets = [];
    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object') continue;
      const bucketId = String(b.bucketId || '').trim();
      const rawWin = String(b.window || '').trim().toLowerCase();
      const win = rawWin
        || (bucketId.toLowerCase().endsWith('-weekly') ? 'weekly'
          : bucketId.toLowerCase().endsWith('-5h') ? '5h' : '');
      if (!bucketId && !win) continue;
      const resetMs = parseValidResetMs(b.resetTime);
      const resetTime = resetMs && resetMs > 0 ? String(b.resetTime).trim() : '';
      const frac = resolveQuotaFraction(b, resetMs);
      buckets.push({
        bucketId,
        window: win,
        remainingFraction: frac,
        remainingPercent: formatQuotaPercent(frac),
        resetTime,
        _explicit: b.remainingFraction != null,
      });
    }
    const pool = inferSummaryPool(displayName, buckets);
    if (!pool) continue;
    const fiveHour = buckets.find((b) => b.window === '5h') || null;
    const weekly = buckets.find((b) => b.window === 'weekly') || null;
    const existing = (byPool[pool] ||= { fiveHour: null, weekly: null });
    if (fiveHour && !existing.fiveHour) existing.fiveHour = fiveHour;
    if (weekly && !existing.weekly) existing.weekly = weekly;
  }

  return Object.keys(byPool).length > 0 ? byPool : null;
}

function stripWindowMeta(w) {
  if (!w) return null;
  return {
    window: w.window,
    remainingFraction: w.remainingFraction,
    remainingPercent: w.remainingPercent,
    resetTime: w.resetTime || '',
  };
}

function parseLsAddress() {
  const raw = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const token = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!raw || !token) return null;
  const cleaned = raw.replace(/^https?:\/\//i, '');
  const idx = cleaned.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = cleaned.slice(0, idx) || '127.0.0.1';
  const port = parseInt(cleaned.slice(idx + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: host === 'localhost' ? '127.0.0.1' : host, port, token };
}

function parseProtoDurationSec(val) {
  if (!val) return 0;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : 0;
  if (typeof val === 'string') {
    const m = val.match(/^([0-9]+(?:\.[0-9]+)?)s$/);
    return m ? parseFloat(m[1]) : 0;
  }
  if (typeof val === 'object') {
    const total = (Number(val.seconds) || 0) + (Number(val.nanos) || 0) / 1e9;
    return Number.isFinite(total) && total > 0 ? total : 0;
  }
  return 0;
}

function pickBestGmModel(cm, usage) {
  const resp = String(cm?.responseModel || usage?.model || '').trim();
  const direct = String(cm?.model || '').trim();
  const respLow = resp.toLowerCase();
  // Prefer concrete worker / specific tiered response slug when available
  if (
    resp &&
    respLow !== 'unknown' &&
    (/(?:-(?:xhigh|high|medium|low|thinking|worker-agy|orchestrator))/.test(respLow) ||
      respLow.startsWith('claude-') ||
      respLow.startsWith('gpt-'))
  ) {
    return resp;
  }
  if (direct && direct !== 'MODEL_UNSPECIFIED' && direct.toLowerCase() !== 'unknown') return direct;
  return resp && respLow !== 'unknown' ? resp : '';
}

function emptyTimingAgg() {
  return {
    ttftCalls: 0,
    ttftSumSec: 0,
    lastTtftSec: null,
    minTtftSec: null,
    maxTtftSec: null,
    streamCalls: 0,
    streamSumSec: 0,
    streamOutputTokens: 0,
  };
}

function recordTimingSample(agg, ttftSec, streamSec, outTok) {
  if (ttftSec > 0 && ttftSec <= 300) {
    const r = +ttftSec.toFixed(2);
    agg.ttftCalls++;
    agg.ttftSumSec += ttftSec;
    agg.lastTtftSec = r;
    agg.minTtftSec = agg.minTtftSec === null ? r : Math.min(agg.minTtftSec, r);
    agg.maxTtftSec = agg.maxTtftSec === null ? r : Math.max(agg.maxTtftSec, r);
  }
  if (streamSec > 0 && streamSec <= 600 && outTok > 0) {
    agg.streamCalls++;
    agg.streamSumSec += streamSec;
    agg.streamOutputTokens += outTok;
  }
}

function extractContextSnapshot(cm) {
  const cwm = cm?.chatStartMetadata?.contextWindowMetadata || {};
  const rawGroups = Array.isArray(cwm?.tokenBreakdown?.groups) ? cwm.tokenBreakdown.groups : [];
  if (rawGroups.length === 0 && !cm?.systemPrompt && !Array.isArray(cm?.tools) && !Array.isArray(cm?.promptSections)) {
    return null;
  }
  const groups = rawGroups
    .map((g) => ({
      name: String(g?.name || g?.type || 'Other').trim(),
      type: String(g?.type || '').trim(),
      tokens: Number(g?.numTokens) || 0,
      children: Array.isArray(g?.children)
        ? g.children
            .map((c) => ({ name: String(c?.name || '').trim(), tokens: Number(c?.numTokens) || 0 }))
            .filter((c) => c.name && c.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 20)
        : [],
    }))
    .filter((g) => g.tokens > 0);

  const toolsArr = Array.isArray(cm.tools) ? cm.tools : [];
  let toolSchemaChars = 0;
  for (const t of toolsArr) {
    try { toolSchemaChars += JSON.stringify(t).length; } catch { /* ignore */ }
  }
  const promptSections = Array.isArray(cm.promptSections)
    ? cm.promptSections
        .map((ps) => ({ title: String(ps?.title || '').trim(), chars: String(ps?.content || ps?.text || '').length }))
        .filter((ps) => ps.title)
        .slice(0, 24)
    : [];

  return {
    estimatedTokensUsed: Number(cwm.estimatedTokensUsed) || 0,
    groups,
    systemPromptChars: typeof cm.systemPrompt === 'string' ? cm.systemPrompt.length : 0,
    toolCount: toolsArr.length,
    toolSchemaChars,
    promptSections,
  };
}

function httpJsonRequest({ host, port, useTls, method, reqPath, headers = {}, body = '', timeoutMs = 4000, maxBytes = 10 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const transport = useTls ? https : http;
    const agent = useTls ? HTTPS_AGENT : HTTP_AGENT;
    const req = transport.request(
      { hostname: host, port, path: reqPath, method, headers, timeout: timeoutMs, agent, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        let bytes = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          if (aborted) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            aborted = true;
            req.destroy();
            reject(new Error('LS response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          const data = chunks.length === 1 ? chunks[0].toString('utf8') : Buffer.concat(chunks, bytes).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${reqPath}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout calling ${reqPath}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

export class LSClient {
  constructor() {
    this._useTls = null; // auto-detected once via /healthz
    this._rpcCache = new Map(); // slot -> { at, value, inflight }
    this._convMetaCache = new Map(); // convId -> { at, value, inflight } (bounded LRU max 32)
    this._convListCache = { at: 0, value: null, error: null };
    // Bounded LRU cache for Layer-2 trajectory model/timing/context metadata
    this._gmBackfillCache = new Map();
    this._gmInflight = new Map();
  }

  _cachedRpc(slot, ttlMs, force, loader) {
    const entry = this._rpcCache.get(slot);
    if (!force && entry?.at > 0 && Date.now() - entry.at < ttlMs) return Promise.resolve(entry.value);
    if (!force && entry?.inflight) return entry.inflight;
    const inflight = loader()
      .then((value) => {
        this._rpcCache.set(slot, { at: Date.now(), value, inflight: null });
        return value;
      })
      .finally(() => {
        const cur = this._rpcCache.get(slot);
        if (cur?.inflight === inflight) cur.inflight = null;
      });
    this._rpcCache.set(slot, { at: entry?.at || 0, value: entry?.value ?? null, inflight });
    return inflight;
  }

  _conn() {
    return parseLsAddress();
  }

  _putBackfillCache(convId, record) {
    this._gmBackfillCache.delete(convId);
    this._gmBackfillCache.set(convId, record);
    while (this._gmBackfillCache.size > MAX_BACKFILL_CACHE) {
      this._gmBackfillCache.delete(this._gmBackfillCache.keys().next().value);
    }
  }

  async _detectProtocol(conn) {
    if (this._useTls !== null) return this._useTls;
    for (const useTls of [false, true]) {
      try {
        await httpJsonRequest({ ...conn, useTls, method: 'GET', reqPath: '/healthz', timeoutMs: 1500 });
        this._useTls = useTls;
        return useTls;
      } catch { /* try next */ }
    }
    return false;
  }

  async callRpc(service, method, payload = {}, timeoutMs = 5000, maxBytes = 10 * 1024 * 1024) {
    const conn = this._conn();
    if (!conn) throw new Error('ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN not set');
    const useTls = await this._detectProtocol(conn);
    const body = JSON.stringify(payload);
    return httpJsonRequest({
      ...conn,
      useTls,
      method: 'POST',
      reqPath: `/${service}/${method}`,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': conn.token,
        'x-codeium-csrf-token': conn.token,
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs,
      maxBytes,
    });
  }

  checkHealth({ force = false } = {}) {
    const entry = this._rpcCache.get('health');
    const ttl = entry?.value?.ok ? 10_000 : 2_000;
    return this._cachedRpc('health', ttl, force, async () => {
      const conn = this._conn();
      if (!conn) return { ok: false, reason: 'missing_env' };
      try {
        const useTls = await this._detectProtocol(conn);
        const res = await httpJsonRequest({ ...conn, useTls, method: 'GET', reqPath: '/healthz', timeoutMs: 1500 });
        return { ok: true, address: `${conn.host}:${conn.port}`, tls: useTls, instanceId: res.instanceId || '' };
      } catch (err) {
        this._useTls = null;
        return { ok: false, reason: err.message };
      }
    });
  }

  /** Layer 1 (Official Public API): Get single conversation metadata (short TTL + inflight dedup). */
  getConversation(conversationId, { force = false, ttlMs = 3500 } = {}) {
    if (!conversationId) return Promise.resolve(null);
    const entry = this._convMetaCache.get(conversationId);
    if (!force && entry?.at > 0 && Date.now() - entry.at < ttlMs) return Promise.resolve(entry.value);
    if (!force && entry?.inflight) return entry.inflight;
    const inflight = this.callRpc('product.v1.ConversationService', 'GetConversation', { conversationId }, 3000)
      .catch(() => null)
      .then((value) => {
        this._convMetaCache.delete(conversationId);
        this._convMetaCache.set(conversationId, { at: Date.now(), value, inflight: null });
        if (this._convMetaCache.size > 32) this._convMetaCache.delete(this._convMetaCache.keys().next().value);
        return value;
      })
      .finally(() => {
        const cur = this._convMetaCache.get(conversationId);
        if (cur?.inflight === inflight) cur.inflight = null;
      });
    this._convMetaCache.set(conversationId, { at: entry?.at || 0, value: entry?.value ?? null, inflight });
    return inflight;
  }

  /** Layer 1 (Official Public API): List top-level conversations (cached 4s). */
  async listConversations({ pageSize = 80, includeArchived = false, force = false } = {}) {
    const now = Date.now();
    if (!force && !includeArchived && this._convListCache.value && now - this._convListCache.at < 4000) {
      return this._convListCache.value;
    }
    try {
      const res = await this.callRpc('product.v1.ConversationService', 'ListConversations', { pageSize, includeArchived }, 5000);
      const list = Array.isArray(res?.conversations) ? res.conversations : [];
      if (!includeArchived) this._convListCache = { at: now, value: list, error: null };
      return list;
    } catch (err) {
      this._convListCache = { at: now, value: null, error: err.message };
      return null;
    }
  }

  /** Layer 1 (Official Public API): List direct child subagent conversations of a parent. */
  async listChildConversations(parentConversationId) {
    if (!parentConversationId) return [];
    try {
      const res = await this.callRpc(
        'product.v1.ConversationService',
        'ListConversations',
        { parentConversationId, pageSize: 100, includeArchived: true },
        4000,
      );
      return Array.isArray(res?.conversations) ? res.conversations : [];
    } catch {
      return [];
    }
  }

  /** Layer 2 (Optional Enhancement): Fetch dual-window (5h + weekly) quota summary. */
  getUserQuotaSummary({ force = false } = {}) {
    return this._cachedRpc('quotaSummary', 15_000, force, async () => {
      try {
        const res = await this.callRpc('exa.language_server_pb.LanguageServerService', 'RetrieveUserQuotaSummary', LS_METADATA, 4000);
        return parseUserQuotaSummary(res);
      } catch {
        return null;
      }
    });
  }

  /** Layer 2 (Optional Enhancement): Fetch live account, credits, and model quotas (incl. 5h + weekly). */
  getUserStatus({ force = false } = {}) {
    return this._cachedRpc('userStatus', 10_000, force, async () => {
      try {
        const [res, summaryByPool] = await Promise.all([
          this.callRpc('exa.language_server_pb.LanguageServerService', 'GetUserStatus', LS_METADATA, 5000),
          this.getUserQuotaSummary({ force }),
        ]);
        const us = res?.userStatus;
        if (!us) throw new Error('Empty userStatus payload');

        const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
        const labelsByModel = {};
        const poolMap = new Map();
        const models = configs.map((c) => {
          const modelId = c.modelOrAlias?.model || '';
          const label = c.label || modelId;
          if (modelId && label) labelsByModel[modelId] = label;
          const qInfo = c.quotaInfo || {};
          const resetMs = parseValidResetMs(qInfo.resetTime);
          const resetTime = resetMs && resetMs > 0 ? String(qInfo.resetTime).trim() : '';
          const frac = resolveQuotaFraction(qInfo, resetMs);
          const remainingPercent = formatQuotaPercent(frac);
          const pool = resolveQuotaPool(modelId, label);

          const pEntry = poolMap.get(pool);
          if (!pEntry) {
            poolMap.set(pool, { poolKey: pool, label, modelCount: 1, remainingPercent, resetTime });
          } else {
            pEntry.modelCount++;
            if (remainingPercent !== null && (pEntry.remainingPercent === null || remainingPercent < pEntry.remainingPercent)) {
              pEntry.remainingPercent = remainingPercent;
            }
            if (resetTime && (!pEntry.resetTime || resetTime < pEntry.resetTime)) {
              pEntry.resetTime = resetTime;
            }
          }
          return {
            modelId,
            label,
            tagTitle: c.tagTitle || '',
            tagDescription: c.tagDescription || '',
            pool,
            remainingFraction: frac,
            remainingPercent,
            resetTime,
          };
        });

        const nowMs = Date.now();
        const resetPools = [...poolMap.values()]
          .map((pool) => {
            const dual = summaryByPool?.[pool.poolKey] || null;
            let fiveHour = dual?.fiveHour ? { ...dual.fiveHour } : null;
            let weekly = dual?.weekly ? { ...dual.weekly } : null;

            // Reconcile when RetrieveUserQuotaSummary omits both fraction & resetTime on an
            // exhausted bucket while GetUserStatus explicitly reports 0% with a future resetTime.
            if (pool.remainingPercent === 0 && pool.resetTime) {
              const rMs = parseValidResetMs(pool.resetTime);
              const remMs = rMs && rMs > nowMs ? rMs - nowMs : 0;
              if (remMs <= 5.5 * 3600_000 && fiveHour && !fiveHour._explicit && !fiveHour.resetTime) {
                fiveHour = { ...fiveHour, remainingFraction: 0, remainingPercent: 0, resetTime: pool.resetTime };
              } else if (remMs > 5.5 * 3600_000 && weekly && !weekly._explicit && !weekly.resetTime) {
                weekly = { ...weekly, remainingFraction: 0, remainingPercent: 0, resetTime: pool.resetTime };
              }
            }

            // Fallback inference from single resetTime when RetrieveUserQuotaSummary is unavailable
            if (!fiveHour && !weekly && pool.remainingPercent !== null) {
              const rMs = parseValidResetMs(pool.resetTime);
              const remMs = rMs && rMs > nowMs ? rMs - nowMs : 0;
              const winObj = {
                window: remMs > 5.5 * 3600_000 ? 'weekly' : '5h',
                remainingFraction: pool.remainingPercent / 100,
                remainingPercent: pool.remainingPercent,
                resetTime: pool.resetTime,
              };
              if (winObj.window === 'weekly') weekly = winObj;
              else fiveHour = winObj;
            }

            const clean5h = stripWindowMeta(fiveHour);
            const cleanWk = stripWindowMeta(weekly);
            const limiting =
              clean5h && cleanWk
                ? ((cleanWk.remainingPercent ?? 100) < (clean5h.remainingPercent ?? 100) ? cleanWk : clean5h)
                : (clean5h || cleanWk);
            return {
              ...pool,
              remainingPercent: limiting?.remainingPercent ?? pool.remainingPercent ?? 100,
              resetTime: limiting ? limiting.resetTime : (pool.resetTime || ''),
              fiveHour: clean5h,
              weekly: cleanWk,
            };
          })
          .sort((a, b) => (a.poolKey === 'gemini' ? -1 : 1) - (b.poolKey === 'gemini' ? -1 : 1));

        const planInfo = us.planStatus?.planInfo || {};
        const creditsList = us.planStatus?.availableCredits || us.availableCredits || [];
        const credits = creditsList.reduce((s, c) => s + (Number(c.creditAmount) > 0 ? Number(c.creditAmount) : 0), 0);

        return {
          available: true,
          email: us.email || '',
          name: us.name || us.email || '',
          planName: planInfo.planName || '',
          tierName: us.userTier?.name || planInfo.teamsTier || '',
          credits,
          models,
          labelsByModel,
          resetPools,
        };
      } catch (err) {
        return { available: false, error: err.message, models: [], labelsByModel: {}, resetPools: [] };
      }
    });
  }

  /** Layer 2 (Optional Enhancement): Fetch live model specs (cpLimit, maxTokens, thinkingLevel). Cached 5m. */
  getModelCatalog({ force = false } = {}) {
    return this._cachedRpc('modelCatalog', 300_000, force, async () => {
      try {
        const res = await this.callRpc('exa.language_server_pb.LanguageServerService', 'GetAvailableModels', {}, 6000);
        const rawModels = res?.response?.models || {};
        const specsById = {};
        const limitsByAny = {};
        for (const [slug, m] of Object.entries(rawModels)) {
          if (m.isInternal) continue;
          let cpLimit = 0;
          let cpThreshold = 0;
          const cpStr = m.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
          if (cpStr) {
            try {
              const cp = JSON.parse(cpStr);
              cpLimit = Number(cp.max_token_limit) || 0;
              cpThreshold = Number(cp.token_threshold) || 0;
            } catch { /* ignore */ }
          }
          const spec = {
            slug,
            modelId: m.model || slug,
            displayName: m.displayName || slug,
            apiProvider: String(m.apiProvider || '').replace(/^API_PROVIDER_/, ''),
            maxTokens: Number(m.maxTokens) || 0,
            maxOutputTokens: Number(m.maxOutputTokens) || 0,
            supportsThinking: Boolean(m.supportsThinking),
            supportsAdaptiveThinking: Boolean(m.supportsAdaptiveThinking),
            thinkingLevel: Number(m.thinkingLevel) || 0,
            thinkingBudget: Number(m.thinkingBudget) || 0,
            cpLimit,
            cpThreshold,
          };
          if (m.model) specsById[m.model] = spec;
          if (cpLimit > 0) {
            if (m.model) limitsByAny[m.model] = cpLimit;
            limitsByAny[slug] = cpLimit;
            if (m.displayName) limitsByAny[m.displayName] = cpLimit;
          }
        }
        return { available: true, specsById, limitsByAny };
      } catch (err) {
        return { available: false, error: err.message, specsById: {}, limitsByAny: {} };
      }
    });
  }

  /** Peek cached trajectory model/timing backfill without triggering an RPC. */
  peekTrajectoryBackfill(convId) {
    const c = this._gmBackfillCache.get(convId);
    return !c || c.failed ? null : c;
  }

  /**
   * Layer 2 (Optional Enhancement): Fetch exact TTFT, streaming durations, token breakdown,
   * and missing pre-2026-11-18 model IDs via GetCascadeTrajectoryGeneratorMetadata.
   * Immediately discards the raw payload and caches ONLY a tiny step + per-model timing summary.
   */
  async getTrajectoryBackfill(convId, { timeoutMs = 12000, isRunning = false } = {}) {
    if (!convId || !CONV_ID_RE.test(convId)) return null;
    const now = Date.now();
    const cached = this._gmBackfillCache.get(convId);
    if (cached) {
      const ttl = cached.failed ? 120_000 : (isRunning ? 12_000 : 1_800_000);
      if (now - cached.at < ttl) return cached.failed ? null : cached;
    }
    if (this._gmInflight.has(convId)) return this._gmInflight.get(convId);

    const p = (async () => {
      try {
        const res = await this.callRpc(
          'exa.language_server_pb.LanguageServerService',
          'GetCascadeTrajectoryGeneratorMetadata',
          { cascadeId: convId },
          timeoutMs,
          128 * 1024 * 1024,
        );
        const list = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
        const byStep = Object.create(null);
        const timingByModel = Object.create(null);
        const overallTiming = emptyTimingAgg();
        let fallbackModel = '';
        let entryCount = 0;
        let lastContextCm = null;

        for (const gm of list) {
          const cm = gm?.chatModel || {};
          const usage = cm.usage || {};
          const model = pickBestGmModel(cm, usage);
          if (!model) continue;
          fallbackModel = model;
          entryCount++;

          if (
            cm.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups?.length ||
            cm.systemPrompt ||
            (Array.isArray(cm.tools) && cm.tools.length > 0) ||
            (Array.isArray(cm.promptSections) && cm.promptSections.length > 0)
          ) {
            lastContextCm = cm;
          }

          const ttftSec = parseProtoDurationSec(cm.timeToFirstToken);
          const streamSec = parseProtoDurationSec(cm.streamingDuration);
          const outTok = Number(usage.outputTokens) || 0;
          const cacheCreationTokens = Number(usage.cacheCreationTokens || usage.cacheCreationInputTokens) || 0;
          const info = { model, ttftSec, streamSec, cacheCreationTokens };

          if (!timingByModel[model]) timingByModel[model] = emptyTimingAgg();
          recordTimingSample(timingByModel[model], ttftSec, streamSec, outTok);
          recordTimingSample(overallTiming, ttftSec, streamSec, outTok);

          for (const rawIdx of Array.isArray(gm.stepIndices) ? gm.stepIndices : []) {
            const n = Number(rawIdx);
            if (Number.isFinite(n) && n >= 0) byStep[n] = info;
          }
          const startIdx = Number(cm.chatStartMetadata?.startStepIndex);
          if (Number.isFinite(startIdx) && startIdx >= 0 && !byStep[startIdx]) {
            byStep[startIdx] = info;
          }
        }

        const latestContext = lastContextCm ? extractContextSnapshot(lastContextCm) : null;

        const record = {
          at: Date.now(),
          failed: false,
          byStep,
          timingByModel,
          overallTiming,
          latestContext,
          fallbackModel,
          entryCount,
        };
        this._putBackfillCache(convId, record);
        return record;
      } catch {
        this._putBackfillCache(convId, {
          at: Date.now(),
          failed: true,
          byStep: Object.create(null),
          timingByModel: Object.create(null),
          overallTiming: null,
          latestContext: null,
          fallbackModel: '',
          entryCount: 0,
        });
        return null;
      } finally {
        this._gmInflight.delete(convId);
      }
    })();

    this._gmInflight.set(convId, p);
    return p;
  }
}
