import type { ExternalReference } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { agentShortName } from '@/components/chat/primitives';
import { MarkdownBody } from '@/components/chronicle/MarkdownBody';

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

// ReferenceReader — the in-hub detail view for one external reference: kind chip,
// title, summary, optional markdown body, and the real action links (live demo /
// GitHub / open). External links open in a new tab.
export function ReferenceReader({ reference, onBack }: { reference: ExternalReference; onBack: () => void }) {
  const agent = reference.agentIds[0] as ThomasId | undefined;
  const color = agent ? THOMAS_COLORS[agent] : '#8a8174';

  const links: { label: string; href: string }[] = [];
  if (reference.liveUrl) links.push({ label: 'Live demo ↗', href: reference.liveUrl });
  if (reference.githubUrl) links.push({ label: 'GitHub ↗', href: reference.githubUrl });
  if (reference.url && reference.url !== reference.githubUrl)
    links.push({ label: reference.kind === 'writing' ? 'Read ↗' : 'Open ↗', href: reference.url });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <BackButton onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <article style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '26px 28px 30px', maxWidth: 640, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color, background: `${color}14`, padding: '3px 8px', borderRadius: 5 }}>
              {KIND_LABELS[reference.kind] ?? reference.kind}
            </span>
            {reference.agentIds.map((a) => (
              <span key={a} style={{ font: '600 9px var(--mono)', color: THOMAS_COLORS[a], textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {agentShortName(a as ThomasId)}
              </span>
            ))}
          </div>
          <h1 style={{ font: '700 25px var(--display)', color: 'var(--ink)', margin: '12px 0 4px', lineHeight: 1.2 }}>{reference.title}</h1>
          <div style={{ height: 3, width: 48, borderRadius: 999, background: color, margin: '10px 0 16px' }} />
          <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, margin: '0 0 16px' }}>{reference.summary}</p>
          {reference.bodyMd && <MarkdownBody body={reference.bodyMd} color={color} />}
          {links.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 18 }}>
              {links.map((l, i) => (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: '9px 15px',
                    borderRadius: 10,
                    textDecoration: 'none',
                    border: i === 0 ? 'none' : `1px solid ${color}55`,
                    background: i === 0 ? color : '#fff',
                    color: i === 0 ? '#fff' : color,
                    font: '600 13px var(--sans)',
                  }}
                >
                  {l.label}
                </a>
              ))}
            </div>
          )}
          {reference.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 18 }}>
              {reference.tags.map((t) => (
                <span key={t} style={{ font: '600 9px var(--mono)', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper-2)', border: '1px solid var(--line)', padding: '2px 8px', borderRadius: 999 }}>
                  {t}
                </span>
              ))}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        margin: '4px 0 14px',
        padding: '6px 12px',
        borderRadius: 999,
        border: '1px solid var(--line-2)',
        background: '#fff',
        color: 'var(--ink-2)',
        font: '600 12.5px var(--sans)',
        cursor: 'pointer',
      }}
    >
      ← Back
    </button>
  );
}
