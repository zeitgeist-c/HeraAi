/**
 * Usage statistics (schemaVersion 2).
 *
 * Privacy: only counts, model ids/providers and durations are stored.
 * Message text, URLs and attachments are never persisted here.
 */

const SCHEMA_VERSION = 2;
const MAX_RECENT_IDS = 100;
const OUTCOMES = ['completed', 'error', 'interrupted', 'cancelled'];
const TOOLS = ['voice', 'screenshot', 'search'];
const VALID_RANGES = ['7d', '30d', 'all'];

function getChromeStorage() {
  try {
    const c = globalThis.chrome;
    return c && c.storage && c.storage.local ? c.storage.local : null;
  } catch {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local day key YYYY-MM-DD (never toDateString). */
function toDayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function emptyByOutcome() {
  return { completed: 0, error: 0, interrupted: 0, cancelled: 0 };
}

function emptyTools() {
  return { voice: 0, screenshot: 0, search: 0 };
}

function emptyDay() {
  return {
    prompts: 0,
    byOutcome: emptyByOutcome(),
    successDurationMs: 0,
    tools: emptyTools(),
    models: {},
  };
}

function ensureDay(stats, key) {
  if (!stats.days[key]) stats.days[key] = emptyDay();
  return stats.days[key];
}

function ensureModelRow(container, modelKey, modelId, provider) {
  if (!container[modelKey]) {
    container[modelKey] = {
      modelId,
      provider,
      attempts: 0,
      successes: 0,
      successDurationMs: 0,
    };
  }
  return container[modelKey];
}

function validDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function storageGet(keys) {
  const storage = getChromeStorage();
  return new Promise((resolve) => {
    if (!storage) {
      resolve({});
      return;
    }
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value || {});
      }
    };
    try {
      const maybe = storage.get(keys, (result) => done(result));
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((result) => done(result), () => done({}));
      }
    } catch {
      done({});
    }
  });
}

function storageSet(data) {
  const storage = getChromeStorage();
  return new Promise((resolve) => {
    if (!storage) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const maybe = storage.set(data, () => done());
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(() => done(), () => done());
      }
    } catch {
      done();
    }
  });
}

/**
 * Migrate a v1 (or missing) stats object to the v2 shape.
 * v1 shape: { totalMessages, totalSessions, messagesByDate (Date.toDateString keys),
 *   lastActive, voiceInputs, screenshots, searches }.
 * totalSessions is ignored (it was buggy).
 */
function migrateV1ToV2(old) {
  const source = old && typeof old === 'object' ? old : {};
  const legacyTools = {
    voice: source.voiceInputs || 0,
    screenshot: source.screenshots || 0,
    search: source.searches || 0,
  };
  const stats = {
    schemaVersion: SCHEMA_VERSION,
    lastActive: source.lastActive ?? null,
    lifetime: {
      prompts: source.totalMessages || 0,
      byOutcome: emptyByOutcome(),
      successDurationMs: 0,
      tools: { ...legacyTools },
      models: {},
    },
    days: {},
    legacyTools: { ...legacyTools },
    recentFinalizedIds: [],
  };

  const byDate = source.messagesByDate;
  if (byDate && typeof byDate === 'object') {
    let unparseable = 0;
    for (const [key, value] of Object.entries(byDate)) {
      const count = Number(value) || 0;
      const parsed = new Date(key);
      if (!Number.isNaN(parsed.getTime())) {
        const dayKey = toDayKey(parsed);
        ensureDay(stats, dayKey).prompts += count;
      } else {
        unparseable += count;
      }
    }
    if (unparseable > 0) {
      const dayKeys = Object.keys(stats.days).sort();
      if (dayKeys.length > 0) {
        stats.days[dayKeys[0]].prompts += unparseable;
      }
    }
  }

  return stats;
}

/**
 * Load stats, migrating v1 -> v2 (and persisting the migration) when needed.
 * Idempotent: anything already at schemaVersion 2 is returned as-is.
 */
async function ensureV2() {
  let stored = {};
  try {
    stored = await storageGet(['stats', 'sessions']);
  } catch {
    stored = {};
  }
  const sessions = stored ? stored.sessions : undefined;
  const current = stored ? stored.stats : undefined;
  if (current && current.schemaVersion === SCHEMA_VERSION) {
    return { stats: current, sessions };
  }
  const migrated = migrateV1ToV2(current);
  try {
    await storageSet({ stats: migrated });
  } catch {
    // never throw
  }
  return { stats: migrated, sessions };
}

