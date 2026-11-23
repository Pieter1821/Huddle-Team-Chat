import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { sendEmail } from '../src/worker/lib/email';
import { buildMessage, saveAccount, useGoogleFetch } from '../src/worker/modules/email/gmail';
import { addMember, api, OWNER_EMAIL, resetDb, setupWorkspace } from './helpers';

const db = getDb(env);
const config = getConfig(env);

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (ch) => ch.charCodeAt(0)),
  );
const idToken = (email: string) =>
  `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ email, email_verified: true }))}.sig`;

/** Stands in for Google: the token endpoint and Gmail's send endpoint. */
function fakeGoogle(opts: { account?: string; refresh?: 'ok' | 'invalid_grant'; scope?: string } = {}) {
  const calls: { url: string; body: string }[] = [];
  const sent: string[] = [];
  useGoogleFetch((url, init) => Promise.resolve(answer(url, typeof init.body === 'string' ? init.body : '')));
  function answer(url: string, body: string): Response {
    calls.push({ url, body });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-secret-1',
          expires_in: 3600,
          scope: opts.scope ?? 'https://www.googleapis.com/auth/gmail.send openid email',
          id_token: idToken(opts.account ?? OWNER_EMAIL),
        });
      }
      if (opts.refresh === 'invalid_grant') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'access-2', expires_in: 3600 });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      sent.push(fromB64url((JSON.parse(body) as { raw: string }).raw));
      return Response.json({ id: 'm1' });
    }
    return new Response('unexpected', { status: 500 });
  }
  return { calls, sent, tokenCalls: () => calls.filter((c) => c.url.includes('oauth2')).length };
}

/** Starts the connection like a browser would and returns the callback, with the state cookie. */
async function connect(cookie = '', state?: string) {
  const start = await api('/api/email/google/start', { cookie });
  if (start.status !== 302) return { start, callback: null };
  const location = new URL(start.res.headers.get('location')!);
  const stateCookie = start.res.headers.getSetCookie().find((c) => c.startsWith('huddle_gmail_state='))!;
  const both = [cookie, stateCookie.split(';')[0]].filter(Boolean).join('; ');
  const callback = await api(
    `/api/email/google/callback?code=abc&state=${state ?? location.searchParams.get('state')}`,
    { cookie: both },
  );
  return { start, location, callback };
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => useGoogleFetch(null));

describe('the email message', () => {
  it('is a proper text and HTML email, safe from header injection', () => {
    const raw = buildMessage(
      {
        to: 'jaco@example.com',
        subject: 'Your code\r\nBcc: attacker@evil.test — 123456 ✓',
        text: 'Code: 123456',
        html: '<p>Code: <b>123456</b></p>',
        headers: { 'List-Unsubscribe': '<https://x.test/u>', 'Bad Header': 'x' },
      },
      { name: 'Acme "Huddle"', address: 'team@gmail.com' },
    );
    const headers = raw.split('\r\n\r\n')[0]!;
    expect(headers).toContain('From: "Acme  Huddle" <team@gmail.com>');
    expect(headers).toContain('To: jaco@example.com');
    expect(headers).not.toMatch(/^Bcc:/m); // the line break in the subject was neutralised
    expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(headers).toContain('List-Unsubscribe: <https://x.test/u>');
    expect(headers).not.toContain('Bad Header');
    const parts = raw.split(/--huddle-[^\r\n]+/);
    const text = parts[1]!.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(fromB64url(text.replaceAll('+', '-').replaceAll('/', '_'))).toBe('Code: 123456');
  });
});

