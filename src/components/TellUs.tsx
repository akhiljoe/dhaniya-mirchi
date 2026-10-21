import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, MessageSquareText, Send, X } from 'lucide-react';

import type { Toast } from '../types';
import { Stepper } from '@/components/HouseholdQuick';
import { ApiError } from '@/lib/api';
import { AI_POLL_MS, AI_WAIT_MS } from '@/lib/constants';
import {
  AI_ERROR_FALLBACK,
  AI_ERROR_TEXT,
  getRequest,
  perDayFrom,
  saveMeasure,
  saveOutcome,
  sendNote,
  type Missing,
  type ParseResult,
  type Proposal,
  type Unit,
} from '@/lib/ai';
import { addFact, type NewFact } from '@/lib/facts';

export interface TellUsItem {
  id: string;
  name: string;
  unit: Unit;
}

interface TellUsProps {
  items: TellUsItem[]; // the household's items, most bought first
  onChanged: () => void; // a fact was added
  onOpenSettings: () => void;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  // One tap-to-open line (Home, where the running-low list matters most).
  compact?: boolean;
}

const dayLabel = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const UNIT_WORD: Record<Unit, string> = { ml: 'ml', g: 'g', piece: 'pieces' };
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : AI_ERROR_FALLBACK);
// "a phone number and an email"
const withArticle = (w: string) => (/^[aeiouAEIOU]/.test(w) && !w.startsWith('UPI') ? `an ${w}` : `a ${w}`);
const listText = (ws: string[]) => {
  const x = ws.map(withArticle);
  return x.length > 1 ? `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}` : x[0];
};

