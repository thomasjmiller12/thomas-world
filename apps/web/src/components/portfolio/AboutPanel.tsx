import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AboutResponse, ExternalReference, PortfolioProof } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { SpritePortrait, agentShortName } from '@/components/chat/primitives';
import { MarkdownBody } from '@/components/chronicle/MarkdownBody';
import { fetchAbout, fetchProofs, fetchReferences, fetchReference } from './PortfolioClient';
import { ReferenceCard } from './ReferenceCard';
import { ProofCard } from './ProofCard';
import { ReferenceReader, BackButton } from './ReferenceReader';

// AboutPanel — the visitor-facing About / Portfolio hub (M2.2 — Part 3). A full-
// screen paper overlay (mirrors the Chronicle hub's chrome) that explains Thomas,
// the five facets, the architecture, and the proof behind the claims. It reads
// even when the agents are asleep — all curated data, no LLM. Tabs: Overview ·
// Facets · Proof · Projects · How It Works. A proof/reference can be opened into
// an in-hub reader; ESC pops the reader before closing the hub.

export type AboutTab = 'overview' | 'facets' | 'proof' | 'projects' | 'how';

const TABS: { id: AboutTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'facets', label: 'Facets' },
  { id: 'proof', label: 'Proof' },
  { id: 'projects', label: 'Projects' },
  { id: 'how', label: 'How It Works' },
];

export interface AboutPanelProps {
  onClose: () => void;
  initialTab?: AboutTab;
  initialReferenceId?: string | null;
  initialProofId?: string | null;
}

