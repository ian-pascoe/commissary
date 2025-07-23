CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_title_idx` ON `conversations` (`title`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` string NOT NULL,
	`updatedAt` string NOT NULL,
	`conversationId` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversationId`);