import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { workspaceMember } from '../../db/schema';
import { randomToken } from '../../lib/crypto';
import { emailDeliveryConfigured, sendEmail } from '../../lib/email';
import { emailBrand } from '../../lib/email-layout';
import { testEmail } from '../auth/emails';
import { AppError, forbidden } from '../../lib/errors';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { recordAudit, requestMeta } from '../audit/audit';
import { authorizationUrl, exchangeCode, getAccount, redirectUri, removeAccount, saveAccount } from './gmail';

const STATE_COOKIE = 'huddle_gmail_state';
const STATE_PATH = '/api/email/google';

const isSetUp = async (c: Context<AppEnv>) =>
  Boolean(await c.var.db.query.workspace.findFirst({ columns: { id: true } }));

/** Email works right now: an app password is set, or Gmail is connected and Google still accepts it. */
const emailWorks = async (c: Context<AppEnv>) => {
  if (c.var.config.gmailAppPassword) return true;
  const account = await getAccount(c.var.db);
  return Boolean(account && !account.needsReconnectAt);
};

/** The signed-in owner or admin, or null. */
async function adminSession(c: Context<AppEnv>) {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const member = await c.var.db.query.workspaceMember.findFirst({
    where: and(eq(workspaceMember.userId, session.user.id), eq(workspaceMember.status, 'active')),
  });
  return member && (member.role === 'owner' || member.role === 'admin') ? session.user : null;
}

/**
 * Mounted at /api/email. Connecting Gmail:
 * - while email works, only a signed-in owner or admin can change it;
 * - while it doesn't (a brand-new install, or Google withdrew access), nobody can get a sign-in
 *   code, so anyone may start connecting, but Huddle only accepts the Google account of the
 *   configured admin email, or the same mailbox that was connected before. Otherwise whoever found
 *   the site first could connect their own Gmail and read every sign-in code in its Sent folder.
 */
export const emailRoutes = new Hono<AppEnv>()
  // What the sign-in page needs to know: whether sign-in codes can be sent at all.
  .get('/status', async (c) => {
    const { db, config } = c.var;
    const account = await getAccount(db);
    return c.json({
      ready: (await emailDeliveryConfigured(db, config)) || config.isLocal,
      gmail: config.gmailAppPassword
        ? 'app-password'
        : account
          ? account.needsReconnectAt
            ? 'needs-reconnect'
            : 'connected'
          : 'not-connected',
      canConnect: Boolean(config.gmail),
      needsSetup: !(await isSetUp(c)),
    });
  })

  .get('/google/start', async (c) => {
    const { config } = c.var;
    if (!config.gmail)
      throw new AppError(503, 'gmail_not_configured', 'Gmail is not set up for this server.');
    if ((await emailWorks(c)) && !(await adminSession(c))) {
      throw forbidden('Only owners and admins can connect Gmail.');
    }
    // Ties Google's answer to this browser: the same random value must come back in the callback.
    const state = randomToken();
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: !config.isLocal,
      sameSite: 'Lax', // sent on Google's redirect back (a top-level navigation)
      path: STATE_PATH,
      maxAge: 600,
    });
    return c.redirect(authorizationUrl(config, state), 302);
  })

  .get('/google/callback', async (c) => {
    const { db, config } = c.var;
    const back = (await adminSession(c)) ? '/admin/email' : '/signin';
    const done = (result: string) => c.redirect(`${back}?gmail=${result}`, 302);

    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: STATE_PATH });
    const state = c.req.query('state');
    if (!expected || !state || state !== expected) return done('expired');
    if (c.req.query('error')) return done('denied');
    const code = c.req.query('code');
    if (!code) return done('failed');

    let connected: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      connected = await exchangeCode(config, code);
    } catch (err) {
      return done(err instanceof AppError && err.code === 'gmail_scope_missing' ? 'scope' : 'failed');
    }

    const admin = await adminSession(c);
    const previous = await getAccount(db);
    const working = Boolean(previous && !previous.needsReconnectAt);
    if (working && !admin) return done('forbidden');
    if (!admin && connected.address !== config.adminEmail && connected.address !== previous?.address) {
      return done('wrong-account');
    }
    const actorId = admin?.id ?? null;
    await saveAccount(db, config, {
      address: connected.address,
      refreshToken: connected.refreshToken,
      connectedBy: actorId,
    });
    await recordAudit(db, {
      ...requestMeta(c),
      action: 'email.connected',
      actorId,
      meta: { address: connected.address },
    });
    return done('connected');
  });

/** Mounted at /api/admin/email: the Email section of the admin area. */
export const emailAdminRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  .use('/*', async (c, next) => {
    if (!isAdmin(c.var.actor)) throw forbidden('Only owners and admins can manage email.');
    await next();
  })
  .get('/', async (c) => {
    const { db, config } = c.var;
    const account = await getAccount(db);
    return c.json({
      account: account
        ? {
            address: account.address,
            connectedAt: account.connectedAt.toISOString(),
            needsReconnect: Boolean(account.needsReconnectAt),
          }
        : null,
      appPassword: config.gmailAppPassword ? { address: config.gmailAppPassword.address } : null,
      canConnect: Boolean(config.gmail),
      redirectUri: redirectUri(config),
      local: config.isLocal,
    });
  })
  .post('/test', async (c) => {
    const { db, config, actor } = c.var;
    const from = config.gmailAppPassword?.address ?? (await getAccount(db))?.address;
    if (!from) throw new AppError(400, 'gmail_not_connected', 'Set up Gmail first.');
    await sendEmail(config, testEmail(actor.email, await emailBrand(db, config), from), { db });
    return c.json({ sentTo: actor.email });
  })
  .post('/disconnect', async (c) => {
    const { db, actor } = c.var;
    const account = await getAccount(db);
    if (account) {
      await removeAccount(db);
      await recordAudit(db, {
        ...requestMeta(c),
        action: 'email.disconnected',
        actorId: actor.userId,
        meta: { address: account.address },
      });
    }
    return c.body(null, 204);
  });
