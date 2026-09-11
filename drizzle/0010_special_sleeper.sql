CREATE TABLE `legacy_account_links` (
	`source_user` text PRIMARY KEY NOT NULL,
	`target_user` text NOT NULL,
	`linked_at` integer NOT NULL
);
