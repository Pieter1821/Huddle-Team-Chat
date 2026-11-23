import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Mail } from 'lucide-react';
import { AppPasswordSteps, GmailSetupSteps } from '@/components/gmail-setup-steps';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Card, SaveNote } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { GMAIL_RESULTS } from '@/lib/gmail-results';

type EmailInfo = {
  account: { address: string; connectedAt: string; needsReconnect: boolean } | null;
  appPassword: { address: string } | null;
  canConnect: boolean;
  redirectUri: string;
  local: boolean;
};
type Note = { ok: boolean; text: string } | null;

const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** Admin › Email: the Gmail account Huddle sends sign-in codes, invitations and summaries from. */
export function EmailTab() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const result = params.get('gmail');
  const [note, setNote] = useState<Note>(result ? (GMAIL_RESULTS[result] ?? null) : null);
  const info = useQuery({ queryKey: ['admin', 'email'], queryFn: () => api<EmailInfo>('/admin/email') });
  // The result is shown once; the address bar goes back to plain /admin/email.
  useEffect(() => {
    if (result) setParams({}, { replace: true });
  }, [result, setParams]);

  if (!info.data) return <Card title="Email">{null}</Card>;
  const { account, appPassword, canConnect, redirectUri, local } = info.data;

  const connect = (
    <Button asChild variant={account && !account.needsReconnect ? 'ghost' : 'primary'}>
      {/* A full page visit: Google's consent screen, then back here. */}
      <a href="/api/email/google/start">
        <Mail aria-hidden />
        {account?.needsReconnect ? 'Reconnect Gmail' : account ? 'Use a different Gmail' : 'Connect Gmail'}
      </a>
    </Button>
  );

  async function sendTest() {
    setNote(null);
    try {
      const { sentTo } = await api<{ sentTo: string }>('/admin/email/test', { json: {} });
      setNote({ ok: true, text: `Sent to ${sentTo}. Check your inbox.` });
    } catch (err) {
      setNote({
        ok: false,
        text: err instanceof ApiError ? err.message : 'The test didn’t send. Try again.',
      });
    }
  }

  return (
    <>
      <Card
        title="Email"
        description="Huddle sends sign-in codes, invitations and email summaries through your team’s own Gmail account: free, about 500 emails a day, no domain needed."
      >
        <div className="space-y-4">
          {appPassword ? (
            <>
              <p className="text-[15px]">
                Sending from <strong>{appPassword.address}</strong>
                <span className="text-muted"> · with an app password</span>
              </p>
              <p className="text-sm text-meta">
                To change it, update <code>GMAIL_ADDRESS</code> and <code>GMAIL_APP_PASSWORD</code> in
                Cloudflare (Settings › Variables and Secrets).
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" onClick={() => void sendTest()}>
                  Send me a test email
                </Button>
                {note && <SaveNote state={note} />}
              </div>
            </>
          ) : (
            <>
              {account?.needsReconnect && (
                <p role="alert" className="rounded-lg bg-attention/10 px-4 py-3 text-sm text-ink">
                  Gmail stopped accepting Huddle, usually after a password change or when access was removed
                  in the Google account. <strong>No sign-in codes can be sent</strong> until you reconnect it.
                </p>
              )}
              {account ? (
                <p className="text-[15px]">
                  Sending from <strong>{account.address}</strong>
                  <span className="text-muted">
                    {' '}
                    · connected {date.format(new Date(account.connectedAt))}
                  </span>
                </p>
              ) : (
                <p className="text-[15px] text-muted">
                  {local
                    ? 'Not connected. On this computer, emails are printed in the terminal instead of sent.'
                    : 'Not connected. Until Gmail is connected, nobody can receive a sign-in code.'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {canConnect && connect}
                {account && !account.needsReconnect && (
                  <Button variant="ghost" onClick={() => void sendTest()}>
                    Send me a test email
                  </Button>
                )}
                {account && (
                  <ConfirmButton
                    title="Disconnect Gmail?"
                    description="Huddle stops sending email. Nobody will receive sign-in codes until Gmail is connected again."
                    confirmLabel="Disconnect"
                    onConfirm={async () => {
                      await api('/admin/email/disconnect', { json: {} });
                      setNote({ ok: true, text: 'Gmail is disconnected.' });
                      await client.invalidateQueries({ queryKey: ['admin', 'email'] });
                    }}
                  >
                    Disconnect
                  </ConfirmButton>
                )}
                {note && <SaveNote state={note} />}
              </div>
            </>
          )}
        </div>
      </Card>

      {!appPassword && (
        <Card
          title="Set up Gmail sending"
          description="Once, about 5 minutes: an app password for the Gmail account. Nothing is shared with anyone else."
        >
          <AppPasswordSteps />
          <details open={canConnect} className="mt-5">
            <summary className="cursor-pointer text-sm font-medium text-action">
              {canConnect
                ? 'How the Google Cloud connection is set up'
                : 'Or use a Google Cloud project instead'}
            </summary>
            <GmailSetupSteps redirectUri={redirectUri} />
          </details>
        </Card>
      )}
    </>
  );
}
