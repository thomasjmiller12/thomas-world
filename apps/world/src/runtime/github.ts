// GitHub reference layer — read-only access to Thomas's actual code
// repositories, the same shape as the vault reference layer (vault.ts):
// list / browse / read / search, no writes. Where the vault is Thomas's
// knowledge base, this is his codebase — the Builder especially reaches for it,
// but any facet can reference a real project.
//
// Fully env-gated (brief): no GITHUB_TOKEN => the tools degrade in-fiction
// ("the workshop's git remote isn't wired up yet"). The credential is a
// fine-grained, READ-ONLY PAT on Thomas's account (Contents + Metadata: read);
// even so, every call here is a GET — read-only is enforced at both layers.

import { config } from "../config.js";

const API = "https://api.github.com";
// Cap how much one file read pulls into the tick context (parallels vault.ts).
const FILE_TRUNCATE = 14_000;
const MAX_LIST = 80;
const MAX_SEARCH = 25;

export const GITHUB_REFERENCE_FICTION =
  "The workshop's line to Thomas's code repositories isn't wired up yet — there's nothing to browse here for now. You could file a request_capability if you wish it were.";

export interface GithubResult {
  ok: boolean;
  text: string;
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn("[github] GITHUB_TOKEN absent — code-repo reference tools degrade in-fiction.");
}

function token(): string | null {
  return config.githubToken ?? null;
}

function defaultOwner(): string {
  return config.githubUser;
}

// Accept either a bare repo name ("thomas-world2") — prefixed with the default
// owner — or an explicit "owner/repo" for collaborator repos under other owners.
export function normalizeRepo(repo: string): string {
  const cleaned = repo.trim().replace(/^\/+|\/+$/g, "");
  return cleaned.includes("/") ? cleaned : `${defaultOwner()}/${cleaned}`;
}

interface GhResponse {
  ok: boolean;
  status: number;
  // Parsed JSON body on success; null on network error.
  body: unknown;
}

async function gh(path: string): Promise<GhResponse> {
  const t = token();
  if (!t) return { ok: false, status: 0, body: null };
  try {
    const res = await fetch(`${API}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "thomas-town-world",
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty / non-JSON body */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    console.warn("[github] request failed:", (err as Error).message);
    return { ok: false, status: 0, body: null };
  }
}

// Turn a non-ok response into an in-fiction soft failure (never throws).
function softFail(res: GhResponse, subject: string): GithubResult {
  if (res.status === 404) return { ok: false, text: `Couldn't find ${subject}.` };
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      text: "The repository line is acting up right now — the connection got refused. Try again later.",
    };
  }
  return { ok: false, text: `Couldn't reach ${subject} right now — the line's quiet. Try again later.` };
}

// --- read-side tools --------------------------------------------------------

interface RepoSummary {
  full_name?: string;
  name?: string;
  description?: string | null;
  language?: string | null;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  pushed_at?: string;
}

export async function listRepos(): Promise<GithubResult> {
  if (!token()) {
    warnOnce();
    return { ok: false, text: GITHUB_REFERENCE_FICTION };
  }
  const res = await gh(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator`);
  if (!res.ok || !Array.isArray(res.body)) return softFail(res, "Thomas's repositories");
  const repos = (res.body as RepoSummary[])
    .filter((r) => !r.archived)
    .slice(0, MAX_LIST)
    .map((r) => {
      const name = r.full_name ?? r.name ?? "(unknown)";
      const tags = [r.language, r.private ? "private" : null, r.fork ? "fork" : null]
        .filter(Boolean)
        .join(", ");
      const desc = r.description ? ` — ${r.description}` : "";
      return `${name}${desc}${tags ? ` [${tags}]` : ""}`;
    });
  return {
    ok: true,
    text: repos.length
      ? `Thomas's repositories (most recently worked on first):\n${repos.join("\n")}`
      : "No repositories came back.",
  };
}

