import { useEffect, useMemo, useRef } from 'react';
import type { Artifact } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { fetchArtifactState, putArtifactStateKey } from '@/lib/world/artifact-state';
import { getMyVisitorId } from '@/lib/visitor-id';

// ArtifactFrame (programmable world D1/D3) — the sandboxed runtime for
// `interactive` artifacts: agent-authored single-file web apps. The app runs in
// an iframe with sandbox="allow-scripts" ONLY (opaque origin: no cookies, no
// storage, no parent DOM) plus a strict CSP baked into the srcdoc head (no
// network — the offline, one-file constraint is the medium). Its single
// capability is the injected `window.town` bridge: a postMessage RPC to THIS
// component, which proxies to the world server's per-artifact state store and
// pushes live state on artifact.state_changed events. The bridge, not the
// frame, carries the visitor's identity — the app never sees tokens.

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: https: blob:",
  "media-src data: https: blob:",
  "font-src data: https:",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
  "connect-src 'none'",
].join('; ');

// The bridge injected ahead of the artifact's own code. Kept dependency-free
// and ES5-ish so it never trips inside the sandbox.
function bridgeScript(artifactId: string, visitor: { id: string; name: string } | null): string {
  return `<script>(function(){
var pending = new Map(); var seq = 0; var listeners = [];
window.addEventListener('message', function(e){
  var d = e.data; if (!d || d.__town !== true) return;
  if (d.kind === 'state') { listeners.forEach(function(cb){ try { cb(d.state); } catch(_){} }); return; }
  var p = pending.get(d.reqId); if (!p) return; pending.delete(d.reqId);
  if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
});
function call(op, payload){ return new Promise(function(resolve, reject){
  var reqId = ++seq; pending.set(reqId, {resolve: resolve, reject: reject});
  parent.postMessage(Object.assign({__town: true, op: op, reqId: reqId}, payload || {}), '*');
});}
window.town = {
  artifactId: ${JSON.stringify(artifactId)},
  visitor: ${JSON.stringify(visitor)},
  getState: function(){ return call('get'); },
  setState: function(key, value){ return call('set', {key: key, value: value}); },
  onChange: function(cb){ listeners.push(cb); }
};
})();</script>`;
}

interface Props {
  artifact: Artifact;
  // Height of the app viewport; the reader passes something roomy.
  height?: number | string;
}

export function ArtifactFrame({ artifact, height = 520 }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(() => {
    const visitorId = getMyVisitorId();
    let visitorName: string | null = null;
    try {
      visitorName = localStorage.getItem('town.visitorName');
    } catch {
      /* SSR/no-storage — bridge ships visitor: null */
    }
    const visitor = visitorId ? { id: visitorId, name: visitorName ?? 'Visitor' } : null;
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      bridgeScript(artifact.id, visitor),
      '</head><body style="margin:0">',
      artifact.body,
      '</body></html>',
    ].join('');
  }, [artifact.id, artifact.body]);

  // Parent side of the bridge: answer get/set RPCs from OUR iframe only, and
  // push fresh state into the frame whenever this artifact's state changes on
  // the world stream.
  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;

    const reply = (reqId: number, result?: unknown, error?: string) => {
      frame.contentWindow?.postMessage({ __town: true, reqId, result, error }, '*');
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { __town?: boolean; op?: string; reqId?: number; key?: string; value?: unknown };
      if (!d || d.__town !== true || typeof d.reqId !== 'number') return;
      if (d.op === 'get') {
        fetchArtifactState(artifact.id)
          .then((state) => reply(d.reqId!, state))
          .catch((err) => reply(d.reqId!, undefined, (err as Error).message));
      } else if (d.op === 'set') {
        if (typeof d.key !== 'string' || !d.key) {
          reply(d.reqId, undefined, 'setState needs a string key');
          return;
        }
        putArtifactStateKey(artifact.id, d.key, d.value ?? null)
          .then((r) => (r.ok ? reply(d.reqId!, true) : reply(d.reqId!, undefined, r.message ?? 'write refused')))
          .catch((err) => reply(d.reqId!, undefined, (err as Error).message));
      }
    };

    const onWorldEvent = (ev: { type: string; payload?: unknown }) => {
      if (ev.type !== 'artifact.state_changed') return;
      const p = ev.payload as { artifactId?: string } | undefined;
      if (p?.artifactId !== artifact.id) return;
      fetchArtifactState(artifact.id)
        .then((state) => frame.contentWindow?.postMessage({ __town: true, kind: 'state', state }, '*'))
        .catch(() => {});
    };

    window.addEventListener('message', onMessage);
    EventBus.on('world-event', onWorldEvent);
    return () => {
      window.removeEventListener('message', onMessage);
      EventBus.off('world-event', onWorldEvent);
    };
  }, [artifact.id]);

  return (
    <iframe
      ref={iframeRef}
      title={artifact.title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{
        width: '100%',
        height,
        border: '1px solid var(--line)',
        borderRadius: 12,
        background: '#fff',
        display: 'block',
      }}
    />
  );
}
