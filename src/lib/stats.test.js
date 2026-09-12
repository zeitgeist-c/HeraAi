import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordPromptStarted,
  recordGenerationResults,
  recordToolUsage,
  getStatsSnapshot,
} from './stats.js';

let store;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function shiftDays(base, offset) {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d;
}

beforeEach(() => {
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn((keys, callback) => {
          if (typeof callback === 'function') callback(store);
          return Promise.resolve(store);
        }),
        set: vi.fn((data, callback) => {
          Object.assign(store, data);
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        }),
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('v1 migration', () => {
  it('migrates values, ignores totalSessions, folds unparseable keys into oldest day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
    const oldDay = new Date(2026, 0, 5).toDateString();
    store.stats = {
      totalMessages: 3,
      totalSessions: 99,
      messagesByDate: { [oldDay]: 2, 'not-a-date': 1 },
      lastActive: 12345,
      voiceInputs: 1,
      screenshots: 2,
      searches: 0,
    };

    await recordPromptStarted();

    expect(store.stats.schemaVersion).toBe(2);
    expect(store.stats.totalSessions).toBeUndefined();
    expect(store.stats.lifetime.prompts).toBe(4);
    expect(store.stats.lifetime.tools).toEqual({ voice: 1, screenshot: 2, search: 0 });
    expect(store.stats.legacyTools).toEqual({ voice: 1, screenshot: 2, search: 0 });
    // 2 parsed + 1 unparseable folded into oldest parsed day
    expect(store.stats.days['2026-01-05'].prompts).toBe(3);
    // today's prompt
    expect(store.stats.days['2026-01-10'].prompts).toBe(1);
    expect(store.stats.lastActive).toBe(new Date(2026, 0, 10, 12, 0, 0).getTime());
    expect(Array.isArray(store.stats.recentFinalizedIds)).toBe(true);
  });

  it('does not re-migrate on the second op', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
    store.stats = {
      totalMessages: 3,
      messagesByDate: { [new Date(2026, 0, 5).toDateString()]: 2 },
      lastActive: 111,
      voiceInputs: 1,
      screenshots: 0,
      searches: 0,
    };

    await recordPromptStarted();
    expect(store.stats.schemaVersion).toBe(2);
    const afterFirst = JSON.parse(JSON.stringify(store.stats));

    await recordToolUsage('voice');

    expect(store.stats.schemaVersion).toBe(2);
    // v1 totals applied exactly once
    expect(store.stats.lifetime.prompts).toBe(afterFirst.lifetime.prompts);
    expect(store.stats.days['2026-01-05'].prompts).toBe(2);
    expect(store.stats.lifetime.tools.voice).toBe(afterFirst.lifetime.tools.voice + 1);
    expect(store.stats.legacyTools.voice).toBe(1);
  });
});

describe('bucketing with now-anchored relative days', () => {
  async function seedPrompts(now) {
    // day offsets -> prompt counts: today 1, -1: 2, -6: 1, -7: 1, -42: 1
    const plan = [[0, 1], [-1, 2], [-6, 1], [-7, 1], [-42, 1]];
    for (const [offset, count] of plan) {
      vi.setSystemTime(shiftDays(now, offset));
      for (let i = 0; i < count; i += 1) {
        await recordPromptStarted();
      }
    }
    vi.setSystemTime(now);
  }

  it('7d covers the last 7 local days ascending', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 12, 12, 0, 0);
    await seedPrompts(now);

    const snap = await getStatsSnapshot({ range: '7d', now: now.getTime() });
    expect(snap.range).toBe('7d');
    expect(snap.activity).toHaveLength(7);
    const keys = snap.activity.map((b) => b.key);
    expect(keys[0]).toBe(dayKeyOf(shiftDays(now, -6)));
    expect(keys[6]).toBe(dayKeyOf(now));
    expect(snap.activity.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 2, 1]);
    expect(snap.promptsTotal).toBe(4);
  });

  it('30d uses 5 weekly chunks ending today', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 12, 12, 0, 0);
    await seedPrompts(now);

    const snap = await getStatsSnapshot({ range: '30d', now: now.getTime() });
    expect(snap.activity).toHaveLength(5);
    expect(snap.activity[4].key).toBe(dayKeyOf(shiftDays(now, -6)));
    expect(snap.activity[4].count).toBe(4);
    expect(snap.activity[3].count).toBe(1); // -7d prompt in the previous chunk
    expect(snap.promptsTotal).toBe(5);
  });

  it('all aggregates monthly across the data span', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 12, 12, 0, 0);
    await seedPrompts(now);

    const snap = await getStatsSnapshot({ range: 'all', now: now.getTime() });
    expect(snap.activity.map((b) => b.key)).toEqual(['2026-08', '2026-09']);
    expect(snap.activity.map((b) => b.count)).toEqual([1, 5]);
    expect(snap.promptsTotal).toBe(6);
  });

  it('legacy tools count only in the all range', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    store.stats = {
      totalMessages: 0,
      messagesByDate: {},
      lastActive: null,
      voiceInputs: 2,
      screenshots: 0,
      searches: 0,
    };
    const now = Date.now();

    const week = await getStatsSnapshot({ range: '7d', now });
    expect(week.tools).toEqual({ voice: 0, screenshot: 0, search: 0 });

    const all = await getStatsSnapshot({ range: 'all', now });
    expect(all.tools).toEqual({ voice: 2, screenshot: 0, search: 0 });
  });
});

