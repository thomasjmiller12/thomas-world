import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  FeedResponse,
  type ChronicleItem,
  type ChronicleIssue,
  type DayPhase,
  type FeedItem,
} from '@town/contract';
import type { ThomasId } from '@/lib/types';
import { EventBus } from '@/game/EventBus';
import { WorldClient } from '@/game/systems/WorldClient';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { useAgentStatuses } from '@/lib/useAgentStatuses';
import { fetchChronicle } from '@/components/chronicle/chronicleClient';
import { relativeDayLabel } from '@/components/chronicle/chroniclePresentation';
import { TodayTab } from '@/components/chronicle/TodayTab';
import { ConversationsTab } from '@/components/chronicle/ConversationsTab';
import { MadeTab } from '@/components/chronicle/MadeTab';
import { BoardTab } from '@/components/chronicle/BoardTab';
import { MessagesTab } from '@/components/chronicle/MessagesTab';
import { ArtifactReader } from '@/components/chronicle/ArtifactReader';

// ObserveDashboard — the observer-only surface (/observe). Everything a visitor
// can see, none of what a visitor can do: live agent presence + activity, the
// streaming world feed, artifacts, bulletins, DMs/broadcasts, conversations.
// Boots a WorldClient in observe mode: no visitor registration, no presence,
// no chat — agents cannot perceive an observer.

type Tab = 'live' | 'today' | 'conversations' | 'made' | 'board' | 'messages';

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'today', label: 'Today' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'made', label: 'Made' },
  { id: 'board', label: 'Board' },
  { id: 'messages', label: 'Messages' },
];

const AGENT_IDS = Object.keys(NPC_CONFIGS) as ThomasId[];

export function ObserveDashboard() {
  const statuses = useAgentStatuses();
  const [phase, setPhase] = useState<DayPhase>('afternoon');
  const [awake, setAwake] = useState(true);
  const [tab, setTab] = useState<Tab>('live');
  const [readerId, setReaderId] = useState<string | null>(null);

  // Chronicle day state (Today / Conversations).
  const [day, setDay] = useState<string | null>(null);
  const [items, setItems] = useState<ChronicleItem[]>([]);
  const [issue, setIssue] = useState<ChronicleIssue | null>(null);
  const [days, setDays] = useState<string[]>([]);
  const [resolvedDay, setResolvedDay] = useState('');
  const [chronicleLoading, setChronicleLoading] = useState(false);
  const [chronicleError, setChronicleError] = useState(false);
  const reqSeq = useRef(0);

  // Boot the observe-mode client once: snapshot + SSE, no identity.
  useEffect(() => {
    const world = new WorldClient('Observer', { observe: true });
    void world.start();
    const onWorldState = (w: { phase: DayPhase; awake: boolean }) => {
      setPhase(w.phase);
      setAwake(w.awake);
    };
    EventBus.on('world-state', onWorldState);
    return () => {
      EventBus.off('world-state', onWorldState);
      world.stop();
    };
  }, []);

  // Chronicle loading (mirrors ChroniclePanel, without the overlay chrome).
  useEffect(() => {
    if (tab !== 'today' && tab !== 'conversations') return;
    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setChronicleLoading(true);
    setChronicleError(false);
    fetchChronicle({ day, signal: ctrl.signal })
      .then((page) => {
        if (seq !== reqSeq.current) return;
        setItems(page.items);
        setIssue(page.issue);
        setDays(page.days);
        setResolvedDay(page.day);
      })
      .catch(() => {
        if (seq === reqSeq.current) setChronicleError(true);
      })
      .finally(() => {
        if (seq === reqSeq.current) setChronicleLoading(false);
      });
    return () => ctrl.abort();
  }, [day, tab]);

  const dayIdx = days.indexOf(resolvedDay);
  const hasNewer = dayIdx > 0;
  const hasOlder = dayIdx >= 0 && dayIdx < days.length - 1;
  const showDayNav = tab === 'today' || tab === 'conversations';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '20px 18px 60px' }}>
        {/* ── header ── */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ font: '700 26px var(--display)', margin: 0 }}>Thomas&apos;s Town</h1>
          <span
            style={{
              font: '600 10px var(--mono)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              border: '1px solid var(--line-2)',
              borderRadius: 999,
              padding: '3px 10px',
            }}
          >
            observing · {awake ? phase : 'asleep'}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
            <Link
              href="/town?observe=1"
              style={{ font: '600 12.5px var(--sans)', color: 'var(--ink-2)' }}
            >
              watch the town →
            </Link>
            <Link href="/" style={{ font: '600 12.5px var(--sans)', color: 'var(--career)' }}>
              enter the town →
            </Link>
          </span>
        </div>
        <p style={{ font: '400 13px var(--sans)', color: 'var(--ink-2)', margin: '6px 0 18px' }}>
          Five AI facets of Thomas live here around the clock. You&apos;re watching through the
          window — they can&apos;t see you.
        </p>

        {/* ── live agent cards ── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 10,
            marginBottom: 20,
          }}
        >
          {AGENT_IDS.map((id) => {
            const config = NPC_CONFIGS[id];
            const s = statuses[id];
            return (
              <div
                key={id}
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderTop: `3px solid ${config.color}`,
                  borderRadius: 12,
                  padding: '10px 12px',
                  minHeight: 86,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ font: '700 12.5px var(--sans)', color: config.color }}>
                    {config.displayName.replace(' Thomas', '')}
                  </span>
                  <span style={{ font: '400 10px var(--mono)', color: 'var(--ink-3)' }}>
                    {s ? `· ${s.locationId}` : ''}
                  </span>
                  {s?.busy && (
                    <span title="in a conversation" style={{ marginLeft: 'auto', fontSize: 10 }}>
                      💬
                    </span>
                  )}
                </div>
                <p
                  style={{
                    font: '400 11.5px var(--sans)',
                    color: 'var(--ink-2)',
                    margin: '5px 0 0',
                    lineHeight: 1.4,
                  }}
                >
                  {s?.activity ?? '…'}
                </p>
              </div>
            );
          })}
        </div>

        {/* ── tab strip (+ day nav for chronicle tabs) ── */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            borderBottom: '1px solid var(--line)',
            marginBottom: 16,
          }}
        >
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setReaderId(null);
                }}
                aria-pressed={on}
                style={{
                  padding: '9px 13px',
                  border: 'none',
                  background: 'transparent',
                  font: `${on ? 700 : 600} 13px var(--sans)`,
                  color: on ? 'var(--ink)' : 'var(--ink-3)',
                  borderBottom: `2px solid ${on ? 'var(--ink)' : 'transparent'}`,
                  cursor: 'pointer',
                  marginBottom: -1,
                }}
              >
                {t.label}
              </button>
            );
          })}
          {showDayNav && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <DayArrow dir="‹" disabled={!hasOlder} onClick={() => hasOlder && setDay(days[dayIdx + 1])} />
              <span style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-2)', textTransform: 'uppercase' }}>
                {resolvedDay ? relativeDayLabel(resolvedDay) : '…'}
              </span>
              <DayArrow dir="›" disabled={!hasNewer} onClick={() => hasNewer && setDay(days[dayIdx - 1])} />
            </span>
          )}
        </div>

        {/* ── body ── */}
        {readerId ? (
          <ArtifactReader artifactId={readerId} onBack={() => setReaderId(null)} />
        ) : (
          <>
            {tab === 'live' && <LiveFeed />}
            {tab === 'today' && (
              <TodayTab
                items={items}
                issue={issue}
                loading={chronicleLoading}
                error={chronicleError}
                onOpenArtifact={setReaderId}
                onOpenCitation={(c) => {
                  const href = c.href ?? '';
                  if (href.startsWith('artifact:')) setReaderId(href.slice('artifact:'.length));
                }}
                onGoToDay={setDay}
              />
            )}
            {tab === 'conversations' && (
              <ConversationsTab items={items} loading={chronicleLoading} error={chronicleError} />
            )}
            {tab === 'made' && <MadeTab onOpenArtifact={setReaderId} />}
            {tab === 'board' && <BoardTab onOpenArtifact={setReaderId} />}
            {tab === 'messages' && <MessagesTab />}
          </>
        )}
      </div>
    </div>
  );
}

