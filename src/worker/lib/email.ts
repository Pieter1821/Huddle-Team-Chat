import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { emailUsage } from '../db/schema';
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
  const row = await db.query.emailUsage.findFirst({ where: eq(emailUsage.day, today(now)) });
  return row?.sent ?? 0;
}

async function countEmail(db: Db): Promise<void> {
  await db
    .insert(emailUsage)
    .values({ day: today(), sent: 1 })
    .onConflictDoUpdate({ target: emailUsage.day, set: { sent: sql`${emailUsage.sent} + 1` } });
}

/**
 * Sends through Resend when a key is configured. Running locally without one, the email is printed
 * to the terminal so sign-in works during development; anywhere else that is an error, because
 * printing sign-in codes into production logs would be a security hole. Every email sent is counted
 * (when a database is given) so the daily budget can be enforced.
 */
export async function sendEmail(config: Config, email: Email, db?: Db): Promise<void> {
  if (!config.email) {
    if (config.isLocal) {
      console.warn(`\n[email] to: ${email.to}\n[email] subject: ${email.subject}\n${email.text}\n`);
      if (db) await countEmail(db);
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
  if (db) await countEmail(db);
}
