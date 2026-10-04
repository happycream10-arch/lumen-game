CREATE TABLE `lumen_room_matches` (
	`code` text PRIMARY KEY NOT NULL,
	`match_no` integer DEFAULT 1 NOT NULL,
	`host_ready` integer DEFAULT 0 NOT NULL,
	`guest_ready` integer DEFAULT 0 NOT NULL
);
