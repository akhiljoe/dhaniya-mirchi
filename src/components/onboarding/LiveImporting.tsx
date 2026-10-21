import { useEffect, useState } from 'react';
import { ArrowRight, Check, CloudCog, Loader2, RotateCw, TriangleAlert } from 'lucide-react';

import { SOURCES } from '../../data';
import type { SourceId } from '../../types';
import { ApiError } from '@/lib/api';
import { doneText, retryImport, timeLeftText, vendorChips, type VendorChipState } from '@/lib/imports';
import { HouseholdQuick } from '@/components/HouseholdQuick';
import { NotifyMe } from '@/components/NotifyMe';
import { fetchFacts } from '@/lib/facts';
import type { ImportsState } from '@/lib/useImports';

interface LiveImportingProps {
  imports: ImportsState;
  onExplore: () => void;
  onReconnect: (vendor: SourceId) => void;
  // The household's timezone, to ask who lives here while this runs.
  timezone?: string | null;
}

const sourceOf = (vendor: string) => SOURCES.find((s) => s.id === vendor);
const nameOf = (vendor: string) => sourceOf(vendor)?.name ?? vendor;

// The real import screen (design §7.10). The work runs on our server, so this
// page only reports it — and says plainly that the user can leave.
export function LiveImporting({ imports, onExplore, onReconnect, timezone = null }: LiveImportingProps) {
  const { jobs, overall, loaded, refresh } = imports;
  const [now, setNow] = useState(() => new Date());
  const [retryError, setRetryError] = useState<string | null>(null);

  // While the import runs: ask who lives here, unless someone already said
  // (design §9.12). null = not checked yet.
  const [askWho, setAskWho] = useState<boolean | null>(null);
  useEffect(() => {
    fetchFacts()
      .then((f) => setAskWho(!f.some((x) => x.kind === 'people')))
      .catch(() => setAskWho(false));
  }, []);

  // Keep "about N min left" counting down between polls.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const retry = async (vendor: string) => {
    setRetryError(null);
    try {
      await retryImport(vendor);
      refresh();
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : 'Could not restart the import. Please try again.');
    }
  };

  const { phase } = overall;
  const working = phase === 'running' || phase === 'ready';
  const title =
    !loaded ? 'Checking your import…'
    : phase === 'none' ? 'Nothing to import yet'
    : phase === 'running' ? (overall.sync ? 'Checking for new orders' : 'Reading your order history')
    : phase === 'ready' ? 'Your most-bought items are ready'
    : phase === 'complete' ? 'All done'
    : 'Your import stopped';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sand-50 px-6 py-16 animate-fade-in">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] rounded-full bg-sage-200/20 blur-3xl animate-pulse-soft" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] rounded-full bg-accent-100/30 blur-3xl animate-pulse-soft" />
      </div>

      <div className="relative z-10 max-w-lg w-full">
        {jobs.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
            {vendorChips(jobs).map((c) => (
              <VendorChip key={c.vendor} chip={c} />
            ))}
          </div>
        )}

        <h1 className="font-display text-3xl text-ink-900 text-center mb-2">{title}</h1>
        <p className="text-center text-sm text-ink-500 mb-8">
          {working && timeLeftText(overall.completeAt, now, overall.stillCounting)}
          {phase === 'complete' && doneText(overall)}
          {phase === 'none' && loaded && 'Connect a grocery app and your history will appear here.'}
        </p>

        {working && (
          <>
            <ProgressBar percent={overall.percent} />
            <div className="grid grid-cols-2 gap-3 mt-6 mb-8">
              <Stat value={overall.ordersDone} label={overall.sync ? 'new orders' : 'orders found'} />
              <Stat
                value={jobs.reduce((n, j) => n + j.skusDone, 0)}
                label={
                  jobs.every((j) => j.skusTotal !== null)
                    ? `of ${jobs.reduce((n, j) => n + (j.skusTotal ?? 0), 0)} products learned`
                    : 'products learned'
                }
              />
            </div>
            {phase === 'ready' && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-sage-50 border border-sage-200 mb-4">
                <Check className="w-4 h-4 text-sage-600 mt-0.5 shrink-0" />
                <p className="text-sm text-ink-600">
                  Predictions start now for the things you buy most. The rest keeps filling in.
                </p>
              </div>
            )}
            <div className="flex items-start gap-3 p-4 rounded-xl bg-surface border border-sand-200 mb-8">
              <CloudCog className="w-4 h-4 text-ink-400 mt-0.5 shrink-0" />
              <p className="text-sm text-ink-500 leading-relaxed">
                <span className="font-medium text-ink-700">You can close this page.</span> The import keeps running.
              </p>
            </div>
            <div className="mb-4">
              <NotifyMe />
            </div>
            {askWho && timezone && (
              <div className="mb-4">
                <HouseholdQuick timezone={timezone} onSaved={() => setAskWho(false)} />
              </div>
            )}
          </>
        )}

        {(overall.needsReconnect.length > 0 || overall.failed.length > 0) && (
          <div className="space-y-2 mb-8">
            {overall.needsReconnect.map((v) => (
              <Problem key={v} text={`${nameOf(v)} logged us out, so its import paused. Reconnect it to carry on.`}>
                <button onClick={() => onReconnect(v as SourceId)} className="btn-secondary text-xs py-2 px-3">
                  Reconnect
                </button>
              </Problem>
            ))}
            {overall.failed.map((v) => (
              <Problem key={v} text={`Importing from ${nameOf(v)} stopped part-way. Trying again continues where it left off.`}>
                <button onClick={() => retry(v)} className="btn-secondary text-xs py-2 px-3">
                  <RotateCw className="w-3.5 h-3.5" />
                  Try again
                </button>
              </Problem>
            ))}
            {retryError && <p className="text-sm text-clay-600">{retryError}</p>}
          </div>
        )}

        {loaded && (
          <button onClick={onExplore} className="btn-primary w-full">
            {phase === 'running' ? 'Explore while we work' : 'See your household'}
            <ArrowRight className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

function VendorChip({ chip }: { chip: VendorChipState }) {
  const s = sourceOf(chip.vendor);
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-sand-200 shadow-soft">
      <span className="text-sm">{s?.icon}</span>
      <span className="text-xs font-medium text-ink-600">{s?.name ?? chip.vendor}</span>
      {chip.accounts > 1 && <span className="text-xs text-ink-400">{chip.accounts} accounts</span>}
      {chip.status === 'live' ? (
        <Loader2 className="w-3 h-3 text-ink-400 animate-spin-slow" />
      ) : chip.status === 'complete' ? (
        <Check className="w-3 h-3 text-sage-600" />
      ) : (
        <TriangleAlert className="w-3 h-3 text-clay-500" />
      )}
    </div>
  );
}

// A known percent fills the bar; an unknown one (the order list is still being
// fetched, so the total isn't known) shimmers instead of pretending.
export function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div
      className="h-2 rounded-full bg-sand-200 overflow-hidden"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      {percent === null ? (
        <div className="h-full w-full bg-gradient-to-r from-sand-200 via-sage-400 to-sand-200 bg-[length:200%_100%] animate-shimmer" />
      ) : (
        <div className="h-full rounded-full bg-sage-500 transition-all duration-700 ease-out" style={{ width: `${percent}%` }} />
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center p-3 rounded-xl bg-surface border border-sand-200">
      <div className="text-2xl font-display font-semibold text-ink-800 tabular-nums">{value}</div>
      <div className="text-2xs text-ink-400 mt-0.5">{label}</div>
    </div>
  );
}

function Problem({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-clay-50 border border-clay-200">
      <TriangleAlert className="w-4 h-4 text-clay-500 shrink-0" />
      <p className="flex-1 text-sm text-ink-600">{text}</p>
      {children}
    </div>
  );
}
