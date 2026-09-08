CREATE TABLE `availability_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`slot_start` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`http_status` integer,
	`latency_ms` integer,
	`returned_model` text,
	`request_id` text,
	`answer` text,
	`error` text,
	FOREIGN KEY (`target_id`) REFERENCES `availability_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_sample_target_slot_unique` ON `availability_samples` (`target_id`,`slot_start`);--> statement-breakpoint
CREATE TABLE `availability_scheduler` (
	`id` text PRIMARY KEY NOT NULL,
	`last_tick_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `availability_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`api_type` text NOT NULL,
	`model_name` text NOT NULL,
	`base_url` text NOT NULL,
	`allow_insecure_http` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_target_unique` ON `availability_targets` (`user_id`,`profile_id`,`api_type`,`model_name`);--> statement-breakpoint
CREATE INDEX `availability_target_user_active_idx` ON `availability_targets` (`user_id`,`deleted_at`);