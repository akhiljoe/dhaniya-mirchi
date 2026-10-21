// The carts being filled (design §19 stage 1). Several may be waiting: the
// household keeps tapping while one is running, and the worker fills them one
// after another. This follows them until each is done, so the page can say
// what happened without anyone waiting on a screen.
import { useCallback, useEffect, useRef, useState } from 'react';

import { addToCart, listCartJobs, type CartJobSummary, type CartWant } from './cart';
import { CART_POLL_MS } from './constants';

export function useCartJobs(enabled: boolean) {
  const [jobs, setJobs] = useState<CartJobSummary[]>([]);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { jobs: fresh } = await listCartJobs();
      setJobs(fresh);
    } catch {
      // A blip: the next poll tries again.
    }
  }, [enabled]);

  // Poll while anything is still being filled; stop when nothing is.
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const tick = async () => {
      await refresh();
      if (stopped) return;
      timer.current = window.setTimeout(tick, CART_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, refresh]);

  // The job's id comes back: a cart can be called off in the seconds before
  // the worker picks it up, and the page needs to know which one.
  const send = useCallback(
    async (vendor: string, items: CartWant[]) => {
      const { id } = await addToCart(vendor, items);
      await refresh();
      return id;
    },
    [refresh],
  );

  const active = jobs.filter((j) => j.status === 'requested' || j.status === 'running');
  return { jobs, active, latestDone: jobs.find((j) => j.status === 'done' || j.status === 'failed') ?? null, send, refresh };
}
