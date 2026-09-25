import { useEffect, useRef, useState } from 'react';
import { fetchChronicle, type ChroniclePage } from './chronicleClient';
import { createChronicleLoader } from './chronicleLoader';

export function useChronicleData(day: string | null, enabled = true) {
  const [page, setPage] = useState<ChroniclePage>({ day: '', days: [], items: [], issue: null, generationPending: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const loader = useRef<ReturnType<typeof createChronicleLoader> | null>(null);
  if (!loader.current) loader.current = createChronicleLoader(fetchChronicle, {
    onPage: setPage, onLoading: setLoading, onError: setError,
  });
  const { load, cancel } = loader.current;
  useEffect(() => {
    if (enabled) load(day);
    return cancel;
  }, [day, enabled, load, cancel]);
  return { ...page, resolvedDay: page.day, loading, error, loadChronicle: load };
}
