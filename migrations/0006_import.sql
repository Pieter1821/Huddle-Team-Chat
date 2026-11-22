CREATE TABLE `daily_counter` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `import_conversation_map` (
	`session_id` text NOT NULL,
	`slack_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `slack_id`),
	FOREIGN KEY (`session_id`) REFERENCES `import_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_session` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_user_map` (
	`session_id` text NOT NULL,
	`slack_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `slack_id`),
	FOREIGN KEY (`session_id`) REFERENCES `import_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