/** Record one user prompt: lifetime + today prompt counters and lastActive. */
/** Aynı storage anahtarına yazan işlemleri sıraya alır (eşzamanlı okuma-yazma kaybını önler). */
let statsWriteChain = Promise.resolve()
function serializeStatsWrite(task) {
  const result = statsWriteChain.then(task, task)
  statsWriteChain = result.catch(() => {})
  return result
}

export async function recordPromptStarted() {
  if (!getChromeStorage()) return;
  return serializeStatsWrite(async () => {
    try {
      const { stats } = await ensureV2();
      const nowMs = Date.now();
      const day = ensureDay(stats, toDayKey(new Date(nowMs)));
      stats.lifetime.prompts += 1;
      day.prompts += 1;
      stats.lastActive = nowMs;
      await storageSet({ stats });
    } catch {
      // never throw
    }
  });
}

/**
 * Record finalized generation results.
 * Each entry: { dedupId, outcome: 'completed'|'error'|'interrupted'|'cancelled',
 *   modelId?, provider?, durationMs? }.
 * Entries with an already-seen dedupId are skipped. recentFinalizedIds is capped
 * at 100 (FIFO). Cancelled runs never count as attempts.
 */
export async function recordGenerationResults(results) {
  if (!getChromeStorage()) return;
  return serializeStatsWrite(async () => {
    try {
      const { stats } = await ensureV2();
    if (!Array.isArray(results) || results.length === 0) return;
    if (!Array.isArray(stats.recentFinalizedIds)) stats.recentFinalizedIds = [];
    const nowMs = Date.now();
    const day = ensureDay(stats, toDayKey(new Date(nowMs)));

    for (const entry of results) {
      if (!entry || typeof entry !== 'object') continue;
      const { dedupId, outcome, modelId, provider } = entry;
      if (!dedupId || !OUTCOMES.includes(outcome)) continue;
      if (stats.recentFinalizedIds.includes(dedupId)) continue;

      stats.recentFinalizedIds.push(dedupId);
      while (stats.recentFinalizedIds.length > MAX_RECENT_IDS) {
        stats.recentFinalizedIds.shift();
      }

      stats.lifetime.byOutcome[outcome] += 1;
      day.byOutcome[outcome] += 1;

      const duration = validDuration(entry.durationMs);
      if (outcome === 'completed' && duration !== null) {
        stats.lifetime.successDurationMs += duration;
        day.successDurationMs += duration;
      }

      if (modelId) {
        const resolvedProvider = provider || 'unknown';
        const modelKey = `${resolvedProvider}:${modelId}`;
        const lifetimeRow = ensureModelRow(
          stats.lifetime.models,
          modelKey,
          modelId,
          resolvedProvider,
        );
        const dayRow = ensureModelRow(day.models, modelKey, modelId, resolvedProvider);
        if (outcome === 'completed' || outcome === 'error' || outcome === 'interrupted') {
          lifetimeRow.attempts += 1;
          dayRow.attempts += 1;
        }
        if (outcome === 'completed') {
          lifetimeRow.successes += 1;
          dayRow.successes += 1;
          if (duration !== null) {
            lifetimeRow.successDurationMs += duration;
            dayRow.successDurationMs += duration;
          }
        }
      }
    }

    await storageSet({ stats });
    } catch {
      // never throw
    }
  });
}

/** Record one tool usage ('voice' | 'screenshot' | 'search'). */
export async function recordToolUsage(tool) {
  if (!getChromeStorage()) return;
  return serializeStatsWrite(async () => {
    try {
      const { stats } = await ensureV2();
      if (!TOOLS.includes(tool)) return;
      const nowMs = Date.now();
      const day = ensureDay(stats, toDayKey(new Date(nowMs)));
      stats.lifetime.tools[tool] += 1;
      day.tools[tool] += 1;
      stats.lastActive = nowMs;
      await storageSet({ stats });
    } catch {
      // never throw
    }
  });
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(base, offset) {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d;
}

function dayPrompts(stats, key) {
  const day = stats.days ? stats.days[key] : null;
  return (day && day.prompts) || 0;
}

/** Build the ordered bucket list plus the set of in-range day keys. */
function buildBuckets(stats, range, nowDate) {
  const todayStart = startOfDay(nowDate);
  if (range === '30d') {
    const buckets = [];
    const inRange = new Set();
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const startOffset = -(34 - 7 * chunk);
      const start = addDays(todayStart, startOffset);
      const key = toDayKey(start);
      let count = 0;
      for (let i = 0; i < 7; i += 1) {
        const dayKey = toDayKey(addDays(start, i));
        inRange.add(dayKey);
        count += dayPrompts(stats, dayKey);
      }
      buckets.push({ key, label: key, count });
    }
    return { buckets, inRange };
  }
  if (range === 'all') {
    const inRange = new Set(Object.keys(stats.days || {}));
    const monthCounts = new Map();
    for (const dayKey of inRange) {
      const month = dayKey.slice(0, 7);
      monthCounts.set(month, (monthCounts.get(month) || 0) + dayPrompts(stats, dayKey));
    }
    const months = Array.from(monthCounts.keys()).sort().slice(-12);
    const buckets = months.map((month) => ({
      key: month,
      label: month,
      count: monthCounts.get(month) || 0,
    }));
    return { buckets, inRange };
  }
  // '7d' default: last 7 local days, ascending.
  const buckets = [];
  const inRange = new Set();
  for (let offset = -6; offset <= 0; offset += 1) {
    const key = toDayKey(addDays(todayStart, offset));
    inRange.add(key);
    buckets.push({ key, label: key, count: dayPrompts(stats, key) });
  }
  return { buckets, inRange };
}

