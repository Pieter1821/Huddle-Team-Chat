import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Copy, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Card, SaveNote } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { GMAIL_RESULTS } from '@/lib/gmail-results';

type EmailInfo = {
  account: { address: string; connectedAt: string; needsReconnect: boolean } | null;
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
  const [copied, setCopied] = useState(false);
  const info = useQuery({ queryKey: ['admin', 'email'], queryFn: () => api<EmailInfo>('/admin/email') });
  // The result is shown once; the address bar goes back to plain /admin/email.
  useEffect(() => {
    if (result) setParams({}, { replace: true });
  }, [result, setParams]);

  if (!info.data) return <Card title="Email">{null}</Card>;
  const { account, canConnect, redirectUri, local } = info.data;

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
          {account?.needsReconnect && (
            <p role="alert" className="rounded-lg bg-attention/10 px-4 py-3 text-sm text-ink">
              Gmail stopped accepting Huddle, usually after a password change or when access was removed in
              the Google account. <strong>No sign-in codes can be sent</strong> until you reconnect it.
            </p>
          )}
          {account ? (
            <p className="text-[15px]">
              Sending from <strong>{account.address}</strong>
              <span className="text-muted"> · connected {date.format(new Date(account.connectedAt))}</span>
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
        </div>
      </Card>

      <Card
        title={canConnect ? 'How Gmail sending is set up' : 'Set up Gmail sending'}
        description={
          canConnect
            ? 'For reference: this is already done for this server.'
            : 'Once, about 10 minutes, in your own free Google Cloud project. Nothing is shared with anyone else.'
        }
      >
        <details open={!canConnect} className="group">
          <summary className="cursor-pointer text-sm font-medium text-action">Show the steps</summary>
          <ol className="mt-4 list-decimal space-y-3 pl-5 text-[15px] leading-relaxed">
            <li>
              Go to <span className="font-medium">console.cloud.google.com</span>, sign in with the Gmail
              account that should send the email, and create a project (any name, e.g. “Huddle”).
            </li>
            <li>
              In <span className="font-medium">APIs &amp; Services › Library</span>, find{' '}
              <span className="font-medium">Gmail API</span> and enable it.
            </li>
            <li>
              In <span className="font-medium">OAuth consent screen</span>, choose External, fill in the app
              name and your email, then <span className="font-medium">publish the app</span> (status “In
              production”). Left in testing, Google stops the connection after 7 days.
            </li>
            <li>
              In <span className="font-medium">Credentials</span>, create an{' '}
              <span className="font-medium">OAuth client ID</span> of type Web application, with this
              authorised redirect URI:
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-ground px-2 py-1 text-sm break-all edge">{redirectUri}</code>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => void navigator.clipboard.writeText(redirectUri).then(() => setCopied(true))}
                >
                  <Copy aria-hidden />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </span>
            </li>
            <li>
              Add the client ID and secret to Huddle’s settings as{' '}
              <code className="text-sm">GMAIL_CLIENT_ID</code> and{' '}
              <code className="text-sm">GMAIL_CLIENT_SECRET</code> (on Cloudflare:{' '}
              <code className="text-sm">npx wrangler secret put GMAIL_CLIENT_ID</code>, then the same for the
              secret).
            </li>
            <li>
              Come back and choose <span className="font-medium">Connect Gmail</span>. Google says it hasn’t
              verified the app: that’s expected, because it’s your own. Choose Advanced, then continue, and
              allow Huddle to send email.
            </li>
          </ol>
        </details>
      </Card>
    </>
  );
}
