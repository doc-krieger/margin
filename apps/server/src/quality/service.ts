import { randomUUID } from "node:crypto";
import {
  activeQualityAttemptStatuses,
  isTerminalQualityAttemptStatus,
  qualityAcceptedCheckpointSchema,
  qualityFindingSchema,
  qualityProgressEventSchema,
  qualityReviewAttemptSchema,
  qualityReviewRecordSchema,
  qualityReviewerInstructionSchema,
  type QualityAcceptedCheckpoint,
  type QualityAttemptOutcome,
  type QualityAttemptStatus,
  type QualityFinding,
  type QualityFindingDisposition,
  type QualityFindingPromotion,
  type QualityProgressEvent,
  type QualityProgressType,
  type QualityReviewAttempt,
  type QualityReviewRecord,
  type QualityReviewerInstruction,
} from "../../../../packages/shared/src/quality/contracts.js";
import { CommentService } from "../comments/repository.js";
import { runPiProcess, PiProcessError, type PiRunResult } from "../pi/adapter.js";
import { defaultPiProfileManifest, type PiProfileManifest } from "../pi/manifest.js";
import { MemoryRunEventStore } from "../runs/events.js";
import { type QualityReviewStore } from "./store.js";
import { promoteQualityFinding, type QualityPromotionResult } from "./promotion.js";

const MAX_DIAGNOSTICS = 32_000;

export interface QualityProfile {
  id: string;
  manifest: PiProfileManifest;
  status?: "available" | "unavailable";
}

export interface QualityExecutorInput {
  manifest: PiProfileManifest;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  runId: string;
  correlationId: string;
  checkpoint: QualityAcceptedCheckpoint;
  reviewerInstruction: QualityReviewerInstruction;
  emit: (type: QualityProgressType, details?: { message?: string; claimId?: string; percent?: number }) => Promise<void>;
}

export interface QualityExecutorResult {
  sessionId?: string | null;
  durationMs?: number | null;
  processExit?: QualityReviewAttempt["processExit"];
  findings?: unknown[];
  claimsReviewed?: number;
  outcome?: QualityAttemptOutcome;
  status?: Exclude<QualityAttemptStatus, "queued" | "running" | "cancelling" | "cancelled" | "failed">;
  diagnostics?: QualityReviewAttempt["diagnostics"];
}

export interface QualityExecutor {
  run(input: QualityExecutorInput): Promise<QualityExecutorResult>;
}

export interface StartQualityReviewInput {
  projectId: string;
  repositoryRoot: string;
  targetCheckpoint: QualityAcceptedCheckpoint;
  reviewerInstruction: QualityReviewerInstruction;
  profileId?: string;
  correlationId?: string;
}

export interface RetryQualityReviewInput {
  reviewId: string;
  repositoryRoot: string;
  profileId?: string;
  correlationId?: string;
}

export interface QualityDispositionInput {
  reviewId: string;
  findingId: string;
  action: QualityFindingDisposition["action"];
  rationale: string;
  actorId: string;
  supersedesDispositionId?: string | null;
}

export interface QualityPromotionRequest {
  reviewId: string;
  findingId: string;
  repositoryRoot: string;
  target: QualityFindingPromotion["target"];
  actorId: string;
  body?: string;
}

export type QualityReviewErrorCode =
  | "QUALITY_REVIEW_NOT_FOUND"
  | "QUALITY_REVIEW_ALREADY_ACTIVE"
  | "QUALITY_REVIEW_NOT_CANCELLABLE"
  | "QUALITY_REVIEW_NOT_RETRYABLE"
  | "QUALITY_ATTEMPT_NOT_FOUND"
  | "QUALITY_FINDING_NOT_FOUND"
  | "QUALITY_PROFILE_NOT_FOUND"
  | "QUALITY_PROFILE_UNAVAILABLE"
  | "QUALITY_INVALID_REVIEW_OUTPUT"
  | "QUALITY_INVALID_SOURCE_REFERENCE"
  | "QUALITY_REVIEW_PROJECT_MISMATCH"
  | "QUALITY_REVIEW_CHECKPOINT_MISMATCH"
  | "QUALITY_PROJECT_NOT_FOUND";

