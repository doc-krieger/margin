import { z } from "zod";

/** Versioned contracts for the durable research boundary. Report bodies remain files; these are metadata and references only. */
export const researchSchemaVersion = 1 as const;
export const researchSchemaVersionSchema = z.literal(researchSchemaVersion);

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedPathSchema = z.string().min(1).max(4096)
  .refine((value) => !value.includes("\\"), "backslashes are not supported")
  .refine((value) => !value.startsWith("/"), "absolute paths are not supported")
  .refine((value) => !value.split("/").some((segment) => segment === ".."), "path traversal is not supported");
const timestampSchema = z.string().datetime({ offset: true });
const boundedDiagnosticSchema = z.string().max(32_000);

export const researchBriefIdSchema = identifierSchema;
export const researchRunIdSchema = identifierSchema;
export const researchProjectIdSchema = identifierSchema;
export const researchCorrelationIdSchema = z.string().uuid();

export const researchRecipeSchema = z.enum(["quick", "standard", "deep"]);
export type ResearchRecipe = z.infer<typeof researchRecipeSchema>;

export const researchRecipeDefinitionSchema = z.object({
  id: researchRecipeSchema,
  label: z.string().min(1).max(80),
  outcome: z.string().min(1).max(2_000),
  reviewExpectation: z.string().min(1).max(2_000),
  suggestedStages: z.array(z.string().min(1).max(64)).min(1).max(16),
});
export type ResearchRecipeDefinition = z.infer<typeof researchRecipeDefinitionSchema>;

export const researchRecipeDefinitions: Record<ResearchRecipe, ResearchRecipeDefinition> = {
  quick: {
    id: "quick",
    label: "Quick",
    outcome: "A bounded answer with a small set of primary or directly relevant sources.",
    reviewExpectation: "Check that the answer addresses the question and that cited sources support the key claims.",
    suggestedStages: ["planning", "researching", "synthesizing"],
  },
  standard: {
    id: "standard",
    label: "Standard",
    outcome: "A balanced research brief, evidence set, and cited report suitable for review.",
    reviewExpectation: "Check coverage, source quality, citation support, uncertainty, and notable omissions.",
    suggestedStages: ["planning", "scouting", "researching", "synthesizing", "reviewing"],
  },
  deep: {
    id: "deep",
    label: "Deep",
    outcome: "A broad, multi-source investigation with explicit evidence gaps and a carefully reviewed report.",
    reviewExpectation: "Check competing evidence, source limitations, claim-level support, and unresolved questions.",
    suggestedStages: ["planning", "scouting", "researching", "synthesizing", "reviewing", "finalizing"],
  },
};

export const researchOutputModeSchema = z.enum(["research-only", "research-and-report"]);
export type ResearchOutputMode = z.infer<typeof researchOutputModeSchema>;

export const researchBriefStatusSchema = z.enum(["draft", "confirmed"]);
export type ResearchBriefStatus = z.infer<typeof researchBriefStatusSchema>;

export const researchClarificationDecisionSchema = z.object({
  decisionId: identifierSchema,
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(4_000),
  resolved: z.boolean().default(true),
  createdAt: timestampSchema,
}).strict();
export type ResearchClarificationDecision = z.infer<typeof researchClarificationDecisionSchema>;

export const researchOutputPathsSchema = z.object({
  reportPath: boundedPathSchema.nullable().default(null),
  notesPath: boundedPathSchema.nullable().default(null),
  manifestPath: boundedPathSchema.nullable().default(null),
}).strict();
export type ResearchOutputPaths = z.infer<typeof researchOutputPathsSchema>;

export const sourcePreferenceSchema = z.object({
  permittedKinds: z.array(z.string().min(1).max(64)).max(32).default([]),
  preferredKinds: z.array(z.string().min(1).max(64)).max(32).default([]),
  preferPrimarySources: z.boolean().default(true),
  languages: z.array(z.string().regex(/^[a-zA-Z]{2,12}$/)).max(16).default([]),
});
export type SourcePreferences = z.infer<typeof sourcePreferenceSchema>;

export const dateLimitsSchema = z.object({
  from: timestampSchema.nullable().default(null),
  to: timestampSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) context.addIssue({ code: z.ZodIssueCode.custom, message: "date limit from must not be after to", path: ["from"] });
});

