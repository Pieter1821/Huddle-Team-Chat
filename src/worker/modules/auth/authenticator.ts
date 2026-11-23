// Signing in with an authenticator app, as a Better Auth plugin so it creates exactly the same
// sessions (and runs the same checks: invite-only joining, deactivated accounts refused) as
// signing in with an email code.
//
// Who may set up an authenticator:
// - the owner, with the setup key (the server's BETTER_AUTH_SECRET, which only whoever deployed
//   Huddle has) and the configured admin email. This also recovers an owner who lost their phone;
// - an invited person, through their invitation link;
// - someone an admin gave a reset link to (lost phone);
// - anyone already signed in, for their own account (Settings).
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { invitation, totpCredential, totpEnrollment, totpResetLink } from '../../db/schema';
import { seal, sha256Hex, unseal } from '../../lib/crypto';
import { newId } from '../../lib/id';
import { matchStep, newSecret, otpauthUri } from '../../lib/totp';
import { acceptInvitation } from '../invitations/service';

const SECRET_PURPOSE = 'huddle:totp-secret:v1';
const ENROLL_MINUTES = 15;
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

const sameText = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

const forbidden = (message: string) => new APIError('FORBIDDEN', { message });
const badCode = () => new APIError('BAD_REQUEST', { message: 'That email and code don’t match.' });

async function pendingInvitation(db: Db, where: ReturnType<typeof eq>) {
  return db.query.invitation.findFirst({
    where: and(
      where,
      isNull(invitation.acceptedAt),
      isNull(invitation.revokedAt),
      gt(invitation.expiresAt, new Date()),
    ),
  });
}

