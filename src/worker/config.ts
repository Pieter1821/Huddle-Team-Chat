import { z } from 'zod';

// Empty strings in .dev.vars mean "not set" for the optional integrations.
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  // Optional: without it Huddle uses the address it's reached at (e.g. right after a one-click
  // deploy, before anyone knows the workers.dev address).
  APP_URL: z
    .union([z.literal(''), z.url({ message: 'APP_URL must be the full URL Huddle is served from' })])
    .optional(),
  ADMIN_EMAIL: z.email({ message: 'ADMIN_EMAIL must be the email address of the first owner' }),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  EMAIL_FROM: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GMAIL_ADDRESS: z
    .union([z.literal(''), z.email({ message: 'GMAIL_ADDRESS must be the Gmail address to send from' })])
    .optional(),
  GMAIL_APP_PASSWORD: optional,
});

/**
 * A required setting is missing or invalid. Carries the setting NAMES only (never values), so the
 * app can say exactly what to fix instead of "Something went wrong".
 */
export class ConfigError extends Error {
  constructor(
    readonly settings: string[],
    detail: string,
  ) {
    super(`Huddle is misconfigured: ${detail}`);
  }
}

export type Config = {
  appUrl: string;
  adminEmail: string;
  authSecret: string;
  /** True when running on this machine: emails print to the terminal instead of failing. */
  isLocal: boolean;
  /** Sender address for outgoing email (the delivery transport itself is chosen in lib/email.ts). */
  emailFrom: string;
  google: { clientId: string; clientSecret: string } | null;
  /** Sending through Gmail with an app password (the simple way): address and password. */
  gmailAppPassword: { address: string; password: string } | null;
  /** The display name on outgoing email (the address is the Gmail account). */
  emailName: string;
};

/**
 * The settings, with `origin` (the address a request arrived at, or the one stored at setup for
 * background work) used when APP_URL isn't set.
 */
export function getConfig(env: Env, origin?: string | null): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))], problems);
  }
  const v = parsed.data;
  const appUrl = v.APP_URL || origin;
  if (!appUrl) throw new ConfigError(['APP_URL'], 'APP_URL is not set and no address is known yet');
  const host = new URL(appUrl).hostname;
  return {
    appUrl: appUrl.replace(/\/$/, ''),
    adminEmail: v.ADMIN_EMAIL.toLowerCase(),
    authSecret: v.BETTER_AUTH_SECRET,
    isLocal: host === 'localhost' || host === '127.0.0.1',
    emailFrom: v.EMAIL_FROM ?? `Huddle <no-reply@${host}>`,
    google:
      v.GOOGLE_CLIENT_ID && v.GOOGLE_CLIENT_SECRET
        ? { clientId: v.GOOGLE_CLIENT_ID, clientSecret: v.GOOGLE_CLIENT_SECRET }
        : null,
    gmailAppPassword:
      v.GMAIL_ADDRESS && v.GMAIL_APP_PASSWORD
        ? {
            address: v.GMAIL_ADDRESS.toLowerCase(),
            // Google shows app passwords in groups of four ("abcd efgh ijkl mnop").
            password: v.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
          }
        : null,
    emailName: (/^\s*"?([^"<]+?)"?\s*</.exec(v.EMAIL_FROM ?? '')?.[1] ?? 'Huddle').trim(),
  };
}
