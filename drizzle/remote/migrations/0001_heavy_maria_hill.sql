CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` string NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);