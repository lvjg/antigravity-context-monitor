/**
 * Antigravity Context Window Monitor v2.0 — Native sidecar_sdk backend.
 *
 * Design principles:
 * - Zero background polling (0% idle CPU): computes data strictly on-demand per HTTP request.
 * - Zero runtime disk duplication: reads Antigravity's local transcript.jsonl with an in-memory
 *   incremental byte-offset & mtime+size cache; persists ONLY tiny (<5 KB) accounts & prefs.
 * - Upgrade-resilient layered client: Layer 1 uses official /healthz + product.v1.ConversationService
 *   + local transcript.jsonl; Layer 2 optional LS RPCs degrade independently without breaking the panel.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  PRICING_LAST_UPDATED,
  effortRank,
  formatFamilyLabel,
  formatLocalDateKey,
  getDefaultPricing,
  resolveContextLimit,
  resolveQuotaFamily,
} from './lib/pricing.mjs';
import { AccountPrefsStore, getDataDir } from './lib/store.mjs';
import { LSClient } from './lib/ls-client.mjs';
import { TranscriptAnalyzer, isValidConvId, queryLocalConversationIndex } from './lib/transcripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new AccountPrefsStore();
const ls = new LSClient();
const analyzer = new TranscriptAnalyzer();

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const staticCache = new Map();
function readPublicCached(filename) {
  const fp = path.join(PUBLIC_DIR, filename);
  const mtimeMs = fs.statSync(fp).mtimeMs;
  const cached = staticCache.get(filename);
  if (cached && cached.mtimeMs === mtimeMs) return cached.body;
  const body = fs.readFileSync(fp, 'utf8');
  staticCache.set(filename, { mtimeMs, body });
  return body;
}

const app = new SidecarApp();

for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
  app.page(route, () => new Response(readPublicCached(file), {
    contentType,
    headers: { 'Cache-Control': 'no-store' },
  }));
}

function syncAccount(userStatus) {
  if (userStatus?.available && userStatus.email) {
    store.upsertAccountSnapshot(userStatus);
  }
}

function emptySessionListItem(c, subagentCount = 0, sideQuestionCount = 0) {
  return {
    id: c.id,
    title: c.annotations?.title || c.state?.summary || c.id.slice(0, 8),
    runState: c.state?.runState || 'RUN_STATE_IDLE',
    updateTime: c.state?.updateTime || '',
    createTime: c.metadata?.createTime || '',
    projectId: c.metadata?.projectId || '',
    model: '',
    calls: 0,
    turns: 0,
    subagentCount,
    sideQuestionCount,
    contextUsed: 0,
    contextLimit: 0,
    usagePercent: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheHitPercent: 0,
    outputTokensPerSec: null,
    avgLatencySec: null,
    avgOutputPerCall: 0,
    totalDurationSec: 0,
    timedCalls: 0,
    lastSpeedTokPerSec: null,
    modelBreakdown: [],
  };
}

async function resolveRootAndChildren(convId, force = false) {
  if (!convId) return { rootId: '', rootMeta: null, children: [] };
  const localTree = await queryLocalConversationIndex({ mode: 'tree', convId });
  if (localTree) {
    // Refresh live runState via LS when directly viewing a side conversation (not in conversation_summaries)
    if (localTree.rootMeta?.metadata?.isSideQuestion) {
      const liveMeta = await ls.getConversation(localTree.rootId, { force });
      if (liveMeta?.state?.runState) {
        return {
          ...localTree,
          rootMeta: {
            ...localTree.rootMeta,
            state: {
              ...localTree.rootMeta.state,
              runState: liveMeta.state.runState,
              updateTime: liveMeta.state.updateTime || localTree.rootMeta.state.updateTime,
            },
          },
        };
      }
    }
    return localTree;
  }
  const meta = await ls.getConversation(convId, { force });
  const parentId = meta?.metadata?.parentConversationId || '';
  const isSubagent = Boolean(parentId && parentId !== convId);
  const parentMeta = isSubagent ? await ls.getConversation(parentId, { force }) : null;
  const rootMeta = isSubagent
    ? {
        ...(meta || { id: convId }),
        isSubagent: true,
        metadata: {
          ...(meta?.metadata || {}),
          parentConversationId: parentId,
          parentTitle: parentMeta?.annotations?.title || parentMeta?.state?.summary || '',
          parentIsSubagent: Boolean(parentMeta?.metadata?.parentConversationId),
          rootConversationId: convId,
          isSubagent: true,
        },
      }
    : meta;
  const children = await ls.listChildConversations(convId);
  return { rootId: convId, rootMeta, children };
}

async function listRecentTopConversations(limit = 60, force = false) {
  const localTop = await queryLocalConversationIndex({ mode: 'top', limit });
  if (Array.isArray(localTop) && localTop.length > 0) return localTop;
  const rpcTop = await ls.listConversations({ pageSize: Math.min(limit, 25), force });
  if (Array.isArray(rpcTop) && rpcTop.length > 0) return rpcTop;
  try {
    const items = [];
    for (const id of fs.readdirSync(analyzer.brainDir)) {
      if (!isValidConvId(id)) continue;
      const fp = path.join(analyzer.brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        items.push({ id, mtimeMs: fs.statSync(fp).mtimeMs });
      } catch { /* ignore */ }
    }
    return items
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((x) => ({
        id: x.id,
        annotations: { title: '' },
        metadata: { projectId: '', rootConversationId: x.id },
        state: { runState: 'RUN_STATE_IDLE', updateTime: new Date(x.mtimeMs).toISOString() },
      }));
  } catch {
    return [];
  }
}

