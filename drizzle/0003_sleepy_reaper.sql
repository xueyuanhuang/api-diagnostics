CREATE TABLE `profile_api_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`api_type` text NOT NULL,
	`base_url` text NOT NULL,
	`model_name` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`key_iv` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_api_configs_profile_type_unique` ON `profile_api_configs` (`profile_id`,`api_type`);--> statement-breakpoint
CREATE INDEX `profile_api_configs_profile_idx` ON `profile_api_configs` (`profile_id`);--> statement-breakpoint
CREATE TABLE `profile_api_models` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`model_name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `profile_api_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_api_models_config_name_unique` ON `profile_api_models` (`config_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `profile_api_models_config_idx` ON `profile_api_models` (`config_id`);