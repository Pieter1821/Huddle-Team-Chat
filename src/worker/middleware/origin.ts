import { createMiddleware } from 'hono/factory';
import { forbidden } from '../lib/errors';
import type { AppEnv } from './context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for the JSON API. Hono's built-in csrf() only inspects form-style content types,
 * so JSON requests would pass unchecked. Here every state-changing request must say it came from
 * Huddle's own origin: browsers always send Origin on POST/PATCH/DELETE and a foreign site can't
 * forge it. Requests without Origin (scripts, curl) are refused; machine endpoints such as incoming
 * webhooks are mounted outside this middleware.
 */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin !== c.var.config.appUrl) throw forbidden('Cross-site requests are not allowed.');
  }
  await next();
});
