CREATE TABLE `channel_proactive_messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `public_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `persona_id` text NOT NULL,
  `content` text NOT NULL,
  `scheduled_at` integer NOT NULL,
  `status` text NOT NULL DEFAULT 'scheduled',
  `reason` text,
  `metadata` text,
  `created_at` integer NOT NULL DEFAULT (strftime('%s','now') * 1000),
  `updated_at` integer NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_proactive_messages_public_id_idx` ON `channel_proactive_messages` (`public_id`);
--> statement-breakpoint
CREATE INDEX `channel_proactive_messages_channel_idx` ON `channel_proactive_messages` (`channel_id`);
--> statement-breakpoint
CREATE INDEX `channel_proactive_messages_schedule_idx` ON `channel_proactive_messages` (`scheduled_at`);
