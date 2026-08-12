import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  commentSchema,
  commentStateTransitions,
  createCommentInputSchema,
  type CommentRecord,
  type CommentScope,
  type CommentState,
  type CreateCommentInput,
  type TextAnchor,
} from "../../../../packages/shared/src/comments/contracts.js";
import { createTextAnchor, hashDocument, reanchorTextAnchor, updateTextAnchor } from "./anchors.js";

export const commentsTableSql = `
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  document_path TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('document', 'selection', 'run')),
  run_id TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'addressed', 'resolved')),
  anchor_quote TEXT,
  anchor_prefix TEXT,
  anchor_suffix TEXT,
  anchor_start INTEGER,
  anchor_end INTEGER,
  anchor_section_path TEXT,
  anchor_fingerprint TEXT,
  anchor_document_hash TEXT,
  anchor_status TEXT NOT NULL DEFAULT 'none' CHECK (anchor_status IN ('none', 'anchored', 'orphaned')),
  anchor_confidence REAL,
  orphan_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  addressed_at TEXT,
  resolved_at TEXT,
  CHECK (
    (scope = 'selection' AND document_path IS NOT NULL AND anchor_quote IS NOT NULL AND anchor_start IS NOT NULL AND anchor_end IS NOT NULL)
    OR scope <> 'selection'
  ),
  CHECK ((scope = 'run' AND run_id IS NOT NULL) OR scope <> 'run')
);
CREATE INDEX IF NOT EXISTS comments_project_document_idx ON comments(project_id, document_path, created_at);
CREATE INDEX IF NOT EXISTS comments_project_run_idx ON comments(project_id, run_id, created_at);
`;

export interface SelectionCommentInput {
  projectId: string;
  documentPath: string;
  documentText: string;
  start: number;
  end: number;
  body: string;
  contextLength?: number;
  sectionPath?: string[];
}

export interface DocumentCommentInput {
  projectId: string;
  documentPath: string;
  body: string;
}

export interface RunGuidanceInput {
  projectId: string;
  runId: string;
  body: string;
  documentPath?: string;
}

export interface CommentListFilter {
  projectId: string;
  documentPath?: string;
  runId?: string;
  scope?: CommentScope;
  state?: CommentState;
}

export type CommentActor = "user" | "automation" | { actor: "user" | "automation" };

export class CommentNotFoundError extends Error {
  constructor(public readonly commentId: string) {
    super(`Comment ${commentId} was not found`);
    this.name = "CommentNotFoundError";
  }
}

export class CommentAuthorizationError extends Error {
  constructor(message = "Only a user may resolve a comment") {
    super(message);
    this.name = "CommentAuthorizationError";
  }
}

export class InvalidCommentTransitionError extends Error {
  constructor(public readonly from: CommentState, public readonly to: CommentState) {
    super(`Invalid comment state transition: ${from} -> ${to}`);
    this.name = "InvalidCommentTransitionError";
  }
}

interface CommentRow {
  id: string;
  project_id: string;
  document_path: string | null;
  scope: string;
  run_id: string | null;
  body: string;
  state: string;
  anchor_quote: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_start: number | null;
  anchor_end: number | null;
  anchor_section_path: string | null;
  anchor_fingerprint: string | null;
  anchor_document_hash: string | null;
  anchor_status: string;
  anchor_confidence: number | null;
  orphan_reason: string | null;
  created_at: string;
  updated_at: string;
  addressed_at: string | null;
  resolved_at: string | null;
}

function actorKind(actor: CommentActor): "user" | "automation" {
  return typeof actor === "string" ? actor : actor.actor;
}

function now(): string {
  return new Date().toISOString();
}

function anchorFromRow(row: CommentRow): TextAnchor | null {
  if (!row.anchor_quote) return null;
  if (
    row.anchor_prefix === null ||
    row.anchor_suffix === null ||
    row.anchor_start === null ||
    row.anchor_end === null ||
    row.anchor_section_path === null ||
    row.anchor_fingerprint === null ||
    row.anchor_document_hash === null
  ) {
    return null;
  }
  return {
    quote: row.anchor_quote,
    prefix: row.anchor_prefix,
    suffix: row.anchor_suffix,
    start: row.anchor_start,
    end: row.anchor_end,
    sectionPath: JSON.parse(row.anchor_section_path) as string[],
    fingerprint: row.anchor_fingerprint,
    documentHash: row.anchor_document_hash,
  };
}

function commentFromRow(row: CommentRow): CommentRecord {
  return commentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    documentPath: row.document_path,
    scope: row.scope,
    runId: row.run_id,
    body: row.body,
    state: row.state,
    anchor: anchorFromRow(row),
    anchorStatus: row.anchor_status,
    anchorConfidence: row.anchor_confidence,
    orphanReason: row.orphan_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    addressedAt: row.addressed_at,
    resolvedAt: row.resolved_at,
  });
}

export class CommentRepository {
  public readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(database: DatabaseSync | string = ":memory:") {
    if (typeof database === "string") {
      this.ownsDatabase = true;
      this.database = new DatabaseSync(database);
    } else {
      this.ownsDatabase = false;
      this.database = database;
    }
    this.database.exec(commentsTableSql);
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }

  createComment(input: CreateCommentInput): CommentRecord {
    const parsed = createCommentInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = now();
    const anchor = parsed.anchor ?? null;
    this.database.prepare(`
      INSERT INTO comments (
        id, project_id, document_path, scope, run_id, body, state,
        anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end,
        anchor_section_path, anchor_fingerprint, anchor_document_hash,
        anchor_status, anchor_confidence, orphan_reason,
        created_at, updated_at, addressed_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
    `).run(
      id,
      parsed.projectId,
      parsed.documentPath ?? null,
      parsed.scope,
      parsed.runId ?? null,
      parsed.body,
      anchor?.quote ?? null,
      anchor?.prefix ?? null,
      anchor?.suffix ?? null,
      anchor?.start ?? null,
      anchor?.end ?? null,
      anchor ? JSON.stringify(anchor.sectionPath) : null,
      anchor?.fingerprint ?? null,
      anchor?.documentHash ?? null,
      anchor ? "anchored" : "none",
      anchor ? 1 : null,
      timestamp,
      timestamp,
    );
    return this.require(id);
  }

  createSelectionComment(input: SelectionCommentInput): CommentRecord {
    const anchor = createTextAnchor(input.documentText, input.start, input.end, {
      contextLength: input.contextLength,
      sectionPath: input.sectionPath,
    });
    return this.createComment({
      projectId: input.projectId,
      documentPath: input.documentPath,
      scope: "selection",
      body: input.body,
      anchor,
    });
  }

  createDocumentComment(input: DocumentCommentInput): CommentRecord {
    return this.createComment({
      projectId: input.projectId,
      documentPath: input.documentPath,
      scope: "document",
      body: input.body,
    });
  }

  createRunGuidance(input: RunGuidanceInput): CommentRecord {
    return this.createComment({
      projectId: input.projectId,
      documentPath: input.documentPath ?? null,
      scope: "run",
      runId: input.runId,
      body: input.body,
    });
  }

  get(id: string): CommentRecord | null {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | undefined;
    return row ? commentFromRow(row) : null;
  }

  require(id: string): CommentRecord {
    const comment = this.get(id);
    if (!comment) throw new CommentNotFoundError(id);
    return comment;
  }

  requireForProject(projectId: string, id: string): CommentRecord {
    const row = this.database.prepare("SELECT * FROM comments WHERE project_id = ? AND id = ?").get(projectId, id) as CommentRow | undefined;
    if (!row) throw new CommentNotFoundError(id);
    return commentFromRow(row);
  }

  list(filter: CommentListFilter): CommentRecord[] {
    const clauses = ["project_id = ?"];
    const values: Array<string> = [filter.projectId];
    if (filter.documentPath !== undefined) {
      clauses.push("document_path = ?");
      values.push(filter.documentPath);
    }
    if (filter.runId !== undefined) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }
    if (filter.scope !== undefined) {
      clauses.push("scope = ?");
      values.push(filter.scope);
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      values.push(filter.state);
    }
    const rows = this.database.prepare(`SELECT * FROM comments WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`).all(...values) as unknown as CommentRow[];
    return rows.map(commentFromRow);
  }

  updateBody(id: string, body: string): CommentRecord {
    const nextBody = body.trim();
    if (!nextBody) throw new TypeError("comment body must not be empty");
    this.require(id);
    this.database.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(nextBody, now(), id);
    return this.require(id);
  }

  transition(id: string, nextState: CommentState, actor: CommentActor): CommentRecord {
    const current = this.require(id);
    if (nextState === "resolved" && actorKind(actor) !== "user") throw new CommentAuthorizationError();
    if (!commentStateTransitions[current.state].includes(nextState)) {
      throw new InvalidCommentTransitionError(current.state, nextState);
    }
    const timestamp = now();
    const addressedAt = nextState === "addressed" ? current.addressedAt ?? timestamp : current.addressedAt;
    const resolvedAt = nextState === "resolved" ? timestamp : current.resolvedAt;
    this.database.prepare("UPDATE comments SET state = ?, updated_at = ?, addressed_at = ?, resolved_at = ? WHERE id = ?").run(
      nextState,
      timestamp,
      addressedAt,
      resolvedAt,
      id,
    );
    return this.require(id);
  }

  reanchorDocument(projectId: string, documentPath: string, documentText: string): CommentRecord[] {
    const comments = this.list({ projectId, documentPath, scope: "selection" });
    const documentHash = hashDocument(documentText);
    for (const comment of comments) {
      if (!comment.anchor) continue;
      const result = reanchorTextAnchor(comment.anchor, documentText);
      const timestamp = now();
      const nextAnchor = updateTextAnchor(comment.anchor, documentText, result);
      if (nextAnchor) {
        this.database.prepare(`
          UPDATE comments SET anchor_start = ?, anchor_end = ?, anchor_section_path = ?,
            anchor_fingerprint = ?, anchor_document_hash = ?, anchor_status = 'anchored',
            anchor_confidence = ?, orphan_reason = NULL, updated_at = ? WHERE id = ?
        `).run(
          nextAnchor.start,
          nextAnchor.end,
          JSON.stringify(nextAnchor.sectionPath),
          nextAnchor.fingerprint,
          nextAnchor.documentHash,
          result.confidence,
          timestamp,
          comment.id,
        );
      } else {
        this.database.prepare(`
          UPDATE comments SET anchor_document_hash = ?, anchor_status = 'orphaned',
            anchor_confidence = ?, orphan_reason = ?, updated_at = ? WHERE id = ?
        `).run(documentHash, result.confidence, result.orphanReason ?? "invalid-anchor", timestamp, comment.id);
      }
    }
    return this.list({ projectId, documentPath, scope: "selection" });
  }
}

/** Service name retained as a small semantic wrapper around the durable store. */
export class CommentService extends CommentRepository {}

export function createCommentService(database: DatabaseSync | string = ":memory:"): CommentService {
  return new CommentService(database);
}
