import { Hono } from 'hono';
import { emailDeliveryConfigured, sendEmail } from '../../lib/email';
import { emailBrand } from '../../lib/email-layout';
import { AppError, forbidden } from '../../lib/errors';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { testEmail } from '../auth/emails';

/** Mounted at /api/email: what the sign-in page needs to know before anyone is signed in. */
export const emailRoutes = new Hono<AppEnv>().get('/status', async (c) => {
  const { db, config } = c.var;
  return c.json({
    // Email sign-in codes can be sent (always true on this machine, where they're printed).
    ready: (await emailDeliveryConfigured(config)) || config.isLocal,
    needsSetup: !(await db.query.workspace.findFirst({ columns: { id: true } })),
  });
});

/**
 * Mounted at /api/admin/email. Email is optional (people sign in with an authenticator app); with
 * a Gmail app password set, Huddle also sends invitations, sign-in codes and email summaries.
 */
export const emailAdminRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  .use('/*', async (c, next) => {
    if (!isAdmin(c.var.actor)) throw forbidden('Only owners and admins can manage email.');
    await next();
  })
  .get('/', (c) => {
    const { config } = c.var;
    return c.json({
      appPassword: config.gmailAppPassword ? { address: config.gmailAppPassword.address } : null,
      local: config.isLocal,
    });
  })
  .post('/test', async (c) => {
    const { db, config, actor } = c.var;
    const from = config.gmailAppPassword?.address;
    if (!from) throw new AppError(400, 'email_not_configured', 'Set up a Gmail app password first.');
    await sendEmail(config, testEmail(actor.email, await emailBrand(db, config), from), { db });
    return c.json({ sentTo: actor.email });
  });
