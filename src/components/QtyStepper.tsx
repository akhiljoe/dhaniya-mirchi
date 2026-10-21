import { Minus, Plus, Trash2 } from 'lucide-react';

import { BASKET_MAX_QTY } from '@/lib/constants';

// How many of one thing is going, the way the grocery apps do it: minus,
// the count, plus - and at one, minus takes it off the list rather than
// going dead.
//
// That last part is why this is shared rather than written twice. The review
// sheet had the household settings stepper in it, which stops at a floor and
// disables its own minus there, so the only thing on the list somebody
// wanted to drop could not be dropped: the button was simply dead under
// their finger. Both places use this now, so both behave the same way.
export function QtyStepper({
  qty,
  name,
  onChange,
  onRemove,
  max = BASKET_MAX_QTY,
}: {
  qty: number;
  name: string; // what it is, for the buttons' own labels
  onChange: (qty: number) => void;
  onRemove: () => void;
  max?: number;
}) {
  const it = name.toLowerCase();
  const down = () => (qty <= 1 ? onRemove() : onChange(qty - 1));
  return (
    <div className="flex items-center gap-0.5 shrink-0 rounded-full bg-sage-600 text-sand-50">
      <button
        type="button"
        onClick={down}
        aria-label={qty === 1 ? `Take ${it} off the list` : `One less ${it}`}
        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-sage-700"
      >
        {qty === 1 ? <Trash2 className="w-3.5 h-3.5" /> : <Minus className="w-4 h-4" />}
      </button>
      <span className="min-w-[1.5rem] text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {qty}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, qty + 1))}
        disabled={qty >= max}
        aria-label={`One more ${it}`}
        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-sage-700 disabled:opacity-50"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
