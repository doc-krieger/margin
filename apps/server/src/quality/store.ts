import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isTerminalQualityAttemptStatus,
  qualityAttemptIdSchema,
  qualityDispositionIdSchema,
  qualityFindingDispositionSchema,
  qualityFindingIdSchema,
  qualityFindingPromotionSchema,
  qualityFindingSchema,
  qualityProgressEventSchema,
  qualityReviewAttemptSchema,
  qualityReviewIdSchema,
  qualityReviewRecordSchema,
  type QualityFinding,
  type QualityFindingDisposition,
  type QualityFindingPromotion,
  type QualityProgressEvent,
  type QualityReviewAttempt,
  type QualityReviewRecord,
} from "../../../../packages/shared/src/quality/contracts.js";

export type QualityStoreErrorCode =
  | "INVALID_REVIEW_ID"
  | "INVALID_ATTEMPT_ID"
  | "INVALID_FINDING_ID"
  | "INVALID_DISPOSITION_ID"
  | "INVALID_RECORD"
  | "IMMUTABLE_RECORD"
  | "SEQUENCE_ERROR"
  | "IO_ERROR";

/** A quality review record is malformed, has been rewritten, or cannot be safely reconstructed. */
export class QualityStoreError extends Error {
  constructor(
    public readonly code: QualityStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "QualityStoreError";
  }
}

export interface QualityReviewStore {
  save(record: QualityReviewRecord): Promise<void>;
  get(reviewId: string): Promise<QualityReviewRecord | null>;
  list(projectId?: string): Promise<QualityReviewRecord[]>;
  appendAttempt(reviewId: string, attempt: QualityReviewAttempt): Promise<QualityReviewRecord>;
  appendProgress(reviewId: string, attemptId: string, event: QualityProgressEvent): Promise<QualityReviewRecord>;
  appendFinding(reviewId: string, finding: QualityFinding): Promise<QualityReviewRecord>;
  appendDisposition(reviewId: string, disposition: QualityFindingDisposition): Promise<QualityReviewRecord>;
  appendPromotion(reviewId: string, promotion: QualityFindingPromotion): Promise<QualityReviewRecord>;
}

