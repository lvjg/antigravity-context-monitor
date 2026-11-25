/**
 * Streaming, incremental transcript.jsonl analyzer with pure in-memory caching.
 *
 * Reads ONLY Antigravity's local brain/<id>/.system_generated/logs/transcript.jsonl files.
 * - Zero disk persistence, zero background polling.
 * - Active conversation uses incremental byte-offset reading (<1 ms warm refresh).
 * - Full history uses compact per-conversation summary cache (invalidated on mtime+size+timeline).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  computeCost,
  formatFamilyLabel,
  formatLocalDateKey,
  formatModelName,
  resolveContextLimit,
  resolveModelPricing,
  resolvePricingFamily,
  resolveQuotaPool,
} from './pricing.mjs';

const CONV_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;
const LINE_TYPE_RE = /"type"\s*:\s*"([A-Z_]+)"/;
const STEP_INDEX_RE = /"step_index"\s*:\s*(\d+)/;
const CREATED_AT_RE = /"created_at"\s*:\s*"([^"]+)"/;
const MAX_VALID_CALL_DURATION_SEC = 300;
const MAX_LONG_GEN_DURATION_SEC = 600;
const FIVE_HOURS_MS = 5 * 3600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

export function isValidConvId(id) {
  return typeof id === 'string' && CONV_ID_RE.test(id);
}

function getAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) return process.env.ANTIGRAVITY_APP_DATA_DIR;
  const dd = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dd) {
    for (let d = dd; d !== path.dirname(d); d = path.dirname(d)) {
      if (path.basename(d) === 'sidecar_data') return path.dirname(d);
    }
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

/**
 * Fast (<5ms) read-only local conversation & subagent index backed by Antigravity's
 * SQLite WAL database (`conversation_summaries.db`), using Node 24's built-in `node:sqlite`.
 */
let sqliteModPromise = null;
function getSqlite() {
  if (!sqliteModPromise) sqliteModPromise = import('node:sqlite').catch(() => null);
  return sqliteModPromise;
}

function normalizeRunState(status) {
  const s = String(status || '');
  if (s === 'RUN_STATE_RUNNING' || s === 'CASCADE_RUN_STATUS_RUNNING') return 'RUN_STATE_RUNNING';
  if (s === 'RUN_STATE_CANCELLING' || s === 'CASCADE_RUN_STATUS_CANCELLING') return 'RUN_STATE_CANCELLING';
  return 'RUN_STATE_IDLE';
}

function normalizeTimestamp(raw) {
  const s = String(raw || '').trim();
  // Filter Go zero time.Time ("0001-01-01 00:00:00+00:00") so callers fall back to transcript lastTs
  return !s || s.startsWith('0001-01-01') ? '' : s;
}

function mapSummaryRow(r, rootId = r.conversation_id) {
  return {
    id: r.conversation_id,
    ...(r.agent_name ? { agentName: r.agent_name } : {}),
    annotations: { title: r.title || r.agent_name || '' },
    metadata: {
      projectId: r.project_id || '',
      parentConversationId: r.parent_conversation_id || '',
      rootConversationId: rootId,
    },
    state: { runState: normalizeRunState(r.status), updateTime: normalizeTimestamp(r.last_modified_time) },
  };
}

const localIndexCache = new Map(); // (mode|convId|limit) -> { walSig, annOwnerId, annOwnerSig, value }
const sideTitlesCache = new Map(); // rootId -> { mtimeMs, map }

function statFileSig(fp) {
  try {
    const st = fs.statSync(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '0:0';
  }
}

/** Read official side-question titles from Antigravity's annotations/<rootId>.pbtxt (cached by mtimeMs). */
function readSideQuestionTitles(appDataDir, rootId) {
  if (!rootId) return new Map();
  const fp = path.join(appDataDir, 'annotations', `${rootId}.pbtxt`);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(fp).mtimeMs;
  } catch {
    return new Map();
  }
  const cached = sideTitlesCache.get(rootId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.map;

  const map = new Map();
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    for (const m of txt.matchAll(/side_question_titles:\{key:"([^"]+)"\s+value:"((?:[^"\\]|\\.)*)"\}/g)) {
      const title = m[2]
        .replace(/\\(["\\nt])/g, (_, ch) => (ch === 'n' || ch === 't' ? ' ' : ch))
        .trim();
      if (title) map.set(m[1], title);
    }
  } catch { /* ignore */ }
  sideTitlesCache.delete(rootId);
  sideTitlesCache.set(rootId, { mtimeMs, map });
  if (sideTitlesCache.size > 64) sideTitlesCache.delete(sideTitlesCache.keys().next().value);
  return map;
}

function makeSideQuestionRow(cid, parentId, rootId, title = '') {
  return {
    id: cid,
    isSideQuestion: true,
    annotations: { title },
    metadata: {
      projectId: '',
      parentConversationId: parentId,
      rootConversationId: rootId,
      isSideQuestion: true,
    },
    state: { runState: 'RUN_STATE_IDLE', updateTime: '' },
  };
}

export async function queryLocalConversationIndex({ mode, convId = '', limit = 60 } = {}) {
  const sqlite = await getSqlite();
  if (!sqlite?.DatabaseSync) return null;
  const appDataDir = getAppDataDir();
  const dbPath = path.join(appDataDir, 'conversation_summaries.db');
  const dbSig = statFileSig(dbPath);
  if (dbSig === '0:0') return null;
  const walSig = `${dbSig}|${statFileSig(`${dbPath}-wal`)}`;
  const cacheKey = `${mode}|${convId}|${limit}`;
  const cached = localIndexCache.get(cacheKey);
  if (
    cached &&
    cached.walSig === walSig &&
    (!cached.annOwnerId || statFileSig(path.join(appDataDir, 'annotations', `${cached.annOwnerId}.pbtxt`)) === cached.annOwnerSig)
  ) {
    return cached.value;
  }

  const remember = (value, annOwnerId = '') => {
    const annOwnerSig = annOwnerId ? statFileSig(path.join(appDataDir, 'annotations', `${annOwnerId}.pbtxt`)) : '';
    localIndexCache.delete(cacheKey);
    localIndexCache.set(cacheKey, { walSig, annOwnerId, annOwnerSig, value });
    if (localIndexCache.size > 32) localIndexCache.delete(localIndexCache.keys().next().value);
    return value;
  };

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const cols = 'conversation_id, title, status, last_modified_time, project_id, parent_conversation_id, agent_name';
    const hasSideParents = Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_parents'`).get(),
    );

    if (mode === 'top') {
      const rows = db
        .prepare(`SELECT ${cols} FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT ?`)
        .all(limit);
      return remember(rows.map((r) => mapSummaryRow(r)));
    }

    if (mode === 'tree' && convId) {
      const getRow = db.prepare(`SELECT ${cols} FROM conversation_summaries WHERE conversation_id = ?`);
      const getSideParent = hasSideParents
        ? db.prepare(`SELECT parent_id FROM conversation_parents WHERE conversation_id = ?`)
        : null;
      const getSideChildren = hasSideParents
        ? db.prepare(`SELECT conversation_id FROM conversation_parents WHERE parent_id = ?`)
        : null;
      const byParent = db.prepare(`SELECT ${cols} FROM conversation_summaries WHERE parent_conversation_id = ? ORDER BY last_modified_time DESC`);

      // Check if viewing a side conversation directly: keep focus on its own independent context & trace
      const sideParentRow = getSideParent ? getSideParent.get(convId) : null;
      let rootId = convId;
      let rootMeta = null;

      if (sideParentRow?.parent_id) {
        const parentId = sideParentRow.parent_id;
        const parentRow = getRow.get(parentId);
        const sideTitles = readSideQuestionTitles(appDataDir, parentId);
        const title = sideTitles.get(convId) || '';
        rootMeta = {
          id: convId,
          isSideQuestion: true,
          annotations: { title },
          metadata: {
            projectId: parentRow?.project_id || '',
            parentConversationId: parentId,
            parentTitle: parentRow?.title || '',
            rootConversationId: convId,
            isSideQuestion: true,
          },
          state: { runState: 'RUN_STATE_IDLE', updateTime: '' },
        };
      } else {
        let rootRow = getRow.get(convId);
        for (let hops = 0; rootRow?.parent_conversation_id && hops < 8; hops++) {
          const nextParentId = rootRow.parent_conversation_id;
          const parent = getRow.get(nextParentId);
          if (parent && parent.conversation_id !== rootId) {
            rootId = parent.conversation_id;
            rootRow = parent;
            continue;
          }
          // Subagent spawned by a side conversation: walk up through conversation_parents to the main session
          const sideUp = getSideParent ? getSideParent.get(nextParentId) : null;
          if (sideUp?.parent_id && sideUp.parent_id !== rootId) {
            const grandParent = getRow.get(sideUp.parent_id);
            if (grandParent) {
              rootId = grandParent.conversation_id;
              rootRow = grandParent;
              continue;
            }
          }
          break;
        }
        rootMeta = rootRow ? mapSummaryRow(rootRow, rootId) : null;
      }

      const children = [];
      const seen = new Set([rootId]);
      const sideIdsInTree = new Set();
      const sideTitleById = new Map();
      const queue = [rootId];

      while (queue.length > 0 && children.length < 200) {
        const curId = queue.shift();
        const viaSideId = sideIdsInTree.has(curId) ? curId : '';

        for (const c of byParent.all(curId)) {
          if (seen.has(c.conversation_id)) continue;
          seen.add(c.conversation_id);
          const mapped = mapSummaryRow(c, rootId);
          if (viaSideId) {
            mapped.parentSideId = viaSideId;
            mapped.parentSideTitle = sideTitleById.get(viaSideId) || '';
          }
          children.push(mapped);
          queue.push(c.conversation_id);
        }

        if (getSideChildren) {
          const sideRows = getSideChildren.all(curId);
          if (sideRows.length > 0) {
            const titles = readSideQuestionTitles(appDataDir, curId);
            for (const sr of sideRows) {
              const sid = sr.conversation_id;
              if (!sid || seen.has(sid)) continue;
              seen.add(sid);
              sideIdsInTree.add(sid);
              const title = titles.get(sid) || '';
              if (title) sideTitleById.set(sid, title);
              children.push(makeSideQuestionRow(sid, curId, rootId, title));
              queue.push(sid);
            }
          }
        }
      }

      return remember({ rootId, rootMeta, children }, sideParentRow?.parent_id || rootId);
    }

    if (mode === 'descendantsMap') {
      const rows = db.prepare(`SELECT conversation_id, parent_conversation_id FROM conversation_summaries WHERE parent_conversation_id != ''`).all();
      const parentOf = new Map(rows.map((r) => [r.conversation_id, r.parent_conversation_id]));
      const sideIds = new Set();
      if (hasSideParents) {
        for (const sr of db.prepare(`SELECT conversation_id, parent_id FROM conversation_parents`).all()) {
          if (!sr.conversation_id || !sr.parent_id) continue;
          sideIds.add(sr.conversation_id);
          if (!parentOf.has(sr.conversation_id)) parentOf.set(sr.conversation_id, sr.parent_id);
        }
      }
      const byRoot = new Map();
      for (const [cid, pid] of parentOf.entries()) {
        let cur = pid;
        for (let hops = 0; parentOf.has(cur) && hops < 8; hops++) {
          const next = parentOf.get(cur);
          if (!next || next === cur) break;
          cur = next;
        }
        let entry = byRoot.get(cur);
        if (!entry) {
          entry = { subagentIds: [], sideQuestionIds: [] };
          byRoot.set(cur, entry);
        }
        if (sideIds.has(cid)) entry.sideQuestionIds.push(cid);
        else entry.subagentIds.push(cid);
      }
      return remember(byRoot);
    }
    return null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function transcriptPathOf(brainDir, convId) {
  return path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function formatTimelineSig(timeline) {
  return Array.isArray(timeline) && timeline.length ? timeline.map((e) => `${e.atMs}:${e.email}`).join('|') : '';
}

function readSubagentDescriptors(brainDir, rootId, cache = null) {
  if (!rootId) return new Map();
  const dir = path.join(brainDir, rootId, '.system_generated', 'subagents');
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return new Map();
  }
  const cached = cache?.get(rootId);
  if (cached && cached.mtimeMs === dirMtimeMs) return cached.map;

  const map = new Map();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const cid = raw?.conversationId || f.slice(0, -5);
      const desc = raw?.subagentDescriptor || {};
      if (cid) {
        map.set(cid, {
          role: String(desc.role || '').trim(),
          typeName: String(desc.typeName || '').trim(),
          state: String(raw?.state || '').trim(),
        });
      }
    } catch { /* ignore */ }
  }
  if (cache) {
    cache.delete(rootId);
    cache.set(rootId, { mtimeMs: dirMtimeMs, map });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return map;
}

/**
 * Fast O(1) header extractor on the first 320 chars of a JSONL line, avoiding full scans
 * or false matches against large tool outputs (`GENERIC` content).
 */
function parseLineHeader(line) {
  const head = line.length > 320 ? line.slice(0, 320) : line;
  const typeMatch = head.match(LINE_TYPE_RE) || (line.length < 2048 ? line.match(LINE_TYPE_RE) : null);
  const stepMatch = head.match(STEP_INDEX_RE);
  const tsMatch = head.match(CREATED_AT_RE);
  return {
    type: typeMatch ? typeMatch[1] : '',
    stepIdx: stepMatch ? Number(stepMatch[1]) : 0,
    ts: tsMatch ? tsMatch[1] : '',
  };
}

function extractUserPrompt(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m ? m[1] : content).trim().replace(/\s+/g, ' ').slice(0, 240);
}

function unquoteArg(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') return String(raw);
  const s = raw.trim();
  if (!s) return '';
  if (s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed.trim();
    } catch { /* keep raw */ }
  }
  return s;
}

function shortPathArg(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return '';
  const parts = clean.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : (parts[0] || clean);
}

function summarizeToolCallArg(args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (...keys) => {
    for (const k of keys) {
      if (args[k] != null) {
        const v = unquoteArg(args[k]);
        if (v) return v;
      }
    }
    return '';
  };
  const clip = (s, max = 84) => {
    const one = String(s || '').replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };

  const filePath = pick('Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath');
  if (filePath) {
    const start = pick('StartLine');
    const end = pick('EndLine');
    const range = start ? ` L${start}${end ? `-${end}` : ''}` : '';
    return clip(`${shortPathArg(filePath)}${range}`);
  }
  const cmd = pick('toolSummary', 'CommandLine', 'query', 'Url', 'Role', 'focus', 'toolAction', 'Description', 'Action', 'ServerName', 'ToolName');
  if (cmd) return clip(cmd);

  for (const [k, v] of Object.entries(args)) {
    if (k === 'WaitMsBeforeAsync' || k === 'Overwrite' || k === 'Append') continue;
    const s = unquoteArg(v);
    if (s && !s.startsWith('{') && !s.startsWith('[')) return clip(`${k}: ${s}`);
  }
  return '';
}

function classifyErrorCategory(message) {
  const s = String(message || '').toLowerCase();
  if (/(?:timeout|deadline exceeded|timed out)/.test(s)) return 'timeout';
  if (/(?:dial tcp|lookup |econnrefused|econnreset|enotfound|network|socket hang up|tls handshake)/.test(s)) return 'network';
  if (/(?:429|503|unavailable|no capacity|rate limit|resource_exhausted|quota|overloaded)/.test(s)) return 'capacity';
  if (/(?:malformed function call|improperly formatted|model output error|failed to parse)/.test(s)) return 'format';
  if (/(?:stream was interrupted|interrupted|cancelled|canceled|aborted)/.test(s)) return 'interrupted';
  if (/(?:api error|http [45]\d\d|status code [45]\d\d|internal error)/.test(s)) return 'api';
  return 'other';
}

function buildErrorSummary(errors, mainConvId, sideQuestionIds = null) {
  const counts = new Map();
  let mainCount = 0;
  let sideQuestionCount = 0;
  let subagentCount = 0;
  for (const e of errors) {
    if (e.convId === mainConvId) mainCount++;
    else if (sideQuestionIds?.has(e.convId)) sideQuestionCount++;
    else subagentCount++;
    counts.set(e.category, (counts.get(e.category) || 0) + 1);
  }
  const byCategory = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  return {
    total: errors.length,
    mainCount,
    sideQuestionCount,
    subagentCount,
    latestTs: errors[0]?.ts || '',
    byCategory,
  };
}

// ── Bucket, Timing & Backfill Helpers ──

function emptyModelBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    timedCalls: 0,
    timedOutputTokens: 0,
    timedDurationSec: 0,
    lastSpeedTokPerSec: null,
    byDate: {},
  };
}

