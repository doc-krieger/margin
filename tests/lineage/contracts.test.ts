import { describe, expect, it } from "vitest";
import {
  checkpointReviewAcknowledgmentInputSchema,
  finalCheckpointSummarySchema,
  findingRelationshipInputSchema,
  findingRelationshipSchema,
} from "../../packages/shared/src/lineage/contracts.js";

const timestamp = "2026-08-14T12:00:00.000Z";

describe("lineage contracts", () => {
  it("keeps relationship decisions append-only and accepts server-assigned identity", () => {
    const input = findingRelationshipInputSchema.parse({
      fromFindingId: "finding-old",
      toFindingId: "finding-new",
      relation: "superseded",
      rationale: "The follow-up finding narrows the original claim.",
      confidence: 0.92,
      origin: "human-confirmed",
      actorId: "reviewer-1",
    });
    expect(input.relationshipId).toBeUndefined();
    expect(findingRelationshipSchema.parse({
      ...input,
      relationshipId: "relationship-1",
      projectId: "project-1",
      createdAt: timestamp,
    })).toMatchObject({ relation: "superseded", supersedesRelationshipId: null });
  });

  it("rejects unsafe relationship input and binds acknowledgements to both records", () => {
    expect(() => findingRelationshipInputSchema.parse({
      fromFindingId: "finding-old",
      relation: "resolved",
      rationale: "ok",
      confidence: 1.1,
      origin: "automatic",
      actorId: "agent",
    })).toThrow();

    expect(checkpointReviewAcknowledgmentInputSchema.parse({
      checkpointId: "checkpoint-1",
      qaAttemptId: "qa-1",
      actorId: "reviewer-1",
    })).toMatchObject({ checkpointId: "checkpoint-1", qaAttemptId: "qa-1" });
  });

  it("does not allow a summary to omit its truth fields", () => {
    expect(() => finalCheckpointSummarySchema.parse({
      schemaVersion: 1,
      projectId: "project-1",
      checkpointId: "checkpoint-1",
      reportTarget: null,
      latestQaAttemptId: null,
      latestQaOutcome: null,
      remainingRiskCounts: { open: 0, accepted: 0 },
      sourceHealth: { total: 0, archived: 0, metadataOnly: 0, unavailable: 0, failed: 0 },
      reviewAcknowledged: false,
      proposalDecision: null,
      generatedAt: timestamp,
    })).not.toThrow();
  });
});
