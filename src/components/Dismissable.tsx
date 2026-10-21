import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { NOTICE_SHOWN_MS, NOTICE_SWIPE_PX } from '@/lib/constants';

// A notice that goes away by itself, or on a swipe right. Used for the ones
// that only report what already happened ("Synced 1 order", "Your cart is
// ready"): they must not sit in the way of the page.
//
// Touch and mouse alike (pointer events), and the keyboard gets the close
// button the notice itself provides. A swipe that does not reach far enough
// springs back.
export function Dismissable({
  onDismiss,
  afterMs = NOTICE_SHOWN_MS,
  children,
  className = '',
}: {
  onDismiss: () => void;
  afterMs?: number | null; // null: only by swipe or its own button
  children: React.ReactNode;
  className?: string;
}) {
  const [dx, setDx] = useState(0);
  const [going, setGoing] = useState(false);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (afterMs === null) return;
    const t = window.setTimeout(() => setGoing(true), afterMs);
    return () => window.clearTimeout(t);
  }, [afterMs]);

  // The slide out finishes before it is taken off the page.
  useEffect(() => {
    if (!going) return;
    const t = window.setTimeout(onDismiss, 200);
    return () => window.clearTimeout(t);
  }, [going, onDismiss]);

  const down = (e: ReactPointerEvent) => {
    start.current = e.clientX;
  };
  const move = (e: ReactPointerEvent) => {
    if (start.current === null) return;
    setDx(Math.max(0, e.clientX - start.current)); // right only
  };
  const up = () => {
    if (dx >= NOTICE_SWIPE_PX) setGoing(true);
    setDx(0);
    start.current = null;
  };

  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ transform: going ? 'translateX(110%)' : `translateX(${dx}px)`, opacity: going ? 0 : 1 }}
      className={`touch-pan-y transition-[transform,opacity] duration-200 ${dx ? '' : 'ease-out'} ${className}`}
    >
      {children}
    </div>
  );
}
