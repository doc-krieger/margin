import { z } from "zod";

/** Versioned contracts for independent, append-only report quality reviews. */
export const qualitySchemaVersion = 1 as const;
export const qualitySchemaVersionSchema = z.literal(qualitySchemaVersion);

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedPathSchema = z.string().min(1).max(4096)
  .refine((value) => !value.includes("\\"), "backslashes are not supported")
  .refine((value) => !value.startsWith("/"), "absolute paths are not supported")
  .refine((value) => !value.split("/").some((segment) => segment === ".."), "path traversal is not supported");
const timestampSchema = z.string().datetime({ offset: true });
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/, "checksum must be a lowercase SHA-256 digest");
const boundedDiagnosticSchema = z.string().max(32_000);
const boundedTextSchema = z.string().trim().max(32_000);

export const qualityReviewIdSchema = identifierSchema;
export const qualityAttemptIdSchema = identifierSchema;
export const qualityFindingIdSchema = identifierSchema;
export const qualityDispositionIdSchema = identifierSchema;
export const qualityPromotionIdSchema = identifierSchema;
export const qualityComparisonIdSchema = identifierSchema;
export const qualityProjectIdSchema = identifierSchema;
export const qualitySessionIdSchema = identifierSchema;
export const qualityCorrelationIdSchema = z.string().uuid();

export const qualityEvidenceAvailabilitySchema = z.enum(["full-text", "metadata-only", "unavailable"]);
export type QualityEvidenceAvailability = z.infer<typeof qualityEvidenceAvailabilitySchema>;

/** A source/version binding captured by the accepted checkpoint. Never resolve latest at review time. */
export const qualitySourceBindingSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  checksum: checksumSchema,
  required: z.boolean().default(true),
  citationKeys: z.array(identifierSchema).max(1_000).default([]),
  evidenceAvailability: qualityEvidenceAvailabilitySchema,
  evidenceChecksum: checksumSchema.nullable().default(null),
}).strict().superRefine((binding, context) => {
  if (binding.evidenceAvailability === "full-text" && binding.evidenceChecksum === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceChecksum"], message: "full-text evidence requires evidenceChecksum" });
  }
});
export type QualitySourceBinding = z.infer<typeof qualitySourceBindingSchema>;

export const qualitySourceGraphSchema = z.object({
  graphId: identifierSchema,
  sourceBindings: z.array(qualitySourceBindingSchema).max(10_000),
  graphChecksum: checksumSchema.nullable().default(null),
  capturedAt: timestampSchema,
}).strict().superRefine((graph, context) => {
  const seen = new Set<string>();
  for (const binding of graph.sourceBindings) {
    const key = `${binding.sourceId}:${binding.versionId}`;
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceBindings"], message: "source/version bindings must be unique" });
      break;
    }
    seen.add(key);
  }
});
export type QualitySourceGraph = z.infer<typeof qualitySourceGraphSchema>;

/** The report and source graph accepted for review. This object is immutable once a review is created. */
export const qualityAcceptedCheckpointSchema = z.object({
  checkpointId: identifierSchema,
  reportArtifactId: identifierSchema,
  reportPath: boundedPathSchema,
  reportSha256: checksumSchema,
  sourceGraph: qualitySourceGraphSchema,
  citationValidationHash: checksumSchema.nullable().default(null),
  acceptedAt: timestampSchema,
  acceptedBy: identifierSchema,
}).strict();
export type QualityAcceptedCheckpoint = z.infer<typeof qualityAcceptedCheckpointSchema>;

export const qualityReviewerInstructionSchema = z.object({
  instructionId: identifierSchema,
  text: z.string().trim().min(1).max(20_000),
  sha256: checksumSchema,
  createdAt: timestampSchema,
}).strict();
export type QualityReviewerInstruction = z.infer<typeof qualityReviewerInstructionSchema>;

export const qualityReportAnchorSchema = z.object({
  relativePath: boundedPathSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  line: z.number().int().positive().nullable().default(null),
  column: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  endColumn: z.number().int().positive().nullable().default(null),
  quote: z.string().min(1).max(4_000),
}).strict().superRefine((anchor, context) => {
  if (anchor.endOffset < anchor.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endOffset"], message: "endOffset must not be before startOffset" });
  }
});
export type QualityReportAnchor = z.infer<typeof qualityReportAnchorSchema>;

/** Explicitly distinguishes a report location from a finding with no safe anchor. */
export const qualityFindingLocationSchema = z.object({
  status: z.enum(["anchored", "unanchored"]),
  anchor: qualityReportAnchorSchema.nullable().default(null),
  diagnostic: z.string().trim().max(4_000).default(""),
}).strict().superRefine((location, context) => {
  if (location.status === "anchored" && location.anchor === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor"], message: "anchored findings require a report anchor" });
  }
  if (location.status === "unanchored" && location.anchor !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor"], message: "unanchored findings cannot carry a report anchor" });
  }
});
export type QualityFindingLocation = z.infer<typeof qualityFindingLocationSchema>;

