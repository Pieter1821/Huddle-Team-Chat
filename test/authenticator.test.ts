import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { codeAt, currentStep, matchStep } from '../src/worker/lib/totp';
import { addMember, api, OWNER_EMAIL, resetDb, setupWorkspace } from './helpers';

const SETUP_KEY = 'test-secret-that-is-long-enough-for-better-auth'; // BETTER_AUTH_SECRET in tests

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Scans the QR code (reads the secret) and confirms it with the app's current code. */
async function enroll(body: Record<string, unknown>, cookie?: string) {
  const start = await api('/api/auth/authenticator/start', { body, ...(cookie ? { cookie } : {}) });
  if (start.status !== 200) return { start, finish: null, secret: '' };
  const secret = start.json.secret as string;
  const finish = await api('/api/auth/authenticator/finish', {
    body: { enrollmentId: start.json.enrollmentId, code: await codeAt(secret, currentStep()) },
    ...(cookie ? { cookie } : {}),
  });
  return { start, finish, secret, cookie: cookieOf(finish.res) };
}

/** A later sign-in: the next step's code (the current one was just used to confirm). */
const signIn = async (email: string, secret: string, step = currentStep() + 1) =>
  api('/api/auth/sign-in/authenticator', { body: { email, code: await codeAt(secret, step) } });

beforeEach(() => resetDb());

describe('the codes', () => {
  it('match the RFC 6238 test value', async () => {
    // Secret "12345678901234567890" in base32; at 59 seconds the 8-digit code is 94287082.
    expect(await codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
  });

  it('accept the current step and one either side, nothing further', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = Date.now();
    const step = currentStep(now);
    expect(await matchStep(secret, await codeAt(secret, step), now)).toBe(step);
    expect(await matchStep(secret, await codeAt(secret, step - 1), now)).toBe(step - 1);
    expect(await matchStep(secret, await codeAt(secret, step - 3), now)).toBeNull();
    expect(await matchStep(secret, 'abcdef', now)).toBeNull();
  });
});

describe('the owner, on a fresh install with no email', () => {
  it('needs the setup key and the admin email', async () => {
    expect(
      (await api('/api/auth/authenticator/start', { body: { email: OWNER_EMAIL, setupKey: 'wrong' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await api('/api/auth/authenticator/start', {
          body: { email: 'someone@else.test', setupKey: SETUP_KEY },
        })
      ).status,
    ).toBe(403);
    // Without any way in, nobody can start a setup.
    expect((await api('/api/auth/authenticator/start', { body: { email: OWNER_EMAIL } })).status).toBe(401);
  });

  it('scans, confirms, is signed in, sets up the workspace, and signs in again later', async () => {
    const { start, finish, secret, cookie } = await enroll({ email: OWNER_EMAIL, setupKey: SETUP_KEY });
    expect(start.json.uri).toMatch(/^otpauth:\/\/totp\/Huddle%3Aowner%40example\.com\?secret=/);
    expect(finish!.status).toBe(200);
    const setup = await api('/api/setup', {
      body: { workspaceName: 'Brightwater Studio', yourName: 'Thandi Nkosi' },
      cookie: cookie!,
    });
    expect(setup.status).toBe(201);
    // The stored secret is sealed, not readable in the database.
    const row = await env.DB.prepare('SELECT secret FROM totp_credential').first<{ secret: string }>();
    expect(row?.secret).not.toContain(secret);

    const again = await signIn(OWNER_EMAIL, secret);
    expect(again.status).toBe(200);
    expect((await api('/api/me', { cookie: cookieOf(again.res) })).json.hasAuthenticator).toBe(true);
  });

  it('a wrong confirmation code is refused and nothing is saved', async () => {
    const start = await api('/api/auth/authenticator/start', {
      body: { email: OWNER_EMAIL, setupKey: SETUP_KEY },
    });
    const finish = await api('/api/auth/authenticator/finish', {
      body: { enrollmentId: start.json.enrollmentId, code: '000000' },
    });
    expect(finish.status).toBe(400);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM totp_credential').first<{ n: number }>())?.n,
    ).toBe(0);
  });
});

describe('signing in', () => {
  async function ownerWithApp() {
    const owner = await setupWorkspace();
    const { secret } = await enroll({}, owner.cookie); // set up from Settings while signed in
    return { owner, secret };
  }

  it('a code works only once', async () => {
    const { secret } = await ownerWithApp();
    const step = currentStep() + 1;
    expect((await signIn(OWNER_EMAIL, secret, step)).status).toBe(200);
    expect((await signIn(OWNER_EMAIL, secret, step)).status).toBe(400);
  });

  it('locks the account for a while after repeated wrong codes', async () => {
    const { secret } = await ownerWithApp();
    for (let i = 0; i < 8; i++) {
      await api('/api/auth/sign-in/authenticator', {
        body: { email: OWNER_EMAIL, code: '111111' },
        ip: `198.51.100.${i + 10}`, // spread over addresses, like a distributed guesser
      });
    }
    const locked = await api('/api/auth/sign-in/authenticator', {
      body: { email: OWNER_EMAIL, code: await codeAt(secret, currentStep() + 1) },
      ip: '198.51.100.99',
    });
    expect(locked.status).toBe(429);
  });

  it('gives the same answer for unknown people and wrong codes', async () => {
    await ownerWithApp();
    const unknown = await api('/api/auth/sign-in/authenticator', {
      body: { email: 'nobody@x.test', code: '123456' },
    });
    const wrong = await api('/api/auth/sign-in/authenticator', {
      body: { email: OWNER_EMAIL, code: '123456' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.message).toBe(wrong.json.message);
  });
});

describe('invitations and lost phones', () => {
  it('an invitation link lets the invitee set up the app and join, without email', async () => {
    const owner = await setupWorkspace();
    const inv = await api('/api/invitations', {
      body: { email: 'jaco@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    const token = (inv.json.link as string).split('/').at(-1)!;
    const { start, finish, cookie } = await enroll({ inviteToken: token });
    expect(start.json.email).toBe('jaco@example.com');
    expect(finish!.status).toBe(200);
    const me = await api('/api/me', { cookie: cookie! });
    expect(me.json.user.email).toBe('jaco@example.com');
    expect(me.json.role).toBe('member');
    // The invitation is used up.
    expect((await api('/api/auth/authenticator/start', { body: { inviteToken: token } })).status).toBe(403);
  });

  it('an admin’s reset link works once; deactivated people still can’t sign in', async () => {
    const owner = await setupWorkspace();
    const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect(
      (
        await api(`/api/members/${jaco.userId}/authenticator-reset`, {
          body: {},
          cookie: jaco.cookie,
        })
      ).status,
    ).toBe(403); // members can't create reset links (even for themselves: Settings does that)
    const reset = await api(`/api/members/${jaco.userId}/authenticator-reset`, {
      body: {},
      cookie: owner.cookie,
    });
    expect(reset.status).toBe(201);
    const token = (reset.json.link as string).split('/').at(-1)!;
    const { finish, secret } = await enroll({ resetToken: token });
    expect(finish!.status).toBe(200);
    expect((await api('/api/auth/authenticator/start', { body: { resetToken: token } })).status).toBe(403);

    await api(`/api/members/${jaco.userId}/deactivate`, { body: {}, cookie: owner.cookie });
    expect((await signIn('jaco@example.com', secret)).status).toBe(403);
  });
});
