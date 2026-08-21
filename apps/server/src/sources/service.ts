import { createHash, randomUUID } from "node:crypto";
import {
  makeSourceRecord,
  sourceRecordSchema,
  type CaptureAttempt,
  type CaptureOrigin,
  type EvidenceState,
  type EvidenceVersion,
  type SourceKind,
  type SourceMetadata,
  type SourceRecord,
} from "../../../../packages/shared/src/sources/contracts.js";
import { sourceIdentity, normalizeSourceIdentity } from "./identity.js";
import { captureFileSource, diagnosticForFileError, type FileCaptureLimits } from "./file-capture.js";
import { captureWebSource, diagnosticForWebError, type WebCaptureLimits, type FetchImplementation, type WebNetworkPolicy } from "./web-capture.js";
import type { SourceStore } from "./store.js";

export interface SourceCaptureInput {
  kind: SourceKind;
  value: string;
  baseDir?: string;
  origin: CaptureOrigin;
  runId?: string;
  signal?: AbortSignal;
}

export interface SourceCaptureResult {
  sourceId: string;
  attemptId: string;
  status: "archived" | "reused" | "metadata-only" | "unavailable" | "failed" | "cancelled";
  reused: boolean;
  source: SourceRecord;
  version?: EvidenceVersion;
  diagnostic?: { code: string; message: string };
}

export interface SourceCaptureServiceOptions {
  now?: () => string;
  fetchImpl?: FetchImplementation;
  networkPolicy?: WebNetworkPolicy;
  webLimits?: Partial<WebCaptureLimits>;
  fileLimits?: Partial<FileCaptureLimits>;
}

