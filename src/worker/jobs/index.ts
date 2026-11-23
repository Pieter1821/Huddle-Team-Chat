import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb, type Db } from '../db/client';
import { file, rateLimit, verification } from '../db/schema';
import { AppError } from '../lib/errors';
import { roomFor } from '../modules/conversations/service';
import { scheduleDigests, sendDigest, type DigestJob } from '../modules/notifications/digest';
import { sendPushJob, type PushJob } from '../modules/push/send';

/** Everything on the notifications queue: hourly digest emails and instant pushes. */
export type NotificationJob = DigestJob | PushJob;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Housekeeping, run hourly:
 * - uploads that were never attached to a message (after a day) leave storage;
 * - expired sign-in codes and links, and stale rate-limit counters, are deleted;
 * - events a crashed room saved but never broadcast are published (the outbox safety net).
 */
export async function cleanup(env: Env, db: Db, now = new Date()) {
  // Rows first, then objects. A row is only deleted if it is STILL unattached (someone may have
  // sent it since we looked), and only the objects of rows actually deleted are removed. If the
  // storage delete then fails, the worst case is an unreferenced object (a small, logged storage
  // leak), never a database row pointing at a file that no longer exists.
  const candidates = await db
    .select({ id: file.id })
    .from(file)
    .where(and(isNull(file.messageId), lt(file.createdAt, new Date(now.getTime() - DAY))))
    .limit(100);
  let orphanFiles = 0;
  if (candidates.length) {
    const deleted = await db
      .delete(file)
      .where(
        and(
          inArray(
            file.id,
            candidates.map((c) => c.id),
          ),
          isNull(file.messageId),
        ),
      )
      .returning({ r2Key: file.r2Key });
    orphanFiles = deleted.length;
    if (deleted.length) {
      try {
        await env.FILES.delete(deleted.map((d) => d.r2Key));
      } catch (err) {
        console.error('orphan upload objects could not be deleted', deleted.length, err);
      }
    }
  }

  await db.delete(verification).where(lt(verification.expiresAt, now));
  await db.delete(rateLimit).where(lt(rateLimit.lastRequest, now.getTime() - DAY));

  const stuck = await db.all<{ conversationId: string }>(sql`
    SELECT DISTINCT conversation_id AS conversationId FROM conversation_event
    WHERE published_at IS NULL AND created_at < ${now.getTime() - 60_000}
  `);
  for (const { conversationId } of stuck) await roomFor(env, conversationId).publishPending(conversationId);

  return { orphanFiles, republished: stuck.length };
}

/**
 * The settings for work without a request: APP_URL, or the address Huddle was set up at. Null
 * before setup (there is nothing to email or push yet).
 */
async function backgroundConfig(env: Env, db: Db) {
  const ws = await db.query.workspace.findFirst({ columns: { appUrl: true } });
  try {
    return getConfig(env, ws?.appUrl);
  } catch {
    return null;
  }
}

/** Cron: once an hour. */
export async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  const db = getDb(env);
  const now = new Date();
  ctx.waitUntil(cleanup(env, db, now));
  await scheduleDigests(db, (jobs) => env.NOTIFICATIONS.sendBatch(jobs.map((body) => ({ body }))), now);
}

/**
 * Queue consumer. Digests: one per message; a failed send is retried (up to 3 times, then the job
 * goes to the dead-letter queue), so a mention is never silently dropped. Pushes: best effort and
 * never retried, since a retry could repeat a push on devices that already showed it.
 */
export async function queue(batch: MessageBatch<NotificationJob>, env: Env) {
  const db = getDb(env);
  const config = await backgroundConfig(env, db);
  if (!config) {
    for (const message of batch.messages) message.ack(); // not set up yet: nothing to send
    return;
  }
  for (const message of batch.messages) {
    const job = message.body;
    if ('type' in job) {
      try {
        await sendPushJob(db, config, job);
      } catch (err) {
        console.error('push job failed', err instanceof Error ? err.message : err);
      }
      message.ack();
      continue;
    }
    try {
      const result = await sendDigest(db, config, job.userId);
      if (result === 'over_budget') {
        // Acknowledged on purpose: the notifications stay pending and tomorrow's run picks them up.
        console.warn('digest deferred: daily email budget used up');
      }
      message.ack();
    } catch (err) {
      console.error('digest failed', err instanceof AppError ? err.code : err);
      // Later than CLAIM_IN_FLIGHT_MS, so the retry reuses the claim (same content, same idempotency key).
      message.retry({ delaySeconds: 20 * 60 });
    }
  }
}
