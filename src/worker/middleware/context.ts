import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { ensureMigrated } from '../db/migrate';
import { getConfig, type Config } from '../config';
import { getDb, type Db } from '../db/client';
import { workspaceMember } from '../db/schema';
import { forbidden, unauthorized } from '../lib/errors';
import type { Actor } from '../modules/access/access';
import { createAuth, type Auth } from '../modules/auth/auth';

type Session = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

export type AppEnv = {
  Bindings: Env;
  Variables: { config: Config; db: Db; auth: Auth; session: Session; actor: Actor };
};

/** Per-request services: validated config, the Drizzle client and Better Auth. */
export const withServices = createMiddleware<AppEnv>(async (c, next) => {
  await ensureMigrated(c.env.DB);
  const config = getConfig(c.env, new URL(c.req.url).origin);
  const db = getDb(c.env);
  c.set('config', config);
  c.set('db', db);
  c.set(
    'auth',
    createAuth(config, db, (p) => c.executionCtx.waitUntil(p)),
  );
  await next();
});

/** Signed in, member or not (used by first-run setup). */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw unauthorized();
  c.set('session', session);
  await next();
});

/**
 * Signed in AND an active member of the workspace. Deactivated members and guests past their expiry
 * are refused here, so no route has to remember to check.
 */
export const requireActor = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw unauthorized();
  const member = await c.var.db.query.workspaceMember.findFirst({
    where: and(eq(workspaceMember.userId, session.user.id), eq(workspaceMember.status, 'active')),
  });
  if (!member) throw forbidden('You are not a member of this workspace.');
  if (member.role === 'guest' && member.guestExpiresAt && member.guestExpiresAt <= new Date()) {
    throw forbidden('Your guest access has ended.');
  }
  c.set('session', session);
  c.set('actor', {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    workspaceId: member.workspaceId,
    role: member.role,
  });
  await next();
});
