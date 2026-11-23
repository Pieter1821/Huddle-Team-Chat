import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { encode } from 'uqr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { FormError } from './auth-layout';

type Start = { enrollmentId: string; email: string; secret: string; uri: string };
/** Who is setting up: the owner (setup key), an invitee, a reset link, or yourself (signed in). */
export type StartWith =
  | { email: string; setupKey: string }
  | { inviteToken: string }
  | { resetToken: string }
  | Record<string, never>;

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const codeInput = (v: string) => v.replace(/\D/g, '').slice(0, 6);

/** The QR code an authenticator app scans, drawn as one SVG path (no images, no scripts). */
function QrCode({ text }: { text: string }) {
  const { data, size } = useMemo(() => encode(text, { ecc: 'M', border: 2 }), [text]);
  const d = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join('');
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code to scan with your authenticator app"
      className="mx-auto size-48 rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <path d={d} fill="#151515" />
    </svg>
  );
}

/**
 * Setting up the app: scan the QR code (or type the key), then enter the code it shows. Calls
 * onDone with whether the person is now signed in (they already were, for "yourself").
 */
export function AuthenticatorSetup({
  startWith,
  onDone,
  onBack,
}: {
  startWith: StartWith;
  onDone: (signedIn: boolean) => void;
  /** Shown as "Back" when setup can't start (e.g. a mistyped setup key). */
  onBack?: () => void;
}) {
  const client = useQueryClient();
  const [started, setStarted] = useState<Start | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const began = useRef(false);

  useEffect(() => {
    if (began.current) return; // once, even under StrictMode
    began.current = true;
    api<Start>('/auth/authenticator/start', { json: startWith })
      .then(setStarted)
      .catch((err: unknown) => setError(errorText(err, 'Setup couldn’t start. Reload and try again.')));
  }, [startWith]);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!started) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ signedIn: boolean }>('/auth/authenticator/finish', {
        json: { enrollmentId: started.enrollmentId, code },
      });
      await client.invalidateQueries();
      onDone(res.signedIn);
    } catch (err) {
      setError(errorText(err, 'That didn’t work. Try the newest code.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (!started) {
    if (!error) return <p className="text-sm text-muted">Preparing…</p>;
    return (
      <div className="space-y-3">
        <FormError message={error} />
        {onBack && (
          <Button variant="ghost" className="w-full" onClick={onBack}>
            Back
          </Button>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void confirm(e)} className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-[15px] leading-relaxed">
        <li>
          Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy,
          1Password…) and add an account by scanning this code:
        </li>
      </ol>
      <QrCode text={started.uri} />
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">Can’t scan? Enter this key instead</summary>
        <p className="mt-2 font-mono text-[15px] tracking-wider break-all text-ink select-all">
          {started.secret.replace(/(.{4})/g, '$1 ').trim()}
        </p>
        <p className="mt-1">Account: {started.email} · Type: time based</p>
      </details>
      <ol start={2} className="list-decimal space-y-2 pl-5 text-[15px] leading-relaxed">
        <li>Enter the 6-digit code the app now shows for Huddle:</li>
      </ol>
      <div className="space-y-2">
        <Label htmlFor="totp-setup-code" className="sr-only">
          6-digit code
        </Label>
        <Input
          id="totp-setup-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(codeInput(e.target.value))}
          placeholder="123456"
          className="text-center font-mono text-lg tracking-[0.3em]"
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Confirm'}
      </Button>
    </form>
  );
}

/** Signing in with your email address and the app's current code. */
export function AuthenticatorSignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/sign-in/authenticator', { json: { email: email.trim(), code } });
      await client.invalidateQueries();
      onSignedIn();
    } catch (err) {
      setError(errorText(err, 'That didn’t work. Try again.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="totp-email">Work email</Label>
        <Input
          id="totp-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="totp-code">Code from your authenticator app</Label>
        <Input
          id="totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(codeInput(e.target.value))}
          placeholder="123456"
          className="font-mono tracking-[0.2em]"
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="w-full" disabled={busy || !email.trim() || code.length !== 6}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-sm text-meta">Lost your phone? Ask an admin for a reset link.</p>
    </form>
  );
}

/**
 * The owner's first sign-in (or recovery): the admin email and the setup key, which is the
 * BETTER_AUTH_SECRET entered when Huddle was deployed. Only whoever deployed Huddle has it.
 */
export function OwnerSetup({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [go, setGo] = useState<StartWith | null>(null);

  if (go) return <AuthenticatorSetup startWith={go} onDone={() => onSignedIn()} onBack={() => setGo(null)} />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setGo({ email: email.trim(), setupKey: setupKey.trim() });
      }}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="owner-email">Your email</Label>
        <Input
          id="owner-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="The ADMIN_EMAIL you deployed with"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-key">Setup key</Label>
        <Input
          id="setup-key"
          type="password"
          autoComplete="off"
          value={setupKey}
          onChange={(e) => setSetupKey(e.target.value)}
          placeholder="Your BETTER_AUTH_SECRET"
        />
        <p className="text-xs text-meta">
          The BETTER_AUTH_SECRET you entered when deploying. It proves you’re the one who set Huddle up.
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={!email.trim() || setupKey.trim().length < 32}>
        Continue
      </Button>
    </form>
  );
}
