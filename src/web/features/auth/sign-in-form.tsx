import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { FormError } from './auth-layout';

const RESEND_AFTER_S = 30;

type Provider = 'google' | 'github';
const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', github: 'GitHub' };

/**
 * What Google or GitHub said when it sent the person back here. Only our own wording is ever
 * shown, never text taken from the address bar.
 */
function providerErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'NOT_INVITED' || code === 'unable_to_create_user')
    return 'That account’s email hasn’t been invited to this workspace. Ask an admin to invite it.';
  if (code === 'ACCOUNT_DEACTIVATED' || code === 'unable_to_create_session')
    return 'This account has been deactivated. Ask an admin.';
  if (code === 'email_not_found')
    return 'That account didn’t share a verified email address. Verify one with the provider, or use an emailed code.';
  if (code === 'access_denied') return null; // they chose not to continue
  return 'That sign-in didn’t work. Try again, or use an emailed code.';
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * Two steps: an email address, then the 6-digit code sent to it. Used on the sign-in page and on
 * invitation links (where the email is fixed). Calls onSignedIn once a session cookie is set.
 */
export function SignInForm({
  fixedEmail,
  google = false,
  github = false,
  onSignedIn,
}: {
  fixedEmail?: string;
  /** Offer "Continue with Google" / "Continue with GitHub" (the server has their settings). */
  google?: boolean;
  github?: boolean;
  onSignedIn: () => void;
}) {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const providerError = providerErrorMessage(params.get('error'));
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

  /** Hands over to Google or GitHub, which sends the person back signed in (or with an error code). */
  async function continueWith(provider: Provider) {
    setBusy(true);
    setError(null);
    // Only same-app paths are followed afterwards (never a full URL to another site).
    const next = params.get('next');
    const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : null;
    try {
      const { url } = await api<{ url: string }>('/auth/sign-in/social', {
        json: {
          provider,
          callbackURL: safeNext ?? '/',
          errorCallbackURL:
            window.location.pathname + (safeNext ? `?next=${encodeURIComponent(safeNext)}` : ''),
        },
      });
      window.location.assign(url);
    } catch {
      setError(`We couldn’t start ${PROVIDER_NAME[provider]} sign-in. Try again, or use an emailed code.`);
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
        <FormError message={error ?? (google || github ? providerError : null)} />
        <Button type="submit" className="w-full" disabled={busy || !email.includes('@')}>
          {busy ? 'Sending…' : 'Email me a sign-in code'}
        </Button>
        {(google || github) && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
              <span className="h-px flex-1 bg-rule" />
              or
              <span className="h-px flex-1 bg-rule" />
            </div>
            {google && (
              <Button
                type="button"
                variant="ghost"
                className="w-full gap-2"
                disabled={busy}
                onClick={() => void continueWith('google')}
              >
                <GoogleMark />
                Continue with Google
              </Button>
            )}
            {github && (
              <Button
                type="button"
                variant="ghost"
                className="w-full gap-2"
                disabled={busy}
                onClick={() => void continueWith('github')}
              >
                <GitHubMark />
                Continue with GitHub
              </Button>
            )}
          </>
        )}
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
