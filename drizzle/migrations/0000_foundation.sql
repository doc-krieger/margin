-- Foundation migration. No document-body table by design.
CREATE TABLE IF NOT EXISTS _margin_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO _margin_migrations (version) VALUES (1);
