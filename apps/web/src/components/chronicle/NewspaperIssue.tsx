import { useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChronicleIssue, ChronicleCitation } from '@town/contract';
import { clockFor, relativeDayLabel } from './chroniclePresentation';

// NewspaperIssue — the Town Crier front page (M2.2 — Part 1). Renders the LLM-
// written issue as a small-town paper: masthead, byline + print status, lead
// story, section blocks, and a citation rail. Every [Sn] marker in the prose
// becomes a clickable pill; clicking opens a source drawer (preview + "open
// source"). The model never writes raw links — pills resolve to validated
// citations. A "read the timeline" toggle hands back to the chronological river.

interface Props {
  issue: ChronicleIssue;
  // Open a citation's underlying source (artifact reader / conversations / About).
  onOpenCitation: (citation: ChronicleCitation) => void;
  // Switch to the chronological timeline view.
  onReadTimeline: () => void;
  // Jump to the latest meaningful day (quiet-day link).
  onGoToDay: (day: string) => void;
}

// Turn bare [Sn] markers into cite: links react-markdown can render as pills.
function linkifyCitations(md: string): string {
  return md.replace(/\[(S\d+)\](?!\()/g, '[$1](cite:$1)');
}

export function NewspaperIssue({ issue, onOpenCitation, onReadTimeline, onGoToDay }: Props) {
  const [drawer, setDrawer] = useState<ChronicleCitation | null>(null);
  const citationById = useMemo(() => new Map(issue.citations.map((c) => [c.id, c])), [issue.citations]);

  const onCite = (id: string) => {
    const c = citationById.get(id);
    if (c) setDrawer(c);
  };

  // Quiet day → the "presses are waiting" card.
  if (issue.status === 'empty') {
    return (
      <div style={{ maxWidth: 640, margin: '8px auto 0', textAlign: 'center', padding: '32px 16px' }}>
        <div style={{ font: '700 9px var(--mono)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          The Town Chronicle
        </div>
        <h1 style={{ font: '700 24px var(--display)', color: 'var(--ink)', margin: '12px 0 8px', lineHeight: 1.25 }}>{issue.title}</h1>
        <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6, margin: '0 auto', maxWidth: 440 }}>{issue.bodyMd}</p>
        <div style={{ display: 'flex', gap: 9, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
          {issue.latestMeaningfulDay && (
            <button onClick={() => onGoToDay(issue.latestMeaningfulDay!)} style={primaryPill()}>
              Read the latest issue →
            </button>
          )}
          <button onClick={onReadTimeline} style={ghostPill()}>Read the timeline →</button>
        </div>
      </div>
    );
  }

  const statusLine =
    issue.status === 'ready' && issue.generatedAt
      ? `Printed ${clockFor(issue.generatedAt)}`
      : issue.status === 'fallback'
        ? 'A light edition — the full press was quiet'
        : 'From the latest cached issue';

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        {/* masthead */}
        <div style={{ textAlign: 'center', borderBottom: '2px solid var(--ink)', paddingBottom: 10, marginBottom: 18 }}>
          <div style={{ font: '700 9px var(--mono)', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            The Town Chronicle
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 6, font: '400 10px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', textTransform: 'uppercase' }}>
            <span>{issue.byline}</span>
            <span>·</span>
            <span>{relativeDayLabel(issue.day)}</span>
            <span>·</span>
            <span>{statusLine}</span>
          </div>
        </div>

        {/* lead */}
        <h1 style={{ font: '700 30px var(--display)', color: 'var(--ink)', lineHeight: 1.15, margin: '0 0 6px', textAlign: 'center' }}>
          {issue.title}
        </h1>
        {issue.subtitle && (
          <p style={{ font: '400 15px var(--sans)', fontStyle: 'italic', color: 'var(--ink-2)', textAlign: 'center', margin: '0 0 20px', lineHeight: 1.5 }}>
            {issue.subtitle}
          </p>
        )}

        <IssueProse md={issue.bodyMd} onCite={onCite} lead />

        {/* sections */}
        {issue.sections.map((s) => (
          <section key={s.id} style={{ marginTop: 22 }}>
            <h2 style={{ font: '700 11px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-2)', borderBottom: '1px solid var(--line)', paddingBottom: 6, margin: '0 0 10px' }}>
              {s.title}
            </h2>
            <IssueProse md={s.bodyMd} onCite={onCite} />
          </section>
        ))}

        {/* sources rail */}
        {issue.citations.length > 0 && (
          <div style={{ marginTop: 26, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div style={{ font: '700 9px var(--mono)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 9 }}>
              Sources
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {issue.citations.map((c) => (
                <button key={c.id} onClick={() => setDrawer(c)} style={sourceChip()}>
                  <span style={{ fontWeight: 700 }}>{c.id}</span> {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
          <button onClick={onReadTimeline} style={ghostPill()}>Read the timeline →</button>
        </div>
      </div>

      {/* source drawer */}
      {drawer && (
        <div
          onClick={() => setDrawer(null)}
          style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 5 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 520, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '14px 14px 0 0', boxShadow: 'var(--shadow-lg)', padding: '16px 18px 18px', animation: 'slideUpSheet .2s ease-out' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper-2)', border: '1px solid var(--line)', padding: '2px 7px', borderRadius: 5 }}>
                {drawer.kind.replace(/_/g, ' ')}
              </span>
              <span style={{ font: '700 10px var(--mono)', color: 'var(--ink-3)' }}>{drawer.id}</span>
              <button onClick={() => setDrawer(null)} aria-label="Close source" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--ink-3)', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ font: '700 15px var(--display)', color: 'var(--ink)', lineHeight: 1.3 }}>{drawer.label}</div>
            {drawer.excerpt && (
              <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{drawer.excerpt}</p>
            )}
            {drawer.href && (
              <button
                onClick={() => { const c = drawer; setDrawer(null); onOpenCitation(c); }}
                style={{ ...primaryPill(), marginTop: 14 }}
              >
                Open source →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Markdown prose with citation pills. `lead` gives the first paragraph a drop-y
// larger size for the front-page feel.
function IssueProse({ md, onCite, lead }: { md: string; onCite: (id: string) => void; lead?: boolean }) {
  const source = useMemo(() => linkifyCitations(md), [md]);
  const components: Components = {
    p: ({ children }) => (
      <p style={{ margin: '0 0 12px', font: `400 ${lead ? 16 : 14.5}px var(--sans)`, lineHeight: 1.65, color: 'var(--ink)' }}>{children}</p>
    ),
    ul: ({ children }) => <ul style={{ margin: '0 0 12px', paddingLeft: 22, listStyle: 'disc' }}>{children}</ul>,
    li: ({ children }) => <li style={{ margin: '0 0 5px', fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink)' }}>{children}</li>,
    em: ({ children }) => <em>{children}</em>,
    strong: ({ children }) => <strong>{children}</strong>,
    a: ({ children, href }) => {
      if (href && href.startsWith('cite:')) {
        const id = href.slice('cite:'.length);
        return (
          <button onClick={() => onCite(id)} style={citePill()}>
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ink)', fontWeight: 600 }}>
          {children}
        </a>
      );
    },
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>;
}

function citePill(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'super',
    fontSize: 9.5,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    lineHeight: 1,
    color: 'var(--career)',
    background: 'color-mix(in srgb, var(--career) 14%, transparent)',
    border: 'none',
    borderRadius: 5,
    padding: '2px 4px',
    margin: '0 1px',
    cursor: 'pointer',
  };
}

function sourceChip(): React.CSSProperties {
  return {
    font: '500 11px var(--sans)',
    color: 'var(--ink-2)',
    background: 'var(--paper-2)',
    border: '1px solid var(--line)',
    borderRadius: 999,
    padding: '5px 11px',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

function primaryPill(): React.CSSProperties {
  return { padding: '9px 15px', borderRadius: 10, border: 'none', background: 'var(--ink)', color: '#fff', font: '600 13px var(--sans)', cursor: 'pointer' };
}
function ghostPill(): React.CSSProperties {
  return { padding: '9px 15px', borderRadius: 10, border: '1px solid var(--line-2)', background: '#fff', color: 'var(--ink-2)', font: '600 13px var(--sans)', cursor: 'pointer' };
}
