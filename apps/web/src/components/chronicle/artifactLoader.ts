import type { Artifact } from '@town/contract';

// Initial reads, retries, and live updates share one generation. Aborting alone
// is insufficient when an older request has already received its response.
export function createArtifactLoader(
  fetchArtifact: (signal: AbortSignal) => Promise<Artifact>,
  handlers: {
    onArtifact: (artifact: Artifact) => void;
    onLoading: (loading: boolean) => void;
    onError: (error: boolean) => void;
  },
) {
  let generation = 0;
  let controller: AbortController | null = null;
  let hasArtifact = false;
  const cancel = () => {
    generation++;
    controller?.abort();
  };
  const load = (background = false) => {
    cancel();
    const current = generation;
    controller = new AbortController();
    if (!background) {
      handlers.onLoading(true);
      handlers.onError(false);
    }
    void fetchArtifact(controller.signal).then((artifact) => {
      if (current !== generation) return;
      hasArtifact = true;
      handlers.onArtifact(artifact);
      handlers.onError(false);
    }).catch(() => {
      // Keep an existing page (and its contribution draft) mounted if a live
      // refresh fails. If no page has loaded yet, show the opening error.
      if (current === generation && (!background || !hasArtifact)) handlers.onError(true);
    }).finally(() => {
      // A live update can supersede the initial read and finish opening it.
      if (current === generation) handlers.onLoading(false);
    });
  };
  return { load, cancel };
}
