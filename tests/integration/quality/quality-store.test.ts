import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  qualityAcceptedCheckpointSchema,
  qualityFindingSchema,
  qualityReviewAttemptSchema,
  qualityReviewRecordSchema,
} from "../../../packages/shared/src/quality/contracts.js";
import {
  FileQualityReviewStore,
  MemoryQualityReviewStore,
  QualityStoreError,
  type QualityReviewStore,
} from "../../../apps/server/src/quality/store.js";

const timestamp = "2026-08-14T12:00:00.000Z";
const checksum = "b".repeat(64);
const sourceId = "src_fedcba0987654321";
const versionId = "ev_fedcba0987654321";

function makeRecord() {
  const checkpoint = qualityAcceptedCheckpointSchema.parse({
    checkpointId: "checkpoint-1",
    reportArtifactId: "report-1",
    reportPath: "research/report.md",
    reportSha256: checksum,
    sourceGraph: {
      graphId: "source-graph-1",
      sourceBindings: [{ sourceId, versionId, checksum, evidenceAvailability: "metadata-only" }],
      capturedAt: timestamp,
    },
    acceptedAt: timestamp,
    acceptedBy: "acceptance-user",
  });
  return qualityReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: "review-1",
    projectId: "project-1",
    correlationId: randomUUID(),
    targetCheckpoint: checkpoint,
    reviewerInstruction: {
      instructionId: "instruction-1",
      text: "Review claims independently against the accepted checkpoint.",
      sha256: checksum,
      createdAt: timestamp,
    },
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function makeAttempt(status: "queued" | "completed" = "queued") {
  return qualityReviewAttemptSchema.parse({
    attemptId: status === "queued" ? "attempt-1" : "attempt-2",
    parentAttemptId: status === "queued" ? null : "attempt-1",
    sessionId: "session-1",
    correlationId: randomUUID(),
    reviewerInstructionId: "instruction-1",
    status,
    outcome: status === "completed" ? "findings" : null,
    statistics: {},
    cancellation: {},
    createdAt: timestamp,
    endedAt: status === "completed" ? timestamp : null,
  });
}

function makeFinding() {
  return qualityFindingSchema.parse({
    findingId: "finding-1",
    attemptId: "attempt-1",
    kind: "unsupported-claim",
    severity: "high",
    uncertainty: "low",
    title: "Claim is unsupported",
    rationale: "The frozen source does not support the report wording.",
    location: {
      status: "anchored",
      anchor: { relativePath: "research/report.md", startOffset: 2, endOffset: 18, quote: "unsupported claim" },
    },
    citation: { citationKey: "cite-1", sourceId, versionId },
    evidence: [{ sourceId, versionId, checksum, availability: "metadata-only" }],
    createdAt: timestamp,
  });
}

async function exerciseStore(makeStore: (root: string) => QualityReviewStore, root: string) {
  const store = makeStore(root);
  const record = makeRecord();
  await store.save(record);

  const loaded = await store.get("review-1");
  expect(loaded).toEqual(record);
  loaded!.status = "running";
  expect((await store.get("review-1"))!.status).toBe("draft");

  const queued = await store.appendAttempt("review-1", makeAttempt());
  expect(queued.latestAttemptId).toBe("attempt-1");
  await store.appendProgress("review-1", "attempt-1", { eventId: "event-1", sequence: 0, type: "started", timestamp });
  await expect(store.appendProgress("review-1", "attempt-1", { eventId: "event-3", sequence: 2, type: "diagnostic", timestamp }))
    .rejects.toMatchObject({ code: "SEQUENCE_ERROR" });

  const finding = makeFinding();
  const withFinding = await store.appendFinding("review-1", finding);
  expect(withFinding.findings).toHaveLength(1);
  expect(withFinding.attempts[0]?.statistics).toMatchObject({ findingsProduced: 1, anchoredFindings: 1, evidenceCount: 1 });

  const withDisposition = await store.appendDisposition("review-1", {
    dispositionId: "disposition-1",
    findingId: "finding-1",
    action: "accepted-risk",
    rationale: "The limitation is explicit and accepted for this checkpoint.",
    actorId: "reviewer-1",
    createdAt: timestamp,
  });
  expect(withDisposition.dispositions[0]?.action).toBe("accepted-risk");

  const withPromotion = await store.appendPromotion("review-1", {
    promotionId: "promotion-1",
    findingId: "finding-1",
    target: "comment",
    targetId: "comment-1",
    actorId: "reviewer-1",
    createdAt: timestamp,
  });
  expect(withPromotion.promotions[0]?.targetId).toBe("comment-1");

  const terminal = qualityReviewRecordSchema.parse({
    ...withPromotion,
    status: "completed",
    attempts: [{ ...withPromotion.attempts[0], status: "completed", outcome: "findings", endedAt: timestamp }],
  });
  await store.save(terminal);
  await expect(store.appendProgress("review-1", "attempt-1", { eventId: "event-2", sequence: 1, type: "completed", timestamp }))
    .rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });

  const mutated = qualityReviewRecordSchema.parse({
    ...terminal,
    findings: [{ ...terminal.findings[0], rationale: "rewritten reviewer history" }],
  });
  await expect(store.save(mutated)).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });

  const listed = await store.list("project-1");
  expect(listed.map((entry) => entry.reviewId)).toEqual(["review-1"]);
  expect(await store.get("missing-review")).toBeNull();
}

describe("quality review persistence", () => {
  it("keeps append-only lifecycle and claim history in memory", async () => {
    await exerciseStore((root) => new MemoryQualityReviewStore(), "memory");
  });

  it("reconnects append-only lifecycle and claim history from atomic JSON", async () => {
    const root = await mkdtemp(`${tmpdir()}/margin-quality-`);
    try {
      await exerciseStore((storeRoot) => new FileQualityReviewStore(storeRoot), root);
      const store = new FileQualityReviewStore(root);
      expect((await store.get("review-1"))?.status).toBe("completed");
      expect((await store.get("review-1"))?.findings[0]?.findingId).toBe("finding-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid review identifiers without touching persistence", async () => {
    const store = new MemoryQualityReviewStore();
    await expect(store.get("../escape")).rejects.toBeInstanceOf(QualityStoreError);
    await expect(store.get("../escape")).rejects.toMatchObject({ code: "INVALID_REVIEW_ID" });
  });

  it("does not expose malformed persisted records as valid review state", async () => {
    const root = await mkdtemp(`${tmpdir()}/margin-quality-invalid-`);
    try {
      await writeFile(`${root}/review-1.json`, "{ malformed", "utf8");
      await expect(new FileQualityReviewStore(root).get("review-1"))
        .rejects.toMatchObject({ code: "INVALID_RECORD" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
