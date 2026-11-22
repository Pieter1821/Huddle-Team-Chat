import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { AppError } from './errors';

export type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe on digests. */
  headers?: Record<string, string>;
};

/** The free email plan allows about 100 a day; digests stop at this many so sign-in codes always fit. */
export const DIGEST_DAILY_BUDGET = 80;

const today = (now = new Date()) => now.toISOString().slice(0, 10);

export async function emailsSentToday(db: Db, now = new Date()): Promise<number> {
  const row = await db.get<{ sent: number }>(sql`SELECT sent FROM email_usage WHERE day = ${today(now)}`);
  return row?.sent ?? 0;
}

/**
 * Claims one email slot for today BEFORE sending, in a single statement, so it is atomic: when two
 * senders race for the last slot, SQLite lets exactly one of them have it. Counting before sending
 * also means a failed count can never cause the same email to be sent twice.
 * With no limit (sign-in codes) the slot is always granted; it is still counted.
 */
export async function reserveEmailSlot(db: Db, limit: number | null, now = new Date()): Promise<boolean> {
  const day = today(now);
  await db.run(sql`INSERT INTO email_usage (day, sent) VALUES (${day}, 0) ON CONFLICT(day) DO NOTHING`);
  const row = await db.get<{ sent: number }>(sql`
    UPDATE email_usage SET sent = sent + 1
    WHERE day = ${day} ${limit === null ? sql`` : sql`AND sent < ${limit}`}
    RETURNING sent`);
  return row !== undefined;
}

/** Gives a slot back when the send failed after it was reserved. */
async function releaseEmailSlot(db: Db, now = new Date()): Promise<void> {
  await db.run(sql`UPDATE email_usage SET sent = max(sent - 1, 0) WHERE day = ${today(now)}`);
}

async function deliver(config: Config, email: Email): Promise<void> {
  if (!config.email) {
    if (config.isLocal) {
      console.warn(`\n[email] to: ${email.to}\n[email] subject: ${email.subject}\n${email.text}\n`);
      return;
    }
    throw new AppError(503, 'email_not_configured', 'Email is not set up for this workspace yet.');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.email.from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(email.headers ? { headers: email.headers } : {}),
    }),
  });
  if (!res.ok) {
    // Log the status only: the response may echo the recipient or the message.
    console.error('email send failed', res.status);
    throw new AppError(502, 'email_failed', 'The email could not be sent. Try again shortly.');
  }
}

/**
 * Sends through Resend when a key is configured. Running locally without one, the email is printed
 * to the terminal so sign-in works during development; anywhere else that is an error, because
 * printing sign-in codes into production logs would be a security hole.
 *
 * With a database, the email is counted against today's usage first (see reserveEmailSlot); pass
 * `limit` to refuse the send once that many emails have gone out today. Returns false when refused.
 */
export async function sendEmail(
  config: Config,
  email: Email,
  db?: Db,
  limit: number | null = null,
): Promise<boolean> {
  if (db && !(await reserveEmailSlot(db, limit))) return false;
  try {
    await deliver(config, email);
  } catch (err) {
    if (db) await releaseEmailSlot(db);
    throw err;
  }
  return true;
}