describe('outcomes math', () => {
  it('counts outcomes, excludes cancelled from rate and attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const now = Date.now();

    await recordGenerationResults([
      { dedupId: 'a', outcome: 'completed', modelId: 'flash', provider: 'gemini', durationMs: 200 },
      { dedupId: 'b', outcome: 'error', modelId: 'flash', provider: 'gemini' },
      { dedupId: 'c', outcome: 'interrupted' },
      { dedupId: 'd', outcome: 'cancelled', modelId: 'flash', provider: 'gemini' },
    ]);

    const snap = await getStatsSnapshot({ range: '7d', now });
    expect(snap.outcomes).toEqual({ completed: 1, error: 1, interrupted: 1, cancelled: 1 });
    expect(snap.successRate).toBeCloseTo(1 / 3);
    expect(snap.avgSuccessDurationMs).toBe(200);
    expect(snap.models).toHaveLength(1);
    expect(snap.models[0]).toMatchObject({
      modelKey: 'gemini:flash',
      modelId: 'flash',
      provider: 'gemini',
      attempts: 2,
      successes: 1,
    });
    expect(snap.models[0].avgSuccessDurationMs).toBe(200);
    expect(snap.models[0].successRate).toBeCloseTo(0.5);
    expect(snap.hasAnyData).toBe(true);
  });

  it('returns null rate and avg when there are no completed runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const now = Date.now();

    await recordGenerationResults([{ dedupId: 'x', outcome: 'cancelled' }]);
    const snap = await getStatsSnapshot({ range: '7d', now });
    expect(snap.outcomes.cancelled).toBe(1);
    expect(snap.successRate).toBeNull();
    expect(snap.avgSuccessDurationMs).toBeNull();
  });

  it('ignores non-finite or negative durations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const now = Date.now();

    await recordGenerationResults([
      { dedupId: 'a', outcome: 'completed', durationMs: -5 },
      { dedupId: 'b', outcome: 'completed', durationMs: null },
    ]);
    const snap = await getStatsSnapshot({ range: '7d', now });
    expect(snap.outcomes.completed).toBe(2);
    expect(snap.avgSuccessDurationMs).toBe(0);
  });
});

describe('dedup and bounds', () => {
  it('counts the same dedupId only once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const entry = { dedupId: 'same', outcome: 'completed', durationMs: 50 };
    await recordGenerationResults([entry]);
    await recordGenerationResults([entry]);

    expect(store.stats.lifetime.byOutcome.completed).toBe(1);
    expect(store.stats.recentFinalizedIds).toEqual(['same']);
    const snap = await getStatsSnapshot({ now: Date.now() });
    expect(snap.outcomes.completed).toBe(1);
  });

  it('caps recentFinalizedIds at 100 FIFO', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const batch = Array.from({ length: 105 }, (_, i) => ({
      dedupId: `id-${i}`,
      outcome: 'completed',
    }));
    await recordGenerationResults(batch);

    expect(store.stats.recentFinalizedIds).toHaveLength(100);
    expect(store.stats.recentFinalizedIds[0]).toBe('id-5');
    expect(store.stats.recentFinalizedIds[99]).toBe('id-104');
    expect(store.stats.lifetime.byOutcome.completed).toBe(105);
  });
});

describe('prompt plus variant results', () => {
  it('counts one prompt with two variant results', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    const now = Date.now();

    await recordPromptStarted();
    await recordGenerationResults([
      { dedupId: 'v1', outcome: 'completed', modelId: 'm1', provider: 'p1', durationMs: 100 },
      { dedupId: 'v2', outcome: 'error', modelId: 'm1', provider: 'p1' },
    ]);

    const snap = await getStatsSnapshot({ now });
    expect(snap.promptsTotal).toBe(1);
    expect(snap.outcomes.completed).toBe(1);
    expect(snap.outcomes.error).toBe(1);
    expect(store.stats.lifetime.prompts).toBe(1);
  });
});

describe('sessions and empty snapshot', () => {
  it('reports sessionCount from the sessions key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
    store.sessions = [{ id: 1 }, { id: 2 }];
    const snap = await getStatsSnapshot({ now: Date.now() });
    expect(snap.sessionCount).toBe(2);
  });

  it('empty store yields hasAnyData false with null aggregates', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 12, 12, 0, 0);
    vi.setSystemTime(now);
    const snap = await getStatsSnapshot({ now: now.getTime() });

    expect(snap.hasAnyData).toBe(false);
    expect(snap.promptsTotal).toBe(0);
    expect(snap.avgSuccessDurationMs).toBeNull();
    expect(snap.successRate).toBeNull();
    expect(snap.models).toEqual([]);
    expect(snap.sessionCount).toBe(0);
    expect(snap.lastActive).toBeNull();
    expect(snap.activity).toHaveLength(7);
  });

  it('never throws without chrome', async () => {
    delete globalThis.chrome;
    await expect(recordPromptStarted()).resolves.toBeUndefined();
    await expect(recordGenerationResults([{ dedupId: 'a', outcome: 'completed' }])).resolves.toBeUndefined();
    await expect(recordToolUsage('voice')).resolves.toBeUndefined();
    const snap = await getStatsSnapshot();
    expect(snap.hasAnyData).toBe(false);
  });
});
