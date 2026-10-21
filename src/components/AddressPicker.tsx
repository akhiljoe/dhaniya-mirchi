import { useState } from 'react';

import { ADDRESSES_SHOWN } from '@/lib/constants';
import { accountHolderName, addressNote, matchAddresses, rankAddresses, type PickableAddress } from '@/lib/connect';

interface AddressPickerProps {
  addresses: PickableAddress[];
  chosenId?: string | null;
  onChoose: (addressId: string) => Promise<void> | void;
  onCancel?: () => void;
  note?: string;
}

// Which of the app's own saved addresses a household's cart is filled for.
// The app keeps a cart per store and the store follows from the address, so
// filling the wrong one leaves the items somewhere the household never looks
// (design §19 stage 1). Used when connecting the app and again on the Grocery
// apps page, so both ask the same question the same way.
export function AddressPicker({ addresses, chosenId, onChoose, onCancel, note }: AddressPickerProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const choose = async (addressId: string) => {
    setSaving(addressId);
    try {
      await onChoose(addressId);
    } finally {
      setSaving(null);
    }
  };

  const ranked = rankAddresses(addresses, chosenId);
  const shown = search.trim() ? matchAddresses(ranked, search) : ranked.slice(0, ADDRESSES_SHOWN);
  // Worked out once over the whole list, not per row: it is the name on most
  // of them, so a row can only be called somebody else's by comparison.
  const holder = accountHolderName(addresses);

  return (
    <div className="space-y-1.5">
      {note && <p className="text-2xs text-ink-400">{note}</p>}
      {addresses.length > ADDRESSES_SHOWN && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${addresses.length} addresses`}
          className="w-full px-3 py-2 rounded-xl border border-sand-200 bg-surface text-xs focus:outline-none focus:border-sage-400"
        />
      )}
      {shown.map((addr) => (
        <button
          key={addr.id}
          onClick={() => choose(addr.id)}
          disabled={!!saving}
          className={`w-full text-left px-3 py-2 rounded-xl border text-xs disabled:opacity-60 ${
            chosenId === addr.id ? 'border-sage-400 bg-sage-50' : 'border-sand-200 bg-surface hover:border-sage-300'
          }`}
        >
          <span className="font-medium text-ink-700">{addr.label || 'No label'}</span>
          <span className="block text-2xs text-ink-400 truncate">{addr.display}</span>
          {/* Only when there is something to say. Rows the household saved
              themselves get no line, so the ones that do stand out. */}
          {addressNote(addr, holder) && <span className="block text-2xs text-clay-600">{addressNote(addr, holder)}</span>}
        </button>
      ))}
      {search.trim() && shown.length === 0 && <p className="text-2xs text-ink-400">No address matches that.</p>}
      {onCancel && (
        <button onClick={onCancel} className="text-2xs text-ink-400 hover:text-ink-600">
          Cancel
        </button>
      )}
    </div>
  );
}
