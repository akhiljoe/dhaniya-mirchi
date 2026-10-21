import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, TriangleAlert, X } from 'lucide-react';

import { Dismissable } from '@/components/Dismissable';
import { doneText, progressText, timeLeftText } from '@/lib/imports';
import type { ImportsState } from '@/lib/useImports';

interface ImportBarProps {
  imports: ImportsState;
  onOpen: () => void; // the full import screen
}

// A slim bar across the top of the app while an import runs (design §7.10),
// so the user can look around and still see how far along it is. When an
// import finishes while they're here, it says so once, until dismissed.
export function ImportBar({ imports, onOpen }: ImportBarProps) {
  const { overall, loaded } = imports;
  const { phase } = overall;
  const [justFinished, setJustFinished] = useState(false);
  const wasWorking = useRef(false);

  useEffect(() => {
    const working = phase === 'running' || phase === 'ready';
    if (wasWorking.current && phase === 'complete') setJustFinished(true);
    wasWorking.current = working;
  }, [phase]);

  if (!loaded) return null;

  if (phase === 'running' || phase === 'ready') {
    const parts = [
      overall.sync ? 'Checking for new orders' : phase === 'ready' ? 'Top items ready. Importing the rest' : 'Importing your order history',
      progressText(overall),
      timeLeftText(overall.completeAt, new Date(), overall.stillCounting),
    ].filter(Boolean);
    return (
      <Bar onClick={onOpen} tone="info" icon={<Loader2 className="w-4 h-4 text-sage-600 animate-spin-slow" />}>
        {parts.join(' · ')}
        {overall.percent !== null && (
          <span className="block h-0.5 mt-1.5 rounded-full bg-sage-100 overflow-hidden">
            <span className="block h-full bg-sage-500 transition-all duration-700" style={{ width: `${overall.percent}%` }} />
          </span>
        )}
      </Bar>
    );
  }

  if (phase === 'attention') {
    return (
      <Bar onClick={onOpen} tone="warn" icon={<TriangleAlert className="w-4 h-4 text-clay-500" />}>
        Import stopped. Tap to fix
      </Bar>
    );
  }

  // Finished: said once, then gone by itself (or swiped away). It reports
  // what already happened, so it must not sit in the way.
  if (phase === 'complete' && justFinished) {
    return (
      <Dismissable onDismiss={() => setJustFinished(false)}>
        <div className="flex items-center gap-3 px-4 py-2.5 bg-sage-50 border-b border-sage-200 text-sm text-ink-700 animate-fade-in-down">
          <Check className="w-4 h-4 text-sage-600 shrink-0" />
          <span className="flex-1">{doneText(overall)}</span>
          <button onClick={() => setJustFinished(false)} className="p-1 text-ink-400 hover:text-ink-600" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      </Dismissable>
    );
  }

  return null;
}

function Bar({ onClick, tone, icon, children }: { onClick: () => void; tone: 'info' | 'warn'; icon: React.ReactNode; children: React.ReactNode }) {
  const colors = tone === 'info' ? 'bg-surface border-sand-200 hover:bg-sand-50' : 'bg-clay-50 border-clay-200 hover:bg-clay-100';
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-2.5 border-b text-left text-sm text-ink-700 transition-colors ${colors}`}>
      {icon}
      <span className="flex-1 min-w-0">{children}</span>
      <span className="flex items-center gap-0.5 text-xs font-medium text-ink-400 shrink-0">
        Details <ChevronRight className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}
