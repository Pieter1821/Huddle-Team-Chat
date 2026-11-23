import { z } from 'zod';

// Empty strings in .dev.vars mean "not set" for the optional integrations.
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  APP_URL: z.url({ message: 'APP_URL must be the full URL Huddle is served from' }),
  ADMIN_EMAIL: z.email({ message: 'ADMIN_EMAIL must be the email address of the first owner' }),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  EMAIL_FROM: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GMAIL_CLIENT_ID: optional,
  GMAIL_CLIENT_SECRET: optional,
});

export type Config = {
  appUrl: string;
  adminEmail: string;
  authSecret: string;
  /** True when running on this machine: emails print to the terminal instead of failing. */
  isLocal: boolean;
  /** Sender address for outgoing email (the delivery transport itself is chosen in lib/email.ts). */
  emailFrom: string;
  google: { clientId: string; clientSecret: string } | null;
  /** The OAuth client for sending email through the team's own Gmail (Admin > Email). */
  gmail: { clientId: string; clientSecret: string } | null;
  /** The display name on outgoing email (the address is the connected Gmail account). */
  emailName: string;
};

export function getConfig(env: Env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Huddle is misconfigured: ${problems}`);
  }
  const v = parsed.data;
  const host = new URL(v.APP_URL).hostname;
  return {
    appUrl: v.APP_URL.replace(/\/$/, ''),
    adminEmail: v.ADMIN_EMAIL.toLowerCase(),
    authSecret: v.BETTER_AUTH_SECRET,
    isLocal: host === 'localhost' || host === '127.0.0.1',
    emailFrom: v.EMAIL_FROM ?? `Huddle <no-reply@${host}>`,
    google:
      v.GOOGLE_CLIENT_ID && v.GOOGLE_CLIENT_SECRET
        ? { clientId: v.GOOGLE_CLIENT_ID, clientSecret: v.GOOGLE_CLIENT_SECRET }
        : null,
    gmail:
      v.GMAIL_CLIENT_ID && v.GMAIL_CLIENT_SECRET
        ? { clientId: v.GMAIL_CLIENT_ID, clientSecret: v.GMAIL_CLIENT_SECRET }
        : null,
    emailName: (/^\s*"?([^"<]+?)"?\s*</.exec(v.EMAIL_FROM ?? '')?.[1] ?? 'Huddle').trim(),
  };
}