interface ContentEntry {
  name?: string;
  path?: string;
  type?: string; // "file" | "dir" | "symlink" | "submodule"
  size?: number;
  // present on a single-file response
  content?: string;
  encoding?: string;
}

export async function browseRepo(repo: string, path: string): Promise<GithubResult> {
  if (!token()) {
    warnOnce();
    return { ok: false, text: GITHUB_REFERENCE_FICTION };
  }
  const full = normalizeRepo(repo);
  const rel = (path || "").replace(/^\/+|\/+$/g, "");
  const res = await gh(`/repos/${full}/contents/${encodeURI(rel)}`);
  if (!res.ok) return softFail(res, `${full}/${rel || "(root)"}`);
  // A directory comes back as an array; a file as an object.
  if (Array.isArray(res.body)) {
    const entries = (res.body as ContentEntry[])
      .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
      .filter(Boolean)
      .sort()
      .slice(0, MAX_LIST);
    const where = rel ? `${full}/${rel}` : full;
    return {
      ok: true,
      text: entries.length
        ? `Contents of ${where}:\n${entries.join("\n")}\n\n(Use read_repo_file to open one.)`
        : `${where} is empty.`,
    };
  }
  // It's a file — point them at read_repo_file rather than dumping it here.
  const entry = res.body as ContentEntry;
  return {
    ok: true,
    text: `${full}/${entry.path ?? rel} is a file (${entry.size ?? "?"} bytes). Use read_repo_file to read it.`,
  };
}

export async function readRepoFile(repo: string, path: string, ref?: string): Promise<GithubResult> {
  if (!token()) {
    warnOnce();
    return { ok: false, text: GITHUB_REFERENCE_FICTION };
  }
  const full = normalizeRepo(repo);
  const rel = (path || "").replace(/^\/+|\/+$/g, "");
  if (!rel) return { ok: false, text: "Give the path to a file in the repo." };
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await gh(`/repos/${full}/contents/${encodeURI(rel)}${query}`);
  if (!res.ok) return softFail(res, `${full}/${rel}`);
  if (Array.isArray(res.body)) {
    return { ok: false, text: `${full}/${rel} is a directory — use browse_repo to list it.` };
  }
  const entry = res.body as ContentEntry;
  if (entry.encoding !== "base64" || typeof entry.content !== "string") {
    return { ok: false, text: `${full}/${rel} can't be read as text (it may be too large or binary).` };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(entry.content, "base64").toString("utf8");
  } catch {
    return { ok: false, text: `${full}/${rel} couldn't be decoded as text.` };
  }
  const text =
    decoded.length > FILE_TRUNCATE ? decoded.slice(0, FILE_TRUNCATE) + "\n…(truncated)" : decoded;
  return { ok: true, text: `${full}/${rel}:\n\n${text}` };
}

interface CodeSearchItem {
  name?: string;
  path?: string;
  repository?: { full_name?: string };
}

export async function searchCode(query: string): Promise<GithubResult> {
  if (!token()) {
    warnOnce();
    return { ok: false, text: GITHUB_REFERENCE_FICTION };
  }
  // Scope the search to Thomas's account so results are his code, not all of
  // GitHub. Code search only indexes default branches (GitHub limitation).
  const q = `${query} user:${defaultOwner()}`;
  const res = await gh(`/search/code?q=${encodeURIComponent(q)}&per_page=${MAX_SEARCH}`);
  if (!res.ok || typeof res.body !== "object" || res.body === null) {
    return softFail(res, "the code search");
  }
  const items = ((res.body as { items?: CodeSearchItem[] }).items ?? []).slice(0, MAX_SEARCH);
  if (!items.length) return { ok: true, text: `No code in Thomas's repositories matches "${query}".` };
  const lines = items.map((it) => `${it.repository?.full_name ?? "?"}: ${it.path ?? it.name ?? "?"}`);
  return { ok: true, text: `Matches for "${query}":\n${lines.join("\n")}` };
}
