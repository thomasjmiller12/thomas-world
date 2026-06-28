import { useEffect, useRef, useState } from 'react';
import type { Message, MessageScope } from '@town/contract';
import type { ThomasId } from '@/lib/types';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { fetchMessages } from './chronicleClient';

// MessagesTab — the agents' mail: DMs between facets + broadcasts to everyone.
// Bodies are public by design (M2 veto-point default). Scope chips filter;
// long bodies clamp with a "more" expander; cursor-paged "load older".

const SCOPES: { id: MessageScope | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'dm', label: 'DMs' },
  { id: 'broadcast', label: 'Broadcasts' },
];

function agentName(id: string): string {
  return NPC_CONFIGS[id as ThomasId]?.displayName ?? id;
}

function agentColor(id: string): string {
  return NPC_CONFIGS[id as ThomasId]?.color ?? 'var(--ink-2)';
}

function timeLabel(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

export function MessagesTab({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const [scope, setScope] = useState<MessageScope | 'all'>('all');
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const reqSeq = useRef(0);

  // (Re)load on scope change.
  useEffect(() => {
    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    fetchMessages({ scope: scope === 'all' ? null : scope, signal: ctrl.signal })
      .then((page) => {
        if (seq !== reqSeq.current) return;
        setMessages(page.messages);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (seq === reqSeq.current) setError(true);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
    return () => ctrl.abort();
  }, [scope, refreshNonce]);

  const loadOlder = () => {
    if (!cursor || loading) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    fetchMessages({ scope: scope === 'all' ? null : scope, cursor })
      .then((page) => {
        if (seq !== reqSeq.current) return;
        setMessages((prev) => [...prev, ...page.messages]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (seq === reqSeq.current) setError(true);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
  };

  return (
    <div>
      {/* scope chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {SCOPES.map((s) => {
          const on = scope === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setScope(s.id)}
              aria-pressed={on}
              style={{
                padding: '5px 12px',
                borderRadius: 999,
                border: `1px solid ${on ? 'var(--ink)' : 'var(--line-2)'}`,
                background: on ? 'var(--ink)' : '#fff',
                color: on ? '#fff' : 'var(--ink-2)',
                font: '600 11.5px var(--sans)',
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {error && (
        <p style={{ color: 'var(--ink-3)', font: '400 13px var(--sans)' }}>
          The mail room is unreachable right now. Try again shortly.
        </p>
      )}
      {!error && !loading && messages.length === 0 && (
        <p style={{ color: 'var(--ink-3)', font: '400 13px var(--sans)' }}>
          No messages yet — the facets haven&apos;t written to each other.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </div>

      {cursor && (
        <button
          onClick={loadOlder}
          disabled={loading}
          style={{
            marginTop: 14,
            padding: '7px 14px',
            borderRadius: 8,
            border: '1px solid var(--line-2)',
            background: '#fff',
            color: 'var(--ink-2)',
            font: '600 12px var(--sans)',
            cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? 'loading…' : 'load older'}
        </button>
      )}
    </div>
  );
}

const CLAMP_CHARS = 280;

function MessageRow({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const long = message.body.length > CLAMP_CHARS;
  const body = expanded || !long ? message.body : `${message.body.slice(0, CLAMP_CHARS)}…`;
  const broadcast = message.to == null;

  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '10px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ font: '700 12.5px var(--sans)', color: agentColor(message.from) }}>
          {agentName(message.from)}
        </span>
        <span style={{ font: '400 11px var(--sans)', color: 'var(--ink-3)' }}>
          {broadcast ? '→ everyone' : `→ ${agentName(message.to!)}`}
        </span>
        {broadcast && (
          <span
            style={{
              font: '600 9px var(--mono)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              border: '1px solid var(--line-2)',
              borderRadius: 999,
              padding: '1px 7px',
            }}
          >
            broadcast
          </span>
        )}
        <span style={{ marginLeft: 'auto', font: '400 10.5px var(--mono)', color: 'var(--ink-3)' }}>
          {timeLabel(message.ts)}
        </span>
      </div>
      <p style={{ font: '400 13px var(--sans)', color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: 0 }}>
        {body}
      </p>
      {long && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: 4,
            border: 'none',
            background: 'transparent',
            color: 'var(--ink-3)',
            font: '600 11px var(--sans)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {expanded ? 'less ↑' : 'more ↓'}
        </button>
      )}
    </div>
  );
}
