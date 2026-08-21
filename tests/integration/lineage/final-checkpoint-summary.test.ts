import { describe, expect, it } from "vitest";
import { LineageService } from "../../../apps/server/src/lineage/service.js";
import { MemoryLineageStore } from "../../../apps/server/src/lineage/store.js";
import type { ProposalRecord } from "../../../apps/server/src/proposals/store.js";
import type { QualityReviewRecord } from "../../../packages/shared/src/quality/contracts.js";
import { makeSourceRecord, type SourceRecord } from "../../../packages/shared/src/sources/contracts.js";

const projectId = "project-final-summary";
const timestamp = "2026-08-14T12:00:00.000Z";
const sourceId = "src_aaaaaaaaaaaaaaaa";
const versionId = "ev_bbbbbbbbbbbbbbbb";
const checksum = "a".repeat(64);

function source(): SourceRecord {
  return makeSourceRecord({
    sourceId,
    kind: "url",
    identity: "https://example.test/source",
    evidenceState: "archived",
    latestVersionId: versionId,
    versions: [{ versionId, checksum, byteLength: 10, mediaType: "text/plain", capturedAt: timestamp, attemptId: "cap_cccccccccccccccc", originalRef: "source.txt" }],
    attempts: [],
    lastAttemptId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function review(): QualityReviewRecord {
  return {
    reviewId: "review-final",
    projectId,
    targetCheckpoint: {
      checkpointId: "checkpoint-final",
      acceptedAt: "2026-08-14T12:02:00.000Z",
      reportArtifactId: "report-final",
      reportPath: "research/report.md",
      sourceGraph: {
        graphId: "graph-final",
        sourceBindings: [
          { sourceId, versionId, checksum },
          { sourceId: "src_missingmissing", versionId: "ev_missingmissing", checksum },
        ],
      },
    },
    createdAt: "2026-08-14T12:03:00.000Z",
    updatedAt: "2026-08-14T12:05:00.000Z",
    attempts: [
      { attemptId: "qa-old", parentAttemptId: null, status: "completed", outcome: "findings", createdAt: "2026-08-14T12:03:00.000Z" },
      { attemptId: "qa-latest", parentAttemptId: "qa-old", status: "completed", outcome: "pass", createdAt: "2026-08-14T12:05:00.000Z" },
    ],
    findings: [
      { findingId: "finding-open", attemptId: "qa-old", title: "Open risk", rationale: "The claim remains narrow.", severity: "high", location: { status: "unanchored", anchor: null, diagnostic: null }, citation: null, evidence: [] },
      { findingId: "finding-accepted", attemptId: "qa-old", title: "Accepted risk", rationale: "The limitation is visible.", severity: "medium", location: { status: "unanchored", anchor: null, diagnostic: null }, citation: null, evidence: [] },
    ],
    dispositions: [{ dispositionId: "disposition-final", findingId: "finding-accepted", action: "accepted-risk", rationale: "Keep this limitation visible.", createdAt: "2026-08-14T12:04:00.000Z" }],
    promotions: [],
  } as unknown as QualityReviewRecord;
}

function proposal(): ProposalRecord {
  return {
    proposalId: "proposal-final",
    runId: "research-final",
    repositoryRoot: "/fixture/project",
    checkpoint: { sha: "checkpoint-final", ref: "refs/margin/checkpoints/final", worktreePath: "/fixture/worktree" },
    status: "kept",
    decision: "keep",
    diff: { files: [] },
    cleanup: { status: "completed", startedAt: timestamp, endedAt: timestamp, diagnostics: null },
    createdAt: "2026-08-14T12:01:00.000Z",
    updatedAt: "2026-08-14T12:02:30.000Z",
    decidedAt: "2026-08-14T12:02:30.000Z",
    errorCode: null,
    diagnostics: null,
  } as unknown as ProposalRecord;
}

describe("final checkpoint summary", () => {
  it("reports source health, remaining risks, proposal state, and the latest exact QA attempt", async () => {
    const store = new MemoryLineageStore({ sources: [source()], qualityReviews: [review()], proposals: [proposal()] });
    const service = new LineageService(store, { clock: () => new Date("2026-08-14T12:10:00.000Z") });
    await service.acknowledgeCheckpointReview(projectId, {
      acknowledgmentId: "ack-old",
      checkpointId: "checkpoint-final",
      qaAttemptId: "qa-old",
      actorId: "reviewer-1",
      createdAt: "2026-08-14T12:04:30.000Z",
    });

    const beforeLatestAck = await service.getFinalCheckpointSummary(projectId);
    expect(beforeLatestAck).toMatchObject({
      checkpointId: "checkpoint-final",
      reportTarget: { type: "research-report", id: "report-final", path: "research/report.md" },
      latestQaAttemptId: "qa-latest",
      latestQaOutcome: "pass",
      remainingRiskCounts: { open: 1, accepted: 1 },
      sourceHealth: { total: 2, archived: 1, metadataOnly: 0, unavailable: 1, failed: 0 },
      reviewAcknowledged: false,
      proposalDecision: "keep",
    });

    await service.acknowledgeCheckpointReview(projectId, {
      acknowledgmentId: "ack-latest",
      checkpointId: "checkpoint-final",
      qaAttemptId: "qa-latest",
      actorId: "reviewer-1",
      createdAt: "2026-08-14T12:06:00.000Z",
    });
    const afterRestart = await new LineageService(store, { clock: () => new Date("2026-08-14T12:11:00.000Z") }).finalCheckpointSummary(projectId);
    expect(afterRestart.reviewAcknowledged).toBe(true);
    expect(afterRestart.latestQaAttemptId).toBe("qa-latest");
  });
});
