import { vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';

export const APP_URL = 'http://localhost:8787';
export const OWNER_EMAIL = 'owner@example.com';

type Options = { method?: string; body?: unknown; cookie?: string; origin?: string | null; ip?: string };

/** Calls the Worker the way the web app would: same-origin JSON with the session cookie. */
export async function api(path: string, opts: Options = {}) {
  const headers = new Headers({ 'cf-connecting-ip': opts.ip ?? '203.0.113.1' });
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.origin !== null && method !== 'GET') headers.set('origin', opts.origin ?? APP_URL);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const res = await exports.default.fetch(`${APP_URL}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { res, status: res.status, json: parseJson(text), text };
}

/** JSON body, or null for empty or non-JSON responses (e.g. the unsubscribe confirmation page). */
function parseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Collects emails "sent" in local mode (printed through console.warn) so tests can read codes. */
export function captureEmails() {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const all = () =>
    spy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[email] to:'))
      .map((s) => ({
        to: /\[email\] to: (.+)/.exec(s)?.[1]?.trim() ?? '',
        subject: /\[email\] subject: (.+)/.exec(s)?.[1]?.trim() ?? '',
        text: s,
      }));
  const lastTo = (email: string) =>
    all()
      .filter((m) => m.to === email)
      .at(-1);
  return {
    all,
    lastTo,
    /**
     * Better Auth sends sign-in emails as a background task after responding (so response time
     * doesn't reveal whether an account exists), so tests wait briefly for the email to arrive.
     */
    async waitFor(email: string, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = lastTo(email);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      return undefined;
    },
    restore: () => spy.mockRestore(),
  };
}

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

export async function requestCode(email: string, ip?: string) {
  return api('/api/auth/email-otp/send-verification-otp', {
    body: { email, type: 'sign-in' },
    ...(ip ? { ip } : {}),
  });
}

/** Signs in with an emailed code and returns the session cookie (or the failed response). */
export async function signIn(email: string) {
  const mail = captureEmails();
  try {
    const sent = await requestCode(email);
    if (sent.status !== 200) throw new Error(`code request failed: ${sent.status}`);
    const code = /\b(\d{6})\b/.exec((await mail.waitFor(email, 500))?.subject ?? '')?.[1];
    if (!code) return { cookie: '', status: 0, emailed: false };
    const res = await api('/api/auth/sign-in/email-otp', { body: { email, otp: code } });
    return { cookie: res.status === 200 ? cookieFrom(res.res) : '', status: res.status, emailed: true };
  } finally {
    mail.restore();
  }
}

export async function setupWorkspace(name = 'Brightwater Studio') {
  const { cookie } = await signIn(OWNER_EMAIL);
  const res = await api('/api/setup', { body: { workspaceName: name, yourName: 'Thandi Nkosi' }, cookie });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { cookie, workspaceId: res.json.workspace.id as string };
}

/** Invites, then signs the invitee in (which accepts the invitation). */
export async function addMember(
  ownerCookie: string,
  email: string,
  role: string,
  conversationIds?: string[],
) {
  const inv = await api('/api/invitations', {
    body: { email, role, ...(conversationIds ? { conversationIds } : {}) },
    cookie: ownerCookie,
  });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.json)}`);
  const { cookie } = await signIn(email);
  const me = await api('/api/me', { cookie });
  return { cookie, userId: me.json.user.id as string, link: inv.json.link as string };
}

/** Empties every table (children first, because D1 enforces foreign keys). */
export async function resetDb() {
  const tables = [
    'push_subscription',
    'push_key',
    'audit_log',
    'daily_counter',
    'import_conversation_map',
    'import_user_map',
    'import_session',
    'email_usage',
    'rate_limit',
    'reaction',
    'message_mention',
    'notification',
    'file',
    'conversation_event',
    'message',
    'webhook',
    'conversation_member',
    'conversation',
    'invitation',
    'workspace_member',
    'workspace',
    'verification',
    'account',
    'session',
    'user_preference',
    'user',
  ];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export async function addChannel(
  workspaceId: string,
  ownerId: string,
  name: string,
  kind: 'public' | 'private',
) {
  const id = `c-${name}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO conversation (id, workspace_id, kind, name, created_by) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, workspaceId, kind, name, ownerId),
    env.DB.prepare('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?, ?)').bind(
      id,
      ownerId,
    ),
  ]);
  return id;
}
