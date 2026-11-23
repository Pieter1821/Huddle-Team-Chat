import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppPasswordSteps } from '@/components/gmail-setup-steps';
import { Button } from '@/components/ui/button';
import { Card, SaveNote } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';

type EmailInfo = { appPassword: { address: string } | null; local: boolean };
type Note = { ok: boolean; text: string } | null;

/**
 * Admin › Email. Optional: people sign in with an authenticator app. With a Gmail app password,
 * Huddle also emails invitations, sign-in codes and summaries.
 */
export function EmailTab() {
  const [note, setNote] = useState<Note>(null);
  const info = useQuery({ queryKey: ['admin', 'email'], queryFn: () => api<EmailInfo>('/admin/email') });
  if (!info.data) return <Card title="Email">{null}</Card>;
  const { appPassword, local } = info.data;

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
    <Card
      title="Email"
      description="Optional. People sign in with an authenticator app; with email set up, Huddle also sends invitations, sign-in codes and email summaries from a Gmail account (free, about 500 a day)."
    >
      {appPassword ? (
        <div className="space-y-3">
          <p className="text-[15px]">
            Sending from <strong>{appPassword.address}</strong>
            <span className="text-muted"> · with an app password</span>
          </p>
          <p className="text-sm text-meta">
            To change it, update <code>GMAIL_ADDRESS</code> and <code>GMAIL_APP_PASSWORD</code> in Cloudflare
            (Settings › Variables and Secrets).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={() => void sendTest()}>
              Send me a test email
            </Button>
            <SaveNote state={note} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[15px] text-muted">
            {local
              ? 'Not set up. On this computer, emails are printed in the terminal instead of sent.'
              : 'Not set up. Invitations are shared as links, and people sign in with an authenticator app.'}
          </p>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-action">
              Set up email (about 5 minutes)
            </summary>
            <div className="mt-4">
              <AppPasswordSteps />
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}
