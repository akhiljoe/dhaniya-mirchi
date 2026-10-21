import { useEffect, useRef, useState } from 'react';
import { Check, LogOut, Monitor, Moon, Sparkles, Sun, Users } from 'lucide-react';

import { pictureUrlFor, initialOf, type Me } from '@/lib/auth';
import { applyTheme, readTheme, writeTheme, type Theme } from '@/lib/theme';

interface ProfileMenuProps {
  me: Me;
  onSignOut: () => void;
  // Opens the Household page (people and invites). Absent before there is one.
  onHousehold?: () => void;
  // Opens AI settings (design §19). Absent before there is a household.
  onAiSettings?: () => void;
  // In the header (the app's pages) rather than floating in the corner
  // (onboarding screens, which have no header).
  inline?: boolean;
}

// A round avatar fixed in the top-right corner; clicking it opens a small
// account popover (not a page). Clicking or tapping anywhere outside it, or
// pressing Escape, closes it.
export function ProfileMenu({ me, onSignOut, onHousehold, onAiSettings, inline = false }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [pictureFailed, setPictureFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown (not click) so a tap that starts outside closes it at once,
    // on touch screens too.
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const showPicture = me.hasPicture && !pictureFailed;
  const avatar = (size: string, text: string) =>
    showPicture ? (
      <img
        src={pictureUrlFor(me)}
        alt=""
        className={`${size} rounded-full object-cover`}
        onError={() => setPictureFailed(true)}
        referrerPolicy="no-referrer"
      />
    ) : (
      <span className={`${size} rounded-full bg-sage-200 text-sage-700 font-semibold flex items-center justify-center ${text}`}>
        {initialOf(me.email)}
      </span>
    );

  return (
    <div ref={root} className={inline ? 'relative' : 'fixed top-4 right-4 z-40'}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Account"
        className="rounded-full ring-2 ring-surface shadow-soft-md hover:ring-sage-200 focus:outline-none focus-visible:ring-sage-400 transition-all"
      >
        {avatar(inline ? 'w-9 h-9' : 'w-10 h-10', 'text-sm')}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute right-0 mt-2 w-72 rounded-2xl bg-surface border border-sand-200 shadow-soft-md p-4 animate-fade-in"
        >
          <div className="flex items-center gap-3 pb-4 border-b border-sand-100">
            {avatar('w-12 h-12', 'text-lg')}
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink-800 truncate">{me.email ?? 'Signed in with Google'}</div>
              {me.household && <div className="text-xs text-ink-400 truncate">{me.household.name}</div>}
            </div>
          </div>
          {onHousehold && (
            <button
              onClick={() => {
                setOpen(false);
                onHousehold();
              }}
              className="mt-3 w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-600 hover:bg-sand-100 transition-colors"
            >
              <Users className="w-4 h-4" />
              Household
              {(me.invites?.length ?? 0) > 0 && (
                <span className="ml-auto px-2 py-0.5 rounded-full text-2xs font-semibold bg-sage-100 text-sage-700">Invite</span>
              )}
            </button>
          )}
          {onAiSettings && (
            <button
              onClick={() => {
                setOpen(false);
                onAiSettings();
              }}
              className="mt-1 w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-600 hover:bg-sand-100 transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              AI settings
            </button>
          )}
          {/* Light, dark, or whatever the phone is set to. Three small
              buttons rather than a switch: "follow the phone" is a real
              third answer, not the absence of the other two. */}
          <div className="mt-3 pt-3 border-t border-sand-100">
            <p className="px-3 text-2xs uppercase tracking-wide text-ink-400 mb-1.5">Appearance</p>
            <div className="flex gap-1">
              {(
                [
                  { id: 'light' as const, label: 'Light', Icon: Sun },
                  { id: 'dark' as const, label: 'Dark', Icon: Moon },
                  { id: 'system' as const, label: 'Auto', Icon: Monitor },
                ]
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => {
                    setTheme(id);
                    writeTheme(id);
                    applyTheme(id);
                  }}
                  aria-pressed={theme === id}
                  className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-2xs font-medium transition-colors ${
                    theme === id ? 'bg-sand-100 text-ink-800' : 'text-ink-500 hover:bg-sand-100'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                  {theme === id && <Check className="w-3 h-3 text-sage-600" aria-hidden />}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className={`mt-3 w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-600 hover:bg-sand-100 transition-colors`}
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
