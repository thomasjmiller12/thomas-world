import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { MAX_CONTRIBUTION_LENGTH, type Artifact, type ArtifactRevision, type ArtifactTrailResponse, type WorldEvent } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { fetchArtifactRevision, fetchArtifactTrail, submitContribution } from '@/lib/world/contributions';
import { agentShortName } from '@/components/chat/primitives';

const buttonStyle: CSSProperties = { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line-2)', background: '#fff', color: 'var(--ink-2)', cursor: 'pointer', font: '600 12px var(--sans)' };
const proseStyle: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '400 13px/1.5 var(--sans)', margin: '8px 0' };

export function ArtifactTrail({ artifact, readOnly }: { artifact: Artifact; readOnly: boolean }) {
  const [trail, setTrail] = useState<ArtifactTrailResponse | null>(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [revision, setRevision] = useState<ArtifactRevision | null>(null);
  const [revisionError, setRevisionError] = useState('');
  const request = useRef<{ text: string; id: string } | null>(null);
  const revisionRequest = useRef<AbortController | null>(null);
  const revisionPanel = useRef<HTMLElement | null>(null);
  const canSuggest = !readOnly && !['diary_entry', 'daily_digest', 'bulletin'].includes(artifact.kind);

  useEffect(() => {
    if (revision) revisionPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [revision]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    fetchArtifactTrail(artifact.id, { readOnly, signal: controller.signal }).then(setTrail)
      .catch((error: Error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    return () => controller.abort();
  }, [artifact.id, readOnly, refresh]);

  useEffect(() => {
    const onEvent = (event: WorldEvent) => {
      if ((event.type === 'artifact.updated' || event.type === 'artifact.contribution') && event.payload.artifactId === artifact.id) setRefresh((n) => n + 1);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') setRefresh((n) => n + 1); };
    EventBus.on('world-event', onEvent);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      EventBus.off('world-event', onEvent);
      document.removeEventListener('visibilitychange', onVisible);
      revisionRequest.current?.abort();
    };
  }, [artifact.id]);

  async function send() {
    if (saving || !canSuggest || !text.trim()) return;
    setSaving(true);
    setMessage('');
    const body = text.trim();
    if (request.current?.text !== body) request.current = { text: body, id: crypto.randomUUID() };
    try {
      await submitContribution(artifact.id, body, request.current.id, { readOnly });
      setText('');
      request.current = null;
      setMessage('Saved publicly. Come back here to see the response and any resulting version.');
      setRefresh((n) => n + 1);
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }

  async function openRevision(id: string) {
    revisionRequest.current?.abort();
    const controller = new AbortController();
    revisionRequest.current = controller;
    setRevisionError('');
    try { setRevision(await fetchArtifactRevision(artifact.id, id, controller.signal)); }
    catch (error) { if (!controller.signal.aborted) setRevisionError((error as Error).message); }
  }

  const contributions = trail ? [...new Map([...trail.yours, ...trail.contributions].map((item) => [item.id, item])).values()] : [];
  return (
    <section aria-label="Suggestions and versions" style={{ maxWidth: 860, margin: '24px auto 0', padding: '20px 24px', border: '1px solid var(--line)', borderRadius: 14, background: 'var(--card)', color: 'var(--ink)' }}>
      <h2 style={{ margin: '0 0 8px', font: '700 21px var(--display)' }}>Leave something for later</h2>
      <p style={proseStyle}>An idea for {agentShortName(artifact.agentId)} Thomas to consider. Suggestions and responses stay with this creation. Changes appear as saved versions.</p>
      {canSuggest && <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label htmlFor={`suggestion-${artifact.id}`} style={{ font: '600 12px var(--sans)' }}>Your public suggestion</label>
        <textarea id={`suggestion-${artifact.id}`} value={text} maxLength={MAX_CONTRIBUTION_LENGTH} rows={3} disabled={saving} onChange={(event) => setText(event.target.value)} placeholder="What would make this more useful or fun?"
          style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', border: '1px solid var(--line-2)', borderRadius: 8, padding: 10, font: '400 13px/1.5 var(--sans)', background: '#fff', color: 'var(--ink)' }} />
        <p style={{ ...proseStyle, color: 'var(--ink-3)', fontSize: 12 }}>Posting makes this text and your visitor name public. The resident may accept, decline, or explain a blocker.</p>
        <button type="submit" disabled={saving || !text.trim()} style={buttonStyle}>{saving ? 'Saving…' : 'Post public suggestion'}</button>
      </form>}
      {readOnly && <p style={{ ...proseStyle, color: 'var(--ink-3)' }}>You&apos;re observing. Enter town to leave a suggestion.</p>}
      {message && <p role="status" style={proseStyle}>{message}</p>}
      {loadError && <p role="alert" style={proseStyle}>{loadError} <button type="button" style={buttonStyle} onClick={() => setRefresh((n) => n + 1)}>Retry</button></p>}

      <h3 style={{ margin: '24px 0 8px', font: '700 16px var(--display)' }}>Suggestions</h3>
      {trail && !contributions.length && <p style={proseStyle}>No suggestions yet.</p>}
      {contributions.map((item) => <article key={item.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
        <div style={{ font: '600 12px var(--sans)', color: 'var(--ink-2)' }}>{item.mine ? 'Yours' : item.contributorName} · {item.status} · {new Date(item.createdAt).toLocaleDateString()}</div>
        {/* Plain text, never HTML/Markdown: visitor text cannot create links or executable markup. */}
        <p style={proseStyle}>{item.text}</p>
        {item.responses.map((response) => <div key={response.id} style={{ padding: '6px 0 6px 12px', borderLeft: '2px solid var(--line-2)', marginTop: 8 }}>
          <div style={{ font: '600 12px var(--sans)' }}>{agentShortName(response.agentId)} · {response.status}</div>
          <p style={proseStyle}>{response.response}</p>
          {response.revisionId && <button type="button" style={buttonStyle} onClick={() => void openRevision(response.revisionId!)}>View resulting version</button>}
        </div>)}
      </article>)}
      {trail && <p style={{ ...proseStyle, fontSize: 11, color: 'var(--ink-3)' }}>Latest 20 suggestions, your latest 20, and the latest 10 responses on each.</p>}

      <h3 style={{ margin: '24px 0 8px', font: '700 16px var(--display)' }}>Saved versions</h3>
      {trail && !trail.revisions.length && <p style={proseStyle}>The first edit will preserve the original and the new version here.</p>}
      {trail?.revisions.map((item) => <button key={item.id} type="button" style={{ ...buttonStyle, display: 'block', margin: '6px 0', textAlign: 'left', maxWidth: '100%' }} onClick={() => void openRevision(item.id)}>
        Version {item.version} · {new Date(item.createdAt).toLocaleDateString()}{item.contributionId ? ' · visitor suggestion credited' : ''}
      </button>)}
      {revisionError && <p role="alert" style={proseStyle}>{revisionError}</p>}
      {revision && <section ref={revisionPanel} aria-label={`Version ${revision.version}`} style={{ marginTop: 14 }}>
        <h4 style={{ margin: '8px 0' }}>Version {revision.version}: {revision.title}</h4>
        <p style={{ ...proseStyle, fontSize: 12 }}>Read-only saved content. Interactive code is shown as text.</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, maxHeight: 320, overflow: 'auto', background: '#fff', borderRadius: 8, font: '12px/1.5 var(--mono)' }}>{revision.body}</pre>
        <button type="button" style={buttonStyle} onClick={() => setRevision(null)}>Close version</button>
      </section>}
    </section>
  );
}
