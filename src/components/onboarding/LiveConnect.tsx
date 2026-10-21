import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, TriangleAlert } from 'lucide-react';

import type { SourceId } from '../../types';
import { SOURCES } from '../../data';
import {
  ApiError,
  cancelConnect,
  chooseCartAddress,
  connectErrorText,
  ensureHousehold,
  fetchConnections,
  getConnectRequest,
  startConnect,
  submitOtp,
  type Connection,
  type ConnectRequest,
} from '@/lib/connect';
import { AddressPicker } from '@/components/AddressPicker';
import { CONNECT_POLL_MS } from '@/lib/constants';

interface LiveConnectProps {
  sourceId: SourceId;
  onComplete: () => void;
  onSkip: () => void;
  onBack: () => void;
  // The number used for the previous app in this setup, pre-filled.
  initialPhone?: string;
  onPhoneUsed?: (phone: string) => void;
}

// The real connect flow (design §7.10): the phone and code go to OUR api,
// which seals them; the grocery app is driven by our server in the
// background. This page only shows progress.
type Step = 'phone' | 'sending' | 'otp' | 'verifying' | 'address' | 'failed';

export function LiveConnect({ sourceId, onComplete, onSkip, onBack, initialPhone = '', onPhoneUsed }: LiveConnectProps) {
  const source = SOURCES.find((s) => s.id === sourceId)!;
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState(initialPhone);
  const [otp, setOtp] = useState('');
  const [request, setRequest] = useState<ConnectRequest | null>(null);
  // The app's own saved addresses, asked for here rather than left for the
  // household to find on the Grocery apps page later: the app keeps a cart per
  // store and the store follows from the address (design §19 stage 1). A
  // friend connected with 65 saved addresses and none chosen.
  const [connection, setConnection] = useState<Connection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // An earlier attempt for this app is still open on the server (a reload, or
  // another tab) — offer to end it rather than leave the user stuck.
  const [stuck, setStuck] = useState(false);
  const polling = useRef<number | null>(null);
  // Bumped on every cancel: an attempt whose start was still in flight when
  // the user cancelled is cancelled on the server as soon as it lands.
  const generation = useRef(0);

  const stopPolling = () => {
    if (polling.current !== null) window.clearInterval(polling.current);
    polling.current = null;
  };
  useEffect(() => stopPolling, []);

  // Follow the attempt until it needs the user again or ends.
  const follow = (id: string) => {
    stopPolling();
    polling.current = window.setInterval(async () => {
      try {
        const r = await getConnectRequest(id);
        setRequest(r);
        if (r.status === 'otp_sent') {
          stopPolling();
          setMessage(r.errorCode === 'otp_invalid' ? connectErrorText('otp_invalid') : null);
          setOtp('');
          setStep('otp');
        } else if (r.status === 'connected') {
          stopPolling();
          // Ask which address the cart belongs to, while the household is
          // still here. No saved addresses, or only one, means nothing to
          // ask: the import carries on either way.
          const mine = (await fetchConnections().catch(() => []))
            .filter((c) => c.vendor === sourceId && (c.addresses?.length ?? 0) > 1 && !c.cartAddress?.chosenByHousehold)
            .pop();
          if (mine) {
            setConnection(mine);
            setStep('address');
          } else {
            onComplete();
          }
        } else if (r.status === 'failed' || r.status === 'expired') {
          stopPolling();
          setMessage(connectErrorText(r.errorCode));
          setStep('failed');
        } else if (r.status === 'cancelled') {
          // Cancelled elsewhere (another tab): back to the number.
          stopPolling();
          setRequest(null);
          setStep('phone');
        }
      } catch {
        // A missed poll is harmless; the next one catches up.
      }
    }, CONNECT_POLL_MS);
  };

  const sendCode = async () => {
    setMessage(null);
    setStuck(false);
    setStep('sending');
    const mine = generation.current;
    try {
      await ensureHousehold();
      const r = await startConnect(sourceId, phone);
      if (generation.current !== mine) {
        await cancelConnect(sourceId); // cancelled while this was starting
        return;
      }
      onPhoneUsed?.(phone);
      setRequest(r);
      follow(r.id);
    } catch (err) {
      if (generation.current !== mine) return;
      if (err instanceof ApiError && err.status === 409) {
        setStuck(true);
        setMessage(`An earlier ${source.name} attempt is still open.`);
      } else {
        setMessage(err instanceof ApiError ? err.message : connectErrorText(null));
      }
      setStep('phone');
    }
  };

  // Ends the open attempt on the server, then sends a code to the number now
  // in the box.
  const cancelAndResend = async () => {
    try {
      await cancelConnect(sourceId);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : connectErrorText(null));
      return;
    }
    await sendCode();
  };

  const verify = async () => {
    if (!request) return;
    setMessage(null);
    setStep('verifying');
    try {
      await submitOtp(request.id, otp);
      follow(request.id);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : connectErrorText(null));
      setStep('otp');
    }
  };

  // Back to the number. An attempt still open on the server is cancelled
  // first, so the worker stops and a new number isn't refused as "already in
  // progress". A code already being checked can't be cancelled — the result
  // is seconds away, so the user stays put.
  const restart = async () => {
    stopPolling();
    generation.current++;
    let failure: string | null = null;
    if (step === 'sending' || (request && step !== 'failed')) {
      try {
        await cancelConnect(sourceId);
      } catch (err) {
        failure = err instanceof ApiError ? err.message : connectErrorText(null);
        if (request) {
          // Still open on the server: keep following it.
          setMessage(failure);
          follow(request.id);
          return;
        }
        // No id yet: the start still in flight cancels itself when it lands.
      }
    }
    setRequest(null);
    setOtp('');
    setMessage(failure);
    setStuck(false);
    setStep('phone');
  };

  const busy = step === 'sending' || step === 'verifying';

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 animate-fade-in">
      <div className="flex items-center justify-between px-6 py-5 max-w-md mx-auto w-full">
        <button onClick={step === 'phone' ? onBack : restart} className="btn-ghost" disabled={step === 'verifying'}>
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-md mx-auto w-full pb-12">
        <div className="w-full flex items-center gap-3 p-3 rounded-xl bg-surface border border-sand-200 mb-8">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ backgroundColor: `${source.color}15` }}>
            {source.icon}
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-ink-700">Connecting to {source.name}</div>
          </div>
        </div>

        {message && (
          <div className="w-full flex items-start gap-3 p-3 rounded-xl bg-clay-50 border border-clay-200 mb-4">
            <TriangleAlert className="w-4 h-4 text-clay-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-ink-600">{message}</p>
              {stuck && step === 'phone' && (
                <button onClick={cancelAndResend} disabled={phone.length < 10} className="mt-2 text-sm font-medium text-clay-600 hover:text-clay-700 underline underline-offset-2 disabled:opacity-50">
                  Cancel it and send a code to this number
                </button>
              )}
            </div>
          </div>
        )}

        {step === 'phone' && (
          <div className="w-full animate-fade-in-up">
            <h2 className="font-display text-2xl text-ink-900 mb-2">Verify your {source.name} account</h2>
            <p className="text-ink-400 text-sm mb-8 leading-relaxed">
              Enter the mobile number you use on {source.name}. {source.name} will text you a login code.
            </p>
            <div className="relative mb-4">
              <div className="flex items-center gap-2">
                <div className="px-4 py-3 rounded-xl bg-sand-100 border border-sand-200 text-ink-500 font-medium text-sm">+91</div>
                <input
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="98765 43210"
                  className="input-field pl-4 flex-1 tracking-wider"
                  autoFocus
                />
              </div>
            </div>
            {initialPhone !== '' && phone === initialPhone && (
              <p className="text-xs text-ink-400 mb-4">
                Same number as your last app. Change it if needed.
              </p>
            )}
            <button onClick={sendCode} disabled={phone.length < 10} className="btn-primary w-full">
              Send verification code
              <ArrowRight className="w-5 h-5" />
            </button>
            <button onClick={onSkip} className="btn-ghost w-full mt-2">
              Skip for now
            </button>
          </div>
        )}

        {step === 'otp' && (
          <div className="w-full animate-fade-in-up">
            <h2 className="font-display text-2xl text-ink-900 mb-2">Enter the code</h2>
            <p className="text-ink-400 text-sm mb-8 leading-relaxed">
              {source.name} sent a code to the number ending{' '}
              <span className="font-medium text-ink-600">{request?.phoneLast4}</span>. It expires in a few minutes.
            </p>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="Code"
              className="input-field w-full text-center text-2xl tracking-[0.5em] mb-6"
              autoFocus
            />
            <button onClick={verify} disabled={otp.length < 4} className="btn-primary w-full">
              Verify & connect
            </button>
            <button onClick={restart} className="btn-ghost w-full mt-2">
              Wrong number? Change it
            </button>
          </div>
        )}

        {busy && (
          <div className="w-full text-center animate-fade-in">
            <div className="relative inline-flex items-center justify-center mb-6">
              <div className="w-20 h-20 rounded-full flex items-center justify-center text-3xl" style={{ backgroundColor: `${source.color}15` }}>
                {source.icon}
              </div>
              <Loader2 className="absolute -bottom-1 -right-1 w-7 h-7 text-ink-600 bg-sand-50 rounded-full p-1 animate-spin-slow" />
            </div>
            <h2 className="font-display text-2xl text-ink-900 mb-2">
              {step === 'sending' ? `Asking ${source.name} to send a code…` : `Connecting to ${source.name}…`}
            </h2>
            <p className="text-ink-400 text-sm">This usually takes a few seconds.</p>
            {step === 'sending' && (
              <button onClick={restart} className="btn-ghost mx-auto mt-4">
                Cancel
              </button>
            )}
          </div>
        )}

        {step === 'address' && connection && (
          <div className="w-full animate-fade-in-up">
            <h2 className="font-display text-2xl text-ink-900 mb-2">Where do your groceries go?</h2>
            <p className="text-ink-400 text-sm mb-6 leading-relaxed">
              {source.name} keeps a separate cart for each address. Pick the one you order to, so anything we add lands in
              the cart you see.
            </p>
            <AddressPicker
              addresses={connection.addresses ?? []}
              chosenId={connection.cartAddress?.id ?? null}
              onChoose={async (addressId) => {
                await chooseCartAddress(connection.id, addressId).catch(() => undefined);
                onComplete();
              }}
            />
            <button onClick={onComplete} className="btn-ghost w-full mt-3">
              Choose later
            </button>
          </div>
        )}

        {step === 'failed' && (
          <div className="w-full animate-fade-in-up">
            <h2 className="font-display text-2xl text-ink-900 mb-6">That didn't connect</h2>
            <button onClick={restart} className="btn-primary w-full">
              Try again
            </button>
            <button onClick={onSkip} className="btn-ghost w-full mt-2">
              Skip for now
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
