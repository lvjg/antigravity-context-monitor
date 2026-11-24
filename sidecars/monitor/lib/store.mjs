/**
 * Ultra-lightweight (<5 KB) persistent store for accounts & user preferences ONLY.
 * Zero runtime/conversation/call duplication on disk.
 *
 * File: $ANTIGRAVITY_EXECUTABLE_DATA_DIR/accounts.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPricing } from './pricing.mjs';

const VALID_LANGS = new Set(['zh', 'en', 'both']);
const MAX_TIMELINE_ENTRIES = 2000;

function pruneDefaultMatchingPricing(map) {
  const defaults = getDefaultPricing();
  const clean = {};
  let pruned = false;
  for (const [k, v] of Object.entries(map || {})) {
    if (!v || typeof v !== 'object') {
      pruned = true;
      continue;
    }
    const def = defaults[k];
    if (
      def &&
      Number(v.input) === Number(def.input) &&
      Number(v.output) === Number(def.output) &&
      Number(v.cacheRead) === Number(def.cacheRead)
    ) {
      pruned = true;
      continue;
    }
    clean[k] = v;
  }
  return { clean, pruned };
}

export function getDataDir() {
  return (
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    path.join(
      process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity'),
      'sidecar_data',
      'antigravity-context-monitor',
      'monitor',
      'data',
    )
  );
}

const DEFAULT_STORE = {
  version: 2,
  language: 'zh', // 'zh' | 'en' | 'both'
  accounts: {}, // email -> { email, name, planName, tierName, credits, resetPools, lastSeen }
  accountTimeline: [], // chronologically sorted [{ at: ISOString, email }] appended ONLY when active account switches
  customPricing: {}, // familyKey -> { input, output, cacheRead, thinking }
};

function normalizeTimeline(rawTimeline, accounts) {
  let list = Array.isArray(rawTimeline)
    ? rawTimeline
        .filter((e) => e && typeof e.at === 'string' && typeof e.email === 'string' && Number.isFinite(Date.parse(e.at)))
        .map((e) => ({ at: e.at, email: e.email.trim() }))
        .filter((e) => e.email)
    : [];

  let seeded = false;
  // Seed initial timeline from existing snapshots without misattributing post-switch time to the old account:
  // an older account's `lastSeen` marks the end of its last known session, so the newer active account starts right after it.
  if (list.length === 0 && accounts && typeof accounts === 'object') {
    const known = Object.values(accounts)
      .filter((a) => a?.email && a?.lastSeen && Number.isFinite(Date.parse(a.lastSeen)))
      .sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen));
    if (known.length === 1) {
      list = [{ at: known[0].lastSeen, email: known[0].email }];
      seeded = true;
    } else if (known.length >= 2) {
      const prev = known[known.length - 2];
      const latest = known[known.length - 1];
      list = [{ at: new Date(Date.parse(prev.lastSeen) + 1000).toISOString(), email: latest.email }];
      seeded = true;
    }
  }

  list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const deduped = [];
  for (const item of list) {
    if (deduped.length > 0 && deduped[deduped.length - 1].email === item.email) continue;
    deduped.push(item);
  }
  return { timeline: deduped.slice(-MAX_TIMELINE_ENTRIES), seeded };
}

export class AccountPrefsStore {
  constructor(filePath = path.join(getDataDir(), 'accounts.json')) {
    this.filePath = filePath;
    this.data = this._load();
    if (this._needsSave) {
      delete this._needsSave;
      this._save();
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          const accounts = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {};
          const rawCustom = parsed.customPricing && typeof parsed.customPricing === 'object' ? parsed.customPricing : {};
          const { clean, pruned } = pruneDefaultMatchingPricing(rawCustom);
          const { timeline, seeded } = normalizeTimeline(parsed.accountTimeline, accounts);
          if (pruned || seeded) this._needsSave = true;
          return {
            version: 2,
            language: VALID_LANGS.has(parsed.language) ? parsed.language : 'zh',
            accounts,
            accountTimeline: timeline,
            customPricing: clean,
          };
        }
      }
    } catch { /* fallback to default */ }
    return structuredClone(DEFAULT_STORE);
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[context-monitor] failed to save accounts.json:', err.message);
    }
  }

  getLanguage() {
    return this.data.language;
  }

  setLanguage(lang) {
    if (!VALID_LANGS.has(lang) || this.data.language === lang) return;
    this.data.language = lang;
    this._save();
  }

  getCustomPricing() {
    return { ...this.data.customPricing };
  }

  setCustomPricing(pricingMap) {
    const clean = {};
    for (const [k, v] of Object.entries(pricingMap || {})) {
      if (!v || typeof v !== 'object') continue;
      const input = Number(v.input);
      const output = Number(v.output);
      const cacheRead = Number(v.cacheRead);
      const thinking = v.thinking !== undefined && v.thinking !== '' ? Number(v.thinking) : output;
      if ([input, output, cacheRead, thinking].every((n) => Number.isFinite(n) && n >= 0)) {
        clean[k] = { input, output, cacheRead, thinking };
      }
    }
    this.data.customPricing = pruneDefaultMatchingPricing(clean).clean;
    this._save();
  }

  resetCustomPricing() {
    this.data.customPricing = {};
    this._save();
  }

  getAccountTimeline() {
    return (this.data.accountTimeline || []).map((e) => ({ at: e.at, atMs: Date.parse(e.at), email: e.email }));
  }

  upsertAccountSnapshot(liveSnapshot) {
    if (!liveSnapshot?.email) return;
    const nowIso = new Date().toISOString();
    const prev = this.data.accounts[liveSnapshot.email] || {};
    const next = {
      email: liveSnapshot.email,
      name: liveSnapshot.name || prev.name || liveSnapshot.email,
      planName: liveSnapshot.planName || prev.planName || '',
      tierName: liveSnapshot.tierName || prev.tierName || '',
      credits: liveSnapshot.credits ?? prev.credits ?? 0,
      resetPools: liveSnapshot.resetPools || prev.resetPools || [],
      lastSeen: nowIso,
    };

    if (!Array.isArray(this.data.accountTimeline)) this.data.accountTimeline = [];
    const lastSwitch = this.data.accountTimeline[this.data.accountTimeline.length - 1];
    const switchedAccount = !lastSwitch || lastSwitch.email !== liveSnapshot.email;
    if (switchedAccount) {
      this.data.accountTimeline.push({ at: nowIso, email: liveSnapshot.email });
      if (this.data.accountTimeline.length > MAX_TIMELINE_ENTRIES) {
        this.data.accountTimeline = this.data.accountTimeline.slice(-MAX_TIMELINE_ENTRIES);
      }
    }

    const sameCore =
      !switchedAccount &&
      prev.email === next.email &&
      prev.name === next.name &&
      prev.planName === next.planName &&
      prev.tierName === next.tierName &&
      prev.credits === next.credits &&
      JSON.stringify(prev.resetPools) === JSON.stringify(next.resetPools);
    // Avoid disk churn when only lastSeen changed within 60 seconds
    const prevMs = prev.lastSeen ? Date.parse(prev.lastSeen) : 0;
    if (sameCore && Date.now() - prevMs < 60_000) return;

    this.data.accounts[liveSnapshot.email] = next;
    this._save();
  }

  removeAccount(email) {
    if (!email || !this.data.accounts[email]) return false;
    delete this.data.accounts[email];
    this._save();
    return true;
  }

  getAccounts(activeEmail = '') {
    const now = Date.now();
    return Object.values(this.data.accounts)
      .map((acct) => ({
        ...acct,
        isActive: Boolean(activeEmail && acct.email === activeEmail),
        resetPools: (acct.resetPools || []).map((p) => {
          const resetMs = p.resetTime ? Date.parse(p.resetTime) : 0;
          const isExpired = resetMs > 0 && resetMs <= now;
          return {
            ...p,
            remainingPercent: isExpired ? 100 : p.remainingPercent,
            isReady: isExpired || p.remainingPercent >= 100,
          };
        }),
      }))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  }

  getStorageInfo() {
    let sizeBytes = 0;
    let exists = false;
    try {
      sizeBytes = fs.statSync(this.filePath).size;
      exists = true;
    } catch { /* missing */ }
    return {
      filePath: this.filePath,
      exists,
      sizeBytes,
      accountCount: Object.keys(this.data.accounts).length,
      customPricingCount: Object.keys(this.data.customPricing).length,
    };
  }
}
