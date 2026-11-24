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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  PRICING_LAST_UPDATED,
  formatFamilyLabel,
  formatLocalDateKey,
  getDefaultPricing,
  resolveContextLimit,
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

function emptySessionListItem(c, subagentCount = 0) {
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

async function resolveRootAndChildren(convId) {
  if (!convId) return { rootId: '', rootMeta: null, children: [] };
  const localTree = await queryLocalConversationIndex({ mode: 'tree', convId });
  if (localTree) return localTree;
  const meta = await ls.getConversation(convId);
  const rootId = meta?.metadata?.rootConversationId || convId;
  const rootMeta = rootId === convId ? meta : (await ls.getConversation(rootId)) || meta;
  const children = await ls.listChildConversations(rootId);
  return { rootId, rootMeta, children };
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

  const [health, userStatus, catalog] = await Promise.all([
    ls.checkHealth(),
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
    const { rootId, rootMeta, children } = await resolveRootAndChildren(targetConv);
    const runningSet = new Set();
    if (rootMeta?.state?.runState === 'RUN_STATE_RUNNING') runningSet.add(rootId);
    for (const c of children) {
      if (c?.state?.runState === 'RUN_STATE_RUNNING') runningSet.add(c.id);
    }
    session = await analyzer.buildSessionView({
      convId: rootId,
      convMeta: rootMeta,
      childConversations: children,
      customPricing: store.getCustomPricing(),
      liveLabels: userStatus.labelsByModel,
      liveLimits: catalog.limitsByAny,
      resetPools: userStatus.resetPools,
      resolveBackfill: (id) => ls.getTrajectoryBackfill(id, { isRunning: runningSet.has(id) }),
    });
    session.viewingConvId = targetConv;
  }

  const mem = process.memoryUsage();
  return {
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

/** Recent sessions list with cached per-model usage & speed enrichment. */
app.api('/api/sessions', async (params) => {
  const force = params.force === '1';
  const [convs, descendantsMap, userStatus, catalog] = await Promise.all([
    listRecentTopConversations(60, force),
    queryLocalConversationIndex({ mode: 'descendantsMap' }),
    ls.getUserStatus(),
    ls.getModelCatalog(),
  ]);
  const customPricing = store.getCustomPricing();
  const today = formatLocalDateKey();

  const items = [];
  if (Array.isArray(convs)) {
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i];
      const descendantIds = descendantsMap?.get(c.id) || [];
      if (i < 40) {
        items.push(
          await analyzer.buildSessionListItem({
            conv: c,
            descendantIds,
            customPricing,
            liveLabels: userStatus.labelsByModel,
            liveLimits: catalog.limitsByAny,
            dateKey: today,
            resolveBackfill: i < 15
              ? (id) => ls.getTrajectoryBackfill(id, { timeoutMs: 8000 })
              : (id) => Promise.resolve(ls.peekTrajectoryBackfill(id)),
          }),
        );
      } else {
        items.push(emptySessionListItem(c, descendantIds.length));
      }
    }
  }
  return { sessions: items, count: items.length };
}, 'GET');

/** On-demand usage, cost & calendar aggregation from local transcript.jsonl files. */
app.api('/api/usage', async (params) => {
  const daysNum = Math.max(1, Math.min(365, parseInt(params.days || '31', 10) || 31));
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

  return {
    available: userStatus.available,
    error: userStatus.error || null,
    catalogAvailable: catalog.available,
    resetPools: userStatus.resetPools || [],
    models,
  };
}, 'GET');

/** Update or reset custom model pricing overrides. */
app.api('/api/pricing', async (body) => {
  if (body?.reset) {
    store.resetCustomPricing();
    return { ok: true, customPricing: store.getCustomPricing() };
  }
  if (body?.pricing && typeof body.pricing === 'object') {
    store.setCustomPricing(body.pricing);
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