/** Primary overview endpoint for the active conversation + live status bar + account popover. */
app.api('/api/overview', async (params) => {
  const force = params.force === '1' || params.force === 'true';
  const requestedConv = String(params.conv || '').trim();
  const clientVersion = force ? '' : String(params.v || '').trim();

  const [health, userStatus, catalog] = await Promise.all([
    ls.checkHealth({ force }),
    ls.getUserStatus({ force }),
    ls.getModelCatalog({ force }),
  ]);
  syncAccount(userStatus);

  let targetConv = requestedConv;
  if (!targetConv) {
    const recent = await listRecentTopConversations(1, false);
    targetConv = recent?.[0]?.id || '';
  }

  let session = null;
  if (targetConv) {
    const { rootId, rootMeta, children } = await resolveRootAndChildren(targetConv, force);
    const runningSet = new Set();
    if (rootMeta?.state?.runState === 'RUN_STATE_RUNNING') runningSet.add(rootId);
    for (const c of children) {
      if (c?.state?.runState === 'RUN_STATE_RUNNING') runningSet.add(c.id);
    }
    const built = await analyzer.buildSessionView({
      convId: rootId,
      convMeta: rootMeta,
      childConversations: children,
      customPricing: store.getCustomPricing(),
      liveLabels: userStatus.labelsByModel,
      liveLimits: catalog.limitsByAny,
      resetPools: userStatus.resetPools,
      resolveBackfill: (id) => ls.getTrajectoryBackfill(id, { isRunning: runningSet.has(id) }),
    });
    session = built ? { ...built, viewingConvId: targetConv } : null;
    if (session && built?._cacheKey) {
      Object.defineProperty(session, '_cacheKey', { value: built._cacheKey, enumerable: false });
    }
  }

  const poolsSig = (userStatus.resetPools || [])
    .map((p) => `${p.poolKey}:${p.remainingPercent}:${p.resetTime || ''}:${p.fiveHour?.remainingPercent ?? ''}:${p.fiveHour?.resetTime || ''}:${p.weekly?.remainingPercent ?? ''}:${p.weekly?.resetTime || ''}`)
    .join(',');
  const versionRaw = [
    health?.ok ? 1 : 0,
    userStatus.available ? 1 : 0,
    userStatus.email || '',
    userStatus.credits || 0,
    poolsSig,
    catalog.available ? 1 : 0,
    store.getRevision(),
    targetConv,
    session?._cacheKey || '',
    Math.floor(Date.now() / 60_000),
  ].join('\x1e');
  const v = crypto.createHash('sha1').update(versionRaw).digest('base64url').slice(0, 16);

  if (clientVersion && clientVersion === v) {
    return { unchanged: true, v };
  }

  const mem = process.memoryUsage();
  return {
    v,
    health,
    userStatus: {
      available: userStatus.available,
      error: userStatus.error || null,
      email: userStatus.email || '',
      name: userStatus.name || '',
      planName: userStatus.planName || '',
      tierName: userStatus.tierName || '',
      credits: userStatus.credits || 0,
      resetPools: userStatus.resetPools || [],
    },
    catalogAvailable: catalog.available,
    session,
    accounts: store.getAccounts(userStatus.email || ''),
    language: store.getLanguage(),
    storage: store.getStorageInfo(),
    runtime: {
      rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
      heapMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      lsVersion: process.env.ANTIGRAVITY_LS_VERSION || '',
    },
    generatedAt: new Date().toISOString(),
  };
}, 'GET');

/** Recent sessions list with short response cache & parallel enrichment (non-blocking backfill). */
let sessionsCache = { at: 0, value: null };
let sessionsInflight = null;

