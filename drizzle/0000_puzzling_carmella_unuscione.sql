CREATE TABLE `channel_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`server_id` text,
	`author_id` text NOT NULL,
	`author_username` text,
	`content` text NOT NULL,
	`timestamp` integer NOT NULL,
	`is_bot` integer DEFAULT false NOT NULL,
	`mentions_everyone` integer DEFAULT false NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`has_embeds` integer DEFAULT false NOT NULL,
	`responded_to` integer DEFAULT false NOT NULL,
	`has_been_replied_to` integer DEFAULT false NOT NULL,
	`reference_message_id` text,
	`reference_channel_id` text,
	`reference_guild_id` text
);
--> statement-breakpoint
CREATE INDEX `channel_messages_channel_idx` ON `channel_messages` (`channel_id`);--> statement-breakpoint
CREATE INDEX `channel_messages_channel_timestamp_idx` ON `channel_messages` (`channel_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `channel_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_timestamp` integer,
	`last_processed_message_id` text,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`type` text NOT NULL,
	`owner_user_id` text,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_role_mentions` (
	`message_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `role_id`)
);
--> statement-breakpoint
CREATE INDEX `message_role_mentions_message_idx` ON `message_role_mentions` (`message_id`);--> statement-breakpoint
CREATE TABLE `message_user_mentions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `message_user_mentions_message_idx` ON `message_user_mentions` (`message_id`);--> statement-breakpoint
CREATE TABLE `persona_assignments` (
	`assignment_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persona_assignments_server_target_uid` ON `persona_assignments` (`server_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `persona_assignments_persona_idx` ON `persona_assignments` (`persona_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`persona_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`server_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`details` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `personas_server_idx` ON `personas` (`server_id`);--> statement-breakpoint
CREATE INDEX `personas_scope_idx` ON `personas` (`scope`);--> statement-breakpoint
CREATE TABLE `server_channel_permissions` (
	`server_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`server_id`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `server_channel_permissions_server_idx` ON `server_channel_permissions` (`server_id`);--> statement-breakpoint
CREATE TABLE `server_summary_allowed_roles` (
	`server_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`server_id`, `role_id`)
);
--> statement-breakpoint
CREATE INDEX `server_summary_allowed_roles_server_idx` ON `server_summary_allowed_roles` (`server_id`);--> statement-breakpoint
CREATE TABLE `server_summary_banned_channels` (
	`server_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`server_id`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `server_summary_banned_channels_server_idx` ON `server_summary_banned_channels` (`server_id`);--> statement-breakpoint
CREATE TABLE `servers` (
	`server_id` text PRIMARY KEY NOT NULL,
	`responsiveness` integer DEFAULT 1 NOT NULL,
	`language_primary` text DEFAULT 'auto' NOT NULL,
	`language_fallback` text DEFAULT 'en' NOT NULL,
	`language_auto_detect` integer DEFAULT true NOT NULL,
	`max_context_messages` integer,
	`max_daily_responses` integer,
	`channel_mode` text DEFAULT 'whitelist' NOT NULL,
	`channel_auto_manage` integer DEFAULT false NOT NULL,
	`summary_enabled` integer DEFAULT false NOT NULL,
	`summary_max_messages` integer,
	`summary_cooldown_seconds` integer,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
