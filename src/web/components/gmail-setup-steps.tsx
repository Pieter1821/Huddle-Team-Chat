// How to give Huddle a Gmail account to send email from (optional: sign-in works without it).

/**
 * An app password for a Gmail account, pasted into Cloudflare. No Google Cloud project needed.
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
      <li>Wait a minute and reload.</li>
    </ol>
  );
}