function cloneRecord(record: QualityReviewRecord): QualityReviewRecord {
  try {
    return qualityReviewRecordSchema.parse(JSON.parse(JSON.stringify(record)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot persist invalid quality review record: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function cloneAttempt(attempt: QualityReviewAttempt): QualityReviewAttempt {
  try {
    return qualityReviewAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot append invalid quality review attempt: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function cloneProgress(event: QualityProgressEvent): QualityProgressEvent {
  try {
    return qualityProgressEventSchema.parse(JSON.parse(JSON.stringify(event)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot append invalid quality progress event: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function cloneFinding(finding: QualityFinding): QualityFinding {
  try {
    return qualityFindingSchema.parse(JSON.parse(JSON.stringify(finding)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot append invalid quality finding: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function cloneDisposition(disposition: QualityFindingDisposition): QualityFindingDisposition {
  try {
    return qualityFindingDispositionSchema.parse(JSON.parse(JSON.stringify(disposition)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot append invalid quality disposition: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function clonePromotion(promotion: QualityFindingPromotion): QualityFindingPromotion {
  try {
    return qualityFindingPromotionSchema.parse(JSON.parse(JSON.stringify(promotion)));
  } catch (error) {
    throw new QualityStoreError(
      "INVALID_RECORD",
      `Cannot append invalid quality promotion: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertReviewId(reviewId: string): string {
  const parsed = qualityReviewIdSchema.safeParse(reviewId);
  if (!parsed.success) throw new QualityStoreError("INVALID_REVIEW_ID", `Invalid quality review ID: ${reviewId}`);
  return parsed.data;
}

function assertAttemptId(attemptId: string): string {
  const parsed = qualityAttemptIdSchema.safeParse(attemptId);
  if (!parsed.success) throw new QualityStoreError("INVALID_ATTEMPT_ID", `Invalid quality attempt ID: ${attemptId}`);
  return parsed.data;
}

function assertFindingId(findingId: string): string {
  const parsed = qualityFindingIdSchema.safeParse(findingId);
  if (!parsed.success) throw new QualityStoreError("INVALID_FINDING_ID", `Invalid quality finding ID: ${findingId}`);
  return parsed.data;
}

function assertDispositionId(dispositionId: string): string {
  const parsed = qualityDispositionIdSchema.safeParse(dispositionId);
  if (!parsed.success) throw new QualityStoreError("INVALID_DISPOSITION_ID", `Invalid quality disposition ID: ${dispositionId}`);
  return parsed.data;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function assertPrefix<T extends { [key: string]: unknown }>(previous: T[], next: T[], key: keyof T, label: string): void {
  if (next.length < previous.length) {
    throw new QualityStoreError("IMMUTABLE_RECORD", `${label} history cannot be removed`);
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]![key] !== next[index]![key]) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `${label} history cannot be reordered or replaced`);
    }
  }
}

/**
 * Ensure a materialized snapshot only advances append-only histories. The current lifecycle fields may
 * progress while accepted inputs, terminal attempts, findings, dispositions, and promotions cannot be rewritten.
 */
function assertAppendOnly(previous: QualityReviewRecord, next: QualityReviewRecord): void {
  if (previous.reviewId !== next.reviewId) throw new QualityStoreError("IMMUTABLE_RECORD", "quality review ID cannot change");
  if (previous.projectId !== next.projectId) throw new QualityStoreError("IMMUTABLE_RECORD", "quality review project cannot change");
  if (previous.correlationId !== next.correlationId) throw new QualityStoreError("IMMUTABLE_RECORD", "quality review correlation ID cannot change");
  if (stableJson(previous.targetCheckpoint) !== stableJson(next.targetCheckpoint)) {
    throw new QualityStoreError("IMMUTABLE_RECORD", "accepted checkpoint and source graph cannot change");
  }
  if (stableJson(previous.reviewerInstruction) !== stableJson(next.reviewerInstruction)) {
    throw new QualityStoreError("IMMUTABLE_RECORD", "reviewer instruction identity cannot change");
  }
  if (previous.createdAt !== next.createdAt) throw new QualityStoreError("IMMUTABLE_RECORD", "quality review creation time cannot change");

  assertPrefix(previous.attempts as unknown as { [key: string]: unknown }[], next.attempts as unknown as { [key: string]: unknown }[], "attemptId", "quality attempt");
  for (let index = 0; index < previous.attempts.length; index += 1) {
    const oldAttempt = previous.attempts[index]!;
    const newAttempt = next.attempts[index]!;
    if (isTerminalQualityAttemptStatus(oldAttempt.status) && stableJson(oldAttempt) !== stableJson(newAttempt)) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `terminal quality attempt ${oldAttempt.attemptId} cannot be rewritten`);
    }
    if (newAttempt.progress.length < oldAttempt.progress.length) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `progress history for attempt ${oldAttempt.attemptId} cannot be removed`);
    }
    for (let progressIndex = 0; progressIndex < oldAttempt.progress.length; progressIndex += 1) {
      if (stableJson(oldAttempt.progress[progressIndex]) !== stableJson(newAttempt.progress[progressIndex])) {
        throw new QualityStoreError("IMMUTABLE_RECORD", `progress history for attempt ${oldAttempt.attemptId} cannot be rewritten`);
      }
    }
    if (newAttempt.findingIds.length < oldAttempt.findingIds.length) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `finding links for attempt ${oldAttempt.attemptId} cannot be removed`);
    }
    for (let findingIndex = 0; findingIndex < oldAttempt.findingIds.length; findingIndex += 1) {
      if (oldAttempt.findingIds[findingIndex] !== newAttempt.findingIds[findingIndex]) {
        throw new QualityStoreError("IMMUTABLE_RECORD", `finding links for attempt ${oldAttempt.attemptId} cannot be rewritten`);
      }
    }
  }

  assertPrefix(previous.findings as unknown as { [key: string]: unknown }[], next.findings as unknown as { [key: string]: unknown }[], "findingId", "quality finding");
  for (let index = 0; index < previous.findings.length; index += 1) {
    if (stableJson(previous.findings[index]) !== stableJson(next.findings[index])) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `quality finding ${previous.findings[index]!.findingId} cannot be rewritten`);
    }
  }
  assertPrefix(previous.dispositions as unknown as { [key: string]: unknown }[], next.dispositions as unknown as { [key: string]: unknown }[], "dispositionId", "quality disposition");
  for (let index = 0; index < previous.dispositions.length; index += 1) {
    if (stableJson(previous.dispositions[index]) !== stableJson(next.dispositions[index])) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `quality disposition ${previous.dispositions[index]!.dispositionId} cannot be rewritten`);
    }
  }
  assertPrefix(previous.promotions as unknown as { [key: string]: unknown }[], next.promotions as unknown as { [key: string]: unknown }[], "promotionId", "quality promotion");
  for (let index = 0; index < previous.promotions.length; index += 1) {
    if (stableJson(previous.promotions[index]) !== stableJson(next.promotions[index])) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `quality promotion ${previous.promotions[index]!.promotionId} cannot be rewritten`);
    }
  }
}

function withUpdatedRecord(record: QualityReviewRecord, update: (draft: QualityReviewRecord) => void): QualityReviewRecord {
  const draft = cloneRecord(record);
  update(draft);
  draft.updatedAt = new Date().toISOString();
  return qualityReviewRecordSchema.parse(draft);
}

/** Atomic JSON snapshots make review status, attempts, and append-only findings reconnectable. */
export class FileQualityReviewStore implements QualityReviewStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async save(record: QualityReviewRecord): Promise<void> {
    const parsed = cloneRecord(record);
    const reviewId = assertReviewId(parsed.reviewId);
    const previousWrite = this.writes.get(reviewId) ?? Promise.resolve();
    const nextWrite = previousWrite.catch(() => undefined).then(async () => {
      const previous = await this.read(reviewId);
      if (previous !== null) assertAppendOnly(previous, parsed);
      await mkdir(this.root, { recursive: true });
      const target = reviewPath(this.root, reviewId);
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        throw new QualityStoreError("IO_ERROR", `Unable to persist quality review ${reviewId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    });
    this.writes.set(reviewId, nextWrite);
    try {
      await nextWrite;
    } finally {
      if (this.writes.get(reviewId) === nextWrite) this.writes.delete(reviewId);
    }
  }

  async get(reviewId: string): Promise<QualityReviewRecord | null> {
    return this.read(assertReviewId(reviewId));
  }

  async list(projectId?: string): Promise<QualityReviewRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new QualityStoreError("IO_ERROR", `Unable to list quality reviews: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const records: QualityReviewRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const reviewId = entry.name.slice(0, -5);
      const record = await this.read(reviewId);
      if (record !== null && (projectId === undefined || record.projectId === projectId)) records.push(record);
    }
    return records.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.reviewId.localeCompare(right.reviewId));
  }

  async appendAttempt(reviewId: string, attempt: QualityReviewAttempt): Promise<QualityReviewRecord> {
    const id = assertReviewId(reviewId);
    const parsed = cloneAttempt(attempt);
    const current = await this.require(id);
    if (current.attempts.some((entry) => entry.attemptId === parsed.attemptId)) {
      throw new QualityStoreError("IMMUTABLE_RECORD", `quality attempt ${parsed.attemptId} already exists`);
    }
    const next = withUpdatedRecord(current, (draft) => {
      draft.attempts.push(parsed);
      draft.latestAttemptId = parsed.attemptId;
      draft.status = parsed.status === "queued" ? "queued" : parsed.status;
    });
    await this.save(next);
    return (await this.get(id))!;
  }

  async appendProgress(reviewId: string, attemptId: string, event: QualityProgressEvent): Promise<QualityReviewRecord> {
    const id = assertReviewId(reviewId);
    const attemptKey = assertAttemptId(attemptId);
    const parsed = cloneProgress(event);
    const current = await this.require(id);
    const attempt = current.attempts.find((entry) => entry.attemptId === attemptKey);
    if (!attempt) throw new QualityStoreError("INVALID_ATTEMPT_ID", `Quality attempt ${attemptKey} does not exist in review ${id}`);
    if (isTerminalQualityAttemptStatus(attempt.status)) throw new QualityStoreError("IMMUTABLE_RECORD", `terminal quality attempt ${attemptKey} cannot receive progress`);
    const last = attempt.progress.at(-1)?.sequence ?? -1;
    if (parsed.sequence !== last + 1) throw new QualityStoreError("SEQUENCE_ERROR", `Quality progress for ${attemptKey} must append sequence ${last + 1}`);
    if (attempt.progress.some((entry) => entry.eventId === parsed.eventId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality progress event ${parsed.eventId} already exists`);
    const next = withUpdatedRecord(current, (draft) => {
      const target = draft.attempts.find((entry) => entry.attemptId === attemptKey)!;
      target.progress.push(parsed);
      target.lastProgressAt = parsed.timestamp;
      target.statistics.eventCount += 1;
    });
    await this.save(next);
    return (await this.get(id))!;
  }

  async appendFinding(reviewId: string, finding: QualityFinding): Promise<QualityReviewRecord> {
    const id = assertReviewId(reviewId);
    const parsed = cloneFinding(finding);
    const current = await this.require(id);
    if (!current.attempts.some((entry) => entry.attemptId === parsed.attemptId)) throw new QualityStoreError("INVALID_ATTEMPT_ID", `Quality attempt ${parsed.attemptId} does not exist in review ${id}`);
    if (current.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality finding ${parsed.findingId} already exists`);
    const next = withUpdatedRecord(current, (draft) => {
      draft.findings.push(parsed);
      const attempt = draft.attempts.find((entry) => entry.attemptId === parsed.attemptId)!;
      attempt.findingIds.push(parsed.findingId);
      attempt.statistics.findingsProduced += 1;
      if (parsed.location.status === "anchored") attempt.statistics.anchoredFindings += 1;
      else attempt.statistics.unanchoredFindings += 1;
      if (parsed.kind === "unresolved-citation") attempt.statistics.unresolvedCitations += 1;
      attempt.statistics.evidenceCount += parsed.evidence.length;
    });
    await this.save(next);
    return (await this.get(id))!;
  }

  async appendDisposition(reviewId: string, disposition: QualityFindingDisposition): Promise<QualityReviewRecord> {
    const id = assertReviewId(reviewId);
    const parsed = cloneDisposition(disposition);
    const current = await this.require(id);
    if (!current.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("INVALID_FINDING_ID", `Quality finding ${parsed.findingId} does not exist in review ${id}`);
    if (current.dispositions.some((entry) => entry.dispositionId === parsed.dispositionId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality disposition ${parsed.dispositionId} already exists`);
    if (parsed.supersedesDispositionId !== null && !current.dispositions.some((entry) => entry.dispositionId === parsed.supersedesDispositionId)) throw new QualityStoreError("INVALID_DISPOSITION_ID", `Disposition ${parsed.supersedesDispositionId} does not exist in review ${id}`);
    const next = withUpdatedRecord(current, (draft) => { draft.dispositions.push(parsed); });
    await this.save(next);
    return (await this.get(id))!;
  }

  async appendPromotion(reviewId: string, promotion: QualityFindingPromotion): Promise<QualityReviewRecord> {
    const id = assertReviewId(reviewId);
    const parsed = clonePromotion(promotion);
    const current = await this.require(id);
    if (!current.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("INVALID_FINDING_ID", `Quality finding ${parsed.findingId} does not exist in review ${id}`);
    if (current.promotions.some((entry) => entry.promotionId === parsed.promotionId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality promotion ${parsed.promotionId} already exists`);
    const next = withUpdatedRecord(current, (draft) => { draft.promotions.push(parsed); });
    await this.save(next);
    return (await this.get(id))!;
  }

  private async require(reviewId: string): Promise<QualityReviewRecord> {
    const record = await this.get(reviewId);
    if (record === null) throw new QualityStoreError("INVALID_REVIEW_ID", `Quality review ${reviewId} does not exist`);
    return record;
  }

  private async read(reviewId: string): Promise<QualityReviewRecord | null> {
    const target = reviewPath(this.root, reviewId);
    let contents: string;
    try {
      contents = await readFile(target, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new QualityStoreError("IO_ERROR", `Unable to read quality review ${reviewId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    try {
      return qualityReviewRecordSchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new QualityStoreError("INVALID_RECORD", `Persisted quality review ${reviewId} is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

/** In-memory implementation used by orchestration and unit tests. It returns defensive clones. */
export class MemoryQualityReviewStore implements QualityReviewStore {
  private readonly records = new Map<string, QualityReviewRecord>();
  private readonly writes = new Map<string, Promise<void>>();

  async save(record: QualityReviewRecord): Promise<void> {
    const parsed = cloneRecord(record);
    const reviewId = assertReviewId(parsed.reviewId);
    const previousWrite = this.writes.get(reviewId) ?? Promise.resolve();
    const nextWrite = previousWrite.catch(() => undefined).then(() => {
      const previous = this.records.get(reviewId);
      if (previous) assertAppendOnly(previous, parsed);
      this.records.set(reviewId, cloneRecord(parsed));
    });
    this.writes.set(reviewId, nextWrite);
    try {
      await nextWrite;
    } finally {
      if (this.writes.get(reviewId) === nextWrite) this.writes.delete(reviewId);
    }
  }

  async get(reviewId: string): Promise<QualityReviewRecord | null> {
    const id = assertReviewId(reviewId);
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async list(projectId?: string): Promise<QualityReviewRecord[]> {
    return [...this.records.values()]
      .filter((record) => projectId === undefined || record.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.reviewId.localeCompare(right.reviewId))
      .map((record) => cloneRecord(record));
  }

  async appendAttempt(reviewId: string, attempt: QualityReviewAttempt): Promise<QualityReviewRecord> {
    return appendUsing(this, reviewId, (draft) => {
      const parsed = cloneAttempt(attempt);
      if (draft.attempts.some((entry) => entry.attemptId === parsed.attemptId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality attempt ${parsed.attemptId} already exists`);
      draft.attempts.push(parsed);
      draft.latestAttemptId = parsed.attemptId;
      draft.status = parsed.status === "queued" ? "queued" : parsed.status;
    });
  }

  async appendProgress(reviewId: string, attemptId: string, event: QualityProgressEvent): Promise<QualityReviewRecord> {
    return appendUsing(this, reviewId, (draft) => appendProgressToDraft(draft, attemptId, event));
  }

  async appendFinding(reviewId: string, finding: QualityFinding): Promise<QualityReviewRecord> {
    return appendUsing(this, reviewId, (draft) => appendFindingToDraft(draft, finding));
  }

  async appendDisposition(reviewId: string, disposition: QualityFindingDisposition): Promise<QualityReviewRecord> {
    return appendUsing(this, reviewId, (draft) => appendDispositionToDraft(draft, disposition));
  }

  async appendPromotion(reviewId: string, promotion: QualityFindingPromotion): Promise<QualityReviewRecord> {
    return appendUsing(this, reviewId, promotionDraft => appendPromotionToDraft(promotionDraft, promotion));
  }
}

// Names parallel the existing research record store and make the aggregate-oriented API explicit.
export type QualityReviewRecordStore = QualityReviewStore;
export const FileQualityReviewRecordStore = FileQualityReviewStore;
export const MemoryQualityReviewRecordStore = MemoryQualityReviewStore;

function appendProgressToDraft(draft: QualityReviewRecord, attemptId: string, event: QualityProgressEvent): void {
  const attemptKey = assertAttemptId(attemptId);
  const parsed = cloneProgress(event);
  const attempt = draft.attempts.find((entry) => entry.attemptId === attemptKey);
  if (!attempt) throw new QualityStoreError("INVALID_ATTEMPT_ID", `Quality attempt ${attemptKey} does not exist in review ${draft.reviewId}`);
  if (isTerminalQualityAttemptStatus(attempt.status)) throw new QualityStoreError("IMMUTABLE_RECORD", `terminal quality attempt ${attemptKey} cannot receive progress`);
  const last = attempt.progress.at(-1)?.sequence ?? -1;
  if (parsed.sequence !== last + 1) throw new QualityStoreError("SEQUENCE_ERROR", `Quality progress for ${attemptKey} must append sequence ${last + 1}`);
  if (attempt.progress.some((entry) => entry.eventId === parsed.eventId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality progress event ${parsed.eventId} already exists`);
  attempt.progress.push(parsed);
  attempt.lastProgressAt = parsed.timestamp;
  attempt.statistics.eventCount += 1;
}

function appendFindingToDraft(draft: QualityReviewRecord, finding: QualityFinding): void {
  const parsed = cloneFinding(finding);
  if (!draft.attempts.some((entry) => entry.attemptId === parsed.attemptId)) throw new QualityStoreError("INVALID_ATTEMPT_ID", `Quality attempt ${parsed.attemptId} does not exist in review ${draft.reviewId}`);
  if (draft.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality finding ${parsed.findingId} already exists`);
  draft.findings.push(parsed);
  const attempt = draft.attempts.find((entry) => entry.attemptId === parsed.attemptId)!;
  attempt.findingIds.push(parsed.findingId);
  attempt.statistics.findingsProduced += 1;
  if (parsed.location.status === "anchored") attempt.statistics.anchoredFindings += 1;
  else attempt.statistics.unanchoredFindings += 1;
  if (parsed.kind === "unresolved-citation") attempt.statistics.unresolvedCitations += 1;
  attempt.statistics.evidenceCount += parsed.evidence.length;
}

function appendDispositionToDraft(draft: QualityReviewRecord, disposition: QualityFindingDisposition): void {
  const parsed = cloneDisposition(disposition);
  if (!draft.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("INVALID_FINDING_ID", `Quality finding ${parsed.findingId} does not exist in review ${draft.reviewId}`);
  if (draft.dispositions.some((entry) => entry.dispositionId === parsed.dispositionId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality disposition ${parsed.dispositionId} already exists`);
  if (parsed.supersedesDispositionId !== null && !draft.dispositions.some((entry) => entry.dispositionId === parsed.supersedesDispositionId)) throw new QualityStoreError("INVALID_DISPOSITION_ID", `Disposition ${parsed.supersedesDispositionId} does not exist in review ${draft.reviewId}`);
  draft.dispositions.push(parsed);
}

function appendPromotionToDraft(draft: QualityReviewRecord, promotion: QualityFindingPromotion): void {
  const parsed = clonePromotion(promotion);
  if (!draft.findings.some((entry) => entry.findingId === parsed.findingId)) throw new QualityStoreError("INVALID_FINDING_ID", `Quality finding ${parsed.findingId} does not exist in review ${draft.reviewId}`);
  if (draft.promotions.some((entry) => entry.promotionId === parsed.promotionId)) throw new QualityStoreError("IMMUTABLE_RECORD", `quality promotion ${parsed.promotionId} already exists`);
  draft.promotions.push(parsed);
}

async function appendUsing(store: QualityReviewStore, reviewId: string, update: (draft: QualityReviewRecord) => void): Promise<QualityReviewRecord> {
  const id = assertReviewId(reviewId);
  const current = await store.get(id);
  if (current === null) throw new QualityStoreError("INVALID_REVIEW_ID", `Quality review ${id} does not exist`);
  const draft = cloneRecord(current);
  update(draft);
  draft.updatedAt = new Date().toISOString();
  await store.save(draft);
  return (await store.get(id))!;
}

function reviewPath(root: string, reviewId: string): string {
  return path.join(root, `${reviewId}.json`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
