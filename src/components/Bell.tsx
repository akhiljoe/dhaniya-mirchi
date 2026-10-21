import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell as BellIcon } from 'lucide-react';

import { fetchAnnouncements, markAnnouncementsRead, type Announcement } from '@/lib/announcements';

const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));

// Announcements from us (design §13.3), next to the profile photo. A dot
// while something is unread; opening the list marks it all read. Opened by
// itself when the page was reached from an announcement's push
// (?announcements=1).
export function Bell() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('announcements') === '1');
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetchAnnouncements()
      .then((r) => {
        setItems(r.announcements);
        setUnread(r.unread);
      })
      .catch(() => {
        // Nothing to show is fine; the next focus tries again.
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    if (new URLSearchParams(window.location.search).get('announcements') === '1') {
      window.history.replaceState(null, '', window.location.pathname);
    }
    return () => window.removeEventListener('focus', load);
  }, [load]);

  // Opening reads them all.
  useEffect(() => {
    if (!open || unread === 0) return;
    markAnnouncementsRead()
      .then(() => setUnread(0))
      .catch(() => {});
  }, [open, unread]);

  useEffect(() => {
    if (!open) return;
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

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `News, ${unread} unread` : 'News'}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-ink-500 hover:text-ink-700 hover:bg-sand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sage-400"
      >
        <BellIcon className="w-5 h-5" />
        {unread > 0 && <span className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-clay-500" aria-hidden />}
      </button>

      {open && (
        <div role="dialog" aria-label="News" className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl bg-surface border border-sand-200 shadow-soft-md p-2 animate-fade-in">
          <p className="px-2 pt-1 pb-2 text-xs font-semibold text-ink-500 uppercase tracking-wide">News</p>
          {items.length === 0 ? (
            <p className="px-2 pb-3 text-sm text-ink-400">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((a) => (
                <li key={a.id} className="px-2 py-2.5 border-t border-sand-100 first:border-t-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-800">{a.title}</p>
                    <span className="text-2xs text-ink-400 shrink-0">{dayLabel(a.createdAt)}</span>
                  </div>
                  <p className="text-sm text-ink-600 mt-0.5 whitespace-pre-line">{a.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
