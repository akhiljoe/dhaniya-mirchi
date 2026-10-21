// The app asks (design §9.12, Phase 4; §9.11 "were you away?"): plain code
// notices something in the household's own orders and facts, and asks. A
// suggestion changes nothing until the person answers; no model is involved.
//
//  - buying changed: the household's staples are bought markedly more (or
//    less) often since some week, and nobody has said who lives here since
//    then → "Did someone move in or come to stay?"
//  - guests leaving: a stay the household entered ends today → "Still here?"
//  - away: no order for longer than the household has ever gone → "Were you
//    away?" (only asked, never assumed: a wrong away would freeze real use).
import { classifyLine, isStock } from '@/catalog/classify';

import {
  SUGGEST_AWAY_GAP_PERCENTILE,
  SUGGEST_AWAY_MIN_DAYS,
  SUGGEST_AWAY_MIN_ORDERS,
  SUGGEST_CHANGE_AFTER_WEEKS,
  SUGGEST_CHANGE_BEFORE_WEEKS,
  SUGGEST_CHANGE_DOWN,
  SUGGEST_CHANGE_MIN_BEFORE,
  SUGGEST_CHANGE_NEW_SOURCE_DAYS,
  SUGGEST_CHANGE_RECENT_WEEKS,
  SUGGEST_CHANGE_TOLD_DAYS,
  SUGGEST_CHANGE_UP,
  SUGGEST_CHANGE_WEEKS,
  SUGGEST_STAPLES,
} from './constants';
import { lineQty, type Unit } from '@/engine';

import { localDay, type Fact } from './facts';
import type { ApiOrder } from './household';

const DAY = 86_400_000;

export type Suggestion =
  | { id: string; kind: 'buying_changed'; direction: 'up' | 'down'; ratio: number; since: string }
  | { id: string; kind: 'guests_leaving'; fact: Fact }
  | { id: string; kind: 'away'; lastOrder: string; days: number };

