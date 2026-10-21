import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, Loader2, TrendingDown, TrendingUp, X } from 'lucide-react';

import { SOURCES } from '@/data';
import { RangePicker } from '@/components/RangePicker';
import { ADVICE_SHOWN } from '@/lib/constants';
import { unevenHistoryNote, type Insights } from '@/lib/insights';

interface InsightsViewProps {
  // "Stop tracking" on a thing bought once and never again (lib/retired.ts).
  onRetire?: (item: string) => void;
  insights: Insights | null;
  learning: boolean;
  rangeDays: number | null;
  onRange: (days: number | null) => void;
  // The day the household's spending month starts. Absent when it cannot be
  // changed from here.
  onBillingDay?: (day: number) => void;
}

const appName = (vendor: string) => SOURCES.find((s) => s.id === vendor)?.name ?? vendor;

// What the chosen window is called, in the middle of a sentence.
const windowText = (days: number | null) =>
  days === null ? 'all time' : days === 30 ? 'the last 30 days' : days === 365 ? 'the last 12 months' : days === 90 ? 'the last 3 months' : `the last ${days} days`;
// "12 months", "3 months", "30 days": the span alone, for "against the … before".
const spanText = (days: number) => (days === 365 ? '12 months' : days === 90 ? '3 months' : `${days} days`);