export class QualityReviewError extends Error {
  constructor(public readonly code: QualityReviewErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QualityReviewError";
  }
}

export interface QualityReviewServiceOptions {
  store: QualityReviewStore;
  executor?: QualityExecutor;
  profiles?: QualityProfile[];
  comments?: CommentService;
  clock?: () => Date;
  idFactory?: () => string;
}

function now(clock: () => Date): string {
  return clock().toISOString();
}

function bounded(value: string): string {
  return value.length <= MAX_DIAGNOSTICS ? value : `${value.slice(0, MAX_DIAGNOSTICS)}\n…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function candidateFindings(value: unknown, depth = 0): unknown[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => candidateFindings(item, depth + 1));
  const record = asRecord(value);
  if (!record) return [];
  const direct = [record.findings, record.qualityFindings, record.reviewFindings];
  const found = direct.flatMap((item) => Array.isArray(item) ? item : item ? [item] : []);
  if (found.length > 0) return found;
  return [record.data, record.result, record.review, record.output].flatMap((item) => candidateFindings(item, depth + 1));
}

function eventSessionId(events: PiRunResult["events"]): string | null {
  for (const event of events) {
    const record = asRecord(event.payload);
    const id = record ? stringValue(record.sessionId) : undefined;
    if (id) return id;
  }
  return null;
}

function buildQualityPrompt(checkpoint: QualityAcceptedCheckpoint, instruction: QualityReviewerInstruction): string {
  return [
    "You are an independent Margin quality reviewer.",
    "Review only the accepted checkpoint below. Do not edit files, create a proposal, or change the report.",
    "Read the report at the supplied relative path and inspect only the frozen source/version graph; never resolve a latest source.",
    "Return a single structured object with findings (an array of claim-linked findings) and claimsReviewed.",
    "Every citation must use an exact sourceId/versionId from the graph. If a claim cannot be safely anchored or evidenced, report that explicitly instead of guessing.",
    `Reviewer instruction (${instruction.instructionId}): ${instruction.text}`,
    `Accepted checkpoint: ${JSON.stringify(checkpoint)}`,
    `Report path relative to the working directory: ${checkpoint.reportPath}`,
  ].join("\n\n");
}

function defaultFinding(raw: unknown, attemptId: string, timestamp: string): Record<string, unknown> {
  const record = asRecord(raw) ?? {};
  return {
    ...record,
    findingId: stringValue(record.findingId) ?? randomUUID(),
    attemptId,
    kind: record.kind ?? "other",
    severity: record.severity ?? "medium",
    uncertainty: record.uncertainty ?? "medium",
    title: record.title ?? "Quality review finding",
    rationale: record.rationale ?? "The reviewer reported a quality concern.",
    suggestedRevision: record.suggestedRevision ?? null,
    location: record.location ?? { status: "unanchored", anchor: null, diagnostic: "The reviewer did not provide a safe report anchor." },
    citation: record.citation ?? null,
    evidence: record.evidence ?? [],
    createdAt: record.createdAt ?? timestamp,
  };
}

function validateFindingLineage(finding: QualityFinding, checkpoint: QualityAcceptedCheckpoint): void {
  if (finding.location.status === "anchored" && finding.location.anchor?.relativePath !== checkpoint.reportPath) {
    throw new QualityReviewError("QUALITY_INVALID_SOURCE_REFERENCE", "Quality finding anchor is outside the accepted report artifact");
  }
  const bindings = checkpoint.sourceGraph.sourceBindings;
  if (finding.citation?.sourceId !== null && finding.citation?.versionId !== null) {
    const citationIsFrozen = bindings.some((binding) => binding.sourceId === finding.citation!.sourceId && binding.versionId === finding.citation!.versionId);
    if (!citationIsFrozen) throw new QualityReviewError("QUALITY_INVALID_SOURCE_REFERENCE", "Quality finding citation is not in the accepted source graph");
  }
  for (const evidence of finding.evidence) {
    const binding = bindings.find((candidate) => candidate.sourceId === evidence.sourceId && candidate.versionId === evidence.versionId);
    const expectedChecksum = evidence.availability === "full-text" ? binding?.evidenceChecksum : binding?.checksum;
    if (!binding || expectedChecksum !== evidence.checksum) {
      throw new QualityReviewError("QUALITY_INVALID_SOURCE_REFERENCE", "Quality finding evidence does not match the accepted source/version checksum");
    }
    if (evidence.availability === "full-text" && (binding.evidenceAvailability !== "full-text" || binding.evidenceChecksum === null)) {
      throw new QualityReviewError("QUALITY_INVALID_SOURCE_REFERENCE", "Quality finding claims full-text evidence that the checkpoint does not provide");
    }
    if (evidence.availability === "full-text" && binding.evidenceChecksum !== evidence.checksum) {
      throw new QualityReviewError("QUALITY_INVALID_SOURCE_REFERENCE", "Quality finding evidence checksum is not the frozen evidence checksum");
    }
  }
}

function processExitFromPi(result: PiRunResult, timestamp: string): NonNullable<QualityReviewAttempt["processExit"]> {
  return { exitCode: result.exitCode, signal: null, timedOut: false, aborted: false, exitedAt: timestamp };
}

function errorDiagnostics(error: unknown, timestamp: string): NonNullable<QualityReviewAttempt["diagnostics"]> {
  if (error instanceof PiProcessError) {
    const processExit = {
      exitCode: null,
      signal: null,
      timedOut: error.code === "PI_TIMEOUT",
      aborted: error.code === "PI_CANCELLED",
      exitedAt: timestamp,
    };
    return { code: error.code, message: bounded(error.message), stderr: bounded(error.diagnostics), protocol: error.code === "PI_PROTOCOL_ERROR" ? bounded(error.diagnostics) : null, processExit };
  }
  if (error instanceof QualityReviewError) return { code: error.code, message: bounded(error.message), stderr: "", protocol: null, processExit: null };
  return { code: "QUALITY_EXECUTOR_ERROR", message: bounded(error instanceof Error ? error.message : String(error)), stderr: "", protocol: null, processExit: null };
}

async function defaultQualityExecutor(input: QualityExecutorInput): Promise<QualityExecutorResult> {
  const eventStore = new MemoryRunEventStore();
  const result = await runPiProcess(input.manifest, {
    runId: input.runId,
    correlationId: input.correlationId,
    cwd: input.cwd,
    prompt: input.prompt,
    signal: input.signal,
    timeoutMs: input.manifest.timeoutMs,
    emitStarted: false,
    emitTerminal: false,
  }, eventStore);
  const findings = result.events.flatMap((event) => candidateFindings(event.payload));
  const claimsReviewed = result.events.reduce((count, event) => {
    const record = asRecord(event.payload);
    return record && typeof record.claimsReviewed === "number" ? record.claimsReviewed : count;
  }, 0);
  return { sessionId: eventSessionId(result.events), durationMs: result.durationMs, processExit: processExitFromPi(result, new Date().toISOString()), findings, claimsReviewed };
}

/** Independent, reconnectable quality-review lifecycle over an immutable accepted checkpoint. */
export class QualityReviewService {
  private readonly profiles = new Map<string, QualityProfile>();
  private readonly executor: QualityExecutor;
  private readonly comments?: CommentService;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly active = new Map<string, { attemptId: string; controller: AbortController }>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<(event: QualityProgressEvent) => void>>();

  constructor(private readonly options: QualityReviewServiceOptions) {
    this.executor = options.executor ?? { run: defaultQualityExecutor };
    this.comments = options.comments;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    for (const profile of options.profiles ?? [{ id: "default", manifest: defaultPiProfileManifest(), status: "available" as const }]) {
      this.profiles.set(profile.id, profile);
    }
  }

  async ready(): Promise<void> {
    for (const review of await this.options.store.list()) {
      const attempt = review.attempts.find((candidate) => candidate.attemptId === review.latestAttemptId);
      if (!attempt || !activeQualityAttemptStatuses.includes(attempt.status) || this.active.has(review.reviewId)) continue;
      const timestamp = now(this.clock);
      const diagnostics = { code: "QUALITY_PROCESS_LOST", message: "The server restarted before the quality attempt reached a terminal state", stderr: "", protocol: null, processExit: null };
      const settledAttempt = qualityReviewAttemptSchema.parse({
        ...attempt,
        status: "failed",
        outcome: "failed",
        diagnostics,
        endedAt: timestamp,
        lastProgressAt: timestamp,
      });
      await this.options.store.save(qualityReviewRecordSchema.parse({ ...review, status: "failed", attempts: review.attempts.map((candidate) => candidate.attemptId === attempt.attemptId ? settledAttempt : candidate), updatedAt: timestamp }));
    }
  }

  async list(projectId?: string): Promise<QualityReviewRecord[]> {
    await this.ready();
    return this.options.store.list(projectId);
  }

  async events(reviewId: string, after = -1): Promise<QualityProgressEvent[]> {
    const record = await this.get(reviewId);
    const attempt = record.attempts.find((candidate) => candidate.attemptId === record.latestAttemptId);
    return (attempt?.progress ?? []).filter((event) => event.sequence > after);
  }

  subscribe(reviewId: string, listener: (event: QualityProgressEvent) => void): () => void {
    const listeners = this.subscribers.get(reviewId) ?? new Set<(event: QualityProgressEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(reviewId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(reviewId);
    };
  }

  async get(reviewId: string): Promise<QualityReviewRecord> {
    await this.ready();
    const record = await this.options.store.get(reviewId);
    if (!record) throw new QualityReviewError("QUALITY_REVIEW_NOT_FOUND", `Quality review ${reviewId} was not found`);
    return record;
  }

  async start(input: StartQualityReviewInput): Promise<QualityReviewRecord> {
    await this.ready();
    const checkpoint = qualityAcceptedCheckpointSchema.parse(input.targetCheckpoint);
    const instruction = qualityReviewerInstructionSchema.parse(input.reviewerInstruction);
    const reviewId = this.idFactory();
    const timestamp = now(this.clock);
    const record = qualityReviewRecordSchema.parse({
      schemaVersion: 1,
      reviewId,
      projectId: input.projectId,
      correlationId: input.correlationId ?? this.idFactory(),
      targetCheckpoint: checkpoint,
      reviewerInstruction: instruction,
      status: "draft",
      attempts: [],
      latestAttemptId: null,
      findings: [],
      dispositions: [],
      promotions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.options.store.save(record);
    const attempt = this.newAttempt(record, null, input.correlationId ?? this.idFactory(), timestamp);
    await this.options.store.appendAttempt(reviewId, attempt);
    const controller = new AbortController();
    this.active.set(reviewId, { attemptId: attempt.attemptId, controller });
    const execution = this.execute(record.reviewId, attempt.attemptId, input.repositoryRoot, input.profileId ?? "default", controller);
    this.executions.set(reviewId, execution);
    void execution.finally(() => {
      if (this.executions.get(reviewId) === execution) this.executions.delete(reviewId);
      const active = this.active.get(reviewId);
      if (active?.attemptId === attempt.attemptId) this.active.delete(reviewId);
    }).catch(() => undefined);
    return (await this.options.store.get(reviewId))!;
  }

  async wait(reviewId: string): Promise<QualityReviewRecord> {
    const execution = this.executions.get(reviewId);
    if (execution) await execution;
    return this.get(reviewId);
  }

  async retry(input: RetryQualityReviewInput): Promise<QualityReviewRecord> {
    const record = await this.get(input.reviewId);
    if (this.active.has(input.reviewId)) throw new QualityReviewError("QUALITY_REVIEW_ALREADY_ACTIVE", "A quality attempt is already active for this review");
    const previous = record.attempts.find((attempt) => attempt.attemptId === record.latestAttemptId);
    if (!previous || !isTerminalQualityAttemptStatus(previous.status)) throw new QualityReviewError("QUALITY_REVIEW_NOT_RETRYABLE", "Only a terminal quality attempt can be retried");
    const timestamp = now(this.clock);
    const attempt = this.newAttempt(record, previous.attemptId, input.correlationId ?? this.idFactory(), timestamp);
    await this.options.store.appendAttempt(record.reviewId, attempt);
    const controller = new AbortController();
    this.active.set(record.reviewId, { attemptId: attempt.attemptId, controller });
    const execution = this.execute(record.reviewId, attempt.attemptId, input.repositoryRoot, input.profileId ?? "default", controller);
    this.executions.set(record.reviewId, execution);
    void execution.finally(() => {
      if (this.executions.get(record.reviewId) === execution) this.executions.delete(record.reviewId);
      const active = this.active.get(record.reviewId);
      if (active?.attemptId === attempt.attemptId) this.active.delete(record.reviewId);
    }).catch(() => undefined);
    return (await this.options.store.get(record.reviewId))!;
  }

  async cancel(reviewId: string, reason = "cancelled by user"): Promise<QualityReviewRecord> {
    const record = await this.get(reviewId);
    const active = this.active.get(reviewId);
    const attempt = record.attempts.find((candidate) => candidate.attemptId === record.latestAttemptId);
    if (!attempt || !activeQualityAttemptStatuses.includes(attempt.status)) return record;
    const timestamp = now(this.clock);
    const cancelling = qualityReviewAttemptSchema.parse({
      ...attempt,
      status: "cancelling",
      cancellation: { requested: true, requestedAt: timestamp, reason, settledAt: null },
      lastProgressAt: timestamp,
    });
    await this.options.store.save(qualityReviewRecordSchema.parse({ ...record, status: "cancelling", attempts: record.attempts.map((candidate) => candidate.attemptId === attempt.attemptId ? cancelling : candidate), updatedAt: timestamp }));
    active?.controller.abort();
    return (await this.options.store.get(reviewId))!;
  }

  async appendDisposition(input: QualityDispositionInput): Promise<QualityReviewRecord> {
    const record = await this.get(input.reviewId);
    if (!record.findings.some((finding) => finding.findingId === input.findingId)) throw new QualityReviewError("QUALITY_FINDING_NOT_FOUND", `Quality finding ${input.findingId} was not found`);
    const disposition: QualityFindingDisposition = {
      dispositionId: this.idFactory(),
      findingId: input.findingId,
      action: input.action,
      rationale: input.rationale,
      actorId: input.actorId,
      supersedesDispositionId: input.supersedesDispositionId ?? null,
      createdAt: now(this.clock),
    };
    return this.options.store.appendDisposition(input.reviewId, disposition);
  }

  async promote(input: QualityPromotionRequest): Promise<QualityReviewRecord & { promotionResult: QualityPromotionResult }> {
    const record = await this.get(input.reviewId);
    const finding = record.findings.find((candidate) => candidate.findingId === input.findingId);
    if (!finding) throw new QualityReviewError("QUALITY_FINDING_NOT_FOUND", `Quality finding ${input.findingId} was not found`);
    const result = await promoteQualityFinding({
      projectId: record.projectId,
      repositoryRoot: input.repositoryRoot,
      checkpoint: record.targetCheckpoint,
      finding,
      target: input.target,
      actorId: input.actorId,
      body: input.body,
    }, this.comments);
    const updated = await this.options.store.appendPromotion(input.reviewId, result.promotion);
    return Object.assign(updated, { promotionResult: result });
  }

  private newAttempt(record: QualityReviewRecord, parentAttemptId: string | null, correlationId: string, timestamp: string): QualityReviewAttempt {
    return qualityReviewAttemptSchema.parse({
      attemptId: this.idFactory(),
      parentAttemptId,
      sessionId: null,
      correlationId,
      reviewerInstructionId: record.reviewerInstruction.instructionId,
      status: "queued",
      outcome: null,
      progress: [{ eventId: this.idFactory(), sequence: 0, type: "queued", timestamp, message: "Quality review attempt queued", claimId: null, findingId: null, percent: 0 }],
      statistics: { sourceCount: record.targetCheckpoint.sourceGraph.sourceBindings.length },
      findingIds: [],
      comparison: parentAttemptId ? { comparisonId: this.idFactory(), comparedAttemptId: parentAttemptId, checkpointId: record.targetCheckpoint.checkpointId, basis: "same-checkpoint", unchangedCheckpoint: true, createdAt: timestamp } : null,
      cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
      diagnostics: null,
      processExit: null,
      createdAt: timestamp,
      startedAt: null,
      endedAt: null,
      lastProgressAt: timestamp,
    });
  }

  private async emit(reviewId: string, attemptId: string, type: QualityProgressType, details: { message?: string; claimId?: string; findingId?: string; percent?: number } = {}): Promise<void> {
    const current = await this.options.store.get(reviewId);
    const attempt = current?.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!current || !attempt || isTerminalQualityAttemptStatus(attempt.status)) return;
    const event: QualityProgressEvent = qualityProgressEventSchema.parse({
      eventId: this.idFactory(),
      sequence: attempt.progress.length,
      type,
      timestamp: now(this.clock),
      message: details.message ?? "",
      claimId: details.claimId ?? null,
      findingId: details.findingId ?? null,
      percent: details.percent ?? null,
    });
    await this.options.store.appendProgress(reviewId, attemptId, event);
    for (const listener of this.subscribers.get(reviewId) ?? []) listener(event);
  }

  private async execute(reviewId: string, attemptId: string, repositoryRoot: string, profileId: string, controller: AbortController): Promise<void> {
    const initial = await this.options.store.get(reviewId);
    if (!initial) return;
    const attempt = initial.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!attempt) return;
    const profile = this.profiles.get(profileId);
    if (!profile) return this.fail(reviewId, attemptId, new QualityReviewError("QUALITY_PROFILE_NOT_FOUND", `Quality profile ${profileId} was not found`));
    if (profile.status === "unavailable") return this.fail(reviewId, attemptId, new QualityReviewError("QUALITY_PROFILE_UNAVAILABLE", `Quality profile ${profileId} is unavailable`));
    const startedAt = now(this.clock);
    const running = qualityReviewAttemptSchema.parse({ ...attempt, status: "running", startedAt, lastProgressAt: startedAt });
    await this.options.store.save(qualityReviewRecordSchema.parse({ ...initial, status: "running", attempts: initial.attempts.map((candidate) => candidate.attemptId === attemptId ? running : candidate), latestAttemptId: attemptId, updatedAt: startedAt }));
    await this.emit(reviewId, attemptId, "started", { message: "Independent quality review started", percent: 0 });
    const record = await this.options.store.get(reviewId);
    if (!record) return;
    await this.emit(reviewId, attemptId, "checkpoint-verified", { message: `Accepted checkpoint ${record.targetCheckpoint.checkpointId} verified`, percent: 10 });
    try {
      const result = await this.executor.run({
        manifest: profile.manifest,
        cwd: repositoryRoot,
        prompt: buildQualityPrompt(record.targetCheckpoint, record.reviewerInstruction),
        signal: controller.signal,
        runId: attemptId,
        correlationId: attempt.correlationId,
        checkpoint: record.targetCheckpoint,
        reviewerInstruction: record.reviewerInstruction,
        emit: (type, details) => this.emit(reviewId, attemptId, type, details),
      });
      if (controller.signal.aborted) throw new PiProcessError("PI_CANCELLED", "Quality review cancelled", "aborted: true");
      if (result.processExit?.exitCode !== null && result.processExit?.exitCode !== undefined && result.processExit.exitCode !== 0) {
        throw new QualityReviewError("QUALITY_INVALID_REVIEW_OUTPUT", `Quality reviewer exited with code ${result.processExit.exitCode}`);
      }
      const rawFindings = result.findings ?? [];
      for (const raw of rawFindings) {
        const finding = qualityFindingSchema.parse(defaultFinding(raw, attemptId, now(this.clock)));
        validateFindingLineage(finding, record.targetCheckpoint);
        await this.options.store.appendFinding(reviewId, finding);
        await this.emit(reviewId, attemptId, "finding-recorded", { findingId: finding.findingId, message: finding.title });
      }
      const current = await this.options.store.get(reviewId);
      if (!current) return;
      const currentAttempt = current.attempts.find((candidate) => candidate.attemptId === attemptId)!;
      const outcome = result.outcome ?? (rawFindings.length > 0 ? "findings" : "pass");
      const status: QualityAttemptStatus = result.status ?? (outcome === "partial" ? "partial" : outcome === "inconclusive" ? "inconclusive" : "completed");
      const endedAt = now(this.clock);
      const finalized = qualityReviewAttemptSchema.parse({
        ...currentAttempt,
        status,
        outcome,
        sessionId: result.sessionId ?? currentAttempt.sessionId,
        statistics: { ...currentAttempt.statistics, claimsReviewed: result.claimsReviewed ?? Math.max(currentAttempt.statistics.claimsReviewed, rawFindings.length), durationMs: result.durationMs ?? null },
        processExit: result.processExit ?? currentAttempt.processExit,
        diagnostics: result.diagnostics ?? currentAttempt.diagnostics,
        endedAt,
        lastProgressAt: endedAt,
      });
      await this.emitTerminal(reviewId, attemptId, status, outcome);
      const withTerminalProgress = await this.options.store.get(reviewId);
      const terminalAttempt = withTerminalProgress?.attempts.find((candidate) => candidate.attemptId === attemptId) ?? finalized;
      await this.options.store.save(qualityReviewRecordSchema.parse({ ...(withTerminalProgress ?? current), status, attempts: (withTerminalProgress ?? current).attempts.map((candidate) => candidate.attemptId === attemptId ? { ...finalized, progress: terminalAttempt.progress, statistics: terminalAttempt.statistics } : candidate), updatedAt: endedAt }));
    } catch (error) {
      await this.fail(reviewId, attemptId, error);
    }
  }

  private async emitTerminal(reviewId: string, attemptId: string, status: QualityAttemptStatus, outcome: QualityAttemptOutcome): Promise<void> {
    const type: QualityProgressType = status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : status === "partial" ? "partial" : status === "inconclusive" ? "inconclusive" : "completed";
    await this.emit(reviewId, attemptId, type, { message: `Quality review ${outcome}`, percent: 100 });
  }

  private async fail(reviewId: string, attemptId: string, error: unknown): Promise<void> {
    const record = await this.options.store.get(reviewId);
    const attempt = record?.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!record || !attempt || isTerminalQualityAttemptStatus(attempt.status)) return;
    const timestamp = now(this.clock);
    const cancellationRequested = attempt.cancellation.requested || error instanceof PiProcessError && error.code === "PI_CANCELLED";
    const status: QualityAttemptStatus = cancellationRequested ? "cancelled" : "failed";
    const outcome: QualityAttemptOutcome = cancellationRequested ? "cancelled" : "failed";
    const diagnostics = errorDiagnostics(error, timestamp);
    const finalized = qualityReviewAttemptSchema.parse({
      ...attempt,
      status,
      outcome,
      cancellation: cancellationRequested ? { ...attempt.cancellation, requested: true, requestedAt: attempt.cancellation.requestedAt ?? timestamp, settledAt: timestamp } : attempt.cancellation,
      diagnostics,
      processExit: diagnostics.processExit,
      endedAt: timestamp,
      lastProgressAt: timestamp,
    });
    await this.emitTerminal(reviewId, attemptId, status, outcome);
    const withTerminalProgress = await this.options.store.get(reviewId);
    const terminalAttempt = withTerminalProgress?.attempts.find((candidate) => candidate.attemptId === attemptId) ?? finalized;
    await this.options.store.save(qualityReviewRecordSchema.parse({ ...(withTerminalProgress ?? record), status, attempts: (withTerminalProgress ?? record).attempts.map((candidate) => candidate.attemptId === attemptId ? { ...finalized, progress: terminalAttempt.progress, statistics: terminalAttempt.statistics } : candidate), latestAttemptId: attemptId, updatedAt: timestamp }));
  }
}

