import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChronicleItem, ChronicleIssue, ChronicleCitation } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { fetchChronicle } from './chronicleClient';
import { relativeDayLabel } from './chroniclePresentation';
import { TodayTab } from './TodayTab';
import { ConversationsTab } from './ConversationsTab';
import { MadeTab } from './MadeTab';
import { BoardTab } from './BoardTab';
import { MessagesTab } from './MessagesTab';
import { ArtifactReader } from './ArtifactReader';

// ChroniclePanel — the full-screen "Town Chronicle" hub (M2.1, replaces the
// feed side panel). An ink-toned scrim leaves the town visibly alive behind it;
// a centered paper card (~860px / ~90vh; full-screen below ~720px tall) holds
// the header, a Today · Conversations · Made · Board tab strip, and the active
// tab body. Progressive disclosure: list views first; an artifact opens the
// in-hub ArtifactReader, and ESC pops the reader back to the list before it
// closes the hub.
//
// FOCUS / Z-ORDER CONTRACT (for the chat-stage agent): the hub owns the keyboard
// while mounted — it emits `dialog-opened` on mount and `dialog-closed` on
// unmount (the established hook that freezes player movement). It renders at
// z-index 60, ABOVE the docked chat (40) and the feed-era 41 — opening the hub
// does NOT tear down a live chat; the chat keeps streaming underneath. The chat
// stage must not assume it owns `dialog-opened`/`dialog-closed` exclusively.

type Tab = 'today' | 'conversations' | 'made' | 'board' | 'messages';

// World-event types that can change today's Chronicle — a debounced refetch
// fires when one streams in (while viewing the latest day). Kept narrow so
// ambient noise (moves, thoughts, visitor presence) doesn't trigger refetches.
const CHRONICLE_LIVE_TYPES = new Set<string>([
  'agent.spoke',
  'artifact.created',
  'artifact.updated',
  'message.sent',
  'bulletin.posted',
  'capability.requested',
]);

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'made', label: 'Made' },
  { id: 'board', label: 'Board' },
  { id: 'messages', label: 'Messages' },
];

export interface ChroniclePanelProps {
  onClose: () => void;
  // Initial tab (default 'today'). "see their day →" opens 'today'.
  initialTab?: Tab;
  // Initial day key (YYYY-MM-DD) to load; omitted => the latest day the server has.
  initialDay?: string | null;
  // Open this artifact in the in-hub reader on mount (deep-link from a share
  // card / Town Crier citation).
  initialArtifactId?: string | null;
}

