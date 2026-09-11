CREATE TABLE `animation_results` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`model` text NOT NULL,
	`evidence_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `animation_results_user_created_idx` ON `animation_results` (`user_id`,`created_at`);