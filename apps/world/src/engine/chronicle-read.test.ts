import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldEvent } from "@town/contract";

const state = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[], summaries: [] as Record<string, unknown>[],
  issues: [] as Record<string, unknown>[], configured: false,
  generate: vi.fn(), appended: vi.fn(async (_event: unknown) => undefined), eventReads: 0,
}));
vi.mock("../db/client.js", async () => {
  const schema = await import("../db/schema.js");
  return { schema, db: {
    select(fields?: Record<string, unknown>) {
      return { from(table: unknown) {
        let grouped = false;
        const query = {
          where() { return query; }, orderBy() { return query; }, limit() { return query; },
          groupBy() { grouped = true; return query; },
          then(resolve: (rows: unknown[]) => unknown) {
            if (table === schema.worldEvents) {
              if (!grouped) state.eventReads++;
              return Promise.resolve(resolve(grouped ? [{ day: '2026-09-23' }] : [...state.events]));
            }
            if (table === schema.threadSummaries) return Promise.resolve(resolve([...state.summaries]));
            if (table === schema.chronicleIssues) return Promise.resolve(resolve(fields ? [] : [...state.issues]));
            return Promise.resolve(resolve([]));
          },
        };
        return query;
      } };
    },
    insert(table: unknown) { return { values(value: Record<string, unknown>) {
      return {
        onConflictDoNothing() { state.summaries.push(value); return Promise.resolve(); },
        onConflictDoUpdate() { if (table === schema.chronicleIssues) state.issues = [value]; return Promise.resolve(); },
      };
    } }; },
  } };
});
vi.mock("../runtime/llm/provider.js", () => ({ hasLlm: () => state.configured, getLlmProvider: () => ({ generateText: state.generate }) }));
vi.mock("./events.js", () => ({ appendEvent: state.appended }));
vi.mock("./usage.js", () => ({ recordNormalizedUsage: vi.fn() }));
const { getChronicle, _resetChronicleForTest } = await import("./chronicle.js");
const { _resetCrierCachesForTest } = await import("./chronicle-issue.js");
const { publish } = await import("./bus.js");

const day = '2026-09-23';
const issueText = JSON.stringify({ title: 'Bench work', subtitle: null, lead: { bodyMd: 'Builder worked at the bench. [S1]', citationIds: ['S1'] }, sections: [] });
const event = (id: number, minutesAgo = 20) => ({
  id, ts: new Date(Date.now() - minutesAgo * 60_000), type: 'agent.spoke', agentId: 'builder', locationId: 'workshop', visitorId: null, visibility: 'location',
  payload: { agent: 'builder', location: 'workshop', text: `Bench observation ${id}` },
});
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  _resetChronicleForTest(); _resetCrierCachesForTest();
  state.events = [event(1)]; state.summaries = []; state.issues = []; state.configured = false; state.eventReads = 0;
  state.appended.mockClear(); state.generate.mockReset();
});

describe('Chronicle nonblocking reads', () => {
  it('returns a deterministic edition while a slow provider runs, coalesces reads, and announces completion', async () => {
    state.configured = true;
    let resolveSummary!: (value: string) => void;
    state.generate.mockImplementationOnce(() => new Promise<string>(resolve => { resolveSummary = resolve; })).mockResolvedValue(issueText);
    const first = await getChronicle(day);
    expect(first.issue?.status).toBe('fallback');
    expect(first.generationPending).toBe(true);
    const second = await getChronicle(day);
    expect(second.generationPending).toBe(true);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.appended).not.toHaveBeenCalled();
    resolveSummary('Working on the bench');
    await settle();
    expect(state.appended).toHaveBeenCalledExactlyOnceWith({ type: 'chronicle.updated', visibility: 'public', payload: { day } });
    const completed = await getChronicle(day);
    expect(completed.generationPending).toBe(false);
    expect(completed.issue?.status).toBe('ready');
    expect(completed.items[0]).toMatchObject({ summary: 'Working on the bench' });
    expect(state.generate).toHaveBeenCalledTimes(2);
  });

  it('preserves useful and quiet editions with no provider, without polling or provider work', async () => {
    const populated = await getChronicle(day);
    expect(populated.issue?.status).toBe('fallback');
    expect(populated.generationPending).toBe(false);
    state.events = [];
    _resetChronicleForTest();
    const empty = await getChronicle(day);
    expect(empty.issue?.status).toBe('empty');
    expect(empty.generationPending).toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.appended).not.toHaveBeenCalled();
  });

  it('evicts cached timelines immediately after public commits, but ignores private events', async () => {
    await getChronicle(day);
    await getChronicle(day);
    expect(state.eventReads).toBe(1);
    const added = event(2, 19);
    state.events.push(added);
    publish({ ...added, id: '2', ts: added.ts.toISOString(), visibility: 'private' } as WorldEvent);
    await getChronicle(day);
    expect(state.eventReads).toBe(1);
    publish({ ...added, id: '2', ts: added.ts.toISOString() } as WorldEvent);
    const fresh = await getChronicle(day);
    expect(state.eventReads).toBe(2);
    expect(fresh.items[0]).toMatchObject({ turns: [{ text: 'Bench observation 1' }, { text: 'Bench observation 2' }] });
  });

  it('limits provider work to two days at a time', async () => {
    state.configured = true;
    const releases: Array<(text: string) => void> = [];
    state.generate.mockImplementation((request: { maxOutputTokens: number }) => request.maxOutputTokens === 64
      ? new Promise<string>(resolve => releases.push(resolve))
      : Promise.resolve(issueText));
    expect((await getChronicle(day)).generationPending).toBe(true);
    expect((await getChronicle('2026-09-22')).generationPending).toBe(true);
    expect((await getChronicle('2026-09-21')).generationPending).toBe(false);
    expect(releases).toHaveLength(2);
    releases.forEach(resolve => resolve('Bench task'));
    await settle();
    expect(state.appended).toHaveBeenCalledTimes(2);
  });

  it('caps each batch at five summaries and does not drain a backlog through completion refreshes', async () => {
    state.configured = true;
    state.events = Array.from({ length: 8 }, (_, i) => event(i + 1, 200 - i * 15));
    state.generate.mockImplementation(async (request: { maxOutputTokens: number }) => request.maxOutputTokens === 64 ? 'Bench task' : issueText);
    await getChronicle(day);
    await settle();
    expect(state.summaries).toHaveLength(5);
    expect(state.generate).toHaveBeenCalledTimes(6);
    const followup = await getChronicle(day);
    expect(followup.generationPending).toBe(false);
    expect(state.generate).toHaveBeenCalledTimes(6);
  });
});