describe('connecting Gmail on a brand-new install', () => {
  it('says sign-in needs Gmail, and lets anyone start connecting', async () => {
    const status = await api('/api/email/status');
    expect(status.json).toEqual({ ready: true, gmail: 'not-connected', canConnect: true, needsSetup: true });
    // (ready is true only because tests run as "this machine", where codes are printed.)
    const { location } = await connect();
    expect(location!.origin + location!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location!.searchParams.get('client_id')).toBe('test-gmail-client.apps.googleusercontent.com');
    expect(location!.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(location!.searchParams.get('access_type')).toBe('offline');
    expect(location!.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/api/email/google/callback',
    );
  });

  it('accepts only the configured admin’s Google account', async () => {
    fakeGoogle({ account: 'stranger@gmail.com' });
    const { callback } = await connect();
    expect(callback!.res.headers.get('location')).toBe('/signin?gmail=wrong-account');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM email_account').first<{ n: number }>())?.n).toBe(
      0,
    );

    fakeGoogle({ account: OWNER_EMAIL });
    const ok = await connect();
    expect(ok.callback!.res.headers.get('location')).toBe('/signin?gmail=connected');
    const row = await env.DB.prepare('SELECT address, refresh_token AS t FROM email_account').first<{
      address: string;
      t: string;
    }>();
    expect(row?.address).toBe(OWNER_EMAIL);
    expect(row?.t).not.toContain('refresh-secret-1'); // stored sealed
  });

  it('refuses a callback that this browser didn’t start, or without send permission', async () => {
    fakeGoogle();
    expect((await connect('', 'forged-state')).callback!.res.headers.get('location')).toBe(
      '/signin?gmail=expired',
    );
    fakeGoogle({ scope: 'openid email' });
    expect((await connect()).callback!.res.headers.get('location')).toBe('/signin?gmail=scope');
  });

  it('then sends the owner’s sign-in code from Gmail', async () => {
    const google = fakeGoogle();
    await connect();
    const res = await api('/api/auth/email-otp/send-verification-otp', {
      body: { email: OWNER_EMAIL, type: 'sign-in' },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(google.sent).toHaveLength(1));
    expect(google.sent[0]).toContain(`From: "Huddle" <${OWNER_EMAIL}>`);
    expect(google.sent[0]).toContain(`To: ${OWNER_EMAIL}`);
    expect(google.sent[0]).toMatch(/Subject: \d{6} is your/);
  });
});

describe('after setup', () => {
  it('only owners and admins can connect, change or disconnect while email works', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    fakeGoogle({ account: 'team.mailbox@gmail.com' });
    expect((await api('/api/admin/email', { cookie: member.cookie })).status).toBe(403);

    // An owner may connect a different mailbox (e.g. a shared team Gmail).
    const { callback } = await connect(owner.cookie);
    expect(callback!.res.headers.get('location')).toBe('/admin/email?gmail=connected');
    const info = await api('/api/admin/email', { cookie: owner.cookie });
    expect(info.json.account).toMatchObject({ address: 'team.mailbox@gmail.com', needsReconnect: false });

    // Now that email works, nobody else may change it.
    expect((await api('/api/email/google/start', { cookie: member.cookie })).status).toBe(403);
    expect((await api('/api/email/google/start')).status).toBe(403);

    const log = await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'email.%'").all();
    expect(log.results.map((r) => r.action)).toEqual(['email.connected']);
    expect((await api('/api/admin/email/disconnect', { body: {}, cookie: owner.cookie })).status).toBe(204);
    expect((await api('/api/admin/email', { cookie: owner.cookie })).json.account).toBeNull();
  });

  it('when Google withdraws access, the same mailbox can be reconnected while signed out', async () => {
    const owner = await setupWorkspace();
    fakeGoogle({ account: 'team.mailbox@gmail.com' });
    await connect(owner.cookie);
    await env.DB.prepare('UPDATE email_account SET needs_reconnect_at = 1').run();

    // Nobody can get a sign-in code now, so reconnecting works signed out, but not with a stranger's Gmail.
    fakeGoogle({ account: 'stranger@gmail.com' });
    expect((await connect()).callback!.res.headers.get('location')).toBe('/signin?gmail=wrong-account');
    fakeGoogle({ account: 'team.mailbox@gmail.com' });
    expect((await connect()).callback!.res.headers.get('location')).toBe('/signin?gmail=connected');
    expect((await api('/api/email/status')).json.gmail).toBe('connected');
  });

  it('a test email goes to the admin who asked, from the connected account', async () => {
    const owner = await setupWorkspace();
    const google = fakeGoogle({ account: 'team.mailbox@gmail.com' });
    await connect(owner.cookie);
    const res = await api('/api/admin/email/test', { body: {}, cookie: owner.cookie });
    expect(res.json).toEqual({ sentTo: OWNER_EMAIL });
    expect(google.sent.at(-1)).toContain('From: "Huddle" <team.mailbox@gmail.com>');
  });
});

describe('sending', () => {
  it('reuses the access token instead of asking Google every time', async () => {
    const google = fakeGoogle();
    await connect();
    const before = google.tokenCalls();
    for (let i = 0; i < 3; i++) {
      await sendEmail(config, { to: `p${i}@example.com`, subject: 's', text: 't', html: 'h' }, { db });
    }
    expect(google.sent).toHaveLength(3);
    expect(google.tokenCalls() - before).toBeLessThanOrEqual(1);
  });

  it('pauses and asks admins to reconnect when Google withdraws access', async () => {
    fakeGoogle();
    await connect();
    fakeGoogle({ refresh: 'invalid_grant' });
    // Saving the account again drops the cached access token, so the next send must refresh.
    await saveAccount(db, config, {
      address: OWNER_EMAIL,
      refreshToken: 'refresh-secret-1',
      connectedBy: null,
    });
    await expect(
      sendEmail(config, { to: 'a@example.com', subject: 's', text: 't', html: 'h' }, { db }),
    ).rejects.toMatchObject({ code: 'email_disconnected' });
    expect((await api('/api/email/status')).json.gmail).toBe('needs-reconnect');
    // Today's count isn't spent on an email that never left.
    const usage = await env.DB.prepare('SELECT sent FROM email_usage').first<{ sent: number }>();
    expect(usage?.sent ?? 0).toBe(0);
  });
});
