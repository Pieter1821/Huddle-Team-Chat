import { eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { notification, user, userPreference } from '../../db/schema';
import { sign } from '../../lib/crypto';
import { DIGEST_DAILY_BUDGET, emailsSentToday, sendEmail, type Email } from '../../lib/email';

export type DigestJob = { userId: string };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ITEMS = 10;
const DAILY_DIGEST_HOUR = 8;
/** Digests never reach further back than this, so unmuting a channel doesn't email month-old news. */
const LOOKBACK_MS = 7 * DAY;
export const UNSUBSCRIBE_PURPOSE = 'huddle:unsubscribe:v1';
const UNSUBSCRIBE_TTL_MS = 90 * DAY;

/**
 * Which notifications a digest may contain, as SQL over `n` (notification): still unread and not yet
 * emailed, recent, on a live message, in a conversation the person still belongs to and has not read
 * past, and allowed by that conversation's level (muted: nothing; mentions: mentions only).
 * Excluded notifications are left untouched rather than marked, so changing a level later behaves
 * as expected; and because this same filter decides who is due, they never trigger empty jobs.
 */
const eligible = (now: Date) => sql`
  n.read_at IS NULL AND n.emailed_at IS NULL AND n.created_at >= ${now.getTime() - LOOKBACK_MS}
  AND m.deleted_at IS NULL AND m.seq > cm.last_read_seq
  AND (cm.notify_level = 'all' OR (cm.notify_level = 'mentions' AND n.kind = 'mention'))`;

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

/** People who should get a digest this hour, oldest waiting first. */
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
    WHERE wm.status = 'active' AND COALESCE(p.digest, 'hourly') <> 'off' AND ${eligible(now)}
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

/**
 * Builds one person's digest from what is eligible right now and old enough. Returns the ids of the
 * notifications it includes (only those are marked as emailed) and the email, or no email.
 */
export async function buildDigest(db: Db, config: Config, userId: string, now: Date) {
  const prefs = await db.query.userPreference.findFirst({ where: eq(userPreference.userId, userId) });
  const cutoff = now.getTime() - (prefs?.digestDelayMin ?? 120) * 60_000;
  const items = await db.all<Item>(sql`
    SELECT n.id AS notificationId, m.id AS messageId, m.body, u.name AS authorName,
           c.id AS conversationId, c.kind AS convKind, c.name AS convName
    FROM notification n
    ${eligibleJoins}
    JOIN conversation c ON c.id = m.conversation_id
    LEFT JOIN user u ON u.id = m.author_id
    WHERE n.user_id = ${userId} AND n.created_at <= ${cutoff} AND ${eligible(now)}
    ORDER BY n.created_at
  `);
  if (!items.length) return { included: [] as string[], email: null };

  const recipient = await db.query.user.findFirst({ where: eq(user.id, userId), columns: { email: true } });
  if (!recipient) return { included: [] as string[], email: null };
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
  const unsubscribe = await unsubscribeUrl(config, userId, now);
  const count = items.length;

  const email: Email = {
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
    // Lets Gmail and others show their own one-click "Unsubscribe" button (RFC 8058).
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  return { included: items.map((i) => i.notificationId), email };
}

/**
 * - 'sent': emailed; exactly the included notifications are marked.
 * - 'nothing': nothing eligible (read meanwhile, muted, too new).
 * - 'over_budget': today's email budget is used up. Nothing is marked, so the notifications stay
 *   pending and the next day's hourly run schedules them again. The queue job is acknowledged on
 *   purpose: retrying it within the day could not succeed and would only spend queue operations.
 * Provider and configuration failures are thrown, so the queue retries them.
 */
export type DigestResult = 'sent' | 'nothing' | 'over_budget';

export async function sendDigest(
  db: Db,
  config: Config,
  userId: string,
  now = new Date(),
): Promise<DigestResult> {
  const { included, email } = await buildDigest(db, config, userId, now);
  if (!email) return 'nothing';
  // The budget slot is reserved atomically before sending (see reserveEmailSlot).
  if (!(await sendEmail(config, email, db, DIGEST_DAILY_BUDGET))) return 'over_budget';
  await db.batch([
    db.update(notification).set({ emailedAt: now }).where(inArray(notification.id, included)),
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
