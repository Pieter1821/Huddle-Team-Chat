import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The one-time Gmail setup, step by step. Shown in Admin › Email, and on the sign-in page of a fresh
 * install (where nobody can reach the admin area yet, because sign-in needs email).
 */
export function GmailSetupSteps({ redirectUri }: { redirectUri: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ol className="mt-4 list-decimal space-y-3 pl-5 text-[15px] leading-relaxed">
      <li>
        Go to <span className="font-medium">console.cloud.google.com</span>, sign in with the Gmail account
        that should send the email, and create a project (any name, e.g. “Huddle”).
      </li>
      <li>
        In <span className="font-medium">APIs &amp; Services › Library</span>, find{' '}
        <span className="font-medium">Gmail API</span> and enable it.
      </li>
      <li>
        In <span className="font-medium">OAuth consent screen</span>, choose External, fill in the app name
        and your email, then <span className="font-medium">publish the app</span> (status “In production”).
        Left in testing, Google stops the connection after 7 days.
      </li>
      <li>
        In <span className="font-medium">Credentials</span>, create an{' '}
        <span className="font-medium">OAuth client ID</span> of type Web application, with this authorised
        redirect URI:
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
        Add the client ID and secret to Huddle’s settings as <code className="text-sm">GMAIL_CLIENT_ID</code>{' '}
        and <code className="text-sm">GMAIL_CLIENT_SECRET</code> (on Cloudflare:{' '}
        <code className="text-sm">npx wrangler secret put GMAIL_CLIENT_ID</code>, then the same for the
        secret).
      </li>
      <li>
        Come back and choose <span className="font-medium">Connect Gmail</span>. Google says it hasn’t
        verified the app: that’s expected, because it’s your own. Choose Advanced, then continue, and allow
        Huddle to send email.
      </li>
    </ol>
  );
}

/**
 * The simple way: an app password for the Gmail account, pasted into Cloudflare. No Google Cloud
 * project, consent screen or verification.
 */
export function AppPasswordSteps() {
  return (
    <ol className="list-decimal space-y-3 pl-5 text-[15px] leading-relaxed">
      <li>
        Sign in to the Gmail account that should send Huddle’s email. A dedicated one (e.g.{' '}
        <span className="font-medium">acme.huddle@gmail.com</span>) is best.
      </li>
      <li>
        Go to <span className="font-medium">myaccount.google.com › Security</span> and turn on{' '}
        <span className="font-medium">2-Step Verification</span> if it isn’t on yet.
      </li>
      <li>
        Open <span className="font-medium">myaccount.google.com/apppasswords</span>, create one named{' '}
        <span className="font-medium">Huddle</span>, and copy the 16-letter password.
      </li>
      <li>
        In Cloudflare, under{' '}
        <span className="font-medium">
          Workers &amp; Pages › your Worker › Settings › Variables and Secrets
        </span>
        , add two <span className="font-medium">Secrets</span> (Production), then Deploy:
        <span className="mt-2 block text-sm">
          <code>GMAIL_ADDRESS</code> = that Gmail address
          <br />
          <code>GMAIL_APP_PASSWORD</code> = the 16-letter password
        </span>
      </li>
      <li>Wait a minute and reload this page.</li>
    </ol>
  );
}
