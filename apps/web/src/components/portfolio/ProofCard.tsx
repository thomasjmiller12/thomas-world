import type { PortfolioProof } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { agentShortName } from '@/components/chat/primitives';

// ProofCard — a curated claim-with-evidence card for the Proof tab. Clicking
// opens the proof detail (claim, body, evidence links).
export function ProofCard({ proof, onOpen }: { proof: PortfolioProof; onOpen: (p: PortfolioProof) => void }) {
  const agent = proof.agentIds[0] as ThomasId | undefined;
  const color = agent ? THOMAS_COLORS[agent] : '#8a8174';
  return (
    <button
      onClick={() => onOpen(proof)}
      style={{
        display: 'block',
        textAlign: 'left',
        width: '100%',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderTop: `3px solid ${color}`,
        borderRadius: 12,
        padding: '15px 16px',
        cursor: 'pointer',
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ font: '700 16px var(--display)', color: 'var(--ink)', lineHeight: 1.25 }}>{proof.title}</div>
      <div style={{ fontSize: 13, color, fontWeight: 600, marginTop: 5, lineHeight: 1.4 }}>{proof.claim}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginTop: 7 }}>{proof.summary}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {proof.skills.slice(0, 4).map((s) => (
          <span key={s} style={{ font: '600 9px var(--mono)', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper-2)', border: '1px solid var(--line)', padding: '2px 7px', borderRadius: 999 }}>
            {s}
          </span>
        ))}
        {proof.agentIds.map((a) => (
          <span key={a} style={{ font: '600 9px var(--mono)', color: THOMAS_COLORS[a], textTransform: 'uppercase', letterSpacing: '.04em' }}>
            {agentShortName(a as ThomasId)}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 10, font: '700 11px var(--sans)', color }}>see the evidence →</div>
    </button>
  );
}
