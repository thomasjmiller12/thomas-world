import type { ChronicleItem } from '@town/contract';
import { ThreadRow } from './ThreadRow';

// ConversationsTab — the day's room-talk threads only (M2.1). Same progressive-
// disclosure rows as the Today digest, filtered to `kind === 'thread'` so the
// visitor can browse the agents' emergent conversations without the artifact /
// presence noise.

interface Props {
  items: ChronicleItem[];
  loading: boolean;
  error: boolean;
}

export function ConversationsTab({ items, loading, error }: Props) {
  const threads = items.filter((i): i is Extract<ChronicleItem, { kind: 'thread' }> => i.kind === 'thread');

  if (loading && threads.length === 0) {
    return (
      <div style={{ padding: '12px 4px', font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em' }}>
        LOADING…
      </div>
    );
  }

  if (error && threads.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        The town&apos;s day hasn&apos;t loaded yet. It may be dreaming.
      </div>
    );
  }

  if (!loading && threads.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        No one has talked yet today.
      </div>
    );
  }

  return (
    <div>
      {threads.map((t, i) => (
        <ThreadRow key={t.id} thread={t} last={i === threads.length - 1} />
      ))}
    </div>
  );
}
