CREATE TABLE `channel_contexts` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`context_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `custom_personas` (
	`server_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`details` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `persona_id`)
);
--> statement-breakpoint
CREATE TABLE `server_configs` (
	`server_id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
