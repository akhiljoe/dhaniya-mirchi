// Coverage windows — which stretches of time the household's purchase history
// can actually see (design §9.10). Pure: the caller supplies each source's
// coverage; nothing here reads a clock or a database.
import type { HistoryGap, SourceCoverage } from './types';

// The household's history is complete only from the LATEST coverage start
// across its connected sources. Before that point at least one source's orders
// exist but are invisible (e.g. Instamart serves a rolling 12 months), even if
// another source (Blinkit) reaches further back.
export function coverageGaps(sources: SourceCoverage[]): HistoryGap[] {
  const starts = sources.map((s) => s.coverageStart).filter((d): d is Date => d !== null);
  if (starts.length === 0) return [];
  const latest = new Date(Math.max(...starts.map((d) => d.getTime())));
  return [{ from: null, to: latest, reason: 'coverage' }];
}

// Does the purchase interval [start, end] overlap the gap [from, to)? An
// interval that merely touches the gap — ends at `from` or starts at `to` —
// does not overlap: both of its purchases, and everything between, were visible.
export function overlapsGap(start: Date, end: Date, gap: HistoryGap): boolean {
  const afterFrom = gap.from === null || end.getTime() > gap.from.getTime();
  return afterFrom && start.getTime() < gap.to.getTime();
}
