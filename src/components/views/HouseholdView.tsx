import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, Plus, Store, UserMinus, Users } from 'lucide-react';

import { SOURCES } from '../../data';
import type { Toast } from '../../types';
import { ApiError } from '@/lib/api';
import type { Me } from '@/lib/auth';
import type { RetiredItem } from '@/lib/retired';
import type { Fact } from '@/lib/facts';
import { HouseholdFacts, type FactItem } from './HouseholdFacts';
import {
  acceptInvite,
  cancelInvite,
  declineInvite,
  fetchMembers,
  inviteLine,
  leaveHousehold,
  memberName,
  removeMember,
  sendInvite,
  type Member,
  type SentInvite,
  renameMe,
} from '@/lib/members';

interface HouseholdViewProps {
  me: Me;
  // Items the household said it no longer buys, and the way back.
  retired: RetiredItem[];
  onUnretire: (item: string) => void;
  // The household changed (joined, left, someone removed): reload who we are,
  // the connections and the orders.
  onChanged: () => void;
  // Connect the viewer's own grocery apps.
  onConnect: () => void;
  // What the household told us about itself (design §9.12), and the items it
  // buys (for "used every day").
  facts: Fact[];
  items: FactItem[];
  // "Tell us what's changing" (design §7.8), above the facts.
  tellUs?: React.ReactNode;
  // The app's own questions, which used to sit on Home. They belong with
  // everything else about who lives here.
  asks?: React.ReactNode;
  showToast: (toast: Omit<Toast, 'id'>) => void;
}

const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
const appName = (vendor: string) => SOURCES.find((s) => s.id === vendor)?.name ?? vendor;
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

