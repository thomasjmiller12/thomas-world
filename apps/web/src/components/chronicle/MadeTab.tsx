import { useEffect, useRef, useState } from 'react';
import { artifactKinds, type ArtifactKind, type ArtifactSummary, type AgentId } from '@town/contract';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { SpritePortrait, agentShortName } from '@/components/chat/primitives';
import { fetchArtifacts } from './chronicleClient';
import { artifactKindLabel, headerDate } from './chroniclePresentation';

// MadeTab — the artifact browser (M2.1). Kind filter chips × agent hue chips
// over a grid of artifact cards (kind badge, Fredoka title, agent + date,
// [read →]). Bulletins are excluded here — they have their own corkboard on the
// Board tab. Selecting a card hands its id up to the hub's ArtifactReader.

const ALL_AGENTS = Object.values(NPC_CONFIGS);
// The Board owns bulletins; the Made browser shows everything else.
const MADE_KINDS = artifactKinds.filter((k) => k !== 'bulletin') as ArtifactKind[];

interface Props {
  onOpenArtifact: (id: string) => void;
  // Bumped by the hub on a live refresh — re-pull the list without changing filters.
  refreshNonce?: number;
}

export function MadeTab({ onOpenArtifact, refreshNonce = 0 }: Props) {
  const [kind, setKind] = useState<ArtifactKind | 'all'>('all');
  const [agent, setAgent] = useState<AgentId | 'all'>('all');
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    fetchArtifacts({
      kind: kind === 'all' ? null : kind,
      agent: agent === 'all' ? null : agent,
      signal: ctrl.signal,
    })
      .then((list) => {
        if (seq !== reqSeq.current) return;
        // When no kind filter is set we still want to hide bulletins (Board's job).
        setArtifacts(kind === 'all' ? list.filter((a) => a.kind !== 'bulletin') : list);
      })
      .catch(() => {
        if (seq !== reqSeq.current) return;
        setError(true);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
    return () => ctrl.abort();
  }, [kind, agent, refreshNonce]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* filter chips */}
      <div style={{ flexShrink: 0, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip on={kind === 'all'} onClick={() => setKind('all')} color="var(--ink)" label="All kinds" />
          {MADE_KINDS.map((k) => (
            <Chip key={k} on={kind === k} onClick={() => setKind(k)} color="var(--ink)" label={artifactKindLabel(k)} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <Chip on={agent === 'all'} onClick={() => setAgent('all')} color="var(--ink)" label="Everyone" dot={false} />
          {ALL_AGENTS.map((a) => (
            <Chip
              key={a.id}
              on={agent === a.id}
              onClick={() => setAgent(a.id)}
              color={THOMAS_COLORS[a.id]}
              label={agentShortName(a.id)}
            />
          ))}
        </div>
      </div>

      {/* card grid */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 14, minHeight: 0 }}>
        {loading && artifacts.length === 0 && (
          <div style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', padding: '8px 2px' }}>
            LOADING…
          </div>
        )}
        {error && artifacts.length === 0 && (
          <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
            The shelves haven&apos;t loaded yet. The town may be dreaming.
          </div>
        )}
        {!loading && !error && artifacts.length === 0 && (
          <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
            Nothing made here yet.
          </div>
        )}
        {artifacts.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {artifacts.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onOpen={() => onOpenArtifact(a.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactSummary; onOpen: () => void }) {
  const agent = artifact.agentId as ThomasId;
  const color = THOMAS_COLORS[agent];
  return (
    <button
      onClick={onOpen}
      style={{
        textAlign: 'left',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        boxShadow: 'var(--shadow)',
        padding: '14px 15px 13px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <span
        style={{
          alignSelf: 'flex-start',
          font: '700 9px var(--mono)',
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color,
          background: `${color}14`,
          padding: '2px 6px',
          borderRadius: 5,
        }}
      >
        {artifactKindLabel(artifact.kind)}
      </span>
      <div style={{ font: '700 15px var(--display)', color: 'var(--ink)', lineHeight: 1.25 }}>
        {artifact.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 'auto' }}>
        <div
          style={{ width: 20, height: 20, borderRadius: 6, background: `${color}1c`, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}
        >
          <SpritePortrait npcId={agent} scale={0.95} />
        </div>
        <span style={{ font: '700 11px var(--sans)', color }}>{agentShortName(agent)}</span>
        <span style={{ font: '400 9.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', marginLeft: 'auto' }}>
          {headerDate(artifact.createdAt)}
        </span>
      </div>
      <span style={{ font: '700 11px var(--sans)', color, marginTop: 2 }}>read →</span>
    </button>
  );
}

// Filter chip — shared shape with the old feed chips (pill, agent-hue when on).
export function Chip({ on, onClick, color, label, dot = true }: {
  on: boolean; onClick: () => void; color: string; label: string; dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 11px',
        borderRadius: 999,
        border: `1px solid ${on ? color : 'var(--line-2)'}`,
        background: on ? color : '#fff',
        color: on ? '#fff' : 'var(--ink-2)',
        font: '600 12px var(--sans)',
        cursor: 'pointer',
        transition: 'all .15s',
      }}
    >
      {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? '#fff' : color }} />}
      {label}
    </button>
  );
}