function addDateTokens(bucket, dateKey, inTok, cacheTok, outTok, cacheWriteTok = 0) {
  const dk = dateKey || formatLocalDateKey();
  const d = (bucket.byDate[dk] ||= { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
  d.inputTokens += inTok;
  d.cacheReadTokens += cacheTok;
  d.cacheCreationTokens += cacheWriteTok;
  d.outputTokens += outTok;
}

function recordBucketCall(bucket, inTok, cacheTok, outTok, cacheWriteTok = 0, dateKey = '') {
  bucket.calls++;
  bucket.inputTokens += inTok;
  bucket.cacheReadTokens += cacheTok;
  bucket.cacheCreationTokens += cacheWriteTok;
  bucket.outputTokens += outTok;
  if (dateKey) addDateTokens(bucket, dateKey, inTok, cacheTok, outTok, cacheWriteTok);
}

function recordTimedSample(bucket, outTok, dtSec, speed = null) {
  if (!bucket || !(dtSec > 0)) return;
  bucket.timedCalls++;
  bucket.timedOutputTokens += outTok;
  bucket.timedDurationSec += dtSec;
  if (speed !== null) bucket.lastSpeedTokPerSec = speed;
}

function computeBucketCost(bucket, slug, customPricing, fallbackDateKey = formatLocalDateKey()) {
  const dateEntries = bucket?.byDate ? Object.entries(bucket.byDate) : [];
  if (dateEntries.length > 0) {
    let total = 0;
    for (const [dk, tok] of dateEntries) {
      total += computeCost(tok, resolveModelPricing(slug, customPricing, dk));
    }
    return total;
  }
  return computeCost(bucket || {}, resolveModelPricing(slug, customPricing, fallbackDateKey));
}

function cloneModelBucket(src) {
  const byDate = {};
  if (src?.byDate) {
    for (const [dk, v] of Object.entries(src.byDate)) byDate[dk] = { ...v };
  }
  return {
    calls: src?.calls || 0,
    inputTokens: src?.inputTokens || 0,
    cacheReadTokens: src?.cacheReadTokens || 0,
    cacheCreationTokens: src?.cacheCreationTokens || 0,
    outputTokens: src?.outputTokens || 0,
    timedCalls: src?.timedCalls || 0,
    timedOutputTokens: src?.timedOutputTokens || 0,
    timedDurationSec: src?.timedDurationSec || 0,
    lastSpeedTokPerSec: src?.lastSpeedTokPerSec ?? null,
    byDate,
  };
}

function mergeIntoBucket(dst, src) {
  dst.calls += src.calls || 0;
  dst.inputTokens += src.inputTokens || 0;
  dst.cacheReadTokens += src.cacheReadTokens || 0;
  dst.cacheCreationTokens += src.cacheCreationTokens || 0;
  dst.outputTokens += src.outputTokens || 0;
  dst.timedCalls += src.timedCalls || 0;
  dst.timedOutputTokens += src.timedOutputTokens || 0;
  dst.timedDurationSec += src.timedDurationSec || 0;
  if (src.byDate) {
    for (const [dk, v] of Object.entries(src.byDate)) {
      addDateTokens(dst, dk, v.inputTokens || 0, v.cacheReadTokens || 0, v.outputTokens || 0, v.cacheCreationTokens || 0);
    }
  }
}

function lookupBackfillStep(backfill, step) {
  if (!backfill?.byStep) return null;
  return backfill.byStep[step] || backfill.byStep[step - 1] || backfill.byStep[step + 1] || null;
}

function pickStepDurationSec(info, fallbackSec) {
  const gmDur = (info?.ttftSec || 0) + (info?.streamSec || 0);
  return gmDur > 0 && gmDur <= MAX_LONG_GEN_DURATION_SEC ? gmDur : fallbackSec;
}

async function fetchBackfillsInBatches(ids, resolveBackfill, batchSize = 10) {
  const map = new Map();
  if (!resolveBackfill || !ids.length) return map;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((cid) => resolveBackfill(cid).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) map.set(batch[j], results[j]);
    }
  }
  return map;
}

/**
 * Re-attribute pre-2026-11-18 `unknown` steps using Layer-2 LS trajectory metadata backfill.
 * Pure function — leaves cached transcript state untouched.
 */
function resolveUsageWithBackfill(source, backfill) {
  if (!source) {
    return { modelUsage: {}, lastModel: '', timedCalls: 0, timedOutputTokens: 0, timedDurationSec: 0, lastSpeedTokPerSec: null };
  }
  const unknownSteps = source.unknownSteps || [];
  if (!backfill || unknownSteps.length === 0) {
    return {
      modelUsage: source.modelUsage || {},
      lastModel: source.lastModel || '',
      timedCalls: source.timedCalls || 0,
      timedOutputTokens: source.timedOutputTokens || 0,
      timedDurationSec: source.timedDurationSec || 0,
      lastSpeedTokPerSec: source.lastSpeedTokPerSec ?? null,
    };
  }

  const resolved = {};
  let timedCalls = 0;
  let timedOutputTokens = 0;
  let timedDurationSec = 0;
  let lastSpeedTokPerSec = source.lastSpeedTokPerSec ?? null;

  for (const [slug, b] of Object.entries(source.modelUsage || {})) {
    if (slug === 'unknown') continue;
    resolved[slug] = cloneModelBucket(b);
    timedCalls += b.timedCalls || 0;
    timedOutputTokens += b.timedOutputTokens || 0;
    timedDurationSec += b.timedDurationSec || 0;
  }

  let lastResolvedModel = '';
  for (const u of unknownSteps) {
    const info = lookupBackfillStep(backfill, u.step);
    const mSlug = info?.model || backfill.fallbackModel || 'unknown';
    if (mSlug !== 'unknown') lastResolvedModel = mSlug;
    const b = (resolved[mSlug] ||= emptyModelBucket());
    recordBucketCall(b, u.inputTokens, u.cacheReadTokens, u.outputTokens, info?.cacheCreationTokens || 0, u.dateKey);

    const dur = pickStepDurationSec(info, u.dtSec);
    if (dur > 0) {
      const sp = u.outputTokens > 0 ? +(u.outputTokens / dur).toFixed(1) : null;
      recordTimedSample(b, u.outputTokens, dur, sp);
      timedCalls++;
      timedOutputTokens += u.outputTokens;
      timedDurationSec += dur;
      if (sp !== null && !source.lastModel) lastSpeedTokPerSec = sp;
    }
  }

  return {
    modelUsage: resolved,
    lastModel: source.lastModel || lastResolvedModel || backfill.fallbackModel || '',
    timedCalls,
    timedOutputTokens,
    timedDurationSec,
    lastSpeedTokPerSec,
  };
}

function applyBackfillToSummaryByDate(summary, bf, fallbackDateKey) {
  if (!summary.unknownSteps?.length || !bf || !(bf.entryCount > 0)) return summary.byDate;
  const rebuilt = {};
  for (const [dk, dd] of Object.entries(summary.byDate)) {
    const byModel = {};
    for (const [ms, msSt] of Object.entries(dd.byModel)) {
      if (ms !== 'unknown') byModel[ms] = cloneModelBucket(msSt);
    }
    const byAccount = {};
    for (const [ak, ad] of Object.entries(dd.byAccount || {})) {
      const aModels = {};
      for (const [ms, msSt] of Object.entries(ad.byModel || {})) {
        if (ms !== 'unknown') aModels[ms] = cloneModelBucket(msSt);
      }
      byAccount[ak] = { calls: ad.calls, turns: ad.turns, errors: ad.errors, byModel: aModels };
    }
    rebuilt[dk] = { calls: dd.calls, turns: dd.turns, errors: dd.errors, byModel, byAccount };
  }
  for (const u of summary.unknownSteps) {
    const info = lookupBackfillStep(bf, u.step);
    const mSlug = info?.model || bf.fallbackModel || 'unknown';
    const dk = u.dateKey || fallbackDateKey;
    const ak = u.account || 'unattributed';
    const day = (rebuilt[dk] ||= { calls: 0, turns: 0, errors: 0, byModel: {}, byAccount: {} });
    const acctDay = (day.byAccount[ak] ||= { calls: 0, turns: 0, errors: 0, byModel: {} });
    const dm = (day.byModel[mSlug] ||= emptyModelBucket());
    const am = (acctDay.byModel[mSlug] ||= emptyModelBucket());
    const cwTok = info?.cacheCreationTokens || 0;
    const dur = pickStepDurationSec(info, u.dtSec);
    for (const b of [dm, am]) {
      recordBucketCall(b, u.inputTokens, u.cacheReadTokens, u.outputTokens, cwTok);
      recordTimedSample(b, u.outputTokens, dur);
    }
  }
  return rebuilt;
}

