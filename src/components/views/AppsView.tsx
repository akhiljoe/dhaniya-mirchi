import { useState } from 'react';

import { CART_VENDOR, type CartVendorInfo } from '@/lib/constants';
import { ChevronDown, RefreshCw } from 'lucide-react';

import type { SourceId } from '../../types';
import type { AccountRow, VendorRow, VendorState } from '@/lib/vendors';
import { AddressPicker } from '@/components/AddressPicker';

interface AppsViewProps {
  rows: VendorRow[];
  onSync: (id: SourceId) => Promise<void>;
  onConnect: (id: SourceId) => void; // also used to reconnect
  // The two things about carts a household decides once: which app they go
  // to, and whether the other app is offered for what that one lacks. Null
  // vendor: not chosen, so the list offers every connected app.
  cartVendor?: string | null;
  cartVendors?: CartVendorInfo[];
  onCartVendor?: (id: string) => void;
  cartFallback?: boolean;
  onCartFallback?: (on: boolean) => void;
  // Which of the app's own saved addresses this household's carts are filled
  // for (design §19 stage 1).
  onChooseAddress?: (connectionId: string, addressId: string) => Promise<void>;
}

const CHIP: Record<VendorState, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'bg-sage-100 text-sage-700' },
  syncing: { label: 'Syncing', className: 'bg-sand-100 text-ink-600' },
  needs_reconnect: { label: 'Reconnect needed', className: 'bg-clay-100 text-clay-700' },
  stopped: { label: 'Sync stopped', className: 'bg-clay-100 text-clay-700' },
  not_connected: { label: 'Not connected', className: 'bg-sand-100 text-ink-400' },
  coming_soon: { label: 'Coming soon', className: 'bg-sand-100 text-ink-400' },
};

// One card per grocery app: each connected account on it (one per person in
// the household), what we hold from it, when it synced, and each recent sync.
// Syncing and (re)connecting happen here.
export function AppsView({
  rows,
  onSync,
  onConnect,
  onChooseAddress,
  cartVendor = null,
  cartVendors = [],
  onCartVendor,
  cartFallback = true,
  onCartFallback,
}: AppsViewProps) {
  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6">
      <div className="mb-6 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">Grocery apps</h1>
        <p className="text-sm text-ink-400">Where your household's orders come from.</p>
      </div>
      {cartVendors.length > 0 && (
        <CartSettings vendor={cartVendor} vendors={cartVendors} onVendor={onCartVendor} fallback={cartFallback} onFallback={onCartFallback} />
      )}
      <div className="space-y-3">
        {rows
          .filter((r) => r.state !== 'coming_soon')
          .map((r) => (
            <AppCard key={r.id} row={r} onSync={onSync} onConnect={onConnect} onChooseAddress={onChooseAddress} />
          ))}
      </div>
      {/* One line, not two cards that do nothing. */}
      {rows.some((r) => r.state === 'coming_soon') && (
        <p className="text-xs text-ink-400 mt-4">
          Coming next: {rows.filter((r) => r.state === 'coming_soon').map((r) => r.name).join(', ')}.
        </p>
      )}
    </div>
  );
}

