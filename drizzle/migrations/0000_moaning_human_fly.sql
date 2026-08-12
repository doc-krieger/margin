CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`document_path` text,
	`scope` text NOT NULL,
	`run_id` text,
	`body` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`anchor_quote` text,
	`anchor_prefix` text,
	`anchor_suffix` text,
	`anchor_start` integer,
	`anchor_end` integer,
	`anchor_section_path` text,
	`anchor_fingerprint` text,
	`anchor_document_hash` text,
	`anchor_status` text DEFAULT 'none' NOT NULL,
	`anchor_confidence` real,
	`orphan_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`addressed_at` text,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `comments_project_document_idx` ON `comments` (`project_id`,`document_path`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_project_run_idx` ON `comments` (`project_id`,`run_id`,`created_at`);