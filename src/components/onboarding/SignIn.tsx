import { ArrowLeft, Eye, LogIn, TriangleAlert } from 'lucide-react';

import { googleSignInWorksHere, SIGN_IN_URL, type Session, type SignInOutcome } from '@/lib/auth';

interface SignInProps {
  session: Session | null; // null while the check is in flight
  outcome: SignInOutcome | null; // result of the last attempt, if any
  onBack: () => void;
  onPreview: () => void; // look around with sample data — only when sign-in is unavailable
}

// Sign in to *our* site with Google (design §14.3). Not the grocery apps —
// those are connected later with their own phone + OTP (Auth.tsx).
export function SignIn({ session, outcome, onBack, onPreview }: SignInProps) {
  const unavailable = session?.state === 'unavailable';
  // On a plain-http home-network address Google sign-in can't work.
  const googleWorks = googleSignInWorksHere();

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 animate-fade-in">
      <div className="flex items-center justify-between px-6 py-5 max-w-md mx-auto w-full">
        <button onClick={onBack} className="btn-ghost">
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-md mx-auto w-full pb-12">
        <div className="w-full animate-fade-in-up">
          <h2 className="font-display text-2xl text-ink-900 mb-2">Sign in to your household</h2>
          <p className="text-ink-400 text-sm mb-8 leading-relaxed">Your household stays with your account, on every device.</p>

          {outcome && !unavailable && (
            <div className="w-full flex items-start gap-3 p-3 rounded-xl bg-clay-50 border border-clay-200 mb-4">
              <TriangleAlert className="w-4 h-4 text-clay-500 mt-0.5 shrink-0" />
              <p className="text-sm text-ink-600">
                {outcome === 'cancelled'
                  ? 'Sign-in was cancelled. You can try again whenever you like.'
                  : outcome === 'not_allowed'
                    ? "This Google account can't use DhaniyaMirchi yet. Ask the person who invited you to add your email."
                    : "That sign-in didn't go through. Please try again."}
              </p>
            </div>
          )}

          {unavailable ? (
            <>
              <div className="w-full flex items-start gap-3 p-3 rounded-xl bg-surface border border-sand-200 mb-4">
                <TriangleAlert className="w-4 h-4 text-clay-500 mt-0.5 shrink-0" />
                <p className="text-sm text-ink-600">
                  Sign-in isn't available on this server right now, so accounts can't be created yet.
                </p>
              </div>
              <button onClick={onPreview} className="btn-secondary w-full">
                <Eye className="w-5 h-5" />
                Look around with sample data
              </button>
            </>
          ) : googleWorks ? (
            <a
              href={SIGN_IN_URL}
              className={`btn-primary w-full ${session === null ? 'pointer-events-none opacity-60' : ''}`}
              aria-disabled={session === null}
            >
              <LogIn className="w-5 h-5" />
              Continue with Google
            </a>
          ) : (
            <div className="w-full flex items-start gap-3 p-3 rounded-xl bg-surface border border-sand-200">
              <TriangleAlert className="w-4 h-4 text-clay-500 mt-0.5 shrink-0" />
              <p className="text-sm text-ink-600">Google sign-in doesn't work on this address. Open the site at its https address.</p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
