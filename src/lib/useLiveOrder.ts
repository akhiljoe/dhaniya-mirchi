// The order this household has on the go (design §19 stages 2-3).
//
// Carts can be forgotten; an order cannot. It may be holding a placed order
// that is waiting for a bank's code, and if the page that started it has been
// closed there has to be a way back to it. So the app asks, from wherever the
// household happens to be.
import { useCallback, useEffect, useRef, useState } from 'react';

import { liveOrder } from './pay';
import { ORDER_POLL_MS } from './constants';

export function useLiveOrder(enabled: boolean) {
  const [id, setId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { id: live } = await liveOrder();
      setId(live);
    } catch {
      // A blip: the next ask tries again. Never clears what we know.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setId(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      await refresh();
      if (stopped) return;
      timer.current = window.setTimeout(tick, ORDER_POLL_MS * 5);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, refresh]);

  return { id, refresh, forget: () => setId(null) };
}
