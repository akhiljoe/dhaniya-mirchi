// Import progress in the browser (design §7.10). The server does the work and
// keeps the progress; the page only polls and words it — so the user can
// close the tab and come back to the same state.
import { api } from './api';

export type ImportStatus = 'queued' | 'listing' | 'packs' | 'complete' | 'needs_reconnect' | 'failed';

export interface ImportJob {
  connectionId?: string; // the connection it imports for (several per app in a shared household)
  // 'first' reads the order history; 'sync' fetches only new orders.
  kind?: 'first' | 'sync';
  vendor: string;
  status: ImportStatus;
  ordersDone: number;
  skusTotal: number | null; // null until the order list is fully fetched
  skusDone: number;
  readyAt: string | null; // the most-bought items are done: predictions usable
  completedAt: string | null;
  errorCode: string | null;
  startedAt: string;
  // From the products left to look up × the measured time per lookup.
  // stillCounting: the order list is still being read, so completeAt is the
  // least it takes. null once the run has ended.
  estimate: { readyAt: string | null; completeAt: string | null; stillCounting: boolean } | null;
}

export function fetchImports(): Promise<{ imports: ImportJob[] }> {
  return api('GET', '/api/imports');
}

// Start a stopped import again (it continues where it stopped).
export function retryImport(vendor: string): Promise<{ queued: boolean }> {
  return api('POST', `/api/imports/${encodeURIComponent(vendor)}/retry`, {});
}

const LIVE: ImportStatus[] = ['queued', 'listing', 'packs'];

export interface OverallImport {
  // none: nothing imported. running: still working. ready: still working, but
  // the most-bought items are in, so predictions are usable. complete: all
  // done. attention: nothing running and something stopped.
  phase: 'none' | 'running' | 'ready' | 'complete' | 'attention';
  percent: number | null; // null while the total amount of work is unknown
  completeAt: Date | null; // null: no estimate yet (no orders read so far)
  stillCounting: boolean; // an order list is still being read: completeAt is a lower bound
  ordersDone: number;
  // Every run shown only fetches new orders (no history being read).
  sync: boolean;
  needsReconnect: string[];
  failed: string[];
}

// One chip per app, not one per job. A shared household has a job per
// connection (design §19) and keeps finished runs, so mapping jobs straight to
// chips showed the same app three times over. The chip carries the app's worst
// live state: still working beats stopped, and stopped beats done - a finished
// run must never hide an account that still needs the user.
export interface VendorChipState {
  vendor: string;
  status: 'live' | 'attention' | 'complete';
  accounts: number; // jobs behind this chip, so a shared household can be told
}

export function vendorChips(jobs: ImportJob[]): VendorChipState[] {
  const order: string[] = [];
  const byVendor = new Map<string, ImportJob[]>();
  for (const j of jobs) {
    if (!byVendor.has(j.vendor)) {
      byVendor.set(j.vendor, []);
      order.push(j.vendor);
    }
    byVendor.get(j.vendor)!.push(j);
  }
  return order.map((vendor) => {
    const own = byVendor.get(vendor)!;
    const status = own.some((j) => LIVE.includes(j.status))
      ? 'live'
      : own.some((j) => j.status === 'needs_reconnect' || j.status === 'failed')
        ? 'attention'
        : 'complete';
    return { vendor, status, accounts: own.length };
  });
}

// One summary across every vendor being imported.
export function overallImport(jobs: ImportJob[]): OverallImport {
  const live = jobs.filter((j) => LIVE.includes(j.status));
  const needsReconnect = jobs.filter((j) => j.status === 'needs_reconnect').map((j) => j.vendor);
  const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.vendor);
  const ordersDone = jobs.reduce((n, j) => n + j.ordersDone, 0);

  let phase: OverallImport['phase'];
  if (live.length) phase = live.every((j) => j.readyAt) ? 'ready' : 'running';
  else if (needsReconnect.length || failed.length) phase = 'attention';
  else phase = jobs.length ? 'complete' : 'none';

  // The total is known only once every running import has its full order list.
  const known = live.length > 0 && live.every((j) => j.skusTotal !== null);
  const total = live.reduce((n, j) => n + (j.skusTotal ?? 0), 0);
  const done = live.reduce((n, j) => n + j.skusDone, 0);
  const percent = !known ? null : total === 0 ? 100 : Math.floor((done / total) * 100);

  // Finished when the slowest vendor is — unknown if any has no estimate yet.
  const ends = live.map((j) => j.estimate?.completeAt ?? null);
  const completeAt =
    ends.length && ends.every((e) => e !== null) ? new Date(Math.max(...ends.map((e) => new Date(e as string).getTime()))) : null;

  return {
    phase,
    percent,
    completeAt,
    stillCounting: live.some((j) => j.estimate?.stillCounting ?? true),
    ordersDone,
    sync: jobs.length > 0 && jobs.every((j) => j.kind === 'sync'),
    needsReconnect,
    failed,
  };
}

const MINUTE = 60_000;

// "about 18 min left", "about 1 h 15 min left". While orders are still being
// read the estimate only grows, so it says "at least". With no estimate yet
// (nothing read), it says so instead of guessing.
export function timeLeftText(completeAt: Date | null, now: Date, stillCounting = false): string {
  if (!completeAt) return 'working out how long this takes';
  const ms = completeAt.getTime() - now.getTime();
  if (ms < MINUTE) return stillCounting ? 'reading orders' : 'less than a minute left';
  const minutes = Math.ceil(ms / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const span = minutes < 60 ? `${minutes} min` : m ? `${h} h ${m} min` : `${h} h`;
  return stillCounting ? `at least ${span} left` : `about ${span} left`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// How far along, in the most honest terms available. A percentage needs to
// know the whole job, which is only true once the order list has been read.
// Before that - and for a vendor like Blinkit, where reading the list IS the
// work and it never says how many orders there are - a rising count of orders
// is the real answer, and better than a countdown that keeps not arriving.
export function progressText(overall: Pick<OverallImport, 'percent' | 'ordersDone'>): string | null {
  if (overall.percent !== null) return `${overall.percent}%`;
  return overall.ordersDone > 0 ? `${plural(overall.ordersDone, 'order', 'orders')} so far` : null;
}

// What a finished run says. A sync that found nothing never says "0 orders".
export function doneText(overall: Pick<OverallImport, 'sync' | 'ordersDone'>): string {
  if (!overall.sync) return `Import done. ${plural(overall.ordersDone, 'order', 'orders')} read.`;
  return overall.ordersDone ? `Synced. ${plural(overall.ordersDone, 'new order', 'new orders')}.` : 'Up to date. No new orders.';
}
