import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { conversation, conversationMember, type workspaceRoles } from '../../db/schema';

export type Role = (typeof workspaceRoles)[number];

/** The signed-in person as the server knows them. Built from the session, never from the request. */
export type Actor = {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  role: Role;
};

export const isAdmin = (actor: Actor) => actor.role === 'owner' || actor.role === 'admin';

/** What the workspace lets members do about invitations (both off unless an owner turns them on). */
export type MemberInvitePolicy = { guests: boolean; members: boolean };

/**
 * Who may invite whom: owners invite admins, members and guests; admins invite members and guests;
 * members invite guests when the workspace allows guest invites, and members and guests when it
 * lets members invite people; guests invite nobody. Only an owner invites an admin, and nobody is
 * invited straight in as an owner.
 */
export function canInvite(actor: Actor, role: Role, policy: MemberInvitePolicy): boolean {
  if (role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return role !== 'admin';
  if (actor.role === 'member') {
    if (role === 'guest') return policy.guests || policy.members;
    return role === 'member' && policy.members;
  }
  return false;
}

/**
 * Role changes: never your own, never to or from owner (ownership transfer is its own flow),
 * only an owner touches admin rights, and an admin can switch members and guests.
 */
export function canChangeRole(actor: Actor, target: { userId: string; role: Role }, next: Role): boolean {
  if (actor.userId === target.userId) return false;
  if (target.role === 'owner' || next === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return target.role !== 'admin' && next !== 'admin';
  return false;
}

/** Owners can deactivate anyone but themselves; admins can deactivate members and guests. */
export function canDeactivate(actor: Actor, target: { userId: string; role: Role }): boolean {
  if (actor.userId === target.userId || target.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return target.role !== 'admin';
  return false;
}

/**
 * The one rule for conversations: you can read one if you are a member of it, or if it is a public
 * channel in your workspace and you are not a guest. Callers turn `false` into a 404 (not a 403),
 * so a private conversation's existence is never confirmed to outsiders.
 */
export async function canReadConversation(db: Db, actor: Actor, conversationId: string): Promise<boolean> {
  const conv = await db.query.conversation.findFirst({
    where: and(eq(conversation.id, conversationId), eq(conversation.workspaceId, actor.workspaceId)),
    columns: { kind: true },
  });
  if (!conv) return false;
  if (conv.kind === 'public' && actor.role !== 'guest') return true;
  const membership = await db.query.conversationMember.findFirst({
    where: and(
      eq(conversationMember.conversationId, conversationId),
      eq(conversationMember.userId, actor.userId),
    ),
    columns: { userId: true },
  });
  return Boolean(membership);
}