export const qualityCitationReferenceSchema = z.object({
  citationKey: identifierSchema,
  usageId: identifierSchema.nullable().default(null),
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/).nullable().default(null),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/).nullable().default(null),
}).strict().superRefine((citation, context) => {
  if ((citation.sourceId === null) !== (citation.versionId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "sourceId and versionId must be provided together" });
  }
});
export type QualityCitationReference = z.infer<typeof qualityCitationReferenceSchema>;

export const qualityEvidenceReferenceSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  checksum: checksumSchema,
  availability: qualityEvidenceAvailabilitySchema,
  excerpt: z.string().max(4_000).nullable().default(null),
  relativePath: boundedPathSchema.nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  diagnostic: z.string().trim().max(4_000).default(""),
}).strict().superRefine((evidence, context) => {
  if (evidence.availability === "full-text" && evidence.excerpt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["excerpt"], message: "full-text evidence requires an excerpt" });
  }
});
export type QualityEvidenceReference = z.infer<typeof qualityEvidenceReferenceSchema>;

export const qualityFindingKindSchema = z.enum([
  "unsupported-claim",
  "contradictory-claim",
  "overstated-claim",
  "unresolved-citation",
  "missing-context",
  "source-quality",
  "other",
]);
export type QualityFindingKind = z.infer<typeof qualityFindingKindSchema>;
export const qualitySeveritySchema = z.enum(["low", "medium", "high"]);
export type QualitySeverity = z.infer<typeof qualitySeveritySchema>;
export const qualityUncertaintySchema = z.enum(["low", "medium", "high"]);
export type QualityUncertainty = z.infer<typeof qualityUncertaintySchema>;

/** Immutable claim-linked output from one reviewer attempt. Changes are represented by dispositions. */
export const qualityFindingSchema = z.object({
  findingId: qualityFindingIdSchema,
  attemptId: qualityAttemptIdSchema,
  kind: qualityFindingKindSchema,
  severity: qualitySeveritySchema,
  uncertainty: qualityUncertaintySchema,
  title: z.string().trim().min(1).max(240),
  rationale: boundedTextSchema,
  suggestedRevision: boundedTextSchema.nullable().default(null),
  location: qualityFindingLocationSchema,
  citation: qualityCitationReferenceSchema.nullable().default(null),
  evidence: z.array(qualityEvidenceReferenceSchema).max(100).default([]),
  createdAt: timestampSchema,
}).strict();
export type QualityFinding = z.infer<typeof qualityFindingSchema>;

export const qualityProgressTypeSchema = z.enum([
  "queued",
  "started",
  "claim-reviewed",
  "finding-recorded",
  "checkpoint-verified",
  "diagnostic",
  "completed",
  "failed",
  "partial",
  "inconclusive",
  "cancelled",
]);
export type QualityProgressType = z.infer<typeof qualityProgressTypeSchema>;

export const qualityProgressEventSchema = z.object({
  eventId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  type: qualityProgressTypeSchema,
  timestamp: timestampSchema,
  message: z.string().trim().max(4_000).default(""),
  claimId: identifierSchema.nullable().default(null),
  findingId: qualityFindingIdSchema.nullable().default(null),
  percent: z.number().finite().min(0).max(100).nullable().default(null),
}).strict();
export type QualityProgressEvent = z.infer<typeof qualityProgressEventSchema>;

export const qualityAttemptStatisticsSchema = z.object({
  claimsReviewed: z.number().int().nonnegative().max(10_000_000).default(0),
  findingsProduced: z.number().int().nonnegative().max(10_000_000).default(0),
  anchoredFindings: z.number().int().nonnegative().max(10_000_000).default(0),
  unanchoredFindings: z.number().int().nonnegative().max(10_000_000).default(0),
  unresolvedCitations: z.number().int().nonnegative().max(10_000_000).default(0),
  sourceCount: z.number().int().nonnegative().max(10_000).default(0),
  evidenceCount: z.number().int().nonnegative().max(10_000_000).default(0),
  eventCount: z.number().int().nonnegative().max(10_000_000).default(0),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  totalTokens: z.number().int().nonnegative().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
}).strict();
export type QualityAttemptStatistics = z.infer<typeof qualityAttemptStatisticsSchema>;

