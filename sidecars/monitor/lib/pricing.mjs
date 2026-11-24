/**
 * Model metadata, context limits, and official API pricing (USD / 1M tokens).
 * Pure data + lookup functions — zero I/O, zero side effects.
 */

export const PRICING_LAST_UPDATED = '2026-11-24';

export function formatLocalDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const GEMINI_4_PRO_INTRO_LAST_DAY = '2026-11-30';
const GEMINI_4_PRO_INTRO = Object.freeze({ input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0, thinking: 10.0 });
const GEMINI_4_PRO_STD = Object.freeze({ input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 0, thinking: 20.0 });

const GEMINI_FLASH_INTRO_LAST_DAY = '2026-12-31';
const GEMINI_FLASH_INTRO = Object.freeze({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, thinking: 3.75 });
const GEMINI_FLASH_STD = Object.freeze({ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875, thinking: 7.5 });

const BASE_PRICING = Object.freeze({
  'gemini-4-neon': Object.freeze({ input: 3.0, output: 15.0, cacheRead: 0.15, cacheWrite: 3.75, thinking: 15.0 }),
  'gemini-4-hydrogen': Object.freeze({ input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 1.875, thinking: 7.5 }),
  'gemini-3.6-flash': Object.freeze({ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875, thinking: 7.5 }),
  'gemini-3.5-flash': Object.freeze({ input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 1.875, thinking: 9.0 }),
  'gemini-3.1-pro': Object.freeze({ input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 0, thinking: 12.0 }),
  'gemini-3-flash': Object.freeze({ input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0, thinking: 3.0 }),
  'claude-opus-5-5': Object.freeze({ input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0, thinking: 20.0 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5, thinking: 10.0 }),
  'claude-opus-4-6': Object.freeze({ input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, thinking: 25.0 }),
  'claude-sonnet-4-6': Object.freeze({ input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, thinking: 15.0 }),
  'gpt-oss-120b': Object.freeze({ input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0, thinking: 0.36 }),
});

// Memoized frozen pricing tables keyed by promo-window bitmask (max 4 entries)
const PRICING_TABLE_CACHE = new Map();

export function getDefaultPricing(dateKey = formatLocalDateKey()) {
  const g4Intro = dateKey <= GEMINI_4_PRO_INTRO_LAST_DAY;
  const flashIntro = dateKey <= GEMINI_FLASH_INTRO_LAST_DAY;
  const cacheKey = (g4Intro ? 2 : 0) | (flashIntro ? 1 : 0);
  let table = PRICING_TABLE_CACHE.get(cacheKey);
  if (!table) {
    const g4Pro = g4Intro ? GEMINI_4_PRO_INTRO : GEMINI_4_PRO_STD;
    const gFlash = flashIntro ? GEMINI_FLASH_INTRO : GEMINI_FLASH_STD;
    table = Object.freeze({
      'gemini-4-neon': BASE_PRICING['gemini-4-neon'],
      'gemini-4-carbon': g4Pro,
      'gemini-4-argon': g4Pro,
      'gemini-4-hydrogen': BASE_PRICING['gemini-4-hydrogen'],
      'gemini-3.8-flash': gFlash,
      'gemini-3.7-flash': gFlash,
      'gemini-3.6-flash': BASE_PRICING['gemini-3.6-flash'],
      'gemini-3.5-flash': BASE_PRICING['gemini-3.5-flash'],
      'gemini-3.1-pro': BASE_PRICING['gemini-3.1-pro'],
      'gemini-3-flash': BASE_PRICING['gemini-3-flash'],
      'claude-opus-5-5': BASE_PRICING['claude-opus-5-5'],
      'claude-sonnet-5-5': BASE_PRICING['claude-sonnet-5-5'],
      'claude-opus-4-6': BASE_PRICING['claude-opus-4-6'],
      'claude-sonnet-4-6': BASE_PRICING['claude-sonnet-4-6'],
      'gpt-oss-120b': BASE_PRICING['gpt-oss-120b'],
    });
    PRICING_TABLE_CACHE.set(cacheKey, table);
  }
  return table;
}

const spec = (label, family, cpLimit, maxTokens, pool) =>
  Object.freeze({ label, family, cpLimit, maxTokens, pool });
const g4 = (label, family) => spec(label, family, 512000, 1048576, 'gemini');
const g3f = (label, family) => spec(label, family, 256000, 1048576, 'gemini');
const g3s = (label, family) => spec(label, family, 128000, 1048576, 'gemini');
const c55 = (label, family) => spec(label, family, 256000, 1000000, 'premium');
const c46 = (label, family) => spec(label, family, 160000, 250000, 'premium');

