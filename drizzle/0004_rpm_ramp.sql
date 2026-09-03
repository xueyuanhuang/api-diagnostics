CREATE TABLE `rpm_active_leases` (
	`user_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rpm_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rpm_active_leases_run_id_unique` ON `rpm_active_leases` (`run_id`);--> statement-breakpoint
CREATE TABLE `rpm_run_secrets` (
	`run_id` text PRIMARY KEY NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`key_iv` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rpm_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rpm_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text,
	`profile_name` text,
	`api_type` text NOT NULL,
	`base_url` text NOT NULL,
	`model_name` text NOT NULL,
	`ramp_mode` text NOT NULL,
	`target_rpm` integer NOT NULL,
	`stage_duration_seconds` integer NOT NULL,
	`threshold_bps` integer NOT NULL,
	`status` text NOT NULL,
	`current_stage` integer,
	`highest_passed_rpm` integer,
	`stopped_at_rpm` integer,
	`stop_reason` text,
	`total_planned` integer NOT NULL,
	`total_attempted` integer DEFAULT 0 NOT NULL,
	`total_succeeded` integer DEFAULT 0 NOT NULL,
	`total_rate_limited` integer DEFAULT 0 NOT NULL,
	`median_latency_ms` integer,
	`p95_latency_ms` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rpm_runs_user_created_idx` ON `rpm_runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rpm_runs_profile_model_idx` ON `rpm_runs` (`user_id`,`profile_name`,`model_name`);--> statement-breakpoint
CREATE TABLE `rpm_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage_index` integer NOT NULL,
	`percentage` integer NOT NULL,
	`target_rpm` integer NOT NULL,
	`scheduled_count` integer NOT NULL,
	`batch_count` integer NOT NULL,
	`status` text NOT NULL,
	`scheduled_start_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`attempted_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`rate_limited_count` integer DEFAULT 0 NOT NULL,
	`client_error_count` integer DEFAULT 0 NOT NULL,
	`server_error_count` integer DEFAULT 0 NOT NULL,
	`timeout_count` integer DEFAULT 0 NOT NULL,
	`transport_error_count` integer DEFAULT 0 NOT NULL,
	`malformed_count` integer DEFAULT 0 NOT NULL,
	`missed_dispatch_count` integer DEFAULT 0 NOT NULL,
	`success_rate_bps` integer,
	`dispatch_valid` integer,
	`median_latency_ms` integer,
	`p95_latency_ms` integer,
	`p95_schedule_lag_ms` integer,
	FOREIGN KEY (`run_id`) REFERENCES `rpm_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rpm_stages_run_position_unique` ON `rpm_stages` (`run_id`,`stage_index`);--> statement-breakpoint
CREATE INDEX `rpm_stages_run_idx` ON `rpm_stages` (`run_id`);