/** Safe source metadata exposed to report and citation clients. Filesystem references are intentionally omitted. */
export interface SafeSourceRecord {
  sourceId: string;
  kind: SourceKind;
  identity: string;
  aliases: string[];
  effectiveMetadata: SourceMetadata;
  evidenceState: EvidenceState;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe immutable version metadata; originalPath/originalRef/readableRef never cross this boundary. */
export interface SafeEvidenceVersion {
  versionId: string;
  checksum: string;
  byteLength: number;
  mediaType: string;
  capturedAt: string;
  attemptId: string;
  requestedUrl?: string;
  finalUrl?: string;
  readableMediaType?: string;
}

export interface ExactSourceVersion {
  source: SafeSourceRecord;
  version: SafeEvidenceVersion;
}

export interface ExactSourceEvidence extends ExactSourceVersion {
  bytes: Uint8Array | null;
  diagnostic?: { code: string; message: string };
}

export interface SourceEvidenceReadOptions {
  maxBytes?: number;
}

export const defaultExactEvidenceReadLimit = 4 * 1024 * 1024;

export function safeSourceRecord(source: SourceRecord): SafeSourceRecord {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    identity: source.identity,
    aliases: [...source.aliases],
    effectiveMetadata: { ...source.effectiveMetadata },
    evidenceState: source.evidenceState,
    latestVersionId: source.latestVersionId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function safeEvidenceVersion(version: EvidenceVersion): SafeEvidenceVersion {
  return {
    versionId: version.versionId,
    checksum: version.checksum,
    byteLength: version.byteLength,
    mediaType: version.mediaType,
    capturedAt: version.capturedAt,
    attemptId: version.attemptId,
    ...(version.requestedUrl ? { requestedUrl: version.requestedUrl } : {}),
    ...(version.finalUrl ? { finalUrl: version.finalUrl } : {}),
    ...(version.readableMediaType ? { readableMediaType: version.readableMediaType } : {}),
  };
}

interface Claim {
  sourceId: string;
  ownerAttemptId: string;
  controller: AbortController;
  promise: Promise<SourceCaptureResult>;
}

function id(prefix: "cap" | "ev"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nowIso(now: () => string): string {
  return now();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function metadataFromCapture(value: { title?: string; language?: string; url?: string }): SourceMetadata {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as SourceMetadata;
}

function mergeEffectiveMetadata(record: SourceRecord, captured: SourceMetadata): SourceMetadata {
  const editedFields = new Set(Object.keys(Object.assign({}, ...record.metadataEdits.map((edit) => edit.fields))));
  const effective: SourceMetadata = { ...record.effectiveMetadata };
  for (const [key, value] of Object.entries(captured)) {
    if (!editedFields.has(key)) (effective as Record<string, string>)[key] = value;
  }
  return effective;
}

function terminalEvidenceState(record: SourceRecord | null, attempted: EvidenceState): EvidenceState {
  // A failed/cancelled recapture never hides the last immutable good version.
  return record?.latestVersionId ? "archived" : attempted;
}

function attemptFor(input: SourceCaptureInput, sourceId: string, identity: string, attemptId: string, now: string): CaptureAttempt {
  return {
    attemptId,
    sourceId,
    origin: input.origin,
    ...(input.runId ? { runId: input.runId } : {}),
    requestedIdentity: identity,
    status: "capturing",
    requestedAt: now,
    startedAt: now,
    redirectChain: [],
  };
}

/**
 * Shared capture coordinator for UI and Pi callers. A process-local claim
 * joins equal in-flight intents, while every caller still receives its own
 * durable attempt record. The store remains authoritative for reconstruction.
 */
export class SourceCaptureService {
  private readonly claims = new Map<string, Claim>();
  private readonly now: () => string;

  constructor(private readonly store: SourceStore, private readonly options: SourceCaptureServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async capture(input: SourceCaptureInput): Promise<SourceCaptureResult> {
    const canonical = sourceIdentity(input.kind, input.value, input.baseDir);
    const attemptId = id("cap");
    const startedAt = nowIso(this.now);
    const previous = this.claims.get(canonical.sourceId);
    if (previous) {
      await this.recordAttempt(input, canonical.sourceId, canonical.identity, attemptId, startedAt);
      return this.joinClaim(canonical.sourceId, attemptId, input.signal, previous.promise);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let resolveClaim!: (result: SourceCaptureResult) => void;
    let rejectClaim!: (error: unknown) => void;
    const promise = new Promise<SourceCaptureResult>((resolve, reject) => {
      resolveClaim = resolve;
      rejectClaim = reject;
    });
    this.claims.set(canonical.sourceId, { sourceId: canonical.sourceId, ownerAttemptId: attemptId, controller, promise });
    void (async () => {
      try {
        await this.recordAttempt(input, canonical.sourceId, canonical.identity, attemptId, startedAt);
        const result = await this.execute(input, canonical.sourceId, attemptId, controller.signal);
        resolveClaim(result);
      } catch (error) {
        rejectClaim(error);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        if (this.claims.get(canonical.sourceId)?.ownerAttemptId === attemptId) this.claims.delete(canonical.sourceId);
      }
    })();
    return promise;
  }

  private async recordAttempt(input: SourceCaptureInput, sourceId: string, identity: string, attemptId: string, startedAt: string): Promise<void> {
    await this.store.transact((manifest) => {
      let record = manifest.sources.find((item) => item.sourceId === sourceId);
      if (!record) {
        record = makeSourceRecord({ sourceId, kind: input.kind, identity }, startedAt);
        manifest.sources.push(record);
      }
      record.attempts.push(attemptFor(input, sourceId, identity, attemptId, startedAt));
      record.lastAttemptId = attemptId;
      record.updatedAt = startedAt;
    });
  }

  async cancel(attemptId: string, reason = "Capture cancelled"): Promise<SourceRecord | null> {
    const records = await this.store.list();
    const record = records.find((item) => item.attempts.some((attempt) => attempt.attemptId === attemptId));
    if (!record) return null;
    const claim = this.claims.get(record.sourceId);
    if (claim && claim.ownerAttemptId === attemptId) claim.controller.abort(reason);
    await this.store.transact((manifest) => {
      const current = manifest.sources.find((item) => item.sourceId === record.sourceId);
      const attempt = current?.attempts.find((item) => item.attemptId === attemptId);
      if (attempt && (attempt.status === "capturing" || attempt.status === "queued")) {
        attempt.status = "cancelled";
        attempt.completedAt = nowIso(this.now);
        attempt.cancellationReason = reason.slice(0, 4096);
        if (current) current.updatedAt = nowIso(this.now);
      }
    });
    return this.store.get(record.sourceId);
  }

  async retry(input: SourceCaptureInput): Promise<SourceCaptureResult> {
    return this.capture(input);
  }

  async get(sourceId: string): Promise<SourceRecord | null> {
    return this.store.get(sourceId);
  }

  /**
   * Returns only the requested immutable version. This deliberately does not
   * fall back to latestVersionId: a citation is safe only when its exact
   * source/version pair still exists.
   */
  async getExactVersion(sourceId: string, versionId: string): Promise<ExactSourceVersion | null> {
    const source = await this.store.get(sourceId);
    if (!source) return null;
    const version = source.versions.find((candidate) => candidate.versionId === versionId);
    if (!version) return null;
    return { source: safeSourceRecord(source), version: safeEvidenceVersion(version) };
  }

  /**
   * Reads exact-version evidence and verifies its immutable checksum before it
   * is handed to a citation resolver. Missing evidence is represented as a
   * diagnostic rather than converted into a false successful resolution.
   */
  async readExactVersion(sourceId: string, versionId: string, options: SourceEvidenceReadOptions = {}): Promise<ExactSourceEvidence | null> {
    const exact = await this.getExactVersion(sourceId, versionId);
    if (!exact) return null;
    const maxBytes = options.maxBytes ?? defaultExactEvidenceReadLimit;
    if (exact.version.byteLength > maxBytes) {
      return { ...exact, bytes: null, diagnostic: { code: "EVIDENCE_TOO_LARGE", message: `Exact evidence exceeds the ${maxBytes}-byte safe read limit` } };
    }
    try {
      const source = await this.store.get(sourceId);
      const version = source?.versions.find((candidate) => candidate.versionId === versionId);
      if (!source || !version) return null;
      const bytes = await this.store.readEvidence(sourceId, version);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== version.checksum) {
        return { ...exact, bytes: null, diagnostic: { code: "EVIDENCE_CHECKSUM_MISMATCH", message: `Evidence ${versionId} failed its recorded checksum` } };
      }
      return { ...exact, bytes };
    } catch (error) {
      return {
        ...exact,
        bytes: null,
        diagnostic: {
          code: typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "EVIDENCE_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Exact evidence is unavailable",
        },
      };
    }
  }

  private async joinClaim(sourceId: string, attemptId: string, signal: AbortSignal | undefined, owner: Promise<SourceCaptureResult>): Promise<SourceCaptureResult> {
    if (signal?.aborted) return this.cancelJoined(sourceId, attemptId, "Capture cancelled before joined capture settled");
    let onAbort: (() => void) | undefined;
    const cancellation = new Promise<"cancelled">((resolve) => {
      onAbort = () => resolve("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([owner, cancellation]);
    signal?.removeEventListener("abort", onAbort!);
    if (result === "cancelled") return this.cancelJoined(sourceId, attemptId, "Capture cancelled while waiting for joined capture");
    const ownerResult = result as SourceCaptureResult;
    await this.store.transact((manifest) => {
      const record = manifest.sources.find((item) => item.sourceId === sourceId);
      const attempt = record?.attempts.find((item) => item.attemptId === attemptId);
      if (!record || !attempt || attempt.status !== "capturing") return;
      attempt.status = ownerResult.version ? "reused" : ownerResult.status;
      attempt.completedAt = nowIso(this.now);
      if (ownerResult.version) {
        attempt.reusedVersionId = ownerResult.version.versionId;
        attempt.resultingVersionId = ownerResult.version.versionId;
      }
      if (ownerResult.diagnostic) attempt.diagnostic = ownerResult.diagnostic;
      record.lastAttemptId = attemptId;
      record.updatedAt = nowIso(this.now);
    });
    const source = await this.store.get(sourceId);
    if (!source) throw new Error("Source disappeared while joining capture");
    return { ...ownerResult, attemptId, reused: Boolean(ownerResult.version), source, status: ownerResult.version ? "reused" : ownerResult.status };
  }

  private async cancelJoined(sourceId: string, attemptId: string, reason: string): Promise<SourceCaptureResult> {
    await this.cancel(attemptId, reason);
    const source = await this.store.get(sourceId);
    if (!source) throw new Error("Source disappeared while cancelling capture");
    return { sourceId, attemptId, status: "cancelled", reused: false, source, diagnostic: { code: "CANCELLED", message: reason } };
  }

  private async execute(input: SourceCaptureInput, sourceId: string, attemptId: string, signal: AbortSignal): Promise<SourceCaptureResult> {
    try {
      const captured = input.kind === "url"
        ? await captureWebSource(input.value, { fetchImpl: this.options.fetchImpl, networkPolicy: this.options.networkPolicy, limits: this.options.webLimits }, signal)
        : await captureFileSource(input.value, input.baseDir!, { limits: this.options.fileLimits }, signal);
      const bytes = captured.bytes;
      if (captured.state !== "archived" || !bytes) throw new Error("Capture did not produce a complete archived payload");
      return this.publish(input, sourceId, attemptId, { ...captured, state: "archived", bytes });
    } catch (error) {
      const diagnostic = input.kind === "url" ? diagnosticForWebError(error) : diagnosticForFileError(error);
      const status = error instanceof Error && "code" in error && (error as { code?: string }).code === "CANCELLED" ? "cancelled" :
        error instanceof Error && "terminalState" in error ? (error as { terminalState: SourceCaptureResult["status"] }).terminalState : "failed";
      const source = await this.store.transact((manifest) => {
        const record = manifest.sources.find((item) => item.sourceId === sourceId);
        if (!record) throw new Error("Source disappeared during capture");
        const attempt = record.attempts.find((item) => item.attemptId === attemptId);
        if (attempt) {
          attempt.status = status;
          attempt.completedAt = nowIso(this.now);
          attempt.diagnostic = diagnostic;
          if (status === "cancelled") attempt.cancellationReason = diagnostic.message;
        }
        const attemptedState: EvidenceState = status === "cancelled" || status === "reused" ? "failed" : status;
        record.evidenceState = terminalEvidenceState(record, attemptedState);
        record.lastAttemptId = attemptId;
        record.updatedAt = nowIso(this.now);
        return clone(record);
      });
      return { sourceId, attemptId, status, reused: false, source, diagnostic };
    }
  }

  private async publish(input: SourceCaptureInput, sourceId: string, attemptId: string, captured: {
    state: "archived";
    bytes: Uint8Array;
    mediaType?: string;
    readableMediaType?: string;
    requestedUrl?: string;
    finalUrl?: string;
    originalPath?: string;
    redirectChain?: string[];
    metadata: { title?: string; language?: string; url?: string };
  }): Promise<SourceCaptureResult> {
    const checksum = createHash("sha256").update(captured.bytes).digest("hex");
    const capturedAt = nowIso(this.now);
    let version: EvidenceVersion | undefined;
    let reused = false;
    const sourceBefore = await this.store.get(sourceId);
    const existing = sourceBefore?.versions.find((item) => item.checksum === checksum);
    if (existing) {
      version = existing;
      reused = true;
    } else {
      version = {
        versionId: id("ev"),
        checksum,
        byteLength: captured.bytes.byteLength,
        mediaType: captured.mediaType ?? "application/octet-stream",
        capturedAt,
        attemptId,
        ...(captured.requestedUrl ? { requestedUrl: captured.requestedUrl } : {}),
        ...(captured.finalUrl ? { finalUrl: captured.finalUrl } : {}),
        ...(captured.originalPath ? { originalPath: captured.originalPath } : {}),
        originalRef: `evidence/${sourceId}/${id("ev")}-${checksum}.bin`,
        ...(captured.readableMediaType ? { readableMediaType: captured.readableMediaType } : {}),
      };
      // Version IDs are generated once and the reference must use that exact ID.
      version.originalRef = `evidence/${sourceId}/${version.versionId}-${checksum}.bin`;
      await this.store.putEvidence(sourceId, version, captured.bytes);
    }

    const result = await this.store.transact((manifest) => {
      const record = manifest.sources.find((item) => item.sourceId === sourceId);
      if (!record) throw new Error("Source disappeared while publishing capture");
      if (captured.finalUrl && captured.finalUrl !== record.identity && !record.aliases.includes(captured.finalUrl)) record.aliases.push(captured.finalUrl);
      if (!reused) record.versions.push(version!);
      const capturedMetadata = metadataFromCapture(captured.metadata);
      record.capturedMetadata = { ...record.capturedMetadata, ...capturedMetadata };
      record.effectiveMetadata = mergeEffectiveMetadata(record, capturedMetadata);
      record.evidenceState = "archived";
      record.latestVersionId = version!.versionId;
      const attempt = record.attempts.find((item) => item.attemptId === attemptId);
      if (attempt) {
        attempt.status = reused ? "reused" : "archived";
        attempt.completedAt = capturedAt;
        attempt.finalUrl = captured.finalUrl;
        attempt.redirectChain = input.kind === "url" ? (captured.redirectChain ?? []) : [];
        attempt.reusedVersionId = reused ? version!.versionId : undefined;
        attempt.resultingVersionId = version!.versionId;
      }
      record.lastAttemptId = attemptId;
      record.updatedAt = capturedAt;
      return clone(sourceRecordSchema.parse(record));
    });
    return { sourceId, attemptId, status: reused ? "reused" : "archived", reused, source: result, version };
  }
}

export function canonicalSourceIdentity(kind: SourceKind, value: string, baseDir?: string): string {
  return normalizeSourceIdentity({ kind, value, ...(baseDir ? { baseDir } : {}) });
}
