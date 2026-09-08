CREATE TABLE `diagnostic_runs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`test_kind` text NOT NULL,
	`summary_json` text NOT NULL,
	`evidence_key` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `diagnostic_runs_user_created_idx` ON `diagnostic_runs` (`user_id`,`created_at`);