export function ChroniclePanel({ onClose, initialTab = 'today', initialDay = null, initialArtifactId = null }: ChroniclePanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [day, setDay] = useState<string | null>(initialDay);
  // Chronicle (day-scoped) state — Today + Conversations read from this.
  const [items, setItems] = useState<ChronicleItem[]>([]);
  const [issue, setIssue] = useState<ChronicleIssue | null>(null);
  const [days, setDays] = useState<string[]>([]);
  const [resolvedDay, setResolvedDay] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // The artifact open in the in-hub reader (null => list view). Reader overlays
  // any tab; ESC pops it before closing the hub.
  const [readerId, setReaderId] = useState<string | null>(initialArtifactId);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Bumped on a live (silent) refresh so the self-fetching tabs (Made / Board /
  // Messages) re-pull too — Today / Conversations refresh via `items` directly.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const reqSeq = useRef(0);

  // Freeze player movement while the hub owns the keyboard (the established
  // dialog-opened/closed hook). Mount/unmount only.
  useEffect(() => {
    EventBus.emit('dialog-opened');
    return () => {
      EventBus.emit('dialog-closed');
    };
  }, []);

  // Load a day's chronicle. `silent` (live refresh) skips the loading skeleton
  // so a background update doesn't flash the panel.
  const loadChronicle = useCallback(
    (targetDay: string | null, silent: boolean) => {
      const seq = ++reqSeq.current;
      const ctrl = new AbortController();
      if (!silent) {
        setLoading(true);
        setError(false);
      }
      fetchChronicle({ day: targetDay, signal: ctrl.signal })
        .then((page) => {
          if (seq !== reqSeq.current) return;
          setItems(page.items);
          setIssue(page.issue);
          setDays(page.days);
          setResolvedDay(page.day);
        })
        .catch(() => {
          if (seq !== reqSeq.current || silent) return;
          setError(true);
        })
        .finally(() => {
          if (seq === reqSeq.current && !silent) setLoading(false);
        });
      return () => ctrl.abort();
    },
    [],
  );

  // (Re)load the chronicle whenever the selected day changes (user-driven).
  useEffect(() => loadChronicle(day, false), [day, loadChronicle]);

  // Live refresh: while viewing the latest day with no reader open, re-pull on a
  // debounced burst of world events (and on tab-focus regain) so the Chronicle
  // keeps up without a manual refresh / room switch. Refs let the stable event
  // handler read current state without re-subscribing.
  const liveRef = useRef({ day, resolvedDay, days, readerId });
  liveRef.current = { day, resolvedDay, days, readerId };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isLatestDay = () => {
      const { day: d, resolvedDay: rd, days: ds } = liveRef.current;
      return d === null || ds.length === 0 || rd === ds[0];
    };
    const scheduleRefresh = () => {
      if (liveRef.current.readerId || !isLatestDay()) return;
      if (timer) return; // coalesce a burst into one refetch
      timer = setTimeout(() => {
        timer = null;
        if (liveRef.current.readerId || !isLatestDay()) return;
        loadChronicle(liveRef.current.day, true);
        setRefreshNonce((n) => n + 1);
      }, 4_000);
    };
    const onWorldEvent = (ev: { type: string }) => {
      if (CHRONICLE_LIVE_TYPES.has(ev.type)) scheduleRefresh();
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        scheduleRefresh();
      }
    };
    EventBus.on('world-event', onWorldEvent);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      EventBus.off('world-event', onWorldEvent);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadChronicle]);

  // Resolve a Town Crier citation to its source. Artifact citations open the
  // in-hub reader; thread citations switch to Conversations; reference/proof
  // citations hand off to App (open-card-target → the About hub).
  const handleOpenCitation = useCallback((citation: ChronicleCitation) => {
    const href = citation.href ?? '';
    if (href.startsWith('artifact:')) setReaderId(href.slice('artifact:'.length));
    else if (href.startsWith('thread:')) setTab('conversations');
    else if (href.startsWith('reference:') || href.startsWith('proof:')) {
      EventBus.emit('open-card-target', { href });
    }
  }, []);

  // ESC: pop the reader first, then close the hub.
  const handleEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (readerId) {
        setReaderId(null);
      } else if (pickerOpen) {
        setPickerOpen(false);
      } else {
        onClose();
      }
    },
    [readerId, pickerOpen, onClose],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleEsc]);

  // Day arrows step through `days` (which is desc — newest first).
  const dayIdx = days.indexOf(resolvedDay);
  const hasNewer = dayIdx > 0;
  const hasOlder = dayIdx >= 0 && dayIdx < days.length - 1;
  const goNewer = () => hasNewer && setDay(days[dayIdx - 1]);
  const goOlder = () => hasOlder && setDay(days[dayIdx + 1]);

  return (
    <div
      className="pointer-events-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Town Chronicle"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // ink-toned scrim — the town stays visibly alive behind it
        background: 'rgba(43,38,32,.45)',
        animation: 'fadeInScrim .18s ease-out',
      }}
      onClick={(e) => {
        // backdrop click closes (but not clicks inside the card)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 860,
          maxWidth: '100%',
          height: '90vh',
          maxHeight: '100%',
          background: 'var(--paper)',
          borderRadius: 18,
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'var(--sans)',
          animation: 'riseInHub .22s ease-out',
        }}
      >
        {/* ── header ── */}
        <div style={{ padding: '18px 24px 0', background: 'var(--paper-2)', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ font: '700 24px var(--display)', color: 'var(--ink)' }}>Town Chronicle</div>

            {/* day chip + picker */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowBtn dir="‹" disabled={!hasOlder} onClick={goOlder} title="Older day" />
              <button
                onClick={() => setPickerOpen((v) => !v)}
                aria-expanded={pickerOpen}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 999,
                  border: '1px solid var(--line-2)',
                  background: '#fff',
                  font: '400 10.5px var(--mono)',
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-2)',
                  cursor: 'pointer',
                }}
              >
                {resolvedDay ? relativeDayLabel(resolvedDay) : '…'} ▾
              </button>
              <ArrowBtn dir="›" disabled={!hasNewer} onClick={goNewer} title="Newer day" />

              {pickerOpen && days.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: '110%',
                    left: 28,
                    zIndex: 2,
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    boxShadow: 'var(--shadow)',
                    padding: 6,
                    maxHeight: 240,
                    overflowY: 'auto',
                    minWidth: 150,
                  }}
                >
                  {days.map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        setDay(d);
                        setPickerOpen(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '7px 10px',
                        borderRadius: 7,
                        border: 'none',
                        background: d === resolvedDay ? 'var(--paper-2)' : 'transparent',
                        font: '600 12.5px var(--sans)',
                        color: d === resolvedDay ? 'var(--ink)' : 'var(--ink-2)',
                        cursor: 'pointer',
                      }}
                    >
                      {relativeDayLabel(d)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={onClose}
              aria-label="Close chronicle"
              style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--ink-3)', fontSize: 22, lineHeight: 1, cursor: 'pointer' }}
            >
              ×
            </button>
          </div>

          {/* ── tab strip ── */}
          <div style={{ display: 'flex', gap: 4, marginTop: 14 }}>
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
                    padding: '9px 15px',
                    border: 'none',
                    background: 'transparent',
                    font: `${on ? 700 : 600} 13.5px var(--sans)`,
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
          </div>
        </div>

        {/* ── body ── */}
        {/* MadeTab + ArtifactReader own their internal scroll (they're flex
            columns); Today/Conversations/Board scroll in this body. */}
        <div style={{ flex: 1, overflowY: tab === 'made' || readerId ? 'hidden' : 'auto', padding: '16px 24px 24px', minHeight: 0 }}>
          {readerId ? (
            <ArtifactReader artifactId={readerId} onBack={() => setReaderId(null)} />
          ) : (
            <>
              {tab === 'today' && (
                <TodayTab
                  items={items}
                  issue={issue}
                  loading={loading}
                  error={error}
                  onOpenArtifact={setReaderId}
                  onOpenCitation={handleOpenCitation}
                  onGoToDay={setDay}
                />
              )}
              {tab === 'conversations' && (
                <ConversationsTab items={items} loading={loading} error={error} />
              )}
              {tab === 'made' && <MadeTab onOpenArtifact={setReaderId} refreshNonce={refreshNonce} />}
              {tab === 'board' && <BoardTab onOpenArtifact={setReaderId} refreshNonce={refreshNonce} />}
              {tab === 'messages' && <MessagesTab refreshNonce={refreshNonce} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ArrowBtn({ dir, disabled, onClick, title }: {
  dir: string; disabled: boolean; onClick: () => void; title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--line-2)' : 'var(--ink-3)',
        fontSize: 16,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        padding: '2px 4px',
      }}
    >
      {dir}
    </button>
  );
}
