import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { AppError } from './lib/errors';
import { withServices, type AppEnv } from './middleware/context';
import { requireSameOrigin } from './middleware/origin';
import { activityRoutes } from './modules/activity/routes';
import { auditRoutes } from './modules/audit/routes';
import { conversationRoutes } from './modules/conversations/routes';
import { realtimeRoutes } from './modules/realtime/routes';
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

// Everything else: state-changing requests must come from Huddle's own origin (CSRF protection).
app.use(requireSameOrigin);

app.route('/setup', setupRoutes);
app.route('/me', meRoutes);
app.route('/workspace', workspaceRoutes);
app.route('/invitations', invitationRoutes);
app.route('/members', memberRoutes);
app.route('/admin/audit', auditRoutes);
app.route('/conversations', conversationRoutes);
app.route('/realtime', realtimeRoutes);
app.route('/activity', activityRoutes);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

// Never leak stack traces or database details to clients; log them for operators instead.
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
  }
  console.error('unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

// Durable Object classes must be exported from the Worker entry point.
export { ConversationRoom } from './realtime/conversation-room';
export { WorkspaceHub } from './realtime/workspace-hub';

export default app;
