import { desc, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditLog } from '../../db/schema';
import { forbidden } from '../../lib/errors';
import { queryParams } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';

export const auditRoutes = new Hono<AppEnv>().get(
  '/',
  requireActor,
  queryParams(
    z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.string().optional(), // an entry id: ULIDs sort by time, so they work as a cursor
    }),
  ),
  async (c) => {
    const { actor, db } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can see the security log.');
    const { limit, before } = c.req.valid('query');
    const entries = await db
      .select()
      .from(auditLog)
      .where(before ? lt(auditLog.id, before) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(limit);
    return c.json({ entries, nextBefore: entries.length === limit ? entries.at(-1)?.id : null });
  },
);
