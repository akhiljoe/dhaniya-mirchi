import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, KeyRound, Loader2, Sparkles, Trash2 } from 'lucide-react';

import type { Toast } from '../../types';
import { ApiError } from '@/lib/api';
import { OPENAI_KEYS_URL } from '@/lib/constants';
import { fetchAiSettings, removeKey, rupees, saveKey, type AiSettings } from '@/lib/ai';

interface AiSettingsViewProps {
  showToast: (toast: Omit<Toast, 'id'>) => void;
}

const dayLabel = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const thousands = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

// AI features (design §19). Short on purpose: what the AI is for, whether it
// is on, what it costs, and the one thing a household may have to do (paste a
// key). The counts and tokens are kept, one tap away, for anyone who wants
// them.
export function AiSettingsView({ showToast }: AiSettingsViewProps) {
  const [s, setS] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const load = useCallback(() => {
    fetchAiSettings()
      .then(setS)
      .catch(() => setS(null));
  }, []);
  useEffect(load, [load]);
  // A key just saved is checked by the server: look again until it says.
  useEffect(() => {
    if (!s?.ownKey || s.ownKey.checked) return;
    const t = window.setTimeout(load, 2_000);
    return () => window.clearTimeout(t);
  }, [s, load]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveKey(key);
      setKey('');
      showToast({ message: 'Key saved. Checking it now.', type: 'success' });
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not save the key. Please try again.');
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    await removeKey().catch(() => {});
    showToast({ message: 'Key removed.', type: 'success' });
    load();
  };

  if (!s) {
    return (
      <div className="flex justify-center py-24" role="status" aria-label="Loading">
        <Loader2 className="w-6 h-6 text-ink-300 animate-spin-slow" />
      </div>
    );
  }

  const status = s.paused
    ? 'Paused here for now'
    : s.ownKey
      ? s.ownKey.checked
        ? `On, using your key (…${s.ownKey.last4})`
        : `Checking your key (…${s.ownKey.last4})`
      : s.allowance
        ? `On. ${s.allowance.limit - s.allowance.used} of ${s.allowance.limit} free uses left this month`
        : 'Off. Add your key below to turn it on';
  const spent = s.usage.month.calls ? rupees(s.usage.month.inr) : '₹0';

  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6">
      <div className="mb-5 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">AI features</h1>
        <p className="text-sm text-ink-500">Two things here use AI: reading what you write about home, and planning a dish. Everything else works without it.</p>
      </div>

      <div className="card p-4 mb-4 flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-sage-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-800">{status}</p>
          <p className="text-xs text-ink-500 mt-0.5">
            {s.allowance && !s.ownKey ? `Free again on ${dayLabel(s.allowance.resetsOn)}. ` : ''}
            This month: {s.usage.month.calls} {s.usage.month.calls === 1 ? 'use' : 'uses'}, {spent}.
          </p>
        </div>
      </div>

      <div className="card p-4 mb-4">
        <p className="text-sm font-semibold text-ink-800 mb-1">Your own key</p>
        {s.ownKey ? (
          <div className="flex items-center gap-3">
            {s.ownKey.checked ? <CheckCircle2 className="w-5 h-5 text-sage-600" /> : <Loader2 className="w-5 h-5 text-ink-300 animate-spin-slow" />}
            <p className="flex-1 text-sm text-ink-700">
              sk-…{s.ownKey.last4}
              <span className="block text-xs text-ink-400">{s.ownKey.checked ? 'Working. You pay OpenAI directly.' : 'Checking with OpenAI'}</span>
            </p>
            <button onClick={remove} className="btn-ghost text-xs">
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-ink-500 mb-2">
              Not needed while the free uses last. With your own key there is no monthly limit, and about {rupees(s.estimate.inr)} a month at normal use.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) save();
              }}
            >
              <div className="flex gap-2">
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-..."
                  aria-label="Your OpenAI key"
                  className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-sand-200 bg-surface text-sm focus:outline-none focus:border-sage-400"
                />
                <button type="submit" disabled={saving || !key.trim()} className="btn-primary text-sm py-2.5 px-4">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <KeyRound className="w-4 h-4" />}
                  Save
                </button>
              </div>
              {message && <p className="text-xs text-clay-600 mt-2">{message}</p>}
            </form>
            <Toggle open={showSteps} onClick={() => setShowSteps((v) => !v)} label="How to get a key" />
            {showSteps && (
              <ol className="mt-2 space-y-1 text-xs text-ink-600 list-decimal list-inside">
                <li>
                  Open{' '}
                  <a href={OPENAI_KEYS_URL} target="_blank" rel="noopener noreferrer" className="text-sage-700 underline">
                    platform.openai.com
                  </a>{' '}
                  and sign in.
                </li>
                <li>Under Billing, add a small prepaid credit and set a monthly limit.</li>
                <li>Under API keys, create one and paste it above. Only its last 4 characters are kept on screen.</li>
              </ol>
            )}
          </>
        )}
      </div>

      <div className="card p-4 mb-4">
        <p className="text-sm font-semibold text-ink-800 mb-1.5">What is sent</p>
        <ul className="space-y-1 text-xs text-ink-600 list-disc pl-5">
          <li>Only what you type, and your item names. Never your orders, email, phone or address.</li>
          <li>Phone numbers, emails and card numbers are cut out before anything is sent.</li>
          <li>Nothing the AI says counts until you confirm it, and it never changes an estimate by itself.</li>
        </ul>
      </div>

      <Toggle open={showNumbers} onClick={() => setShowNumbers((v) => !v)} label="The numbers" />
      {showNumbers && (
        <div className="card p-4 mt-2 space-y-2 text-xs text-ink-600">
          <Line label="This month" value={`${s.usage.month.calls} uses · ${thousands(s.usage.month.inputTokens + s.usage.month.outputTokens)} tokens · ${spent}`} />
          <Line
            label="Last 30 days"
            value={`${s.usage.days30.calls} uses · ${thousands(s.usage.days30.inputTokens + s.usage.days30.outputTokens)} tokens · ${
              s.usage.days30.calls ? rupees(s.usage.days30.inr) : '₹0'
            }`}
          />
          <Line label="What it did" value={`${s.value.facts} changes added from your words · ${s.value.questions} questions asked back`} />
          <Line label="If you use it often" value={`about ${rupees(s.estimate.inr)} a month (${s.estimate.calls} uses on ${s.estimate.model})`} />
          <Line label="Limits" value={`${s.limits.perUserHour} an hour each, ${s.limits.perHouseholdDay} a day per household`} />
          {s.model && <Line label="Model" value={s.model} />}
        </div>
      )}
    </div>
  );
}

function Toggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-expanded={open} className="mt-2 flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-700">
      {label}
      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-400 shrink-0">{label}</span>
      <span className="text-ink-700 text-right">{value}</span>
    </div>
  );
}
