ALTER TABLE `notification` ADD `digest_id` text;--> statement-breakpoint
ALTER TABLE `notification` ADD `claimed_at` integer;--> statement-breakpoint
CREATE INDEX `notification_claimed` ON `notification` (`digest_id`) WHERE "notification"."digest_id" IS NOT NULL AND "notification"."emailed_at" IS NULL;