// ₹12,345 → "₹12.3k"; small sums as they are.
const rupees = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// What the household's own orders say about how it shops (design §12.7).
// Every number is counted from the orders; nothing is estimated here.
export function InsightsView({ insights, learning, rangeDays, onRange, onBillingDay, onRetire }: InsightsViewProps) {
  // Orders by time of day, shown on request.
  const [byTime, setByTime] = useState(false);
  // The rest of "what to do", shown on request.
  const [moreAdvice, setMoreAdvice] = useState(false);
  if (!insights) {
    return (
      <div className="flex justify-center py-24" role="status" aria-label="Loading">
        <Loader2 className="w-6 h-6 text-ink-300 animate-spin-slow" />
      </div>
    );
  }
  const i = insights;
  const busiest = [...i.dayparts].sort((a, b) => b.orders - a.orders)[0];

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6">
      <div className="mb-6 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">Insights</h1>
        <p className="text-sm text-ink-400">
          From {plural(i.orders, 'order', 'orders')} in {windowText(i.rangeDays)}
          {i.members.length > 1 ? `, placed by ${i.members.length} people` : ''}.{learning ? ' Still importing, so this will grow.' : ''}
        </p>
        {/* Only the cycle belongs up here: it decides the window the forecast
            card below is about. The range picker sits with the numbers it
            changes instead - above the forecast it looked like it moved that
            card too, and it never did. */}
        {i.forecast && onBillingDay && (
          <div className="mt-3">
            <CyclePicker billingDay={i.forecast.billingDay} from={i.forecast.from} to={i.forecast.to} onChange={onBillingDay} />
          </div>
        )}
      </div>

      {i.orders === 0 ? (
        <p className="text-center text-sm text-ink-400 py-16">No orders yet. Insights show up once some are imported.</p>
      ) : (
        <>
          {i.forecast && <MonthAhead f={i.forecast} />}

          {/* Everything from here down is the chosen range, so the control
              that chooses it stands at the top of it. */}
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            <RangePicker value={rangeDays} onChange={onRange} />
          </div>

          {/* Headline numbers */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
            <Stat label={`Spent in ${windowText(i.trendDays === i.rangeDays ? i.rangeDays : i.trendDays)}`} value={rupees(i.trend.recent)} />
            <Stat
              label={`Against the ${spanText(i.trendDays)} before`}
              value={i.trend.changePct === null ? 'No orders then' : `${i.trend.changePct > 0 ? '+' : ''}${i.trend.changePct}%`}
              icon={i.trend.changePct === null ? null : i.trend.changePct >= 0 ? TrendingUp : TrendingDown}
            />
            <Stat label="You order most often" value={`${busiest.label.toLowerCase()}, ${busiest.hours}`} wide />
          </div>

          {/* Beside the number it explains. It used to sit at the top of the
              page, above the forecast, so the best figure here was pushed
              below four lines of caveat about a different one. */}
          <UnevenHistory note={unevenHistoryNote(i.history, i.rangeDays, i.trendDays, new Date(), appName)} />

          {i.fees && i.fees.covered >= 0.8 && (
            <Section
              title="Delivery and handling"
              note={`What the apps charged on top of the goods, across ${plural(i.fees.orders, 'order', 'orders')}.`}
            >
              <div className="grid grid-cols-2 gap-3">
                <Stat label={`Paid in ${windowText(i.rangeDays)}`} value={rupees(i.fees.total)} />
                <Stat label="Typical fee per order" value={rupees(i.fees.perOrder)} />
              </div>
              {i.fees.extraTrips > 0 && (
                <div className="mt-3 rounded-xl bg-sand-100 p-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xl font-display font-semibold text-ink-800">{rupees(i.fees.onExtraTrips)}</span>
                    <span className="text-sm text-ink-600">on repeat trips</span>
                  </div>
                  <p className="text-xs text-ink-500 mt-1 leading-relaxed">
                    You ordered twice or more on {plural(i.fees.daysWithExtraTrips, 'day', 'days')}. Fees on those{' '}
                    {plural(i.fees.extraTrips, 'repeat order', 'repeat orders')} came to this. One trip instead of two saves most of it.
                  </p>
                </div>
              )}
            </Section>
          )}

          {/* The page's range drives the bars. A second copy of the range
              chips sat here and was the third set of them on one page. */}
          <Section title="Spend by month" note={`In ${windowText(i.rangeDays)}. The current month so far is shown lighter.`}>
            <MonthBars months={i.months} />
          </Section>

          {/* Two charts about WHEN you order, back to back, is one too many on
              a phone. The day of the week stays; the time of day is a tap away. */}
          <Section title="Orders by day">
            <Columns items={i.weekdays.map((w) => ({ label: w.label, value: w.orders, tip: `${w.label}: ${plural(w.orders, 'order', 'orders')}` }))} />
            {!byTime ? (
              <button onClick={() => setByTime(true)} className="mt-3 text-xs font-medium text-sage-700 hover:underline">
                By time of day
              </button>
            ) : (
              <div className="mt-4">
                <p className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">By time of day</p>
                <Rows items={i.dayparts.map((d) => ({ label: d.label, note: d.hours, value: d.orders, text: String(d.orders) }))} />
              </div>
            )}
          </Section>

          {/* Sentences with a verb in them, after the numbers and before the
              detail: what is happening first, then what to do about it. A
              few are shown; the rest wait behind one line. */}
          {i.advice.length > 0 && (
            <Section title="What to do" note="From your own orders. Nothing here is estimated.">
              <div className="space-y-2.5">
                {(moreAdvice ? i.advice : i.advice.slice(0, ADVICE_SHOWN)).map((a, n) => (
                  <div key={`${a.kind}-${a.item ?? n}`} className="card p-4">
                    <p className="text-sm font-semibold text-ink-800">{a.title}</p>
                    <p className="text-xs text-ink-500 mt-1 leading-relaxed">{a.detail}</p>
                    {a.items && onRetire && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {a.items.map((it) => (
                          <button
                            key={it.item}
                            onClick={() => onRetire(it.item)}
                            className="inline-flex items-center gap-1 text-xs py-1 px-2.5 rounded-full border border-sand-200 hover:bg-sand-100 text-ink-700"
                            aria-label={`Stop tracking ${it.name.toLowerCase()}`}
                          >
                            {it.name}
                            <X className="w-3 h-3 text-ink-400" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {i.advice.length > ADVICE_SHOWN && (
                <button onClick={() => setMoreAdvice((v) => !v)} className="mt-3 text-xs font-medium text-sage-700 hover:underline">
                  {moreAdvice ? 'Show fewer' : `Show ${i.advice.length - ADVICE_SHOWN} more`}
                </button>
              )}
            </Section>
          )}

          <Section title="Where the money goes" note={`The biggest of ${plural(i.topSpend.length + i.topSpendRest.kinds, 'thing', 'things')} you bought. Tap one to see what it went on.`}>
            <SpendRows items={i.topSpend} />
            {i.topSpendRest.kinds > 0 && (
              <p className="text-xs text-ink-400 mt-2">
                Everything else: {rupees(i.topSpendRest.spend)} across {plural(i.topSpendRest.kinds, 'other thing', 'other things')}.
              </p>
            )}
          </Section>

          {i.members.length > 1 && (
            <Section title="Who orders" note="Each person's connected apps.">
              <Rows items={i.members.map((m) => ({ label: m.name, value: m.orders, text: `${m.orders} orders · ${rupees(m.spend)}` }))} />
            </Section>
          )}

          {i.rhythm.length > 0 && (
            <Section title="How often you buy" note="The usual gap between orders, recent months counting most.">
              <ul className="card divide-y divide-sand-100">
                {i.rhythm.map((r) => (
                  <li key={r.name} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-lg" aria-hidden>
                      {r.emoji}
                    </span>
                    <span className="flex-1 text-sm text-ink-700">{r.name}</span>
                    <span className="text-sm text-ink-600">{r.everyDays === 1 ? 'Every day' : `Every ~${r.everyDays} days`}</span>
                    <span className="text-xs text-ink-400 w-20 text-right">{plural(r.trips, 'order', 'orders')}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* What replaced "Often bought together", which read as a horoscope:
              milk and tomato, milk and potato. Two things bought most weeks
              will land in the same order most weeks, and saying so is not a
              finding. This is: the same product, the same pack, on both apps. */}
          {i.compare.length > 0 && (
            <Section title="The same thing, cheaper elsewhere" note="Matched on the exact product and pack, from what you actually paid.">
              <ul className="card divide-y divide-sand-100">
                {i.compare.map((c) => (
                  <li key={`${c.product}-${c.pack}`} className="px-4 py-3">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 text-sm text-ink-700 truncate">{c.product}</span>
                      <span className="text-sm font-semibold text-sage-700 shrink-0">{rupees(c.saving)} less</span>
                    </div>
                    <p className="text-xs text-ink-400 mt-0.5">
                      {c.pack} · {appName(c.cheaper)} {rupees(c.cheaperPrice)}, {appName(c.dearer)} {rupees(c.dearerPrice)} · {plural(c.buys, 'buy', 'buys')} behind this
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(i.newHabits.length > 0 || i.stopped.length > 0) && (
            <div className="grid md:grid-cols-2 gap-x-6">
              {i.newHabits.length > 0 && (
                <Section title="New lately">
                  <ul className="card divide-y divide-sand-100">
                    {i.newHabits.map((h) => (
                      <li key={h.name} className="px-4 py-2.5">
                        <div className="text-sm text-ink-700">
                          {h.emoji} {h.name}
                        </div>
                        <div className="text-xs text-ink-400">
                          {plural(h.trips, 'order', 'orders')} since {h.since}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {i.stopped.length > 0 && (
                <Section title="Not bought lately">
                  <ul className="card divide-y divide-sand-100">
                    {i.stopped.map((s) => (
                      <li key={s.name} className="px-4 py-2.5">
                        <div className="text-sm text-ink-700">
                          {s.emoji} {s.name}
                        </div>
                        <div className="text-xs text-ink-400">
                          Was every ~{s.everyDays} days. Last bought {s.lastBought}.
                        </div>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Where this month is heading. It reads like a maps app's arrival time: the
// part already spent is certain, the rest is an estimate, and the estimate
// narrows by itself as the month runs out. On the last day the range is gone
// and the number is simply what was spent.
function MonthAhead({ f }: { f: Insights['forecast'] }) {
  if (!f) return null;
  // A calendar month gets its name; any other cycle gets its dates, because
  // "September" would be a lie for the 16th to the 15th.
  const monthName =
    f.billingDay === 1
      ? new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${f.from}T00:00:00Z`))
      : `${dayMonth(f.from)} to ${dayMonth(f.to)}`;
  // The bar runs to the top of the range, so the certain part and the guess
  // are drawn to the same scale.
  const scale = Math.max(f.high, f.spent, 1);
  const spentPct = (f.spent / scale) * 100;
  const midPct = (f.mid / scale) * 100;
  const lowPct = (f.low / scale) * 100;
  const highPct = (f.high / scale) * 100;
  const over = f.typicalByNow === null ? null : f.spent - f.typicalByNow;

  return (
    <div className="card p-5 mb-8">
      {/* The window this card is about, on its own: it names the whole card,
          not either figure. */}
      <div className="text-2xs text-ink-400">{monthName}</div>
      {/* Then spent on the left and heading for on the right, because that is
          the order the bar below reads in: the sage part starts at the left
          and is what has gone, and the estimate runs off to the right. Read
          the other way round the two halves disagreed with each other. */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap mt-1">
        <div>
          <div className="text-2xs text-ink-400">Spent so far</div>
          <div className="text-xl font-display font-semibold text-ink-700 mt-0.5">{rupees(f.spent)}</div>
        </div>
        <div className="text-right">
          <div className="text-2xs text-ink-400">Heading for</div>
          <div className="text-3xl font-display font-semibold text-ink-900 mt-0.5">{rupees(f.mid)}</div>
        </div>
      </div>


      {/* Certain, then estimated. The band is how wrong this could be. */}
      <div className="relative h-3 rounded-full bg-sand-100 mt-4 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-sand-300" style={{ width: `${highPct}%` }} />
        <div className="absolute inset-y-0 bg-sand-400/70" style={{ left: `${lowPct}%`, width: `${Math.max(0, highPct - lowPct)}%` }} />
        <div className="absolute inset-y-0 left-0 bg-sage-500" style={{ width: `${spentPct}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-ink-700" style={{ left: `${midPct}%` }} aria-hidden />
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 text-2xs text-ink-400">
        <span>
          {f.daysLeft === 0 ? 'The month is done' : `${rupees(f.low)} to ${rupees(f.high)}`}
        </span>
        <span>{f.daysLeft === 0 ? '' : `${plural(f.daysLeft, 'day', 'days')} to go`}</span>
      </div>

      {over !== null && f.daysLeft > 0 && (
        <p className="text-sm text-ink-600 mt-3 leading-relaxed">
          {f.daysGone} {f.daysGone === 1 ? 'day' : 'days'} in, you had usually spent <span className="font-semibold text-ink-800">{rupees(f.typicalByNow!)}</span>.{' '}
          {/* "This month" is a lie once the cycle is the 16th to the 15th. */}
          {Math.abs(over) < f.typicalByNow! * 0.1
            ? 'This one is running about the same.'
            : over > 0
              ? `This one is ${rupees(over)} ahead of that.`
              : `This one is ${rupees(-over)} behind that.`}
        </p>
      )}
    </div>
  );
}

// The household's spending cycle, beside the date range because it is the
// same kind of question: what window am I looking at. It was a line of
// underlined text inside the card at first and went unnoticed - a control
// that looks like a label is not a control.
// The household's spending cycle, beside the date range because it is the
// same kind of question: what window am I looking at. It was a line of
// underlined text inside the forecast card at first and went unnoticed - a
// control that looks like a label is not a control - and then a `select`,
// which a phone turns into a list covering the whole screen for what is
// really a date.
//
// So: a month of days, laid out as a month.
function CyclePicker({ billingDay, from, to, onChange }: { billingDay: number; from?: string; to?: string; onChange: (day: number) => void }) {
  const [open, setOpen] = useState(false);

  // Escape closes it, as it should for anything that opens over the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
          open ? 'bg-ink-900 text-sand-50 border-ink-900' : 'bg-surface text-ink-600 border-sand-200 hover:bg-sand-50'
        }`}
      >
        <CalendarDays className={`w-3.5 h-3.5 ${open ? 'text-sand-50' : 'text-ink-400'}`} aria-hidden />
        {/* Labelled, not just dated. "16 Sep to 15 Oct" sitting beside 30
            days and 3 months read as one more range to pick from, rather
            than as the household's own spending month. */}
        My month: {from && to ? `${dayMonth(from)} to ${dayMonth(to)}` : 'calendar'}
        <ChevronDown className={`w-3.5 h-3.5 ${open ? 'text-sand-50 rotate-180' : 'text-ink-400'} transition-transform`} aria-hidden />
      </button>

      {open && (
        <>
          {/* In the flow, under its button: floating, it covered the forecast
              card it was there to change. */}
          <div className="mt-2 w-[17.5rem] max-w-full card p-3 animate-fade-in">
            <p className="text-2xs text-ink-400 mb-2">My spending month runs from the</p>
            <div className="grid grid-cols-7 gap-1" role="group" aria-label="Day of the month">
              {Array.from({ length: 31 }, (_, n) => n + 1).map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    onChange(d);
                    setOpen(false);
                  }}
                  aria-pressed={d === billingDay}
                  className={`h-8 rounded-lg text-xs font-medium transition-colors ${
                    d === billingDay ? 'bg-ink-900 text-sand-50' : 'text-ink-600 hover:bg-sand-100'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            {/* Said because it is what a card does, and because February will
                otherwise look like a mistake. */}
            {billingDay > 28 && <p className="text-2xs text-ink-400 mt-2 leading-relaxed">Months too short for that start on their last day.</p>}
          </div>
        </>
      )}
    </div>
  );
}

// "2026-09-16" -> "16 Sep", in the household's own reading order.
// One formatter for dates on this page. There were two, and en-GB's "16
// Sept" sat eight lines above en-US's "Sep 16" for the same day.
const dayMonth = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));


// Where the money goes, and what it went ON. "Noodles, ₹750" is not an
// answer when the question is which noodles - so a row opens to show the
// products behind it, biggest first.
function SpendRows({ items }: { items: Insights['topSpend'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const most = Math.max(...items.map((t) => t.spend), 1);
  return (
    <ul className="card divide-y divide-sand-100">
      {items.map((t) => {
        const showing = open === t.name;
        return (
          <li key={t.name}>
            <button
              onClick={() => setOpen(showing ? null : t.name)}
              aria-expanded={showing}
              disabled={!t.products.length}
              className="w-full px-4 py-2.5 text-left hover:bg-sand-50 disabled:hover:bg-transparent"
            >
              <div className="flex items-center gap-3">
                <span className="flex-1 text-sm text-ink-700 truncate">
                  {t.emoji} {t.name}
                </span>
                <span className="text-xs text-ink-500 shrink-0">
                  {rupees(t.spend)} · {pct(t.share)}
                </span>
                {t.products.length > 0 && (
                  <ChevronDown className={`w-4 h-4 text-ink-300 shrink-0 transition-transform ${showing ? 'rotate-180' : ''}`} aria-hidden />
                )}
              </div>
              <div className="h-1.5 mt-1.5 rounded-full bg-sand-100 overflow-hidden">
                <div className="h-full rounded-full bg-sage-400" style={{ width: `${(t.spend / most) * 100}%` }} />
              </div>
            </button>
            {showing && (
              <ul className="px-4 pb-3 space-y-1">
                {t.products.map((p) => (
                  <li key={p.label} className="flex items-baseline gap-3 text-xs">
                    <span className="flex-1 text-ink-500 truncate">{p.label}</span>
                    <span className="text-ink-400 shrink-0">{plural(p.buys, 'buy', 'buys')}</span>
                    <span className="text-ink-700 font-medium shrink-0 w-14 text-right">{rupees(p.spend)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide">{title}</h2>
      {note && <p className="text-xs text-ink-400 mt-0.5">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// `wide`: the odd tile out spans both columns on a phone.
function Stat({ label, value, note, icon: Icon, wide = false }: { label: string; value: string; note?: string; icon?: typeof TrendingUp | null; wide?: boolean }) {
  return (
    <div className={`card p-4 ${wide ? 'col-span-2 md:col-span-1' : ''}`}>
      <div className="text-2xs text-ink-400">{label}</div>
      <div className="flex items-center gap-1.5 mt-1">
        {Icon && <Icon className="w-4 h-4 text-ink-400" aria-hidden />}
        <span className="text-xl font-display font-semibold text-ink-800">{value}</span>
      </div>
      {note && <div className="text-2xs text-ink-400 mt-0.5">{note}</div>}
    </div>
  );
}

// Twelve months of spend, one bar each. The hovered (or focused) bar's
// numbers show above the chart; the highest month is labelled directly.
function MonthBars({ months }: { months: Insights['months'] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => m.spend));
  const peak = months.findIndex((m) => m.spend === max);
  const shown = active ?? peak;
  const m = months[shown];
  return (
    <div className="card p-4">
      <p className="text-xs text-ink-500 h-4" aria-live="polite">
        <span className="font-semibold text-ink-700">
          {m.label} {m.key.slice(0, 4)}
        </span>
        {` · ${rupees(m.spend)} · ${plural(m.orders, 'order', 'orders')}${m.partial ? ' so far' : ''}`}
      </p>
      <div className="flex items-end gap-1 h-36 mt-3 border-b border-sand-200" role="list" aria-label="Spend by month">
        {months.map((x, idx) => (
          <button
            key={x.key}
            role="listitem"
            aria-label={`${x.label} ${x.key.slice(0, 4)}: ${rupees(x.spend)}, ${plural(x.orders, 'order', 'orders')}`}
            onMouseEnter={() => setActive(idx)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(idx)}
            onBlur={() => setActive(null)}
            className="flex-1 h-full flex items-end focus:outline-none group"
          >
            <span
              className={`w-full rounded-t ${x.partial ? 'bg-sage-300' : 'bg-sage-500'} ${idx === shown ? 'opacity-100' : 'opacity-80'} group-focus-visible:ring-2 group-focus-visible:ring-sage-700`}
              style={{ height: `${Math.max(x.spend > 0 ? 2 : 0, (x.spend / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="flex gap-1 mt-1.5">
        {months.map((x) => (
          <span key={x.key} className="flex-1 text-center text-2xs text-ink-400">
            {x.label.slice(0, 1)}
            <span className="hidden sm:inline">{x.label.slice(1)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// A few categories as upright bars (days of the week), each value shown
// on hover or focus, the busiest labelled directly.
function Columns({ items }: { items: { label: string; value: number; tip: string }[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...items.map((x) => x.value));
  const peak = items.findIndex((x) => x.value === max);
  const shown = active ?? peak;
  return (
    <div className="card p-4">
      <p className="text-xs text-ink-500 h-4" aria-live="polite">
        {items[shown].tip}
      </p>
      <div className="flex items-end gap-2 h-24 mt-3 border-b border-sand-200">
        {items.map((x, idx) => (
          <button
            key={x.label}
            aria-label={x.tip}
            onMouseEnter={() => setActive(idx)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(idx)}
            onBlur={() => setActive(null)}
            className="flex-1 h-full flex items-end focus:outline-none group"
          >
            <span
              className={`w-full rounded-t bg-sage-500 ${idx === shown ? 'opacity-100' : 'opacity-80'} group-focus-visible:ring-2 group-focus-visible:ring-sage-700`}
              style={{ height: `${Math.max(x.value > 0 ? 3 : 0, (x.value / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-1.5">
        {items.map((x) => (
          <span key={x.label} className="flex-1 text-center text-2xs text-ink-400">
            {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Labelled horizontal bars: every row names itself and states its value in
// text, so nothing depends on reading the bar.
function Rows({ items }: { items: { label: string; note?: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <div className="card p-4 space-y-3">
      {items.map((x) => (
        <div key={x.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink-700 truncate">
              {x.label}
              {x.note && <span className="text-2xs text-ink-400 ml-1.5">{x.note}</span>}
            </span>
            <span className="text-xs text-ink-500 shrink-0">{x.text}</span>
          </div>
          <div className="h-1.5 mt-1 rounded-full bg-sand-100 overflow-hidden">
            <div className="h-full rounded-full bg-sage-500" style={{ width: `${(x.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Said out loud when the apps' histories do not line up, so a number that is
// really a gap in what we could read is never left looking like a change in
// how the household shops. The rule itself lives in lib/insights.ts, tested.
function UnevenHistory({ note }: { note: string | null }) {
  if (!note) return null;
  return <p className="text-xs text-ink-400 -mt-6 mb-8 leading-relaxed">{note}</p>;
}