function computeRateMetrics(stats) {
  const calls = Number(stats?.calls) || 0;
  const inputTokens = Number(stats?.inputTokens) || 0;
  const cacheReadTokens = Number(stats?.cacheReadTokens) || 0;
  const outputTokens = Number(stats?.outputTokens) || 0;
  const timedCalls = Number(stats?.timedCalls) || 0;
  const timedOutputTokens = Number(stats?.timedOutputTokens) || 0;
  const timedDurationSec = Number(stats?.timedDurationSec) || 0;
  const promptTotal = inputTokens + cacheReadTokens;
  return {
    cacheHitPercent: promptTotal > 0 ? +((cacheReadTokens / promptTotal) * 100).toFixed(1) : 0,
    outputTokensPerSec: timedDurationSec > 0 ? +(timedOutputTokens / timedDurationSec).toFixed(1) : null,
    avgLatencySec: timedCalls > 0 ? +(timedDurationSec / timedCalls).toFixed(1) : null,
    avgOutputPerCall: calls > 0 ? Math.round(outputTokens / calls) : 0,
    totalDurationSec: Math.round(timedDurationSec),
    timedCalls,
    lastSpeedTokPerSec: stats?.lastSpeedTokPerSec ?? null,
  };
}

function emptyTtftAgg() {
  return { ttftCalls: 0, ttftSumSec: 0, lastTtftSec: null, minTtftSec: null, maxTtftSec: null, streamCalls: 0, streamSumSec: 0, streamOutputTokens: 0 };
}

function mergeTtftAgg(dst, src) {
  if (!src) return;
  if (src.ttftCalls > 0) {
    dst.ttftCalls += src.ttftCalls;
    dst.ttftSumSec += src.ttftSumSec;
    if (src.lastTtftSec != null) dst.lastTtftSec = src.lastTtftSec;
    if (src.minTtftSec != null) dst.minTtftSec = dst.minTtftSec == null ? src.minTtftSec : Math.min(dst.minTtftSec, src.minTtftSec);
    if (src.maxTtftSec != null) dst.maxTtftSec = dst.maxTtftSec == null ? src.maxTtftSec : Math.max(dst.maxTtftSec, src.maxTtftSec);
  }
  if (src.streamCalls > 0) {
    dst.streamCalls += src.streamCalls;
    dst.streamSumSec += src.streamSumSec;
    dst.streamOutputTokens += src.streamOutputTokens;
  }
}

function finalizeTtftAgg(agg) {
  return {
    ttftCalls: agg?.ttftCalls || 0,
    avgTtftSec: agg?.ttftCalls > 0 ? +(agg.ttftSumSec / agg.ttftCalls).toFixed(2) : null,
    lastTtftSec: agg?.lastTtftSec ?? null,
    minTtftSec: agg?.minTtftSec ?? null,
    maxTtftSec: agg?.maxTtftSec ?? null,
    streamTokPerSec: agg?.streamSumSec > 0 ? +(agg.streamOutputTokens / agg.streamSumSec).toFixed(1) : null,
  };
}

function collectTtftByDisplay(backfills, liveLabels) {
  const byDisplay = new Map();
  const overall = emptyTtftAgg();
  for (const bf of backfills) {
    if (!bf) continue;
    mergeTtftAgg(overall, bf.overallTiming);
    for (const [rawSlug, tm] of Object.entries(bf.timingByModel || {})) {
      const disp = formatModelName(rawSlug, liveLabels);
      if (!byDisplay.has(disp)) byDisplay.set(disp, emptyTtftAgg());
      mergeTtftAgg(byDisplay.get(disp), tm);
    }
  }
  return { byDisplay, overall };
}

function resolveAccountAt(tsMs, timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0 || !Number.isFinite(tsMs) || tsMs < timeline[0].atMs) {
    return 'unattributed';
  }
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid].atMs <= tsMs) lo = mid;
    else hi = mid - 1;
  }
  return timeline[lo].email || 'unattributed';
}

function formatBreakdownList(usageMap, { customPricing = {}, liveLabels = null, dateKey = formatLocalDateKey(), ttftByDisplay = null } = {}) {
  const merged = new Map();
  for (const [slug, st] of Object.entries(usageMap || {})) {
    const model = formatModelName(slug, liveLabels);
    const pricing = resolveModelPricing(slug, customPricing, dateKey);
    const cost = computeBucketCost(st, slug, customPricing, dateKey);
    const existing = merged.get(model);
    if (existing) {
      mergeIntoBucket(existing, st);
      existing.mainCalls += st.mainCalls ?? st.calls ?? 0;
      existing.sideQuestionCalls += st.sideQuestionCalls ?? 0;
      existing.subagentCalls += st.subagentCalls ?? 0;
      existing.cost += cost;
      existing.priced = existing.priced || Boolean(pricing);
      if (st.lastSpeedTokPerSec != null) existing.lastSpeedTokPerSec = st.lastSpeedTokPerSec;
    } else {
      merged.set(model, {
        ...cloneModelBucket(st),
        slug,
        model,
        family: resolvePricingFamily(slug),
        priced: Boolean(pricing),
        mainCalls: st.mainCalls ?? st.calls ?? 0,
        sideQuestionCalls: st.sideQuestionCalls ?? 0,
        subagentCalls: st.subagentCalls ?? 0,
        cost,
      });
    }
  }
  return [...merged.values()]
    .map((m) => ({
      slug: m.slug,
      model: m.model,
      family: m.family,
      priced: m.priced,
      calls: m.calls,
      mainCalls: m.mainCalls,
      sideQuestionCalls: m.sideQuestionCalls,
      subagentCalls: m.subagentCalls,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      outputTokens: m.outputTokens,
      cost: m.cost,
      ...computeRateMetrics(m),
      ...finalizeTtftAgg(ttftByDisplay?.get(m.model)),
    }))
    .sort((a, b) => b.calls - a.calls || b.cost - a.cost);
}

/** Shared accumulator for combining main + side-question + subagent model/token/cost/timing totals. */
function createUsageAccumulator(customPricing, dateKey) {
  const combinedModels = {};
  const acc = {
    combinedModels,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    timedCalls: 0,
    timedOutputTokens: 0,
    timedDurationSec: 0,
    cost: 0,
    unpricedCalls: 0,
    add({ calls = 0, inputTokens = 0, cacheReadTokens = 0, outputTokens = 0, resolved, isMain = false, isSideQuestion = false }) {
      let partCost = 0;
      for (const [mSlug, mStats] of Object.entries(resolved?.modelUsage || {})) {
        partCost += computeBucketCost(mStats, mSlug, customPricing, dateKey);
        if (!resolveModelPricing(mSlug, customPricing, dateKey)) acc.unpricedCalls += mStats.calls;
        const cm = (combinedModels[mSlug] ||= { ...emptyModelBucket(), mainCalls: 0, sideQuestionCalls: 0, subagentCalls: 0 });
        mergeIntoBucket(cm, mStats);
        if (isMain) cm.mainCalls += mStats.calls;
        else if (isSideQuestion) cm.sideQuestionCalls += mStats.calls;
        else cm.subagentCalls += mStats.calls;
        if (mStats.lastSpeedTokPerSec != null && (isMain || cm.lastSpeedTokPerSec == null)) {
          cm.lastSpeedTokPerSec = mStats.lastSpeedTokPerSec;
        }
      }
      acc.calls += calls;
      acc.inputTokens += inputTokens;
      acc.cacheReadTokens += cacheReadTokens;
      acc.outputTokens += outputTokens;
      acc.timedCalls += resolved?.timedCalls || 0;
      acc.timedOutputTokens += resolved?.timedOutputTokens || 0;
      acc.timedDurationSec += resolved?.timedDurationSec || 0;
      acc.cost += partCost;
      return partCost;
    },
  };
  return acc;
}

// ── Detail State & Incremental Parser ──

function emptyStepCounts() {
  return { total: 0, maxStep: 0, user: 0, planner: 0, tool: 0, system: 0, checkpoint: 0, error: 0, sinceCheckpoint: 0, sinceCheckpointCalls: 0 };
}

function emptyWindowContent() {
  return { userChars: 0, assistantChars: 0, thinkingChars: 0, toolCallsChars: 0, toolResultChars: 0, toolResultByTool: {}, checkpointChars: 0, systemChars: 0, errorChars: 0 };
}

function createTurnRecord(turn, stepIdx, ts, prompt, startCtx) {
  return {
    turn,
    startStep: stepIdx,
    endStep: stepIdx,
    ts: ts || '',
    prompt: prompt || '',
    plannerCalls: 0,
    toolExecs: 0,
    checkpoints: 0,
    errors: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    startContextTokens: startCtx || 0,
    endContextTokens: startCtx || 0,
    steps: [],
  };
}

function emptyDetailState() {
  return {
    byteOffset: 0,
    mtimeMs: 0,
    size: 0,
    turns: 0,
    calls: 0,
    checkpoints: 0,
    errorsCount: 0,
    stepCounts: emptyStepCounts(),
    lastModel: '',
    lastContextTokens: 0,
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    timedCalls: 0,
    timedOutputTokens: 0,
    timedDurationSec: 0,
    lastSpeedTokPerSec: null,
    pendingPlanner: null,
    pendingToolQueue: [],
    pendingCheckpointStep: null,
    windowContent: emptyWindowContent(),
    recentTurns: [],
    currentTurn: null,
    toolCounts: {},
    modelUsage: {},
    callEvents: [],
    unknownSteps: [],
    contextPoints: [],
    errors: [],
    firstTs: '',
    lastTs: '',
    lastUserPrompt: '',
    lastCheckpointTs: '',
    lastCheckpointBeforeTokens: 0,
    lastCheckpointAfterTokens: 0,
    pendingCheckpoint: false,
  };
}

function ensureCurrentTurn(st, ts, stepIdx) {
  if (!st.currentTurn) {
    st.currentTurn = createTurnRecord(st.turns || 1, stepIdx, ts, '', st.lastContextTokens);
    st.recentTurns.push(st.currentTurn);
    if (st.recentTurns.length > 30) st.recentTurns.shift();
  }
  return st.currentTurn;
}

function pushTurnStep(st, stepEntry) {
  const t = ensureCurrentTurn(st, stepEntry.ts, stepEntry.step);
  if (stepEntry.step > t.endStep) t.endStep = stepEntry.step;
  if (t.steps.length < 120) t.steps.push(stepEntry);
}

function settlePendingPlanner(target, header) {
  const pending = target.pendingPlanner;
  if (!pending) return 0;
  target.pendingPlanner = null;

  // Never attribute wall-clock time across a user reply boundary
  if (header.type === 'USER_INPUT' || !header.ts) return 0;
  const nextMs = Date.parse(header.ts);
  if (!Number.isFinite(nextMs) || !Number.isFinite(pending.tsMs)) return 0;

  const dtSec = (nextMs - pending.tsMs) / 1000;
  const maxAllowed = pending.outputTokens >= 5000 ? MAX_LONG_GEN_DURATION_SEC : MAX_VALID_CALL_DURATION_SEC;
  if (dtSec <= 0 || dtSec > maxAllowed) return 0;
  // Filter obvious rate-limit retry backoffs (>90s for tiny <500 token output)
  if (dtSec > 90 && pending.outputTokens < 500) return 0;

  if (pending.unknownEntry) pending.unknownEntry.dtSec = dtSec;
  if (pending.callEvent) pending.callEvent.dtSec = dtSec;
  const speed = pending.outputTokens > 0 ? +(pending.outputTokens / dtSec).toFixed(1) : null;
  if (pending.stepEntry) {
    pending.stepEntry.dtSec = +dtSec.toFixed(1);
    pending.stepEntry.speedTokPerSec = speed;
  }

  recordTimedSample(target, pending.outputTokens, dtSec, speed);
  recordTimedSample(target.modelUsage[pending.bucketKey], pending.outputTokens, dtSec, speed);
  return dtSec;
}

