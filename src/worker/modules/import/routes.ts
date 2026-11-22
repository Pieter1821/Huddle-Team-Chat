import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import {
  conversation,
  conversationMember,
  file,
  importConversationMap,
  importSession,
  importUserMap,
  message,
  user,
  workspaceMember,
} from '../../db/schema';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import type { ImportedMessage } from '../../realtime/conversation-room';
import { auditInsert, recordAudit } from '../audit/audit';
import { normalizeChannelName, roomFor, unwrap } from '../conversations/service';
import { MAX_UPLOAD_BYTES } from '../files/routes';
import { cleanFileName, detectType } from '../files/sniff';
import { convertSlackText, emojiFromShortcode } from './slack-text';

/** Imported messages cost several database writes each; this keeps an import inside the daily limit. */
export const IMPORT_DAILY_MESSAGES = 20_000;
const PLACEHOLDER_DOMAIN = 'slack-import.invalid';
/** Housekeeping messages that carry no conversation content. */
const SKIPPED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'bot_add',
  'bot_remove',
  'pinned_item',
  'unpinned_item',
]);
/** Files are only ever fetched from Slack's own file hosts (no server-side request forgery). */
const allowedFileHost = (host: string) =>
  host === 'files.slack.com' || host === 'slack-files.com' || host.endsWith('.slack-edge.com');

const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.actor.role !== 'owner') throw forbidden('Only the workspace owner can import history.');
  await next();
});

async function openSession(db: Db, sessionId: string) {
  const session = await db.query.importSession.findFirst({ where: eq(importSession.id, sessionId) });
  if (!session) throw notFound('That import');
  if (session.status !== 'open')
    throw new AppError(409, 'import_finished', 'This import is already finished.');
  return session;
}

async function userMap(db: Db, sessionId: string, slackIds: string[]): Promise<Map<string, string>> {
  if (!slackIds.length) return new Map();
  const rows = await db
    .select({ slackId: importUserMap.slackId, userId: importUserMap.userId })
    .from(importUserMap)
    .where(
      and(eq(importUserMap.sessionId, sessionId), inArray(importUserMap.slackId, [...new Set(slackIds)])),
    );
  return new Map(rows.map((r) => [r.slackId, r.userId]));
}

/** Atomically claims room for `count` imported messages in today's budget. */
async function reserveImport(db: Db, count: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  await db.run(sql`INSERT INTO daily_counter (day, kind, count) VALUES (${day}, 'import_messages', 0)
    ON CONFLICT(day, kind) DO NOTHING`);
  const row = await db.get<{ count: number }>(sql`
    UPDATE daily_counter SET count = count + ${count}
    WHERE day = ${day} AND kind = 'import_messages' AND count + ${count} <= ${IMPORT_DAILY_MESSAGES}
    RETURNING count`);
  return row !== undefined;
}

async function releaseImport(db: Db, count: number): Promise<void> {
  if (count <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  await db.run(sql`UPDATE daily_counter SET count = max(count - ${count}, 0)
    WHERE day = ${day} AND kind = 'import_messages'`);
}

/** A free channel name: the Slack name, or name-imported, name-imported-2… if it is taken. */
async function freeName(db: Db, workspaceId: string, wanted: string): Promise<string> {
  const base = normalizeChannelName(wanted);
  const taken = new Set(
    (
      await db
        .select({ name: conversation.name })
        .from(conversation)
        .where(and(eq(conversation.workspaceId, workspaceId), like(conversation.name, `${base}%`)))
    ).map((r) => r.name),
  );
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = (i === 1 ? `${base}-imported` : `${base}-imported-${i}`).slice(0, 80);
    if (!taken.has(candidate)) return candidate;
  }
}

type BatchItem = Parameters<Db['batch']>[0][number];
/** Drizzle's batch() takes a non-empty tuple; every list built here ends with a required statement. */
const nonEmpty = (items: BatchItem[]) => items as [BatchItem, ...BatchItem[]];

const slackId = z.string().regex(/^[A-Z0-9]{2,30}$/, 'Not a Slack id.');
const ts = z.string().regex(/^\d{9,11}\.\d{1,6}$/, 'Not a Slack timestamp.');

