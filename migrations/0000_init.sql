CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`topic` text,
	`dm_key` text,
	`created_by` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_kind" CHECK("conversation"."kind" IN ('public','private','dm','group_dm')),
	CONSTRAINT "conversation_shape" CHECK(("conversation"."kind" IN ('public','private') AND "conversation"."name" IS NOT NULL) OR ("conversation"."kind" IN ('dm','group_dm') AND "conversation"."dm_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_dm_key_unique` ON `conversation` (`dm_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_name` ON `conversation` (`workspace_id`,`name`) WHERE "conversation"."name" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `conversation_event` (
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`published_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`conversation_id`, `seq`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_event_unpublished` ON `conversation_event` (`created_at`) WHERE "conversation_event"."published_at" IS NULL;--> statement-breakpoint
CREATE TABLE `conversation_member` (
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`notify_level` text DEFAULT 'all' NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_member_notify" CHECK("conversation_member"."notify_level" IN ('all','mentions','muted'))
);
--> statement-breakpoint
CREATE INDEX `conversation_member_user` ON `conversation_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `file` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`uploader_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_status" CHECK("file"."status" IN ('pending','ready','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_r2_key_unique` ON `file` (`r2_key`);--> statement-breakpoint
CREATE INDEX `file_conversation` ON `file` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`guest_conversation_ids` text,
	`invited_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invitation_role" CHECK("invitation"."role" IN ('owner','admin','member','guest'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_token_hash_unique` ON `invitation` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitation_email` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `message` (
	`row_id` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author_id` text,
	`webhook_id` text,
	`client_msg_id` text,
	`parent_id` text,
	`body` text NOT NULL,
	`also_in_channel` integer DEFAULT false NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`edited_at` integer,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_author" CHECK("message"."author_id" IS NOT NULL OR "message"."webhook_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_unique` ON `message` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_conversation_seq` ON `message` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_client_id` ON `message` (`author_id`,`client_msg_id`);--> statement-breakpoint
CREATE INDEX `message_thread` ON `message` (`parent_id`,`seq`) WHERE "message"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `message_mention` (
	`message_id` text NOT NULL,
	`target` text NOT NULL,
	PRIMARY KEY(`message_id`, `target`),
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_mention_target` ON `message_mention` (`target`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`read_at` integer,
	`emailed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_kind" CHECK("notification"."kind" IN ('mention','dm','thread_reply'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_unique` ON `notification` (`user_id`,`message_id`,`kind`);--> statement-breakpoint
CREATE INDEX `notification_pending` ON `notification` (`user_id`) WHERE "notification"."read_at" IS NULL AND "notification"."emailed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `reaction` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_preference` (
	`user_id` text PRIMARY KEY NOT NULL,
	`digest` text DEFAULT 'hourly' NOT NULL,
	`digest_delay_min` integer DEFAULT 120 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`paused_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_preference_digest" CHECK("user_preference"."digest" IN ('hourly','daily','off'))
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `webhook` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_token_hash_unique` ON `webhook` (`token_hash`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`logo_file_id` text,
	`accent` text,
	`allow_member_guest_invites` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_member` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`guest_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_member_role" CHECK("workspace_member"."role" IN ('owner','admin','member','guest')),
	CONSTRAINT "workspace_member_status" CHECK("workspace_member"."status" IN ('active','deactivated'))
);
