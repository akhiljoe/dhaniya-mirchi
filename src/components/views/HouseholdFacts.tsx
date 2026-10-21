import { useState } from 'react';
import { CalendarDays, ChevronDown, Home, Loader2, Plus, Repeat, Users, X } from 'lucide-react';

import type { Toast } from '../../types';
import { Stepper } from '@/components/HouseholdQuick';
import { ApiError } from '@/lib/api';
import { FACT_ALWAYS_DAYS_BACK } from '@/lib/constants';
import { addFact, localDay, whoLivesHere, withdrawFact, type Fact, type NewFact } from '@/lib/facts';

export interface FactItem {
  id: string; // canonical name
  name: string;
  emoji: string;
  unit: 'ml' | 'g' | 'piece';
}

interface HouseholdFactsProps {
  facts: Fact[];
  timezone: string;
  items: FactItem[]; // what the household buys, most bought first, for "used every day"
  onChanged: () => void;
  showToast: (toast: Omit<Toast, 'id'>) => void;
}

const DAY = 86_400_000;
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const span = (f: Fact) => (f.endsOn ? `${dayLabel(f.startsOn)} to ${dayLabel(f.endsOn)}` : `from ${dayLabel(f.startsOn)}`);
const UNIT_WORD: Record<FactItem['unit'], string> = { ml: 'ml', g: 'g', piece: 'pieces' };
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not save. Please try again.');

