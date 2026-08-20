import { useEffect, useState } from 'react';
import { Artifact, type Artifact as ArtifactType } from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';
import { artifactKindLabel } from './chroniclePresentation';

interface Props {
  objectName: string;
  artifactIds: string[];
  onClose: () => void;
  onOpen: (artifactId: string) => void;
}

export function ArtifactCollection({ objectName, artifactIds, onClose, onOpen }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactType[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const base = resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);
    void Promise.all(
      artifactIds.map(async (id) => {
        const response = await fetch(`${base}/artifacts/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return Artifact.parse(await response.json());
      }),
    )
      .then((rows) => setArtifacts(rows.filter((row): row is ArtifactType => row !== null)))
      .catch(() => undefined);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      controller.abort();
      window.removeEventListener('keydown', onKey);
    };
  }, [artifactIds, onClose]);

  return (
    <div
      className="pointer-events-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`Things on ${objectName}`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 65,
        background: 'rgba(43,38,32,.52)',
        display: 'grid',
        placeItems: 'center',
        padding: 18,
      }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        style={{
          width: 'min(520px, 100%)',
          maxHeight: '75vh',
          overflow: 'auto',
          background: 'var(--paper-2)',
          border: '1px solid var(--line)',
          borderRadius: 16,
          boxShadow: 'var(--shadow-lg)',
          padding: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ font: '700 20px var(--display)', color: 'var(--ink)' }}>{objectName}</div>
            <div
              style={{
                font: '600 9px var(--mono)',
                color: 'var(--ink-3)',
                letterSpacing: '.1em',
                textTransform: 'uppercase',
              }}
            >
              {artifactIds.length} things live here
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close collection"
            style={{
              marginLeft: 'auto',
              border: 0,
              background: 'transparent',
              color: 'var(--ink-3)',
              fontSize: 20,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        {artifacts.length === 0 ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Reading the shelf…</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                onClick={() => onOpen(artifact.id)}
                style={{
                  textAlign: 'left',
                  padding: '11px 12px',
                  borderRadius: 11,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ font: '700 13.5px var(--sans)', color: 'var(--ink)' }}>
                  {artifact.title}
                </div>
                <div
                  style={{
                    font: '500 9px var(--mono)',
                    color: 'var(--ink-3)',
                    marginTop: 3,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                  }}
                >
                  {artifactKindLabel(artifact.kind)} · {artifact.agentId}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
