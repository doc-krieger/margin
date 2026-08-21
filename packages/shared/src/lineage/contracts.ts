import { z } from "zod";

/** Versioned contracts for the derived, cross-domain research lineage projection. */
export const lineageSchemaVersion = 1 as const;
export const lineageSchemaVersionSchema = z.literal(lineageSchemaVersion);

const identifierSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const projectIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
const timestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z.string().max(8_000);
const boundedDiagnosticSchema = z.string().max(32_000);

export const lineageEntryIdSchema = identifierSchema;
export const lineageProjectIdSchema = projectIdSchema;
export const lineageCursorSchema = z.string().max(4_096);

/** A human-meaningful milestone in the projected research journey. */
export const lineageEntryKindSchema = z.enum([
  "brief.confirmed",
  "source.capture",
  "source.version",
  "research.run",
  "research.report",
  "research.decision",
  "checkpoint.created",
  "checkpoint.accepted",
  "qa.attempt",
  "qa.follow-up",
  "qa.finding",
  "qa.disposition",
  "qa.promotion",
  "comment.created",
  "revision.run",
  "proposal.created",
  "proposal.decision",
  "finding.relationship",
  "checkpoint.reviewed",
  "workspace.restored",
  "diagnostic",
]);
export type LineageEntryKind = z.infer<typeof lineageEntryKindSchema>;

export const lineageDetailTypeSchema = z.enum([
  "brief",
  "research-run",
  "research-report",
  "source",
  "source-version",
  "source-capture",
  "checkpoint",
  "qa-review",
  "qa-attempt",
  "finding",
  "comment",
  "revision-run",
  "proposal",
  "proposal-decision",
  "decision",
  "finding-relationship",
  "review-ack",
  "workspace",
  "diagnostic",
]);
export type LineageDetailType = z.infer<typeof lineageDetailTypeSchema>;

/** Stable navigation target. It intentionally references a canonical record instead of embedding it. */
export const lineageDetailTargetSchema = z.object({
  type: lineageDetailTypeSchema,
  id: identifierSchema,
  label: z.string().trim().max(240).optional(),
  path: z.string().min(1).max(4_096)
    .refine((value) => !value.includes("\\"), "backslashes are not supported")
    .refine((value) => !value.startsWith("/"), "absolute paths are not supported")
    .refine((value) => !value.split("/").some((part) => part === ".."), "path traversal is not supported")
    .optional(),
}).strict();
export type LineageDetailTarget = z.infer<typeof lineageDetailTargetSchema>;

export const lineageDiagnosticSchema = z.object({
  available: z.boolean(),
  code: identifierSchema.nullable().default(null),
  summary: boundedDiagnosticSchema.default(""),
  detailTarget: lineageDetailTargetSchema.nullable().default(null),
}).strict();
export type LineageDiagnostic = z.infer<typeof lineageDiagnosticSchema>;

/** One normalized entry. The source record remains authoritative; this is a navigation projection only. */
export const lineageEntrySchema = z.object({
  schemaVersion: lineageSchemaVersionSchema,
  entryId: lineageEntryIdSchema,
  projectId: lineageProjectIdSchema,
  occurredAt: timestampSchema,
  kind: lineageEntryKindSchema,
  title: z.string().trim().min(1).max(240),
  summary: boundedTextSchema,
  target: lineageDetailTargetSchema,
  /** Alias kept explicit for clients that call the navigation reference a detail target. */
  detailTarget: lineageDetailTargetSchema,
  status: z.string().trim().max(64).nullable().default(null),
  checkpointId: identifierSchema.nullable().default(null),
  runId: identifierSchema.nullable().default(null),
  proposalId: identifierSchema.nullable().default(null),
  attemptId: identifierSchema.nullable().default(null),
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/).nullable().default(null),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/).nullable().default(null),
  findingId: identifierSchema.nullable().default(null),
  commentId: identifierSchema.nullable().default(null),
  relatedTargets: z.array(lineageDetailTargetSchema).max(64).default([]),
  diagnostic: lineageDiagnosticSchema.nullable().default(null),
}).strict();
export type LineageEntry = z.infer<typeof lineageEntrySchema>;

export const lineageFreshnessSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: timestampSchema,
  status: z.enum(["fresh", "stale"]),
  cursorRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict();
export type LineageFreshness = z.infer<typeof lineageFreshnessSchema>;

