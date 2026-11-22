import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { notification, user, userPreference } from '../../db/schema';
import { sign } from '../../lib/crypto';
import { newId } from '../../lib/id';
import { DIGEST_DAILY_BUDGET, emailsSentToday, sendEmail, type Email } from '../../lib/email';

export type DigestJob = { userId: string };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ITEMS = 10;
const DAILY_DIGEST_HOUR = 8;
/** Digests never reach further back than this, so unmuting a channel doesn't email month-old news. */
const LOOKBACK_MS = 7 * DAY;
/**
 * An unfinished claim older than this is released and claimed afresh with a new idempotency key.
 * Idempotency keys are commonly remembered for about a day, so a claim stuck past that point can no
 * longer rely on its key, and a failed send must not leave notifications stuck forever.
 */
const CLAIM_EXPIRY_MS = 23 * HOUR;
/**
 * A claim younger than this belongs to a job that may still be sending. Another job leaves it alone
 * (sends nothing) rather than sending the same digest concurrently; retries come later than this.
 */
export const CLAIM_IN_FLIGHT_MS = 15 * 60 * 1000;
export const UNSUBSCRIBE_PURPOSE = 'huddle:unsubscribe:v1';
const UNSUBSCRIBE_TTL_MS = 90 * DAY;

/**
 * Which notifications a digest may contain, as SQL over `n` (notification): unread, not emailed and
 * not claimed by another digest, recent, on a live message, in a conversation the person still
 * belongs to and has not read past, and allowed by that conversation's level (muted: nothing;
 * mentions: mentions only). Excluded notifications are left untouched rather than marked, so
 * changing a level later behaves as expected; and because the same filter decides who is due, they
 * never trigger empty jobs.
 */
const eligible = (now: Date) => sql`
  n.read_at IS NULL AND n.emailed_at IS NULL AND n.digest_id IS NULL
  AND n.created_at >= ${now.getTime() - LOOKBACK_MS}
  AND m.deleted_at IS NULL AND m.seq > cm.last_read_seq
  AND (cm.notify_level = 'all' OR (cm.notify_level = 'mentions' AND n.kind = 'mention'))`;

/** A claim whose job never finished (it failed, or crashed after sending): the next run retries it. */
const unfinishedClaim = (now: Date) => sql`
  n.digest_id IS NOT NULL AND n.emailed_at IS NULL AND n.claimed_at < ${now.getTime() - HOUR}`;

const eligibleJoins = sql`
  JOIN message m ON m.id = n.message_id
  JOIN conversation_member cm ON cm.conversation_id = m.conversation_id AND cm.user_id = n.user_id`;

type Candidate = {
  userId: string;
  digest: 'hourly' | 'daily';
  delayMin: number;
  timezone: string;
  pausedUntil: number | null;
  lastDigestAt: number | null;
  oldest: number;
};

function localParts(timezone: string, at: Date): { hour: number; date: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { hour: Number(get('hour')), date: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return { hour: at.getUTCHours(), date: at.toISOString().slice(0, 10) };
  }
}

/**
 * Daily digests go out at the first hourly run at or after 08:00 local time, once per local day, so
 * a missed 08:00 run catches up at 09:00 instead of skipping the day, and nobody gets two in a day.
 */
function dailyDue(c: Candidate, now: Date): boolean {
  const local = localParts(c.timezone, now);
  if (local.hour < DAILY_DIGEST_HOUR) return false;
  return !c.lastDigestAt || localParts(c.timezone, new Date(c.lastDigestAt)).date !== local.date;
}

/** People who should get a digest this hour (or have an unfinished one to retry), oldest first. */
export async function dueUsers(db: Db, now: Date): Promise<string[]> {
  const candidates = await db.all<Candidate>(sql`
    SELECT wm.user_id AS userId,
           COALESCE(p.digest, 'hourly') AS digest,
           COALESCE(p.digest_delay_min, 120) AS delayMin,
           COALESCE(p.timezone, 'UTC') AS timezone,
           p.paused_until AS pausedUntil,
           p.last_digest_at AS lastDigestAt,
           MIN(n.created_at) AS oldest
    FROM workspace_member wm
    LEFT JOIN user_preference p ON p.user_id = wm.user_id
    JOIN notification n ON n.user_id = wm.user_id
    ${eligibleJoins}
    WHERE wm.status = 'active' AND COALESCE(p.digest, 'hourly') <> 'off'
      AND ((${eligible(now)}) OR (${unfinishedClaim(now)}))
    GROUP BY wm.user_id
  `);
  const t = now.getTime();
  return candidates
    .filter((c) => !(c.pausedUntil && c.pausedUntil > t)) // Do Not Disturb
    .filter((c) => c.oldest <= t - c.delayMin * 60_000) // waited long enough unread
    .filter((c) =>
      c.digest === 'hourly' ? !c.lastDigestAt || c.lastDigestAt <= t - 55 * 60_000 : dailyDue(c, now),
    )
    .sort((a, b) => a.oldest - b.oldest)
    .map((c) => c.userId);
}

