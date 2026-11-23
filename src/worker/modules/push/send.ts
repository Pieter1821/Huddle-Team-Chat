import { inArray, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { pushSubscription } from '../../db/schema';
import { encryptPayload, vapidAuthorization } from '../../lib/web-push';
import { vapidKeys } from './keys';

/** Queued by a conversation room when a new message notifies people (mention, DM, thread reply). */
export type PushJob = { type: 'push'; messageId: string; userIds: string[] };

/** What the service worker receives and shows. */
export type PushPayload = { title: string; body: string; url: string; tag: string };

/** Sends one push request; replaced in tests. */
export type PushSender = (url: string, init: RequestInit) => Promise<Response>;

const TTL_SECONDS = 24 * 60 * 60; // a phone that's off for a day doesn't need yesterday's pings

type Recipient = { userId: string; kind: 'mention' | 'dm' | 'thread_reply' };
type MessageInfo = {
  conversationId: string;
  parentId: string | null;
  body: string;
  convKind: string;
  convName: string | null;
  authorName: string | null;
  webhookName: string | null;
};
type Subscription = { id: string; userId: string; endpoint: string; p256dh: string; auth: string };

/**
 * Who should get a push for this message right now: the same rules as email digests (still unread,
 * message not deleted, still a member and not read past it, allowed by that conversation's level,
 * Do Not Disturb off) and an active member of the workspace.
 */
async function recipients(db: Db, job: PushJob, now: Date): Promise<Recipient[]> {
  if (!job.userIds.length) return [];
  return db.all<Recipient>(sql`
    SELECT n.user_id AS userId, n.kind AS kind
    FROM notification n
    JOIN message m ON m.id = n.message_id
    JOIN conversation_member cm ON cm.conversation_id = m.conversation_id AND cm.user_id = n.user_id
    JOIN workspace_member wm ON wm.user_id = n.user_id AND wm.status = 'active'
    LEFT JOIN user_preference p ON p.user_id = n.user_id
    WHERE n.message_id = ${job.messageId}
      AND n.user_id IN (${sql.join(
        job.userIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND n.read_at IS NULL AND m.deleted_at IS NULL AND m.seq > cm.last_read_seq
      AND (cm.notify_level = 'all' OR (cm.notify_level = 'mentions' AND n.kind = 'mention'))
      AND (p.paused_until IS NULL OR p.paused_until <= ${now.getTime()})`);
}

/** Mention tokens become names; long text is cut so the notification stays readable (and small). */
export function previewText(body: string, names: Map<string, string>): string {
  const readable = body
    .replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (_, id: string) => `@${names.get(id) ?? 'someone'}`)
    .replace(/<@(channel|here)>/g, '@$1')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return readable.length > 180 ? `${readable.slice(0, 179)}…` : readable || 'Shared a file';
}

export function buildPayload(
  messageId: string,
  m: MessageInfo,
  kind: Recipient['kind'],
  names: Map<string, string>,
): PushPayload {
  const who = m.authorName ?? m.webhookName ?? 'Someone';
  const where = m.convKind === 'public' || m.convKind === 'private' ? `#${m.convName ?? 'channel'}` : null;
  const title =
    kind === 'thread_reply' && where
      ? `${who} replied in a thread in ${where}`
      : kind === 'thread_reply'
        ? `${who} replied in a thread`
        : where
          ? `${who} in ${where}`
          : who;
  return {
    title,
    body: previewText(m.body, names),
    url: m.parentId ? `/c/${m.conversationId}/t/${m.parentId}` : `/c/${m.conversationId}/m/${messageId}`,
    // One notification per conversation on screen: a newer one replaces the older.
    tag: m.conversationId,
  };
}

/** Sends one encrypted push. Returns 'gone' when the browser has dropped this subscription. */
export async function deliver(
  sub: Subscription,
  payload: PushPayload,
  keys: Awaited<ReturnType<typeof vapidKeys>>,
  subject: string,
  send: PushSender,
): Promise<'sent' | 'gone' | 'failed'> {
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const res = await send(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_SECONDS),
      Urgency: 'high',
    },
    body,
    redirect: 'manual',
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.ok) return 'sent';
  console.warn('push not accepted', new URL(sub.endpoint).hostname, res.status);
  return 'failed';
}

/**
 * Sends the pushes for one new message. Best effort: a push that fails is logged and not retried,
 * since a retry could repeat it on the devices that did receive it (the email digest still covers
 * anything left unread). Subscriptions the push service reports as gone are deleted.
 */
export async function sendPushJob(
  db: Db,
  config: Config,
  job: PushJob,
  send: PushSender = (url, init) => fetch(url, init),
  now = new Date(),
): Promise<{ sent: number; gone: number; failed: number }> {
  const result = { sent: 0, gone: 0, failed: 0 };
  const people = await recipients(db, job, now);
  if (!people.length) return result;

  // Only devices still signed in: a subscription belongs to the session that made it.
  const subs = await db.all<Subscription>(sql`
    SELECT s.id, s.user_id AS userId, s.endpoint, s.p256dh, s.auth
    FROM push_subscription s JOIN session se ON se.id = s.session_id
    WHERE se.expires_at > ${now.getTime()}
      AND s.user_id IN (${sql.join(
        people.map((p) => sql`${p.userId}`),
        sql`, `,
      )})`);
  if (!subs.length) return result;

  const [m] = await db.all<MessageInfo>(sql`
    SELECT m.conversation_id AS conversationId, m.parent_id AS parentId, m.body,
      c.kind AS convKind, c.name AS convName, u.name AS authorName, w.name AS webhookName
    FROM message m JOIN conversation c ON c.id = m.conversation_id
    LEFT JOIN user u ON u.id = m.author_id LEFT JOIN webhook w ON w.id = m.webhook_id
    WHERE m.id = ${job.messageId}`);
  if (!m) return result;
  const mentioned = [...new Set([...m.body.matchAll(/<@([0-9A-HJKMNP-TV-Z]{26})>/g)].map((x) => x[1]!))];
  const names = new Map<string, string>(
    mentioned.length
      ? (
          await db.all<{ id: string; name: string }>(
            sql`SELECT id, name FROM user WHERE id IN (${sql.join(
              mentioned.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
        ).map((u) => [u.id, u.name])
      : [],
  );

  const keys = await vapidKeys(db, config.authSecret);
  const kindOf = new Map(people.map((p) => [p.userId, p.kind]));
  const outcomes = await Promise.allSettled(
    subs.map((s) =>
      deliver(s, buildPayload(job.messageId, m, kindOf.get(s.userId)!, names), keys, config.appUrl, send),
    ),
  );
  const gone: string[] = [];
  outcomes.forEach((o, i) => {
    if (o.status === 'rejected') {
      console.warn('push failed', o.reason instanceof Error ? o.reason.message : o.reason);
      result.failed += 1;
    } else {
      result[o.value === 'sent' ? 'sent' : o.value === 'gone' ? 'gone' : 'failed'] += 1;
      if (o.value === 'gone') gone.push(subs[i]!.id);
    }
  });
  if (gone.length) await db.delete(pushSubscription).where(inArray(pushSubscription.id, gone));
  return result;
}
