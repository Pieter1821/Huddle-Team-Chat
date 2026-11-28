import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { FormError } from './auth-layout';

const RESEND_AFTER_S = 30;

/**
 * Two steps: an email address, then the 6-digit code sent to it. Used on the sign-in page and on
 * invitation links (where the email is fixed). Calls onSignedIn once a session cookie is set.
 */
export function SignInForm({ fixedEmail, onSignedIn }: { fixedEmail?: string; onSignedIn: () => void }) {
  const client = useQueryClient();
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/email-otp/send-verification-otp', { json: { email: email.trim(), type: 'sign-in' } });
      setStep('code');
      setResendIn(RESEND_AFTER_S);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many codes requested. Try again in a while.'
          : 'We couldn’t send a code. Check the address and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/sign-in/email-otp', { json: { email: email.trim(), otp: code.trim() } });
      await client.invalidateQueries();
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? err.message
          : 'That code didn’t work. Check it, or ask for a new one.',
      );
      setCode('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  if (step === 'email') {
    return (
      <form onSubmit={(e) => void sendCode(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus={!fixedEmail}
            required
            value={email}
            readOnly={Boolean(fixedEmail)}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-invalid={Boolean(error)}
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || !email.includes('@')}>
          {busy ? 'Sending…' : 'Email me a sign-in code'}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void verify(e)} className="space-y-4" noValidate>
      <p className="text-[15px] text-muted">
        We sent a 6-digit code to <span className="text-ink">{email}</span>. It works once, for 5 minutes.
      </p>
      {import.meta.env.DEV && (
        <p className="rounded-card bg-raised px-4 py-3 text-[13px] text-muted">
          Local development: the code appears in the terminal running{' '}
          <code className="text-ink">npm run dev</code>.
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor="code">Sign-in code</Label>
        <Input
          id="code"
          ref={codeRef}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="text-center text-xl tracking-[0.4em]"
          aria-invalid={Boolean(error)}
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="flex items-center justify-between text-sm">
        {!fixedEmail ? (
          <button
            type="button"
            className="text-muted underline-offset-4 hover:text-ink hover:underline"
            onClick={() => setStep('email')}
          >
            Use another email
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="text-muted underline-offset-4 hover:text-ink hover:underline disabled:no-underline disabled:opacity-60"
          disabled={resendIn > 0 || busy}
          onClick={() => void sendCode()}
        >
          {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
        </button>
      </div>
    </form>
  );
}
