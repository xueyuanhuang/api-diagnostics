CREATE TABLE `chatgpt_imports` (
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`imported_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `source_id`)
);
