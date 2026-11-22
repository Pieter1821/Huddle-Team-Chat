import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { file, message } from '../../db/schema';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { requireActor, type AppEnv } from '../../middleware/context';
import { canReadConversation } from '../access/access';
import { isMember, postableConversation, readableConversation } from '../conversations/service';
import { toFileDto } from './dto';
import { INLINE_MIME, cleanFileName, detectType } from './sniff';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Upload and list, mounted under /api/conversations/:id/files. */
export const conversationFileRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  /**
   * The body is the raw file; its name travels URL-encoded in X-File-Name. Size is checked from
   * Content-Length before anything is read, then the real type is detected from the bytes.
   */
  .post('/:id/files', async (c) => {
    const { db, actor } = c.var;
    const conv = await postableConversation(db, actor, c.req.param('id'));
    if (!(await isMember(db, conv.id, actor.userId))) throw forbidden('Join the channel to share files.');

    const declared = Number(c.req.header('content-length'));
    if (!Number.isFinite(declared) || declared <= 0) {
      throw new AppError(411, 'length_required', 'Uploads must say how big they are.');
    }
    if (declared > MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'too_large', `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }

    let rawName = c.req.header('x-file-name') ?? 'file';
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
      // Malformed encoding: keep the raw header value, which cleanFileName still sanitises.
    }
    const name = cleanFileName(rawName);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) throw new AppError(400, 'empty_file', 'That file is empty.');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'too_large', `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    const { mime } = detectType(bytes.subarray(0, 4096), name);

    const id = newId();
    // Random key, never the file name: a name like "../../x" cannot reach anything else.
    const r2Key = `files/${conv.id}/${id}`;
    await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
    try {
      await db.insert(file).values({
        id,
        workspaceId: actor.workspaceId,
        conversationId: conv.id,
        uploaderId: actor.userId,
        r2Key,
        name,
        mime,
        size: bytes.byteLength,
        status: 'ready',
      });
    } catch (err) {
      await c.env.FILES.delete(r2Key); // don't leave an orphan object behind
      throw err;
    }
    return c.json({ file: { id, name, mime, size: bytes.byteLength } }, 201);
  })

  // Everything shared in a conversation, newest first (only files attached to live messages).
  .get('/:id/files', async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    const rows = await db
      .select({ f: file, messageId: message.id })
      .from(file)
      .innerJoin(message, eq(message.id, file.messageId))
      .where(and(eq(file.conversationId, conv.id), isNotNull(file.messageId), isNull(message.deletedAt)))
      .orderBy(desc(file.createdAt))
      .limit(200);
    return c.json({ files: rows.map((r) => ({ ...toFileDto(r.f), messageId: r.messageId })) });
  });

/** Downloads, mounted under /api/files. */
export const fileRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  /**
   * Every download is authorised: you must be able to read the conversation, and the file must be
   * on a message that still exists (or be your own upload that you haven't sent yet). Anything else
   * is a 404, so file ids reveal nothing.
   */
  .get('/:id', async (c) => {
    const { db, actor } = c.var;
    const f = await db.query.file.findFirst({ where: eq(file.id, c.req.param('id')) });
    if (!f || f.workspaceId !== actor.workspaceId) throw notFound('That file');
    if (!(await canReadConversation(db, actor, f.conversationId))) throw notFound('That file');
    if (f.messageId) {
      const msg = await db.query.message.findFirst({
        where: eq(message.id, f.messageId),
        columns: { deletedAt: true },
      });
      if (!msg || msg.deletedAt) throw notFound('That file');
    } else if (f.uploaderId !== actor.userId) {
      throw notFound('That file');
    }

    const object = await c.env.FILES.get(f.r2Key);
    if (!object) throw notFound('That file');

    const wantsInline = c.req.query('inline') === '1' && INLINE_MIME.has(f.mime);
    const encoded = encodeURIComponent(f.name);
    return new Response(object.body, {
      headers: {
        'content-type': f.mime,
        'content-length': String(f.size),
        // RFC 6266: a plain ASCII fallback plus the exact UTF-8 name.
        'content-disposition': `${wantsInline ? 'inline' : 'attachment'}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        'x-content-type-options': 'nosniff',
        // Even a file opened in the browser can never run scripts or load anything.
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'private, max-age=300',
        'cross-origin-resource-policy': 'same-origin',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  });
