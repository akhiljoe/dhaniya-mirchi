import { useEffect, useState } from 'react';
import { Bell, BellOff, Check, Loader2 } from 'lucide-react';

import { ApiError } from '@/lib/api';
import { currentPushEnvironment, enableNotifications, notificationsOn, pushAvailability, type PushAvailability } from '@/lib/push';

type State = PushAvailability | 'checking' | 'working' | 'on' | 'failed';

// "Notify me when it's done" (design §7.10, §13.1). One control, honest about
// what this browser can do: a button where push works, how to install on an
// iPhone, and what to do when notifications are blocked.
export function NotifyMe() {
  const [state, setState] = useState<State>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const availability = pushAvailability(currentPushEnvironment());
    if (availability !== 'ready') {
      setState(availability);
      return;
    }
    notificationsOn()
      .then((on) => setState(on ? 'on' : 'ready'))
      .catch(() => setState('ready'));
  }, []);

  const enable = async () => {
    setState('working');
    setError(null);
    try {
      const result = await enableNotifications();
      setState(result === 'on' ? 'on' : result === 'denied' ? 'denied' : 'ready');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't turn notifications on. Please try again.");
      setState('failed');
    }
  };

  if (state === 'checking' || state === 'unsupported') return null;

  if (state === 'on') {
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-sm text-sage-700">
        <Check className="w-4 h-4" />
        We'll notify you when it's done
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="flex items-start gap-3 p-3 rounded-xl bg-sand-100 text-sm text-ink-500">
        <BellOff className="w-4 h-4 mt-0.5 shrink-0" />
        Notifications are blocked for this site. Allow them in your browser's site settings to hear when it's done.
      </div>
    );
  }

  // iPhone delivers web push only to an installed app, and the site is not
  // installable until launch (index.html), so there is nothing to offer here.
  if (state === 'needs-install') return null;

  return (
    <div>
      <button onClick={enable} disabled={state === 'working'} className="btn-secondary w-full">
        {state === 'working' ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <Bell className="w-4 h-4" />}
        Notify me when it's done
      </button>
      {error && <p className="text-sm text-clay-600 mt-2 text-center">{error}</p>}
    </div>
  );
}
