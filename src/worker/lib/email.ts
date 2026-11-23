import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { sendWithAppPassword } from '../modules/email/smtp';
import { AppError } from './errors';

export type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe on digests. */
  headers?: Record<string, string>;
};

/**
 * A replacement delivery method, used by tests. It receives the sender address and an optional
 * idempotency key. Normally email goes through the team's connected Gmail account instead.
 */
export type EmailTransport = (
  email: Email & { from: string },
  options: { idempotencyKey?: string | undefined },
) => Promise<void>;

let transport: EmailTransport | null = null;

/** Plugs in (or removes) a fake delivery method (tests). */
export function useEmailTransport(next: EmailTransport | null): void {
  transport = next;
}

/** Whether emails really leave the Worker: a Gmail app password is set (false locally without it). */
export async function emailDeliveryConfigured(config: Config): Promise<boolean> {
  return Promise.resolve(Boolean(transport || config.gmailAppPassword));
}

/** Daily email budget for digests, leaving room within it for sign-in codes. */
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

async function deliver(config: Config, email: Email, idempotencyKey: string | undefined): Promise<void> {
  if (transport) {
    await transport({ ...email, from: config.emailFrom }, { idempotencyKey });
    return;
  }
  if (config.gmailAppPassword) {
    await sendWithAppPassword(config, email);
    return;
  }
  // No delivery method yet. On this machine the email is printed so sign-in works during
  // development; anywhere else that is an error, because printing sign-in codes into production
  // logs would be a security hole.
  if (config.isLocal) {
    console.warn(`
[email] to: ${email.to}
[email] subject: ${email.subject}
${email.text}
`);
    return;
  }
  throw new AppError(503, 'email_not_configured', 'Email is not set up for this workspace yet.');
}

export type SendOptions = {
  /** Count the email against today's usage (and enforce `limit`). */
  db?: Db | undefined;
  /** Refuse the send once this many emails have gone out today. */
  limit?: number | null | undefined;
  /** Passed to the transport so a retry of the same message is delivered at most once. */
  idempotencyKey?: string | undefined;
};

/**
 * Sends an email. With a database, the email is counted against today's usage first (see
 * reserveEmailSlot) and the slot is given back if delivery fails. Returns false when the daily
 * limit refused the send.
 */
export async function sendEmail(config: Config, email: Email, options: SendOptions = {}): Promise<boolean> {
  const { db, limit = null, idempotencyKey } = options;
  if (db && !(await reserveEmailSlot(db, limit))) return false;
  try {
    await deliver(config, email, idempotencyKey);
  } catch (err) {
    if (db) await releaseEmailSlot(db);
    throw err;
  }
  return true;
}