export const researchBriefSchema = z.object({
  schemaVersion: researchSchemaVersionSchema,
  briefId: researchBriefIdSchema,
  projectId: researchProjectIdSchema,
  question: z.string().trim().min(1).max(20_000),
  scope: z.string().trim().min(1).max(20_000),
  audience: z.string().trim().max(4_000).default(""),
  exclusions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  depth: researchRecipeSchema.default("standard"),
  outline: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  outputMode: researchOutputModeSchema.default("research-and-report"),
  outputPaths: researchOutputPathsSchema.default({}),
  sourcePreferences: sourcePreferenceSchema.default({}),
  dateLimits: dateLimitsSchema.nullable().default(null),
  recipe: researchRecipeSchema.default("standard"),
  status: researchBriefStatusSchema.default("draft"),
  clarificationDecisions: z.array(researchClarificationDecisionSchema).max(3).default([]),
  revision: z.number().int().positive().max(1_000_000).default(1),
  confirmedRevision: z.number().int().positive().max(1_000_000).nullable().default(null),
  confirmedAt: timestampSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((brief, context) => {
  if (brief.status === "confirmed" && brief.confirmedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmedAt"], message: "confirmed briefs require confirmedAt" });
  }
  if (brief.status === "confirmed" && brief.confirmedRevision === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmedRevision"], message: "confirmed briefs require confirmedRevision" });
  }
  if (brief.confirmedRevision !== null && brief.confirmedRevision > brief.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmedRevision"], message: "confirmedRevision cannot exceed revision" });
  }
});
export type ResearchBrief = z.infer<typeof researchBriefSchema>;

export const researchStageNameSchema = z.enum(["planning", "scouting", "researching", "synthesizing", "reviewing", "finalizing"]);
export type ResearchStageName = z.infer<typeof researchStageNameSchema>;
export const researchStageStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled", "skipped"]);
export type ResearchStageStatus = z.infer<typeof researchStageStatusSchema>;

export const researchStageRecordSchema = z.object({
  stage: researchStageNameSchema,
  status: researchStageStatusSchema,
  startedAt: timestampSchema.nullable().default(null),
  endedAt: timestampSchema.nullable().default(null),
  artifactIds: z.array(identifierSchema).max(100).default([]),
  diagnostics: boundedDiagnosticSchema.nullable().default(null),
});
export type ResearchStageRecord = z.infer<typeof researchStageRecordSchema>;

export const researchCapabilityIdSchema = identifierSchema;
export const researchCapabilityDeclarationSchema = z.object({
  id: researchCapabilityIdSchema,
  label: z.string().min(1).max(160),
  description: z.string().max(2_000).default(""),
  required: z.boolean().default(true),
});
export type ResearchCapabilityDeclaration = z.infer<typeof researchCapabilityDeclarationSchema>;

export const researchCapabilityStatusSchema = z.enum(["available", "unavailable", "unknown"]);
export type ResearchCapabilityStatus = z.infer<typeof researchCapabilityStatusSchema>;
export const researchCapabilityResultSchema = z.object({
  id: researchCapabilityIdSchema,
  status: researchCapabilityStatusSchema,
  checkedAt: timestampSchema,
  evidence: z.array(z.string().max(4_000)).max(16).default([]),
  diagnostics: boundedDiagnosticSchema.nullable().default(null),
});
export type ResearchCapabilityResult = z.infer<typeof researchCapabilityResultSchema>;

export const researchCapabilitySnapshotSchema = z.object({
  checkedAt: timestampSchema,
  executable: researchCapabilityResultSchema,
  rpc: researchCapabilityResultSchema,
  required: z.array(researchCapabilityDeclarationSchema).max(100).default([]),
  results: z.array(researchCapabilityResultSchema).max(100).default([]),
  profilePolicy: z.string().max(4_000).nullable().default(null),
});
export type ResearchCapabilitySnapshot = z.infer<typeof researchCapabilitySnapshotSchema>;

export const researchArtifactKindSchema = z.enum(["notes", "report", "source-reference", "source-manifest", "proposal", "diagnostic", "other"]);
export type ResearchArtifactKind = z.infer<typeof researchArtifactKindSchema>;
export const researchArtifactStatusSchema = z.enum(["partial", "complete", "failed"]);
export const partialArtifactReferenceSchema = z.object({
  artifactId: identifierSchema,
  kind: researchArtifactKindSchema,
  status: researchArtifactStatusSchema,
  relativePath: boundedPathSchema,
  label: z.string().max(240).default(""),
  bytes: z.number().int().nonnegative().max(1_000_000_000).nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type PartialArtifactReference = z.infer<typeof partialArtifactReferenceSchema>;

export const researchSourceSelectionSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  required: z.boolean().default(true),
}).strict();
export type ResearchSourceSelection = z.infer<typeof researchSourceSelectionSchema>;

export const researchSourceProjectionEntrySchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(256),
  required: z.boolean(),
  relativePath: boundedPathSchema,
}).strict();

export const researchMissingSourceEvidenceSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  required: z.boolean(),
  code: z.enum(["SOURCE_NOT_FOUND", "VERSION_NOT_FOUND", "EVIDENCE_UNAVAILABLE"]),
  message: z.string().min(1).max(4000),
}).strict();

export const researchSourceProjectionSchema = z.object({
  status: z.enum(["ready", "partial"]),
  relativeRoot: boundedPathSchema,
  manifestPath: boundedPathSchema,
  entries: z.array(researchSourceProjectionEntrySchema).max(1000),
  missing: z.array(researchMissingSourceEvidenceSchema).max(1000),
  generatedAt: timestampSchema,
}).strict();
export type ResearchSourceProjection = z.infer<typeof researchSourceProjectionSchema>;

/** The exact source/version bytes that a synthesis attempt is allowed to read. */
export const researchFrozenSourceBindingSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  required: z.boolean().default(true),
  citationKey: identifierSchema.nullable().default(null),
}).strict();
export type ResearchFrozenSourceBinding = z.infer<typeof researchFrozenSourceBindingSchema>;

export const researchCitationLocationSchema = z.union([
  boundedPathSchema,
  z.object({
    relativePath: boundedPathSchema,
    line: z.number().int().positive().nullable().default(null),
    column: z.number().int().positive().nullable().default(null),
    endLine: z.number().int().positive().nullable().default(null),
    endColumn: z.number().int().positive().nullable().default(null),
  }).strict(),
]);
export type ResearchCitationLocation = z.infer<typeof researchCitationLocationSchema>;

export const researchCitationUsageSchema = z.object({
  usageId: identifierSchema,
  citationKey: identifierSchema,
  sourceId: z.string().regex(/^src_[a-f0-9]{16,64}$/),
  versionId: z.string().regex(/^ev_[a-f0-9]{16,64}$/),
  location: researchCitationLocationSchema,
  excerpt: z.string().max(4_000).nullable().default(null),
}).strict();
export type ResearchCitationUsage = z.infer<typeof researchCitationUsageSchema>;

export const researchCitationValidationSchema = z.object({
  status: z.enum(["valid", "partial", "failed"]),
  unresolvedKeys: z.array(identifierSchema).max(1_000).default([]),
  ambiguousKeys: z.array(identifierSchema).max(1_000).default([]),
  usages: z.array(researchCitationUsageSchema).max(10_000).default([]),
  diagnostics: boundedDiagnosticSchema.default(""),
}).strict();
export type ResearchCitationValidation = z.infer<typeof researchCitationValidationSchema>;

export const researchSynthesisInputSchema = z.object({
  confirmedBriefRevision: z.number().int().positive().max(1_000_000),
  confirmedBriefHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBindings: z.array(researchFrozenSourceBindingSchema).max(1_000),
  notesArtifactId: identifierSchema.nullable().default(null),
  notesSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  profileId: identifierSchema,
  priorAttemptId: identifierSchema.nullable().default(null),
}).strict().superRefine((input, context) => {
  if ((input.notesArtifactId === null) !== (input.notesSha256 === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["notesArtifactId"], message: "notesArtifactId and notesSha256 must be provided together" });
  }
});
export type ResearchSynthesisInput = z.infer<typeof researchSynthesisInputSchema>;

export const researchSynthesisAttemptStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed", "cancelled"]);
export type ResearchSynthesisAttemptStatus = z.infer<typeof researchSynthesisAttemptStatusSchema>;

