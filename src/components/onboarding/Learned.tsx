import { useState, useEffect } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { SourceId } from '../../types';
import { LEARNED_FACTS } from '../../data';

interface LearnedProps {
  connectedSources: SourceId[];
  onComplete: () => void;
}

export function Learned({ onComplete }: LearnedProps) {
  const [revealedCount, setRevealedCount] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setRevealedCount((c) => {
        if (c >= LEARNED_FACTS.length) {
          clearInterval(interval);
          return c;
        }
        return c + 1;
      });
    }, 350);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sand-50 px-6 animate-fade-in">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[10%] right-[5%] w-[300px] h-[300px] rounded-full bg-sage-200/25 blur-3xl" />
        <div className="absolute bottom-[5%] left-[5%] w-[250px] h-[250px] rounded-full bg-clay-200/20 blur-3xl" />
      </div>

      <div className="relative z-10 max-w-lg w-full">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sage-100 mb-5 animate-scale-in">
            <Check className="w-7 h-7 text-sage-600" />
          </div>
          <h2 className="font-display text-3xl text-ink-900 mb-3 text-balance">
            We've learned a few things about your household
          </h2>
          <p className="text-ink-400 text-base leading-relaxed">
            From your past orders.
          </p>
        </div>

        {/* Learned facts */}
        <div className="space-y-2.5 mb-10">
          {LEARNED_FACTS.map((fact, i) => (
            <div
              key={i}
              className={`flex items-center gap-4 p-4 rounded-2xl bg-surface border border-sand-200/60 shadow-soft transition-all duration-500 ${
                i < revealedCount
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 translate-y-3'
              }`}
            >
              <div className="w-10 h-10 rounded-xl bg-sand-100 flex items-center justify-center text-xl shrink-0">
                {fact.emoji}
              </div>
              <p className="text-sm font-medium text-ink-700 flex-1">{fact.text}</p>
              <Check className="w-4 h-4 text-sage-500" />
            </div>
          ))}
        </div>

        <div className="text-center">
          <p className="text-ink-500 text-sm mb-4 font-medium">
            We can now start predicting what you'll need next.
          </p>
          <button
            onClick={onComplete}
            className="btn-primary text-base px-7 py-4 animate-fade-in-up"
          >
            See your household
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
