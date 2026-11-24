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
const MAX_BACKFILL_CACHE = 400;

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
    const req = transport.request(
      { hostname: host, port, path: reqPath, method, headers, timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        let data = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy();
            reject(new Error('LS response too large'));
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
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
    this._userStatusCache = { at: 0, value: null, error: null };
    this._modelSpecsCache = { at: 0, value: null, error: null };
    this._convListCache = { at: 0, value: null, error: null };
    // Bounded LRU cache for Layer-2 trajectory model/timing/context metadata
    this._gmBackfillCache = new Map();
    this._gmInflight = new Map();
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

  async checkHealth() {
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
  }

  /** Layer 1 (Official Public API): Get single conversation metadata. */
  async getConversation(conversationId) {
    if (!conversationId) return null;
    try {
      return await this.callRpc('product.v1.ConversationService', 'GetConversation', { conversationId }, 3000);
    } catch {
      return null;
    }
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

  /** Layer 2 (Optional Enhancement): Fetch live account, credits, and model quotas. */
  async getUserStatus({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._userStatusCache.value && now - this._userStatusCache.at < 10_000) {
      return this._userStatusCache.value;
    }
    try {
      const res = await this.callRpc('exa.language_server_pb.LanguageServerService', 'GetUserStatus', {}, 5000);
      const us = res?.userStatus;
      if (!us) throw new Error('Empty userStatus payload');

      const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
      const labelsByModel = {};
      const poolMap = new Map();
      const models = configs.map((c) => {
        const modelId = c.modelOrAlias?.model || '';
        const label = c.label || modelId;
        if (modelId && label) labelsByModel[modelId] = label;
        const frac = c.quotaInfo?.remainingFraction;
        const remainingPercent = typeof frac === 'number' ? Math.round(frac * 100) : null;
        const resetTime = c.quotaInfo?.resetTime || '';
        const pool = resolveQuotaPool(modelId, label);

        if (remainingPercent !== null) {
          const p = poolMap.get(pool);
          if (!p) {
            poolMap.set(pool, { poolKey: pool, label, modelCount: 1, remainingPercent, resetTime });
          } else {
            p.modelCount++;
            if (remainingPercent < p.remainingPercent) p.remainingPercent = remainingPercent;
            if (resetTime && (!p.resetTime || resetTime < p.resetTime)) p.resetTime = resetTime;
          }
        }
        return {
          modelId,
          label,
          tagTitle: c.tagTitle || '',
          tagDescription: c.tagDescription || '',
          pool,
          remainingFraction: typeof frac === 'number' ? frac : null,
          remainingPercent,
          resetTime,
        };
      });

      const planInfo = us.planStatus?.planInfo || {};
      const creditsList = us.planStatus?.availableCredits || us.availableCredits || [];
      const credits = creditsList.reduce((s, c) => s + (Number(c.creditAmount) > 0 ? Number(c.creditAmount) : 0), 0);

      const parsed = {
        available: true,
        email: us.email || '',
        name: us.name || us.email || '',
        planName: planInfo.planName || '',
        tierName: us.userTier?.name || planInfo.teamsTier || '',
        credits,
        models,
        labelsByModel,
        resetPools: [...poolMap.values()],
      };
      this._userStatusCache = { at: now, value: parsed, error: null };
      return parsed;
    } catch (err) {
      const degraded = { available: false, error: err.message, models: [], labelsByModel: {}, resetPools: [] };
      this._userStatusCache = { at: now, value: degraded, error: err.message };
      return degraded;
    }
  }

  /** Layer 2 (Optional Enhancement): Fetch live model specs (cpLimit, maxTokens, thinkingLevel). Cached 5m. */
  async getModelCatalog({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._modelSpecsCache.value && now - this._modelSpecsCache.at < 300_000) {
      return this._modelSpecsCache.value;
    }
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
      const parsed = { available: true, specsById, limitsByAny };
      this._modelSpecsCache = { at: now, value: parsed, error: null };
      return parsed;
    } catch (err) {
      const degraded = { available: false, error: err.message, specsById: {}, limitsByAny: {} };
      this._modelSpecsCache = { at: now, value: degraded, error: err.message };
      return degraded;
    }
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
        let latestContext = null;

        for (const gm of list) {
          const cm = gm?.chatModel || {};
          const usage = cm.usage || {};
          const model = pickBestGmModel(cm, usage);
          if (!model) continue;
          fallbackModel = model;
          entryCount++;

          const ctxSnap = extractContextSnapshot(cm);
          if (ctxSnap) latestContext = ctxSnap;

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
