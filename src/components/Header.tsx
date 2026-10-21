import type { ReactNode } from 'react';

interface HeaderProps {
  onHome: () => void;
  right: ReactNode; // the bell and the profile photo
}

// The app's header on every page (phone first): the name on the left, news
// and the profile photo on the right. Sticky, so both stay one tap away.
export function Header({ onHome, right }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 h-14 flex items-center justify-between gap-3 px-4 md:px-5 bg-sand-50/95 backdrop-blur-md border-b border-sand-200">
      <button onClick={onHome} className="flex items-center gap-2 min-w-0" aria-label="DhaniyaMirchi, home">
        <img src="/icon.svg" alt="" className="w-8 h-8 rounded-lg shrink-0" />
        <span className="font-display font-semibold text-ink-800 text-base truncate">DhaniyaMirchi</span>
      </button>
      <div className="flex items-center gap-1.5">{right}</div>
    </header>
  );
}