function applyLineToDetail(st, line) {
  if (!line) return;
  const header = parseLineHeader(line);
  if (st.pendingPlanner) settlePendingPlanner(st, header);

  st.stepCounts.total++;
  st.stepCounts.sinceCheckpoint++;
  if (header.stepIdx > st.stepCounts.maxStep) st.stepCounts.maxStep = header.stepIdx;

  // Fast-path byte accounting for GENERIC (tool outputs) & SYSTEM_MESSAGE without JSON.parse
  if (header.type !== 'PLANNER_RESPONSE' && header.type !== 'USER_INPUT' && header.type !== 'ERROR_MESSAGE' && header.type !== 'CHECKPOINT') {
    const approxChars = Math.max(0, line.length - 120);
    if (header.type === 'GENERIC') {
      st.stepCounts.tool++;
      if (st.currentTurn) st.currentTurn.toolExecs++;
      st.windowContent.toolResultChars += approxChars;
      const toolName = st.pendingToolQueue.length > 0 ? st.pendingToolQueue.shift() : 'tool_output';
      st.windowContent.toolResultByTool[toolName] = (st.windowContent.toolResultByTool[toolName] || 0) + approxChars;
    } else if (header.type === 'SYSTEM_MESSAGE') {
      st.stepCounts.system++;
      st.windowContent.systemChars += approxChars;
    }
    return;
  }

  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = o.created_at || header.ts || '';
  const stepIdx = Number(o.step_index) || header.stepIdx || st.stepCounts.maxStep || st.stepCounts.total;
  if (stepIdx > st.stepCounts.maxStep) st.stepCounts.maxStep = stepIdx;
  if (ts) {
    if (!st.firstTs || ts < st.firstTs) st.firstTs = ts;
    if (!st.lastTs || ts > st.lastTs) st.lastTs = ts;
  }

  if (o.type === 'USER_INPUT') {
    st.turns++;
    st.stepCounts.user++;
    st.pendingToolQueue.length = 0;
    const promptSnippet = extractUserPrompt(o.content);
    if (typeof o.content === 'string') st.windowContent.userChars += o.content.length;
    if (promptSnippet) st.lastUserPrompt = promptSnippet;
    st.currentTurn = createTurnRecord(st.turns, stepIdx, ts, promptSnippet, st.lastContextTokens);
    st.recentTurns.push(st.currentTurn);
    if (st.recentTurns.length > 30) st.recentTurns.shift();
    return;
  }

  if (o.type === 'CHECKPOINT') {
    st.checkpoints++;
    st.stepCounts.checkpoint++;
    st.stepCounts.sinceCheckpoint = 1;
    st.stepCounts.sinceCheckpointCalls = 0;
    st.lastCheckpointTs = ts;
    st.lastCheckpointBeforeTokens = st.lastContextTokens;
    st.pendingCheckpoint = true;
    st.pendingToolQueue.length = 0;
    st.windowContent = emptyWindowContent();
    st.windowContent.checkpointChars = typeof o.content === 'string' ? o.content.length : 0;
    const cpEntry = { step: stepIdx, turn: st.turns || 1, type: 'CHECKPOINT', ts, beforeTokens: st.lastContextTokens, afterTokens: 0, snippet: '' };
    st.pendingCheckpointStep = cpEntry;
    ensureCurrentTurn(st, ts, stepIdx).checkpoints++;
    pushTurnStep(st, cpEntry);
    return;
  }

  if (o.type === 'ERROR_MESSAGE') {
    st.errorsCount++;
    st.stepCounts.error++;
    const msg = String(o.error || o.content || 'Unknown error').trim();
    st.windowContent.errorChars += msg.length;
    st.errors.push({ step: stepIdx, ts, message: msg.slice(0, 800) });
    if (st.errors.length > 60) st.errors.shift();
    ensureCurrentTurn(st, ts, stepIdx).errors++;
    pushTurnStep(st, { step: stepIdx, turn: st.turns || 1, type: 'ERROR_MESSAGE', ts, snippet: msg.replace(/\s+/g, ' ').slice(0, 320) });
    return;
  }

  if (o.type === 'PLANNER_RESPONSE') {
    st.calls++;
    st.stepCounts.planner++;
    st.stepCounts.sinceCheckpointCalls++;
    const inTok = Number(o.input_tokens) || 0;
    const cacheTok = Number(o.cache_read_tokens) || 0;
    const outTok = Number(o.output_tokens) || 0;
    const ctxTok = inTok + cacheTok + outTok;
    const prevCtx = st.lastContextTokens;

    if (typeof o.content === 'string') st.windowContent.assistantChars += o.content.length;
    if (typeof o.thinking === 'string') st.windowContent.thinkingChars += o.thinking.length;

    st.totalInputTokens += inTok;
    st.totalCacheReadTokens += cacheTok;
    st.totalOutputTokens += outTok;
    st.lastInputTokens = inTok;
    st.lastCacheReadTokens = cacheTok;
    st.lastOutputTokens = outTok;

    let wasAfterCp = false;
    if (ctxTok > 0) {
      wasAfterCp = st.pendingCheckpoint;
      if (wasAfterCp) {
        st.lastCheckpointAfterTokens = inTok + cacheTok;
        if (st.pendingCheckpointStep) {
          st.pendingCheckpointStep.afterTokens = inTok + cacheTok;
          st.pendingCheckpointStep = null;
        }
        st.pendingCheckpoint = false;
      }
      st.lastContextTokens = ctxTok;
      st.contextPoints.push({
        step: stepIdx,
        turn: st.turns || 1,
        ts,
        contextTokens: ctxTok,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        afterCheckpoint: wasAfterCp,
      });
      if (st.contextPoints.length > 400) {
        const half = Math.floor(st.contextPoints.length / 2);
        st.contextPoints = [
          ...st.contextPoints.slice(0, half).filter((pt, idx) => idx % 2 === 0 || pt.afterCheckpoint),
          ...st.contextPoints.slice(half),
        ];
      }
    }

    const modelKey = String(o.model || st.lastModel || '').trim();
    if (modelKey) st.lastModel = modelKey;
    const bucketKey = modelKey || 'unknown';
    const tsMs = ts ? Date.parse(ts) : NaN;
    const dKey = Number.isFinite(tsMs) ? formatLocalDateKey(new Date(tsMs)) : formatLocalDateKey();
    recordBucketCall((st.modelUsage[bucketKey] ||= emptyModelBucket()), inTok, cacheTok, outTok, 0, dKey);

    const callEvent = {
      step: stepIdx,
      tsMs: Number.isFinite(tsMs) ? tsMs : 0,
      dateKey: dKey,
      modelSlug: bucketKey,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      dtSec: 0,
    };
    st.callEvents.push(callEvent);

    let unknownEntry = null;
    if (bucketKey === 'unknown') {
      unknownEntry = { step: stepIdx, dateKey: dKey, inputTokens: inTok, cacheReadTokens: cacheTok, outputTokens: outTok, dtSec: 0 };
      st.unknownSteps.push(unknownEntry);
    }

    const hasTools = Array.isArray(o.tool_calls) && o.tool_calls.length > 0;
    const stepTools = [];
    const stepToolCalls = [];
    st.pendingToolQueue.length = 0;
    if (hasTools) {
      for (const tc of o.tool_calls) {
        const name = String(tc?.name || '').trim();
        if (!name) continue;
        stepTools.push(name);
        if (stepToolCalls.length < 12) {
          const arg = summarizeToolCallArg(tc.args);
          stepToolCalls.push(arg ? { name, arg } : { name });
        }
        st.pendingToolQueue.push(name);
        st.toolCounts[name] = (st.toolCounts[name] || 0) + 1;
        try { st.windowContent.toolCallsChars += name.length + (tc.args ? JSON.stringify(tc.args).length : 0); } catch { /* ignore */ }
      }
    }

    const cleanReply = typeof o.content === 'string' ? o.content.trim().replace(/\s+/g, ' ') : '';
    const cleanThink = typeof o.thinking === 'string' ? o.thinking.trim().replace(/\s+/g, ' ') : '';
    const stepEntry = {
      step: stepIdx,
      turn: st.turns || 1,
      type: 'PLANNER_RESPONSE',
      ts,
      dateKey: dKey,
      modelSlug: bucketKey,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      contextTokens: ctxTok,
      contextDelta: prevCtx > 0 && ctxTok > 0 ? ctxTok - prevCtx : 0,
      tools: stepTools,
      toolCalls: stepToolCalls,
      dtSec: null,
      speedTokPerSec: null,
      reply: cleanReply.slice(0, 260),
      thinking: cleanThink.slice(0, 260),
    };
    const curT = ensureCurrentTurn(st, ts, stepIdx);
    curT.plannerCalls++;
    curT.inputTokens += inTok;
    curT.cacheReadTokens += cacheTok;
    curT.outputTokens += outTok;
    if (ctxTok > 0) curT.endContextTokens = ctxTok;
    pushTurnStep(st, stepEntry);

    if (hasTools && Number.isFinite(tsMs)) {
      st.pendingPlanner = { bucketKey, tsMs, outputTokens: outTok, unknownEntry, stepEntry, callEvent };
    }
  }
}

// ── View Builders ──

