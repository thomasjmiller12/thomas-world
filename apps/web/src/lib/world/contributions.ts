import { ArtifactTrailResponse, ArtifactRevisionResponse, CreateContributionResponse } from '@town/contract';
import { resolveWorldBaseUrl } from './mapping';
import { getMyVisitorId } from '@/lib/visitor-id';

const baseUrl = () => resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);
function identity() {
  try {
    const visitorId = getMyVisitorId();
    const token = localStorage.getItem('town.visitorToken');
    return visitorId && token ? { visitorId, token } : null;
  } catch { return null; }
}

export async function fetchArtifactTrail(artifactId: string, options: { readOnly: boolean; signal?: AbortSignal }) {
  const visitor = options.readOnly ? null : identity();
  const url = new URL(`${baseUrl()}/artifacts/${encodeURIComponent(artifactId)}/trail`);
  if (visitor) url.searchParams.set('visitorId', visitor.visitorId);
  const res = await fetch(url, { signal: options.signal, headers: visitor ? { 'x-visitor-token': visitor.token } : {} });
  // A stale browser identity must not hide the public trail.
  if (res.status === 401 && visitor) return fetchArtifactTrail(artifactId, { ...options, readOnly: true });
  if (!res.ok) throw new Error('The suggestion history could not be loaded.');
  return ArtifactTrailResponse.parse(await res.json());
}

export async function submitContribution(artifactId: string, text: string, requestId: string, options: { readOnly: boolean }) {
  if (options.readOnly) throw new Error('Observer mode is read-only.');
  const visitor = identity();
  if (!visitor) throw new Error('Enter town before leaving a suggestion.');
  const res = await fetch(`${baseUrl()}/artifacts/${encodeURIComponent(artifactId)}/contributions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-visitor-token': visitor.token },
    body: JSON.stringify({ visitorId: visitor.visitorId, requestId, text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? (res.status === 401 ? 'Your visitor session expired. Re-enter town to try again.' : 'The suggestion could not be saved. Try again.'));
  }
  return CreateContributionResponse.parse(await res.json());
}

export async function fetchArtifactRevision(artifactId: string, revisionId: string, signal?: AbortSignal) {
  const res = await fetch(`${baseUrl()}/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revisionId)}`, { signal });
  if (!res.ok) throw new Error('This version could not be opened.');
  return ArtifactRevisionResponse.parse(await res.json()).revision;
}
