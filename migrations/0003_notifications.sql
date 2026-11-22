CREATE TABLE `email_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `user_preference` ADD `last_digest_at` integer;