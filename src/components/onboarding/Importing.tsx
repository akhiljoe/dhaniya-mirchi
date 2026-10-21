import { useState, useEffect, useRef } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { SourceId } from '../../types';
import { SOURCES, IMPORT_STAGES } from '../../data';

interface ImportingProps {
  connectedSources: SourceId[];
  onComplete: () => void;
}

export function Importing({ connectedSources, onComplete }: ImportingProps) {
  const [currentStage, setCurrentStage] = useState(0);
  const [stageProgress, setStageProgress] = useState(0);
  const [discovered, setDiscovered] = useState({ orders: 0, items: 0, recurring: 0, locations: 0 });
  const completedRef = useRef(false);

  // Animate discovery counters
  useEffect(() => {
    const targets = { orders: 47, items: 183, recurring: 32, locations: 2 };
    const interval = setInterval(() => {
      setDiscovered((prev) => ({
        orders: Math.min(prev.orders + 2, targets.orders),
        items: Math.min(prev.items + 8, targets.items),
        recurring: Math.min(prev.recurring + 2, targets.recurring),
        locations: Math.min(prev.locations + 1, targets.locations),
      }));
    }, 80);
    return () => clearInterval(interval);
  }, []);

  // Progress through stages
  useEffect(() => {
    const stageDuration = 1400;
    const tickInterval = 30;
    const ticksPerStage = stageDuration / tickInterval;

    const interval = setInterval(() => {
      setStageProgress((p) => {
        const newP = p + 100 / ticksPerStage;
        if (newP >= 100) {
          setCurrentStage((s) => {
            if (s >= IMPORT_STAGES.length - 1) {
              if (!completedRef.current) {
                completedRef.current = true;
                setTimeout(onComplete, 600);
              }
              return s;
            }
            return s + 1;
          });
          return 0;
        }
        return newP;
      });
    }, tickInterval);

    return () => clearInterval(interval);
  }, [onComplete]);

  const connectedSourceObjs = SOURCES.filter((s) => connectedSources.includes(s.id));

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sand-50 px-6 animate-fade-in">
      {/* Ambient backdrop */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] rounded-full bg-sage-200/20 blur-3xl animate-pulse-soft" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] rounded-full bg-accent-100/30 blur-3xl animate-pulse-soft" />
      </div>

      <div className="relative z-10 max-w-lg w-full">
        {/* Connected sources */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {connectedSourceObjs.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-sand-200 shadow-soft"
            >
              <span className="text-sm">{s.icon}</span>
              <span className="text-xs font-medium text-ink-600">{s.name}</span>
              <Check className="w-3 h-3 text-sage-600" />
            </div>
          ))}
        </div>

        {/* Discovery stats */}
        <div className="grid grid-cols-4 gap-3 mb-10">
          {[
            { label: 'Orders', value: discovered.orders, emoji: '📦' },
            { label: 'Items', value: discovered.items, emoji: '🛒' },
            { label: 'Recurring', value: discovered.recurring, emoji: '🔄' },
            { label: 'Locations', value: discovered.locations, emoji: '📍' },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl font-display font-semibold text-ink-800 tabular-nums">
                {stat.value}
              </div>
              <div className="text-2xs text-ink-400 mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Stages */}
        <div className="space-y-1">
          {IMPORT_STAGES.map((stage, i) => {
            const isComplete = i < currentStage;
            const isActive = i === currentStage;
            return (
              <div
                key={i}
                className={`flex items-center gap-4 p-3 rounded-xl transition-all duration-300 ${
                  isActive ? 'bg-surface shadow-soft' : isComplete ? 'opacity-60' : 'opacity-30'
                }`}
              >
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0">
                  {isComplete ? (
                    <div className="w-7 h-7 rounded-full bg-sage-500 flex items-center justify-center animate-check-pop">
                      <Check className="w-4 h-4 text-sand-50" />
                    </div>
                  ) : isActive ? (
                    <Loader2 className="w-6 h-6 text-ink-600 animate-spin-slow" />
                  ) : (
                    <div className="w-7 h-7 rounded-full border-2 border-sand-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${isActive || isComplete ? 'text-ink-700' : 'text-ink-400'}`}>
                    {stage.label}
                  </div>
                  {isActive && (
                    <div className="text-xs text-ink-400 mt-0.5">{stage.detail}</div>
                  )}
                </div>
                {isActive && (
                  <div className="w-16 h-1 rounded-full bg-sand-200 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-sage-500 transition-all duration-75 ease-out"
                      style={{ width: `${stageProgress}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-center text-sm text-ink-400 mt-8">
          This usually takes a few seconds. We're reading through your
          purchase history so we can understand your household.
        </p>
      </div>
    </div>
  );
}
