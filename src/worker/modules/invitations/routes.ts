import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { invitation, user, workspace, workspaceMember } from '../../db/schema';
import { sha256Hex, randomToken } from '../../lib/crypto';
import { emailDeliveryConfigured, sendEmail } from '../../lib/email';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { canInvite, canReadConversation, isAdmin } from '../access/access';
import { auditInsert, requestMeta } from '../audit/audit';
import { emailBrand } from '../../lib/email-layout';
import { invitationEmail } from '../auth/emails';
import { INVITATION_TTL_MS } from './service';

const createSchema = z
  .object({
    email: z.email().transform((e) => e.toLowerCase()),
    role: z.enum(['admin', 'member', 'guest']),
    conversationIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .refine((v) => v.role !== 'guest' || (v.conversationIds?.length ?? 0) > 0, {
    message: 'Guests must be invited to at least one channel.',
    path: ['conversationIds'],
  });

export const invitationRoutes = new Hono<AppEnv>()
  // Public: what the invite landing page shows. Tokens have 256 bits of entropy, so this can't be
  // used to discover invitations by guessing.
  .get('/by-token/:token', async (c) => {
    const { db } = c.var;
    const inv = await db.query.invitation.findFirst({
      where: and(
        eq(invitation.tokenHash, await sha256Hex(c.req.param('token'))),
        isNull(invitation.acceptedAt),
        isNull(invitation.revokedAt),
        gt(invitation.expiresAt, new Date()),
      ),
      columns: { email: true, role: true, workspaceId: true, invitedBy: true, expiresAt: true },
    });
    if (!inv) throw notFound('This invitation');
    const [ws, inviter] = await Promise.all([
      db.query.workspace.findFirst({ where: eq(workspace.id, inv.workspaceId), columns: { name: true } }),
      db.query.user.findFirst({ where: eq(user.id, inv.invitedBy), columns: { name: true } }),
    ]);
    return c.json({
      workspaceName: ws?.name ?? 'Huddle',
      inviterName: inviter?.name ?? 'Someone',
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
    });
  })

  .use('/*', requireActor)

  .post('/', jsonBody(createSchema), async (c) => {
    const { actor, db, config } = c.var;
    const body = c.req.valid('json');

    const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, actor.workspaceId) });
    if (!ws) throw notFound('Workspace');
    if (!canInvite(actor, body.role, ws.allowMemberGuestInvites)) {
      throw forbidden('You cannot invite people with that role.');
    }

    const existingUser = await db.query.user.findFirst({
      where: eq(user.email, body.email),
      columns: { id: true },
    });
    if (existingUser) {
      const membership = await db.query.workspaceMember.findFirst({
        where: eq(workspaceMember.userId, existingUser.id),
        columns: { status: true },
      });
      if (membership) throw conflict('already_member', 'That person is already in this workspace.');
    }

    // A guest can only be added to channels the inviter can see themselves (and never to DMs).
    const conversationIds = body.role === 'guest' ? [...new Set(body.conversationIds)] : [];
    for (const id of conversationIds) {
      const conv = await db.query.conversation.findFirst({
        where: (t, { eq: e }) => e(t.id, id),
        columns: { kind: true },
      });
      if (
        !conv ||
        !(await canReadConversation(db, actor, id)) ||
        (conv.kind !== 'public' && conv.kind !== 'private')
      ) {
        throw badRequest('invalid_channel', 'Guests can only be invited to channels you can see.');
      }
    }

    const token = randomToken();
    const id = newId();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await db.batch([
      // Re-inviting replaces any older pending invitation for the same address.
      db
        .update(invitation)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(invitation.email, body.email), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)),
        ),
      db.insert(invitation).values({
        id,
        workspaceId: actor.workspaceId,
        email: body.email,
        role: body.role,
        tokenHash: await sha256Hex(token),
        guestConversationIds: conversationIds.length ? conversationIds : null,
        invitedBy: actor.userId,
        expiresAt,
      }),
      auditInsert(db, {
        ...requestMeta(c),
        action: 'invitation.created',
        actorId: actor.userId,
        targetId: id,
        meta: { role: body.role },
      }),
    ]);

    const link = `${config.appUrl}/invite/${token}`;
    let emailSent = false;
    try {
      await sendEmail(
        config,
        invitationEmail(body.email, link, await emailBrand(db, config), actor.name, body.role === 'guest'),
        {
          db,
        },
      );
      emailSent = await emailDeliveryConfigured(db);
    } catch (err) {
      // The invitation stands; the inviter can still copy the link and share it another way.
      if (!(err instanceof AppError)) throw err;
    }

    return c.json(
      { invitation: { id, email: body.email, role: body.role, expiresAt }, link, emailSent },
      201,
    );
  })

  .get('/', async (c) => {
    const { actor, db } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can see invitations.');
    const pending = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        invitedBy: invitation.invitedBy,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.workspaceId, actor.workspaceId),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitation.createdAt));
    return c.json({ invitations: pending });
  })

  .delete('/:id', async (c) => {
    const { actor, db } = c.var;
    const inv = await db.query.invitation.findFirst({
      where: and(eq(invitation.id, c.req.param('id')), eq(invitation.workspaceId, actor.workspaceId)),
    });
    if (!inv || inv.acceptedAt || inv.revokedAt) throw notFound('This invitation');
    if (!isAdmin(actor) && inv.invitedBy !== actor.userId) throw notFound('This invitation');
    await db.batch([
      db.update(invitation).set({ revokedAt: new Date() }).where(eq(invitation.id, inv.id)),
      auditInsert(db, {
        ...requestMeta(c),
        action: 'invitation.revoked',
        actorId: actor.userId,
        targetId: inv.id,
      }),
    ]);
    return c.body(null, 204);
  });