function buildContextBreakdown(main, mainBf, mainUsed, mainLimit) {
  const cacheReadTokens = main?.lastCacheReadTokens || 0;
  const inputTokens = main?.lastInputTokens || 0;
  const outputTokens = main?.lastOutputTokens || 0;
  const remainingTokens = Math.max(0, mainLimit - mainUsed);
  const lc = mainBf?.latestContext || null;
  const pctOf = (v, denom) => (denom > 0 ? +((v / denom) * 100).toFixed(1) : 0);

  // Path A: Authoritative Antigravity LS tokenBreakdown.groups
  if (lc && Array.isArray(lc.groups) && lc.groups.length > 0) {
    const rawSum = lc.groups.reduce((s, g) => s + (g.tokens || 0), 0);
    const denomUsed = Math.max(mainUsed, rawSum, 1);
    const groups = [...lc.groups]
      .sort((a, b) => b.tokens - a.tokens)
      .map((g) => ({
        key: g.type || g.name,
        name: g.name,
        tokens: g.tokens,
        shareOfUsed: pctOf(g.tokens, denomUsed),
        shareOfLimit: pctOf(g.tokens, mainLimit),
        children: (g.children || []).map((c) => ({ name: c.name, tokens: c.tokens, shareOfUsed: pctOf(c.tokens, denomUsed) })),
      }));
    return {
      source: 'ls',
      totalUsed: mainUsed,
      estimatedTokensUsed: lc.estimatedTokensUsed || rawSum,
      limit: mainLimit,
      cacheReadTokens,
      inputTokens,
      outputTokens,
      remainingTokens,
      toolCount: lc.toolCount || 0,
      groups,
    };
  }

  // Path B: Active-window transcript content analysis (since last compaction) + LS system/tool telemetry
  const wc = main?.windowContent || emptyWindowContent();
  const toTok = (chars) => Math.round((Number(chars) || 0) / 3.6);
  const rawItems = [];

  const toolResTok = toTok(wc.toolResultChars);
  if (toolResTok > 0) {
    const toolChildren = Object.entries(wc.toolResultByTool || {})
      .map(([name, ch]) => ({ name, raw: toTok(ch) }))
      .filter((x) => x.raw > 0)
      .sort((a, b) => b.raw - a.raw)
      .slice(0, 12);
    rawItems.push({ key: 'tool_results', name: 'Tool Results', raw: toolResTok, children: toolChildren });
  }

  const asstChildren = [
    { name: 'Thinking', raw: toTok(wc.thinkingChars) },
    { name: 'Assistant Reply', raw: toTok(wc.assistantChars) },
    { name: 'Tool Call Args', raw: toTok(wc.toolCallsChars) },
  ].filter((c) => c.raw > 0);
  const asstTotal = asstChildren.reduce((s, c) => s + c.raw, 0);
  if (asstTotal > 0) rawItems.push({ key: 'assistant', name: 'Assistant & Thinking', raw: asstTotal, children: asstChildren });

  const cpTok = toTok(wc.checkpointChars);
  if (cpTok > 0) rawItems.push({ key: 'checkpoint', name: 'Compaction Summary', raw: cpTok, children: [] });

  const userTok = toTok(wc.userChars);
  if (userTok > 0) rawItems.push({ key: 'user', name: 'User Messages', raw: userTok, children: [] });

  const sysMsgTok = toTok(wc.systemChars + wc.errorChars);
  if (sysMsgTok > 0) rawItems.push({ key: 'system_messages', name: 'System & Errors', raw: sysMsgTok, children: [] });

  const lsSysTok = toTok(lc?.systemPromptChars || 0);
  const lsToolsTok = toTok(lc?.toolSchemaChars || 0);
  const lsSectionsTok = (lc?.promptSections || []).reduce((s, p) => s + toTok(p.chars), 0);
  const convSum = rawItems.reduce((s, x) => s + x.raw, 0);
  const knownSysOverhead = lsSysTok + lsToolsTok + lsSectionsTok;
  const residualOverhead = Math.max(0, mainUsed - convSum);
  const sysOverheadRaw = knownSysOverhead > 0 ? Math.max(knownSysOverhead, residualOverhead) : residualOverhead;

  if (sysOverheadRaw > 0) {
    const sysChildren = [];
    if (lsSysTok > 0) sysChildren.push({ name: 'System Prompt', raw: lsSysTok });
    if (lsToolsTok > 0) sysChildren.push({ name: `Tool Schemas (${lc?.toolCount || 0})`, raw: lsToolsTok });
    for (const ps of (lc?.promptSections || []).slice(0, 8)) {
      const pt = toTok(ps.chars);
      if (pt > 0) sysChildren.push({ name: ps.title, raw: pt });
    }
    rawItems.push({ key: 'system_tools', name: 'System, Rules & Tools', raw: sysOverheadRaw, children: sysChildren });
  }

  const rawTotal = rawItems.reduce((s, x) => s + x.raw, 0);
  const scale = mainUsed > 0 && rawTotal > 0 ? mainUsed / rawTotal : 1;
  const denomUsed = Math.max(mainUsed, 1);

  const groups = rawItems
    .map((item) => {
      const tokens = Math.round(item.raw * scale);
      const childSum = item.children.reduce((s, c) => s + c.raw, 0);
      const cScale = childSum > 0 ? tokens / childSum : scale;
      return {
        key: item.key,
        name: item.name,
        tokens,
        shareOfUsed: pctOf(tokens, denomUsed),
        shareOfLimit: pctOf(tokens, mainLimit),
        children: item.children
          .map((c) => {
            const ct = Math.round(c.raw * cScale);
            return { name: c.name, tokens: ct, shareOfUsed: pctOf(ct, denomUsed) };
          })
          .filter((c) => c.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens),
      };
    })
    .filter((g) => g.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    source: 'estimated',
    totalUsed: mainUsed,
    estimatedTokensUsed: mainUsed,
    limit: mainLimit,
    cacheReadTokens,
    inputTokens,
    outputTokens,
    remainingTokens,
    toolCount: lc?.toolCount || 0,
    groups,
  };
}

function buildCompactStepView(rawStep, mainBf, liveLabels, customPricing, fallbackDateKey) {
  if (rawStep.type === 'CHECKPOINT') {
    const out = { step: rawStep.step, turn: rawStep.turn, type: 'CHECKPOINT' };
    if (rawStep.ts) out.ts = rawStep.ts;
    if (rawStep.beforeTokens > 0) out.beforeTokens = rawStep.beforeTokens;
    if (rawStep.afterTokens > 0) out.afterTokens = rawStep.afterTokens;
    return out;
  }
  if (rawStep.type !== 'PLANNER_RESPONSE') {
    const out = { step: rawStep.step, turn: rawStep.turn, type: rawStep.type };
    if (rawStep.ts) out.ts = rawStep.ts;
    if (rawStep.snippet) out.snippet = rawStep.snippet;
    return out;
  }

  const info = lookupBackfillStep(mainBf, rawStep.step);
  const slug = rawStep.modelSlug && rawStep.modelSlug !== 'unknown'
    ? rawStep.modelSlug
    : (info?.model || mainBf?.fallbackModel || 'unknown');
  const model = formatModelName(slug, liveLabels);
  const ttftSec = info?.ttftSec > 0 ? +info.ttftSec.toFixed(2) : null;
  const streamSec = info?.streamSec > 0 ? +info.streamSec.toFixed(2) : null;
  const gmDur = (info?.ttftSec || 0) + (info?.streamSec || 0);
  const dtSec = gmDur > 0 && gmDur <= MAX_LONG_GEN_DURATION_SEC ? +gmDur.toFixed(1) : rawStep.dtSec;
  const speedTokPerSec = dtSec > 0 && rawStep.outputTokens > 0 ? +(rawStep.outputTokens / dtSec).toFixed(1) : rawStep.speedTokPerSec;
  const stepCost = computeCost(rawStep, resolveModelPricing(slug, customPricing, rawStep.dateKey || fallbackDateKey));
  const stepInTotal = (rawStep.inputTokens || 0) + (rawStep.cacheReadTokens || 0);
  const cacheHitPercent = stepInTotal > 0 ? +((rawStep.cacheReadTokens / stepInTotal) * 100).toFixed(1) : 0;

  const out = {
    step: rawStep.step,
    turn: rawStep.turn,
    type: 'PLANNER_RESPONSE',
    model,
    inputTokens: rawStep.inputTokens,
    cacheReadTokens: rawStep.cacheReadTokens,
    outputTokens: rawStep.outputTokens,
    contextTokens: rawStep.contextTokens,
    cacheHitPercent,
  };
  if (rawStep.ts) out.ts = rawStep.ts;
  if (rawStep.contextDelta) out.contextDelta = rawStep.contextDelta;
  if (rawStep.toolCalls?.length) out.toolCalls = rawStep.toolCalls;
  // Send full `tools` list only when tool count exceeds the 12-item `toolCalls` cap
  if (rawStep.tools?.length > (rawStep.toolCalls?.length || 0)) out.tools = rawStep.tools;
  if (dtSec > 0) out.dtSec = dtSec;
  if (ttftSec > 0) out.ttftSec = ttftSec;
  if (streamSec > 0) out.streamSec = streamSec;
  if (speedTokPerSec > 0) out.speedTokPerSec = speedTokPerSec;
  if (stepCost > 0) out.cost = stepCost;
  if (rawStep.reply) out.reply = rawStep.reply;
  if (rawStep.thinking) out.thinking = rawStep.thinking;
  return out;
}

function buildRecentTurnsView(main, mainBf, liveLabels, customPricing, fallbackDateKey) {
  const rawTurns = main?.recentTurns || [];
  const out = [];
  for (let i = rawTurns.length - 1; i >= 0; i--) {
    const t = rawTurns[i];
    let cost = 0;
    let timedSec = 0;
    let timedOut = 0;
    let ttftSum = 0;
    let ttftCnt = 0;
    let maxTtftSec = 0;
    let hasSlowStep = false;
    const modelsUsed = new Set();
    const turnToolCounts = new Map();
    const callSigCounts = new Map();
    let streakTool = '';
    let streakCount = 0;
    let hasToolLoop = false;

    const steps = [];
    if (t.prompt || t.startStep) {
      const userStep = { step: t.startStep, turn: t.turn, type: 'USER_INPUT' };
      if (t.ts) userStep.ts = t.ts;
      if (t.prompt) userStep.snippet = t.prompt;
      steps.push(userStep);
    }

    for (const rawStep of t.steps || []) {
      const s = buildCompactStepView(rawStep, mainBf, liveLabels, customPricing, fallbackDateKey);
      if (s.type === 'PLANNER_RESPONSE') {
        if (s.model && s.model !== 'Unknown Model') modelsUsed.add(s.model);
        if (s.cost > 0) cost += s.cost;
        if (s.dtSec > 0) {
          timedSec += s.dtSec;
          timedOut += s.outputTokens || 0;
          if (s.dtSec >= 60) hasSlowStep = true;
        }
        if (s.ttftSec > 0) {
          ttftSum += s.ttftSec;
          ttftCnt++;
          if (s.ttftSec > maxTtftSec) maxTtftSec = s.ttftSec;
          if (s.ttftSec >= 25) hasSlowStep = true;
        }
        const tools = Array.isArray(rawStep.tools) ? rawStep.tools : [];
        for (const tn of tools) {
          turnToolCounts.set(tn, (turnToolCounts.get(tn) || 0) + 1);
        }
        for (const tc of rawStep.toolCalls || []) {
          if (!tc?.name || !tc?.arg || tc.name === 'edit_file' || tc.name === 'multi_replace_file_content') continue;
          const sig = `${tc.name}|${tc.arg}`;
          const sigCnt = (callSigCounts.get(sig) || 0) + 1;
          callSigCounts.set(sig, sigCnt);
          if (sigCnt >= 3) hasToolLoop = true;
        }
        if (tools.length === 1 && tools[0] !== 'edit_file') {
          if (tools[0] === streakTool) {
            streakCount++;
            if (streakCount >= 5) hasToolLoop = true;
          } else {
            streakTool = tools[0];
            streakCount = 1;
          }
        } else {
          streakTool = '';
          streakCount = 0;
        }
      }
      steps.push(s);
    }

    const promptTotal = (t.inputTokens || 0) + (t.cacheReadTokens || 0);
    const cacheHitPercent = promptTotal > 0 ? +((t.cacheReadTokens / promptTotal) * 100).toFixed(1) : 0;
    const signals = [];
    if (hasSlowStep) signals.push('slow');
    if (!t.checkpoints && promptTotal >= 30_000 && cacheHitPercent < 40) signals.push('cache_drop');
    if (hasToolLoop) signals.push('loop');

    const topTools = [...turnToolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, count }));

    const lastStep = steps[steps.length - 1] || null;
    const lastTs = lastStep?.ts || t.ts || '';
    out.push({
      turn: t.turn,
      startStep: t.startStep,
      endStep: t.endStep,
      ts: t.ts,
      lastTs,
      prompt: t.prompt || '',
      plannerCalls: t.plannerCalls,
      toolExecs: t.toolExecs,
      checkpoints: t.checkpoints,
      errors: t.errors,
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      outputTokens: t.outputTokens,
      cacheHitPercent,
      startContextTokens: t.startContextTokens,
      endContextTokens: t.endContextTokens,
      contextDelta: t.startContextTokens > 0 && t.endContextTokens > 0 ? t.endContextTokens - t.startContextTokens : 0,
      cost,
      avgSpeedTokPerSec: timedSec > 0 ? +(timedOut / timedSec).toFixed(1) : null,
      avgTtftSec: ttftCnt > 0 ? +(ttftSum / ttftCnt).toFixed(2) : null,
      maxTtftSec: maxTtftSec > 0 ? +maxTtftSec.toFixed(2) : null,
      totalDurationSec: Math.round(timedSec),
      models: [...modelsUsed],
      topTools,
      signals,
      steps,
    });
  }
  return out;
}

function inferPoolCycleWindow(pool, nowMs) {
  const winSrc = pool?.fiveHour?.resetTime ? pool.fiveHour : pool;
  const resetMs = winSrc?.resetTime ? Date.parse(winSrc.resetTime) : NaN;
  if (!Number.isFinite(resetMs)) return null;
  if (resetMs <= nowMs) {
    return {
      poolKey: pool.poolKey,
      startMs: resetMs,
      endMs: resetMs + FIVE_HOURS_MS,
      periodHours: 5,
      source: 'reset_passed',
      remainingPercent: 100,
    };
  }
  const remMs = resetMs - nowMs;
  const isFiveHour = Boolean(pool?.fiveHour?.resetTime) || remMs <= 5.5 * 3600_000;
  const durationMs = isFiveHour ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
  return {
    poolKey: pool.poolKey,
    startMs: resetMs - durationMs,
    endMs: resetMs,
    periodHours: isFiveHour ? 5 : 168,
    source: 'quota_pool',
    remainingPercent: winSrc?.remainingPercent ?? pool?.remainingPercent ?? null,
  };
}

