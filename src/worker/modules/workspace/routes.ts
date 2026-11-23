import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { user, workspace, totpCredential } from '../../db/schema';
import { forbidden } from '../../lib/errors';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { auditInsert, requestMeta } from '../audit/audit';
import { accentSchema } from '../branding/routes';

export const displayName = z.string().trim().min(1).max(80);

export const meRoutes = new Hono<AppEnv>()
  .get('/', requireActor, async (c) => {
    const { actor, session, db } = c.var;
    const ws = await db.query.workspace.findFirst({
      where: eq(workspace.id, actor.workspaceId),
      columns: { id: true, name: true, accent: true, logoFileId: true, allowMemberGuestInvites: true },
    });
    const totp = await db.query.totpCredential.findFirst({
      where: eq(totpCredential.userId, actor.userId),
      columns: { userId: true },
    });
    return c.json({
      user: { id: actor.userId, name: actor.name, email: actor.email, image: session.user.image ?? null },
      hasAuthenticator: Boolean(totp),
      role: actor.role,
      // Email-code sign-ups start without a name; the app asks for one when this is true.
      needsName: actor.name.trim() === '',
      workspace: ws,
    });
  })
  // Turns off signing in with an authenticator app for yourself.
  .post('/authenticator/remove', requireActor, async (c) => {
    const { actor, db } = c.var;
    await db.delete(totpCredential).where(eq(totpCredential.userId, actor.userId));
    return c.body(null, 204);
  })
  .patch('/', requireActor, jsonBody(z.object({ name: displayName })), async (c) => {
    const { actor, db } = c.var;
    const { name } = c.req.valid('json');
    await db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, actor.userId));
    return c.json({ user: { id: actor.userId, name } });
  });

export const workspaceRoutes = new Hono<AppEnv>().patch(
  '/',
  requireActor,
  jsonBody(
    z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        allowMemberGuestInvites: z.boolean().optional(),
        // null resets to Huddle's default teal.
        accent: accentSchema.nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to update.'),
  ),
  async (c) => {
    const { actor, db } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can change workspace settings.');
    const body = c.req.valid('json');
    const changes = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.allowMemberGuestInvites !== undefined
        ? { allowMemberGuestInvites: body.allowMemberGuestInvites }
        : {}),
      ...(body.accent !== undefined ? { accent: body.accent } : {}),
    };
    const before = await db.query.workspace.findFirst({
      where: eq(workspace.id, actor.workspaceId),
      columns: { name: true, accent: true, allowMemberGuestInvites: true },
    });
    // What changed, from what to what, recorded together with the change itself.
    const changed = Object.fromEntries(
      Object.entries(changes)
        .filter(([key, to]) => before?.[key as keyof typeof changes] !== to)
        .map(([key, to]) => [key, { from: before?.[key as keyof typeof changes] ?? null, to }]),
    );
    if (!Object.keys(changed).length) {
      // Nothing actually changed: no write, no log entry.
      return c.json({ workspace: { id: actor.workspaceId, ...before } });
    }
    const [rows] = await db.batch([
      db.update(workspace).set(changes).where(eq(workspace.id, actor.workspaceId)).returning({
        id: workspace.id,
        name: workspace.name,
        allowMemberGuestInvites: workspace.allowMemberGuestInvites,
        accent: workspace.accent,
      }),
      auditInsert(db, {
        ...requestMeta(c),
        action: 'workspace.updated',
        actorId: actor.userId,
        targetId: actor.workspaceId,
        meta: { changes: changed },
      }),
    ]);
    return c.json({ workspace: rows[0] });
  },
);
