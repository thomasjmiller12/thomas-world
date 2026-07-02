import { ArtifactStateResponse } from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';
import { getMyVisitorId } from '@/lib/visitor-id';

// Client for the artifact state store (programmable world D3) — the keyed JSON
// "database" an interactive artifact shares with its owning agent. Reads are
// public; writes carry this visitor's identity + token (same localStorage keys
// WorldClient persists).

const baseUrl = (): string => resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);

function visitorToken(): string | null {
  try {
    return localStorage.getItem('town.visitorToken');
  } catch {
    return null;
  }
}

export async function fetchArtifactState(
  artifactId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl()}/artifacts/${encodeURIComponent(artifactId)}/state`, {
    signal,
  });
  if (!res.ok) throw new Error(`artifact state failed: ${res.status}`);
  return ArtifactStateResponse.parse(await res.json()).state;
}

export async function putArtifactStateKey(
  artifactId: string,
  key: string,
  value: unknown,
): Promise<{ ok: boolean; message?: string }> {
  const visitorId = getMyVisitorId();
  const token = visitorToken();
  if (!visitorId || !token) return { ok: false, message: 'no visitor identity yet' };
  const res = await fetch(
    `${baseUrl()}/artifacts/${encodeURIComponent(artifactId)}/state/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-visitor-token': token },
      body: JSON.stringify({ visitorId, value }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, message: body.message ?? `write failed (${res.status})` };
  }
  return { ok: true };
}
