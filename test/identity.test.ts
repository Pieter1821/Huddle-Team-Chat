import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  OWNER_EMAIL,
  addChannel,
  addMember,
  api,
  captureEmails,
  requestCode,
  resetDb,
  setupWorkspace,
  signIn,
} from './helpers';

const auditActions = async () =>
  (await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{ action: string }>()).results.map(
    (r) => r.action,
  );

beforeEach(resetDb);

describe('first-run setup', () => {
  it('reports that setup is needed on a fresh install', async () => {
    expect((await api('/api/setup')).json).toEqual({ needsSetup: true });
  });

  it('lets the configured admin create the workspace, become owner and get #general', async () => {
    const { cookie } = await setupWorkspace('Brightwater Studio');
    const me = await api('/api/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.json.role).toBe('owner');
    expect(me.json.workspace.name).toBe('Brightwater Studio');
    const general = await env.DB.prepare("SELECT kind FROM conversation WHERE name = 'general'").first();
    expect(general).toEqual({ kind: 'public' });
    expect(await auditActions()).toContain('workspace.created');
  });

  it('refuses a second setup', async () => {
    const { cookie } = await setupWorkspace();
    const again = await api('/api/setup', { body: { workspaceName: 'Another', yourName: 'Thandi' }, cookie });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('already_set_up');
  });

  it('allows only one workspace even if setup runs twice at the same moment', async () => {
    const { cookie } = await signIn(OWNER_EMAIL);
    const [a, b] = await Promise.all([
      api('/api/setup', { body: { workspaceName: 'One', yourName: 'Thandi' }, cookie }),
      api('/api/setup', { body: { workspaceName: 'Two', yourName: 'Thandi' }, cookie }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM workspace').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('names', () => {
  it('sets the owner’s name during setup', async () => {
    const { cookie } = await setupWorkspace();
    const me = await api('/api/me', { cookie });
    expect(me.json.user.name).toBe('Thandi Nkosi');
    expect(me.json.needsName).toBe(false);
  });

  it('asks an invitee for a name, then saves it', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect((await api('/api/me', { cookie: member.cookie })).json.needsName).toBe(true);
    expect(
      (await api('/api/me', { method: 'PATCH', body: { name: '  ' }, cookie: member.cookie })).status,
    ).toBe(400);
    const saved = await api('/api/me', {
      method: 'PATCH',
      body: { name: 'Jaco Steyn' },
      cookie: member.cookie,
    });
    expect(saved.status).toBe(200);
    const me = await api('/api/me', { cookie: member.cookie });
    expect(me.json.user.name).toBe('Jaco Steyn');
    expect(me.json.needsName).toBe(false);
  });
});

describe('invite-only sign-in', () => {
  it('sends no code to an uninvited address, but answers the same way', async () => {
    await setupWorkspace();
    const mail = captureEmails();
    const res = await requestCode('stranger@example.com');
    expect(res.status).toBe(200);
    expect(await mail.waitFor('stranger@example.com', 300)).toBeUndefined();
    mail.restore();
  });

  it('an expired invitation cannot be used to join', async () => {
    const owner = await setupWorkspace();
    await api('/api/invitations', {
      body: { email: 'late@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    await env.DB.prepare("UPDATE invitation SET expires_at = 0 WHERE email = 'late@example.com'").run();
    const result = await signIn('late@example.com');
    expect(result.emailed).toBe(false);
    expect(result.cookie).toBe('');
    expect(await auditActions()).not.toContain('invitation.accepted');
  });

  it('a guessed code does not create an account', async () => {
    await setupWorkspace();
    const res = await api('/api/auth/sign-in/email-otp', {
      body: { email: 'stranger@example.com', otp: '123456' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const users = await env.DB.prepare(
      "SELECT count(*) AS n FROM user WHERE email = 'stranger@example.com'",
    ).first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it('accepts an invitation automatically on first sign-in, once only', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    const me = await api('/api/me', { cookie: member.cookie });
    expect(me.json.role).toBe('member');

    const token = member.link.split('/invite/')[1]!;
    expect((await api(`/api/invitations/by-token/${token}`)).status).toBe(404);
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['invitation.created', 'invitation.accepted', 'auth.sign_in']),
    );
  });

  it('shows an invitation landing page from its link, without signing in', async () => {
    const owner = await setupWorkspace('Brightwater Studio');
    const inv = await api('/api/invitations', {
      body: { email: 'aisha@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    const token = (inv.json.link as string).split('/invite/')[1]!;
    const page = await api(`/api/invitations/by-token/${token}`);
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({
      workspaceName: 'Brightwater Studio',
      email: 'aisha@example.com',
      role: 'member',
    });
  });

  it('stores only a hash of the invitation token', async () => {
    const owner = await setupWorkspace();
    const inv = await api('/api/invitations', {
      body: { email: 'kyle@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    const token = (inv.json.link as string).split('/invite/')[1]!;
    const row = await env.DB.prepare('SELECT token_hash FROM invitation').first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a revoked invitation can no longer be used to join', async () => {
    const owner = await setupWorkspace();
    const inv = await api('/api/invitations', {
      body: { email: 'ruan@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    expect(
      (await api(`/api/invitations/${inv.json.invitation.id}`, { method: 'DELETE', cookie: owner.cookie }))
        .status,
    ).toBe(204);
    const result = await signIn('ruan@example.com');
    expect(result.emailed).toBe(false);
    expect(result.cookie).toBe('');
  });
});

describe('roles and invitations', () => {
  it('members cannot invite members, and invite guests only when the workspace allows it', async () => {
    const owner = await setupWorkspace();
    const ws = await api('/api/me', { cookie: owner.cookie });
    const general = await env.DB.prepare("SELECT id FROM conversation WHERE name='general'").first<{
      id: string;
    }>();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');

    const asMember = (body: unknown) => api('/api/invitations', { body, cookie: member.cookie });
    expect((await asMember({ email: 'x@example.com', role: 'member' })).status).toBe(403);
    expect(
      (await asMember({ email: 'g@example.com', role: 'guest', conversationIds: [general!.id] })).status,
    ).toBe(403);

    await api('/api/workspace', {
      method: 'PATCH',
      body: { allowMemberGuestInvites: true },
      cookie: owner.cookie,
    });
    expect(
      (await asMember({ email: 'g@example.com', role: 'guest', conversationIds: [general!.id] })).status,
    ).toBe(201);
    expect(ws.json.workspace.allowMemberGuestInvites).toBe(false);
  });

  it('only the owner can make an admin; nobody changes their own role or makes an owner', async () => {
    const owner = await setupWorkspace();
    const admin = await addMember(owner.cookie, 'aisha@example.com', 'admin');
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    const me = await api('/api/me', { cookie: owner.cookie });

    const patch = (cookie: string, userId: string, role: string) =>
      api(`/api/members/${userId}`, { method: 'PATCH', body: { role }, cookie });

    expect((await patch(admin.cookie, member.userId, 'admin')).status).toBe(403);
    expect((await patch(admin.cookie, admin.userId, 'member')).status).toBe(403);
    expect((await patch(admin.cookie, me.json.user.id, 'member')).status).toBe(403);
    expect((await patch(owner.cookie, member.userId, 'owner')).status).toBe(400);
    expect((await patch(owner.cookie, member.userId, 'admin')).status).toBe(200);
    expect((await patch(member.cookie, admin.userId, 'guest')).status).toBe(403);
  });

  it('a guest must be invited to at least one channel they can be shown', async () => {
    const owner = await setupWorkspace();
    expect(
      (
        await api('/api/invitations', {
          body: { email: 'g@example.com', role: 'guest' },
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('/api/invitations', {
          body: { email: 'g@example.com', role: 'guest', conversationIds: ['c-nope'] },
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(400);
  });

  it('refuses to invite someone who is already a member', async () => {
    const owner = await setupWorkspace();
    await addMember(owner.cookie, 'jaco@example.com', 'member');
    const again = await api('/api/invitations', {
      body: { email: 'jaco@example.com', role: 'member' },
      cookie: owner.cookie,
    });
    expect(again.status).toBe(409);
  });
});

describe('guests', () => {
  it('see only their channels and the people in them, never email addresses', async () => {
    const owner = await setupWorkspace();
    const ownerMe = await api('/api/me', { cookie: owner.cookie });
    const clientChannel = await addChannel(
      owner.workspaceId,
      ownerMe.json.user.id,
      'client-van-wyk',
      'private',
    );
    await addMember(owner.cookie, 'jaco@example.com', 'member'); // not in the guest's channel
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [clientChannel]);

    const members = await api('/api/members', { cookie: guest.cookie });
    const names = members.json.members.map((m: { userId: string }) => m.userId).sort();
    expect(names).toEqual([ownerMe.json.user.id, guest.userId].sort());
    expect(members.json.members.every((m: Record<string, unknown>) => !('email' in m))).toBe(true);
  });

  it('lose access when their guest period ends', async () => {
    const owner = await setupWorkspace();
    const ownerMe = await api('/api/me', { cookie: owner.cookie });
    const channel = await addChannel(owner.workspaceId, ownerMe.json.user.id, 'client-x', 'private');
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [channel]);
    expect((await api('/api/me', { cookie: guest.cookie })).status).toBe(200);

    const past = new Date(Date.now() - 60_000).toISOString();
    await api(`/api/members/${guest.userId}`, {
      method: 'PATCH',
      body: { role: 'guest', guestExpiresAt: past },
      cookie: owner.cookie,
    });
    const after = await api('/api/me', { cookie: guest.cookie });
    expect(after.status).toBe(403);
  });
});

describe('deactivation', () => {
  it('signs the person out everywhere and blocks new sign-ins', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    const res = await api(`/api/members/${member.userId}/deactivate`, { body: {}, cookie: owner.cookie });
    expect(res.status).toBe(200);

    expect((await api('/api/me', { cookie: member.cookie })).status).toBe(401);
    const again = await signIn('jaco@example.com');
    expect(again.cookie).toBe('');
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['member.deactivated', 'auth.session_blocked']),
    );
  });

  it('cannot be used on the owner or by a member', async () => {
    const owner = await setupWorkspace();
    const ownerMe = await api('/api/me', { cookie: owner.cookie });
    const admin = await addMember(owner.cookie, 'aisha@example.com', 'admin');
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect(
      (await api(`/api/members/${ownerMe.json.user.id}/deactivate`, { body: {}, cookie: admin.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await api(`/api/members/${admin.userId}/deactivate`, { body: {}, cookie: member.cookie })).status,
    ).toBe(403);
  });
});

describe('request protections', () => {
  it('rejects state-changing requests from another origin', async () => {
    const owner = await setupWorkspace();
    const evil = await api('/api/workspace', {
      method: 'PATCH',
      body: { name: 'Hacked' },
      cookie: owner.cookie,
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    const missing = await api('/api/workspace', {
      method: 'PATCH',
      body: { name: 'Hacked' },
      cookie: owner.cookie,
      origin: null,
    });
    expect(missing.status).toBe(403);
  });

  it('requires a session for private endpoints', async () => {
    await setupWorkspace();
    for (const path of ['/api/me', '/api/members', '/api/invitations', '/api/admin/audit']) {
      expect((await api(path)).status).toBe(401);
    }
  });

  it('rate-limits sign-in code requests per address', async () => {
    await setupWorkspace();
    const mail = captureEmails();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await requestCode(OWNER_EMAIL, '198.51.100.7')).status);
    mail.restore();
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });

  it('shows the security log to admins only', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect((await api('/api/admin/audit', { cookie: member.cookie })).status).toBe(403);
    const log = await api('/api/admin/audit', { cookie: owner.cookie });
    expect(log.status).toBe(200);
    expect(log.json.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.json)).not.toMatch(/\b\d{6}\b(?!\d)/); // no sign-in codes leak into the log
  });
});
