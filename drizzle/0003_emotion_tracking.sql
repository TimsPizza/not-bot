CREATE TABLE `channel_emotions` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`affinity` integer DEFAULT 0 NOT NULL,
	`annoyance` integer DEFAULT 0 NOT NULL,
	`trust` integer DEFAULT 0 NOT NULL,
	`curiosity` integer DEFAULT 0 NOT NULL,
	`last_interaction_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`last_decay_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`evidence` text,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `channel_emotions_channel_idx` ON `channel_emotions` (`channel_id`);
--> statement-breakpoint
ALTER TABLE `personas` ADD `emotion_thresholds` text;
--> statement-breakpoint
ALTER TABLE `personas` ADD `emotion_delta_caps` text;