// "Tell us what's changing at home" (design §7.8, §9.12, Phase 3): a note in
// the household's own words becomes proposed facts. Nothing counts until the
// person confirms a card; anything the note didn't say is asked on the card.
export function TellUs({ items, onChanged, onOpenSettings, showToast, compact = false }: TellUsProps) {
  const [open, setOpen] = useState(!compact);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'reading' | 'result'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ id: string; result: ParseResult } | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [done, setDone] = useState<Record<number, 'confirmed' | 'discarded'>>({});
  const stopped = useRef(false);
  useEffect(() => () => void (stopped.current = true), []);

  const send = async () => {
    setError(null);
    setPhase('reading');
    setDone({});
    try {
      const { id, removed: cut } = await sendNote(text, items.map((i) => ({ id: i.id, unit: i.unit })));
      setRemoved(cut);
      const started = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, AI_POLL_MS));
        if (stopped.current) return;
        const r = await getRequest(id);
        if (r.status === 'done' && r.result && 'proposals' in r.result) {
          setRequest({ id, result: r.result });
          setPhase('result');
          return;
        }
        if (r.status === 'failed') throw new Error(AI_ERROR_TEXT[r.errorCode ?? ''] ?? AI_ERROR_FALLBACK);
        if (Date.now() - started > AI_WAIT_MS) throw new Error(AI_ERROR_TEXT.provider_down);
      }
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : AI_ERROR_FALLBACK);
      setPhase('idle');
    }
  };

  // Every card answered: record what was kept, then clear the box.
  const settle = (index: number, outcome: 'confirmed' | 'discarded') => {
    const next = { ...done, [index]: outcome };
    setDone(next);
    if (request && Object.keys(next).length === request.result.proposals.length) {
      const confirmed = Object.values(next).filter((v) => v === 'confirmed').length;
      saveOutcome(request.id, confirmed, request.result.proposals.length - confirmed).catch(() => {});
      if (confirmed) onChanged();
      setText('');
      setRequest(null);
      setPhase('idle');
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="card w-full p-4 flex items-center gap-2 text-left hover:shadow-soft transition-shadow">
        <MessageSquareText className="w-4 h-4 text-sage-600 shrink-0" />
        <span className="flex-1 text-sm font-semibold text-ink-800">Tell us what's changing at home</span>
        <span className="text-xs text-ink-400">Guests, trips, daily use</span>
      </button>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <MessageSquareText className="w-4 h-4 text-sage-600" />
        <p className="text-sm font-semibold text-ink-800">Tell us what's changing at home</p>
      </div>
      {phase !== 'result' && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            rows={2}
            disabled={phase === 'reading'}
            placeholder="Friends are staying with us from Tuesday for a week."
            className="w-full px-3 py-2.5 rounded-xl border border-sand-200 text-sm focus:outline-none focus:border-sage-400 resize-none"
          />
          {error && <p className="text-xs text-clay-600 mt-1">{error}</p>}
          <div className="flex items-center justify-between gap-3 mt-2">
            <button onClick={onOpenSettings} className="text-2xs text-ink-400 hover:text-ink-600 text-left">
              Read by an AI service. Nothing counts until you confirm it.
            </button>
            <button onClick={send} disabled={phase === 'reading' || !text.trim()} className="btn-primary text-sm py-2 px-4 shrink-0">
              {phase === 'reading' ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <Send className="w-4 h-4" />}
              {phase === 'reading' ? 'Reading' : 'Send'}
            </button>
          </div>
        </>
      )}

      {phase === 'result' && request && (
        <div className="space-y-3">
          <p className="text-xs text-ink-500 italic">“{text.trim()}”</p>
          {removed.length > 0 && <p className="text-2xs text-ink-400">Not sent to the AI: {listText(removed)}.</p>}
          {request.result.questions.map((q) => (
            <p key={q} className="text-sm text-ink-600">
              {q}
            </p>
          ))}
          {request.result.proposals.length === 0 && (
            <button onClick={() => setPhase('idle')} className="btn-secondary text-sm py-2 px-3">
              Write it another way
            </button>
          )}
          {request.result.proposals.map((p, i) =>
            done[i] ? null : (
              <ProposalCard key={i} proposal={p} items={items} onDone={(o) => settle(i, o)} showToast={showToast} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// One proposed fact: what it will say, the questions the note left open, and
// Confirm / Discard.
function ProposalCard({ proposal, items, onDone, showToast }: { proposal: Proposal; items: TellUsItem[]; onDone: (o: 'confirmed' | 'discarded') => void; showToast: TellUsProps['showToast'] }) {
  const base = proposal.fact ?? proposal.draft;
  const ask = (field: Missing['field']) => proposal.missing.find((m) => m.field === field);
  const measure = ask('measure') as Extract<Missing, { field: 'measure' }> | undefined;
  const [startsOn, setStartsOn] = useState(base.startsOn);
  const [endsOn, setEndsOn] = useState<string | null>(base.endsOn ?? (ask('endsOn') as { suggested: string } | undefined)?.suggested ?? null);
  const [count, setCount] = useState<number>((base.details.count as number | null) ?? 2);
  const [item, setItem] = useState<string>((base.details.item as string | null) && items.some((i) => i.id === base.details.item) ? (base.details.item as string) : items[0]?.id ?? '');
  const [size, setSize] = useState('');
  const [saving, setSaving] = useState(false);

  const kind = base.kind;
  const sizeNumber = Number(size);
  const needsSize = !!measure && !(sizeNumber > 0);
  const chosen = items.find((i) => i.id === item);

  const build = (): NewFact => {
    const details = { ...base.details };
    if (kind === 'people' || kind === 'guests') details.count = count;
    if (kind === 'regular_use') {
      details.item = item;
      if (measure) {
        details.perDay = perDayFrom(measure, sizeNumber);
        details.unit = measure.unit;
      }
    }
    return { kind, startsOn, endsOn: kind === 'people' || kind === 'pets' || kind === 'regular_use' ? null : endsOn, details, said: base.said };
  };

  const confirm = async () => {
    setSaving(true);
    try {
      if (measure) await saveMeasure(measure.measure, measure.unit, sizeNumber);
      await addFact(build(), 'ai');
      onDone('confirmed');
    } catch (err) {
      showToast({ message: errorText(err), type: 'info' });
      setSaving(false);
    }
  };

  const summary = (() => {
    const f = build();
    switch (f.kind) {
      case 'people':
        return `${f.details.count} people live here, from ${dayLabel(f.startsOn)}`;
      case 'guests':
        return `${f.details.count} ${f.details.count === 1 ? 'guest' : 'guests'}${f.endsOn ? `, ${dayLabel(f.startsOn)} to ${dayLabel(f.endsOn)}` : `, from ${dayLabel(f.startsOn)}`}`;
      case 'pets':
        return `Pets: ${f.details.dogs ?? 0} dogs, ${f.details.cats ?? 0} cats${f.details.other ? `, ${f.details.other} other` : ''}`;
      case 'away':
        return f.endsOn ? `Away ${dayLabel(f.startsOn)} to ${dayLabel(f.endsOn)}` : `Away from ${dayLabel(f.startsOn)}`;
      case 'regular_use': {
        const name = chosen?.name ?? String(f.details.item);
        const amount = f.details.perDay ? `${f.details.perDay} ${UNIT_WORD[(f.details.unit ?? 'piece') as Unit]} a day` : 'every day';
        return `${name} for ${f.details.for}: ${amount}`;
      }
    }
  })();

  const input = 'px-3 py-2 rounded-xl border border-sand-200 bg-surface text-sm focus:outline-none focus:border-sage-400';
  return (
    <div className="rounded-xl border border-sand-200 bg-sand-50 p-3">
      <p className="text-sm font-semibold text-ink-800">{summary}</p>
      {proposal.problem && <p className="text-xs text-clay-600 mt-1">{proposal.problem}</p>}

      <div className="space-y-2.5 mt-3">
        {(kind === 'guests' || kind === 'away') && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-2xs text-ink-500">
              From
              <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={`${input} w-full mt-1`} />
            </label>
            <label className="text-2xs text-ink-500">
              {kind === 'away' ? 'Back (empty if not sure)' : 'Last day'}
              <input type="date" value={endsOn ?? ''} min={startsOn} onChange={(e) => setEndsOn(e.target.value || null)} className={`${input} w-full mt-1`} />
            </label>
          </div>
        )}
        {(kind === 'guests' || kind === 'people') && <Stepper label={kind === 'guests' ? 'Guests' : 'People living here'} value={count} onChange={setCount} min={1} max={30} />}
        {kind === 'regular_use' && ask('item') && (
          <label className="block text-2xs text-ink-500">
            Which item?
            <select value={item} onChange={(e) => setItem(e.target.value)} className={`${input} w-full mt-1`}>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {measure && (
          <label className="block text-2xs text-ink-500">
            How much is one {measure.measure}, in {UNIT_WORD[measure.unit]}? Asked once.
            <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" placeholder={measure.unit === 'ml' ? '250' : '100'} className={`${input} w-full mt-1`} />
          </label>
        )}
      </div>

      <div className="flex gap-2 mt-3">
        <button
          onClick={confirm}
          disabled={saving || !!proposal.problem || needsSize || (kind === 'guests' && !endsOn) || (kind === 'regular_use' && !chosen)}
          className="btn-primary text-sm py-2 px-4"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <Check className="w-4 h-4" />}
          Confirm
        </button>
        <button onClick={() => onDone('discarded')} disabled={saving} className="btn-ghost text-sm">
          <X className="w-4 h-4" />
          Discard
        </button>
      </div>
    </div>
  );
}
