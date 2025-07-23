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
	`emailVerified` integer DEFAULT false NOT NULL,
	`emailVerifiedAt` string,
	`image` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_name_idx` ON `users` (`name`);--> statement-breakpoint
CREATE INDEX `users_email_verified_idx` ON `users` (`emailVerified`);