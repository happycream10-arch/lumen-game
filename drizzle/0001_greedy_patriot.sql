CREATE INDEX `lumen_rooms_host_created` ON `lumen_rooms` (`host`,`created_at`);--> statement-breakpoint
CREATE INDEX `lumen_rooms_guest_created` ON `lumen_rooms` (`guest`,`created_at`);