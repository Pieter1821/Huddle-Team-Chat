import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  CHARCOAL,
  DEFAULT_ACCENT,
  MIN_ACCENT_CONTRAST,
  contrastRatio,
  isHexColor,
} from '../../../shared/color';
import { workspace } from '../../db/schema';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { detectType } from '../files/sniff';

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Public: what the sign-in page needs before anyone is signed in. Only the name, accent and logo;
 * everything else about the workspace still needs a session.
 */
export const brandingRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const ws = await c.var.db.query.workspace.findFirst({
      columns: { name: true, accent: true, logoFileId: true },
    });
    c.header('cache-control', 'public, max-age=60');
    return c.json({
      name: ws?.name ?? 'Huddle',
      accent: ws?.accent ?? DEFAULT_ACCENT,
      // The key in the URL changes with every new logo, so caches never show a stale one.
      logoUrl: ws?.logoFileId ? `/api/branding/logo?v=${encodeURIComponent(ws.logoFileId)}` : null,
    });
  })
  .get('/logo', async (c) => {
    const ws = await c.var.db.query.workspace.findFirst({ columns: { logoFileId: true } });
    if (!ws?.logoFileId) throw notFound('A logo');
    const object = await c.env.FILES.get(ws.logoFileId);
    if (!object) throw notFound('A logo');
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });

/** Accent colours must keep button text readable: WCAG AA (4.5:1) against the charcoal text. */
export const accentSchema = z
  .string()
  .refine(isHexColor, 'Use a colour like #00b18c.')
  .refine(
    (hex) => !isHexColor(hex) || contrastRatio(hex, CHARCOAL) >= MIN_ACCENT_CONTRAST,
    `That colour is too dark for readable buttons: it needs a contrast of at least ${MIN_ACCENT_CONTRAST}:1 with the dark text.`,
  )
  .transform((hex) => hex.toLowerCase());

/** Admin: logo upload and removal, mounted under /api/workspace. */
export const logoRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  /**
   * The body is the raw image. PNG, JPEG or WebP only, detected from the bytes. No SVG: it can carry
   * scripts, and the logo is served to people who are not signed in.
   */
  .put('/logo', async (c) => {
    const { db, actor } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can change the logo.');
    const declared = Number(c.req.header('content-length'));
    if (!Number.isFinite(declared) || declared <= 0) {
      throw new AppError(411, 'length_required', 'Uploads must say how big they are.');
    }
    if (declared > MAX_LOGO_BYTES) throw new AppError(413, 'too_large', 'Logos can be up to 1 MB.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_LOGO_BYTES) throw new AppError(413, 'too_large', 'Logos can be up to 1 MB.');
    const { mime } = detectType(bytes.subarray(0, 64), 'logo');
    if (!LOGO_TYPES.has(mime)) {
      throw new AppError(415, 'unsupported_type', 'Logos must be PNG, JPEG or WebP images.');
    }

    const key = `branding/logo-${newId()}`;
    await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
    const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, actor.workspaceId) });
    // Point the workspace at the new logo first, then remove the old object: a failure in between
    // leaves an unused object, never a workspace pointing at a missing logo.
    await db.update(workspace).set({ logoFileId: key }).where(eq(workspace.id, actor.workspaceId));
    if (ws?.logoFileId) await c.env.FILES.delete(ws.logoFileId);
    return c.json({ logoUrl: `/api/branding/logo?v=${encodeURIComponent(key)}` });
  })
  .delete('/logo', async (c) => {
    const { db, actor } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can change the logo.');
    const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, actor.workspaceId) });
    await db.update(workspace).set({ logoFileId: null }).where(eq(workspace.id, actor.workspaceId));
    if (ws?.logoFileId) await c.env.FILES.delete(ws.logoFileId);
    return c.body(null, 204);
  });