export const qualityProcessExitSchema = z.object({
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().max(64).nullable().default(null),
  timedOut: z.boolean().default(false),
  aborted: z.boolean().default(false),
  exitedAt: timestampSchema.nullable().default(null),
}).strict();
export type QualityProcessExit = z.infer<typeof qualityProcessExitSchema>;

export const qualityCancellationSchema = z.object({
  requested: z.boolean().default(false),
  requestedAt: timestampSchema.nullable().default(null),
  reason: z.string().trim().max(4_000).nullable().default(null),
  settledAt: timestampSchema.nullable().default(null),
}).strict();
export type QualityCancellation = z.infer<typeof qualityCancellationSchema>;

export const qualityTerminalDiagnosticsSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_000),
  stderr: boundedDiagnosticSchema.default(""),
  protocol: boundedDiagnosticSchema.nullable().default(null),
  processExit: qualityProcessExitSchema.nullable().default(null),
}).strict();
export type QualityTerminalDiagnostics = z.infer<typeof qualityTerminalDiagnosticsSchema>;

export const qualityAttemptStatusSchema = z.enum(["queued", "running", "cancelling", "cancelled", "failed", "partial", "inconclusive", "completed"]);
export type QualityAttemptStatus = z.infer<typeof qualityAttemptStatusSchema>;
export const qualityAttemptOutcomeSchema = z.enum(["pass", "findings", "partial", "inconclusive", "failed", "cancelled"]);
export type QualityAttemptOutcome = z.infer<typeof qualityAttemptOutcomeSchema>;

export const qualityComparisonSchema = z.object({
  comparisonId: qualityComparisonIdSchema,
  comparedAttemptId: qualityAttemptIdSchema,
  checkpointId: identifierSchema,
  basis: z.enum(["same-checkpoint", "different-checkpoint"]),
  unchangedCheckpoint: z.boolean(),
  createdAt: timestampSchema,
}).strict().superRefine((comparison, context) => {
  if (comparison.basis === "same-checkpoint" && !comparison.unchangedCheckpoint) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unchangedCheckpoint"], message: "same-checkpoint comparisons must mark unchangedCheckpoint" });
  }
});
export type QualityComparison = z.infer<typeof qualityComparisonSchema>;

export const qualityReviewAttemptSchema = z.object({
  attemptId: qualityAttemptIdSchema,
  parentAttemptId: qualityAttemptIdSchema.nullable().default(null),
  sessionId: qualitySessionIdSchema.nullable().default(null),
  correlationId: qualityCorrelationIdSchema,
  reviewerInstructionId: identifierSchema,
  status: qualityAttemptStatusSchema,
  outcome: qualityAttemptOutcomeSchema.nullable().default(null),
  progress: z.array(qualityProgressEventSchema).max(100_000).default([]),
  statistics: qualityAttemptStatisticsSchema,
  findingIds: z.array(qualityFindingIdSchema).max(10_000).default([]),
  comparison: qualityComparisonSchema.nullable().default(null),
  cancellation: qualityCancellationSchema,
  diagnostics: qualityTerminalDiagnosticsSchema.nullable().default(null),
  processExit: qualityProcessExitSchema.nullable().default(null),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable().default(null),
  endedAt: timestampSchema.nullable().default(null),
  lastProgressAt: timestampSchema.nullable().default(null),
}).strict().superRefine((attempt, context) => {
  if (attempt.parentAttemptId === attempt.attemptId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentAttemptId"], message: "quality attempt cannot parent itself" });
  }
  const sequences = new Set<number>();
  for (const [index, event] of attempt.progress.entries()) {
    if (sequences.has(event.sequence)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["progress", index, "sequence"], message: "progress sequence values must be unique" });
    }
    if (index > 0 && event.sequence <= attempt.progress[index - 1]!.sequence) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["progress", index, "sequence"], message: "progress must be ordered by sequence" });
    }
    sequences.add(event.sequence);
  }
  if (attempt.status === "completed" && attempt.outcome === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "completed quality attempts require an outcome" });
  }
  if (attempt.status === "cancelled" && attempt.outcome !== "cancelled") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "cancelled quality attempts require a cancelled outcome" });
  }
});
export type QualityReviewAttempt = z.infer<typeof qualityReviewAttemptSchema>;

export const qualityDispositionActionSchema = z.enum(["accepted-risk", "false-positive"]);
export type QualityDispositionAction = z.infer<typeof qualityDispositionActionSchema>;

/** A disposition never edits a finding; a later disposition can supersede this immutable entry. */
export const qualityFindingDispositionSchema = z.object({
  dispositionId: qualityDispositionIdSchema,
  findingId: qualityFindingIdSchema,
  action: qualityDispositionActionSchema,
  rationale: z.string().trim().min(1).max(8_000),
  actorId: identifierSchema,
  supersedesDispositionId: qualityDispositionIdSchema.nullable().default(null),
  createdAt: timestampSchema,
}).strict();
export type QualityFindingDisposition = z.infer<typeof qualityFindingDispositionSchema>;