export const lineagePageSchema = z.object({
  schemaVersion: lineageSchemaVersionSchema,
  projectId: lineageProjectIdSchema,
  entries: z.array(lineageEntrySchema).max(200),
  cursor: lineageCursorSchema.nullable().default(null),
  nextCursor: lineageCursorSchema.nullable().default(null),
  hasMore: z.boolean(),
  pageSize: z.number().int().positive().max(200),
  freshness: lineageFreshnessSchema,
}).strict();
export type LineagePage = z.infer<typeof lineagePageSchema>;

export const lineageListQuerySchema = z.object({
  cursor: lineageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type LineageListQuery = z.infer<typeof lineageListQuerySchema>;

/** Append-only cross-checkpoint meaning. A later decision supersedes this record; it never edits a finding. */
export const findingRelationshipSchema = z.object({
  relationshipId: identifierSchema,
  projectId: lineageProjectIdSchema,
  fromFindingId: identifierSchema,
  toFindingId: identifierSchema.nullable().default(null),
  relation: z.enum(["persists", "resolved", "superseded", "unresolved"]),
  rationale: z.string().trim().min(1).max(8_000),
  confidence: z.number().finite().min(0).max(1),
  origin: z.enum(["automatic", "human-confirmed", "human-corrected"]),
  actorId: identifierSchema,
  createdAt: timestampSchema,
  supersedesRelationshipId: identifierSchema.nullable().default(null),
}).strict();
export type FindingRelationship = z.infer<typeof findingRelationshipSchema>;
/** Canonical name used by the comparison/review layer. */
export const findingRelationshipDecisionSchema = findingRelationshipSchema;
export type FindingRelationshipDecision = FindingRelationship;

/** Request shape used when the server assigns the immutable lineage identity and timestamp. */
export const findingRelationshipInputSchema = findingRelationshipSchema.omit({
  relationshipId: true,
  projectId: true,
  createdAt: true,
}).extend({
  relationshipId: identifierSchema.optional(),
  createdAt: timestampSchema.optional(),
}).strict();
export type FindingRelationshipInput = z.infer<typeof findingRelationshipInputSchema>;

/** Review acknowledgement is bound to both the exact accepted checkpoint and QA attempt. */
export const checkpointReviewAcknowledgmentSchema = z.object({
  acknowledgmentId: identifierSchema,
  projectId: lineageProjectIdSchema,
  checkpointId: identifierSchema,
  qaAttemptId: identifierSchema,
  actorId: identifierSchema,
  createdAt: timestampSchema,
}).strict();
export type CheckpointReviewAcknowledgment = z.infer<typeof checkpointReviewAcknowledgmentSchema>;

/** Request shape used when the server assigns the acknowledgement identity and timestamp. */
export const checkpointReviewAcknowledgmentInputSchema = checkpointReviewAcknowledgmentSchema.omit({
  acknowledgmentId: true,
  projectId: true,
  createdAt: true,
}).extend({
  acknowledgmentId: identifierSchema.optional(),
  createdAt: timestampSchema.optional(),
}).strict();
export type CheckpointReviewAcknowledgmentInput = z.infer<typeof checkpointReviewAcknowledgmentInputSchema>;

/** Navigation state only. Process truth is always reconstructed from canonical records after restart. */
export const workspaceRestoreSelectionSchema = z.object({
  projectId: lineageProjectIdSchema,
  checkpointId: identifierSchema.nullable().default(null),
  selectedEntryId: lineageEntryIdSchema.nullable().default(null),
  activePanel: z.string().trim().min(1).max(128).nullable().default(null),
  pendingProposalId: identifierSchema.nullable().default(null),
  updatedAt: timestampSchema,
}).strict();
export type WorkspaceRestoreSelection = z.infer<typeof workspaceRestoreSelectionSchema>;

export const finalCheckpointSummarySchema = z.object({
  schemaVersion: lineageSchemaVersionSchema,
  projectId: lineageProjectIdSchema,
  checkpointId: identifierSchema.nullable().default(null),
  reportTarget: lineageDetailTargetSchema.nullable().default(null),
  latestQaAttemptId: identifierSchema.nullable().default(null),
  latestQaOutcome: z.string().trim().max(64).nullable().default(null),
  remainingRiskCounts: z.object({ open: z.number().int().nonnegative(), accepted: z.number().int().nonnegative() }).strict(),
  sourceHealth: z.object({ total: z.number().int().nonnegative(), archived: z.number().int().nonnegative(), metadataOnly: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
  reviewAcknowledged: z.boolean(),
  proposalDecision: z.enum(["pending", "keep", "reject"]).nullable().default(null),
  generatedAt: timestampSchema,
}).strict();
export type FinalCheckpointSummary = z.infer<typeof finalCheckpointSummarySchema>;
