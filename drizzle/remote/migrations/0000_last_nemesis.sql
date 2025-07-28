CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` string,
	`refresh_token_expires_at` string,
	`scope` text,
	`password` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `accounts_account_id_idx` ON `accounts` (`account_id`);--> statement-breakpoint
CREATE INDEX `accounts_provider_id_idx` ON `accounts` (`provider_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`userId` text NOT NULL,
	`title` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_user_id_idx` ON `conversations` (`userId`);--> statement-breakpoint
CREATE INDEX `conversations_title_idx` ON `conversations` (`title`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`userId` text NOT NULL,
	`conversationId` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_user_id_idx` ON `messages` (`userId`);--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversationId`);--> statement-breakpoint
CREATE INDEX `messages_role_idx` ON `messages` (`role`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`is_anonymous` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_name_idx` ON `users` (`name`);--> statement-breakpoint
CREATE INDEX `users_is_anonymous_idx` ON `users` (`is_anonymous`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` string NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);