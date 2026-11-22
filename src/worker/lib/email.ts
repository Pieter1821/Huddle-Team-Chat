import type { Config } from '../config';
import { AppError } from './errors';

export type Email = { to: string; subject: string; text: string; html: string };

/**
 * Sends through Resend when a key is configured. Running locally without one, the email is printed
 * to the terminal so sign-in works during development; anywhere else that is an error, because
 * printing sign-in codes into production logs would be a security hole.
 */
export async function sendEmail(config: Config, email: Email): Promise<void> {
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
    }),
  });
  if (!res.ok) {
    // Log the status only: the response may echo the recipient or the message.
    console.error('email send failed', res.status);
    throw new AppError(502, 'email_failed', 'The email could not be sent. Try again shortly.');
  }
}
