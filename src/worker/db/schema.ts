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

// Better Auth's rate-limit counters. Kept in D1 because a Worker's memory is not shared between
// requests, so an in-memory limiter would protect nothing.
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// Security-relevant events for the owner's Security page. Never holds codes, tokens or message text.
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id'), // null when nobody is signed in (e.g. a blocked sign-up)
    action: text('action').notNull(),
    targetId: text('target_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created').on(t.createdAt), index('audit_log_actor').on(t.actorId)],
);

/* ---------------------------------------------------------------------------------------------
 * Workspace and membership. One workspace per installation, but every conversation still names
 * its workspace so isolation is explicit in the schema and in every query.
 * ------------------------------------------------------------------------------------------- */

export const workspace = sqliteTable(
  'workspace',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    logoFileId: text('logo_file_id'),
    accent: text('accent'),
    allowMemberGuestInvites: integer('allow_member_guest_invites', { mode: 'boolean' })
      .notNull()
      .default(false),
    // The address Huddle was set up at, for work that runs without a request (hourly jobs and the
    // queue: links in emails, the push sender). APP_URL, when set, takes precedence.
    appUrl: text('app_url'),
    createdAt: createdAt(),
  },
  // A unique index on a constant: the database itself allows exactly one workspace per installation,
  // so two simultaneous first-run setups cannot create two.
  () => [uniqueIndex('workspace_singleton').on(sql`(1)`)],
);

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
    // Retries from the same webhook with the same Idempotency-Key are one message.
    uniqueIndex('message_webhook_client_id').on(t.webhookId, t.clientMsgId),
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
  'history.imported',
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
    // Set when a digest job claims this notification, before sending: a concurrent job cannot claim
    // it again, and a retry reuses the same claim (and so the same idempotency key and content).
    digestId: text('digest_id'),
    claimedAt: timestamp('claimed_at'),
  },
  (t) => [
    uniqueIndex('notification_unique').on(t.userId, t.messageId, t.kind),
    index('notification_claimed')
      .on(t.digestId)
      .where(sql`${t.digestId} IS NOT NULL AND ${t.emailedAt} IS NULL`),
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
    // Do Not Disturb: no digests (or pushes) before this moment.
    pausedUntil: timestamp('paused_until'),
    lastDigestAt: timestamp('last_digest_at'),
  },
  (t) => [check('user_preference_digest', sql`${t.digest} IN ('hourly','daily','off')`)],
);

// Emails sent per UTC day, counted by Huddle itself: the free email plan allows about 100 a day, and
// digests stop early so sign-in codes always have room.
export const emailUsage = sqliteTable('email_usage', {
  day: text('day').primaryKey(), // YYYY-MM-DD (UTC)
  sent: integer('sent').notNull().default(0),
});

/* ---------------------------------------------------------------------------------------------
 * Importing history from a Slack export. The browser unpacks the export and sends it in small
 * batches; these tables remember which Slack ids became which Huddle ids within one import.
 * ------------------------------------------------------------------------------------------- */

export const importSession = sqliteTable('import_session', {
  id: text('id').primaryKey(),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
  status: text('status', { enum: ['open', 'finished'] })
    .notNull()
    .default('open'),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at'),
});

export const importUserMap = sqliteTable(
  'import_user_map',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => importSession.id),
    slackId: text('slack_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.slackId] })],
);

export const importConversationMap = sqliteTable(
  'import_conversation_map',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => importSession.id),
    slackId: text('slack_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.slackId] })],
);

// Per-day counters for work with a daily budget other than email (e.g. imported messages, which
// cost several database writes each against the free plan's 100,000 writes a day).
export const dailyCounter = sqliteTable(
  'daily_counter',
  {
    day: text('day').notNull(),
    kind: text('kind').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind] })],
);

/* ---------------------------------------------------------------------------------------------
 * Push notifications. Each browser that turns them on gets one subscription; it belongs to the
 * session that created it, so signing out (or a session expiring) stops pushes to that device.
 * ------------------------------------------------------------------------------------------- */

export const pushSubscription = sqliteTable(
  'push_subscription',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('push_subscription_user').on(t.userId), index('push_subscription_session').on(t.sessionId)],
);

// The server's own signing key for push (VAPID), made on first use. The private half is stored
// encrypted with a key derived from the server secret, so a copy of the database alone can't use it.
export const pushKey = sqliteTable('push_key', {
  id: text('id').primaryKey(), // always 'vapid'
  publicKey: text('public_key').notNull(), // base64url, uncompressed P-256 point
  privateKey: text('private_key').notNull(), // base64url(iv || AES-GCM ciphertext of the JWK)
  createdAt: createdAt(),
});

/* ---------------------------------------------------------------------------------------------
 * Outgoing email through the team's own Gmail account. One row at most; the refresh token Google
 * issues is stored sealed with a key derived from the server secret.
 * ------------------------------------------------------------------------------------------- */

export const emailAccount = sqliteTable('email_account', {
  id: text('id').primaryKey(), // always 'gmail'
  address: text('address').notNull(),
  refreshToken: text('refresh_token').notNull(), // sealed
  connectedBy: text('connected_by'), // null when connected before setup (by the owner, pre sign-in)
  connectedAt: createdAt(),
  // Set when Google stopped accepting the token (password changed, access removed, unused for
  // months): admins are asked to reconnect.
  needsReconnectAt: timestamp('needs_reconnect_at'),
});

/* ---------------------------------------------------------------------------------------------
 * Signing in with an authenticator app (6-digit codes that change every 30 seconds), as an
 * alternative to email codes. Secrets are stored sealed with a key derived from the server secret.
 * ------------------------------------------------------------------------------------------- */

export const totpCredential = sqliteTable('totp_credential', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(), // sealed
  // The last 30-second step a code was accepted for: the same code can't be used twice.
  lastStep: integer('last_step').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  lockedUntil: timestamp('locked_until'),
  createdAt: createdAt(),
});

/** A scan in progress: the secret shown as a QR code, until the person confirms it with a code. */
export const totpEnrollment = sqliteTable('totp_enrollment', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  secret: text('secret').notNull(), // sealed
  kind: text('kind', { enum: ['owner', 'invite', 'reset', 'self'] }).notNull(),
  ref: text('ref'), // invitation id, reset link hash or user id
  expiresAt: timestamp('expires_at').notNull(),
});

/** A one-time link an admin gives someone who lost their phone, to set up the app again. */
export const totpResetLink = sqliteTable('totp_reset_link', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
});
