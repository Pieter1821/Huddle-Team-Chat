import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { conversation, conversationMember, user, workspace, workspaceMember } from '../../db/schema';
import { conflict, forbidden } from '../../lib/errors';
import { newId } from '../../lib/id';
import { jsonBody } from '../../lib/validate';
import { requireSession, type AppEnv } from '../../middleware/context';
import { auditInsert } from '../audit/audit';
import { displayName } from '../workspace/routes';

export const setupRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const existing = await c.var.db.query.workspace.findFirst({ columns: { id: true } });
    return c.json({ needsSetup: !existing });
  })
  .post(
    '/',
    requireSession,
    jsonBody(z.object({ workspaceName: z.string().trim().min(1).max(80), yourName: displayName })),
    async (c) => {
      const { db, config, session } = c.var;
      if (session.user.email.toLowerCase() !== config.adminEmail) {
        throw forbidden('Only the configured admin email can set up this workspace.');
      }
      if (await db.query.workspace.findFirst({ columns: { id: true } })) {
        throw conflict('already_set_up', 'This workspace is already set up.');
      }

      const workspaceId = newId();
      const generalId = newId();
      const userId = session.user.id;
      const { workspaceName, yourName } = c.req.valid('json');
      try {
        // One batch: workspace, owner, #general and the audit entry exist together or not at all.
        // The workspace_singleton index makes a concurrent second setup fail instead of duplicating.
        await db.batch([
          db.insert(workspace).values({ id: workspaceId, name: workspaceName }),
          db.update(user).set({ name: yourName }).where(eq(user.id, userId)),
          db.insert(workspaceMember).values({ workspaceId, userId, role: 'owner' }),
          db.insert(conversation).values({
            id: generalId,
            workspaceId,
            kind: 'public',
            name: 'general',
            topic: 'Announcements and everyday chat for everyone',
            createdBy: userId,
          }),
          db.insert(conversationMember).values({ conversationId: generalId, userId }),
          auditInsert(db, { action: 'workspace.created', actorId: userId, targetId: workspaceId }),
        ]);
      } catch (err) {
        if (String(err).includes('UNIQUE'))
          throw conflict('already_set_up', 'This workspace is already set up.');
        throw err;
      }
      return c.json({ workspace: { id: workspaceId, name: workspaceName } }, 201);
    },
  );
