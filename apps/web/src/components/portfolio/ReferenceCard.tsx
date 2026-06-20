import type { ExternalReference } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { agentShortName } from '@/components/chat/primitives';

const KIND_LABELS: Record<string, string> = {
  project: 'Project',
  repo: 'Repository',
  demo: 'Live Demo',
  writing: 'Writing',
  resume: 'Résumé',
  company: 'Company',
  case_study: 'Case Study',
  other: 'Reference',
};

// ReferenceCard — a compact card for one external reference in the Projects tab.
// Clicking opens the ReferenceReader. Agent-hue accent from its first facet.
export function ReferenceCard({ reference, onOpen }: { reference: ExternalReference; onOpen: (r: ExternalReference) => void }) {
  const agent = reference.agentIds[0] as ThomasId | undefined;
  const color = agent ? THOMAS_COLORS[agent] : '#8a8174';
  return (
    <button
      onClick={() => onOpen(reference)}
      style={{
        display: 'block',
        textAlign: 'left',
        width: '100%',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 12,
        padding: '14px 15px',
        cursor: 'pointer',
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
        <span style={{ font: '700 8.5px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color, background: `${color}16`, padding: '2px 7px', borderRadius: 5 }}>
          {KIND_LABELS[reference.kind] ?? reference.kind}
        </span>
        {reference.agentIds.map((a) => (
          <span key={a} style={{ font: '600 9px var(--mono)', color: THOMAS_COLORS[a], textTransform: 'uppercase', letterSpacing: '.04em' }}>
            {agentShortName(a as ThomasId)}
          </span>
        ))}
      </div>
      <div style={{ font: '700 15px var(--display)', color: 'var(--ink)', lineHeight: 1.25 }}>{reference.title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginTop: 5 }}>{reference.summary}</div>
      <div style={{ marginTop: 9, font: '700 11px var(--sans)', color }}>view →</div>
    </button>
  );
}
