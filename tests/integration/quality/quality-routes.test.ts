import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualityAcceptedCheckpointSchema } from "../../../packages/shared/src/quality/contracts.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { CommentService } from "../../../apps/server/src/comments/repository.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import { MemoryQualityReviewStore } from "../../../apps/server/src/quality/store.js";
import { QualityReviewService } from "../../../apps/server/src/quality/service.js";

const timestamp = "2026-08-14T12:00:00.000Z";
const sourceId = "src_aaaaaaaaaaaaaaaa";
const versionId = "ev_bbbbbbbbbbbbbbbb";
const sourceChecksum = "c".repeat(64);
const report = "# Report\n";

function checkpoint() {
  return qualityAcceptedCheckpointSchema.parse({
    checkpointId: "checkpoint-route-1",
    reportArtifactId: "report-route-1",
    reportPath: "report.md",
    reportSha256: createHash("sha256").update(report).digest("hex"),
    sourceGraph: { graphId: "graph-route-1", sourceBindings: [{ sourceId, versionId, checksum: sourceChecksum, required: true, citationKeys: ["primary"], evidenceAvailability: "metadata-only", evidenceChecksum: null }], graphChecksum: null, capturedAt: timestamp },
    citationValidationHash: null,
    acceptedAt: timestamp,
    acceptedBy: "researcher",
  });
}

describe("quality review routes", () => {
  it("starts, reconnects, retries, and streams an independent review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-quality-routes-"));
    const projects = new ProjectLifecycleService();
    projects.registry.registerProject({ id: "project-1", name: "Fixture", path: root, rootPath: root, manifestPath: path.join(root, "margin.yaml"), gitInitialized: false, markdownFiles: [], files: [], openedAt: timestamp });
    const comments = new CommentService(":memory:");
    const quality = new QualityReviewService({ store: new MemoryQualityReviewStore(), comments, executor: { run: async () => ({ sessionId: "route-session", claimsReviewed: 2 }) } });
    const app = buildApp({ projectService: projects, commentService: comments, qualityService: quality });
    try {
      const start = await app.inject({ method: "POST", url: "/api/projects/project-1/quality-reviews", payload: { targetCheckpoint: checkpoint(), reviewerInstruction: { instructionId: "route-instruction", text: "Review the accepted report.", sha256: "d".repeat(64), createdAt: timestamp } } });
      expect(start.statusCode).toBe(202);
      const reviewId = start.json().reviewId as string;
      const settled = await quality.wait(reviewId);
      expect(settled.status).toBe("completed");

      const get = await app.inject({ method: "GET", url: `/api/projects/project-1/quality-reviews/${reviewId}` });
      expect(get.statusCode).toBe(200);
      expect(get.json().review.latestAttemptId).toBe(settled.latestAttemptId);

      const events = await app.inject({ method: "GET", url: `/api/projects/project-1/quality-reviews/${reviewId}/events` });
      expect(events.statusCode).toBe(200);
      expect(events.headers["content-type"]).toContain("text/event-stream");
      expect(events.body).toContain("event: completed");

      const retry = await app.inject({ method: "POST", url: `/api/projects/project-1/quality-reviews/${reviewId}/retry`, payload: {} });
      expect(retry.statusCode).toBe(202);
      await quality.wait(reviewId);
      const list = await app.inject({ method: "GET", url: "/api/projects/project-1/quality-reviews" });
      expect(list.statusCode).toBe(200);
      expect(list.json().reviews[0].attempts).toHaveLength(2);

      const missingProject = await app.inject({ method: "GET", url: "/api/projects/missing/quality-reviews" });
      expect(missingProject.statusCode).toBe(404);
    } finally {
      await app.close();
      comments.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
