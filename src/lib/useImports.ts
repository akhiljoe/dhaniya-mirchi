// Follows the household's imports while `enabled` (design §7.10): fast while
// one runs, slow otherwise. Every screen reads the same poll, so the import
// screen and the bar across the app never disagree.
import { useCallback, useEffect, useRef, useState } from 'react';

import { IMPORT_IDLE_POLL_MS, IMPORT_POLL_MS } from './constants';
import { fetchImports, overallImport, type ImportJob, type OverallImport } from './imports';

export interface ImportsState {
  jobs: ImportJob[];
  overall: OverallImport;
  loaded: boolean; // false until the first answer — don't say "nothing yet" before it
  refresh: () => void;
}

export function useImports(enabled: boolean): ImportsState {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // A notice just arrived (the service worker says so): refresh now.
  useEffect(() => {
    if (!enabled || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'notice') refresh();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const poll = async () => {
      let live = true;
      try {
        const { imports } = await fetchImports();
        if (stopped) return;
        setJobs(imports);
        setLoaded(true);
        const phase = overallImport(imports).phase;
        live = phase === 'running' || phase === 'ready';
      } catch {
        // No household yet (403) or a blip: try again at the slow pace.
        live = false;
      }
      if (!stopped) timer.current = window.setTimeout(poll, live ? IMPORT_POLL_MS : IMPORT_IDLE_POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [enabled, tick]);

  return { jobs, overall: overallImport(jobs), loaded, refresh };
}
