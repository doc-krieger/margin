import { z } from "zod";

/** Version of the on-disk source provenance manifest. */
export const sourceSchemaVersion = 1 as const;
export const sourceSchemaVersionSchema = z.literal(sourceSchemaVersion);

const identifierSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const sourceIdSchema = z.string().min(1).max(160).regex(/^src_[a-f0-9]{16,64}$/);
const attemptIdSchema = z.string().min(1).max(160).regex(/^cap_[a-f0-9]{16,64}$/);
const versionIdSchema = z.string().min(1).max(160).regex(/^ev_[a-f0-9]{16,64}$/);
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/, "checksum must be a lowercase SHA-256 digest");
const timestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z.string().max(4096);
const boundedDiagnosticSchema = z.string().max(2000);
const boundedReferenceSchema = z.string().min(1).max(4096)
  .refine((value) => !value.includes("\\"), "backslashes are not supported")
  .refine((value) => !value.startsWith("/"), "absolute paths are not allowed in manifest references")
  .refine((value) => !value.split("/").some((part) => part === ".."), "path traversal is not supported");
const urlSchema = z.string().url().max(8192);
const identitySchema = z.string().min(1).max(8192);

export const sourceKindSchema = z.enum(["url", "file"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const captureOriginSchema = z.enum(["ui", "pi"]);
export type CaptureOrigin = z.infer<typeof captureOriginSchema>;

/** A source attempt is separate from a source record so retries and joined callers remain auditable. */
export const captureAttemptStatusSchema = z.enum([
  "queued",
  "capturing",
  "archived",
  "reused",
  "metadata-only",
  "unavailable",
  "failed",
  "cancelled",
]);
export type CaptureAttemptStatus = z.infer<typeof captureAttemptStatusSchema>;

export const evidenceStateSchema = z.enum(["archived", "metadata-only", "unavailable", "failed"]);
export type EvidenceState = z.infer<typeof evidenceStateSchema>;

export const captureDiagnosticSchema = z.object({
  code: z.string().min(1).max(96),
  message: boundedDiagnosticSchema,
}).strict();
export type CaptureDiagnostic = z.infer<typeof captureDiagnosticSchema>;

/** CSL-compatible fields observed by capture. Values are intentionally bounded and nullable. */
export const sourceMetadataSchema = z.object({
  title: boundedTextSchema.optional(),
  author: boundedTextSchema.optional(),
  issued: boundedTextSchema.optional(),
  type: boundedTextSchema.optional(),
  language: boundedTextSchema.optional(),
  publisher: boundedTextSchema.optional(),
  containerTitle: boundedTextSchema.optional(),
  url: urlSchema.optional(),
}).strict();
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

export const metadataEditSchema = z.object({
  editId: identifierSchema,
  fields: sourceMetadataSchema,
  actor: z.string().min(1).max(128),
  reason: boundedTextSchema.optional(),
  createdAt: timestampSchema,
}).strict();
export type MetadataEdit = z.infer<typeof metadataEditSchema>;

export const evidenceVersionSchema = z.object({
  versionId: versionIdSchema,
  checksum: checksumSchema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(256),
  capturedAt: timestampSchema,
  attemptId: attemptIdSchema,
  requestedUrl: urlSchema.optional(),
  finalUrl: urlSchema.optional(),
  originalPath: boundedTextSchema.optional(),
  originalRef: boundedReferenceSchema,
  readableRef: boundedReferenceSchema.optional(),
  readableMediaType: z.string().min(1).max(256).optional(),
}).strict();
export type EvidenceVersion = z.infer<typeof evidenceVersionSchema>;

export const captureAttemptSchema = z.object({
  attemptId: attemptIdSchema,
  sourceId: sourceIdSchema,
  origin: captureOriginSchema,
  runId: identifierSchema.optional(),
  requestedIdentity: identitySchema,
  status: captureAttemptStatusSchema,
  requestedAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  redirectChain: z.array(urlSchema).max(20).default([]),
  finalUrl: urlSchema.optional(),
  diagnostic: captureDiagnosticSchema.optional(),
  cancellationReason: boundedDiagnosticSchema.optional(),
  reusedVersionId: versionIdSchema.optional(),
  resultingVersionId: versionIdSchema.optional(),
}).strict();
export type CaptureAttempt = z.infer<typeof captureAttemptSchema>;

export const sourceRecordSchema = z.object({
  schemaVersion: sourceSchemaVersionSchema,
  sourceId: sourceIdSchema,
  kind: sourceKindSchema,
  identity: identitySchema,
  aliases: z.array(identitySchema).max(100),
  capturedMetadata: sourceMetadataSchema,
  effectiveMetadata: sourceMetadataSchema,
  metadataEdits: z.array(metadataEditSchema).max(1000),
  evidenceState: evidenceStateSchema,
  latestVersionId: versionIdSchema.nullable(),
  versions: z.array(evidenceVersionSchema).max(1000),
  attempts: z.array(captureAttemptSchema).max(10000),
  lastAttemptId: attemptIdSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((record, context) => {
  if (record.latestVersionId !== null && !record.versions.some((version) => version.versionId === record.latestVersionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["latestVersionId"], message: "latestVersionId must reference a stored evidence version" });
  }
  if (record.lastAttemptId !== null && !record.attempts.some((attempt) => attempt.attemptId === record.lastAttemptId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lastAttemptId"], message: "lastAttemptId must reference a stored capture attempt" });
  }
  for (const attempt of record.attempts) {
    if (attempt.sourceId !== record.sourceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempts"], message: "capture attempt belongs to a different source" });
      break;
    }
  }
  if (record.evidenceState === "archived" && record.latestVersionId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceState"], message: "archived sources require a latest evidence version" });
  }
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const sourceManifestSchema = z.object({
  schemaVersion: sourceSchemaVersionSchema,
  sources: z.array(sourceRecordSchema).max(100000),
  updatedAt: timestampSchema,
}).strict();
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

export const sourceIdentityRequestSchema = z.object({
  kind: sourceKindSchema,
  value: z.string().min(1).max(8192),
  baseDir: z.string().min(1).max(4096).optional(),
}).strict();
export type SourceIdentityRequest = z.infer<typeof sourceIdentityRequestSchema>;

export const sourceMetadataPatchSchema = sourceMetadataSchema.partial();
export type SourceMetadataPatch = z.infer<typeof sourceMetadataPatchSchema>;

export function makeEmptySourceManifest(now = new Date().toISOString()): SourceManifest {
  return { schemaVersion: sourceSchemaVersion, sources: [], updatedAt: now };
}

export function makeSourceRecord(input: Pick<SourceRecord, "sourceId" | "kind" | "identity"> & Partial<SourceRecord>, now = new Date().toISOString()): SourceRecord {
  return sourceRecordSchema.parse({
    schemaVersion: sourceSchemaVersion,
    sourceId: input.sourceId,
    kind: input.kind,
    identity: input.identity,
    aliases: input.aliases ?? [],
    capturedMetadata: input.capturedMetadata ?? {},
    effectiveMetadata: input.effectiveMetadata ?? {},
    metadataEdits: input.metadataEdits ?? [],
    evidenceState: input.evidenceState ?? "unavailable",
    latestVersionId: input.latestVersionId ?? null,
    versions: input.versions ?? [],
    attempts: input.attempts ?? [],
    lastAttemptId: input.lastAttemptId ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  });
}

export type SourceManifestMutation<T> = (manifest: SourceManifest) => T | Promise<T>;
