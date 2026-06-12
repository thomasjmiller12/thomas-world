import { useEffect, useState } from 'react';
import type { ArtifactSummary } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { SpritePortrait, agentShortName } from '@/components/chat/primitives';
import { fetchArtifacts } from './chronicleClient';
import { headerDate } from './chroniclePresentation';

// BoardTab — the town notice board (M2.1). Bulletins as pinned-note cards on
// --paper-2 with a slight per-card rotation for a corkboard feel, newest first.
// Selecting a note opens the full bulletin in the hub's ArtifactReader.

interface Props {
  onOpenArtifact: (id: string) => void;
}

// Deterministic ±0.5deg tilt from the artifact id so a card doesn't jump on
// re-render (a hash, not Math.random).
function tiltFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  // map to [-0.5, 0.5]
  return ((Math.abs(h) % 100) / 100 - 0.5);
}

export function BoardTab({ onOpenArtifact }: Props) {
  const [bulletins, setBulletins] = useState<ArtifactSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    fetchArtifacts({ kind: 'bulletin', signal: ctrl.signal })
      .then((list) => {
        // newest first
        const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setBulletins(sorted);
      })
      .catch(() => setError(true))
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  if (loading && bulletins.length === 0) {
    return (
      <div style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', padding: '8px 2px' }}>
        LOADING…
      </div>
    );
  }
  if (error && bulletins.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        The board hasn&apos;t loaded yet. The town may be dreaming.
      </div>
    );
  }
  if (!loading && bulletins.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        The board is empty for now.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 16,
        paddingTop: 4,
      }}
    >
      {bulletins.map((b) => (
        <PinnedNote key={b.id} bulletin={b} onOpen={() => onOpenArtifact(b.id)} />
      ))}
    </div>
  );
}

function PinnedNote({ bulletin, onOpen }: { bulletin: ArtifactSummary; onOpen: () => void }) {
  const agent = bulletin.agentId as ThomasId;
  const color = THOMAS_COLORS[agent];
  const tilt = tiltFor(bulletin.id);
  return (
    <button
      onClick={onOpen}
      style={{
        textAlign: 'left',
        background: 'var(--paper-2)',
        border: '1px solid var(--line)',
        borderRadius: 4,
        boxShadow: 'var(--shadow)',
        padding: '16px 16px 14px',
        cursor: 'pointer',
        transform: `rotate(${tilt}deg)`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* the pin */}
      <span
        style={{
          position: 'absolute',
          top: -6,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 1px 2px rgba(60,48,30,.35), 0 0 0 3px ${color}26`,
        }}
      />
      <div style={{ font: '700 15px var(--display)', color: 'var(--ink)', lineHeight: 1.25, marginTop: 4 }}>
        {bulletin.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 'auto' }}>
        <div
          style={{ width: 20, height: 20, borderRadius: 6, background: `${color}1c`, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}
        >
          <SpritePortrait npcId={agent} scale={0.95} />
        </div>
        <span style={{ font: '700 11px var(--sans)', color }}>{agentShortName(agent)}</span>
        <span style={{ font: '400 9.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', marginLeft: 'auto' }}>
          {headerDate(bulletin.createdAt)}
        </span>
      </div>
    </button>
  );
}
