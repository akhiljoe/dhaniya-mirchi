import { useState, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import type { SourceId } from '../../types';
import { SOURCES } from '../../data';

interface AuthProps {
  sourceId: SourceId;
  onComplete: () => void;
  onSkip: () => void;
  onBack: () => void;
  // The number used for the previous app in this setup, pre-filled.
  initialPhone?: string;
  onPhoneUsed?: (phone: string) => void;
}

type AuthStep = 'phone' | 'otp' | 'connecting';

export function Auth({ sourceId, onComplete, onSkip, onBack, initialPhone = '', onPhoneUsed }: AuthProps) {
  const source = SOURCES.find((s) => s.id === sourceId)!;
  const [step, setStep] = useState<AuthStep>('phone');
  const [phone, setPhone] = useState(initialPhone);
  const [otp, setOtp] = useState(['', '', '', '']);
  const [connectingProgress, setConnectingProgress] = useState(0);

  // Simulate connecting
  useEffect(() => {
    if (step !== 'connecting') return;
    const interval = setInterval(() => {
      setConnectingProgress((p) => {
        if (p >= 100) {
          clearInterval(interval);
          setTimeout(onComplete, 400);
          return 100;
        }
        return p + 4;
      });
    }, 60);
    return () => clearInterval(interval);
  }, [step, onComplete]);

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const next = [...otp];
    next[index] = value;
    setOtp(next);
    if (value && index < 3) {
      const nextInput = document.getElementById(`otp-${index + 1}`);
      nextInput?.focus();
    }
  };

  const otpComplete = otp.every((d) => d !== '');

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 max-w-md mx-auto w-full">
        <button
          onClick={step === 'phone' ? onBack : () => setStep('phone')}
          className="btn-ghost"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 max-w-md mx-auto w-full pb-12">
        {/* Retailer context banner */}
        <div className="w-full flex items-center gap-3 p-3 rounded-xl bg-surface border border-sand-200 mb-8">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
            style={{ backgroundColor: `${source.color}15` }}
          >
            {source.icon}
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-ink-700">
              Connecting to {source.name}
            </div>
          </div>
        </div>

        {step === 'phone' && (
          <div className="w-full animate-fade-in-up">
            <h2 className="font-display text-2xl text-ink-900 mb-2">
              Verify your {source.name} account
            </h2>
            <p className="text-ink-400 text-sm mb-8 leading-relaxed">
              Enter the mobile number linked to your {source.name} account.
              We'll send a verification code to confirm it's you.
            </p>

            <div className="relative mb-4">
              <div className="flex items-center gap-2">
                <div className="px-4 py-3 rounded-xl bg-sand-100 border border-sand-200 text-ink-500 font-medium text-sm">
                  +91
                </div>
                <input
                  type="tel"
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
            <button
              onClick={() => {
                onPhoneUsed?.(phone);
                setStep('otp');
              }}
              disabled={phone.length < 10}
              className="btn-primary w-full"
            >
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
            <h2 className="font-display text-2xl text-ink-900 mb-2">
              Enter the code
            </h2>
            <p className="text-ink-400 text-sm mb-8 leading-relaxed">
              We sent a 4-digit code to <span className="font-medium text-ink-600">+91 {phone}</span>.
              For this demo, just enter any digits.
            </p>

            <div className="flex gap-3 mb-8 justify-center">
              {otp.map((digit, i) => (
                <input
                  key={i}
                  id={`otp-${i}`}
                  type="tel"
                  value={digit}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  maxLength={1}
                  className="w-14 h-16 text-center text-2xl font-bold rounded-xl bg-sand-50 border-2 border-sand-200 text-ink-800 focus:outline-none focus:border-accent-400 focus:bg-surface focus:ring-4 focus:ring-accent-100 transition-all"
                  autoFocus={i === 0}
                />
              ))}
            </div>

            <button
              onClick={() => setStep('connecting')}
              disabled={!otpComplete}
              className="btn-primary w-full"
            >
              Verify & connect
            </button>

            <button
              onClick={() => setStep('phone')}
              className="btn-ghost w-full mt-2"
            >
              Change number
            </button>
          </div>
        )}

        {step === 'connecting' && (
          <div className="w-full text-center animate-fade-in">
            <div className="relative inline-flex items-center justify-center mb-6">
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-3xl"
                style={{ backgroundColor: `${source.color}15` }}
              >
                {source.icon}
              </div>
              <Loader2 className="absolute -bottom-1 -right-1 w-7 h-7 text-ink-600 bg-sand-50 rounded-full p-1 animate-spin-slow" />
            </div>

            <h2 className="font-display text-2xl text-ink-900 mb-2">
              Connecting to {source.name}…
            </h2>
            <p className="text-ink-400 text-sm mb-8">
              Securely linking your account
            </p>

            {/* Progress bar */}
            <div className="w-full h-2 rounded-full bg-sand-200 overflow-hidden mb-3">
              <div
                className="h-full rounded-full bg-sage-500 transition-all duration-100 ease-out"
                style={{ width: `${connectingProgress}%` }}
              />
            </div>
            <p className="text-xs text-ink-400">{connectingProgress}%</p>

          </div>
        )}
      </div>
    </div>
  );
}
