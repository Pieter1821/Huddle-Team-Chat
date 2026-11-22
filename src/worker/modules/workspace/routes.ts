import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { user, workspace } from '../../db/schema';
import { forbidden } from '../../lib/errors';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';

export const displayName = z.string().trim().min(1).max(80);

export const meRoutes = new Hono<AppEnv>()
  .get('/', requireActor, async (c) => {
    const { actor, session, db } = c.var;
    const ws = await db.query.workspace.findFirst({
      where: eq(workspace.id, actor.workspaceId),
      columns: { id: true, name: true, accent: true, logoFileId: true, allowMemberGuestInvites: true },
    });
    return c.json({
      user: { id: actor.userId, name: actor.name, email: actor.email, image: session.user.image ?? null },
      role: actor.role,
      // Email-code sign-ups start without a name; the app asks for one when this is true.
      needsName: actor.name.trim() === '',
      workspace: ws,
    });
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
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to update.'),
  ),
  async (c) => {
    const { actor, db } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can change workspace settings.');
    const body = c.req.valid('json');
    const [updated] = await db
      .update(workspace)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.allowMemberGuestInvites !== undefined
          ? { allowMemberGuestInvites: body.allowMemberGuestInvites }
          : {}),
      })
      .where(eq(workspace.id, actor.workspaceId))
      .returning({
        id: workspace.id,
        name: workspace.name,
        allowMemberGuestInvites: workspace.allowMemberGuestInvites,
      });
    return c.json({ workspace: updated });
  },
);
