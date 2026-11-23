// Sending email through the team's own Gmail account (Gmail API over HTTPS). Free, no domain needed,
// and the mail genuinely comes from Gmail, so it reaches inboxes. The team creates an OAuth client
// in their own Google Cloud project once; an admin then connects the account in Huddle.
import { eq } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { emailAccount } from '../../db/schema';
import { seal, unseal } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import type { Email } from '../../lib/email';

const ACCOUNT_ID = 'gmail';
const TOKEN_PURPOSE = 'huddle:gmail-refresh-token:v1';
/** Send-only access, plus the address of the account (to show it and check who connected). */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Google's endpoints; replaced in tests. */
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;
let googleFetch: GoogleFetch = (url, init) => fetch(url, init);
export function useGoogleFetch(next: GoogleFetch | null) {
  googleFetch = next ?? ((url, init) => fetch(url, init));
}

export const redirectUri = (config: Config) => `${config.appUrl}/api/email/google/callback`;

/** Where the admin is sent to allow Huddle to send as them. */
export function authorizationUrl(config: Config, state: string): string {
  if (!config.gmail) throw new AppError(503, 'gmail_not_configured', 'Gmail is not set up for this server.');
  const params = new URLSearchParams({
    client_id: config.gmail.clientId,
    redirect_uri: redirectUri(config),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    // A refresh token, so Huddle can keep sending without anyone signed in to Google.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await googleFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) return { error: json.error ?? `http_${res.status}` };
  return json;
}

/**
 * Exchanges the code Google returned for a refresh token and the account's address. The ID token
 * comes straight from Google's token endpoint over TLS, so its claims can be read without checking
 * its signature (OpenID Connect Core 3.1.3.7).
 */
export async function exchangeCode(
  config: Config,
  code: string,
): Promise<{ refreshToken: string; address: string; accessToken: string; expiresIn: number }> {
  if (!config.gmail) throw new AppError(503, 'gmail_not_configured', 'Gmail is not set up for this server.');
  const t = await tokenRequest({
    code,
    client_id: config.gmail.clientId,
    client_secret: config.gmail.clientSecret,
    redirect_uri: redirectUri(config),
    grant_type: 'authorization_code',
  });
  if (t.error || !t.refresh_token || !t.access_token || !t.id_token) {
    throw new AppError(400, 'gmail_connect_failed', 'Google didn’t complete the connection. Try again.');
  }
  if (!t.scope?.split(' ').includes(GMAIL_SCOPES[0]!)) {
    throw new AppError(
      400,
      'gmail_scope_missing',
      'Huddle needs permission to send email. Connect again and tick “Send email on your behalf”.',
    );
  }
  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(t.id_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')), (ch) =>
        ch.charCodeAt(0),
      ),
    ),
  ) as { email?: string; email_verified?: boolean };
  if (!claims.email || claims.email_verified === false) {
    throw new AppError(
      400,
      'gmail_connect_failed',
      'Google didn’t share a verified address for that account.',
    );
  }
  return {
    refreshToken: t.refresh_token,
    address: claims.email.toLowerCase(),
    accessToken: t.access_token,
    expiresIn: t.expires_in ?? 3600,
  };
}

export async function saveAccount(
  db: Db,
  config: Config,
  account: { address: string; refreshToken: string; connectedBy: string | null },
) {
  const values = {
    address: account.address,
    refreshToken: await seal(config.authSecret, TOKEN_PURPOSE, account.refreshToken),
    connectedBy: account.connectedBy,
    connectedAt: new Date(),
    needsReconnectAt: null,
  };
  await db
    .insert(emailAccount)
    .values({ id: ACCOUNT_ID, ...values })
    .onConflictDoUpdate({ target: emailAccount.id, set: values });
  accessCache = null;
}

export async function getAccount(db: Db) {
  return (await db.query.emailAccount.findFirst({ where: eq(emailAccount.id, ACCOUNT_ID) })) ?? null;
}

