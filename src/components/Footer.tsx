import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { ApiError } from '@/lib/api';
import { FEEDBACK_MAX, SUPPORT_URL } from '@/lib/constants';
import { sendFeedback } from '@/lib/feedback';

interface FooterProps {
  page: string; // the view it is shown under, sent with feedback
  onHowItWorks: () => void;
}

// The end of every page (design §12.8): How it works, Send feedback and Buy
// me a coffee, as three quiet links. It sits at the end of the page, not
// pinned: on a phone the bottom nav already holds the bottom edge. The coffee
// link was Buy Me a Coffee's own yellow banner in a cursive face, and on a
// page of sage and sand it was the loudest thing on every screen. Nothing
// loads from them until someone taps.
export function Footer({ page, onHowItWorks }: FooterProps) {
  const [feedback, setFeedback] = useState(false);
  return (
    <footer className="mt-6 border-t border-sand-200 px-5 pt-5 pb-28 md:pb-8 text-center">
      <nav className="flex items-center justify-center gap-5 text-sm text-ink-500">
        <button onClick={onHowItWorks} className="py-2 hover:text-ink-700">
          How it works
        </button>
        <button onClick={() => setFeedback(true)} className="py-2 hover:text-ink-700">
          Send feedback
        </button>
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="py-2 hover:text-ink-700">
          Buy me a coffee
        </a>
      </nav>
      {feedback && <FeedbackSheet page={page} onClose={() => setFeedback(false)} />}
    </footer>
  );
}

// A sheet from the bottom on a phone, a centred card on a laptop.
function FeedbackSheet({ page, onClose }: { page: string; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'writing' | 'sending' | 'sent'>('writing');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      await sendFeedback(message, page);
      setState('sent');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send. Please try again.');
      setState('writing');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-scrim/30" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Send feedback"
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-md bg-surface rounded-t-3xl md:rounded-2xl p-5 pb-8 md:pb-5 text-left shadow-soft-md animate-fade-in-up"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg text-ink-900">Send feedback</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 text-ink-400 hover:text-ink-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        {state === 'sent' ? (
          <>
            <p className="text-sm text-ink-600">Sent. Thank you.</p>
            <button onClick={onClose} className="btn-primary w-full text-sm mt-4">
              Close
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-ink-500 mb-2">What works, what doesn't, what you'd like next.</p>
            <textarea
              ref={box}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={FEEDBACK_MAX}
              rows={5}
              className="w-full px-3 py-2.5 rounded-xl border border-sand-200 text-sm focus:outline-none focus:border-sage-400 resize-none"
            />
            {error && <p className="text-xs text-clay-600 mt-1">{error}</p>}
            <button onClick={send} disabled={state === 'sending' || !message.trim()} className="btn-primary w-full text-sm mt-3">
              {state === 'sending' && <Loader2 className="w-4 h-4 animate-spin-slow" />}
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