export function AboutPanel({ onClose, initialTab = 'overview', initialReferenceId = null, initialProofId = null }: AboutPanelProps) {
  const [tab, setTab] = useState<AboutTab>(initialTab);
  const [about, setAbout] = useState<AboutResponse | null>(null);
  const [proofs, setProofs] = useState<PortfolioProof[]>([]);
  const [references, setReferences] = useState<ExternalReference[]>([]);
  const [error, setError] = useState(false);
  const [openReference, setOpenReference] = useState<ExternalReference | null>(null);
  const [openProof, setOpenProof] = useState<PortfolioProof | null>(null);
  const [facetFilter, setFacetFilter] = useState<ThomasId | null>(null);

  // Freeze player movement while the hub owns the keyboard.
  useEffect(() => {
    EventBus.emit('dialog-opened');
    return () => {
      EventBus.emit('dialog-closed');
    };
  }, []);

  // Load everything once (curated, small).
  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      fetchAbout(ctrl.signal),
      fetchProofs({ signal: ctrl.signal }),
      fetchReferences({ signal: ctrl.signal }),
    ])
      .then(([a, p, r]) => {
        if (ctrl.signal.aborted) return;
        setAbout(a);
        setProofs(p);
        setReferences(r);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      });
    return () => ctrl.abort();
  }, []);

  // Open an initial reference/proof reader (deep-link from a share card / citation).
  useEffect(() => {
    if (!initialReferenceId) return;
    const ctrl = new AbortController();
    fetchReference(initialReferenceId, ctrl.signal)
      .then((r) => !ctrl.signal.aborted && setOpenReference(r))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [initialReferenceId]);

  useEffect(() => {
    if (!initialProofId || proofs.length === 0) return;
    const p = proofs.find((x) => x.id === initialProofId);
    if (p) setOpenProof(p);
  }, [initialProofId, proofs]);

  const referenceById = useMemo(() => new Map(references.map((r) => [r.id, r])), [references]);
  const proofById = useMemo(() => new Map(proofs.map((p) => [p.id, p])), [proofs]);

  const openReferenceById = useCallback(
    (id: string) => {
      const r = referenceById.get(id);
      if (r) setOpenReference(r);
      else fetchReference(id).then(setOpenReference).catch(() => undefined);
    },
    [referenceById],
  );

  // ESC: pop a reader first, then close the hub.
  const handleEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (openReference) setOpenReference(null);
      else if (openProof) setOpenProof(null);
      else onClose();
    },
    [openReference, openProof, onClose],
  );
  useEffect(() => {
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleEsc]);

  const switchTab = (t: AboutTab) => {
    setTab(t);
    setOpenReference(null);
    setOpenProof(null);
  };

  const reader = openReference ? (
    <ReferenceReader reference={openReference} onBack={() => setOpenReference(null)} />
  ) : openProof ? (
    <ProofReader
      proof={openProof}
      referenceById={referenceById}
      onBack={() => setOpenProof(null)}
      onOpenReference={openReferenceById}
    />
  ) : null;

  return (
    <div
      className="pointer-events-auto"
      role="dialog"
      aria-modal="true"
      aria-label="About Thomas's Town"
      style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(43,38,32,.45)', animation: 'fadeInScrim .18s ease-out' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 880, maxWidth: '100%', height: '90vh', maxHeight: '100%', background: 'var(--paper)', borderRadius: 18, boxShadow: 'var(--shadow-lg)', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--sans)', animation: 'riseInHub .22s ease-out' }}>
        {/* header */}
        <div style={{ padding: '18px 24px 0', background: 'var(--paper-2)', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ font: '700 24px var(--display)', color: 'var(--ink)' }}>About Thomas&apos;s Town</div>
            <button onClick={onClose} aria-label="Close about" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--ink-3)', fontSize: 22, lineHeight: 1, cursor: 'pointer' }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 14, flexWrap: 'wrap' }}>
            {TABS.map((t) => {
              const on = tab === t.id;
              return (
                <button key={t.id} onClick={() => switchTab(t.id)} aria-pressed={on} style={{ padding: '9px 15px', border: 'none', background: 'transparent', font: `${on ? 700 : 600} 13.5px var(--sans)`, color: on ? 'var(--ink)' : 'var(--ink-3)', borderBottom: `2px solid ${on ? 'var(--ink)' : 'transparent'}`, cursor: 'pointer', marginBottom: -1 }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflowY: reader ? 'hidden' : 'auto', padding: '20px 24px 24px', minHeight: 0 }}>
          {error && !about && <Muted>The town&apos;s story didn&apos;t load. It may be dreaming — try again shortly.</Muted>}
          {!about && !error && <Muted>Loading…</Muted>}
          {reader ? (
            reader
          ) : about ? (
            <>
              {tab === 'overview' && <OverviewTab about={about} onGoProof={() => switchTab('proof')} onGoFacets={() => switchTab('facets')} />}
              {tab === 'facets' && (
                <FacetsTab about={about} referenceById={referenceById} proofById={proofById} onOpenReference={(r) => setOpenReference(r)} onOpenProof={(p) => setOpenProof(p)} />
              )}
              {tab === 'proof' && (
                <div style={{ display: 'grid', gap: 12 }}>
                  {proofs.map((p) => <ProofCard key={p.id} proof={p} onOpen={setOpenProof} />)}
                </div>
              )}
              {tab === 'projects' && (
                <ProjectsTab references={references} facetFilter={facetFilter} setFacetFilter={setFacetFilter} onOpen={setOpenReference} />
              )}
              {tab === 'how' && (
                <div style={{ maxWidth: 660 }}>
                  <h2 style={{ font: '700 20px var(--display)', color: 'var(--ink)', margin: '0 0 12px' }}>{about.howItWorks.title}</h2>
                  <MarkdownBody body={about.howItWorks.bodyMd} color="#8a8174" />
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>{children}</div>;
}

function OverviewTab({ about, onGoProof, onGoFacets }: { about: AboutResponse; onGoProof: () => void; onGoFacets: () => void }) {
  return (
    <div style={{ maxWidth: 660 }}>
      <h2 style={{ font: '700 22px var(--display)', color: 'var(--ink)', margin: '0 0 12px' }}>{about.overview.title}</h2>
      <MarkdownBody body={about.overview.bodyMd} color="#8a8174" />
      <div style={{ display: 'flex', gap: 9, marginTop: 18, flexWrap: 'wrap' }}>
        <button onClick={onGoFacets} style={pillBtn(false)}>Meet the five facets →</button>
        <button onClick={onGoProof} style={pillBtn(true)}>See the proof →</button>
      </div>
    </div>
  );
}

function FacetsTab({ about, referenceById, proofById, onOpenReference, onOpenProof }: {
  about: AboutResponse;
  referenceById: Map<string, ExternalReference>;
  proofById: Map<string, PortfolioProof>;
  onOpenReference: (r: ExternalReference) => void;
  onOpenProof: (p: PortfolioProof) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {about.facets.map((f) => {
        const color = THOMAS_COLORS[f.agentId] ?? '#8a8174';
        return (
          <div key={f.agentId} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '15px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 8 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: `${color}1c`, border: `1px solid ${color}40`, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
                <SpritePortrait npcId={f.agentId} scale={1.5} />
              </div>
              <div style={{ font: '700 16px var(--display)', color }}>{f.displayName}</div>
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 0 10px' }}>{f.bio}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {f.proofIds.map((id) => {
                const p = proofById.get(id);
                if (!p) return null;
                return <Chip key={id} color={color} onClick={() => onOpenProof(p)} label={p.title} kind="proof" />;
              })}
              {f.referenceIds.map((id) => {
                const r = referenceById.get(id);
                if (!r) return null;
                return <Chip key={id} color={color} onClick={() => onOpenReference(r)} label={r.shortTitle ?? r.title} kind="ref" />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectsTab({ references, facetFilter, setFacetFilter, onOpen }: {
  references: ExternalReference[];
  facetFilter: ThomasId | null;
  setFacetFilter: (a: ThomasId | null) => void;
  onOpen: (r: ExternalReference) => void;
}) {
  const facets: ThomasId[] = ['career', 'researcher', 'builder', 'writer', 'hobby'];
  const shown = facetFilter ? references.filter((r) => r.agentIds.includes(facetFilter)) : references;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <FilterChip active={facetFilter === null} onClick={() => setFacetFilter(null)} label="All" color="var(--ink-2)" />
        {facets.map((a) => (
          <FilterChip key={a} active={facetFilter === a} onClick={() => setFacetFilter(a)} label={agentShortName(a)} color={THOMAS_COLORS[a]} />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {shown.map((r) => <ReferenceCard key={r.id} reference={r} onOpen={onOpen} />)}
        {shown.length === 0 && <Muted>No projects for that facet yet.</Muted>}
      </div>
    </div>
  );
}

function ProofReader({ proof, referenceById, onBack, onOpenReference }: {
  proof: PortfolioProof;
  referenceById: Map<string, ExternalReference>;
  onBack: () => void;
  onOpenReference: (id: string) => void;
}) {
  const agent = proof.agentIds[0] as ThomasId | undefined;
  const color = agent ? THOMAS_COLORS[agent] : '#8a8174';
  const linkedRefs = proof.referenceIds.map((id) => referenceById.get(id)).filter((r): r is ExternalReference => Boolean(r));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <BackButton onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <article style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '26px 28px 30px', maxWidth: 640, margin: '0 auto' }}>
          <span style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color, background: `${color}14`, padding: '3px 8px', borderRadius: 5 }}>Proof</span>
          <h1 style={{ font: '700 25px var(--display)', color: 'var(--ink)', margin: '12px 0 4px', lineHeight: 1.2 }}>{proof.title}</h1>
          <p style={{ fontSize: 14.5, color, fontWeight: 600, margin: '0 0 4px', lineHeight: 1.4 }}>{proof.claim}</p>
          <div style={{ height: 3, width: 48, borderRadius: 999, background: color, margin: '12px 0 16px' }} />
          <MarkdownBody body={proof.bodyMd} color={color} />
          {linkedRefs.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ font: '700 10px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 9 }}>Evidence</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {linkedRefs.map((r) => <ReferenceCard key={r.id} reference={r} onOpen={() => onOpenReference(r.id)} />)}
              </div>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function Chip({ color, onClick, label, kind }: { color: string; onClick: () => void; label: string; kind: 'proof' | 'ref' }) {
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999, border: `1px solid ${color}40`, background: `${color}10`, color, font: '600 11px var(--sans)', cursor: 'pointer' }}>
      <span style={{ font: '700 8px var(--mono)', opacity: 0.7 }}>{kind === 'proof' ? '◆' : '↗'}</span>
      {label}
    </button>
  );
}

function FilterChip({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color: string }) {
  return (
    <button onClick={onClick} style={{ padding: '5px 12px', borderRadius: 999, border: `1px solid ${active ? color : 'var(--line-2)'}`, background: active ? color : '#fff', color: active ? '#fff' : 'var(--ink-2)', font: '600 11.5px var(--sans)', cursor: 'pointer' }}>
      {label}
    </button>
  );
}

function pillBtn(primary: boolean): React.CSSProperties {
  return {
    padding: '9px 15px',
    borderRadius: 10,
    border: primary ? 'none' : '1px solid var(--line-2)',
    background: primary ? 'var(--ink)' : '#fff',
    color: primary ? '#fff' : 'var(--ink-2)',
    font: '600 13px var(--sans)',
    cursor: 'pointer',
  };
}
