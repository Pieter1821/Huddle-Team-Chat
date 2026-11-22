import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb, type Db } from '../db/client';
import { file, rateLimit, verification } from '../db/schema';
import { AppError } from '../lib/errors';
import { roomFor } from '../modules/conversations/service';
import { scheduleDigests, sendDigest, type DigestJob } from '../modules/notifications/digest';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Housekeeping, run hourly:
 * - uploads that were never attached to a message (after a day) leave storage;
 * - expired sign-in codes and links, and stale rate-limit counters, are deleted;
 * - events a crashed room saved but never broadcast are published (the outbox safety net).
 */
export async function cleanup(env: Env, db: Db, now = new Date()) {
  const orphans = await db
    .select({ id: file.id, r2Key: file.r2Key })
    .from(file)
    .where(and(isNull(file.messageId), lt(file.createdAt, new Date(now.getTime() - DAY))))
    .limit(100);
  if (orphans.length) {
    await env.FILES.delete(orphans.map((o) => o.r2Key));
    await db.delete(file).where(
      inArray(
        file.id,
        orphans.map((o) => o.id),
      ),
    );
  }

  await db.delete(verification).where(lt(verification.expiresAt, now));
  await db.delete(rateLimit).where(lt(rateLimit.lastRequest, now.getTime() - DAY));

  const stuck = await db.all<{ conversationId: string }>(sql`
    SELECT DISTINCT conversation_id AS conversationId FROM conversation_event
    WHERE published_at IS NULL AND created_at < ${now.getTime() - 60_000}
  `);
  for (const { conversationId } of stuck) await roomFor(env, conversationId).publishPending(conversationId);

  return { orphanFiles: orphans.length, republished: stuck.length };
}

/** Cron: once an hour. */
export async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  const db = getDb(env);
  const now = new Date();
  ctx.waitUntil(cleanup(env, db, now));
  await scheduleDigests(db, (jobs) => env.NOTIFICATIONS.sendBatch(jobs.map((body) => ({ body }))), now);
}

/**
 * Queue consumer: one digest per message. A failed send is retried (up to 3 times, then the job goes
 * to the dead-letter queue), so a mention is never silently dropped.
 */
export async function queue(batch: MessageBatch<DigestJob>, env: Env) {
  const db = getDb(env);
  const config = getConfig(env);
  for (const message of batch.messages) {
    try {
      await sendDigest(db, config, message.body.userId);
      message.ack();
    } catch (err) {
      console.error('digest failed', err instanceof AppError ? err.code : err);
      message.retry({ delaySeconds: 60 * 5 });
    }
  }
}
