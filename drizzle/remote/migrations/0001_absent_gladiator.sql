ALTER TABLE `conversations` ADD `lastSyncedAt` string;--> statement-breakpoint
ALTER TABLE `conversations` ADD `isDirty` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `isDeleted` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `lastSyncedAt` string;--> statement-breakpoint
ALTER TABLE `messages` ADD `isDirty` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `isDeleted` integer NOT NULL;