// Who is in the household, who is invited, and the controls for both (design
// §19). Each person connects their own grocery apps; everyone's orders count.
export function HouseholdView({ me, onChanged, onConnect, facts, items, tellUs, asks, showToast, retired, onUnretire }: HouseholdViewProps) {
  const [members, setMembers] = useState<Member[] | null>(null);
  // The name being typed, or null when not editing.
  const [naming, setNaming] = useState<string | null>(null);
  const [invites, setInvites] = useState<SentInvite[]>([]);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The one action waiting for "are you sure": a member to remove, or leaving.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchMembers();
      setMembers(r.members);
      setInvites(r.invites);
    } catch {
      setMembers([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, me.household?.id]);

  const owner = me.household?.role === 'owner';
  const you = members?.find((m) => m.you);

  const invite = async () => {
    setSending(true);
    setMessage(null);
    try {
      const { invite: sent } = await sendInvite(email);
      setEmail('');
      showToast({ message: `Invited ${sent.email}. They see it when they sign in.`, type: 'success' });
      await load();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setSending(false);
    }
  };

  // Every change goes through here: one at a time, then a reload.
  const run = async (work: () => Promise<unknown>, done: string, householdChanged: boolean) => {
    setBusy(true);
    try {
      await work();
      setConfirming(null);
      showToast({ message: done, type: 'success' });
      if (householdChanged) onChanged();
      await load();
    } catch (err) {
      showToast({ message: errorText(err), type: 'info' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6">
      <div className="mb-6 animate-fade-in-down">
        {/* "Household", not the household's own name: this one is called Home,
            and a page titled Home that is not the app's home was confusing. */}
        <h1 className="font-display text-2xl text-ink-900 mb-1">Household</h1>
        <p className="text-sm text-ink-400">
          {me.household?.name ? `${me.household.name}. ` : ''}Everyone here shares the same stock and estimates. Each person's orders count.
        </p>
      </div>

      {/* Invites waiting for the viewer ("Not now" on the join screen). */}
      {(me.invites ?? []).map((i) => (
        <div key={i.id} className="card p-4 mb-4 border-sage-200 bg-sage-50">
          <p className="text-sm font-semibold text-ink-800">{inviteLine(i)}</p>
          <p className="text-xs text-ink-500 mt-0.5">Your grocery apps and their orders move with you.</p>
          <div className="flex gap-2 mt-3">
            <button
              disabled={busy}
              onClick={() => run(() => acceptInvite(i.id), `You joined ${i.householdName}.`, true)}
              className="btn-primary text-xs py-2 px-3"
            >
              Join {i.householdName}
            </button>
            <button disabled={busy} onClick={() => run(() => declineInvite(i.id), 'Invite declined.', true)} className="btn-ghost text-xs">
              Decline
            </button>
          </div>
        </div>
      ))}

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide mb-3">Members</h2>
        {members === null ? (
          <div className="flex justify-center py-8" role="status" aria-label="Loading">
            <Loader2 className="w-5 h-5 text-ink-300 animate-spin-slow" />
          </div>
        ) : (
          <div className="space-y-2.5">
            {members.map((m) => (
              <div key={m.userId} className="card p-4">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-full bg-sage-200 text-sage-700 font-semibold flex items-center justify-center shrink-0">
                    {(m.email ?? '?')[0].toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-ink-800 truncate">{m.you ? (m.name ?? 'You') : memberName(m.email, false, m.name)}</span>
                      {m.role === 'owner' && <span className="chip bg-sand-100 text-ink-500">Owner</span>}
                      {/* The one place a person names themself. Every page
                          that names people reads it: History, Insights, Apps.
                          Without it they were all the email's local part. */}
                      {m.you && naming === null && (
                        <button onClick={() => setNaming(m.name ?? '')} className="text-2xs font-medium text-sage-700 hover:underline">
                          {m.name ? 'Change name' : 'Set your name'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-ink-400 truncate">{m.email}</p>
                    {m.you && naming !== null && (
                      <form
                        className="flex items-center gap-2 mt-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = naming.trim();
                          if (!name) return;
                          void run(() => renameMe(name), `You are ${name} here now.`, true).then(() => setNaming(null));
                        }}
                      >
                        <input
                          value={naming}
                          onChange={(e) => setNaming(e.target.value)}
                          maxLength={40}
                          placeholder="Your first name"
                          aria-label="Your name"
                          autoFocus
                          className="flex-1 min-w-0 rounded-lg border border-sand-200 bg-surface px-3 py-1.5 text-sm focus:outline-none focus:border-sage-400"
                        />
                        <button type="submit" disabled={busy || !naming.trim()} className="btn-primary text-xs py-1.5 px-3">
                          Save
                        </button>
                        <button type="button" onClick={() => setNaming(null)} className="btn-ghost text-xs">
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                  {owner && !m.you && confirming !== m.userId && (
                    <button onClick={() => setConfirming(m.userId)} className="btn-ghost text-xs" aria-label={`Remove ${memberName(m.email, false, m.name)}`}>
                      <UserMinus className="w-4 h-4" />
                      Remove
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mt-3 pl-[3.25rem]">
                  <Store className="w-3.5 h-3.5 text-ink-300" />
                  {m.apps.length === 0 ? (
                    <span className="text-xs text-ink-400">No grocery apps connected yet</span>
                  ) : (
                    m.apps.map((a) => (
                      <span key={a.vendor} className={`chip ${a.status === 'active' ? 'bg-sage-100 text-sage-700' : 'bg-clay-100 text-clay-700'}`}>
                        {appName(a.vendor)}
                        {a.status === 'active' ? '' : ': reconnect needed'}
                      </span>
                    ))
                  )}
                </div>
                {m.you && m.apps.length === 0 && (
                  <button onClick={onConnect} className="btn-secondary text-xs py-2 px-3 mt-3">
                    <Plus className="w-3.5 h-3.5" />
                    Connect your grocery apps
                  </button>
                )}

                {confirming === m.userId && (
                  <div className="mt-3 pt-3 border-t border-sand-100">
                    <p className="text-xs text-ink-600">
                      Remove {memberName(m.email, false, m.name)}? Their grocery apps and orders leave with them.
                    </p>
                    <div className="flex gap-2 mt-2">
                      <button
                        disabled={busy}
                        onClick={() => run(() => removeMember(m.userId), `${memberName(m.email, false, m.name)} was removed.`, true)}
                        className="btn-secondary text-xs py-2 px-3 text-clay-700"
                      >
                        Remove
                      </button>
                      <button disabled={busy} onClick={() => setConfirming(null)} className="btn-ghost text-xs">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {asks && <div className="mb-6">{asks}</div>}
      {tellUs && <div className="mb-6">{tellUs}</div>}
      {me.household && <HouseholdFacts facts={facts} timezone={me.household.timezone} items={items} onChanged={onChanged} showToast={showToast} />}

      {/* What the household said it no longer buys, with the way back. The
          only other place these appear is nowhere: they are out of the stock
          list and out of "not bought lately", which is the point. */}
      {retired.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide mb-3">Not bought any more ({retired.length})</h2>
          <div className="card divide-y divide-sand-100">
            {retired.map((r) => (
              <div key={r.item} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 min-w-0 text-sm text-ink-700 truncate first-letter:uppercase">{r.item}</span>
                <button onClick={() => onUnretire(r.item)} className="text-xs font-medium text-sage-700 hover:underline shrink-0">
                  Track again
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {(owner || invites.length > 0) && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide mb-3">Invite someone</h2>
          {owner && (
            <div className="card p-4">
              <p className="text-xs text-ink-500 mb-3">
                They sign in with Google using this email, then connect their own grocery apps with their own phone.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email.trim()) invite();
                }}
                className="flex gap-2"
              >
                <label className="sr-only" htmlFor="invite-email">
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="name@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-sand-200 bg-surface text-sm focus:outline-none focus:border-sage-400"
                />
                <button type="submit" disabled={sending || !email.trim()} className="btn-primary text-sm py-2.5 px-4">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <Mail className="w-4 h-4" />}
                  Invite
                </button>
              </form>
              {message && <p className="text-xs text-clay-600 mt-2">{message}</p>}
            </div>
          )}
          {invites.length > 0 && (
            <ul className="mt-3 space-y-2">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-1">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink-700 truncate">{i.email}</p>
                    <p className="text-2xs text-ink-400">
                      Invited {dayLabel(i.createdAt)} · open until {dayLabel(i.expiresAt)}
                    </p>
                  </div>
                  {owner && (
                    <button disabled={busy} onClick={() => run(() => cancelInvite(i.id), 'Invite withdrawn.', false)} className="btn-ghost text-xs">
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!owner && you && (
        <section>
          {confirming === 'leave' ? (
            <div className="card p-4">
              <p className="text-sm text-ink-700">Leave {me.household?.name}? Your grocery apps and orders come with you.</p>
              <div className="flex gap-2 mt-3">
                <button disabled={busy} onClick={() => run(leaveHousehold, 'You left the household.', true)} className="btn-secondary text-xs py-2 px-3 text-clay-700">
                  Leave
                </button>
                <button disabled={busy} onClick={() => setConfirming(null)} className="btn-ghost text-xs">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirming('leave')} className="btn-ghost text-sm">
              <Users className="w-4 h-4" />
              Leave this household
            </button>
          )}
        </section>
      )}
    </div>
  );
}
