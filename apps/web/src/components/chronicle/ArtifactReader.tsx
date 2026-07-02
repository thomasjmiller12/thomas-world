import { useEffect, useState } from 'react';
import type { Artifact, AgentId } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { agentShortName } from '@/components/chat/primitives';
import { fetchArtifact } from './chronicleClient';
import { artifactKindLabel, headerDate } from './chroniclePresentation';
import { MarkdownBody } from './MarkdownBody';
import { ArtifactFrame } from '@/components/artifact/ArtifactFrame';

// ArtifactReader — the in-hub document reader (M2.1). Lazily GETs the full
// artifact body (list views carry only the headline) and renders it as a paper
// document: a --card page with an agent-hue accent rule, Fredoka title, the
// markdown body the agents write in (MarkdownBody maps it onto the tokens),
// and a Silkscreen meta footer. The ← back affordance pops the reader off the
// stack (the parent owns whether that returns to a list or a tab).

interface Props {
  artifactId: string;
  onBack: () => void;
}

export function ArtifactReader({ artifactId, onBack }: Props) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Bumped by the retry button to re-run the effect on demand.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    fetchArtifact(artifactId, ctrl.signal)
      .then((a) => setArtifact(a))
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setError(true);
        void e;
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [artifactId, attempt]);

  const agent = artifact?.agentId as ThomasId | undefined;
  // Hex (not a CSS var) — MarkdownBody derives alpha variants like `${color}66`.
  const color = agent ? THOMAS_COLORS[agent] : '#8a8174';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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

      {loading && (
        <div style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', padding: '8px 2px' }}>
          OPENING…
        </div>
      )}

      {error && !loading && (
        <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
          <div>This page wouldn&apos;t open. It may have been put away.</div>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            style={{
              marginTop: 12,
              padding: '6px 14px',
              borderRadius: 999,
              border: `1px solid ${color}`,
              background: '#fff',
              color: 'var(--ink-2)',
              font: '600 12.5px var(--sans)',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )}

      {artifact && !loading && !error && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* the paper page (interactive artifacts get a wider stage — the app IS the page) */}
          <article
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              boxShadow: 'var(--shadow)',
              padding: '28px 30px 32px',
              maxWidth: artifact.kind === 'interactive' ? 860 : 640,
              margin: '0 auto',
            }}
          >
            <span
              style={{
                font: '700 9px var(--mono)',
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                color,
                background: `${color}14`,
                padding: '3px 8px',
                borderRadius: 5,
              }}
            >
              {artifactKindLabel(artifact.kind)}
            </span>
            <h1 style={{ font: '700 26px var(--display)', color: 'var(--ink)', margin: '12px 0 4px', lineHeight: 1.2 }}>
              {artifact.title}
            </h1>
            {/* agent-hue accent rule */}
            <div style={{ height: 3, width: 48, borderRadius: 999, background: color, margin: '10px 0 18px' }} />
            {artifact.kind === 'interactive' ? (
              // An agent-built app: run it in the sandboxed frame instead of
              // rendering its HTML source as prose.
              <ArtifactFrame artifact={artifact} />
            ) : (
              <MarkdownBody body={artifact.body} color={color} />
            )}
          </article>

          {/* Silkscreen meta footer */}
          <div
            style={{
              maxWidth: 640,
              margin: '14px auto 0',
              font: '400 10px var(--mono)',
              letterSpacing: '.04em',
              color: 'var(--ink-3)',
              textAlign: 'center',
            }}
          >
            {agent && (
              <span style={{ color, fontWeight: 700 }}>{agentShortName(artifact.agentId as AgentId)} THOMAS</span>
            )}
            {agent && ' · '}
            {headerDate(artifact.createdAt)}
          </div>
        </div>
      )}
    </div>
  );
}