// Monday of the week a household-local day falls in.
function weekOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * DAY).toISOString().slice(0, 10);
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The week buying changed most, if it changed enough. Measured as amounts,
// not trips: a bigger household mostly buys more each time (the household's
// own milk went from 2.5-4 L a week to 4.5-8.5 L while its trips rose only
// ~1.3×). For each of the SUGGEST_STAPLES most-bought items whose packs are
// known, its weekly amount over its own average; the index is the mean.
export function buyingChange(orders: ApiOrder[], facts: Fact[], today: string, tz: string): Suggestion | null {
  const thisWeek = weekOf(today);
  const weeks: string[] = [];
  for (let i = SUGGEST_CHANGE_WEEKS; i >= 1; i--) weeks.push(addDays(thisWeek, -7 * i)); // full weeks only
  const first = weeks[0];

  // Amount per item per week, in canonical units (lines with no known pack
  // are left out, never guessed), and how many orders bought each item.
  const amounts = new Map<string, { unit: Unit; byWeek: Map<string, number>; orders: number }>();
  const sourceStart = new Map<string, string>();
  for (const o of orders) {
    const day = localDay(new Date(o.placedAt), tz);
    const source = `${o.vendor}:${o.by ?? ''}`;
    if (!sourceStart.has(source) || day < sourceStart.get(source)!) sourceStart.set(source, day);
    if (day < first || day >= thisWeek) continue;
    const seen = new Set<string>();
    for (const l of o.items) {
      const c = classifyLine(l);
      if (!isStock(c)) continue;
      const qty = lineQty(l.count, l.packLabel, c.unit);
      if (qty === null) continue;
      const a = amounts.get(c.canonical) ?? { unit: c.unit, byWeek: new Map<string, number>(), orders: 0 };
      amounts.set(c.canonical, a);
      const w = weekOf(day);
      a.byWeek.set(w, (a.byWeek.get(w) ?? 0) + qty);
      if (!seen.has(c.canonical)) a.orders++;
      seen.add(c.canonical);
    }
  }
  const staples = [...amounts.values()].sort((a, b) => b.orders - a.orders).slice(0, SUGGEST_STAPLES);
  if (!staples.length) return null;
  // Each staple's weeks over its own average, so milk in litres and eggs in
  // pieces weigh the same; the household index is their mean.
  const normal = staples.map((a) => {
    const avg = mean(weeks.map((w) => a.byWeek.get(w) ?? 0));
    return weeks.map((w) => (avg > 0 ? (a.byWeek.get(w) ?? 0) / avg : 0));
  });
  const perWeek = weeks.map((_, i) => mean(normal.map((n) => n[i])));
  const tripsPerWeek = weeks.map((w) => staples.reduce((n, a) => n + (a.byWeek.has(w) ? 1 : 0), 0));

  // The split with the biggest change, keeping enough weeks on each side.
  let best: { k: number; ratio: number } | null = null;
  // Only a change from the last SUGGEST_CHANGE_RECENT_WEEKS: older ones were
  // either told already, or not worth asking about any more.
  for (let k = Math.max(SUGGEST_CHANGE_BEFORE_WEEKS, weeks.length - SUGGEST_CHANGE_RECENT_WEEKS); k <= weeks.length - SUGGEST_CHANGE_AFTER_WEEKS; k++) {
    const before = mean(perWeek.slice(0, k));
    const after = mean(perWeek.slice(k));
    // Enough buying before the change to judge from.
    if (mean(tripsPerWeek.slice(0, k)) < SUGGEST_CHANGE_MIN_BEFORE || before <= 0) continue;
    const ratio = after / before;
    if (!best || Math.abs(Math.log(ratio)) > Math.abs(Math.log(best.ratio))) best = { k, ratio };
  }
  if (!best || (best.ratio < SUGGEST_CHANGE_UP && best.ratio > SUGGEST_CHANGE_DOWN)) return null;
  const since = weeks[best.k];

  // Not when the household already said who lives here around then, and not
  // when a new account's orders simply started arriving (a member joining).
  const told = facts.some((f) => (f.kind === 'people' || f.kind === 'guests' || f.kind === 'away') && Math.abs(daysBetween(since, f.startsOn)) <= SUGGEST_CHANGE_TOLD_DAYS);
  const toldSince = facts.some((f) => f.kind === 'people' && f.startsOn >= addDays(since, -SUGGEST_CHANGE_TOLD_DAYS));
  const newSource = [...sourceStart.values()].some((d) => d > first && Math.abs(daysBetween(d, since)) <= SUGGEST_CHANGE_NEW_SOURCE_DAYS);
  if (told || toldSince || newSource) return null;

  const direction = best.ratio >= 1 ? 'up' : 'down';
  return { id: `buying_changed:${since}:${direction}`, kind: 'buying_changed', direction, ratio: Math.round(best.ratio * 10) / 10, since };
}

// Guest stays that end today.
export function guestsLeaving(facts: Fact[], today: string): Suggestion[] {
  return facts.filter((f) => f.kind === 'guests' && f.endsOn === today).map((f) => ({ id: `guests_leaving:${f.id}`, kind: 'guests_leaving', fact: f }));
}

// No order for longer than the household has ever gone between orders.
export function wereYouAway(orders: ApiOrder[], facts: Fact[], today: string, tz: string): Suggestion | null {
  const days = [...new Set(orders.map((o) => localDay(new Date(o.placedAt), tz)))].sort();
  if (days.length < SUGGEST_AWAY_MIN_ORDERS) return null;
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).sort((a, b) => a - b);
  const usual = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * SUGGEST_AWAY_GAP_PERCENTILE))];
  const last = days[days.length - 1];
  const silent = daysBetween(last, today);
  if (silent <= Math.max(usual, SUGGEST_AWAY_MIN_DAYS)) return null;
  // Already said: time away that covers the silence.
  if (facts.some((f) => f.kind === 'away' && f.startsOn <= addDays(last, 1) && (f.endsOn === null || f.endsOn >= today))) return null;
  return { id: `away:${last}`, kind: 'away', lastOrder: last, days: silent };
}

export function suggestionsFor(orders: ApiOrder[], facts: Fact[], now: Date, tz: string): Suggestion[] {
  const today = localDay(now, tz);
  const out: Suggestion[] = [...guestsLeaving(facts, today)];
  const away = wereYouAway(orders, facts, today, tz);
  if (away) out.push(away);
  // A household away doesn't need asking why it bought less.
  const change = away ? null : buyingChange(orders, facts, today, tz);
  if (change) out.push(change);
  return out;
}
