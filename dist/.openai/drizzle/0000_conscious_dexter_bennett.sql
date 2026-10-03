CREATE TABLE `lumen_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`guest` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lumen_saves` (
	`owner` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
