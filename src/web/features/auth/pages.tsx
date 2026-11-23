import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { useBranding, useMe, useSignOut } from '@/lib/queries';
import type { InvitationPreview } from '@/lib/types';
import { AuthLayout, FormError } from './auth-layout';
import { SignInForm } from './sign-in-form';

/** /signin: anyone who already has an account or an invitation. */
export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: branding } = useBranding();
  const me = useMe();
  // Only same-app paths are followed after sign-in (never a full URL to another site).
  const next =
    params.get('next')?.startsWith('/') && !params.get('next')?.startsWith('//') ? params.get('next')! : '/';
  if (me.data) return <Navigate to={next} replace />;
  return (
    <AuthLayout
      title={`Sign in to ${branding?.name ?? 'Huddle'}`}
      subtitle="No password: we’ll email you a one-time code."
    >
      <SignInForm onSignedIn={() => void navigate(next, { replace: true })} />
    </AuthLayout>
  );
}

/** First run: the admin names the workspace and themselves. */
export function SetupPage() {
  const client = useQueryClient();
  const [workspaceName, setWorkspaceName] = useState('');
  const [yourName, setYourName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/setup', { json: { workspaceName: workspaceName.trim(), yourName: yourName.trim() } });
      await client.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed. Try again.');
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Set up your workspace"
      subtitle="Two things, and your team’s chat is ready. You can change both later."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="workspace">Workspace name</Label>
          <Input
            id="workspace"
            autoFocus
            maxLength={80}
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="Your company or team"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input
            id="name"
            autoComplete="name"
            maxLength={80}
            value={yourName}
            onChange={(e) => setYourName(e.target.value)}
            placeholder="How your team will see you"
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || !workspaceName.trim() || !yourName.trim()}>
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** /invite/:token: who invited you, then the same code sign-in with your address filled in. */
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const invite = useQuery<InvitationPreview, ApiError>({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitationPreview>(`/invitations/by-token/${encodeURIComponent(token)}`),
    retry: false,
  });

  if (me.data) return <Navigate to="/" replace />;
  if (invite.isPending) return <AuthLayout title="Opening your invitation…">{null}</AuthLayout>;
  if (invite.error || !invite.data) {
    return (
      <AuthLayout
        title="This invitation can’t be used"
        subtitle="It may have expired, been used already, or been withdrawn. Ask the person who invited you for a new link."
      >
        <Button variant="ghost" className="w-full" onClick={() => void navigate('/signin')}>
          I already have an account
        </Button>
      </AuthLayout>
    );
  }
  const { inviterName, workspaceName, email, role } = invite.data;
  return (
    <AuthLayout
      title={`Join ${workspaceName}`}
      subtitle={
        <>
          {inviterName} invited you{role === 'guest' ? ' as a guest' : ''}. Confirm it’s you and you’re in.
        </>
      }
    >
      <SignInForm fixedEmail={email} onSignedIn={() => void navigate('/', { replace: true })} />
    </AuthLayout>
  );
}

/** Asked once of people who signed up with an email code (which carries no name). */
export function NamePrompt() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/me', { method: 'PATCH', json: { name: name.trim() } });
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t save. Try again.');
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="What should people call you?"
      subtitle="This is how your name appears next to your messages."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="display-name">Your name</Label>
          <Input
            id="display-name"
            autoFocus
            autoComplete="name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Signed in, but this account has no place in the workspace (e.g. a removed member). */
export function NotAMember({ message }: { message: string }) {
  const signOut = useSignOut();
  const navigate = useNavigate();
  return (
    <AuthLayout title="You can’t open this workspace" subtitle={message}>
      <Button
        variant="ghost"
        className="w-full"
        onClick={() =>
          signOut.mutate(undefined, { onSettled: () => void navigate('/signin', { replace: true }) })
        }
      >
        Sign out
      </Button>
    </AuthLayout>
  );
}
