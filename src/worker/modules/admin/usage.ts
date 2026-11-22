import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { forbidden } from '../../lib/errors';
import { DIGEST_DAILY_BUDGET, emailsSentToday } from '../../lib/email';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { IMPORT_DAILY_MESSAGES } from '../import/routes';

/** Free-plan ceilings this page measures against. Providers can change these; check their pages. */
export const LIMITS = {
  databaseBytes: 500 * 1024 * 1024, // D1: per database on the free plan
  fileBytes: 10 * 1024 * 1024 * 1024, // R2: free storage
} as const;
const WARN_AT = 0.8;

/**
 * How close this installation is to its free limits, so the owner can see trouble coming instead of
 * finding out when writes start failing.
 */
export const usageRoutes = new Hono<AppEnv>().use('/*', requireActor).get('/', async (c) => {
  const { db, actor } = c.var;
  if (!isAdmin(actor)) throw forbidden('Only owners and admins can see usage.');

  // D1 reports the database's size in the metadata of every query result.
  const probe = await c.env.DB.prepare('SELECT 1').run();
  const databaseBytes = Number((probe.meta as { size_after?: number }).size_after ?? 0);
  const counts = await db.get<{
    fileBytes: number;
    files: number;
    messages: number;
    members: number;
    imported: number;
  }>(sql`
    SELECT (SELECT coalesce(sum(size), 0) FROM file) AS fileBytes,
           (SELECT count(*) FROM file) AS files,
           (SELECT count(*) FROM message WHERE deleted_at IS NULL) AS messages,
           (SELECT count(*) FROM workspace_member WHERE status = 'active') AS members,
           (SELECT coalesce(max(count), 0) FROM daily_counter
              WHERE kind = 'import_messages' AND day = ${new Date().toISOString().slice(0, 10)}) AS imported`);
  const emails = await emailsSentToday(db);

  const meter = (used: number, limit: number) => ({ used, limit, ratio: limit ? used / limit : 0 });
  const usage = {
    database: meter(databaseBytes, LIMITS.databaseBytes),
    files: meter(counts?.fileBytes ?? 0, LIMITS.fileBytes),
    emailsToday: meter(emails, DIGEST_DAILY_BUDGET),
    importedToday: meter(counts?.imported ?? 0, IMPORT_DAILY_MESSAGES),
  };
  const warnings = [
    usage.database.ratio >= WARN_AT && 'The database is over 80% of the free plan’s 500 MB.',
    usage.files.ratio >= WARN_AT && 'File storage is over 80% of the free plan’s 10 GB.',
    usage.emailsToday.ratio >= WARN_AT &&
      'Today’s email budget is almost used up; digests may wait until tomorrow.',
  ].filter((w): w is string => Boolean(w));

  return c.json({
    usage,
    counts: {
      files: counts?.files ?? 0,
      messages: counts?.messages ?? 0,
      activeMembers: counts?.members ?? 0,
    },
    warnings,
  });
});
