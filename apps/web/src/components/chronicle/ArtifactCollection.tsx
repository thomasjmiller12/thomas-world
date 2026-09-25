import { useEffect, useRef, useState } from 'react';
import { ArtifactResponse, type Artifact as ArtifactType } from '@town/contract';
import { EventBus } from '@/game/EventBus';
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
  const [loaded, setLoaded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    EventBus.emit('dialog-opened');
    dialogRef.current?.focus();
    return () => {
      EventBus.emit('dialog-closed');
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const base = resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);
    setLoaded(false);
    void Promise.allSettled(
      artifactIds.map(async (id) => {
        const response = await fetch(`${base}/artifacts/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return ArtifactResponse.parse(await response.json()).artifact;
      }),
    )
      .then((results) => {
        if (controller.signal.aborted) return;
        setArtifacts(
          results.flatMap((result) =>
            result.status === 'fulfilled' && result.value ? [result.value] : [],
          ),
        );
        setLoaded(true);
      });
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
      tabIndex={-1}
      ref={dialogRef}
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
        {!loaded ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Reading the shelf…</div>
        ) : artifacts.length === 0 ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
            Nothing readable is available here right now.
          </div>
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