function buildModelFamilies(models, resetPools) {
  const poolByKey = new Map((resetPools || []).map((p) => [p.poolKey, p]));
  const famMap = new Map();
  for (const m of models || []) {
    const info = resolveQuotaFamily(m.modelId, m.label, m.slug);
    const key = `${m.pool}:${info.familyKey}`;
    let fam = famMap.get(key);
    if (!fam) {
      const poolObj = poolByKey.get(m.pool) || null;
      fam = {
        familyKey: info.familyKey,
        familyLabel: info.familyLabel,
        pool: m.pool,
        cpLimit: m.cpLimit || 0,
        maxTokens: m.maxTokens || 0,
        maxOutputTokens: m.maxOutputTokens || 0,
        supportsThinking: Boolean(m.supportsThinking),
        supportsAdaptiveThinking: Boolean(m.supportsAdaptiveThinking),
        tags: [],
        members: [],
        fiveHour: poolObj?.fiveHour || null,
        weekly: poolObj?.weekly || null,
        remainingPercent: poolObj?.remainingPercent ?? m.remainingPercent,
        resetTime: poolObj?.resetTime || m.resetTime || '',
      };
      famMap.set(key, fam);
    }
    if (m.cpLimit > fam.cpLimit) fam.cpLimit = m.cpLimit;
    if (m.maxTokens > fam.maxTokens) fam.maxTokens = m.maxTokens;
    if (m.maxOutputTokens > fam.maxOutputTokens) fam.maxOutputTokens = m.maxOutputTokens;
    if (m.supportsThinking) fam.supportsThinking = true;
    if (m.supportsAdaptiveThinking) fam.supportsAdaptiveThinking = true;
    if (m.tagTitle && !fam.tags.includes(m.tagTitle)) fam.tags.push(m.tagTitle);
    fam.members.push({
      modelId: m.modelId,
      slug: m.slug || '',
      label: m.label,
      cpLimit: m.cpLimit || 0,
      maxTokens: m.maxTokens || 0,
      maxOutputTokens: m.maxOutputTokens || 0,
      tagTitle: m.tagTitle || '',
      remainingPercent: m.remainingPercent,
      resetTime: m.resetTime || '',
      _rank: effortRank(info.effort),
      _variant: info.variant,
    });
  }
  return [...famMap.values()].map((fam) => {
    fam.members.sort((a, b) => a._rank - b._rank);
    const variants = [...new Set(fam.members.map((x) => x._variant).filter(Boolean))];
    const members = fam.members.map(({ _rank, _variant, ...mb }) => mb);
    return { ...fam, variants, members };
  });
}

app.api('/api/sessions', async (params) => {
  const force = params.force === '1';
  const now = Date.now();
  if (!force && sessionsCache.value && now - sessionsCache.at < 15_000) {
    return sessionsCache.value;
  }
  if (!force && sessionsInflight) return sessionsInflight;

  const task = (async () => {
    const [convs, descendantsMap, userStatus, catalog] = await Promise.all([
      listRecentTopConversations(60, force),
      queryLocalConversationIndex({ mode: 'descendantsMap' }),
      ls.getUserStatus(),
      ls.getModelCatalog(),
    ]);
    const customPricing = store.getCustomPricing();
    const accountTimeline = store.getAccountTimeline();
    const today = formatLocalDateKey();

    const items = [];
    const bgBackfillIds = [];
    if (Array.isArray(convs)) {
      const enrichedConvs = convs.slice(0, 40);
      const CHUNK = 10;
      for (let i = 0; i < enrichedConvs.length; i += CHUNK) {
        const chunk = enrichedConvs.slice(i, i + CHUNK);
        const batchRes = await Promise.all(
          chunk.map((c, j) => {
            const idx = i + j;
            const desc = descendantsMap?.get(c.id);
            return analyzer.buildSessionListItem({
              conv: c,
              subagentIds: desc?.subagentIds || [],
              sideQuestionIds: desc?.sideQuestionIds || [],
              customPricing,
              liveLabels: userStatus.labelsByModel,
              liveLimits: catalog.limitsByAny,
              dateKey: today,
              accountTimeline,
              resolveBackfill: (id) => {
                const cached = ls.peekTrajectoryBackfill(id);
                if (!cached && idx < 10 && bgBackfillIds.length < 10) bgBackfillIds.push(id);
                return Promise.resolve(cached);
              },
            });
          }),
        );
        items.push(...batchRes);
      }
      for (let i = 40; i < convs.length; i++) {
        const c = convs[i];
        const desc = descendantsMap?.get(c.id);
        items.push(emptySessionListItem(c, (desc?.subagentIds || []).length, (desc?.sideQuestionIds || []).length));
      }
    }

    if (bgBackfillIds.length > 0) {
      analyzer.scheduleBackgroundBackfill(bgBackfillIds, (id) => ls.getTrajectoryBackfill(id, { timeoutMs: 6000 }));
    }

    const payload = { sessions: items, count: items.length };
    sessionsCache = { at: Date.now(), value: payload };
    return payload;
  })();

  sessionsInflight = task;
  try {
    return await task;
  } finally {
    sessionsInflight = null;
  }
}, 'GET');