export const researchSynthesisAttemptSchema = z.object({
  attemptId: identifierSchema,
  parentAttemptId: identifierSchema.nullable().default(null),
  status: researchSynthesisAttemptStatusSchema,
  input: researchSynthesisInputSchema,
  notesArtifactId: identifierSchema.nullable().default(null),
  reportArtifactId: identifierSchema.nullable().default(null),
  citationValidation: researchCitationValidationSchema.nullable().default(null),
  diagnostics: boundedDiagnosticSchema.nullable().default(null),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable().default(null),
  endedAt: timestampSchema.nullable().default(null),
}).strict().superRefine((attempt, context) => {
  if (attempt.parentAttemptId === attempt.attemptId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentAttemptId"], message: "synthesis attempt cannot parent itself" });
  }
  if (attempt.status === "completed" && attempt.reportArtifactId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reportArtifactId"], message: "completed synthesis attempts require a report artifact" });
  }
});
export type ResearchSynthesisAttempt = z.infer<typeof researchSynthesisAttemptSchema>;

export const researchProposalStatusSchema = z.enum(["pending", "kept", "rejected", "conflict", "failed"]);
export type ResearchProposalStatus = z.infer<typeof researchProposalStatusSchema>;
export const researchProposalDecisionSchema = z.enum(["keep", "reject"]);
export type ResearchProposalDecision = z.infer<typeof researchProposalDecisionSchema>;
export const researchProposalCleanupSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: timestampSchema.nullable().default(null),
  endedAt: timestampSchema.nullable().default(null),
  diagnostics: boundedDiagnosticSchema.nullable().default(null),
}).strict();
export type ResearchProposalCleanup = z.infer<typeof researchProposalCleanupSchema>;

/** Review lineage is separate from execution state so Keep/Reject never rewrites the run history. */
export const researchProposalLineageSchema = z.object({
  proposalId: identifierSchema,
  status: researchProposalStatusSchema,
  decision: researchProposalDecisionSchema.nullable().default(null),
  artifactIds: z.array(identifierSchema).max(1_000).default([]),
  reportArtifactId: identifierSchema.nullable().default(null),
  notesArtifactId: identifierSchema.nullable().default(null),
  manifestArtifactId: identifierSchema.nullable().default(null),
  cleanup: researchProposalCleanupSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decidedAt: timestampSchema.nullable().default(null),
}).strict().superRefine((proposal, context) => {
  if (proposal.status === "pending" && proposal.decision !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "pending proposals cannot have a decision" });
  }
  if (proposal.status !== "pending" && proposal.decision === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "terminal proposals require a decision" });
  }
});
export type ResearchProposalLineage = z.infer<typeof researchProposalLineageSchema>;

export const researchCancellationSchema = z.object({
  requested: z.boolean().default(false),
  requestedAt: timestampSchema.nullable().default(null),
  reason: z.string().trim().max(4_000).nullable().default(null),
  settledAt: timestampSchema.nullable().default(null),
});
export type ResearchCancellation = z.infer<typeof researchCancellationSchema>;

export const researchSessionStatisticsSchema = z.object({
  sessionId: identifierSchema.nullable().default(null),
  eventCount: z.number().int().nonnegative().max(10_000_000).default(0),
  commandCount: z.number().int().nonnegative().max(1_000_000).default(0),
  promptCount: z.number().int().nonnegative().max(1_000_000).default(0),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  totalTokens: z.number().int().nonnegative().nullable().default(null),
  costUsd: z.number().nonnegative().finite().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  lastEventAt: timestampSchema.nullable().default(null),
});
export type ResearchSessionStatistics = z.infer<typeof researchSessionStatisticsSchema>;

export const researchProcessExitSchema = z.object({
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().max(64).nullable().default(null),
  timedOut: z.boolean().default(false),
  aborted: z.boolean().default(false),
  exitedAt: timestampSchema.nullable().default(null),
});
export type ResearchProcessExit = z.infer<typeof researchProcessExitSchema>;

export const researchTerminalDiagnosticsSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_000),
  stderr: boundedDiagnosticSchema.default(""),
  protocol: boundedDiagnosticSchema.nullable().default(null),
  processExit: researchProcessExitSchema.nullable().default(null),
});
export type ResearchTerminalDiagnostics = z.infer<typeof researchTerminalDiagnosticsSchema>;

