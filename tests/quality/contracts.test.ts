import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  qualityAcceptedCheckpointSchema,
  qualityFindingSchema,
  qualityReviewAttemptSchema,
  qualityReviewRecordSchema,
  qualitySourceGraphSchema,
} from "../../packages/shared/src/quality/contracts.js";

const timestamp = "2026-08-14T12:00:00.000Z";
const checksum = "a".repeat(64);
const sourceId = "src_1234567890abcdef";
const versionId = "ev_1234567890abcdef";

function checkpoint() {
  return qualityAcceptedCheckpointSchema.parse({
    checkpointId: "checkpoint-1",
    reportArtifactId: "report-1",
    reportPath: "research/report.md",
    reportSha256: checksum,
    sourceGraph: {
      graphId: "source-graph-1",
      sourceBindings: [{
        sourceId,
        versionId,
        checksum,
        evidenceAvailability: "metadata-only",
      }],
      capturedAt: timestamp,
    },
    acceptedAt: timestamp,
    acceptedBy: "human-reviewer",
  });
}

function attempt(overrides: Record<string, unknown> = {}) {
  return qualityReviewAttemptSchema.parse({
    attemptId: "attempt-1",
    correlationId: randomUUID(),
    reviewerInstructionId: "instruction-1",
    status: "queued",
    statistics: {},
    cancellation: {},
    createdAt: timestamp,
    ...overrides,
  });
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return qualityReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: "review-1",
    projectId: "project-1",
    correlationId: randomUUID(),
    targetCheckpoint: checkpoint(),
    reviewerInstruction: {
      instructionId: "instruction-1",
      text: "Review every report claim against the frozen source graph.",
      sha256: checksum,
      createdAt: timestamp,
    },
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

describe("quality contracts", () => {
  it("freezes accepted report and exact source/version evidence lineage", () => {
    const parsed = checkpoint();

    expect(parsed.sourceGraph.sourceBindings[0]).toMatchObject({ sourceId, versionId, checksum });
    expect(parsed.sourceGraph.sourceBindings[0]?.evidenceAvailability).toBe("metadata-only");
    expect(qualitySourceGraphSchema.safeParse({
      ...parsed.sourceGraph,
      sourceBindings: [parsed.sourceGraph.sourceBindings[0], parsed.sourceGraph.sourceBindings[0]],
    }).success).toBe(false);
  });

  it("requires explicit anchored versus unanchored finding state and bounded evidence", () => {
    const anchored = qualityFindingSchema.parse({
      findingId: "finding-1",
      attemptId: "attempt-1",
      kind: "unsupported-claim",
      severity: "high",
      uncertainty: "low",
      title: "Claim lacks support",
      rationale: "The cited source does not contain the reported claim.",
      location: {
        status: "anchored",
        anchor: { relativePath: "research/report.md", startOffset: 10, endOffset: 20, quote: "unsupported claim" },
      },
      citation: { citationKey: "cite-1", sourceId, versionId },
      evidence: [{ sourceId, versionId, checksum, availability: "metadata-only" }],
      createdAt: timestamp,
    });
    const unanchored = qualityFindingSchema.parse({
      findingId: "finding-2",
      attemptId: "attempt-1",
      kind: "unresolved-citation",
      severity: "medium",
      uncertainty: "high",
      title: "Citation cannot be resolved",
      rationale: "No safe exact-version match was available.",
      location: { status: "unanchored", diagnostic: "citation key was not present in the accepted graph" },
      citation: { citationKey: "missing-citation" },
      createdAt: timestamp,
    });

    expect(anchored.location.status).toBe("anchored");
    expect(unanchored.location).toMatchObject({ status: "unanchored", anchor: null });
    expect(qualityFindingSchema.safeParse({
      ...anchored,
      location: { status: "anchored", anchor: null },
    }).success).toBe(false);
    expect(qualityFindingSchema.safeParse({
      ...anchored,
      location: { status: "unanchored", anchor: anchored.location.anchor },
    }).success).toBe(false);
  });

  it("keeps progress ordered and prevents terminal attempts without a result", () => {
    expect(() => attempt({
      progress: [
        { eventId: "event-1", sequence: 0, type: "started", timestamp: timestamp },
        { eventId: "event-2", sequence: 2, type: "completed", timestamp: timestamp },
        { eventId: "event-3", sequence: 1, type: "diagnostic", timestamp: timestamp },
      ],
    })).toThrow();
  });

  it("validates review references and immutable retry instruction identity", () => {
    const first = attempt();
    const record = baseRecord({ attempts: [first], latestAttemptId: first.attemptId });
    expect(record.latestAttemptId).toBe("attempt-1");
    expect(qualityReviewRecordSchema.safeParse({
      ...record,
      attempts: [{ ...first, reviewerInstructionId: "different-instruction" }],
    }).success).toBe(false);
    expect(qualityReviewRecordSchema.safeParse({
      ...record,
      latestAttemptId: "missing-attempt",
    }).success).toBe(false);
  });
});
