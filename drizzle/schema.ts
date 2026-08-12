import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    documentPath: text("document_path"),
    scope: text("scope", { enum: ["document", "selection", "run"] }).notNull(),
    runId: text("run_id"),
    body: text("body").notNull(),
    state: text("state", { enum: ["open", "addressed", "resolved"] }).notNull().default("open"),
    anchorQuote: text("anchor_quote"),
    anchorPrefix: text("anchor_prefix"),
    anchorSuffix: text("anchor_suffix"),
    anchorStart: integer("anchor_start"),
    anchorEnd: integer("anchor_end"),
    anchorSectionPath: text("anchor_section_path"),
    anchorFingerprint: text("anchor_fingerprint"),
    anchorDocumentHash: text("anchor_document_hash"),
    anchorStatus: text("anchor_status", { enum: ["none", "anchored", "orphaned"] }).notNull().default("none"),
    anchorConfidence: real("anchor_confidence"),
    orphanReason: text("orphan_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    addressedAt: text("addressed_at"),
    resolvedAt: text("resolved_at"),
  },
  (table) => ({
    projectDocumentIndex: index("comments_project_document_idx").on(table.projectId, table.documentPath, table.createdAt),
    projectRunIndex: index("comments_project_run_idx").on(table.projectId, table.runId, table.createdAt),
    scopeCheck: check("comments_scope_check", sql`${table.scope} IN ('document', 'selection', 'run')`),
    stateCheck: check("comments_state_check", sql`${table.state} IN ('open', 'addressed', 'resolved')`),
    anchorStatusCheck: check("comments_anchor_status_check", sql`${table.anchorStatus} IN ('none', 'anchored', 'orphaned')`),
    selectionAnchorCheck: check(
      "comments_selection_anchor_check",
      sql`(${table.scope} <> 'selection' OR (${table.documentPath} IS NOT NULL AND ${table.anchorQuote} IS NOT NULL AND ${table.anchorStart} IS NOT NULL AND ${table.anchorEnd} IS NOT NULL))`,
    ),
    runIdCheck: check("comments_run_id_check", sql`(${table.scope} <> 'run' OR ${table.runId} IS NOT NULL)`),
  }),
);

export const schemaVersion = 2;
