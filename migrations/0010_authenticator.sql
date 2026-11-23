CREATE TABLE `totp_credential` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`last_step` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `totp_enrollment` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`secret` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `totp_reset_link` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