// Where carts go, and what happens when that app does not have something.
// Two decisions a household makes once, kept beside the apps they are about.
function CartSettings({
  vendor,
  vendors,
  onVendor,
  fallback,
  onFallback,
}: {
  vendor: string | null;
  vendors: CartVendorInfo[];
  onVendor?: (id: string) => void;
  fallback: boolean;
  onFallback?: (on: boolean) => void;
}) {
  const other = vendors.find((v) => v.id !== vendor);
  return (
    <section className="card p-4 mb-4">
      <h2 className="text-sm font-semibold text-ink-700">Carts</h2>
      <p className="text-sm text-ink-700 mt-3">Send carts to</p>
      <div className="flex gap-1.5 flex-wrap mt-1.5">
        {vendors.map((v) => (
            <button
              key={v.id}
              onClick={() => onVendor?.(v.id)}
              disabled={!onVendor}
              aria-pressed={v.id === vendor}
              className={`text-xs font-medium py-1.5 px-3 rounded-full border transition-colors ${
                v.id === vendor ? 'bg-ink-800 text-sand-50 border-ink-800' : 'bg-surface text-ink-700 border-sand-200 hover:border-sand-300'
              }`}
            >
              {v.name}
            </button>
          ))}
      </div>
      <p className="text-2xs text-ink-400 mt-1">
        {vendor ? `The list sends to ${vendors.find((v) => v.id === vendor)?.name ?? vendor}.` : 'Not chosen yet: the list offers every connected app.'}
      </p>
      {vendors.length > 1 && (
        <>
          <div className="flex items-center justify-between gap-3 mt-4">
            <p className="text-sm text-ink-700">
              If it does not have something, offer it from {other?.name ?? 'the other app'}
            </p>
            <button
              role="switch"
              aria-checked={fallback}
              onClick={() => onFallback?.(!fallback)}
              disabled={!onFallback}
              aria-label="Offer from the other app"
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${fallback ? 'bg-sage-500' : 'bg-sand-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-soft transition-transform ${fallback ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <p className="text-2xs text-ink-400 mt-1">From your own orders: only things you have bought there before.</p>
        </>
      )}
    </section>
  );
}

function AppCard({
  row,
  onSync,
  onConnect,
  onChooseAddress,
}: {
  row: VendorRow;
  onSync: (id: SourceId) => Promise<void>;
  onConnect: (id: SourceId) => void;
  onChooseAddress?: AppsViewProps['onChooseAddress'];
}) {
  const [starting, setStarting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const chip = CHIP[row.state];
  const canSync = row.accounts.some((a) => a.state === 'connected' || a.state === 'stopped');
  const hasActions = canSync || row.canConnect;

  const sync = async () => {
    setStarting(true);
    try {
      await onSync(row.id);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0" style={{ backgroundColor: `${row.color}15` }}>
          {row.icon}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-ink-800">{row.name}</span>
          <span className={`chip ${chip.className}`}>{chip.label}</span>
        </div>
      </div>

      {/* The one thing a stranger trips on here: an app that is read from
          and cannot be filled. They found out by looking for an Add button. */}
      {row.id !== CART_VENDOR && row.accounts.length > 0 && (
        <p className="text-xs text-ink-500 mt-3 pl-14">Orders are read from here. Carts cannot be filled on {row.name}.</p>
      )}

      {row.accounts.map((a) => (
        <Account key={a.connectionId} account={a} fillsCart={row.id === CART_VENDOR} onReconnect={() => onConnect(row.id)} onChooseAddress={onChooseAddress} />
      ))}

      {/* Once per card, covering every account on it. It was once per
          account, so a card with two people on it said it twice. */}
      {row.accounts.some((a) => a.history.length > 0) && (
        <div className="mt-2 pl-14">
          <button
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="flex items-center gap-1 text-xs font-medium text-ink-400 hover:text-ink-600"
          >
            Sync history
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <ul className="mt-1.5 space-y-1">
              {row.accounts.flatMap((a) =>
                a.history.map((h, i) => (
                  <li key={`${a.connectionId}-${i}`} className="text-xs text-ink-500">
                    {row.accounts.length > 1 && a.who ? `${a.who}: ` : ''}
                    {h}
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}

      {hasActions && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-sand-100">
          {canSync && (
            <button onClick={sync} disabled={starting} className="btn-ghost text-xs">
              <RefreshCw className={`w-3.5 h-3.5 ${starting ? 'animate-spin-slow' : ''}`} />
              Sync now
            </button>
          )}
          {row.canConnect && (
            <button onClick={() => onConnect(row.id)} className="btn-secondary text-xs py-2 px-3">
              {row.accounts.length ? 'Connect yours' : 'Connect'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Account({
  account: a,
  fillsCart,
  onReconnect,
  onChooseAddress,
}: {
  account: AccountRow;
  // Whether a cart can be filled on this app today. The address matters
  // either way - it is where the order is delivered - but only one of those
  // two sentences is true on an app we cannot write a cart to.
  fillsCart: boolean;
  onReconnect: () => void;
  onChooseAddress?: AppsViewProps['onChooseAddress'];
}) {
  return (
    <div className="mt-3 pl-14">
      {a.who && <p className="text-xs font-semibold text-ink-600">{a.who}</p>}
      {[a.phone, a.data, a.lastSync].map((line) => (
        <p key={line} className="text-xs text-ink-500 mt-0.5">
          {line}
        </p>
      ))}
      {a.note && <p className="text-xs text-clay-600 mt-1">{a.note}</p>}

      {a.addresses.length > 0 && onChooseAddress && <CartAddress account={a} fillsCart={fillsCart} onChoose={onChooseAddress} />}

      {a.progress && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-sand-200 overflow-hidden">
            {a.progress.percent === null ? (
              <div className="h-full w-full bg-gradient-to-r from-sand-200 via-sage-400 to-sand-200 bg-[length:200%_100%] animate-shimmer" />
            ) : (
              <div className="h-full bg-sage-500 transition-all duration-700" style={{ width: `${a.progress.percent}%` }} />
            )}
          </div>
          <p className="text-xs text-ink-500 mt-1.5">{a.progress.text}</p>
        </div>
      )}

      {/* Reconnecting is offered on a working app too, not only a broken one.
          A session can be alive enough to read orders and still be missing
          something the vendor's own checkout wants, which is exactly what
          happened on Blinkit: everything imported, and paying was refused,
          and there was no way to do anything about it from here. */}
      {a.mine && (
        <button
          onClick={onReconnect}
          className={`${a.state === 'needs_reconnect' || a.cannotPay ? 'btn-secondary' : 'btn-ghost'} text-xs py-1.5 px-3 mt-2`}
        >
          {a.state === 'needs_reconnect' ? 'Reconnect' : a.cannotPay ? 'Connect again to pay' : 'Reconnect this app'}
        </button>
      )}
    </div>
  );
}

// Where this app's cart is filled. The app keeps a cart per store and the
// store follows from the delivery address, so the household picks one of the
// addresses already saved in the app (design §19 stage 1). Until it picks,
// the app says so: a cart filled at the wrong store is one nobody sees.
function CartAddress({ account: a, fillsCart, onChoose }: { account: AccountRow; fillsCart: boolean; onChoose: NonNullable<AppsViewProps['onChooseAddress']> }) {
  const [open, setOpen] = useState(false);
  const choose = async (addressId: string) => {
    await onChoose(a.connectionId, addressId);
    setOpen(false);
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-1.5 flex items-baseline gap-1.5 text-xs text-left">
        {/* On an app whose cart we can fill, the address decides which cart:
            a vendor keeps one per store and the store follows the address, so
            filling the wrong one means the household sees nothing. On an app
            we cannot write to, the same address is simply where a delivery
            goes - and saying "cart" there contradicted the line above it. */}
        <span className={a.cartAddress?.chosenByHousehold ? 'text-ink-500' : 'text-clay-600'}>
          {!a.cartAddress
            ? fillsCart
              ? 'Pick where your cart is filled'
              : 'Pick where deliveries go'
            : a.cartAddress.chosenByHousehold
              ? `${fillsCart ? 'Cart goes' : 'Deliveries go'} to ${a.cartAddress.label}`
              : `${fillsCart ? 'Cart goes' : 'Deliveries go'} to ${a.cartAddress.label}, where your orders go. Is that right?`}
        </span>
        <span className="font-medium text-sage-700">{a.cartAddress ? 'Change' : 'Choose'}</span>
      </button>
    );
  }
  return (
    <div className="mt-2">
      <AddressPicker
        addresses={a.addresses}
        chosenId={a.cartAddress?.id ?? null}
        onChoose={choose}
        onCancel={() => setOpen(false)}
        note={fillsCart ? 'Your addresses in the app. Items are added to the cart for this one.' : 'Your addresses in the app. Orders are delivered to this one.'}
      />
    </div>
  );
}
