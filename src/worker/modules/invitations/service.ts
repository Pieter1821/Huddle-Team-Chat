import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { conversation, conversationMember, invitation, workspaceMember } from '../../db/schema';
import { auditInsert } from '../audit/audit';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Invitation = typeof invitation.$inferSelect;

/** The newest invitation for this email that has not been used, revoked or expired. */
export async function findPendingInvitation(db: Db, email: string): Promise<Invitation | undefined> {
  return db.query.invitation.findFirst({
    where: and(
      eq(invitation.email, email.toLowerCase()),
      isNull(invitation.acceptedAt),
      isNull(invitation.revokedAt),
      gt(invitation.expiresAt, new Date()),
    ),
    orderBy: desc(invitation.createdAt),
  });
}

/**
 * Turns an invitation into membership in one atomic batch: the member row, the invitation marked
 * used, a guest's channel memberships and the audit entry all land together or not at all.
 */
export async function acceptInvitation(db: Db, inv: Invitation, userId: string): Promise<void> {
  const guestChannels =
    inv.role === 'guest' && inv.guestConversationIds?.length
      ? await db
          .select({ id: conversation.id })
          .from(conversation)
          .where(
            and(
              eq(conversation.workspaceId, inv.workspaceId),
              inArray(conversation.id, inv.guestConversationIds),
              inArray(conversation.kind, ['public', 'private']),
              isNull(conversation.archivedAt),
            ),
          )
      : [];

  await db.batch([
    db.insert(workspaceMember).values({ workspaceId: inv.workspaceId, userId, role: inv.role }),
    db.update(invitation).set({ acceptedAt: new Date() }).where(eq(invitation.id, inv.id)),
    ...guestChannels.map((c) =>
      db.insert(conversationMember).values({ conversationId: c.id, userId }).onConflictDoNothing(),
    ),
    auditInsert(db, {
      action: 'invitation.accepted',
      actorId: userId,
      targetId: inv.id,
      meta: { role: inv.role, channels: guestChannels.length },
    }),
  ]);
}

export async function hasOwner(db: Db): Promise<boolean> {
  const row = await db.query.workspaceMember.findFirst({
    where: eq(workspaceMember.role, 'owner'),
    columns: { userId: true },
  });
  return Boolean(row);
}
