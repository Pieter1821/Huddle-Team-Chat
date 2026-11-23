import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import * as schema from '../../db/schema';
import { sendEmail } from '../../lib/email';
import { newId } from '../../lib/id';
import { recordAudit } from '../audit/audit';
import { acceptInvitation, findPendingInvitation, hasOwner } from '../invitations/service';
import { emailBrand } from '../../lib/email-layout';
import { authenticator } from './authenticator';
import { magicLinkEmail, signInCodeEmail } from './emails';

const FIVE_MINUTES = 5 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Whether this address may create an account: the admin before an owner exists, or an invitee. */
async function mayJoin(db: Db, config: Config, email: string): Promise<boolean> {
  return (
    (email === config.adminEmail && !(await hasOwner(db))) || Boolean(await findPendingInvitation(db, email))
  );
}

/**
 * Codes and links only go to people who could actually sign in: existing users or allowed joiners.
 * Anyone else gets the same "sent" response but no email, which protects the daily email quota and
 * avoids revealing who is a member.
 */
async function mayReceiveSignIn(db: Db, config: Config, email: string): Promise<boolean> {
  const normalized = email.toLowerCase();
  const existing = await db.query.user.findFirst({
    where: eq(schema.user.email, normalized),
    columns: { id: true },
  });
  return Boolean(existing) || (await mayJoin(db, config, normalized));
}

/**
 * Better Auth is built per request: a D1 binding only exists inside a request, and Workers must not
 * share I/O objects between requests.
 */
export function createAuth(config: Config, db: Db, waitUntil?: (p: Promise<unknown>) => void) {
  return betterAuth({
    appName: 'Huddle',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.appUrl],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    // No passwords anywhere: email codes, magic links, authenticator apps and Google only.
    emailAndPassword: { enabled: false },
    socialProviders: config.google
      ? { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret } }
      : {},
    session: { expiresIn: THIRTY_DAYS, updateAge: 24 * 60 * 60 },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60 * 60, max: 5 },
        '/sign-in/magic-link': { window: 60 * 60, max: 5 },
        '/sign-in/email-otp': { window: FIVE_MINUTES, max: 10 },
        '/sign-in/authenticator': { window: FIVE_MINUTES, max: 10 },
        '/authenticator/start': { window: 60 * 60, max: 10 },
        '/authenticator/finish': { window: FIVE_MINUTES, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: 'huddle',
      useSecureCookies: config.appUrl.startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      // Cloudflare sets this header itself (overwriting any client value), so it can't be spoofed.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: { generateId: () => newId() },
      ...(waitUntil ? { backgroundTasks: { handler: waitUntil } } : {}),
    },
    plugins: [
      authenticator(config, db),
      emailOTP({
        otpLength: 6,
        expiresIn: FIVE_MINUTES,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp }) {
          if (!(await mayReceiveSignIn(db, config, email))) return;
          await sendEmail(config, signInCodeEmail(email, otp, await emailBrand(db, config)), { db });
        },
      }),
      magicLink({
        expiresIn: FIVE_MINUTES,
        async sendMagicLink({ email, url }) {
          if (!(await mayReceiveSignIn(db, config, email))) return;
          await sendEmail(config, magicLinkEmail(email, url, await emailBrand(db, config)), { db });
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Invite-only: the configured admin (until an owner exists) or someone with a valid invitation.
          async before(user) {
            const email = user.email.toLowerCase();
            if (!(await mayJoin(db, config, email))) {
              await recordAudit(db, { action: 'auth.sign_up_blocked', meta: { email } });
              throw new APIError('FORBIDDEN', {
                message: 'This email has not been invited to this workspace.',
              });
            }
            return { data: { ...user, email } };
          },
          async after(user) {
            const inv = await findPendingInvitation(db, user.email);
            if (inv) await acceptInvitation(db, inv, user.id);
          },
        },
      },
      session: {
        create: {
          // A deactivated member can't start a new session by any sign-in method.
          async before(session) {
            const deactivated = await db.query.workspaceMember.findFirst({
              where: and(
                eq(schema.workspaceMember.userId, session.userId),
                eq(schema.workspaceMember.status, 'deactivated'),
              ),
              columns: { userId: true },
            });
            if (deactivated) {
              await recordAudit(db, { action: 'auth.session_blocked', actorId: session.userId });
              throw new APIError('FORBIDDEN', { message: 'This account has been deactivated.' });
            }
          },
          async after(session) {
            await recordAudit(db, {
              action: 'auth.sign_in',
              actorId: session.userId,
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
            });
          },
        },
      },
    },
    hooks: {
      // Failed code or link attempts are what an owner needs to see when someone is guessing.
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        if (
          !failed ||
          !['/sign-in/email-otp', '/magic-link/verify', '/sign-in/authenticator'].includes(ctx.path)
        )
          return;
        const body = ctx.body as { email?: unknown } | undefined;
        await recordAudit(db, {
          action: 'auth.sign_in_failed',
          ipAddress: ctx.request?.headers.get('cf-connecting-ip') ?? null,
          meta: { method: ctx.path, email: typeof body?.email === 'string' ? body.email : undefined },
        });
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