type Item = {
  notificationId: string;
  messageId: string;
  body: string;
  authorName: string | null;
  conversationId: string;
  convKind: string;
  convName: string | null;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Mention tokens become readable names; long text is cut to a 140-character snippet. */
function snippet(body: string, names: Map<string, string>): string {
  const readable = body
    .replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (_, id: string) => `@${names.get(id) ?? 'someone'}`)
    .replace(/<@(channel|here)>/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
  return readable.length > 140 ? `${readable.slice(0, 139)}…` : readable || '(file)';
}

/**
 * A one-click unsubscribe link that expires after 90 days. It is signed with a key derived for this
 * purpose only (never the raw server secret), over the user id AND the expiry, so neither can be
 * changed without breaking the signature.
 */
export async function unsubscribeUrl(config: Config, userId: string, now = new Date()) {
  const expires = Math.floor((now.getTime() + UNSUBSCRIBE_TTL_MS) / 1000);
  const token = await sign(config.authSecret, UNSUBSCRIBE_PURPOSE, `${userId}.${expires}`);
  return `${config.appUrl}/api/unsubscribe?u=${encodeURIComponent(userId)}&e=${expires}&t=${token}`;
}

const itemColumns = sql`
  n.id AS notificationId, m.id AS messageId, m.body, u.name AS authorName,
  c.id AS conversationId, c.kind AS convKind, c.name AS convName`;

/**
 * Renders the email for a list of items. Everything in it is derived from the items and `at` (never
 * the current time), so rendering the same claim again produces the same email: that is what makes
 * reusing an idempotency key on a retry safe.
 */
async function render(
  db: Db,
  config: Config,
  userId: string,
  items: Item[],
  at: Date,
): Promise<Email | null> {
  if (!items.length) return null;
  const recipient = await db.query.user.findFirst({ where: eq(user.id, userId), columns: { email: true } });
  if (!recipient) return null;
  const ws = await db.query.workspace.findFirst({ columns: { name: true } });
  const workspaceName = ws?.name ?? 'Huddle';

  const mentionedIds = [
    ...new Set(items.flatMap((i) => [...i.body.matchAll(/<@([0-9A-HJKMNP-TV-Z]{26})>/g)].map((m) => m[1]!))),
  ];
  const names = new Map(
    mentionedIds.length
      ? (
          await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, mentionedIds))
        ).map((u) => [u.id, u.name])
      : [],
  );

  const shown = items.slice(0, MAX_ITEMS).map((i) => ({
    who: i.authorName || 'Someone',
    where: i.convKind === 'public' || i.convKind === 'private' ? `#${i.convName}` : 'a direct message',
    text: snippet(i.body, names),
    link: `${config.appUrl}/c/${i.conversationId}/m/${i.messageId}`,
  }));
  const more = items.length - shown.length;
  const unsubscribe = await unsubscribeUrl(config, userId, at);
  const count = items.length;

  return {
    to: recipient.email,
    subject: `${count} ${count === 1 ? 'message is' : 'messages are'} waiting for you in ${workspaceName}`,
    text: [
      `While you were away in ${workspaceName}:`,
      '',
      ...shown.map((s) => `${s.who} in ${s.where}: ${s.text}\n${s.link}`),
      ...(more > 0 ? ['', `…and ${more} more.`] : []),
      '',
      `Stop these emails: ${unsubscribe}`,
    ].join('\n'),
    html:
      `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#151515;max-width:520px">` +
      `<p>While you were away in <strong>${escapeHtml(workspaceName)}</strong>:</p>` +
      shown
        .map(
          (s) =>
            `<p style="margin:16px 0"><strong>${escapeHtml(s.who)}</strong> in ${escapeHtml(s.where)}<br>${escapeHtml(s.text)}<br><a href="${escapeHtml(s.link)}" style="color:#00805f">Open in Huddle</a></p>`,
        )
        .join('') +
      (more > 0 ? `<p>…and ${more} more.</p>` : '') +
      `<p style="color:#5f5e59;font-size:13px"><a href="${escapeHtml(unsubscribe)}" style="color:#5f5e59">Stop these emails</a></p></div>`,
    // Lets mail apps show their own one-click "Unsubscribe" button (RFC 8058).
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** This person's eligible notifications that have waited at least their chosen delay. */
async function eligibleItems(db: Db, userId: string, now: Date): Promise<Item[]> {
  const prefs = await db.query.userPreference.findFirst({ where: eq(userPreference.userId, userId) });
  const cutoff = now.getTime() - (prefs?.digestDelayMin ?? 120) * 60_000;
  return db.all<Item>(sql`
    SELECT ${itemColumns}
    FROM notification n
    ${eligibleJoins}
    JOIN conversation c ON c.id = m.conversation_id
    LEFT JOIN user u ON u.id = m.author_id
    WHERE n.user_id = ${userId} AND n.created_at <= ${cutoff} AND ${eligible(now)}
    ORDER BY n.created_at, n.id
  `);
}

/** What a digest would contain right now, without claiming anything (previews and tests). */
export async function buildDigest(db: Db, config: Config, userId: string, now: Date) {
  const items = await eligibleItems(db, userId, now);
  return {
    included: items.map((i) => i.notificationId),
    email: await render(db, config, userId, items, now),
  };
}

type Claim = { digestId: string; claimedAt: Date; reused: boolean };

/**
 * Claims this person's digest before anything is sent.
 * - A claim younger than CLAIM_IN_FLIGHT_MS means another job may be sending right now: do nothing.
 * - An older unfinished claim is reused (same id, so same content and same idempotency key), unless
 *   it is older than CLAIM_EXPIRY_MS, in which case it is released and claimed afresh.
 * - Otherwise the eligible notifications are stamped with a new claim id in ONE UPDATE that only
 *   takes rows nobody has claimed. Two jobs racing for the same person: one gets the rows, the other
 *   gets none and sends nothing.
 */
async function claimDigest(db: Db, userId: string, now: Date): Promise<Claim | null> {
  const open = await db.get<{ digestId: string; claimedAt: number }>(sql`
    SELECT digest_id AS digestId, MIN(claimed_at) AS claimedAt FROM notification
    WHERE user_id = ${userId} AND digest_id IS NOT NULL AND emailed_at IS NULL
    GROUP BY digest_id ORDER BY claimedAt LIMIT 1`);
  if (open) {
    if (open.claimedAt > now.getTime() - CLAIM_IN_FLIGHT_MS) return null; // another job is on it
    if (open.claimedAt > now.getTime() - CLAIM_EXPIRY_MS) {
      return { digestId: open.digestId, claimedAt: new Date(open.claimedAt), reused: true };
    }
    await releaseClaim(db, open.digestId);
  }

  const included = (await eligibleItems(db, userId, now)).map((i) => i.notificationId);
  if (!included.length) return null;
  const digestId = newId();
  const claimed = await db
    .update(notification)
    .set({ digestId, claimedAt: now })
    .where(
      and(inArray(notification.id, included), isNull(notification.digestId), isNull(notification.emailedAt)),
    )
    .returning({ id: notification.id });
  return claimed.length ? { digestId, claimedAt: now, reused: false } : null;
}

async function releaseClaim(db: Db, digestId: string): Promise<void> {
  await db
    .update(notification)
    .set({ digestId: null, claimedAt: null })
    .where(and(eq(notification.digestId, digestId), isNull(notification.emailedAt)));
}

/** The claimed items, exactly as claimed (rendering must not depend on what changed since). */
async function claimedItems(db: Db, digestId: string): Promise<Item[]> {
  return db.all<Item>(sql`
    SELECT ${itemColumns}
    FROM notification n
    JOIN message m ON m.id = n.message_id
    JOIN conversation c ON c.id = m.conversation_id
    LEFT JOIN user u ON u.id = m.author_id
    WHERE n.digest_id = ${digestId}
    ORDER BY n.created_at, n.id
  `);
}

/**
 * - 'sent': emailed; exactly the claimed notifications are marked.
 * - 'nothing': nothing eligible (read meanwhile, muted, too new), or another job holds the claim.
 * - 'over_budget': today's email budget is used up. The claim is released, nothing is marked, and the
 *   next day's hourly run schedules the notifications again. The queue job is acknowledged on
 *   purpose: retrying it within the day could not succeed and would only spend queue operations.
 * Delivery failures are thrown so the queue retries; the claim is KEPT, so the retry sends the same
 * email with the same idempotency key, and a send that actually went through is not delivered twice.
 */
export type DigestResult = 'sent' | 'nothing' | 'over_budget';

export async function sendDigest(
  db: Db,
  config: Config,
  userId: string,
  now = new Date(),
): Promise<DigestResult> {
  const claim = await claimDigest(db, userId, now);
  if (!claim) return 'nothing';
  const email = await render(db, config, userId, await claimedItems(db, claim.digestId), claim.claimedAt);
  if (!email) {
    await releaseClaim(db, claim.digestId);
    return 'nothing';
  }
  const sent = await sendEmail(config, email, {
    db,
    limit: DIGEST_DAILY_BUDGET,
    idempotencyKey: `huddle-digest-${claim.digestId}`,
  });
  if (!sent) {
    // A fresh claim was never sent: release it. A reused claim may already have been delivered by an
    // earlier attempt, so it is kept (with its idempotency key) for the next try.
    if (!claim.reused) await releaseClaim(db, claim.digestId);
    return 'over_budget';
  }
  await db.batch([
    db.update(notification).set({ emailedAt: now }).where(eq(notification.digestId, claim.digestId)),
    db
      .insert(userPreference)
      .values({ userId, lastDigestAt: now })
      .onConflictDoUpdate({ target: userPreference.userId, set: { lastDigestAt: now } }),
  ]);
  return 'sent';
}

/** Hourly: queue one job per due person, within what is left of today's email budget. */
export async function scheduleDigests(
  db: Db,
  enqueue: (jobs: DigestJob[]) => Promise<unknown>,
  now = new Date(),
): Promise<number> {
  const left = DIGEST_DAILY_BUDGET - (await emailsSentToday(db, now));
  if (left <= 0) return 0;
  const due = (await dueUsers(db, now)).slice(0, left);
  if (due.length) await enqueue(due.map((userId) => ({ userId })));
  return due.length;
}
