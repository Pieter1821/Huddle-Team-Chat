import { auditLog } from '../../db/schema';
import type { Db } from '../../db/client';
import { newId } from '../../lib/id';

export type AuditAction =
  | 'auth.sign_in'
  | 'auth.sign_in_failed'
  | 'auth.sign_up_blocked'
  | 'auth.session_blocked'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.logo_changed'
  | 'workspace.logo_removed'
  | 'webhook.created'
  | 'webhook.revoked'
  | 'invitation.created'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'member.role_changed'
  | 'member.deactivated'
  | 'member.reactivated'
  | 'import.started'
  | 'import.finished'
  | 'export.started';

export type AuditEntry = {
  action: AuditAction;
  actorId?: string | null;
  targetId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
};

/** Builds the insert so callers can put it in the same atomic batch as the change it records. */
export const auditInsert = (db: Db, entry: AuditEntry) =>
  db.insert(auditLog).values({
    id: newId(),
    action: entry.action,
    actorId: entry.actorId ?? null,
    targetId: entry.targetId ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent?.slice(0, 300) ?? null,
    meta: entry.meta ?? null,
  });

export const recordAudit = async (db: Db, entry: AuditEntry) => {
  await auditInsert(db, entry);
};
