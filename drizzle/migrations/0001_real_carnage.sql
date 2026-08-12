PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_comments` (
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
	`resolved_at` text,
	CONSTRAINT "comments_scope_check" CHECK("__new_comments"."scope" IN ('document', 'selection', 'run')),
	CONSTRAINT "comments_state_check" CHECK("__new_comments"."state" IN ('open', 'addressed', 'resolved')),
	CONSTRAINT "comments_anchor_status_check" CHECK("__new_comments"."anchor_status" IN ('none', 'anchored', 'orphaned')),
	CONSTRAINT "comments_selection_anchor_check" CHECK(("__new_comments"."scope" <> 'selection' OR ("__new_comments"."document_path" IS NOT NULL AND "__new_comments"."anchor_quote" IS NOT NULL AND "__new_comments"."anchor_start" IS NOT NULL AND "__new_comments"."anchor_end" IS NOT NULL))),
	CONSTRAINT "comments_run_id_check" CHECK(("__new_comments"."scope" <> 'run' OR "__new_comments"."run_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "project_id", "document_path", "scope", "run_id", "body", "state", "anchor_quote", "anchor_prefix", "anchor_suffix", "anchor_start", "anchor_end", "anchor_section_path", "anchor_fingerprint", "anchor_document_hash", "anchor_status", "anchor_confidence", "orphan_reason", "created_at", "updated_at", "addressed_at", "resolved_at") SELECT "id", "project_id", "document_path", "scope", "run_id", "body", "state", "anchor_quote", "anchor_prefix", "anchor_suffix", "anchor_start", "anchor_end", "anchor_section_path", "anchor_fingerprint", "anchor_document_hash", "anchor_status", "anchor_confidence", "orphan_reason", "created_at", "updated_at", "addressed_at", "resolved_at" FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `comments_project_document_idx` ON `comments` (`project_id`,`document_path`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_project_run_idx` ON `comments` (`project_id`,`run_id`,`created_at`);