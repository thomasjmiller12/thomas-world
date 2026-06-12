import type { ChronicleItem, LocationId } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { SpritePortrait, agentShortName } from '@/components/chat/primitives';
import { ThreadRow } from './ThreadRow';
import { clockFor, locationLabel, artifactKindLabel } from './chroniclePresentation';

// TodayTab — the day's grouped digest timeline (M2.1). Renders the full
// ChronicleItem[] as a river using the FeedTimeline's good bones: a time gutter,
// an agent-tinted portrait spine, and a content row per item. Row variants by
// `kind`: ThreadRow (its own progressive-disclosure component), artifact rows
// with [read →], bulletin rows, and muted flavor rows for effect/presence.

interface Props {
  items: ChronicleItem[];
  loading: boolean;
  error: boolean;
  // Open an artifact in the in-hub reader (lazy GET /artifacts/:id).
  onOpenArtifact: (id: string) => void;
}

export function TodayTab({ items, loading, error, onOpenArtifact }: Props) {
  if (loading && items.length === 0) return <Skeleton />;

  if (error && items.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        The town&apos;s day hasn&apos;t loaded yet. It may be dreaming.
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
        Nothing has happened yet today.
      </div>
    );
  }

  return (
    <div>
      {items.map((item, i) => (
        <ChronicleRow
          key={item.id}
          item={item}
          last={i === items.length - 1}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </div>
  );
}

// Dispatch one ChronicleItem to its row variant. Threads delegate to ThreadRow;
// everything else shares the gutter+spine+content scaffold below.
export function ChronicleRow({ item, last, onOpenArtifact }: {
  item: ChronicleItem;
  last: boolean;
  onOpenArtifact: (id: string) => void;
}) {
  switch (item.kind) {
    case 'thread':
      return <ThreadRow thread={item} last={last} />;
    case 'artifact': {
      const agent = item.artifact.agentId as ThomasId;
      return (
        <ScaffoldRow ts={item.ts} agent={agent} last={last}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{ font: '700 13px var(--sans)', color: THOMAS_COLORS[agent] }}>
              {agentShortName(agent)}
            </span>
            <Badge color={THOMAS_COLORS[agent]}>
              {item.action === 'updated' ? 'REVISED' : 'MADE'}
            </Badge>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', fontWeight: 600 }}>
              {item.artifact.title}
            </span>
            <span style={{ font: '400 10px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em' }}>
              {artifactKindLabel(item.artifact.kind).toUpperCase()}
            </span>
          </div>
          <ReadLink color={THOMAS_COLORS[agent]} onClick={() => onOpenArtifact(item.artifact.id)} />
        </ScaffoldRow>
      );
    }
    case 'bulletin': {
      const agent = item.agent as ThomasId;
      return (
        <ScaffoldRow ts={item.ts} agent={agent} last={last}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{ font: '700 13px var(--sans)', color: THOMAS_COLORS[agent] }}>
              {agentShortName(agent)}
            </span>
            <Badge color={THOMAS_COLORS[agent]}>POSTED</Badge>
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', fontWeight: 600 }}>
            {item.title}
          </div>
          <ReadLink color={THOMAS_COLORS[agent]} onClick={() => onOpenArtifact(item.artifactId)} />
        </ScaffoldRow>
      );
    }
    case 'effect':
      return (
        <ScaffoldRow ts={item.ts} agent={null} last={last}>
          <FlavorLine text={item.line} loc={item.locationId} />
        </ScaffoldRow>
      );
    case 'presence': {
      const agent = item.agent as ThomasId;
      return (
        <ScaffoldRow ts={item.ts} agent={agent} last={last}>
          <FlavorLine text={item.line} loc={null} agent={agent} />
        </ScaffoldRow>
      );
    }
    default: {
      // Exhaustiveness guard: a new ChronicleItem kind forces a compile error.
      const _never: never = item;
      void _never;
      return null;
    }
  }
}

// The shared gutter (clock) + spine (portrait or neutral dot) + content row,
// matching the FeedTimeline's river layout.
function ScaffoldRow({ ts, agent, last, children }: {
  ts: string;
  agent: ThomasId | null;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 13, position: 'relative' }}>
      <div style={{ width: 56, textAlign: 'right', font: '400 10px var(--mono)', color: 'var(--ink-3)', paddingTop: 9, flexShrink: 0 }}>
        {clockFor(ts)}
      </div>
      <div style={{ position: 'relative', width: 30, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!last && <div style={{ position: 'absolute', top: 18, bottom: -14, width: 2, background: 'var(--line)' }} />}
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: agent ? `${THOMAS_COLORS[agent]}1c` : 'var(--paper-2)',
            border: `1px solid ${agent ? `${THOMAS_COLORS[agent]}40` : 'var(--line)'}`,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            zIndex: 1,
            marginTop: 3,
          }}
        >
          {agent ? (
            <SpritePortrait npcId={agent} scale={1.4} />
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-3)' }} />
          )}
        </div>
      </div>
      <div style={{ flex: 1, paddingBottom: 16, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', color, background: `${color}14`, padding: '2px 6px', borderRadius: 5 }}>
      {children}
    </span>
  );
}

function ReadLink({ color, onClick }: { color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginTop: 6,
        padding: 0,
        border: 'none',
        background: 'transparent',
        font: '700 11px var(--sans)',
        color,
        cursor: 'pointer',
      }}
    >
      read →
    </button>
  );
}

// Muted, italic flavor line for effect/presence beats (third-person narration).
function FlavorLine({ text, loc, agent }: { text: string; loc?: LocationId | null; agent?: ThomasId }) {
  const where = loc ? locationLabel(loc) : '';
  return (
    <div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)', fontStyle: 'italic', wordBreak: 'break-word' }}>
        {agent && (
          <span style={{ color: THOMAS_COLORS[agent], fontWeight: 700, fontStyle: 'normal' }}>
            {agentShortName(agent)}{' '}
          </span>
        )}
        {text}
      </div>
      {where && (
        <div style={{ font: '400 10px var(--mono)', color: 'var(--ink-3)', marginTop: 4 }}>{where}</div>
      )}
    </div>
  );
}

// Loading skeleton — three ghost rows in the river shape.
function Skeleton() {
  return (
    <div>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 13, marginBottom: 18, opacity: 1 - i * 0.22 }}>
          <div style={{ width: 56 }} />
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--line)', flexShrink: 0, marginTop: 3 }} />
          <div style={{ flex: 1, paddingTop: 6 }}>
            <div style={{ height: 11, width: '40%', background: 'var(--line)', borderRadius: 5, marginBottom: 8 }} />
            <div style={{ height: 11, width: '78%', background: 'var(--line)', borderRadius: 5 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
