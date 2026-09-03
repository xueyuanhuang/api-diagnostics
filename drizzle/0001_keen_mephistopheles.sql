ALTER TABLE `test_results` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `test_results` ADD `generation_ms` integer;--> statement-breakpoint
ALTER TABLE `test_results` ADD `total_time_ms` integer;--> statement-breakpoint
ALTER TABLE `test_results` ADD `output_tokens_per_second` real;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `unavailable_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `median_ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `median_generation_ms` integer;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `median_total_time_ms` integer;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `median_output_tokens_per_second` real;