function recordCycleTtftSample(agg, ttftSec, streamSec, outTok) {
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

function buildActiveCycleBreakdown({
  sources,
  resetPools = [],
  customPricing = {},
  liveLabels = null,
  fallbackDateKey = formatLocalDateKey(),
  mainModelRaw = '',
  mainModelName = '',
  nowMs = Date.now(),
}) {
  const poolWindows = new Map();
  for (const p of Array.isArray(resetPools) ? resetPools : []) {
    const win = inferPoolCycleWindow(p, nowMs);
    if (win && win.poolKey) poolWindows.set(win.poolKey, win);
  }
  const fallbackStartMs = nowMs - FIVE_HOURS_MS;
  const activeModels = {};
  const ttftByDisplay = new Map();
  const matchedPools = new Set();
  let calls = 0;
  let cost = 0;
  let timedDurationSec = 0;
  let latestPoolKey = '';
  let latestTsMs = 0;

  for (const { detail, backfill, isMain, isSideQuestion } of sources) {
    if (!detail?.callEvents?.length) continue;
    for (const ev of detail.callEvents) {
      if (!(ev.tsMs > 0)) continue;
      const info = lookupBackfillStep(backfill, ev.step);
      const slug = ev.modelSlug && ev.modelSlug !== 'unknown'
        ? ev.modelSlug
        : (info?.model || backfill?.fallbackModel || 'unknown');
      const disp = formatModelName(slug, liveLabels);
      const poolKey = resolveQuotaPool(slug, disp);
      const win = poolWindows.get(poolKey);
      const startMs = win ? win.startMs : fallbackStartMs;
      const endMs = win ? win.endMs : nowMs;
      if (ev.tsMs < startMs || ev.tsMs > endMs + 60_000) continue;

      matchedPools.add(poolKey);
      if (ev.tsMs >= latestTsMs) {
        latestTsMs = ev.tsMs;
        latestPoolKey = poolKey;
      }

      const cwTok = info?.cacheCreationTokens || 0;
      const dKey = ev.dateKey || fallbackDateKey;
      const bucket = (activeModels[slug] ||= { ...emptyModelBucket(), mainCalls: 0, sideQuestionCalls: 0, subagentCalls: 0 });
      recordBucketCall(bucket, ev.inputTokens, ev.cacheReadTokens, ev.outputTokens, cwTok, dKey);
      if (isMain) bucket.mainCalls++;
      else if (isSideQuestion) bucket.sideQuestionCalls++;
      else bucket.subagentCalls++;

      const dur = pickStepDurationSec(info, ev.dtSec);
      if (dur > 0) {
        const sp = ev.outputTokens > 0 ? +(ev.outputTokens / dur).toFixed(1) : null;
        recordTimedSample(bucket, ev.outputTokens, dur, sp);
        timedDurationSec += dur;
      }

      if (info && (info.ttftSec > 0 || info.streamSec > 0)) {
        if (!ttftByDisplay.has(disp)) ttftByDisplay.set(disp, emptyTtftAgg());
        recordCycleTtftSample(ttftByDisplay.get(disp), info.ttftSec || 0, info.streamSec || 0, ev.outputTokens);
      }

      calls++;
      cost += computeCost(
        {
          inputTokens: ev.inputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          cacheCreationTokens: cwTok,
          outputTokens: ev.outputTokens,
        },
        resolveModelPricing(slug, customPricing, dKey),
      );
    }
  }

  const breakdown = formatBreakdownList(activeModels, {
    customPricing,
    liveLabels,
    dateKey: fallbackDateKey,
    ttftByDisplay,
  });

  const primaryPoolKey = latestPoolKey
    || (mainModelRaw || mainModelName ? resolveQuotaPool(mainModelRaw, mainModelName) : '')
    || (poolWindows.has('gemini') ? 'gemini' : [...poolWindows.keys()][0] || 'gemini');
  const primaryWin = poolWindows.get(primaryPoolKey) || null;

  return {
    activeModelBreakdown: breakdown,
    activeCycle: {
      source: primaryWin ? primaryWin.source : 'fallback_5h',
      poolKey: primaryPoolKey,
      matchedPools: [...matchedPools],
      periodHours: primaryWin ? primaryWin.periodHours : 5,
      startTs: new Date(primaryWin ? primaryWin.startMs : fallbackStartMs).toISOString(),
      endTs: primaryWin ? new Date(primaryWin.endMs).toISOString() : '',
      remainingPercent: primaryWin?.remainingPercent ?? null,
      modelCount: breakdown.length,
      calls,
      cost,
      totalDurationSec: Math.round(timedDurationSec),
      pools: [...poolWindows.values()].map((w) => ({
        poolKey: w.poolKey,
        periodHours: w.periodHours,
        startTs: new Date(w.startMs).toISOString(),
        endTs: new Date(w.endMs).toISOString(),
        remainingPercent: w.remainingPercent,
      })),
    },
  };
}

async function readLinesFromOffset(fp, startOffset, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(fp, { encoding: 'utf8', start: startOffset, highWaterMark: 256 * 1024 }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) onLine(line);
}

// ── Main Analyzer Class ──

export class TranscriptAnalyzer {
  constructor(brainDir = path.join(getAppDataDir(), 'brain')) {
    this.brainDir = brainDir;
    this._detailCache = new Map(); // bounded LRU (max 24)
    this._detailInflight = new Map(); // dedup concurrent incremental parses of the same file
    this._subDescCache = new Map(); // subagent descriptor dir cache keyed by rootId + mtimeMs
    this._sessionViewCache = new Map(); // memoized buildSessionView payload (bounded LRU max 4)
    this._summaryCache = new Map(); // compact per-conv summary keyed by convId
    this._summaryInflight = new Map(); // dedup concurrent summary parses of the same file
    this._usageCache = new Map(); // memoized aggregateUsage keyed by (days, fingerprint, pricing, timeline, backfillVer)
    this._usageBackfillVer = 0;
    this._bgBackfillInflight = null;
    this._bgBackfillAttempted = new Set();
  }

  scheduleBackgroundBackfill(ids, resolveBackfill) {
    if (!resolveBackfill || !ids.length || this._bgBackfillInflight) return;
    const fresh = ids.filter((id) => !this._bgBackfillAttempted.has(id)).slice(0, 25);
    if (!fresh.length) return;
    for (const id of fresh) this._bgBackfillAttempted.add(id);
    if (this._bgBackfillAttempted.size > 2000) this._bgBackfillAttempted.clear();
    this._bgBackfillInflight = fetchBackfillsInBatches(fresh, resolveBackfill, 5)
      .then((fetched) => {
        if (fetched.size > 0) this._usageBackfillVer++;
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        this._bgBackfillInflight = null;
      });
  }

  /** Incrementally parse a single conversation's transcript.jsonl (<1 ms warm refresh). */
  async getConversationDetail(convId) {
    if (!isValidConvId(convId)) return null;
    const fp = transcriptPathOf(this.brainDir, convId);
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch {
      return null;
    }

    let st = this._detailCache.get(convId);
    if (st && st.mtimeMs === stat.mtimeMs && st.size === stat.size) {
      this._detailCache.delete(convId);
      this._detailCache.set(convId, st);
      return st;
    }

    const inflightKey = `${convId}|${stat.mtimeMs}|${stat.size}`;
    if (this._detailInflight.has(inflightKey)) return this._detailInflight.get(inflightKey);

    const task = (async () => {
      if (!st || stat.size < st.byteOffset) st = emptyDetailState();
      await readLinesFromOffset(fp, st.byteOffset, (line) => applyLineToDetail(st, line));
      st.byteOffset = stat.size;
      st.mtimeMs = stat.mtimeMs;
      st.size = stat.size;

      this._detailCache.delete(convId);
      this._detailCache.set(convId, st);
      while (this._detailCache.size > 24) {
        this._detailCache.delete(this._detailCache.keys().next().value);
      }
      return st;
    })();

    this._detailInflight.set(inflightKey, task);
    try {
      return await task;
    } finally {
      this._detailInflight.delete(inflightKey);
    }
  }

  /** Public cached compact summary (including per-model usage & speed) for fast multi-session lists. */
  async getConversationSummary(convId, accountTimeline = null) {
    if (!isValidConvId(convId)) return null;
    const fp = transcriptPathOf(this.brainDir, convId);
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch {
      return null;
    }
    const tl = Array.isArray(accountTimeline) ? accountTimeline : [];
    return this._getCompactSummary(convId, fp, stat, tl, formatTimelineSig(tl));
  }

  /** Summarize one conversation into per-local-day, per-account & session-wide per-model aggregates. */
  async _getCompactSummary(convId, fp, stat, accountTimeline = [], timelineSig = '') {
    const cached = this._summaryCache.get(convId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (!timelineSig || cached.timelineSig === timelineSig)) {
      return cached;
    }
    const inflightKey = `${convId}|${stat.mtimeMs}|${stat.size}|${timelineSig}`;
    if (this._summaryInflight.has(inflightKey)) return this._summaryInflight.get(inflightKey);

    const task = (async () => {
      const byDate = {};
      const modelUsage = {};
      const unknownSteps = [];
      const timingCtx = { timedCalls: 0, timedOutputTokens: 0, timedDurationSec: 0, lastSpeedTokPerSec: null, pendingPlanner: null, modelUsage };
      let lastModel = '';
      let lastContextTokens = 0;
      let totalCalls = 0;
      let totalTurns = 0;
      let totalInput = 0;
      let totalCache = 0;
      let totalOutput = 0;
      let firstTs = '';
      let lastTs = '';
      let lastUserPrompt = '';

      await readLinesFromOffset(fp, 0, (line) => {
        if (!line) return;
        const header = parseLineHeader(line);
        if (timingCtx.pendingPlanner) {
          const pending = timingCtx.pendingPlanner;
          const dtSec = settlePendingPlanner(timingCtx, header);
          if (dtSec > 0 && pending.dateKey) {
            recordTimedSample(byDate[pending.dateKey]?.byModel?.[pending.bucketKey], pending.outputTokens, dtSec, timingCtx.lastSpeedTokPerSec);
            recordTimedSample(byDate[pending.dateKey]?.byAccount?.[pending.account]?.byModel?.[pending.bucketKey], pending.outputTokens, dtSec);
          }
        }

        if (header.type !== 'PLANNER_RESPONSE' && header.type !== 'USER_INPUT' && header.type !== 'ERROR_MESSAGE') return;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }

        const ts = o.created_at || header.ts || '';
        const tsMs = ts ? Date.parse(ts) : stat.mtimeMs;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
        const dKey = formatLocalDateKey(new Date(Number.isFinite(tsMs) ? tsMs : stat.mtimeMs));
        const acct = resolveAccountAt(tsMs, accountTimeline);
        const day = (byDate[dKey] ||= { calls: 0, turns: 0, errors: 0, byModel: {}, byAccount: {} });
        const acctDay = (day.byAccount[acct] ||= { calls: 0, turns: 0, errors: 0, byModel: {} });

        if (o.type === 'USER_INPUT') {
          day.turns++;
          acctDay.turns++;
          totalTurns++;
          const prompt = extractUserPrompt(o.content);
          if (prompt) lastUserPrompt = prompt;
          return;
        }
        if (o.type === 'ERROR_MESSAGE') {
          day.errors++;
          acctDay.errors++;
          return;
        }
        if (o.type === 'PLANNER_RESPONSE') {
          const inTok = Number(o.input_tokens) || 0;
          const cacheTok = Number(o.cache_read_tokens) || 0;
          const outTok = Number(o.output_tokens) || 0;
          const mKey = String(o.model || lastModel || 'unknown').trim();
          if (o.model) lastModel = String(o.model).trim();
          if (inTok + cacheTok + outTok > 0) lastContextTokens = inTok + cacheTok + outTok;

          day.calls++;
          acctDay.calls++;
          totalCalls++;
          totalInput += inTok;
          totalCache += cacheTok;
          totalOutput += outTok;

          recordBucketCall((day.byModel[mKey] ||= emptyModelBucket()), inTok, cacheTok, outTok);
          recordBucketCall((acctDay.byModel[mKey] ||= emptyModelBucket()), inTok, cacheTok, outTok);
          recordBucketCall((modelUsage[mKey] ||= emptyModelBucket()), inTok, cacheTok, outTok, 0, dKey);

          let unknownEntry = null;
          if (mKey === 'unknown') {
            unknownEntry = { step: Number(o.step_index) || 0, dateKey: dKey, account: acct, inputTokens: inTok, cacheReadTokens: cacheTok, outputTokens: outTok, dtSec: 0 };
            unknownSteps.push(unknownEntry);
          }

          if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0 && ts && Number.isFinite(tsMs)) {
            timingCtx.pendingPlanner = { bucketKey: mKey, dateKey: dKey, account: acct, tsMs, outputTokens: outTok, unknownEntry };
          }
        }
      });

      const entry = {
        convId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        timelineSig,
        lastModel,
        lastContextTokens,
        totalCalls,
        totalTurns,
        totalInput,
        totalCache,
        totalOutput,
        timedCalls: timingCtx.timedCalls,
        timedOutputTokens: timingCtx.timedOutputTokens,
        timedDurationSec: timingCtx.timedDurationSec,
        lastSpeedTokPerSec: timingCtx.lastSpeedTokPerSec,
        firstTs,
        lastTs,
        lastUserPrompt,
        modelUsage,
        unknownSteps,
        byDate,
      };
      this._summaryCache.set(convId, entry);
      return entry;
    })();

    this._summaryInflight.set(inflightKey, task);
    try {
      return await task;
    } finally {
      this._summaryInflight.delete(inflightKey);
    }
  }

  /** Scan local brain transcripts within `sinceDays` and aggregate daily/account/model/cost totals. */
  async aggregateUsage({
    sinceDays = 31,
    customPricing = {},
    liveLabels = null,
    accountTimeline = [],
    peekBackfill = null,
    resolveBackfill = null,
    force = false,
  } = {}) {
    let entries;
    try {
      entries = fs.readdirSync(this.brainDir);
    } catch {
      return { days: {}, models: [], accountTotals: {}, totals: { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 }, scannedFiles: 0 };
    }

    const timeline = Array.isArray(accountTimeline) ? accountTimeline : [];
    const timelineSig = formatTimelineSig(timeline);
    const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0;

    const candidates = [];
    let maxMtime = 0;
    let totalSize = 0;
    for (const id of entries) {
      if (!isValidConvId(id)) continue;
      const fp = transcriptPathOf(this.brainDir, id);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (cutoffMs > 0 && st.mtimeMs < cutoffMs) continue;
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      totalSize += st.size;
      candidates.push({ id, fp, st });
    }
    candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

    const pricingSig = JSON.stringify(customPricing || {});
    const cacheKey = `${sinceDays}|${candidates.length}|${Math.round(maxMtime)}|${totalSize}|${pricingSig}|${timelineSig}|${this._usageBackfillVer}`;
    const cachedUsage = force ? null : this._usageCache.get(cacheKey);
    if (cachedUsage) return cachedUsage;

    const loaded = [];
    const needBackfillIds = [];
    const CONCURRENCY = 12;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const summaries = await Promise.all(
        batch.map(({ id, fp, st }) => this._getCompactSummary(id, fp, st, timeline, timelineSig)),
      );
      for (let j = 0; j < batch.length; j++) {
        const { id, st } = batch[j];
        const summary = summaries[j];
        const bf = summary.unknownSteps?.length > 0 && peekBackfill ? peekBackfill(id) : null;
        if (summary.unknownSteps?.length > 0 && !bf && resolveBackfill && needBackfillIds.length < 25) {
          needBackfillIds.push(id);
        }
        loaded.push({ id, st, summary, bf });
      }
    }

    // Never block HTTP rendering on historical LS backfills; warm asynchronously for next request
    if (needBackfillIds.length > 0) this.scheduleBackgroundBackfill(needBackfillIds, resolveBackfill);

    const days = {};
    const modelAgg = new Map();
    const accountTotals = {};
    const addModelRow = (map, key, mStats, cost) => {
      const row = (map[key] ||= { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 });
      row.calls += mStats.calls;
      row.inputTokens += mStats.inputTokens;
      row.cacheReadTokens += mStats.cacheReadTokens;
      row.outputTokens += mStats.outputTokens;
      row.cost += cost;
    };

    for (const { st, summary, bf } of loaded) {
      const effectiveByDate = applyBackfillToSummaryByDate(summary, bf, formatLocalDateKey(new Date(st.mtimeMs)));

      for (const [dateKey, dayData] of Object.entries(effectiveByDate)) {
        if (sinceDays > 0) {
          const dayTs = Date.parse(`${dateKey}T23:59:59`);
          if (Number.isFinite(dayTs) && dayTs < cutoffMs) continue;
        }
        const target = (days[dateKey] ||= {
          date: dateKey, calls: 0, turns: 0, errors: 0,
          inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0,
          byModel: {}, byAccount: {},
        });
        target.calls += dayData.calls;
        target.turns += dayData.turns;
        target.errors += dayData.errors;

        for (const [modelSlug, mStats] of Object.entries(dayData.byModel)) {
          const pricing = resolveModelPricing(modelSlug, customPricing, dateKey);
          const cost = computeCost(mStats, pricing);
          const displayName = formatModelName(modelSlug, liveLabels);
          const family = resolvePricingFamily(modelSlug) || modelSlug;

          target.inputTokens += mStats.inputTokens;
          target.cacheReadTokens += mStats.cacheReadTokens;
          target.outputTokens += mStats.outputTokens;
          target.cost += cost;
          addModelRow(target.byModel, displayName, mStats, cost);

          const fam = modelAgg.get(family);
          if (fam) {
            mergeIntoBucket(fam, mStats);
            fam.cost += cost;
          } else {
            modelAgg.set(family, {
              ...cloneModelBucket(mStats),
              family,
              name: family === 'unknown' ? 'Unknown Model' : formatFamilyLabel(family),
              cost,
              pricing,
            });
          }
        }

        for (const [acctKey, acctData] of Object.entries(dayData.byAccount || {})) {
          const ta = (target.byAccount[acctKey] ||= {
            calls: 0, turns: 0, errors: 0,
            inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, byModel: {},
          });
          const ga = (accountTotals[acctKey] ||= { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 });
          ta.calls += acctData.calls;
          ta.turns += acctData.turns;
          ta.errors += acctData.errors;
          ga.calls += acctData.calls;

          for (const [modelSlug, mStats] of Object.entries(acctData.byModel || {})) {
            const cost = computeCost(mStats, resolveModelPricing(modelSlug, customPricing, dateKey));
            const displayName = formatModelName(modelSlug, liveLabels);
            for (const dst of [ta, ga]) {
              dst.inputTokens += mStats.inputTokens;
              dst.cacheReadTokens += mStats.cacheReadTokens;
              dst.outputTokens += mStats.outputTokens;
              dst.cost += cost;
            }
            addModelRow(ta.byModel, displayName, mStats, cost);
          }
        }
      }
    }

    const totals = { calls: 0, turns: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 };
    for (const d of Object.values(days)) {
      totals.calls += d.calls;
      totals.turns += d.turns;
      totals.errors += d.errors;
      totals.inputTokens += d.inputTokens;
      totals.cacheReadTokens += d.cacheReadTokens;
      totals.outputTokens += d.outputTokens;
      totals.cost += d.cost;
    }

    const models = [...modelAgg.values()]
      .map((m) => ({ ...m, ...computeRateMetrics(m) }))
      .sort((a, b) => b.cost - a.cost || b.calls - a.calls);
    const result = { days, models, accountTotals, totals, scannedFiles: candidates.length, cacheEntries: this._summaryCache.size };
    this._usageCache.set(cacheKey, result);
    while (this._usageCache.size > 8) {
      this._usageCache.delete(this._usageCache.keys().next().value);
    }
    return result;
  }

  /** Build the full Session Overview payload for a root conversation + all its subagents. */
  async buildSessionView({
    convId,
    convMeta = null,
    childConversations = [],
    customPricing = {},
    liveLabels = null,
    liveLimits = null,
    resetPools = [],
    resolveBackfill = null,
  }) {
    const validChildren = childConversations.filter((c) => c?.id && c.id !== convId);
    const [main, ...childDetails] = await Promise.all([
      this.getConversationDetail(convId),
      ...validChildren.map((c) => this.getConversationDetail(c.id)),
    ]);
    const today = formatLocalDateKey();
    const childEntries = validChildren.map((child, idx) => ({ child, cid: child.id, cd: childDetails[idx] }));

    const needIds = [];
    if (main && main.calls > 0) needIds.push(convId);
    let recentTimingBudget = 24;
    for (const { child, cid, cd } of childEntries) {
      if (!cd || !(cd.calls > 0)) continue;
      if (cd.unknownSteps?.length > 0 || child.isSideQuestion) needIds.push(cid);
      else if (recentTimingBudget-- > 0) needIds.push(cid);
    }
    const backfillMap = await fetchBackfillsInBatches(needIds, resolveBackfill, 8);

    const poolsSig = (resetPools || [])
      .map((p) => `${p.poolKey}:${p.remainingPercent}:${p.resetTime || ''}:${p.fiveHour?.resetTime || ''}:${p.weekly?.resetTime || ''}`)
      .join(',');
    const childSig = childEntries
      .map(({ child, cid, cd }) => `${cid}:${child.isSideQuestion ? 'S' : 'A'}:${child.annotations?.title || ''}:${child.state?.runState || ''}:${cd?.mtimeMs || 0}:${cd?.size || 0}:${backfillMap.get(cid)?.at || 0}`)
      .join('|');
    const sessionKey = [
      convId,
      convMeta?.state?.runState || '',
      convMeta?.annotations?.title || '',
      convMeta?.metadata?.isSideQuestion ? convMeta.metadata.parentConversationId || '1' : '',
      main?.mtimeMs || 0,
      main?.size || 0,
      backfillMap.get(convId)?.at || 0,
      childSig,
      today,
      poolsSig,
      JSON.stringify(customPricing || {}),
    ].join('\x1f');

    const cachedView = this._sessionViewCache.get(sessionKey);
    if (cachedView) {
      this._sessionViewCache.delete(sessionKey);
      this._sessionViewCache.set(sessionKey, cachedView);
      return cachedView;
    }

    let descriptors = readSubagentDescriptors(this.brainDir, convId, this._subDescCache);
    let descriptorsCloned = false;
    for (const { child, cid } of childEntries) {
      if (!child.isSideQuestion) continue;
      const sideDesc = readSubagentDescriptors(this.brainDir, cid, this._subDescCache);
      if (sideDesc.size === 0) continue;
      if (!descriptorsCloned) {
        descriptors = new Map(descriptors);
        descriptorsCloned = true;
      }
      for (const [k, v] of sideDesc) {
        if (!descriptors.has(k)) descriptors.set(k, v);
      }
    }

    const acc = createUsageAccumulator(customPricing, today);
    const combinedTools = {};
    const combinedErrors = [];
    const absorbExtras = (detail, sourceLabel, convKey) => {
      if (!detail) return;
      for (const [tool, count] of Object.entries(detail.toolCounts)) {
        combinedTools[tool] = (combinedTools[tool] || 0) + count;
      }
      for (const e of detail.errors) {
        combinedErrors.push({ ...e, category: classifyErrorCategory(e.message), source: sourceLabel, convId: convKey });
      }
    };

    const mainTitle = convMeta?.annotations?.title || convMeta?.state?.summary || main?.lastUserPrompt || convId;
    const mainResolved = resolveUsageWithBackfill(main, backfillMap.get(convId));
    const mainCost = main
      ? acc.add({
          calls: main.calls,
          inputTokens: main.totalInputTokens,
          cacheReadTokens: main.totalCacheReadTokens,
          outputTokens: main.totalOutputTokens,
          resolved: mainResolved,
          isMain: true,
        })
      : 0;
    absorbExtras(main, mainTitle, convId);

    const subagents = [];
    const sideQuestions = [];
    const sideQuestionIds = new Set();
    const sideChildSubCounts = new Map();
    for (const { child } of childEntries) {
      if (child.parentSideId) {
        sideChildSubCounts.set(child.parentSideId, (sideChildSubCounts.get(child.parentSideId) || 0) + 1);
      }
    }

    for (const { child, cid, cd } of childEntries) {
      const isSide = Boolean(child.isSideQuestion);
      // Skip legacy pre-transcript side chats with no local log & not running so counts match /api/sessions
      if (isSide && !cd && child.state?.runState !== 'RUN_STATE_RUNNING') continue;
      if (isSide) sideQuestionIds.add(cid);
      const desc = isSide ? null : descriptors.get(cid);
      const agentType = isSide ? '' : (desc?.typeName || child.agentName || '');
      const rawTitle =
        desc?.role ||
        (child.annotations?.title && child.annotations.title !== cid ? child.annotations.title : '') ||
        child.agentName ||
        child.state?.summary ||
        cd?.lastUserPrompt ||
        (isSide ? `Side Chat ${cid.slice(0, 8)}` : `Subagent ${cid.slice(0, 8)}`);

      const cBf = backfillMap.get(cid) || null;
      const cResolved = resolveUsageWithBackfill(cd, cBf);
      const cCost = cd
        ? acc.add({
            calls: cd.calls,
            inputTokens: cd.totalInputTokens,
            cacheReadTokens: cd.totalCacheReadTokens,
            outputTokens: cd.totalOutputTokens,
            resolved: cResolved,
            isSideQuestion: isSide,
          })
        : 0;
      absorbExtras(cd, rawTitle, cid);

      const cModelRaw = cResolved.lastModel || '';
      const cModelName = formatModelName(cModelRaw, liveLabels);
      const cUsed = cd?.lastContextTokens || 0;
      const cLimit = resolveContextLimit(cModelRaw || cModelName, liveLimits, cUsed);
      const cTtft = collectTtftByDisplay(cBf ? [cBf] : [], liveLabels);
      const cRates = computeRateMetrics({
        calls: cd?.calls || 0,
        inputTokens: cd?.totalInputTokens || 0,
        cacheReadTokens: cd?.totalCacheReadTokens || 0,
        outputTokens: cd?.totalOutputTokens || 0,
        timedCalls: cResolved.timedCalls || 0,
        timedOutputTokens: cResolved.timedOutputTokens || 0,
        timedDurationSec: cResolved.timedDurationSec || 0,
        lastSpeedTokPerSec: cResolved.lastSpeedTokPerSec ?? null,
      });

      const entry = {
        id: cid,
        title: rawTitle,
        agentType: agentType && agentType.toLowerCase() !== rawTitle.toLowerCase() ? agentType : '',
        runState: child.state?.runState || 'RUN_STATE_IDLE',
        updateTime: child.state?.updateTime || cd?.lastTs || '',
        model: cModelName,
        calls: cd?.calls || 0,
        turns: cd?.turns || 0,
        contextUsed: cUsed,
        contextLimit: cLimit,
        usagePercent: cLimit > 0 ? Math.min(100, (cUsed / cLimit) * 100) : 0,
        inputTokens: cd?.totalInputTokens || 0,
        cacheReadTokens: cd?.totalCacheReadTokens || 0,
        outputTokens: cd?.totalOutputTokens || 0,
        cost: cCost,
        ...cRates,
        ...finalizeTtftAgg(cTtft.overall),
        modelBreakdown: formatBreakdownList(cResolved.modelUsage, { customPricing, liveLabels, dateKey: today, ttftByDisplay: cTtft.byDisplay }),
        toolCount: Object.values(cd?.toolCounts || {}).reduce((a, b) => a + b, 0),
        topTools: Object.entries(cd?.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
        errors: cd?.errors || [],
      };
      if (isSide) {
        entry.subagentCount = sideChildSubCounts.get(cid) || 0;
        sideQuestions.push(entry);
      } else {
        if (child.parentSideId) {
          entry.parentSideId = child.parentSideId;
          entry.parentSideTitle = child.parentSideTitle || '';
        }
        subagents.push(entry);
      }
    }
    const sortByLiveAndTime = (a, b) => {
      const runDiff = (b.runState === 'RUN_STATE_RUNNING' ? 1 : 0) - (a.runState === 'RUN_STATE_RUNNING' ? 1 : 0);
      return runDiff || String(b.updateTime || '').localeCompare(String(a.updateTime || ''));
    };
    subagents.sort(sortByLiveAndTime);
    sideQuestions.sort(sortByLiveAndTime);

    const mainModelRaw = mainResolved.lastModel || '';
    const mainModelName = formatModelName(mainModelRaw, liveLabels);
    const mainUsed = main?.lastContextTokens || 0;
    const mainLimit = resolveContextLimit(mainModelRaw || mainModelName, liveLimits, mainUsed);
    const mainBf = backfillMap.get(convId) || null;
    const allTtft = collectTtftByDisplay([...backfillMap.values()], liveLabels);
    if (mainBf?.overallTiming?.lastTtftSec != null) allTtft.overall.lastTtftSec = mainBf.overallTiming.lastTtftSec;

    const toolRanking = Object.entries(combinedTools).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    combinedErrors.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const errorSummary = buildErrorSummary(combinedErrors, convId, sideQuestionIds);
    const { activeModelBreakdown, activeCycle } = buildActiveCycleBreakdown({
      sources: [
        { detail: main, backfill: mainBf, isMain: true, isSideQuestion: false },
        ...childEntries.map(({ child, cid, cd }) => ({
          detail: cd,
          backfill: backfillMap.get(cid) || null,
          isMain: false,
          isSideQuestion: Boolean(child.isSideQuestion),
        })),
      ],
      resetPools,
      customPricing,
      liveLabels,
      fallbackDateKey: today,
      mainModelRaw,
      mainModelName,
    });

    const isViewingSide = Boolean(convMeta?.metadata?.isSideQuestion);
    const parentSession = isViewingSide && convMeta?.metadata?.parentConversationId
      ? { id: convMeta.metadata.parentConversationId, title: convMeta.metadata.parentTitle || '' }
      : null;

    const view = {
      conversationId: convId,
      title: mainTitle,
      isSideQuestion: isViewingSide,
      parentSession,
      runState: convMeta?.state?.runState || 'RUN_STATE_IDLE',
      model: mainModelName,
      contextUsed: mainUsed,
      contextLimit: mainLimit,
      usagePercent: mainLimit > 0 ? Math.min(100, (mainUsed / mainLimit) * 100) : 0,
      lastInputTokens: main?.lastInputTokens || 0,
      lastCacheReadTokens: main?.lastCacheReadTokens || 0,
      lastOutputTokens: main?.lastOutputTokens || 0,
      turns: main?.turns || 0,
      checkpoints: main?.checkpoints || 0,
      lastCheckpointTs: main?.lastCheckpointTs || '',
      lastCheckpointBeforeTokens: main?.lastCheckpointBeforeTokens || 0,
      lastCheckpointAfterTokens: main?.lastCheckpointAfterTokens || 0,
      mainCalls: main?.calls || 0,
      mainCost,
      modelBreakdown: formatBreakdownList(acc.combinedModels, { customPricing, liveLabels, dateKey: today, ttftByDisplay: allTtft.byDisplay }),
      activeModelBreakdown,
      activeCycle,
      contextPoints: main?.contextPoints || [],
      contextBreakdown: buildContextBreakdown(main, mainBf, mainUsed, mainLimit),
      stepSummary: main?.stepCounts || emptyStepCounts(),
      mainTurns: buildRecentTurnsView(main, mainBf, liveLabels, customPricing, today),
      totals: {
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        outputTokens: acc.outputTokens,
        cost: acc.cost,
        unpricedCalls: acc.unpricedCalls,
        ...computeRateMetrics({ ...acc, lastSpeedTokPerSec: mainResolved.lastSpeedTokPerSec ?? null }),
        ...finalizeTtftAgg(allTtft.overall),
        subagentCount: subagents.length,
        runningSubagents: subagents.filter((s) => s.runState === 'RUN_STATE_RUNNING').length,
        sideQuestionCount: sideQuestions.length,
        errorCount: combinedErrors.length,
        toolCalls: toolRanking.reduce((s, t) => s + t.count, 0),
      },
      toolRanking,
      sideQuestions,
      subagents,
      errorSummary,
      errors: combinedErrors.slice(0, 50),
    };
    Object.defineProperty(view, '_cacheKey', { value: sessionKey, enumerable: false });
    this._sessionViewCache.delete(sessionKey);
    this._sessionViewCache.set(sessionKey, view);
    while (this._sessionViewCache.size > 4) {
      this._sessionViewCache.delete(this._sessionViewCache.keys().next().value);
    }
    return view;
  }

  /** Build a compact enriched session summary (main + subagents + side questions) for the Sessions list. */
  async buildSessionListItem({
    conv,
    subagentIds = [],
    sideQuestionIds = [],
    customPricing = {},
    liveLabels = null,
    liveLimits = null,
    dateKey = formatLocalDateKey(),
    resolveBackfill = null,
    accountTimeline = null,
  }) {
    const validSubIds = subagentIds.filter((cid) => cid && cid !== conv.id);
    const validSideIds = sideQuestionIds.filter((cid) => cid && cid !== conv.id);
    const sideIdSet = new Set(validSideIds);
    const allChildIds = [...new Set([...validSubIds, ...validSideIds])];
    const [main, ...rawSubs] = await Promise.all([
      this.getConversationSummary(conv.id, accountTimeline),
      ...allChildIds.map((cid) => this.getConversationSummary(cid, accountTimeline)),
    ]);
    const subSummaries = [];
    for (let i = 0; i < allChildIds.length; i++) {
      if (rawSubs[i]) subSummaries.push({ cid: allChildIds[i], sub: rawSubs[i], isSide: sideIdSet.has(allChildIds[i]) });
    }

    const needIds = [];
    if (main?.unknownSteps?.length > 0) needIds.push(conv.id);
    for (const { cid, sub } of subSummaries) {
      if (sub.unknownSteps?.length > 0) needIds.push(cid);
    }
    const backfillMap = await fetchBackfillsInBatches(needIds, resolveBackfill, 10);

    const acc = createUsageAccumulator(customPricing, dateKey);
    const mainResolved = resolveUsageWithBackfill(main, backfillMap.get(conv.id));
    if (main) {
      acc.add({
        calls: main.totalCalls,
        inputTokens: main.totalInput,
        cacheReadTokens: main.totalCache,
        outputTokens: main.totalOutput,
        resolved: mainResolved,
        isMain: true,
      });
    }
    let activeSubCount = 0;
    let activeSideCount = 0;
    for (const { cid, sub, isSide } of subSummaries) {
      if (isSide) activeSideCount++;
      else activeSubCount++;
      acc.add({
        calls: sub.totalCalls,
        inputTokens: sub.totalInput,
        cacheReadTokens: sub.totalCache,
        outputTokens: sub.totalOutput,
        resolved: resolveUsageWithBackfill(sub, backfillMap.get(cid)),
        isSideQuestion: isSide,
      });
    }

    const modelRaw = mainResolved.lastModel || '';
    const model = modelRaw ? formatModelName(modelRaw, liveLabels) : '';
    const contextUsed = main?.lastContextTokens || 0;
    const contextLimit = resolveContextLimit(modelRaw || model, liveLimits, contextUsed);
    const allTtft = collectTtftByDisplay([...backfillMap.values()], liveLabels);

    return {
      id: conv.id,
      title: conv.annotations?.title || conv.state?.summary || main?.lastUserPrompt || conv.id.slice(0, 8),
      runState: conv.state?.runState || 'RUN_STATE_IDLE',
      updateTime: conv.state?.updateTime || main?.lastTs || '',
      createTime: conv.metadata?.createTime || main?.firstTs || '',
      projectId: conv.metadata?.projectId || '',
      model,
      calls: acc.calls,
      turns: main?.totalTurns || 0,
      subagentCount: activeSubCount,
      sideQuestionCount: activeSideCount,
      contextUsed,
      contextLimit,
      usagePercent: contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : 0,
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      outputTokens: acc.outputTokens,
      cost: acc.cost,
      ...computeRateMetrics({ ...acc, lastSpeedTokPerSec: mainResolved.lastSpeedTokPerSec ?? null }),
      ...finalizeTtftAgg(allTtft.overall),
      modelBreakdown: formatBreakdownList(acc.combinedModels, { customPricing, liveLabels, dateKey, ttftByDisplay: allTtft.byDisplay }),
    };
  }
}