function DayArrow({ dir, disabled, onClick }: { dir: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--line-2)' : 'var(--ink-3)',
        fontSize: 15,
        cursor: disabled ? 'default' : 'pointer',
        padding: '0 2px',
      }}
    >
      {dir}
    </button>
  );
}

// ── Live feed: the rendered world feed, refreshed when live events stream in ──

const FEED_LIMIT = 60;
// Visitor churn stays out of the observer's live view — agent life is the point.
const HIDDEN_TYPES = new Set(['visitor.arrived', 'visitor.left', 'visitor.moved']);

function LiveFeed() {
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [error, setError] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const base = resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);
      const res = await fetch(`${base}/feed?limit=${FEED_LIMIT}`);
      if (!res.ok) throw new Error(String(res.status));
      const parsed = FeedResponse.parse(await res.json());
      setFeedItems(parsed.items.filter((it) => !HIDDEN_TYPES.has(it.type ?? '')));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Debounced refetch on any live event: the server renders feed lines, so a
    // single re-fetch after a burst keeps the view live without re-implementing
    // the line renderer client-side.
    const onEvent = () => {
      if (refetchTimer.current) return;
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        void load();
      }, 1_200);
    };
    EventBus.on('world-event', onEvent);
    return () => {
      EventBus.off('world-event', onEvent);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [load]);

  if (error) {
    return (
      <p style={{ color: 'var(--ink-3)', font: '400 13px var(--sans)' }}>
        The town is unreachable right now — try again shortly.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {feedItems.map((it) => (
        <FeedLine key={it.id} item={it} />
      ))}
      {feedItems.length === 0 && (
        <p style={{ color: 'var(--ink-3)', font: '400 13px var(--sans)' }}>Nothing yet today.</p>
      )}
    </div>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  const color = item.agent ? NPC_CONFIGS[item.agent as ThomasId]?.color : undefined;
  const time = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ font: '400 10px var(--mono)', color: 'var(--ink-3)', flexShrink: 0 }}>
        {time}
      </span>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color ?? 'var(--line-2)',
          flexShrink: 0,
          position: 'relative',
          top: -1,
        }}
      />
      <span style={{ font: '400 13px var(--sans)', color: 'var(--ink)', lineHeight: 1.45 }}>
        {item.line}
      </span>
    </div>
  );
}
