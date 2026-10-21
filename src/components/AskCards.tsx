import { useState } from 'react';
import { HelpCircle, Loader2, X } from 'lucide-react';

import type { Toast } from '../types';
import { Stepper } from '@/components/HouseholdQuick';
import { ApiError } from '@/lib/api';
import { FACT_ALWAYS_DAYS_BACK } from '@/lib/constants';
import { dismiss, isDismissed } from '@/lib/dismissed';
import { addFact, localDay, whoLivesHere, type Fact } from '@/lib/facts';
import type { Suggestion } from '@/lib/suggestions';

interface AskCardsProps {
  suggestions: Suggestion[];
  facts: Fact[];
  timezone: string;
  onChanged: () => void; // a fact was added
  onOpenHousehold: () => void;
  showToast: (toast: Omit<Toast, 'id'>) => void;
}

const DAY = 86_400_000;
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not save. Please try again.');

// "About twice as much", "about 1.6 times as much", "about half", "about 40%".
function howMuch(ratio: number): string {
  if (ratio >= 1.8 && ratio <= 2.2) return 'about twice as much';
  if (ratio > 1) return `about ${ratio} times as much`;
  if (ratio >= 0.4 && ratio <= 0.6) return 'about half as much';
  return `about ${Math.round(ratio * 100)}% of what it did`;
}

// The app's questions (design §9.12 Phase 4, §9.11), on Home. Nothing changes
// until the person answers; "No" just stops asking.
export function AskCards({ suggestions, facts, timezone, onChanged, onOpenHousehold, showToast }: AskCardsProps) {
  const [, rerender] = useState(0);
  const now = new Date();
  const shown = suggestions.filter((s) => !isDismissed(s, now));
  if (!shown.length) return null;
  const close = (s: Suggestion) => {
    dismiss(s, new Date());
    rerender((n) => n + 1);
  };
  return (
    <div className="space-y-3">
      {shown.map((s) => (
        <Card key={s.id} s={s} facts={facts} timezone={timezone} onDone={() => close(s)} onChanged={onChanged} onOpenHousehold={onOpenHousehold} showToast={showToast} />
      ))}
    </div>
  );
}