export async function removeAccount(db: Db) {
  await db.delete(emailAccount).where(eq(emailAccount.id, ACCOUNT_ID));
  accessCache = null;
}

// Access tokens last about an hour; reusing one saves a call to Google for every email.
let accessCache: { address: string; token: string; expiresAt: number } | null = null;

async function accessToken(
  db: Db,
  config: Config,
  account: NonNullable<Awaited<ReturnType<typeof getAccount>>>,
) {
  if (accessCache && accessCache.address === account.address && accessCache.expiresAt > Date.now() + 60_000) {
    return accessCache.token;
  }
  if (!config.gmail) throw new AppError(503, 'gmail_not_configured', 'Gmail is not set up for this server.');
  let refreshToken: string;
  try {
    refreshToken = await unseal(config.authSecret, TOKEN_PURPOSE, account.refreshToken);
  } catch {
    await markNeedsReconnect(db);
    throw needsReconnect();
  }
  const t = await tokenRequest({
    client_id: config.gmail.clientId,
    client_secret: config.gmail.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (t.error === 'invalid_grant' || t.error === 'unauthorized_client') {
    // Google no longer accepts it: password changed, access removed, or unused for six months.
    await markNeedsReconnect(db);
    throw needsReconnect();
  }
  if (t.error || !t.access_token) {
    throw new AppError(503, 'email_unavailable', 'Gmail didn’t respond. The email will be tried again.');
  }
  accessCache = {
    address: account.address,
    token: t.access_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
  return t.access_token;
}

const needsReconnect = () =>
  new AppError(
    503,
    'email_disconnected',
    'Email is paused: an admin needs to reconnect Gmail in Admin › Email.',
  );

async function markNeedsReconnect(db: Db) {
  accessCache = null;
  await db.update(emailAccount).set({ needsReconnectAt: new Date() }).where(eq(emailAccount.id, ACCOUNT_ID));
}

/* ------------------------------------------------------------------ the message itself */

const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64url = (text: string) => b64(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** A header value that may contain any characters (RFC 2047), never a line break. */
const headerText = (value: string) => {
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
};
const quotedName = (name: string) => {
  const clean = name.replace(/[\r\n"\\]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : headerText(clean);
};
/** Base64 body lines of at most 76 characters, as MIME requires. */
const wrapped = (text: string) => b64(text).replace(/.{76}/g, '$&\r\n');

/** The raw message (RFC 5322, text and HTML alternatives) that Gmail's API sends. */
export function buildMessage(email: Email, from: { name: string; address: string }): string {
  const to = email.to.replace(/[\r\n<>,;"]/g, '');
  const boundary = `huddle-${crypto.randomUUID()}`;
  const extra = Object.entries(email.headers ?? {})
    .filter(([k]) => /^[A-Za-z][A-Za-z0-9-]*$/.test(k))
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}`);
  return [
    `From: ${quotedName(from.name)} <${from.address}>`,
    `To: ${to}`,
    `Subject: ${headerText(email.subject)}`,
    'MIME-Version: 1.0',
    ...extra,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(email.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(email.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Sends one email from the connected Gmail account. Throws if it couldn't be sent. */
export async function sendWithGmail(
  db: Db,
  config: Config,
  account: NonNullable<Awaited<ReturnType<typeof getAccount>>>,
  email: Email,
): Promise<void> {
  if (account.needsReconnectAt) throw needsReconnect();
  const token = await accessToken(db, config, account);
  const res = await googleFetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw: b64url(buildMessage(email, { name: config.emailName, address: account.address })),
    }),
  });
  if (res.status === 401) {
    accessCache = null; // try a fresh token next time
    throw new AppError(503, 'email_unavailable', 'Gmail didn’t accept the request. It will be tried again.');
  }
  if (res.status === 429) {
    throw new AppError(503, 'email_limit', 'Gmail’s daily sending limit is reached. Email resumes tomorrow.');
  }
  if (!res.ok) {
    console.warn('gmail send failed', res.status);
    throw new AppError(503, 'email_unavailable', 'Gmail didn’t send the email. It will be tried again.');
  }
}
