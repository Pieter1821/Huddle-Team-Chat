import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';

export type AppEnv = { Bindings: Env };

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

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

// Never leak stack traces or database details to clients; log them for operators instead.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
  }
  console.error('unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

export default app;
