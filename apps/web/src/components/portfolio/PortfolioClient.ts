import {
  AboutResponse,
  ProofsResponse,
  ProofResponse,
  ReferencesResponse,
  ReferenceResponse,
  type AboutResponse as AboutResponseT,
  type PortfolioProof,
  type ExternalReference,
  type AgentId,
} from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';

// Typed fetchers for the About / Portfolio hub (M2.2 — Part 3). Same conventions
// as chronicleClient: base URL from the build-time env var, AbortSignal threading,
// and a contract-schema parse on every response. All reads are free and stay live
// in dream mode (the About surface must work while the town sleeps).

const baseUrl = (): string => resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);

export async function fetchAbout(signal?: AbortSignal): Promise<AboutResponseT> {
  const res = await fetch(`${baseUrl()}/portfolio/about`, { signal });
  if (!res.ok) throw new Error(`about failed: ${res.status}`);
  return AboutResponse.parse(await res.json());
}

export async function fetchProofs(
  opts: { agent?: AgentId | null; tag?: string | null; featured?: boolean | null; signal?: AbortSignal } = {},
): Promise<PortfolioProof[]> {
  const url = new URL(`${baseUrl()}/portfolio/proofs`);
  if (opts.agent) url.searchParams.set('agent', opts.agent);
  if (opts.tag) url.searchParams.set('tag', opts.tag);
  if (opts.featured != null) url.searchParams.set('featured', String(opts.featured));
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`proofs failed: ${res.status}`);
  return ProofsResponse.parse(await res.json()).proofs;
}

export async function fetchProof(id: string, signal?: AbortSignal): Promise<PortfolioProof> {
  const res = await fetch(`${baseUrl()}/portfolio/proofs/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`proof failed: ${res.status}`);
  return ProofResponse.parse(await res.json()).proof;
}

export async function fetchReferences(
  opts: { q?: string | null; agent?: AgentId | null; tag?: string | null; kind?: string | null; signal?: AbortSignal } = {},
): Promise<ExternalReference[]> {
  const url = new URL(`${baseUrl()}/references`);
  if (opts.q) url.searchParams.set('q', opts.q);
  if (opts.agent) url.searchParams.set('agent', opts.agent);
  if (opts.tag) url.searchParams.set('tag', opts.tag);
  if (opts.kind) url.searchParams.set('kind', opts.kind);
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`references failed: ${res.status}`);
  return ReferencesResponse.parse(await res.json()).references;
}

export async function fetchReference(id: string, signal?: AbortSignal): Promise<ExternalReference> {
  const res = await fetch(`${baseUrl()}/references/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`reference failed: ${res.status}`);
  return ReferenceResponse.parse(await res.json()).reference;
}