function Card({ s, facts, timezone, onDone, onChanged, onOpenHousehold, showToast }: { s: Suggestion; onDone: () => void } & Omit<AskCardsProps, 'suggestions'>) {
  const today = localDay(new Date(), timezone);
  const always = localDay(new Date(Date.now() - FACT_ALWAYS_DAYS_BACK * DAY), timezone);
  const [form, setForm] = useState(false);
  // The answers are behind the line until somebody wants to give one.
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const known = whoLivesHere(facts, today).people;
  // Who lived here the day before the change, as the facts say so far.
  const knownBefore = s.kind === 'buying_changed' ? whoLivesHere(facts, addDays(s.since, -1)).people : null;
  const [people, setPeople] = useState(known ?? 2);
  const [before, setBefore] = useState(knownBefore ?? known ?? 2);
  const [date, setDate] = useState(s.kind === 'guests_leaving' ? addDays(s.fact.endsOn!, 3) : today);

  const save = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      showToast({ message: done, type: 'success' });
      onChanged();
      onDone();
    } catch (err) {
      showToast({ message: errorText(err), type: 'info' });
      setBusy(false);
    }
  };

  const input = 'w-full px-3 py-2 rounded-xl border border-sand-200 bg-surface text-sm focus:outline-none focus:border-sage-400';
  // Chips rather than a stack of full-width buttons. Four of those took a
  // third of the landing screen for one question, and the question is worth
  // asking but not worth that.
  const choice = 'px-3 py-1.5 rounded-full border border-sand-200 bg-surface text-xs text-ink-700 hover:border-sage-300';

  let title = '';
  let body = '';
  let choices: React.ReactNode = null;
  let formBody: React.ReactNode = null;

  if (s.kind === 'buying_changed') {
    const up = s.direction === 'up';
    title = `Your household is buying ${howMuch(s.ratio)} since the week of ${dayLabel(s.since)}.`;
    body = up ? 'Did someone move in or come to stay? The estimates follow who lives here.' : 'Did someone move out, or are you away? The estimates follow who lives here.';
    choices = (
      <>
        <button className={choice} onClick={() => setForm(true)}>
          {up ? 'Someone moved in' : 'Someone moved out'}
        </button>
        <button className={choice} onClick={onOpenHousehold}>
          {up ? 'Guests stayed with us' : 'We were away'}
        </button>
        <button className={choice} onClick={onDone}>
          {up ? 'We buy more here instead of another app or shop' : 'We buy more elsewhere now'}
        </button>
        <button className={choice} onClick={onDone}>
          No, nothing changed
        </button>
      </>
    );
    formBody = (
      <>
        <Stepper label="People living here now" value={people} onChange={setPeople} min={1} max={30} />
        <Stepper label="People before that" value={before} onChange={setBefore} min={1} max={30} />
        <label className="block text-2xs text-ink-500">
          Since
          <input type="date" value={date === today ? s.since : date} max={today} onChange={(e) => setDate(e.target.value)} className={`${input} mt-1`} />
        </label>
        <button
          disabled={busy}
          className="btn-primary text-sm py-2 px-4"
          onClick={() =>
            save(async () => {
              const since = date === today ? s.since : date;
              // The count before the change, when it differs from what the
              // facts say (e.g. "4 people" entered with no date): a newer fact
              // from as far back as we go supersedes it.
              if (before !== knownBefore) await addFact({ kind: 'people', startsOn: always, endsOn: null, details: { count: before }, said: null });
              await addFact({ kind: 'people', startsOn: since, endsOn: null, details: { count: people }, said: null });
            }, 'Saved. The estimates now count everyone.')
          }
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin-slow" />}
          Save
        </button>
      </>
    );
  } else if (s.kind === 'guests_leaving') {
    const n = s.fact.details.count ?? 0;
    title = `Your ${n} ${n === 1 ? "guest's" : "guests'"} last day is today.`;
    body = 'Still staying?';
    choices = (
      <>
        <button className={choice} onClick={onDone}>
          They leave today
        </button>
        <button className={choice} onClick={() => setForm(true)}>
          They're staying longer
        </button>
      </>
    );
    formBody = (
      <>
        <label className="block text-2xs text-ink-500">
          Their new last day
          <input type="date" value={date} min={addDays(today, 1)} onChange={(e) => setDate(e.target.value)} className={`${input} mt-1`} />
        </label>
        <button
          disabled={busy}
          className="btn-primary text-sm py-2 px-4"
          onClick={() =>
            save(() => addFact({ kind: 'guests', startsOn: addDays(s.fact.endsOn!, 1), endsOn: date, details: { count: n }, said: s.fact.said }), 'Stay extended.')
          }
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin-slow" />}
          Save
        </button>
      </>
    );
  } else {
    title = `No orders since ${dayLabel(s.lastOrder)}, longer than usual.`;
    body = 'Were you away? Nothing is used while you are, so reminders wait.';
    choices = (
      <>
        <button className={choice} onClick={() => setForm(true)}>
          Yes, we were away
        </button>
        <button className={choice} onClick={onDone}>
          No, we bought elsewhere
        </button>
      </>
    );
    formBody = (
      <>
        <label className="block text-2xs text-ink-500">
          Back on (empty if still away)
          <input type="date" value={date === today ? '' : date} min={addDays(s.lastOrder, 1)} max={today} onChange={(e) => setDate(e.target.value || today)} className={`${input} mt-1`} />
        </label>
        <button
          disabled={busy}
          className="btn-primary text-sm py-2 px-4"
          onClick={() =>
            save(
              () => addFact({ kind: 'away', startsOn: addDays(s.lastOrder, 1), endsOn: date === today ? null : date, details: {}, said: null }),
              'Saved. Reminders wait while you are away.',
            )
          }
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin-slow" />}
          Save
        </button>
      </>
    );
  }

  // Shut until asked. The finding is worth reading on the landing page -
  // the household's buying changed and the app noticed - but the four
  // answers under it made it a form, and a form sitting permanently on the
  // main screen reads as onboarding that never ended. The line stays, the
  // form waits behind it.
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full card p-3 border-sage-200 text-left flex items-start gap-2.5 hover:border-sage-300">
        <HelpCircle className="w-4 h-4 text-sage-600 shrink-0 mt-0.5" />
        <span className="flex-1 min-w-0 text-sm text-ink-700">{title}</span>
        <span className="text-xs font-medium text-sage-700 shrink-0 mt-0.5">Tell us why</span>
      </button>
    );
  }

  return (
    <div className="card p-4 border-sage-200">
      <div className="flex items-start gap-3">
        <HelpCircle className="w-5 h-5 text-sage-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-800">{title}</p>
          <p className="text-xs text-ink-500 mt-0.5">{body}</p>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Not now" className="p-1 -mr-1 text-ink-300 hover:text-ink-600 shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className={`mt-3 ${form ? 'space-y-2' : 'flex flex-wrap gap-1.5'}`}>{form ? formBody : choices}</div>
      {form && (
        <button onClick={() => setForm(false)} className="mt-2 text-xs text-ink-400 hover:text-ink-600">
          Back
        </button>
      )}
    </div>
  );
}