export const qualityPromotionTargetSchema = z.enum(["comment", "revision-input"]);
export type QualityPromotionTarget = z.infer<typeof qualityPromotionTargetSchema>;
export const qualityFindingPromotionSchema = z.object({
  promotionId: qualityPromotionIdSchema,
  findingId: qualityFindingIdSchema,
  target: qualityPromotionTargetSchema,
  targetId: identifierSchema,
  actorId: identifierSchema,
  createdAt: timestampSchema,
}).strict();
export type QualityFindingPromotion = z.infer<typeof qualityFindingPromotionSchema>;

export const qualityReviewStatusSchema = z.enum(["draft", "queued", "running", "cancelling", "cancelled", "failed", "partial", "inconclusive", "completed"]);
export type QualityReviewStatus = z.infer<typeof qualityReviewStatusSchema>;

export const qualityReviewRecordSchema = z.object({
  schemaVersion: qualitySchemaVersionSchema,
  reviewId: qualityReviewIdSchema,
  projectId: qualityProjectIdSchema,
  correlationId: qualityCorrelationIdSchema,
  targetCheckpoint: qualityAcceptedCheckpointSchema,
  reviewerInstruction: qualityReviewerInstructionSchema,
  status: qualityReviewStatusSchema,
  attempts: z.array(qualityReviewAttemptSchema).max(1_000).default([]),
  latestAttemptId: qualityAttemptIdSchema.nullable().default(null),
  findings: z.array(qualityFindingSchema).max(100_000).default([]),
  dispositions: z.array(qualityFindingDispositionSchema).max(100_000).default([]),
  promotions: z.array(qualityFindingPromotionSchema).max(100_000).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((review, context) => {
  const attempts = new Set<string>();
  for (const [index, attempt] of review.attempts.entries()) {
    if (attempts.has(attempt.attemptId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempts", index, "attemptId"], message: "quality attempt IDs must be unique" });
    }
    attempts.add(attempt.attemptId);
    if (attempt.reviewerInstructionId !== review.reviewerInstruction.instructionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempts", index, "reviewerInstructionId"], message: "attempt reviewer instruction must match the review snapshot" });
    }
  }
  if (review.latestAttemptId !== null && !attempts.has(review.latestAttemptId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["latestAttemptId"], message: "latestAttemptId must reference a stored quality attempt" });
  }
  const findings = new Set<string>();
  for (const [index, finding] of review.findings.entries()) {
    if (findings.has(finding.findingId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["findings", index, "findingId"], message: "quality finding IDs must be unique" });
    }
    findings.add(finding.findingId);
    if (!attempts.has(finding.attemptId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["findings", index, "attemptId"], message: "finding must reference a stored attempt" });
    }
  }
  const dispositions = new Set<string>();
  for (const [index, disposition] of review.dispositions.entries()) {
    if (dispositions.has(disposition.dispositionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dispositions", index, "dispositionId"], message: "disposition IDs must be unique" });
    }
    dispositions.add(disposition.dispositionId);
    if (!findings.has(disposition.findingId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dispositions", index, "findingId"], message: "disposition must reference a stored finding" });
    }
  }
  const promotions = new Set<string>();
  for (const [index, promotion] of review.promotions.entries()) {
    if (promotions.has(promotion.promotionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["promotions", index, "promotionId"], message: "promotion IDs must be unique" });
    }
    promotions.add(promotion.promotionId);
    if (!findings.has(promotion.findingId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["promotions", index, "findingId"], message: "promotion must reference a stored finding" });
    }
  }
});
export type QualityReviewRecord = z.infer<typeof qualityReviewRecordSchema>;

export const terminalQualityAttemptStatuses: readonly QualityAttemptStatus[] = ["cancelled", "failed", "partial", "inconclusive", "completed"];
export function isTerminalQualityAttemptStatus(status: QualityAttemptStatus): boolean {
  return terminalQualityAttemptStatuses.includes(status);
}

export const activeQualityAttemptStatuses: readonly QualityAttemptStatus[] = ["queued", "running", "cancelling"];
export function isActiveQualityAttemptStatus(status: QualityAttemptStatus): boolean {
  return activeQualityAttemptStatuses.includes(status);
}

export const terminalQualityReviewStatuses: readonly QualityReviewStatus[] = ["cancelled", "failed", "partial", "inconclusive", "completed"];
export function isTerminalQualityReviewStatus(status: QualityReviewStatus): boolean {
  return terminalQualityReviewStatuses.includes(status);
}
