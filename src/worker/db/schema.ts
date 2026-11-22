import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// Timestamps are stored as epoch milliseconds and surface in TypeScript as Date objects.
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const createdAt = () =>
  timestamp('created_at')
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

/* ---------------------------------------------------------------------------------------------
 * Auth tables, in the shape Better Auth's Drizzle adapter expects (property names are its field
 * names; column names stay snake_case).
 * ------------------------------------------------------------------------------------------- */

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at')
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index('session_user').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index('account_user').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index('verification_identifier').on(t.identifier)],
);

/* ---------------------------------------------------------------------------------------------
 * Workspace and membership. One workspace per installation, but every conversation still names
 * its workspace so isolation is explicit in the schema and in every query.
 * ------------------------------------------------------------------------------------------- */

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  logoFileId: text('logo_file_id'),
  accent: text('accent'),
  allowMemberGuestInvites: integer('allow_member_guest_invites', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: createdAt(),
});

export const workspaceRoles = ['owner', 'admin', 'member', 'guest'] as const;

export const workspaceMember = sqliteTable(
  'workspace_member',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role', { enum: workspaceRoles }).notNull(),
    status: text('status', { enum: ['active', 'deactivated'] })
      .notNull()
      .default('active'),
    guestExpiresAt: timestamp('guest_expires_at'),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check('workspace_member_role', sql`${t.role} IN ('owner','admin','member','guest')`),
    check('workspace_member_status', sql`${t.status} IN ('active','deactivated')`),
  ],
);

export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id),
    email: text('email').notNull(),
    role: text('role', { enum: workspaceRoles }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    guestConversationIds: text('guest_conversation_ids', { mode: 'json' }).$type<string[]>(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitation_email').on(t.email),
    check('invitation_role', sql`${t.role} IN ('owner','admin','member','guest')`),
  ],
);

/* ---------------------------------------------------------------------------------------------
 * Conversations: public and private channels, DMs and group DMs are one table with a kind.
 * ------------------------------------------------------------------------------------------- */

export const conversationKinds = ['public', 'private', 'dm', 'group_dm'] as const;

export const conversation = sqliteTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id),
    kind: text('kind', { enum: conversationKinds }).notNull(),
    name: text('name'),
    topic: text('topic'),
    // Sorted member ids joined with ':' so the same people always reopen the same DM.
    dmKey: text('dm_key').unique(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    lastSeq: integer('last_seq').notNull().default(0),
    archivedAt: timestamp('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('conversation_name')
      .on(t.workspaceId, t.name)
      .where(sql`${t.name} IS NOT NULL`),
    check('conversation_kind', sql`${t.kind} IN ('public','private','dm','group_dm')`),
    check(
      'conversation_shape',
      sql`(${t.kind} IN ('public','private') AND ${t.name} IS NOT NULL) OR (${t.kind} IN ('dm','group_dm') AND ${t.dmKey} IS NOT NULL)`,
    ),
  ],
);

export const conversationMember = sqliteTable(
  'conversation_member',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    notifyLevel: text('notify_level', { enum: ['all', 'mentions', 'muted'] })
      .notNull()
      .default('all'),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('conversation_member_user').on(t.userId),
    check('conversation_member_notify', sql`${t.notifyLevel} IN ('all','mentions','muted')`),
  ],
);

/* ---------------------------------------------------------------------------------------------
 * Messages and the per-conversation event log.
 * ------------------------------------------------------------------------------------------- */

export const webhook = sqliteTable('webhook', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversation.id),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
  revokedAt: timestamp('revoked_at'),
  createdAt: createdAt(),
});

export const message = sqliteTable(
  'message',
  {
    // Integer primary key = a stable SQLite rowid, which the external-content FTS index points at.
    // Without it, VACUUM may renumber rows and silently break search.
    rowId: integer('row_id').primaryKey(),
    id: text('id').notNull().unique(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    seq: integer('seq').notNull(),
    authorId: text('author_id').references(() => user.id),
    webhookId: text('webhook_id').references(() => webhook.id),
    clientMsgId: text('client_msg_id'),
    parentId: text('parent_id').references((): AnySQLiteColumn => message.id),
    body: text('body').notNull(),
    alsoInChannel: integer('also_in_channel', { mode: 'boolean' }).notNull().default(false),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: timestamp('last_reply_at'),
    editedAt: timestamp('edited_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('message_conversation_seq').on(t.conversationId, t.seq),
    uniqueIndex('message_client_id').on(t.authorId, t.clientMsgId),
    index('message_thread')
      .on(t.parentId, t.seq)
      .where(sql`${t.parentId} IS NOT NULL`),
    check('message_author', sql`${t.authorId} IS NOT NULL OR ${t.webhookId} IS NOT NULL`),
  ],
);

export const eventTypes = [
  'message.created',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'member.joined',
  'member.left',
  'conversation.updated',
] as const;

// Every change in a conversation gets the next seq. This table is both the outbox (rows with no
// published_at still need broadcasting) and the replay log for clients that reconnect.
export const conversationEvent = sqliteTable(
  'conversation_event',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    seq: integer('seq').notNull(),
    type: text('type', { enum: eventTypes }).notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    index('conversation_event_unpublished')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

export const messageMention = sqliteTable(
  'message_mention',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
    // A user id, or the special targets 'channel' and 'here'.
    target: text('target').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.target] }), index('message_mention_target').on(t.target)],
);

export const reaction = sqliteTable(
  'reaction',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/* ---------------------------------------------------------------------------------------------
 * Files, notifications, preferences.
 * ------------------------------------------------------------------------------------------- */

export const file = sqliteTable(
  'file',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    messageId: text('message_id').references(() => message.id),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => user.id),
    r2Key: text('r2_key').notNull().unique(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    status: text('status', { enum: ['pending', 'ready', 'rejected'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    index('file_conversation').on(t.conversationId, t.createdAt),
    check('file_status', sql`${t.status} IN ('pending','ready','rejected')`),
  ],
);

export const notification = sqliteTable(
  'notification',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
    kind: text('kind', { enum: ['mention', 'dm', 'thread_reply'] }).notNull(),
    createdAt: createdAt(),
    readAt: timestamp('read_at'),
    emailedAt: timestamp('emailed_at'),
  },
  (t) => [
    uniqueIndex('notification_unique').on(t.userId, t.messageId, t.kind),
    index('notification_pending')
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL AND ${t.emailedAt} IS NULL`),
    check('notification_kind', sql`${t.kind} IN ('mention','dm','thread_reply')`),
  ],
);

export const userPreference = sqliteTable(
  'user_preference',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id),
    digest: text('digest', { enum: ['hourly', 'daily', 'off'] })
      .notNull()
      .default('hourly'),
    digestDelayMin: integer('digest_delay_min').notNull().default(120),
    timezone: text('timezone').notNull().default('UTC'),
    pausedUntil: timestamp('paused_until'),
  },
  (t) => [check('user_preference_digest', sql`${t.digest} IN ('hourly','daily','off')`)],
);
