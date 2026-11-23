import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { conversationMember, session, user, workspaceMember } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { canChangeRole, canDeactivate, isAdmin, type Actor } from '../access/access';
import { auditInsert, requestMeta } from '../audit/audit';
import type { Db } from '../../db/client';
import { hubFor } from '../../realtime/workspace-hub';
import { roomFor } from '../conversations/service';

async function findTarget(db: Db, actor: Actor, userId: string) {
  const target = await db.query.workspaceMember.findFirst({
    where: and(eq(workspaceMember.userId, userId), eq(workspaceMember.workspaceId, actor.workspaceId)),
  });
  if (!target) throw notFound('That member');
  return target;
}

export const memberRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  // Admins see everyone (including deactivated people); members see active people; guests see only
  // the people they share a channel with, and never anyone's email address.
  .get('/', async (c) => {
    const { actor, db } = c.var;
    const admin = isAdmin(actor);
    const guest = actor.role === 'guest';

    const sharedWithGuest = guest
      ? db
          .selectDistinct({ userId: conversationMember.userId })
          .from(conversationMember)
          .where(
            inArray(
              conversationMember.conversationId,
              db
                .select({ id: conversationMember.conversationId })
                .from(conversationMember)
                .where(eq(conversationMember.userId, actor.userId)),
            ),
          )
      : null;

    const rows = await db
      .select({
        userId: workspaceMember.userId,
        name: user.name,
        email: user.email,
        image: user.image,
        role: workspaceMember.role,
        status: workspaceMember.status,
        guestExpiresAt: workspaceMember.guestExpiresAt,
      })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .where(
        and(
          eq(workspaceMember.workspaceId, actor.workspaceId),
          admin ? undefined : eq(workspaceMember.status, 'active'),
          sharedWithGuest ? inArray(workspaceMember.userId, sharedWithGuest) : undefined,
        ),
      )
      .orderBy(sql`lower(${user.name})`);

    return c.json({
      members: rows.map((m) => ({
        userId: m.userId,
        name: m.name,
        image: m.image,
        role: m.role,
        ...(guest ? {} : { email: m.email }),
        ...(admin ? { status: m.status, guestExpiresAt: m.guestExpiresAt } : {}),
      })),
    });
  })

  .patch(
    '/:userId',
    jsonBody(
      z.object({
        role: z.enum(['admin', 'member', 'guest']),
        guestExpiresAt: z.iso.datetime().nullable().optional(),
      }),
    ),
    async (c) => {
      const { actor, db } = c.var;
      const target = await findTarget(db, actor, c.req.param('userId'));
      const body = c.req.valid('json');
      if (!canChangeRole(actor, target, body.role)) throw forbidden('You cannot change this person’s role.');
      const guestExpiresAt =
        body.role === 'guest' && body.guestExpiresAt ? new Date(body.guestExpiresAt) : null;
      await db.batch([
        db
          .update(workspaceMember)
          .set({ role: body.role, guestExpiresAt })
          .where(
            and(
              eq(workspaceMember.userId, target.userId),
              eq(workspaceMember.workspaceId, actor.workspaceId),
            ),
          ),
        auditInsert(db, {
          ...requestMeta(c),
          action: 'member.role_changed',
          actorId: actor.userId,
          targetId: target.userId,
          meta: { from: target.role, to: body.role },
        }),
      ]);
      return c.json({ member: { userId: target.userId, role: body.role, guestExpiresAt } });
    },
  )

  // Deactivation signs the person out everywhere in the same batch: their sessions are deleted.
  .post('/:userId/deactivate', async (c) => {
    const { actor, db } = c.var;
    const target = await findTarget(db, actor, c.req.param('userId'));
    if (!canDeactivate(actor, target)) throw forbidden('You cannot deactivate this person.');
    await db.batch([
      db
        .update(workspaceMember)
        .set({ status: 'deactivated' })
        .where(
          and(eq(workspaceMember.userId, target.userId), eq(workspaceMember.workspaceId, actor.workspaceId)),
        ),
      db.delete(session).where(eq(session.userId, target.userId)),
      auditInsert(db, {
        ...requestMeta(c),
        action: 'member.deactivated',
        actorId: actor.userId,
        targetId: target.userId,
      }),
    ]);
    // Sessions are gone; also end every live connection right now, not at the next reconnect.
    const rooms = await db
      .select({ id: conversationMember.conversationId })
      .from(conversationMember)
      .where(eq(conversationMember.userId, target.userId));
    await Promise.all([
      hubFor(c.env).disconnectUser(target.userId),
      ...rooms.map((r) => roomFor(c.env, r.id).disconnectUser(target.userId)),
    ]);
    return c.json({ member: { userId: target.userId, status: 'deactivated' } });
  })

  .post('/:userId/reactivate', async (c) => {
    const { actor, db } = c.var;
    const target = await findTarget(db, actor, c.req.param('userId'));
    if (!canDeactivate(actor, target)) throw forbidden('You cannot reactivate this person.');
    await db.batch([
      db
        .update(workspaceMember)
        .set({ status: 'active' })
        .where(
          and(eq(workspaceMember.userId, target.userId), eq(workspaceMember.workspaceId, actor.workspaceId)),
        ),
      auditInsert(db, {
        ...requestMeta(c),
        action: 'member.reactivated',
        actorId: actor.userId,
        targetId: target.userId,
      }),
    ]);
    return c.json({ member: { userId: target.userId, status: 'active' } });
  });
