import type { ShareCard, ShareCardAction } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { agentColor } from './primitives';

// ShareCardBubble — a concrete card an agent dropped into the chat (M2.2 —
// Part 4): an artifact, a curated external reference/project, or a portfolio
// proof. Rendered as a distinct line (not a plain bubble): a kind chip, title,
// summary, and action buttons. External actions open a new tab; internal actions
// emit `open-card-target` so App can open the right overlay (artifact reader,
// reference reader, proof). The card carries its own links — no raw URLs in prose.

export function ShareCardBubble({ card }: { card: ShareCard }) {
  const color = card.color ?? (card.agentId ? agentColor(card.agentId) : 'var(--ink-2)');

  const runAction = (a: ShareCardAction) => {
    if (a.kind === 'external') {
      window.open(a.href, '_blank', 'noopener,noreferrer');
    } else {
      EventBus.emit('open-card-target', { href: a.href });
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
      <div
        style={{
          maxWidth: '92%',
          width: '100%',
          background: '#fff',
          border: `1px solid ${color}3a`,
          borderLeft: `3px solid ${color}`,
          borderRadius: 12,
          padding: '12px 13px',
          boxShadow: `0 1px 0 ${color}14, 0 8px 22px -16px rgba(60,48,30,.45)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
          <span
            style={{
              font: '700 8.5px var(--mono)',
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color,
              background: `${color}16`,
              padding: '2px 7px',
              borderRadius: 5,
            }}
          >
            {card.sourceLabel}
          </span>
        </div>
        <div style={{ font: '700 14px var(--display)', color: 'var(--ink)', lineHeight: 1.25 }}>
          {card.title}
        </div>
        {card.subtitle && (
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2, fontStyle: 'italic' }}>
            {card.subtitle}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.45, marginTop: 6 }}>
          {card.summary}
        </div>
        {card.actions.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>
            {card.actions.map((a, i) => (
              <button
                key={`${a.href}-${i}`}
                onClick={() => runAction(a)}
                style={{
                  padding: '6px 11px',
                  borderRadius: 8,
                  border: i === 0 ? 'none' : `1px solid ${color}55`,
                  background: i === 0 ? color : '#fff',
                  color: i === 0 ? '#fff' : color,
                  font: '600 11.5px var(--sans)',
                  cursor: 'pointer',
                }}
              >
                {a.label}
                {a.kind === 'external' ? ' ↗' : ' →'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