function summarizeRange(stats, range, nowMs, sessions) {
  const nowDate = new Date(nowMs);
  const { buckets, inRange } = buildBuckets(stats, range, nowDate);

  let promptsTotal = 0;
  const outcomes = emptyByOutcome();
  const tools = emptyTools();
  let successDurationMs = 0;
  const modelAgg = {};

  for (const dayKey of inRange) {
    const day = stats.days ? stats.days[dayKey] : null;
    if (!day) continue;
    promptsTotal += day.prompts || 0;
    for (const outcome of OUTCOMES) {
      outcomes[outcome] += (day.byOutcome && day.byOutcome[outcome]) || 0;
    }
    for (const tool of TOOLS) {
      tools[tool] += (day.tools && day.tools[tool]) || 0;
    }
    successDurationMs += day.successDurationMs || 0;
    const dayModels = day.models || {};
    for (const [modelKey, row] of Object.entries(dayModels)) {
      if (!modelAgg[modelKey]) {
        modelAgg[modelKey] = {
          modelKey,
          modelId: row.modelId,
          provider: row.provider,
          attempts: 0,
          successes: 0,
          successDurationMs: 0,
        };
      }
      modelAgg[modelKey].attempts += row.attempts || 0;
      modelAgg[modelKey].successes += row.successes || 0;
      modelAgg[modelKey].successDurationMs += row.successDurationMs || 0;
    }
  }

  if (range === 'all' && stats.legacyTools) {
    for (const tool of TOOLS) {
      tools[tool] += stats.legacyTools[tool] || 0;
    }
  }

  const models = Object.values(modelAgg)
    .map((row) => ({
      modelKey: row.modelKey,
      modelId: row.modelId,
      provider: row.provider,
      attempts: row.attempts,
      successes: row.successes,
      avgSuccessDurationMs:
        row.successes > 0 ? row.successDurationMs / row.successes : null,
      successRate: row.attempts > 0 ? row.successes / row.attempts : null,
    }))
    .sort((a, b) => b.attempts - a.attempts || (a.modelKey < b.modelKey ? -1 : 1));

  const avgSuccessDurationMs =
    outcomes.completed > 0 ? successDurationMs / outcomes.completed : null;
  const rateDenominator = outcomes.completed + outcomes.error + outcomes.interrupted;
  const successRate = rateDenominator > 0 ? outcomes.completed / rateDenominator : null;

  const hasAnyData =
    promptsTotal > 0 ||
    OUTCOMES.some((outcome) => outcomes[outcome] > 0) ||
    TOOLS.some((tool) => tools[tool] > 0) ||
    models.length > 0;

  return {
    range,
    activity: buckets,
    promptsTotal,
    outcomes,
    tools,
    models,
    avgSuccessDurationMs,
    successRate,
    sessionCount: Array.isArray(sessions) ? sessions.length : 0,
    hasAnyData,
    lastActive: stats.lastActive ?? null,
  };
}

function emptySnapshot(range, nowMs) {
  return summarizeRange(
    {
      lastActive: null,
      lifetime: null,
      days: {},
      legacyTools: emptyTools(),
    },
    range,
    nowMs,
    [],
  );
}

/**
 * Snapshot of stats for a range ('7d' | '30d' | 'all'), anchored at `now`.
 * Migrates v1 data first. Never throws.
 */
export async function getStatsSnapshot({ range = '7d', now = Date.now() } = {}) {
  const safeRange = VALID_RANGES.includes(range) ? range : '7d';
  const parsedNow = new Date(now).getTime();
  const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;
  if (!getChromeStorage()) return emptySnapshot(safeRange, nowMs);
  try {
    const { stats, sessions } = await ensureV2();
    return summarizeRange(stats, safeRange, nowMs, sessions);
  } catch {
    return emptySnapshot(safeRange, nowMs);
  }
}