export function authenticator(config: Config, db: Db) {
  const saveCredential = async (userId: string, secret: string, step: number) => {
    const values = {
      secret: await seal(config.authSecret, SECRET_PURPOSE, secret),
      lastStep: step,
      failedCount: 0,
      lockedUntil: null,
    };
    await db
      .insert(totpCredential)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: totpCredential.userId, set: values });
  };

  return {
    id: 'huddle-authenticator',
    endpoints: {
      /** Starts setting up the app: returns the secret (as a QR code link) to scan. */
      authenticatorStart: createAuthEndpoint(
        '/authenticator/start',
        {
          method: 'POST',
          body: z.object({
            email: z.string().max(254).optional(),
            setupKey: z.string().max(500).optional(),
            inviteToken: z.string().max(200).optional(),
            resetToken: z.string().max(200).optional(),
          }),
        },
        async (ctx) => {
          const b = ctx.body;
          let email: string;
          let kind: 'owner' | 'invite' | 'reset' | 'self';
          let ref: string | null = null;
          if (b.setupKey !== undefined) {
            if (
              !sameText(b.setupKey.trim(), config.authSecret) ||
              (b.email ?? '').trim().toLowerCase() !== config.adminEmail
            ) {
              throw forbidden('That setup key and email don’t match this Huddle.');
            }
            email = config.adminEmail;
            kind = 'owner';
          } else if (b.inviteToken) {
            const inv = await pendingInvitation(db, eq(invitation.tokenHash, await sha256Hex(b.inviteToken)));
            if (!inv) throw forbidden('This invitation has expired or was already used.');
            email = inv.email;
            kind = 'invite';
            ref = inv.id;
          } else if (b.resetToken) {
            const hash = await sha256Hex(b.resetToken);
            const link = await db.query.totpResetLink.findFirst({
              where: and(
                eq(totpResetLink.tokenHash, hash),
                isNull(totpResetLink.usedAt),
                gt(totpResetLink.expiresAt, new Date()),
              ),
            });
            const owner = link && (await ctx.context.internalAdapter.findUserById(link.userId));
            if (!owner) throw forbidden('This reset link has expired or was already used.');
            email = owner.email;
            kind = 'reset';
            ref = hash;
          } else {
            const session = await getSessionFromCtx(ctx);
            if (!session) throw new APIError('UNAUTHORIZED', { message: 'Sign in to continue.' });
            email = session.user.email;
            kind = 'self';
            ref = session.user.id;
          }

          const secret = newSecret();
          const id = newId();
          await db.batch([
            db.delete(totpEnrollment).where(lt(totpEnrollment.expiresAt, new Date())),
            db.insert(totpEnrollment).values({
              id,
              email,
              secret: await seal(config.authSecret, SECRET_PURPOSE, secret),
              kind,
              ref,
              expiresAt: new Date(Date.now() + ENROLL_MINUTES * 60_000),
            }),
          ]);
          const ws = await db.query.workspace.findFirst({ columns: { name: true } });
          return ctx.json({
            enrollmentId: id,
            email,
            secret,
            uri: otpauthUri(ws?.name ?? 'Huddle', email, secret),
          });
        },
      ),

      /** Confirms the scan with a code from the app; signs the person in (except "self"). */
      authenticatorFinish: createAuthEndpoint(
        '/authenticator/finish',
        {
          method: 'POST',
          body: z.object({ enrollmentId: z.string().max(40), code: z.string().max(12) }),
        },
        async (ctx) => {
          const e = await db.query.totpEnrollment.findFirst({
            where: and(
              eq(totpEnrollment.id, ctx.body.enrollmentId),
              gt(totpEnrollment.expiresAt, new Date()),
            ),
          });
          if (!e) throw new APIError('BAD_REQUEST', { message: 'This setup expired. Start again.' });
          const secret = await unseal(config.authSecret, SECRET_PURPOSE, e.secret);
          const step = await matchStep(secret, ctx.body.code);
          if (step === null) {
            throw new APIError('BAD_REQUEST', {
              message: 'That code didn’t match. Use the newest code the app shows for Huddle.',
            });
          }

          if (e.kind === 'self') {
            const session = await getSessionFromCtx(ctx);
            if (!session || session.user.id !== e.ref) throw forbidden('Sign in to continue.');
            await saveCredential(session.user.id, secret, step);
            await db.delete(totpEnrollment).where(eq(totpEnrollment.id, e.id));
            return ctx.json({ signedIn: false });
          }

          const inv =
            e.kind === 'invite' ? await pendingInvitation(db, eq(invitation.id, e.ref ?? '')) : null;
          if (e.kind === 'invite' && !inv)
            throw forbidden('This invitation has expired or was already used.');
          if (e.kind === 'reset') {
            // Used once: claiming it fails if another tab already did.
            const claimed = await db
              .update(totpResetLink)
              .set({ usedAt: new Date() })
              .where(and(eq(totpResetLink.tokenHash, e.ref ?? ''), isNull(totpResetLink.usedAt)))
              .returning({ userId: totpResetLink.userId });
            if (!claimed.length) throw forbidden('This reset link was already used.');
          }

          const found = await ctx.context.internalAdapter.findUserByEmail(e.email);
          // A new account runs the usual checks (invite-only) and accepts the invitation.
          const user =
            found?.user ??
            (await ctx.context.internalAdapter.createUser(
              { email: e.email, emailVerified: true, name: '' },
              { method: 'authenticator' },
            ));
          if (found && inv) await acceptInvitation(db, inv, found.user.id);

          await saveCredential(user.id, secret, step);
          await db.delete(totpEnrollment).where(eq(totpEnrollment.id, e.id));
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ signedIn: true });
        },
      ),

      /** Signs in with the email address and the app's current code. */
      authenticatorSignIn: createAuthEndpoint(
        '/sign-in/authenticator',
        {
          method: 'POST',
          body: z.object({ email: z.string().max(254), code: z.string().max(12) }),
        },
        async (ctx) => {
          const found = await ctx.context.internalAdapter.findUserByEmail(
            ctx.body.email.trim().toLowerCase(),
          );
          const cred =
            found &&
            (await db.query.totpCredential.findFirst({ where: eq(totpCredential.userId, found.user.id) }));
          if (!found || !cred) throw badCode();
          if (cred.lockedUntil && cred.lockedUntil > new Date()) {
            throw new APIError('TOO_MANY_REQUESTS', {
              message: `Too many wrong codes. Try again in ${LOCK_MINUTES} minutes.`,
            });
          }
          const step = await matchStep(
            await unseal(config.authSecret, SECRET_PURPOSE, cred.secret),
            ctx.body.code,
          );
          // A code works once: a step at or before the last one used is refused.
          if (step === null || step <= cred.lastStep) {
            const failed = cred.failedCount + 1;
            await db
              .update(totpCredential)
              .set(
                failed >= MAX_FAILURES
                  ? { failedCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
                  : { failedCount: failed },
              )
              .where(eq(totpCredential.userId, cred.userId));
            throw badCode();
          }
          await db
            .update(totpCredential)
            .set({ lastStep: step, failedCount: 0, lockedUntil: null })
            .where(eq(totpCredential.userId, cred.userId));
          const session = await ctx.context.internalAdapter.createSession(found.user.id);
          await setSessionCookie(ctx, { session, user: found.user });
          return ctx.json({ signedIn: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
