import { Hono, type Context } from 'hono';
import { AppError, forbidden } from '../../lib/errors';
import { requireActor, type AppEnv } from '../../middleware/context';
import { hubFor } from '../../realtime/workspace-hub';
import { readableConversation, roomFor } from '../conversations/service';

/**
 * Checks for a WebSocket upgrade. Browsers do NOT apply same-origin rules to WebSockets and do send
 * cookies, so without the Origin check any website could open a socket as the signed-in user
 * (cross-site WebSocket hijacking).
 */
function assertSocketRequest(c: Context<AppEnv>) {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new AppError(426, 'upgrade_required', 'This endpoint only accepts WebSocket connections.');
  }
  if (c.req.header('origin') !== c.var.config.appUrl)
    throw forbidden('Cross-site connections are not allowed.');
}

/** Forwards the upgrade with the identity the Worker verified, overwriting anything the client sent. */
function forward(c: Context<AppEnv>, extra: Record<string, string>) {
  const headers = new Headers(c.req.raw.headers);
  for (const key of [...headers.keys()]) if (key.startsWith('x-huddle-')) headers.delete(key);
  headers.set('x-huddle-user-id', c.var.actor.userId);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Request(c.req.url, { headers });
}

export const realtimeRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  // The workspace socket: presence and badge pings for every conversation you belong to.
  .get('/socket', (c) => {
    assertSocketRequest(c);
    return hubFor(c.env).fetch(forward(c, {}));
  })

  // A conversation socket: live events for one conversation, replayed from ?after=<seq>.
  .get('/conversations/:id/socket', async (c) => {
    assertSocketRequest(c);
    const conv = await readableConversation(c.var.db, c.var.actor, c.req.param('id'));
    return roomFor(c.env, conv.id).fetch(forward(c, { 'x-huddle-conversation-id': conv.id }));
  });
