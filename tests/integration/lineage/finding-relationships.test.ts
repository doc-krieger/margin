import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LineageError, LineageService } from "../../../apps/server/src/lineage/service.js";
import { FileLineageFactStore, LineageStore, MemoryLineageStore } from "../../../apps/server/src/lineage/store.js";
import type { QualityReviewRecord } from "../../../packages/shared/src/quality/contracts.js";

const projectId = "project-relationships";
const timestamp = "2026-08-14T12:00:00.000Z";

function review(): QualityReviewRecord {
  return {
    reviewId: "review-relationships",
    projectId,
    targetCheckpoint: { checkpointId: "checkpoint-1" },
    createdAt: timestamp,
    updatedAt: "2026-08-14T12:03:00.000Z",
    attempts: [{ attemptId: "qa-1", parentAttemptId: null, status: "completed", outcome: "findings", createdAt: "2026-08-14T12:01:00.000Z" }],
    findings: [
      { findingId: "finding-old", attemptId: "qa-1", title: "Original claim", rationale: "The first checkpoint overstates the source.", severity: "high", location: { status: "unanchored", anchor: null, diagnostic: null }, citation: null, evidence: [] },
      { findingId: "finding-new", attemptId: "qa-1", title: "Narrowed claim", rationale: "The follow-up checkpoint narrows the claim.", severity: "medium", location: { status: "unanchored", anchor: null, diagnostic: null }, citation: null, evidence: [] }
    ],
    dispositions: [],
    promotions: [],
  } as unknown as QualityReviewRecord;
}

describe("finding relationships and checkpoint review facts", () => {
  it("appends relationships without mutating findings and projects their cross-checkpoint targets", async () => {
    const store = new MemoryLineageStore({ qualityReviews: [review()] });
    const service = new LineageService(store, { clock: () => new Date(timestamp) });
    const first = await service.recordFindingRelationship(projectId, {
      relationshipId: "relationship-1",
      fromFindingId: "finding-old",
      toFindingId: "finding-new",
      relation: "superseded",
      rationale: "The follow-up checkpoint narrows the original claim.",
      confidence: 0.95,
      origin: "human-confirmed",
      actorId: "reviewer-1",
      createdAt: "2026-08-14T12:04:00.000Z",
    });
    const second = await service.recordFindingRelationship(projectId, {
      relationshipId: "relationship-2",
      fromFindingId: "finding-old",
      toFindingId: "finding-new",
      relation: "resolved",
      rationale: "A later review confirms the narrowed claim.",
      confidence: 0.88,
      origin: "human-corrected",
      actorId: "reviewer-1",
      createdAt: "2026-08-14T12:05:00.000Z",
      supersedesRelationshipId: first.relationshipId,
    });

    const snapshot = await store.snapshot(projectId);
    expect(snapshot.findingRelationships).toEqual([first, second]);
    const page = await service.list(projectId, { limit: 200 });
    const relationshipEntries = page.entries.filter((entry) => entry.kind === "finding.relationship");
    expect(relationshipEntries).toHaveLength(2);
    expect(relationshipEntries[1]).toMatchObject({
      status: "resolved",
      findingId: "finding-old",
      detailTarget: { type: "finding-relationship", id: "relationship-2" },
    });
    expect(relationshipEntries[1].relatedTargets).toEqual(expect.arrayContaining([
      { type: "finding", id: "finding-new" },
      { type: "finding-relationship", id: "relationship-1" },
    ]));
    expect(page.entries.find((entry) => entry.entryId === "qa.finding:finding-old")?.summary).toBe("The first checkpoint overstates the source.");
  });

  it("rejects relationships that invent findings or supersede unknown decisions", async () => {
    const service = new LineageService(new MemoryLineageStore({ qualityReviews: [review()] }));
    await expect(service.recordFindingRelationship(projectId, {
      fromFindingId: "missing-finding",
      relation: "unresolved",
      rationale: "This must not become a guessed finding.",
      confidence: 0.5,
      origin: "automatic",
      actorId: "agent",
    })).rejects.toMatchObject<LineageError>({ code: "LINEAGE_INVALID_RELATIONSHIP" });

    await expect(service.recordFindingRelationship(projectId, {
      fromFindingId: "finding-old",
      relation: "resolved",
      rationale: "The superseded relationship must already exist.",
      confidence: 0.5,
      origin: "human-confirmed",
      actorId: "reviewer-1",
      supersedesRelationshipId: "missing-relationship",
    })).rejects.toMatchObject<LineageError>({ code: "LINEAGE_INVALID_RELATIONSHIP" });
  });

  it("survives a new store and service instance through the atomic fact file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-lineage-facts-"));
    try {
      const facts = new FileLineageFactStore(root);
      const canonical = { qualityReviews: [review()] };
      const firstService = new LineageService(new LineageStore({ snapshot: async () => canonical, factStore: facts }));
      await firstService.recordFindingRelationship(projectId, {
        relationshipId: "relationship-persisted",
        fromFindingId: "finding-old",
        toFindingId: "finding-new",
        relation: "persists",
        rationale: "The relationship remains true after reconnect.",
        confidence: 0.81,
        origin: "automatic",
        actorId: "agent",
        createdAt: "2026-08-14T12:07:00.000Z",
      });
      const restarted = new LineageService(new LineageStore({ snapshot: async () => canonical, factStore: facts }));
      expect((await restarted.list(projectId, { limit: 200 })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "finding.relationship", detailTarget: expect.objectContaining({ id: "relationship-persisted" }) }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("acknowledges only the exact terminal QA attempt and exposes the acknowledgement as a fact", async () => {
    const service = new LineageService(new MemoryLineageStore({ qualityReviews: [review()] }), { clock: () => new Date(timestamp) });
    const acknowledgment = await service.acknowledgeCheckpointReview(projectId, {
      acknowledgmentId: "ack-1",
      checkpointId: "checkpoint-1",
      qaAttemptId: "qa-1",
      actorId: "reviewer-1",
      createdAt: "2026-08-14T12:06:00.000Z",
    });
    expect(acknowledgment).toMatchObject({ checkpointId: "checkpoint-1", qaAttemptId: "qa-1" });
    await expect(service.acknowledgeCheckpointReview(projectId, {
      acknowledgmentId: "ack-2",
      checkpointId: "checkpoint-1",
      qaAttemptId: "missing-qa",
      actorId: "reviewer-1",
    })).rejects.toMatchObject<LineageError>({ code: "LINEAGE_INVALID_REVIEW_ACKNOWLEDGMENT" });
    expect((await service.list(projectId, { limit: 200 })).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "checkpoint.reviewed", checkpointId: "checkpoint-1", attemptId: "qa-1" }),
    ]));
  });
});
