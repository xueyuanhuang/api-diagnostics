CREATE TABLE `connection_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`api_type` text NOT NULL,
	`base_url` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`key_iv` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_user_name_unique` ON `connection_profiles` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `profiles_user_updated_idx` ON `connection_profiles` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `profile_models` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`model_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_models_profile_name_unique` ON `profile_models` (`profile_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `profile_models_profile_idx` ON `profile_models` (`profile_id`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`question_id` text NOT NULL,
	`category` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`returned_model` text,
	`input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`total_input_tokens` integer,
	`output_tokens` integer,
	`request_id` text,
	`answer` text,
	`raw_response` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `results_run_position_unique` ON `test_results` (`run_id`,`position`);--> statement-breakpoint
CREATE INDEX `results_run_idx` ON `test_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text,
	`profile_name` text,
	`api_type` text NOT NULL,
	`base_url` text NOT NULL,
	`model_name` text NOT NULL,
	`verdict` text NOT NULL,
	`normal_count` integer NOT NULL,
	`cache_count` integer NOT NULL,
	`large_count` integer NOT NULL,
	`error_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_user_created_idx` ON `test_runs` (`user_id`,`created_at`);