export const researchRunStatusSchema = z.enum(["queued", "running", "cancelling", "cancelled", "failed", "partial", "completed"]);
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>;

export const researchRunRecordSchema = z.object({
  schemaVersion: researchSchemaVersionSchema,
  runId: researchRunIdSchema,
  correlationId: researchCorrelationIdSchema,
  projectId: researchProjectIdSchema,
  profileId: identifierSchema,
  brief: researchBriefSchema,
  recipe: researchRecipeSchema,
  status: researchRunStatusSchema,
  currentStage: researchStageRecordSchema,
  stageHistory: z.array(researchStageRecordSchema).max(100).default([]),
  requiredCapabilities: z.array(researchCapabilityDeclarationSchema).max(100).default([]),
  sourceSelections: z.array(researchSourceSelectionSchema).max(1000).default([]),
  sourceProjection: researchSourceProjectionSchema.nullable().default(null),
  /** Exact source/version checksums captured for synthesis and retry; never resolve latest here. */
  frozenSourceBindings: z.array(researchFrozenSourceBindingSchema).max(1_000).default([]),
  capabilities: researchCapabilitySnapshotSchema.nullable().default(null),
  session: researchSessionStatisticsSchema,
  artifacts: z.array(partialArtifactReferenceSchema).max(1_000).default([]),
  synthesisAttempts: z.array(researchSynthesisAttemptSchema).max(100).default([]),
  latestSynthesisAttemptId: identifierSchema.nullable().default(null),
  proposal: researchProposalLineageSchema.nullable().default(null),
  cancellation: researchCancellationSchema,
  diagnostics: researchTerminalDiagnosticsSchema.nullable().default(null),
  processExit: researchProcessExitSchema.nullable().default(null),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable().default(null),
  endedAt: timestampSchema.nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  lastEventAt: timestampSchema.nullable().default(null),
}).superRefine((run, context) => {
  if (run.latestSynthesisAttemptId !== null && !run.synthesisAttempts.some((attempt) => attempt.attemptId === run.latestSynthesisAttemptId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["latestSynthesisAttemptId"], message: "latestSynthesisAttemptId must reference a stored synthesis attempt" });
  }
  const attempts = new Set<string>();
  for (const attempt of run.synthesisAttempts) {
    if (attempts.has(attempt.attemptId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["synthesisAttempts"], message: "synthesis attempt IDs must be unique" });
      break;
    }
    attempts.add(attempt.attemptId);
  }
});
export type ResearchRunRecord = z.infer<typeof researchRunRecordSchema>;

export const researchEventTypeSchema = z.enum([
  "research.started",
  "research.capability",
  "research.stage",
  "research.artifact",
  "research.progress",
  "research.diagnostic",
  "research.completed",
  "research.failed",
  "research.cancelled",
]);
export type ResearchEventType = z.infer<typeof researchEventTypeSchema>;

export const researchEventSchema = z.object({
  schemaVersion: researchSchemaVersionSchema,
  runId: researchRunIdSchema,
  correlationId: researchCorrelationIdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: timestampSchema,
  type: researchEventTypeSchema,
  payload: z.record(z.unknown()),
});
export type ResearchEvent = z.infer<typeof researchEventSchema>;

export function makeResearchEvent(
  runId: string,
  correlationId: string,
  sequence: number,
  type: ResearchEventType,
  payload: Record<string, unknown>,
): ResearchEvent {
  return researchEventSchema.parse({ schemaVersion: researchSchemaVersion, runId, correlationId, sequence, timestamp: new Date().toISOString(), type, payload });
}

export const terminalResearchRunStatuses: readonly ResearchRunStatus[] = ["cancelled", "failed", "partial", "completed"];
export function isTerminalResearchRunStatus(status: ResearchRunStatus): boolean {
  return terminalResearchRunStatuses.includes(status);
}

export const activeResearchRunStatuses: readonly ResearchRunStatus[] = ["queued", "running", "cancelling"];
export function isActiveResearchRunStatus(status: ResearchRunStatus): boolean {
  return activeResearchRunStatuses.includes(status);
}
