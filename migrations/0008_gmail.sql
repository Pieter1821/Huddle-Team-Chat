CREATE TABLE `email_account` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`refresh_token` text NOT NULL,
	`connected_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`needs_reconnect_at` integer
);
