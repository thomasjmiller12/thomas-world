import type { ChroniclePage } from './chronicleClient';

// Completion arrives over SSE. These finite followups cover a missed signal or
// reconnect, including generations slower than the old one-shot seven seconds.
const FOLLOWUP_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000];

export function createChronicleLoader(
  fetchPage: (opts: { day: string | null; signal: AbortSignal }) => Promise<ChroniclePage>,
  handlers: {
    onPage: (page: ChroniclePage) => void;
    onLoading: (loading: boolean) => void;
    onError: (error: boolean) => void;
  },
) {
  let sequence = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const cancel = () => {
    sequence++;
    controller?.abort();
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const load = (day: string | null, silent = false) => {
    cancel();
    const seq = sequence;
    controller = new AbortController();
    if (!silent) {
      attempts = 0;
      handlers.onLoading(true);
      handlers.onError(false);
    }
    void fetchPage({ day, signal: controller.signal }).then((page) => {
      if (seq !== sequence) return;
      handlers.onPage(page);
      handlers.onError(false);
      if (!page.generationPending) attempts = 0;
      else if (attempts < FOLLOWUP_DELAYS.length) {
        const delay = FOLLOWUP_DELAYS[attempts++];
        timer = setTimeout(() => {
          timer = null;
          load(day, true);
        }, delay);
      }
    }).catch(() => {
      if (seq === sequence && !silent) handlers.onError(true);
    }).finally(() => {
      // A silent refresh may supersede an initial request: it must also clear
      // the initial loading state when its replacement response arrives.
      if (seq === sequence) handlers.onLoading(false);
    });
  };
  return { load, cancel };
}
