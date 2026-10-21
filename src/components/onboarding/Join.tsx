import { useState } from 'react';
import { ArrowRight, Loader2, Users } from 'lucide-react';

import { ApiError } from '@/lib/api';
import { acceptInvite, declineInvite, inviteLine, type PendingInvite } from '@/lib/members';

interface JoinProps {
  invite: PendingInvite;
  // The user already has grocery apps connected: they move with them.
  hasApps: boolean;
  onJoined: () => void;
  onNotNow: () => void;
  onDeclined: () => void;
}

// Shown right after sign-in when a household has invited this email (design
// §19), before Connect: joining first means the person's own apps are then
// connected straight into the shared household.
export function Join({ invite, hasApps, onJoined, onNotNow, onDeclined }: JoinProps) {
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const act = async (kind: 'join' | 'decline') => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === 'join') {
        await acceptInvite(invite.id);
        onJoined();
      } else {
        await declineInvite(invite.id);
        onDeclined();
      }
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sand-50 px-6 animate-fade-in">
      <div className="w-full max-w-md">
        <div className="w-14 h-14 rounded-2xl bg-sage-100 flex items-center justify-center mb-6">
          <Users className="w-7 h-7 text-sage-700" />
        </div>
        <h1 className="font-display text-3xl text-ink-900 mb-3 text-balance">{inviteLine(invite)}</h1>
        <p className="text-ink-500 text-base leading-relaxed mb-2">
          You share the same stock and the same estimates. Everyone's orders count.
        </p>
        <p className="text-ink-500 text-base leading-relaxed mb-8">
          {hasApps
            ? 'Your connected grocery apps and their orders move to this household.'
            : 'Next, you connect your own grocery apps with your own phone number.'}
        </p>

        {message && <p className="text-sm text-clay-600 mb-4">{message}</p>}

        <button onClick={() => act('join')} disabled={busy !== null} className="btn-primary w-full text-base">
          {busy === 'join' ? <Loader2 className="w-5 h-5 animate-spin-slow" /> : null}
          Join {invite.householdName}
          {busy === null && <ArrowRight className="w-5 h-5" />}
        </button>
        <div className="flex items-center justify-center gap-4 mt-4">
          <button onClick={onNotNow} disabled={busy !== null} className="text-sm font-medium text-ink-400 hover:text-ink-600">
            Not now
          </button>
          <span className="text-ink-200">·</span>
          <button onClick={() => act('decline')} disabled={busy !== null} className="text-sm font-medium text-ink-400 hover:text-ink-600">
            {busy === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>
  );
}
