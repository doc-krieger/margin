import { z } from "zod";
import { commentScopeSchema, textAnchorSchema } from "../comments/contracts.js";

export const runIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const runStatusSchema = z.enum(["queued", "checkpointing", "running", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runEventTypeSchema = z.enum([
  "run.started",
  "pi.event",
  "pi.stderr",
  "pi.invalid",
  "diagnostic",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  runId: runIdSchema,
  correlationId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  type: runEventTypeSchema,
  payload: z.record(z.unknown()),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const piProfileManifestSchema = z.object({
  command: z.string().trim().min(1).max(512),
  versionArgs: z.array(z.string().max(512)).max(32).default(["--version"]),
  runArgs: z.array(z.string().max(4096)).max(128),
  protocol: z.literal("jsonl"),
  timeoutMs: z.number().int().min(1000).max(15 * 60 * 1000).default(120_000),
});
export type PiProfileManifest = z.infer<typeof piProfileManifestSchema>;

export const selectedCommentSchema = z.object({
  id: z.string().min(1).max(128),
  scope: commentScopeSchema,
  documentPath: z.string().min(1).max(4096).nullable(),
  body: z.string().trim().min(1).max(20_000),
  anchor: textAnchorSchema.nullable(),
});
export type SelectedComment = z.infer<typeof selectedCommentSchema>;

export const checkpointManifestSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{7,64}$/),
  ref: z.string().min(1).max(256).regex(/^refs\/margin\/checkpoints\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
});
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

/** The exact, bounded instruction payload sent to a Pi profile for one revision run. */
export const revisionInstructionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  correlationId: z.string().uuid(),
  projectId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  checkpoint: checkpointManifestSchema,
  comments: z.array(selectedCommentSchema).min(1).max(100),
  guidance: z.string().trim().max(8_000),
  createdAt: z.string().datetime({ offset: true }),
});
export type RevisionInstructionManifest = z.infer<typeof revisionInstructionManifestSchema>;

export const changedFileSchema = z.object({
  path: z.string().min(1).max(4096),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const cleanupSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  diagnostics: z.string().max(32_000).nullable(),
});
export type RunCleanup = z.infer<typeof cleanupSchema>;

export const runCheckpointSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{7,64}$/),
  ref: z.string().min(1).max(256),
  worktreePath: z.string().min(1).max(4096),
});
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

/** Durable lifecycle record. `worktreePath` is retained as evidence even after cleanup. */
export const revisionRunRecordSchema = z.object({
  runId: runIdSchema,
  correlationId: z.string().uuid(),
  projectId: z.string().min(1).max(128),
  repositoryRoot: z.string().min(1).max(4096),
  profileId: z.string().min(1).max(128),
  status: runStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  checkpoint: runCheckpointSchema.nullable(),
  proposalId: z.string().min(1).max(128).nullable().default(null),
  manifest: revisionInstructionManifestSchema.nullable(),
  changedFiles: z.array(changedFileSchema),
  diagnostics: z.string().max(32_000).nullable(),
  errorCode: z.string().max(128).nullable(),
  cleanup: cleanupSchema,
});
export type RevisionRunRecord = z.infer<typeof revisionRunRecordSchema>;

export const startRevisionRunInputSchema = z.object({
  projectId: z.string().min(1).max(128),
  repositoryRoot: z.string().min(1).max(4096),
  profileId: z.string().min(1).max(128),
  selectedCommentIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  guidance: z.string().trim().max(8_000).default(""),
  correlationId: z.string().uuid().optional(),
});
export type StartRevisionRunInput = z.infer<typeof startRevisionRunInputSchema>;

export function makeRunEvent(
  runId: string,
  correlationId: string,
  sequence: number,
  type: RunEventType,
  payload: Record<string, unknown>,
): RunEvent {
  return runEventSchema.parse({ runId, correlationId, sequence, timestamp: new Date().toISOString(), type, payload });
}

export const terminalRunStatuses: readonly RunStatus[] = ["completed", "failed", "cancelled"];
export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatuses.includes(status);
}