/** On-demand usage, cost & calendar aggregation from local transcript.jsonl files. */
const usageInflight = new Map();

app.api('/api/usage', async (params) => {
  const daysNum = Math.max(1, Math.min(365, parseInt(params.days || '31', 10) || 31));
  const force = params.force === '1';
  if (!force && usageInflight.has(daysNum)) return usageInflight.get(daysNum);

  const task = (async () => {
    const userStatus = await ls.getUserStatus();
    syncAccount(userStatus);
    const customPricing = store.getCustomPricing();
    const accountTimeline = store.getAccountTimeline();
    const agg = await analyzer.aggregateUsage({
      sinceDays: daysNum,
      customPricing,
      liveLabels: userStatus.labelsByModel,
      accountTimeline,
      peekBackfill: (id) => ls.peekTrajectoryBackfill(id),
      resolveBackfill: (id) => ls.getTrajectoryBackfill(id, { timeoutMs: 8000 }),
      force,
    });

    const todayKey = formatLocalDateKey();
    const pricingRows = Object.entries(getDefaultPricing(todayKey)).map(([family, def]) => {
      const custom = customPricing[family] || null;
      return { family, label: formatFamilyLabel(family), default: def, custom, effective: custom || def, isCustom: Boolean(custom) };
    });

    return {
      todayKey,
      sinceDays: daysNum,
      pricingLastUpdated: PRICING_LAST_UPDATED,
      accounts: store.getAccounts(userStatus.email || ''),
      accountTimelineCount: accountTimeline.length,
      accountTrackingSince: accountTimeline[0]?.at || '',
      ...agg,
      pricingRows,
    };
  })();

  usageInflight.set(daysNum, task);
  try {
    return await task;
  } finally {
    usageInflight.delete(daysNum);
  }
}, 'GET');

/** Models & Live Quotas tab payload (Layer 2 optional enhancement with graceful degradation). */
app.api('/api/models', async (params) => {
  const force = params.force === '1';
  const [userStatus, catalog] = await Promise.all([
    ls.getUserStatus({ force }),
    ls.getModelCatalog({ force }),
  ]);

  const models = (userStatus.models || []).map((m) => {
    const spec = catalog.specsById[m.modelId] || null;
    return {
      ...m,
      slug: spec?.slug || '',
      apiProvider: spec?.apiProvider || '',
      maxTokens: spec?.maxTokens || 0,
      maxOutputTokens: spec?.maxOutputTokens || 0,
      cpLimit: spec?.cpLimit || resolveContextLimit(m.modelId || m.label, catalog.limitsByAny),
      supportsThinking: spec?.supportsThinking ?? true,
      supportsAdaptiveThinking: Boolean(spec?.supportsAdaptiveThinking),
      thinkingLevel: spec?.thinkingLevel || 0,
      thinkingBudget: spec?.thinkingBudget || 0,
    };
  });

  const resetPools = userStatus.resetPools || [];
  const families = buildModelFamilies(models, resetPools);

  return {
    available: userStatus.available,
    error: userStatus.error || null,
    catalogAvailable: catalog.available,
    resetPools,
    families,
    models,
  };
}, 'GET');

/** Update or reset custom model pricing overrides. */
app.api('/api/pricing', async (body) => {
  if (body?.reset) {
    store.resetCustomPricing();
    sessionsCache = { at: 0, value: null };
    return { ok: true, customPricing: store.getCustomPricing() };
  }
  if (body?.pricing && typeof body.pricing === 'object') {
    store.setCustomPricing(body.pricing);
    sessionsCache = { at: 0, value: null };
    return { ok: true, customPricing: store.getCustomPricing() };
  }
  return new Response(JSON.stringify({ ok: false, error: 'Invalid pricing payload' }), {
    status: 400,
    contentType: 'application/json',
  });
}, 'POST');

/** Update display language or remove an offline account snapshot. */
app.api('/api/prefs', async (body) => {
  if (typeof body?.language === 'string') store.setLanguage(body.language);
  if (typeof body?.removeAccount === 'string') store.removeAccount(body.removeAccount);
  return {
    ok: true,
    language: store.getLanguage(),
    accounts: store.getAccounts(),
    storage: store.getStorageInfo(),
  };
}, 'POST');

app.run().then(() => {
  console.log(`[context-monitor] v2.0 sidecar_sdk ready (dataDir=${getDataDir()}, brainDir=${analyzer.brainDir})`);
});

const shutdown = (sig) => {
  console.log(`[context-monitor] received ${sig}, shutting down cleanly`);
  app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
