import { useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';

interface WelcomeProps {
  onStart: () => void;
}

export function Welcome({ onStart }: WelcomeProps) {
  const [exiting, setExiting] = useState(false);

  const handleStart = () => {
    setExiting(true);
    setTimeout(onStart, 400);
  };

  return (
    <div
      className={`min-h-screen flex flex-col items-center justify-center px-6 bg-sand-50 transition-opacity duration-400 ${
        exiting ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {/* Ambient gradient backdrop */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-5%] w-[400px] h-[400px] rounded-full bg-sage-200/30 blur-3xl" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[350px] h-[350px] rounded-full bg-clay-200/30 blur-3xl" />
        <div className="absolute top-[40%] right-[20%] w-[200px] h-[200px] rounded-full bg-accent-100/40 blur-3xl" />
      </div>

      <div className="relative z-10 max-w-lg w-full text-center">
        {/* Logo mark */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface shadow-soft-md mb-8 animate-scale-in">
          <div className="flex items-center gap-0.5">
            <span className="text-3xl">🏠</span>
          </div>
        </div>

        <h1 className="font-display text-4xl sm:text-5xl text-ink-900 leading-tight mb-4 animate-fade-in-up text-balance">
          It remembers what's in your kitchen
          <br />
          <span className="text-sage-600">so you don't have to.</span>
        </h1>

        <p className="text-ink-400 text-lg leading-relaxed mb-10 animate-fade-in-up max-w-md mx-auto" style={{ animationDelay: '0.1s' }}>
          DhaniyaMirchi tracks what you buy, learns how fast you use it,
          and tells you what to buy next.
        </p>

        {/* Visual: floating items */}
        <div className="flex items-center justify-center gap-3 mb-12 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
          {[
            { emoji: '🥛', label: 'Milk', sub: 'running low' },
            { emoji: '🍞', label: 'Bread', sub: '2 days' },
            { emoji: '🥚', label: 'Eggs', sub: '3 days' },
          ].map((item, i) => (
            <div
              key={item.label}
              className="bg-surface rounded-2xl shadow-soft px-4 py-3 flex flex-col items-center gap-1 animate-fade-in-up"
              style={{ animationDelay: `${0.3 + i * 0.1}s` }}
            >
              <span className="text-2xl">{item.emoji}</span>
              <span className="text-xs font-semibold text-ink-700">{item.label}</span>
              <span className="text-2xs text-clay-500">{item.sub}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleStart}
          className="btn-primary text-base px-7 py-4 animate-fade-in-up"
          style={{ animationDelay: '0.5s' }}
        >
          Set up your household
          <ArrowRight className="w-5 h-5" />
        </button>

        <p className="text-ink-300 text-sm mt-5 animate-fade-in-up flex items-center justify-center gap-1.5" style={{ animationDelay: '0.6s' }}>
          <Sparkles className="w-3.5 h-3.5" />
          Takes about a minute. No manual entry.
        </p>
      </div>
    </div>
  );
}
