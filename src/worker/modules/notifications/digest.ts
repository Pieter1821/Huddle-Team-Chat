import { eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { notification, user, userPreference } from '../../db/schema';
import { sign } from '../../lib/crypto';
import { DIGEST_DAILY_BUDGET, emailsSentToday, sendEmail, type Email } from '../../lib/email';

export type DigestJob = { userId: string };

const HOUR = 60 * 60 * 1000;
const MAX_ITEMS = 10;
const DAILY_DIGEST_HOUR = 8;

type Candidate = {
  userId: string;
  digest: 'hourly' | 'daily';
  delayMin: number;
  timezone: string;
  pausedUntil: number | null;
  lastDigestAt: number | null;
  oldest: number;
};

function localHour(timezone: string, now: Date): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now),
    );
  } catch {
    return now.getUTCHours();
  }
}

/**
 * People who should get a digest this hour, oldest waiting first. Coarse on purpose: the precise
 * rules (membership, muting, deleted messages) are applied again when each digest is built.
 */
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
    JOIN notification n ON n.user_id = wm.user_id AND n.read_at IS NULL AND n.emailed_at IS NULL
    WHERE wm.status = 'active' AND COALESCE(p.digest, 'hourly') <> 'off'
    GROUP BY wm.user_id
  `);
  const t = now.getTime();
  return candidates
    .filter((c) => !(c.pausedUntil && c.pausedUntil > t)) // Do Not Disturb
    .filter((c) => c.oldest <= t - c.delayMin * 60_000) // waited long enough unread
    .filter((c) =>
      c.digest === 'hourly'
        ? !c.lastDigestAt || c.lastDigestAt <= t - 55 * 60_000
        : localHour(c.timezone, now) === DAILY_DIGEST_HOUR &&
          (!c.lastDigestAt || c.lastDigestAt <= t - 20 * HOUR),
    )
    .sort((a, b) => a.oldest - b.oldest)
    .map((c) => c.userId);
}

type Item = {
  notificationId: string;
  kind: 'mention' | 'dm' | 'thread_reply';
  messageId: string;
  body: string;
  authorName: string | null;
  conversationId: string;
  convKind: string;
  convName: string | null;
  level: 'all' | 'mentions' | 'muted';
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

export const unsubscribeUrl = async (config: Config, userId: string) =>
  `${config.appUrl}/api/unsubscribe?u=${encodeURIComponent(userId)}&t=${await sign(config.authSecret, `unsubscribe:${userId}`)}`;

/**
 * Builds one person's digest from what is still unread right now. Muted conversations send nothing,
 * "mentions only" conversations send only mentions, and conversations the person has left or
 * messages that were deleted are skipped. Returns every notification it looked at (so they are
 * handled once) and the email, or no email when nothing qualifies.
 */
export async function buildDigest(db: Db, config: Config, userId: string, now: Date) {
  const prefs = await db.query.userPreference.findFirst({ where: eq(userPreference.userId, userId) });
  const cutoff = now.getTime() - (prefs?.digestDelayMin ?? 120) * 60_000;
  const rows = await db.all<Item>(sql`
    SELECT n.id AS notificationId, n.kind, m.id AS messageId, m.body,
           u.name AS authorName, c.id AS conversationId, c.kind AS convKind, c.name AS convName,
           cm.notify_level AS level
    FROM notification n
    JOIN message m ON m.id = n.message_id AND m.deleted_at IS NULL
    JOIN conversation c ON c.id = m.conversation_id
    JOIN conversation_member cm ON cm.conversation_id = c.id AND cm.user_id = n.user_id
    LEFT JOIN user u ON u.id = m.author_id
    WHERE n.user_id = ${userId} AND n.read_at IS NULL AND n.emailed_at IS NULL
      AND n.created_at <= ${cutoff} AND m.seq > cm.last_read_seq
    ORDER BY n.created_at
  `);
  const handled = rows.map((r) => r.notificationId);
  const items = rows.filter((r) => r.level === 'all' || (r.level === 'mentions' && r.kind === 'mention'));
  if (!items.length) return { handled, email: null };

  const recipient = await db.query.user.findFirst({ where: eq(user.id, userId), columns: { email: true } });
  if (!recipient) return { handled, email: null };
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
  const unsubscribe = await unsubscribeUrl(config, userId);
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
  return { handled, email };
}

export type DigestResult = 'sent' | 'nothing' | 'over_budget';

/**
 * Sends one digest. The email goes first and only then are the notifications marked, so a failure
 * leaves them pending for a retry; marking makes a repeated job send nothing twice.
 */
export async function sendDigest(
  db: Db,
  config: Config,
  userId: string,
  now = new Date(),
): Promise<DigestResult> {
  if ((await emailsSentToday(db, now)) >= DIGEST_DAILY_BUDGET) return 'over_budget';
  const { handled, email } = await buildDigest(db, config, userId, now);
  if (email) await sendEmail(config, email, db);
  if (handled.length) {
    await db.update(notification).set({ emailedAt: now }).where(inArray(notification.id, handled));
  }
  if (!email) return 'nothing';
  await db
    .insert(userPreference)
    .values({ userId, lastDigestAt: now })
    .onConflictDoUpdate({ target: userPreference.userId, set: { lastDigestAt: now } });
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
