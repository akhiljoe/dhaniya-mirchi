import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CreditCard, Loader2, Truck, X } from 'lucide-react';

import { agreeToTotal, asks, cancelOrder, getOrder, isWaiting, orderText, sendSecret, startOrder, unpaidWarning, type OrderJob, type PayMethod } from '@/lib/pay';
import { cartVendorInfo, ORDER_POLL_MS } from '@/lib/constants';

// Paying for the cart, from here (design §19 stages 2-3).
//
// Two things this screen says plainly rather than hiding:
//
//   * A card needs the CVV and then the bank's code, every time. That is how
//     the app's own checkout works, and pretending otherwise would just make
//     the wait look broken.
//   * If an order gets placed and the payment does not go through, it says
//     so. The app makes the order before the money moves, so that is a real
//     thing that can happen and the household has to hear it from us.
export function PayNow({
  toPay,
  cards,
  vendor,
  cartJobId,
  resume,
  onClose,
  onPaid,
}: {
  toPay: number;
  cards: string[];
  // The app the CART is on. Never a constant: this screen once sent every
  // order as Instamart whatever cart it was for, and a Blinkit cart came up
  // titled "Pay Instamart" with the one method Blinkit does not have.
  vendor: string;
  // The cart being paid for. The worker checks the payment screen against it
  // and pays through that cart's own connection.
  cartJobId?: string | null;
  // An order that is already under way, opened from anywhere in the app
  // rather than only from the page that started it.
  resume?: string | null;
  onClose: () => void;
  // The money moved. Whoever is showing the cart this paid for stops
  // offering to pay for it.
  onPaid?: (orderId: string | null) => void;
}) {
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [card, setCard] = useState<string | null>(cards[0] ?? null);
  const [id, setId] = useState<string | null>(resume ?? null);
  const [job, setJob] = useState<OrderJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow the order until it is over.
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const next = await getOrder(id);
        if (stop) return;
        setJob(next);
        if (isWaiting(next.status)) setTimeout(tick, ORDER_POLL_MS);
      } catch {
        if (!stop) setTimeout(tick, ORDER_POLL_MS);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);

  const begin = async (how: PayMethod) => {
    setBusy(true);
    setError(null);
    try {
      const started = await startOrder(vendor, how, toPay, how === 'card' ? (card ?? undefined) : undefined, cartJobId ?? undefined);
      setMethod(how);
      setId(started.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not start. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const wants = asks(job);
  const done = job && !isWaiting(job.status);
  // Said once, the moment it is true.
  const paidSaid = useRef(false);
  useEffect(() => {
    // "Settled" is an order existing at the store, not only money read back:
    // an order the worker could not confirm is still an order, and the cart
    // it paid for must leave the line either way.
    if (job && !isWaiting(job.status) && (job.paid || job.orderId) && !paidSaid.current) {
      paidSaid.current = true;
      onPaid?.(job.orderId);
    }
  }, [job?.status, job?.paid, job?.orderId, onPaid]);
  const unpaid = job && unpaidWarning(job);
  // A resumed order says which app it is on; a fresh one is on the cart's.
  const info = cartVendorInfo(job?.vendor ?? vendor);
  // A card can be chosen here only when the cards are known. On an app whose
  // checkout has never been opened they are not, and the worker then takes
  // the one card the screen shows.
  const cardKnown = cards.length > 0;
  const canPayByCard = cardKnown || !info.payOnDelivery;

  return (
    <Sheet title={job ? 'Paying' : `Pay ${info.name}`} onClose={onClose}>
      {/* The same sentence the card shows, in case this sheet is reached for
          an app the api will refuse. Better here than as a 400 after a tap. */}
      {!id && !info.canPay && <p className="text-sm text-ink-700">Paying on {info.name} from here is not ready yet.</p>}
      {!id && info.canPay && (
        <>
          {/* Two lines before the first control, not four. */}
          <p className="text-sm text-ink-700">
            ₹{Math.round(toPay)} in your cart. {info.name} adds its fees at checkout and shows you its total before anything is
            ordered.
          </p>

          {cards.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-ink-500 mb-2">Card</p>
              <div className="space-y-1.5">
                {cards.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCard(c)}
                    className={`w-full text-left text-sm py-2.5 px-3 rounded-xl border ${card === c ? 'border-sage-500 bg-sage-50 text-ink-900' : 'border-sand-200 text-ink-700'}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-400 mt-2">A card needs its CVV, then the code your bank sends. Both are asked for here.</p>
            </div>
          )}

          <div className="flex flex-col gap-2 mt-5">
            {canPayByCard && (
              <button onClick={() => begin('card')} disabled={busy || (cardKnown && !card)} className="btn-primary text-sm py-2.5 px-4 justify-center">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                Pay ₹{Math.round(toPay)} {cardKnown ? 'by card' : 'with your saved card'}
              </button>
            )}
            {/* Only where the app's checkout actually has it. */}
            {info.payOnDelivery && (
              <button onClick={() => begin('on_delivery')} disabled={busy} className="btn-secondary text-sm py-2.5 px-4 justify-center">
                <Truck className="w-4 h-4" />
                Order now, pay on delivery
              </button>
            )}
            {!cardKnown && (
              <p className="text-xs text-ink-400">
                {info.payOnDelivery
                  ? 'Your saved cards are listed here after the first order. Paying on delivery needs nothing typed.'
                  : `The card saved in ${info.name} is used. It needs its CVV, then the code your bank sends. Both are asked for here.`}
              </p>
            )}
          </div>
        </>
      )}

      {job && (
        <>
          <p className="flex items-start gap-2 text-sm text-ink-800">
            {job.status === 'done' ? (
              <Check className="w-4 h-4 text-sage-600 shrink-0 mt-0.5" />
            ) : job.status === 'failed' ? (
              <X className="w-4 h-4 text-clay-500 shrink-0 mt-0.5" />
            ) : (
              <Loader2 className="w-4 h-4 text-ink-400 shrink-0 mt-0.5 animate-spin" />
            )}
            {orderText(job)}
          </p>

          {/* The bank's own figure wins wherever there is one. The app's
              total is what the checkout said before the order was made, and
              the app can change the order after that: on 2026-09-23 the
              screen said 320 while the bank asked for 255, one item having
              gone. Showing the stale one beside a code box is asking somebody
              to approve a number that is not the one being taken. */}
          {job.bankTotal !== null && job.status !== 'failed' && (
            <p className="text-xs text-ink-700 mt-2">
              Your bank is asking for ₹{Math.round(job.bankTotal)}.
              {job.vendorTotal !== null && Math.round(job.bankTotal) !== Math.round(job.vendorTotal)
                ? ` The app had said ₹${Math.round(job.vendorTotal)}, so something in the order changed. Check it in the app before you type the code.`
                : ''}
            </p>
          )}

          {job.bankTotal === null && job.vendorTotal !== null && job.status !== 'failed' && job.status !== 'awaiting_ok' && (
            <p className="text-xs text-ink-500 mt-2">The app's total: ₹{Math.round(job.vendorTotal)}.</p>
          )}

          {/* The cart's bill is not what the checkout charges: the app adds
              fees its own cart call never spells out. Rather than pay a
              number nobody saw, it asks with the app's own figure. */}
          {job.status === 'awaiting_ok' && job.vendorTotal !== null && (
            <div className="mt-4">
              <p className="text-xs text-ink-500">Fees are added at checkout. Nothing has been ordered.</p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={async () => {
                    setError(null);
                    try {
                      await agreeToTotal(id!, job.vendorTotal!);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'That did not go through. Try again.');
                    }
                  }}
                  className="btn-primary text-sm py-2.5 px-4"
                >
                  Pay ₹{Math.round(job.vendorTotal)}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await cancelOrder(id!);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Too late to stop that one.');
                    }
                  }}
                  className="btn-ghost text-sm"
                >
                  No
                </button>
              </div>
            </div>
          )}

          {wants && <SecretBox id={id!} kind={wants} onError={setError} />}

          {/* Changing your mind with the code box open, which the app this
              pays through offers on its own payment screen too. What it can
              undo depends on how far this has gone, and the words say which:
              before Pay there is nothing to undo, after it there is a real
              order that was never paid for. */}
          {wants && (
            <div className="mt-3">
              <button
                onClick={async () => {
                  setError(null);
                  try {
                    await cancelOrder(id!);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'That one is already finished. Check the app.');
                  }
                }}
                className="btn-ghost text-sm"
              >
                Cancel payment
              </button>
              <p className="text-2xs text-ink-400 mt-1">
                {wants === 'otp'
                  ? 'The order is already placed. This stops the payment, so it stays unpaid - check it in the app.'
                  : 'Nothing has been ordered yet, so this stops it completely.'}
              </p>
            </div>
          )}

          {unpaid && (
            <p className="flex items-start gap-2 text-sm text-clay-700 bg-clay-50 rounded-xl p-3 mt-4">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {unpaid}
            </p>
          )}
          {job.orderId && job.paid && <p className="text-xs text-ink-400 mt-2">Order {job.orderId}.</p>}
        </>
      )}

      {error && <p className="text-sm text-clay-600 mt-3">{error}</p>}

      <div className="flex gap-2 mt-5">
        {(unpaid || job?.status === 'done') && info.url && (
          <a href={info.url} target="_blank" rel="noreferrer" className="btn-primary text-sm py-2 px-4">
            Open {info.name}
          </a>
        )}
        {id && job && isWaiting(job.status) && !job.orderId && (
          <button
            onClick={async () => {
              try {
                await cancelOrder(id);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Too late to stop that one.');
              }
            }}
            className="btn-ghost text-sm"
          >
            Stop
          </button>
        )}
        <button onClick={onClose} className="btn-ghost text-sm">
          {done || !id ? 'Close' : 'Hide'}
        </button>
      </div>
      {method === 'card' && !done && <p className="text-2xs text-ink-400 mt-3">Your CVV and the bank's code are used once and not kept.</p>}
    </Sheet>
  );
}

// Shown wherever the household is while an order is still going. It says
// only that one is, because what it is waiting for changes and the sheet is
// where that is answered.
export function LiveOrderBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="fixed left-0 right-0 bottom-14 md:bottom-0 z-30 px-4 pb-2">
      <div className="max-w-3xl mx-auto card shadow-soft-lg p-3 flex items-center gap-3">
        <Loader2 className="w-5 h-5 text-sage-600 animate-spin-slow shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-800">An order is going through</p>
          <p className="text-2xs text-ink-500">It may need something from you.</p>
        </div>
        <button onClick={onOpen} className="btn-primary text-sm py-2 px-4 shrink-0">
          Open
        </button>
      </div>
    </div>
  );
}

// The one box the household types into. It clears itself the moment it is
// sent, and what was typed is never put anywhere else.
function SecretBox({ id, kind, onError }: { id: string; kind: 'cvv' | 'otp'; onError: (e: string | null) => void }) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue('');
    setSent(false);
    box.current?.focus();
  }, [kind]);

  if (sent) return <p className="text-xs text-ink-400 mt-3">Sent. Give it a moment.</p>;

  const send = async () => {
    setSending(true);
    onError(null);
    try {
      await sendSecret(id, kind, value);
      setValue('');
      setSent(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not go through. Try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex gap-2 mt-4">
      <input
        ref={box}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && value && void send()}
        inputMode="numeric"
        autoComplete="off"
        aria-label={kind === 'cvv' ? 'Card CVV' : 'Code from your bank'}
        placeholder={kind === 'cvv' ? 'CVV' : 'Code'}
        className="flex-1 text-sm py-2.5 px-3 rounded-xl border border-sand-200 bg-surface tracking-widest"
      />
      <button onClick={() => void send()} disabled={sending || value.length < 3} className="btn-primary text-sm py-2 px-4">
        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send'}
      </button>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 bg-scrim/30 backdrop-blur-sm z-40 animate-fade-in" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:bottom-auto md:translate-x-[-50%] md:translate-y-[-50%] md:w-[440px] z-50 sheet-surface rounded-t-3xl md:rounded-3xl shadow-soft-lg max-h-[85vh] overflow-y-auto scroll-area animate-slide-up md:animate-scale-in">
        <div className="md:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1.5 rounded-full bg-sand-300" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-xl text-ink-900">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-sand-100 text-ink-400">
              <X className="w-5 h-5" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
