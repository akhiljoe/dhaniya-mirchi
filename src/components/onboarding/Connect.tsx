import { useState } from 'react';
import { ArrowRight, ArrowLeft, Check } from 'lucide-react';
import type { SourceId } from '../../types';
import { SOURCES } from '../../data';
import { CONNECTABLE_SOURCES } from '@/lib/constants';

interface ConnectProps {
  onContinue: (connectedSources: SourceId[]) => void;
  onBack: () => void;
  // Signed in: only apps with a working connection can be picked; the rest
  // say "Coming soon". Preview (sample data): all of them, simulated.
  live?: boolean;
  // Just joined a household (design §19): say these are the person's own apps.
  joinedHousehold?: string | null;
}

export function Connect({ onContinue, onBack, live = false, joinedHousehold = null }: ConnectProps) {
  const [selected, setSelected] = useState<Set<SourceId>>(new Set());

  const toggle = (id: SourceId) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectedCount = selected.size;

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 max-w-2xl mx-auto w-full">
        <button onClick={onBack} className="btn-ghost">
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i <= 0 ? 'w-6 bg-ink-800' : 'w-1.5 bg-sand-300'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-2xl mx-auto w-full pb-12">
        <div className="w-full">
          <h2 className="font-display text-3xl text-ink-900 mb-3 text-balance">
            {joinedHousehold ? 'Now connect your own grocery apps' : 'Connect where you shop for groceries'}
          </h2>
          <p className="text-ink-400 text-base mb-8 leading-relaxed max-w-md">
            {joinedHousehold
              ? `Use your own phone number. Your orders join the rest of ${joinedHousehold}'s.`
              : 'We read your past orders to learn what you buy and when you run out. More apps connected means better estimates.'}
          </p>

          {/* Source cards */}
          <div className="space-y-3 mb-8 stagger">
            {SOURCES.map((source) => {
              const isSelected = selected.has(source.id);
              const available = !live || CONNECTABLE_SOURCES.includes(source.id);
              return (
                <button
                  key={source.id}
                  onClick={() => available && toggle(source.id)}
                  disabled={!available}
                  className={`w-full text-left p-4 rounded-2xl border-2 transition-all duration-200 flex items-center gap-4 ${
                    !available
                      ? 'border-sand-200 bg-sand-100/60 opacity-60 cursor-not-allowed'
                      : isSelected
                      ? 'border-sage-400 bg-sage-50 shadow-soft'
                      : 'border-sand-200 bg-surface hover:border-sand-300 hover:shadow-soft'
                  }`}
                >
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
                    style={{ backgroundColor: `${source.color}15` }}
                  >
                    {source.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-ink-800">{source.name}</div>
                    <div className="text-sm text-ink-400">{available ? source.description : 'Coming soon'}</div>
                  </div>
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all duration-200 ${
                      isSelected
                        ? 'bg-sage-500 border-sage-500'
                        : 'border-sand-300'
                    }`}
                  >
                    {isSelected && <Check className="w-4 h-4 text-sand-50" />}
                  </div>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => onContinue(Array.from(selected))}
            disabled={selectedCount === 0}
            className="btn-primary w-full text-base"
          >
            {selectedCount === 0
              ? 'Select at least one source'
              : `Continue with ${selectedCount} ${selectedCount === 1 ? 'source' : 'sources'}`}
            {selectedCount > 0 && <ArrowRight className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
