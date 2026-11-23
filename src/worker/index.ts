import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { ConfigError } from './config';
import { AppError } from './lib/errors';
import { withServices, type AppEnv } from './middleware/context';
import { requireSameOrigin } from './middleware/origin';
import { queue, scheduled } from './jobs';
import type { NotificationJob } from './jobs';
import {
  conversationNotificationRoutes,
  preferenceRoutes,
  unsubscribeRoutes,
} from './modules/notifications/routes';
import { activityRoutes } from './modules/activity/routes';
import { usageRoutes } from './modules/admin/usage';
import { auditRoutes } from './modules/audit/routes';
import { exportRoutes } from './modules/export/routes';
import { importRoutes } from './modules/import/routes';
import { brandingRoutes, logoRoutes } from './modules/branding/routes';
import { conversationWebhookRoutes, incomingHookRoutes, webhookRoutes } from './modules/webhooks/routes';
import { conversationRoutes } from './modules/conversations/routes';
import { conversationFileRoutes, fileRoutes } from './modules/files/routes';
import { realtimeRoutes } from './modules/realtime/routes';
import { emailAdminRoutes, emailRoutes } from './modules/email/routes';
import { pushRoutes } from './modules/push/routes';
import { searchRoutes } from './modules/search/routes';
import { invitationRoutes } from './modules/invitations/routes';
import { memberRoutes } from './modules/members/routes';
import { setupRoutes } from './modules/setup/routes';
import { meRoutes, workspaceRoutes } from './modules/workspace/routes';

const app = new Hono<AppEnv>().basePath('/api');

// The API only ever returns JSON, so its policy can deny everything else outright.
app.use(
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    referrerPolicy: 'no-referrer',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  }),
);

// Private workspace data must never be indexed by search engines.
app.use(async (c, next) => {
  await next();
  c.header('X-Robots-Tag', 'noindex, nofollow');
});

app.get('/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ status: row?.ok === 1 ? 'ok' : 'degraded' });
});

app.use(withServices);

// Better Auth owns /api/auth/* and checks the Origin of those requests itself (trustedOrigins).
app.on(['GET', 'POST'], '/auth/*', (c) => c.var.auth.handler(c.req.raw));

// Mail apps send one-click unsubscribes without an Origin, so this route sits before the guard; it is
// protected by its signed link instead.
app.route('/unsubscribe', unsubscribeRoutes);
// Other tools post here with no session or Origin; the secret token in the URL is the credential.
app.route('/hooks', incomingHookRoutes);

// Everything else: state-changing requests must come from Huddle's own origin (CSRF protection).
app.use(requireSameOrigin);

app.route('/setup', setupRoutes);
app.route('/me/preferences', preferenceRoutes);
app.route('/me', meRoutes);
app.route('/workspace', workspaceRoutes);
app.route('/workspace', logoRoutes);
app.route('/branding', brandingRoutes);
app.route('/webhooks', webhookRoutes);
app.route('/invitations', invitationRoutes);
app.route('/members', memberRoutes);
app.route('/admin/audit', auditRoutes);
app.route('/admin/usage', usageRoutes);
app.route('/admin/email', emailAdminRoutes);
app.route('/email', emailRoutes);
app.route('/import', importRoutes);
app.route('/export', exportRoutes);
app.route('/conversations', conversationRoutes);
app.route('/conversations', conversationFileRoutes);
app.route('/conversations', conversationNotificationRoutes);
app.route('/conversations', conversationWebhookRoutes);
app.route('/files', fileRoutes);
app.route('/search', searchRoutes);
app.route('/realtime', realtimeRoutes);
app.route('/activity', activityRoutes);
app.route('/push', pushRoutes);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

// Never leak stack traces or database details to clients; log them for operators instead.
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
  }
  if (err instanceof ConfigError) {
    // Names of settings only, never their values: tells whoever is setting Huddle up what to fix.
    console.error(err.message);
    return c.json(
      {
        error: {
          code: 'setup_incomplete',
          message: `Huddle isn’t fully set up yet: check ${err.settings.join(', ')} in Cloudflare (Workers & Pages › your Worker › Settings › Variables and Secrets).`,
          settings: err.settings,
        },
      },
      503,
    );
  }
  console.error('unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

// Durable Object classes must be exported from the Worker entry point.
export { ConversationRoom } from './realtime/conversation-room';
export { WorkspaceHub } from './realtime/workspace-hub';

export default {
  fetch: app.fetch,
  scheduled,
  queue,
} satisfies ExportedHandler<Env, NotificationJob>;
