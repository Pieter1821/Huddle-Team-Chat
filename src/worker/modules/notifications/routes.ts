import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { conversationMember, userPreference } from '../../db/schema';
import { verify } from '../../lib/crypto';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isMember, readableConversation } from '../conversations/service';
import { UNSUBSCRIBE_PURPOSE } from './digest';

const DEFAULTS = { digest: 'hourly' as const, digestDelayMin: 120, timezone: 'UTC', pausedUntil: null };

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Mounted at /api/me/preferences. */
export const preferenceRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  .get('/', async (c) => {
    const { db, actor } = c.var;
    const prefs = await db.query.userPreference.findFirst({ where: eq(userPreference.userId, actor.userId) });
    return c.json({
      preferences: prefs
        ? {
            digest: prefs.digest,
            digestDelayMin: prefs.digestDelayMin,
            timezone: prefs.timezone,
            pausedUntil: prefs.pausedUntil?.toISOString() ?? null,
          }
        : DEFAULTS,
    });
  })
  .patch(
    '/',
    jsonBody(
      z
        .object({
          digest: z.enum(['hourly', 'daily', 'off']).optional(),
          // How long a notification may sit unread before it is emailed: 15 minutes to a day.
          digestDelayMin: z.number().int().min(15).max(1440).optional(),
          timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone.').optional(),
          // Do Not Disturb until this moment; null switches it off.
          pausedUntil: z.iso.datetime().nullable().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update.'),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const body = c.req.valid('json');
      const changes = {
        ...(body.digest !== undefined ? { digest: body.digest } : {}),
        ...(body.digestDelayMin !== undefined ? { digestDelayMin: body.digestDelayMin } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.pausedUntil !== undefined
          ? { pausedUntil: body.pausedUntil ? new Date(body.pausedUntil) : null }
          : {}),
      };
      await db
        .insert(userPreference)
        .values({ userId: actor.userId, ...changes })
        .onConflictDoUpdate({ target: userPreference.userId, set: changes });
      return c.json({ preferences: changes });
    },
  );

/** Mounted at /api/conversations: per-conversation notification level. */
export const conversationNotificationRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  .patch(
    '/:id/notifications',
    jsonBody(z.object({ level: z.enum(['all', 'mentions', 'muted']) })),
    async (c) => {
      const { db, actor } = c.var;
      const conv = await readableConversation(db, actor, c.req.param('id'));
      if (!(await isMember(db, conv.id, actor.userId))) throw forbidden('Join the conversation first.');
      const { level } = c.req.valid('json');
      await db
        .update(conversationMember)
        .set({ notifyLevel: level })
        .where(
          and(eq(conversationMember.conversationId, conv.id), eq(conversationMember.userId, actor.userId)),
        );
      return c.json({ level });
    },
  );

/**
 * One-click unsubscribe from digest emails, without signing in. The link carries an HMAC of the user
 * id made with the server secret, so it cannot be forged for someone else. GET is the link in the
 * email; POST is what mail apps send for their own "Unsubscribe" button (RFC 8058), so this route is
 * mounted before the same-origin guard.
 */
export const unsubscribeRoutes = new Hono<AppEnv>().on(['GET', 'POST'], '/', async (c) => {
  const { db, config } = c.var;
  const userId = c.req.query('u') ?? '';
  const expires = c.req.query('e') ?? '';
  const token = c.req.query('t') ?? '';
  // The signature covers the user id and the expiry together, with the unsubscribe-only key.
  if (
    !userId ||
    !/^\d{1,12}$/.test(expires) ||
    !token ||
    !(await verify(config.authSecret, UNSUBSCRIBE_PURPOSE, `${userId}.${expires}`, token))
  ) {
    throw notFound('That unsubscribe link');
  }
  if (Number(expires) * 1000 < Date.now()) {
    throw new AppError(410, 'link_expired', 'This link has expired. Sign in to change your email settings.');
  }
  await db
    .insert(userPreference)
    .values({ userId, digest: 'off' })
    .onConflictDoUpdate({ target: userPreference.userId, set: { digest: 'off' } });
  if (c.req.method === 'POST') return c.body(null, 204);
  return c.html(
    '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>' +
      '<p>You won’t get Huddle email summaries any more. You can turn them back on in your settings.</p>',
  );
});