// What the household told us about itself (design §9.12): who lives here,
// guests, time away and what is used every day. Each is dated and kept with
// the person's own words; removing one keeps it on record, withdrawn.
export function HouseholdFacts({ facts, timezone, items, onChanged, showToast }: HouseholdFactsProps) {
  const today = localDay(new Date(), timezone);
  const always = localDay(new Date(Date.now() - FACT_ALWAYS_DAYS_BACK * DAY), timezone);
  const now = whoLivesHere(facts, today);
  const [open, setOpen] = useState<'who' | 'guests' | 'away' | 'regular' | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (list: NewFact[], done: string) => {
    setBusy(true);
    try {
      for (const f of list) await addFact(f);
      setOpen(null);
      showToast({ message: done, type: 'success' });
      onChanged();
    } catch (err) {
      showToast({ message: errorText(err), type: 'info' });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: Fact) => {
    setBusy(true);
    try {
      await withdrawFact(f.id);
      showToast({ message: 'Removed.', type: 'success' });
      onChanged();
    } catch (err) {
      showToast({ message: errorText(err), type: 'info' });
    } finally {
      setBusy(false);
    }
  };

  const guests = facts.filter((f) => f.kind === 'guests' && (f.endsOn ?? today) >= today);
  const away = facts.filter((f) => f.kind === 'away' && (f.endsOn === null || f.endsOn >= today));
  const regular = facts.filter((f) => f.kind === 'regular_use' && (f.endsOn === null || f.endsOn >= today));
  const shown = new Set([...guests, ...away, ...regular].map((f) => f.id));
  const past = facts.filter((f) => !shown.has(f.id)).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  const itemOf = (id?: string) => items.find((i) => i.id === id);

  const who =
    now.people === null
      ? 'Not told yet'
      : [`${now.people} ${now.people === 1 ? 'person' : 'people'}`, now.guests ? `${now.guests} staying now` : null, now.pets].filter(Boolean).join(', ');

  return (
    <>
      <Section icon={Users} title="Who lives here" action={open === 'who' ? null : <AddButton label="Change" onClick={() => setOpen('who')} />}>
        <p className="text-sm text-ink-700">{who}</p>
        <p className="text-xs text-ink-400 mt-0.5">More people use things faster. The estimates follow each change from its date.</p>
        {open === 'who' && (
          <WhoForm
            today={today}
            always={always}
            current={{ people: now.people ?? 2, ...currentPets(facts, today) }}
            peopleOn={(day) => whoLivesHere(facts, day).people}
            busy={busy}
            onCancel={() => setOpen(null)}
            onSave={(list) => save(list, 'Saved. The estimates now count everyone.')}
          />
        )}
      </Section>

      <Section icon={CalendarDays} title="Staying with you" action={open === 'guests' ? null : <AddButton label="Add guests" onClick={() => setOpen('guests')} />}>
        {guests.length === 0 && open !== 'guests' && <p className="text-xs text-ink-400">Guests for a few days? Add them and the list gets ready before they arrive.</p>}
        <FactList facts={guests} busy={busy} onRemove={remove} line={(f) => `${f.details.count} ${f.details.count === 1 ? 'guest' : 'guests'} · ${span(f)}`} />
        {open === 'guests' && <GuestsForm today={today} busy={busy} onCancel={() => setOpen(null)} onSave={(f) => save([f], 'Guests added.')} />}
      </Section>

      <Section icon={Home} title="Time away" action={open === 'away' ? null : <AddButton label="Add" onClick={() => setOpen('away')} />}>
        {away.length === 0 && open !== 'away' && <p className="text-xs text-ink-400">Away from home? Nothing is used while you're gone, so reminders wait.</p>}
        <FactList facts={away} busy={busy} onRemove={remove} line={(f) => (f.endsOn ? `Away ${span(f)}` : `Away from ${dayLabel(f.startsOn)}, until you're back`)} />
        {open === 'away' && <AwayForm today={today} busy={busy} onCancel={() => setOpen(null)} onSave={(f) => save([f], 'Saved.')} />}
      </Section>

      <Section icon={Repeat} title="Used every day" action={open === 'regular' ? null : <AddButton label="Add" onClick={() => setOpen('regular')} />}>
        {regular.length === 0 && open !== 'regular' && <p className="text-xs text-ink-400">For example: the dogs eat 2 boiled eggs a day. It stops those items running out.</p>}
        <FactList
          facts={regular}
          busy={busy}
          onRemove={remove}
          line={(f) => {
            const it = itemOf(f.details.item);
            const amount = f.details.perDay ? `${f.details.perDay} ${UNIT_WORD[(f.details.unit ?? 'piece') as FactItem['unit']]} a day` : 'every day';
            return `${it?.emoji ?? ''} ${it?.name ?? f.details.item} · for ${f.details.for} · ${amount}`.trim();
          }}
        />
        {open === 'regular' && <RegularForm today={today} always={always} items={items} busy={busy} onCancel={() => setOpen(null)} onSave={(f) => save([f], 'Saved.')} />}
      </Section>

      {past.length > 0 && (
        <section className="mb-8">
          <button onClick={() => setShowPast((v) => !v)} aria-expanded={showPast} className="flex items-center gap-1 text-xs font-medium text-ink-400 hover:text-ink-600">
            Earlier changes ({past.length})
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPast ? 'rotate-180' : ''}`} />
          </button>
          {showPast && (
            <div className="mt-2">
              <FactList
                facts={past}
                busy={busy}
                onRemove={remove}
                line={(f) =>
                  f.kind === 'people' ? `${f.details.count} people ${span(f)}`
                  : f.kind === 'pets' ? `Pets ${span(f)}: ${f.details.dogs ?? 0} dogs, ${f.details.cats ?? 0} cats`
                  : f.kind === 'guests' ? `${f.details.count} guests · ${span(f)}`
                  : f.kind === 'away' ? `Away ${span(f)}`
                  : `${itemOf(f.details.item)?.name ?? f.details.item} every day · ${span(f)}`
                }
              />
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Section({ icon: Icon, title, action, children }: { icon: typeof Users; title: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-500 uppercase tracking-wide">
          <Icon className="w-4 h-4" />
          {title}
        </h2>
        {action}
      </div>
      <div className="card p-4">{children}</div>
    </section>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="btn-ghost text-xs">
      <Plus className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function FactList({ facts, line, busy, onRemove }: { facts: Fact[]; line: (f: Fact) => string; busy: boolean; onRemove: (f: Fact) => void }) {
  if (!facts.length) return null;
  return (
    <ul className="space-y-2">
      {facts.map((f) => (
        <li key={f.id} className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-ink-700">{line(f)}</p>
            {f.said && <p className="text-xs text-ink-400 italic truncate">“{f.said}”</p>}
          </div>
          <button disabled={busy} onClick={() => onRemove(f)} aria-label="Remove" className="p-1 text-ink-300 hover:text-clay-600">
            <X className="w-4 h-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

const input = 'w-full px-3 py-2 rounded-xl border border-sand-200 bg-surface text-sm focus:outline-none focus:border-sage-400';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-ink-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function FormButtons({ busy, disabled, onCancel }: { busy: boolean; disabled?: boolean; onCancel: () => void }) {
  return (
    <div className="flex gap-2 pt-1">
      <button type="submit" disabled={busy || disabled} className="btn-primary text-sm py-2 px-4">
        {busy && <Loader2 className="w-4 h-4 animate-spin-slow" />}
        Save
      </button>
      <button type="button" onClick={onCancel} className="btn-ghost text-sm">
        Cancel
      </button>
    </div>
  );
}

// The pets on a day, as the facts say (0 when never told).
function currentPets(facts: Fact[], day: string): { dogs: number; cats: number } {
  const p = facts
    .filter((f) => f.kind === 'pets' && f.startsOn <= day)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.createdAt.localeCompare(b.createdAt))
    .pop();
  return { dogs: p?.details.dogs ?? 0, cats: p?.details.cats ?? 0 };
}

function WhoForm(props: {
  today: string;
  always: string;
  current: { people: number; dogs: number; cats: number };
  peopleOn: (day: string) => number | null; // who lived here then, as told so far
  busy: boolean;
  onCancel: () => void;
  onSave: (list: NewFact[]) => void;
}) {
  const [people, setPeople] = useState(props.current.people);
  const [dogs, setDogs] = useState(props.current.dogs);
  const [cats, setCats] = useState(props.current.cats);
  const [since, setSince] = useState(props.today);
  const [said, setSaid] = useState('');
  // A change from a date: who lived here before it. Prefilled from what was
  // told; when it differs (e.g. "4" was entered with no date), it corrects
  // the earlier count too.
  const dated = since > props.always;
  const knownBefore = dated ? props.peopleOn(new Date(Date.parse(`${since}T00:00:00Z`) - DAY).toISOString().slice(0, 10)) : null;
  const [before, setBefore] = useState<number | null>(null);
  const beforeValue = before ?? knownBefore ?? props.current.people;
  return (
    <form
      className="mt-4 pt-4 border-t border-sand-100 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const list: NewFact[] = [];
        if (dated && beforeValue !== knownBefore) list.push({ kind: 'people', startsOn: props.always, endsOn: null, details: { count: beforeValue }, said: null });
        list.push({ kind: 'people', startsOn: since, endsOn: null, details: { count: people }, said: said.trim() || null });
        // Pets only when they changed: a head count isn't a new pets fact.
        if (dogs !== props.current.dogs || cats !== props.current.cats) {
          list.push({ kind: 'pets', startsOn: since, endsOn: null, details: { dogs, cats, other: 0 }, said: null });
        }
        props.onSave(list);
      }}
    >
      <Stepper label="People living here" value={people} onChange={setPeople} min={1} max={30} />
      <Stepper label="Dogs" value={dogs} onChange={setDogs} max={20} />
      <Stepper label="Cats" value={cats} onChange={setCats} max={20} />
      <Field label="Since">
        <input type="date" value={since} max={props.today} min={props.always} onChange={(e) => setSince(e.target.value || props.today)} className={input} />
      </Field>
      {dated && <Stepper label="People before that" value={beforeValue} onChange={setBefore} min={1} max={30} />}
      <Field label="In your words (optional)">
        <input value={said} onChange={(e) => setSaid(e.target.value)} placeholder="My mother-in-law and brother-in-law moved in" className={input} maxLength={1000} />
      </Field>
      <FormButtons busy={props.busy} onCancel={props.onCancel} />
    </form>
  );
}

function GuestsForm({ today, busy, onCancel, onSave }: { today: string; busy: boolean; onCancel: () => void; onSave: (f: NewFact) => void }) {
  const [count, setCount] = useState(2);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [said, setSaid] = useState('');
  return (
    <form
      className="mt-3 pt-3 border-t border-sand-100 first:mt-0 first:pt-0 first:border-t-0 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ kind: 'guests', startsOn: from, endsOn: to, details: { count }, said: said.trim() || null });
      }}
    >
      <Stepper label="How many guests" value={count} onChange={setCount} min={1} max={30} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Arriving">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} required />
        </Field>
        <Field label="Last day">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={input} required />
        </Field>
      </div>
      <Field label="In your words (optional)">
        <input value={said} onChange={(e) => setSaid(e.target.value)} placeholder="Friends from Pune for Diwali" className={input} maxLength={1000} />
      </Field>
      <FormButtons busy={busy} disabled={!to} onCancel={onCancel} />
    </form>
  );
}

function AwayForm({ today, busy, onCancel, onSave }: { today: string; busy: boolean; onCancel: () => void; onSave: (f: NewFact) => void }) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [said, setSaid] = useState('');
  return (
    <form
      className="mt-3 pt-3 border-t border-sand-100 first:mt-0 first:pt-0 first:border-t-0 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ kind: 'away', startsOn: from, endsOn: to || null, details: {}, said: said.trim() || null });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Leaving">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} required />
        </Field>
        <Field label="Back (leave empty if not sure)">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={input} />
        </Field>
      </div>
      <Field label="In your words (optional)">
        <input value={said} onChange={(e) => setSaid(e.target.value)} placeholder="Goa trip" className={input} maxLength={1000} />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} />
    </form>
  );
}

function RegularForm(props: { today: string; always: string; items: FactItem[]; busy: boolean; onCancel: () => void; onSave: (f: NewFact) => void }) {
  // Most bought first (the caller's order): what is used daily is near the top.
  const sorted = props.items;
  const [itemId, setItemId] = useState(sorted[0]?.id ?? '');
  const [who, setWho] = useState<'people' | 'pets'>('people');
  const [amount, setAmount] = useState('');
  const [said, setSaid] = useState('');
  const item = sorted.find((i) => i.id === itemId);
  const perDay = amount.trim() === '' ? null : Number(amount);
  const badAmount = perDay !== null && !(perDay > 0);
  return (
    <form
      className="mt-3 pt-3 border-t border-sand-100 first:mt-0 first:pt-0 first:border-t-0 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!item) return;
        props.onSave({
          kind: 'regular_use',
          startsOn: props.always,
          endsOn: null,
          details: { item: item.id, for: who, perDay, unit: perDay === null ? null : item.unit },
          said: said.trim() || null,
        });
      }}
    >
      <Field label="Item">
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={input}>
          {sorted.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <span className="text-xs text-ink-500">For</span>
        <div className="flex gap-2 mt-1">
          {(['people', 'pets'] as const).map((w) => (
            <button key={w} type="button" onClick={() => setWho(w)} aria-pressed={who === w} className={`chip px-3 py-1.5 ${who === w ? 'bg-sage-100 text-sage-700' : 'bg-sand-100 text-ink-500'}`}>
              {w === 'people' ? 'People' : 'Pets'}
            </button>
          ))}
        </div>
      </div>
      <Field label={`How much a day, in ${item ? UNIT_WORD[item.unit] : 'units'} (optional)`}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={item?.unit === 'piece' ? '2' : '500'} className={input} />
      </Field>
      {badAmount && <p className="text-xs text-clay-600">Enter a number above 0, or leave it empty.</p>}
      <Field label="In your words (optional)">
        <input value={said} onChange={(e) => setSaid(e.target.value)} placeholder="The dogs eat 2 boiled eggs a day" className={input} maxLength={1000} />
      </Field>
      <FormButtons busy={props.busy} disabled={!item || badAmount} onCancel={props.onCancel} />
    </form>
  );
}