const STATIC_PLACEHOLDER_MAP = Object.freeze({
  MODEL_PLACEHOLDER_M532: g4('Gemini 4 Neon (High)', 'gemini-4-neon'),
  MODEL_PLACEHOLDER_M533: g4('Gemini 4 Neon (Medium)', 'gemini-4-neon'),
  MODEL_PLACEHOLDER_M534: g4('Gemini 4 Neon (Low)', 'gemini-4-neon'),
  MODEL_PLACEHOLDER_M535: g4('Gemini 4 Neon (XHigh)', 'gemini-4-neon'),
  MODEL_PLACEHOLDER_M537: g4('Orchestrator (Neon)', 'gemini-4-neon'),
  MODEL_PLACEHOLDER_M427: g4('Gemini 4 Carbon (High)', 'gemini-4-carbon'),
  MODEL_PLACEHOLDER_M437: g4('Gemini 4 Carbon (Medium)', 'gemini-4-carbon'),
  MODEL_PLACEHOLDER_M438: g4('Gemini 4 Carbon (Low)', 'gemini-4-carbon'),
  MODEL_PLACEHOLDER_M667: g4('Orchestrator (Carbon)', 'gemini-4-carbon'),
  MODEL_PLACEHOLDER_M417: g4('Gemini 4 Argon (High)', 'gemini-4-argon'),
  MODEL_PLACEHOLDER_M418: g4('Gemini 4 Argon (Medium)', 'gemini-4-argon'),
  MODEL_PLACEHOLDER_M419: g4('Gemini 4 Argon (Low)', 'gemini-4-argon'),
  MODEL_PLACEHOLDER_M681: g4('Orchestrator (Argon)', 'gemini-4-argon'),
  MODEL_PLACEHOLDER_M525: g4('Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M526: g4('Gemini 4 Hydrogen (Medium)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M527: g4('Gemini 4 Hydrogen (Low)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M528: g4('Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M669: g4('Gemini 4 Hydrogen (Orchestrator)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M530: g4('Gemini 4 Hydrogen (Tiered High)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M531: g4('Gemini 4 Hydrogen (Tiered)', 'gemini-4-hydrogen'),
  MODEL_PLACEHOLDER_M318: g3f('Gemini 3.8 Flash (High)', 'gemini-3.8-flash'),
  MODEL_PLACEHOLDER_M319: g3f('Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash'),
  MODEL_PLACEHOLDER_M320: g3f('Gemini 3.8 Flash (Low)', 'gemini-3.8-flash'),
  MODEL_PLACEHOLDER_M322: g3f('Gemini 3.8 Flash (Tiered)', 'gemini-3.8-flash'),
  MODEL_PLACEHOLDER_M298: g3f('Gemini 3.7 Flash (High)', 'gemini-3.7-flash'),
  MODEL_PLACEHOLDER_M299: g3f('Gemini 3.7 Flash (Medium)', 'gemini-3.7-flash'),
  MODEL_PLACEHOLDER_M300: g3f('Gemini 3.7 Flash (Low)', 'gemini-3.7-flash'),
  MODEL_PLACEHOLDER_M71: g3f('Gemini 3.6 Flash (High)', 'gemini-3.6-flash'),
  MODEL_PLACEHOLDER_M72: g3f('Gemini 3.6 Flash (Medium)', 'gemini-3.6-flash'),
  MODEL_PLACEHOLDER_M73: g3f('Gemini 3.6 Flash (Low)', 'gemini-3.6-flash'),
  MODEL_PLACEHOLDER_M196: g3f('Gemini 3.6 Flash (Tiered)', 'gemini-3.6-flash'),
  MODEL_PLACEHOLDER_M84: g3f('Gemini 3.5 Flash (High)', 'gemini-3.5-flash'),
  MODEL_PLACEHOLDER_M20: g3f('Gemini 3.5 Flash (Medium)', 'gemini-3.5-flash'),
  MODEL_PLACEHOLDER_M187: g3f('Gemini 3.5 Flash (Low)', 'gemini-3.5-flash'),
  MODEL_PLACEHOLDER_M50: g3s('Gemini 3 Flash Lite', 'gemini-3-flash'),
  MODEL_PLACEHOLDER_M198: g3s('Gemini 3 Flash Lite', 'gemini-3-flash'),
  MODEL_PLACEHOLDER_M37: g3s('Gemini 3.1 Pro (High)', 'gemini-3.1-pro'),
  MODEL_PLACEHOLDER_M36: g3s('Gemini 3.1 Pro (Low)', 'gemini-3.1-pro'),
  MODEL_PLACEHOLDER_M400: c55('Claude Opus 5.5 (Low)', 'claude-opus-5-5'),
  MODEL_PLACEHOLDER_M401: c55('Claude Opus 5.5 (Medium)', 'claude-opus-5-5'),
  MODEL_PLACEHOLDER_M402: c55('Claude Opus 5.5 (High)', 'claude-opus-5-5'),
  MODEL_PLACEHOLDER_M403: c55('Claude Sonnet 5.5 (Low)', 'claude-sonnet-5-5'),
  MODEL_PLACEHOLDER_M404: c55('Claude Sonnet 5.5 (Medium)', 'claude-sonnet-5-5'),
  MODEL_PLACEHOLDER_M405: c55('Claude Sonnet 5.5 (High)', 'claude-sonnet-5-5'),
  MODEL_PLACEHOLDER_M35: c46('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'),
  MODEL_PLACEHOLDER_M26: c46('Claude Opus 4.6 (Thinking)', 'claude-opus-4-6'),
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: spec('GPT-OSS 120B (Medium)', 'gpt-oss-120b', 80000, 131072, 'premium'),
});

const FAMILY_ALIASES = Object.freeze({
  'gemini-4-argon-b': 'gemini-4-argon',
  'gemini-4-argon-d': 'gemini-4-argon',
  'gemini-pro-orchestrator': 'gemini-4-carbon',
  'gemini-pro-orchestrator-argon': 'gemini-4-argon',
  'gemini-pro-orchestrator-neon': 'gemini-4-neon',
  'gemini-flash-worker-agy': 'gemini-4-hydrogen',
  'gemini-flash': 'gemini-4-hydrogen',
  'gemini-3-flash-agent': 'gemini-3.5-flash',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-pro-default': 'gemini-3.1-pro',
});

const EXPLICIT_SLUG_LABELS = Object.freeze({
  'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
  'gemini-pro-orchestrator-neon': 'Orchestrator (Neon)',
  'gemini-flash-worker-agy': 'Gemini 4 Hydrogen (Orchestrator)',
});

const TIER_LABELS = Object.freeze({
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  thinking: 'Thinking',
  tiered: 'Tiered',
});

/**
 * Normalize a raw model string (catalog slug, placeholder ID, or display label)
 * to a clean human-readable display name.
 */
export function formatModelName(raw, liveLabels = null) {
  const s = String(raw || '').trim();
  if (!s || s.toLowerCase() === 'unknown') return 'Unknown Model';
  if (liveLabels?.[s]) return liveLabels[s];
  if (STATIC_PLACEHOLDER_MAP[s]) return STATIC_PLACEHOLDER_MAP[s].label;

  const low = s.toLowerCase();
  if (EXPLICIT_SLUG_LABELS[low]) return EXPLICIT_SLUG_LABELS[low];
  if (low.startsWith('gpt-oss-120b')) return 'GPT-OSS 120B (Medium)';
  if (/^(?:orchestrator\s*\(|gemini\s+\d|claude\s+|gpt-oss\s+)/i.test(s)) return s;

  const claude = low.match(/^claude-(opus|sonnet)-(\d+)[.-](\d+)(?:-(low|medium|high|thinking))?$/);
  if (claude) {
    const fam = claude[1][0].toUpperCase() + claude[1].slice(1);
    const tier = claude[4] ? ` (${TIER_LABELS[claude[4]] || claude[4]})` : '';
    return `Claude ${fam} ${claude[2]}.${claude[3]}${tier}`;
  }

  const g4m = low.match(/^gemini-4-(neon|carbon|argon|hydrogen)(?:-[bd])?(?:-(?:tiered-)?(xhigh|high|medium|low))?$/);
  if (g4m) {
    const fam = g4m[1][0].toUpperCase() + g4m[1].slice(1);
    const tier = g4m[2] ? ` (${TIER_LABELS[g4m[2]] || g4m[2]})` : '';
    return `Gemini 4 ${fam}${tier}`;
  }

  const gFlash = low.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(lite|xhigh|high|medium|low|tiered))?$/);
  if (gFlash) {
    const kind = gFlash[2][0].toUpperCase() + gFlash[2].slice(1);
    if (gFlash[3] === 'lite') return `Gemini ${gFlash[1]} ${kind} Lite`;
    const tier = gFlash[3] ? ` (${TIER_LABELS[gFlash[3]] || gFlash[3]})` : '';
    return `Gemini ${gFlash[1]} ${kind}${tier}`;
  }

  return s;
}

/**
 * Resolve any model string to its canonical pricing family key (e.g. 'gemini-4-neon', 'claude-opus-5-5').
 */
export function resolvePricingFamily(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (STATIC_PLACEHOLDER_MAP[s]) return STATIC_PLACEHOLDER_MAP[s].family;

  const orchDisp = s.match(/^orchestrator\s*\(\s*([a-z0-9._-]+)\s*\)$/i);
  if (orchDisp) return `gemini-4-${orchDisp[1].toLowerCase()}`;

  let key = s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (FAMILY_ALIASES[key]) return FAMILY_ALIASES[key];

  const orchSlug = key.match(/^gemini-pro-orchestrator(?:-(.+))?$/);
  if (orchSlug) return `gemini-4-${orchSlug[1] || 'carbon'}`;

  key = key.replace(/-(?:tiered-)?(?:xhigh|high|medium|low|thinking|tiered)$/, '');
  if (FAMILY_ALIASES[key]) return FAMILY_ALIASES[key];

  if (key.startsWith('claude-')) {
    key = key.replace(/(\d+)\.(\d+)/g, '$1-$2');
  }
  return key;
}

export function formatFamilyLabel(familyKey) {
  const claude = String(familyKey || '').match(/^claude-(opus|sonnet)-(\d+)-(\d+)$/);
  if (claude) {
    return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  }
  if (familyKey === 'gpt-oss-120b') return 'GPT-OSS 120B';
  return String(familyKey || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve effective context compression limit (tokens) for a model.
 * Honors live LS overrides first, then static/family heuristics.
 */
export function resolveContextLimit(raw, liveLimits = null, observedTokens = 0) {
  const s = String(raw || '').trim();
  if (s && s.toLowerCase() !== 'unknown' && s !== 'Unknown Model') {
    if (liveLimits?.[s] > 0) return liveLimits[s];
    if (STATIC_PLACEHOLDER_MAP[s]) return STATIC_PLACEHOLDER_MAP[s].cpLimit;

    const low = s.toLowerCase();
    if (/(?:neon|carbon|argon|hydrogen|orchestrator|flash-worker)/.test(low)) return 512000;
    if (/(?:claude|opus|sonnet)/.test(low)) return /5[._-]5/.test(low) ? 256000 : 160000;
    if (/3\.[5-9][\s-]flash/.test(low)) return 256000;
    if (/(?:gpt|oss)/.test(low)) return 80000;
    if (/(?:pro|flash)/.test(low)) return 128000;
  }
  return observedTokens > 512000 ? 1048576 : 512000;
}

export function resolveQuotaPool(modelId, label = '') {
  if (STATIC_PLACEHOLDER_MAP[modelId]) return STATIC_PLACEHOLDER_MAP[modelId].pool;
  const text = `${modelId || ''} ${label || ''}`.toLowerCase();
  return /(?:claude|opus|sonnet|gpt|oss)/.test(text) ? 'premium' : 'gemini';
}

export function resolveModelPricing(raw, customPricing = {}, dateKey = formatLocalDateKey()) {
  const family = resolvePricingFamily(raw);
  if (!family) return null;
  if (customPricing?.[family]) return customPricing[family];
  return getDefaultPricing(dateKey)[family] || null;
}

/**
 * Compute USD cost for token counts.
 * In Antigravity transcript.jsonl, `input_tokens` is uncached input tokens,
 * `cache_read_tokens` is cached prompt tokens, and `output_tokens` includes reasoning/thinking tokens.
 */
export function computeCost({ inputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, outputTokens = 0 }, pricing) {
  if (!pricing) return 0;
  const inRate = Number(pricing.input) || 0;
  const outRate = Number(pricing.output) || 0;
  const cacheRate = Number(pricing.cacheRead) || 0;
  const cacheWriteRate = Number(pricing.cacheWrite) || 0;
  // Avoid double-charging cacheCreationTokens at both input and cacheWrite rates
  const writeTok = cacheWriteRate > 0 && cacheCreationTokens > 0 ? Math.min(cacheCreationTokens, inputTokens) : 0;
  const plainInTok = Math.max(0, inputTokens - writeTok);
  return (plainInTok * inRate + writeTok * cacheWriteRate + cacheReadTokens * cacheRate + outputTokens * outRate) / 1_000_000;
}