export const importRoutes = new Hono<AppEnv>()
  .use('/*', requireActor, ownerOnly)

  .post('/', async (c) => {
    const { db, actor } = c.var;
    const id = newId();
    await db.batch([
      db.insert(importSession).values({ id, createdBy: actor.userId }),
      auditInsert(db, { action: 'import.started', actorId: actor.userId, targetId: id }),
    ]);
    return c.json({ sessionId: id, dailyMessageLimit: IMPORT_DAILY_MESSAGES }, 201);
  })

  .get('/:sid', async (c) => {
    const { db } = c.var;
    const session = await db.query.importSession.findFirst({
      where: eq(importSession.id, c.req.param('sid')),
    });
    if (!session) throw notFound('That import');
    const counts = await db.get<{ users: number; conversations: number; messages: number }>(sql`
      SELECT (SELECT count(*) FROM import_user_map WHERE session_id = ${session.id}) AS users,
             (SELECT count(*) FROM import_conversation_map WHERE session_id = ${session.id}) AS conversations,
             (SELECT count(*) FROM message m JOIN import_conversation_map icm ON icm.conversation_id = m.conversation_id
               WHERE icm.session_id = ${session.id} AND m.client_msg_id LIKE 'slack-%') AS messages`);
    return c.json({ session: { id: session.id, status: session.status }, counts });
  })

  /**
   * People, matched by email to existing accounts. Anyone unmatched becomes a deactivated placeholder
   * account: old messages keep their author, nobody can sign in as them, and if the person is invited
   * later an admin can reactivate them to link their history. At most 15 per call.
   */
  .post(
    '/:sid/users',
    jsonBody(
      z.object({
        users: z
          .array(
            z.object({
              slackId,
              name: z.string().trim().max(80).default(''),
              realName: z.string().trim().max(80).optional(),
              email: z.email().optional(),
            }),
          )
          .min(1)
          .max(15),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const session = await openSession(db, c.req.param('sid'));
      const people = c.req.valid('json').users;
      const already = await userMap(
        db,
        session.id,
        people.map((p) => p.slackId),
      );
      let mapped = 0;
      for (const p of people) {
        if (already.has(p.slackId)) continue;
        const email = (p.email ?? `${p.slackId.toLowerCase()}@${PLACEHOLDER_DOMAIN}`).toLowerCase();
        const existing = await db.query.user.findFirst({
          where: eq(user.email, email),
          columns: { id: true },
        });
        const userId = existing?.id ?? newId();
        const membership = existing
          ? await db.query.workspaceMember.findFirst({
              where: eq(workspaceMember.userId, userId),
              columns: { userId: true },
            })
          : null;
        // Order matters: foreign keys are checked per statement (user, then membership, then the map).
        await db.batch(
          nonEmpty([
            ...(existing
              ? []
              : [
                  db
                    .insert(user)
                    .values({ id: userId, name: p.realName || p.name || 'Former member', email }),
                ]),
            ...(membership
              ? []
              : [
                  db.insert(workspaceMember).values({
                    workspaceId: actor.workspaceId,
                    userId,
                    role: 'member',
                    status: 'deactivated',
                  }),
                ]),
            db.insert(importUserMap).values({ sessionId: session.id, slackId: p.slackId, userId }),
          ]),
        );
        mapped++;
      }
      return c.json({ mapped, skipped: people.length - mapped });
    },
  )

  /** Channels and DMs. Each becomes a new conversation (never merged into an existing channel). */
  .post(
    '/:sid/channels',
    jsonBody(
      z.object({
        channels: z
          .array(
            z.object({
              slackId,
              kind: z.enum(['public', 'private', 'dm', 'group_dm']),
              name: z.string().trim().max(100).optional(),
              topic: z.string().trim().max(250).optional(),
              archived: z.boolean().optional(),
              memberSlackIds: z.array(slackId).max(500).default([]),
            }),
          )
          .min(1)
          .max(10),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const session = await openSession(db, c.req.param('sid'));
      const channels = c.req.valid('json').channels;
      const members = await userMap(
        db,
        session.id,
        channels.flatMap((ch) => ch.memberSlackIds),
      );
      const done = new Map(
        (
          await db
            .select({
              slackId: importConversationMap.slackId,
              conversationId: importConversationMap.conversationId,
            })
            .from(importConversationMap)
            .where(
              and(
                eq(importConversationMap.sessionId, session.id),
                inArray(
                  importConversationMap.slackId,
                  channels.map((ch) => ch.slackId),
                ),
              ),
            )
        ).map((r) => [r.slackId, r.conversationId]),
      );

      const result: { slackId: string; conversationId: string; name: string | null }[] = [];
      for (const ch of channels) {
        const known = done.get(ch.slackId);
        if (known) {
          result.push({ slackId: ch.slackId, conversationId: known, name: null });
          continue;
        }
        const memberIds = [
          ...new Set(ch.memberSlackIds.map((id) => members.get(id)).filter((id): id is string => !!id)),
        ];
        const isDm = ch.kind === 'dm' || ch.kind === 'group_dm';
        if (isDm && !memberIds.length)
          throw badRequest('unknown_members', 'Import the people in this DM first.');
        const dmKey = isDm ? [...memberIds].sort().join(':') : null;
        const existingDm = dmKey
          ? await db.query.conversation.findFirst({
              where: and(eq(conversation.workspaceId, actor.workspaceId), eq(conversation.dmKey, dmKey)),
            })
          : undefined;

        const id = existingDm?.id ?? newId();
        const name = isDm ? null : await freeName(db, actor.workspaceId, ch.name || ch.slackId.toLowerCase());
        const inserts = existingDm
          ? []
          : [
              db.insert(conversation).values({
                id,
                workspaceId: actor.workspaceId,
                kind: isDm ? (memberIds.length > 2 ? 'group_dm' : 'dm') : ch.kind,
                name,
                topic: ch.topic || null,
                dmKey,
                createdBy: actor.userId,
                archivedAt: ch.archived ? new Date() : null,
              }),
              ...memberIds.map((userId) =>
                db.insert(conversationMember).values({ conversationId: id, userId }).onConflictDoNothing(),
              ),
              // The owner running the import joins imported channels so they can check the result.
              ...(isDm || memberIds.includes(actor.userId)
                ? []
                : [
                    db
                      .insert(conversationMember)
                      .values({ conversationId: id, userId: actor.userId })
                      .onConflictDoNothing(),
                  ]),
            ];
        // The conversation (and its members) first, then the map row that refers to it.
        await db.batch(
          nonEmpty([
            ...inserts,
            db
              .insert(importConversationMap)
              .values({ sessionId: session.id, slackId: ch.slackId, conversationId: id }),
          ]),
        );
        result.push({ slackId: ch.slackId, conversationId: id, name });
      }
      return c.json({ channels: result });
    },
  )

  /**
   * Up to 20 messages of one channel, oldest first. Slack markup is converted, threads are linked
   * through the original timestamps, common emoji reactions are kept, and housekeeping messages
   * (joins, topic changes) are skipped. Re-sending a batch is harmless.
   */
  .post(
    '/:sid/messages',
    jsonBody(
      z.object({
        channelSlackId: slackId,
        messages: z
          .array(
            z.object({
              ts,
              user: slackId.optional(),
              text: z.string().max(40_000).default(''),
              subtype: z.string().max(50).optional(),
              threadTs: ts.optional(),
              reactions: z
                .array(z.object({ name: z.string().max(100), users: z.array(slackId).max(50) }))
                .max(20)
                .optional(),
            }),
          )
          .min(1)
          .max(20),
      }),
    ),
    async (c) => {
      const { db } = c.var;
      const session = await openSession(db, c.req.param('sid'));
      const body = c.req.valid('json');
      const mapped = await db.query.importConversationMap.findFirst({
        where: and(
          eq(importConversationMap.sessionId, session.id),
          eq(importConversationMap.slackId, body.channelSlackId),
        ),
      });
      if (!mapped) throw badRequest('unknown_channel', 'Import this channel before its messages.');

      const wanted = body.messages.filter((m) => !m.subtype || !SKIPPED_SUBTYPES.has(m.subtype));
      const mentioned = wanted.flatMap((m) => [...m.text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]!));
      const users = await userMap(db, session.id, [
        ...wanted.map((m) => m.user).filter((u): u is string => !!u),
        ...wanted.flatMap((m) => (m.reactions ?? []).flatMap((r) => r.users)),
        ...mentioned,
      ]);
      const fallbackAuthor = session.createdBy;

      const messages: ImportedMessage[] = wanted
        .map((m) => ({
          clientMsgId: `slack-${m.ts}`,
          // Messages from people or bots that were not imported are attributed to the importer.
          authorId: (m.user && users.get(m.user)) || fallbackAuthor,
          body: convertSlackText(m.text, users, new Map()),
          createdAt: Math.round(Number(m.ts) * 1000),
          parentClientMsgId: m.threadTs && m.threadTs !== m.ts ? `slack-${m.threadTs}` : null,
          reactions: (m.reactions ?? [])
            .map((r) => ({
              emoji: emojiFromShortcode(r.name),
              userIds: r.users.map((u) => users.get(u)).filter((u): u is string => !!u),
            }))
            .filter(
              (r): r is { emoji: string; userIds: string[] } => r.emoji !== null && r.userIds.length > 0,
            ),
        }))
        .filter((m) => m.body.trim().length > 0)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!messages.length) return c.json({ imported: 0, skipped: body.messages.length });

      if (!(await reserveImport(db, messages.length))) {
        c.header('retry-after', '3600');
        throw new AppError(
          429,
          'import_daily_limit',
          `Today's import allowance (${IMPORT_DAILY_MESSAGES} messages) is used up. The import can continue tomorrow.`,
        );
      }
      try {
        const result = unwrap(
          await roomFor(c.env, mapped.conversationId).importMessages(mapped.conversationId, messages),
        );
        await releaseImport(db, result.skipped);
        return c.json({ imported: result.imported, skipped: body.messages.length - result.imported });
      } catch (err) {
        await releaseImport(db, messages.length);
        throw err;
      }
    },
  )

  /**
   * One file from a Slack export, fetched from Slack's own file hosts only, while its export link
   * still works. Stored privately and attached to its imported message.
   */
  .post(
    '/:sid/files',
    jsonBody(z.object({ channelSlackId: slackId, ts, name: z.string().min(1).max(255), url: z.url() })),
    async (c) => {
      const { db, actor } = c.var;
      const session = await openSession(db, c.req.param('sid'));
      const body = c.req.valid('json');
      const mapped = await db.query.importConversationMap.findFirst({
        where: and(
          eq(importConversationMap.sessionId, session.id),
          eq(importConversationMap.slackId, body.channelSlackId),
        ),
      });
      if (!mapped) throw badRequest('unknown_channel', 'Import this channel before its files.');
      const msg = await db.query.message.findFirst({
        where: and(
          eq(message.conversationId, mapped.conversationId),
          eq(message.clientMsgId, `slack-${body.ts}`),
        ),
      });
      if (!msg) throw badRequest('unknown_message', 'Import the message before its files.');

      const res = await fetchSlackFile(body.url);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new AppError(413, 'too_large', 'Files can be up to 25 MB.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new AppError(413, 'too_large', 'Files can be up to 25 MB.');
      }
      const name = cleanFileName(body.name);
      const { mime } = detectType(bytes.subarray(0, 4096), name);
      const id = newId();
      const r2Key = `files/${mapped.conversationId}/${id}`;
      await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
      try {
        await db.insert(file).values({
          id,
          workspaceId: actor.workspaceId,
          conversationId: mapped.conversationId,
          messageId: msg.id,
          uploaderId: msg.authorId ?? actor.userId,
          r2Key,
          name,
          mime,
          size: bytes.byteLength,
          status: 'ready',
        });
      } catch (err) {
        await c.env.FILES.delete(r2Key);
        throw err;
      }
      return c.json({ file: { id, name, mime, size: bytes.byteLength } }, 201);
    },
  )

  /** Recomputes thread reply counts for everything imported and closes the import. */
  .post('/:sid/finish', async (c) => {
    const { db, actor } = c.var;
    const session = await openSession(db, c.req.param('sid'));
    // One statement recounts every imported thread; then the import is closed.
    await db.run(sql`
        UPDATE message SET
          reply_count = (SELECT count(*) FROM message r WHERE r.parent_id = message.id AND r.deleted_at IS NULL),
          last_reply_at = (SELECT max(r.created_at) FROM message r WHERE r.parent_id = message.id AND r.deleted_at IS NULL)
        WHERE parent_id IS NULL AND conversation_id IN
          (SELECT conversation_id FROM import_conversation_map WHERE session_id = ${session.id})`);
    await db
      .update(importSession)
      .set({ status: 'finished', finishedAt: new Date() })
      .where(eq(importSession.id, session.id));
    await recordAudit(db, { action: 'import.finished', actorId: actor.userId, targetId: session.id });
    return c.json({ finished: true });
  });

/**
 * Fetches a file only from Slack's file hosts over HTTPS, following at most two redirects and only
 * to those same hosts. The server never fetches an address the importer could point anywhere else.
 */
async function fetchSlackFile(raw: string): Promise<Response> {
  let url = new URL(raw);
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== 'https:' || !allowedFileHost(url.hostname)) {
      throw badRequest('file_host_not_allowed', 'Files can only be imported from Slack’s file servers.');
    }
    const res = await fetch(url.toString(), { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new AppError(502, 'file_unavailable', 'That file is no longer available from Slack.');
    return res;
  }
  throw new AppError(502, 'file_unavailable', 'That file is no longer available from Slack.');
}
