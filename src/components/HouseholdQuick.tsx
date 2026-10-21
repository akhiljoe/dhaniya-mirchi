import { useState } from 'react';
import { Loader2, Minus, Plus, Users } from 'lucide-react';

import { ApiError } from '@/lib/api';
import { FACT_ALWAYS_DAYS_BACK } from '@/lib/constants';
import { addFact, localDay } from '@/lib/facts';

interface HouseholdQuickProps {
  timezone: string;
  onSaved: () => void;
}

const DAY = 86_400_000;

// A number with − and + buttons, for small counts.
export function Stepper({ label, value, onChange, min = 0, max }: { label: string; value: number; onChange: (n: number) => void; min?: number; max: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-ink-700">{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`} className="w-8 h-8 rounded-full border border-sand-200 flex items-center justify-center text-ink-500 disabled:opacity-40">
          <Minus className="w-4 h-4" />
        </button>
        <span className="w-6 text-center text-sm font-semibold text-ink-800" aria-live="polite">
          {value}
        </span>
        <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`} className="w-8 h-8 rounded-full border border-sand-200 flex items-center justify-center text-ink-500 disabled:opacity-40">
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// "How many people live here?" (design §9.12), asked while the first import
// runs and on Home until answered. Saved as holding for as long as we know;
// a change later ("4 people since June") is added on the Household page.
export function HouseholdQuick({ timezone, onSaved }: HouseholdQuickProps) {
  const [people, setPeople] = useState(2);
  const [dogs, setDogs] = useState(0);
  const [cats, setCats] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const since = localDay(new Date(Date.now() - FACT_ALWAYS_DAYS_BACK * DAY), timezone);
    try {
      await addFact({ kind: 'people', startsOn: since, endsOn: null, details: { count: people }, said: null });
      if (dogs || cats) await addFact({ kind: 'pets', startsOn: since, endsOn: null, details: { dogs, cats, other: 0 }, said: null });
      onSaved();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not save. Please try again.');
      setSaving(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center shrink-0">
          <Users className="w-5 h-5 text-sage-700" />
        </div>
        <div>
          <p className="text-sm font-semibold text-ink-800">How many live here?</p>
          <p className="text-xs text-ink-500 mt-0.5">More people use things faster. Change it any time on the Household page.</p>
        </div>
      </div>
      <div className="space-y-2.5">
        <Stepper label="People" value={people} onChange={setPeople} min={1} max={30} />
        <Stepper label="Dogs" value={dogs} onChange={setDogs} max={20} />
        <Stepper label="Cats" value={cats} onChange={setCats} max={20} />
      </div>
      {message && <p className="text-xs text-clay-600 mt-2">{message}</p>}
      <button onClick={save} disabled={saving} className="btn-primary w-full text-sm mt-4">
        {saving && <Loader2 className="w-4 h-4 animate-spin-slow" />}
        Save
      </button>
    </div>
  );
}
