import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualityAcceptedCheckpointSchema } from "../../../packages/shared/src/quality/contracts.js";
import { CommentService } from "../../../apps/server/src/comments/repository.js";
import { MemoryQualityReviewStore } from "../../../apps/server/src/quality/store.js";
import { QualityReviewError, QualityReviewService, type QualityExecutor, type QualityExecutorInput } from "../../../apps/server/src/quality/service.js";

const timestamp = "2026-08-14T12:00:00.000Z";
const sourceId = "src_aaaaaaaaaaaaaaaa";
const versionId = "ev_bbbbbbbbbbbbbbbb";
const sourceChecksum = "c".repeat(64);
const instruction = { instructionId: "qa-instruction-v1", text: "Check every claim against the accepted evidence.", sha256: "d".repeat(64), createdAt: timestamp };

function checkpoint(reportText = "# Accepted report\nThe claim is here.\n") {
  return qualityAcceptedCheckpointSchema.parse({
    checkpointId: "checkpoint-accepted-1",
    reportArtifactId: "report-artifact-1",
    reportPath: "report.md",
    reportSha256: createHash("sha256").update(reportText).digest("hex"),
    sourceGraph: {
      graphId: "source-graph-1",
      sourceBindings: [{ sourceId, versionId, checksum: sourceChecksum, required: true, citationKeys: ["primary"], evidenceAvailability: "metadata-only", evidenceChecksum: null }],
      graphChecksum: null,
      capturedAt: timestamp,
    },
    citationValidationHash: null,
    acceptedAt: timestamp,
    acceptedBy: "researcher",
  });
}

function finding() {
  return {
    findingId: "finding-unsupported-1",
    kind: "unsupported-claim",
    severity: "high",
    uncertainty: "low",
    title: "Claim is unsupported",
    rationale: "The frozen source does not contain support for the report wording.",
    suggestedRevision: "Qualify the claim.",
    location: { status: "anchored", anchor: { relativePath: "report.md", startOffset: 0, endOffset: 17, quote: "# Accepted report" }, diagnostic: "" },
    citation: { citationKey: "primary", usageId: null, sourceId, versionId },
    evidence: [{ sourceId, versionId, checksum: sourceChecksum, availability: "metadata-only", excerpt: null, relativePath: null, diagnostic: "Only metadata is available." }],
    createdAt: timestamp,
  };
}

function executorWithFinding(calls: Array<QualityExecutorInput>): QualityExecutor {
  return {
    async run(input) {
      calls.push(input);
      return { sessionId: `pi-session-${calls.length}`, durationMs: 9, claimsReviewed: 1, findings: [finding()] };
    },
  };
}

describe("QualityReviewService", () => {
  it("runs an independent attempt, persists findings, dispositions, and same-checkpoint retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-quality-"));
    const calls: QualityExecutorInput[] = [];
    const store = new MemoryQualityReviewStore();
    const comments = new CommentService(":memory:");
    try {
      const service = new QualityReviewService({ store, comments, executor: executorWithFinding(calls) });
      const started = await service.start({ projectId: "project-1", repositoryRoot: root, targetCheckpoint: checkpoint(), reviewerInstruction: instruction });
      const first = await service.wait(started.reviewId);
      expect(first.status).toBe("completed");
      expect(first.attempts).toHaveLength(1);
      expect(first.attempts[0]?.outcome).toBe("findings");
      expect(first.attempts[0]?.sessionId).toBe("pi-session-1");
      expect(first.attempts[0]?.progress.map((event) => event.type)).toEqual(expect.arrayContaining(["queued", "started", "checkpoint-verified", "finding-recorded", "completed"]));
      expect(first.findings).toHaveLength(1);
      expect(first.attempts[0]?.statistics.anchoredFindings).toBe(1);
      expect(calls[0]?.prompt).toContain("accepted checkpoint");
      expect(calls[0]?.prompt).toContain("qa-instruction-v1");

      const dispositioned = await service.appendDisposition({ reviewId: first.reviewId, findingId: first.findings[0]!.findingId, action: "accepted-risk", rationale: "Retain the wording for this release.", actorId: "reviewer" });
      expect(dispositioned.dispositions).toHaveLength(1);
      expect(dispositioned.findings[0]?.rationale).toContain("frozen source");

      const retried = await service.retry({ reviewId: first.reviewId, repositoryRoot: root });
      const second = await service.wait(retried.reviewId);
      expect(second.attempts).toHaveLength(2);
      expect(second.attempts[1]?.parentAttemptId).toBe(second.attempts[0]?.attemptId);
      expect(second.attempts[1]?.comparison).toMatchObject({ basis: "same-checkpoint", checkpointId: "checkpoint-accepted-1", unchangedCheckpoint: true });
      expect(second.dispositions).toHaveLength(1);
      expect(calls).toHaveLength(2);
    } finally {
      comments.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when reviewer evidence is not in the frozen source graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-quality-invalid-"));
    try {
      const service = new QualityReviewService({
        store: new MemoryQualityReviewStore(),
        executor: { run: async () => ({ findings: [{ ...finding(), evidence: [{ ...finding().evidence[0], sourceId: "src_ffffffffffffffff" }] }] }) },
      });
      const started = await service.start({ projectId: "project-1", repositoryRoot: root, targetCheckpoint: checkpoint(), reviewerInstruction: instruction });
      const review = await service.wait(started.reviewId);
      expect(review.status).toBe("failed");
      expect(review.findings).toHaveLength(0);
      expect(review.attempts[0]?.diagnostics?.code).toBe("QUALITY_INVALID_SOURCE_REFERENCE");
      expect(review.attempts[0]?.outcome).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes an anchored finding to a comment without changing the accepted report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-quality-promotion-"));
    const reportText = "# Accepted report\nThe claim is here.\n";
    await writeFile(path.join(root, "report.md"), reportText, "utf8");
    const comments = new CommentService(":memory:");
    try {
      const service = new QualityReviewService({ store: new MemoryQualityReviewStore(), comments, executor: executorWithFinding([]) });
      const started = await service.start({ projectId: "project-1", repositoryRoot: root, targetCheckpoint: checkpoint(reportText), reviewerInstruction: instruction });
      const review = await service.wait(started.reviewId);
      const promoted = await service.promote({ reviewId: review.reviewId, findingId: review.findings[0]!.findingId, repositoryRoot: root, target: "comment", actorId: "reviewer" });
      expect(promoted.promotions).toHaveLength(1);
      expect(promoted.promotions[0]?.target).toBe("comment");
      const comment = comments.get(promoted.promotions[0]!.targetId);
      expect(comment?.anchorStatus).toBe("anchored");
      expect(comment?.documentPath).toBe("report.md");
      expect(await import("node:fs/promises").then(({ readFile: read }) => read(path.join(root, "report.md"), "utf8"))).toBe(reportText);
    } finally {
      comments.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace a terminal attempt on a duplicate lifecycle transition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-quality-terminal-"));
    try {
      const service = new QualityReviewService({ store: new MemoryQualityReviewStore(), executor: executorWithFinding([]) });
      const review = await service.start({ projectId: "project-1", repositoryRoot: root, targetCheckpoint: checkpoint(), reviewerInstruction: instruction });
      await service.wait(review.reviewId);
      await expect(service.cancel(review.reviewId)).resolves.toMatchObject({ status: "completed" });
      await expect(service.retry({ reviewId: "missing-review", repositoryRoot: root })).rejects.toBeInstanceOf(QualityReviewError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
