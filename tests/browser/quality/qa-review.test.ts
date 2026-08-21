import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QualityReviewRecord, ResearchRunRecord } from "@margin/shared";
import { QualityApiClient } from "../../../apps/web/src/quality/api.js";
import { QualityReviewPanel, acceptedCheckpointFromRun } from "../../../apps/web/src/quality/qa-panel.js";

const checkpoint = {
  checkpointId: "run-qa-1",
  reportArtifactId: "report-qa-1",
  reportPath: "reports/accepted.md",
  reportSha256: "a".repeat(64),
  sourceGraph: {
    graphId: "run-qa-1-sources",
    sourceBindings: [{
      sourceId: "src_0123456789abcdef",
      versionId: "ev_0123456789abcdef",
      checksum: "b".repeat(64),
      required: true,
      citationKeys: ["source-one"],
      evidenceAvailability: "full-text" as const,
      evidenceChecksum: "c".repeat(64),
    }],
    graphChecksum: null,
    capturedAt: "2026-08-14T10:00:00.000Z",
  },
  citationValidationHash: null,
  acceptedAt: "2026-08-14T10:00:00.000Z",
  acceptedBy: "user",
};

const attempt = {
  attemptId: "attempt-qa-1",
  parentAttemptId: null,
  sessionId: "session-qa-1",
  correlationId: "00000000-0000-4000-8000-000000000001",
  reviewerInstructionId: "instruction-qa-1",
  status: "completed" as const,
  outcome: "findings" as const,
  progress: [],
  statistics: {
    claimsReviewed: 4,
    findingsProduced: 2,
    anchoredFindings: 1,
    unanchoredFindings: 1,
    unresolvedCitations: 1,
    sourceCount: 1,
    evidenceCount: 1,
    eventCount: 0,
  },
  findingIds: ["finding-unsupported", "finding-unresolved"],
  comparison: null,
  cancellation: { requestedAt: null, reason: null, settledAt: null },
  diagnostics: null,
  processExit: null,
  createdAt: "2026-08-14T10:00:00.000Z",
  startedAt: "2026-08-14T10:00:01.000Z",
  endedAt: "2026-08-14T10:00:05.000Z",
  lastProgressAt: "2026-08-14T10:00:05.000Z",
};

const review = {
  schemaVersion: 1,
  reviewId: "review-qa-1",
  projectId: "project-1",
  correlationId: "00000000-0000-4000-8000-000000000002",
  targetCheckpoint: checkpoint,
  reviewerInstruction: { instructionId: "instruction-qa-1", text: "Review the checkpoint", sha256: "d".repeat(64), createdAt: "2026-08-14T10:00:00.000Z" },
  status: "completed" as const,
  attempts: [attempt],
  latestAttemptId: attempt.attemptId,
  findings: [
    {
      findingId: "finding-unsupported",
      attemptId: attempt.attemptId,
      kind: "unsupported-claim" as const,
      severity: "high" as const,
      uncertainty: "low" as const,
      title: "Claim lacks support",
      rationale: "The report claims an outcome that the frozen evidence does not establish.",
      suggestedRevision: "Qualify the claim.",
      location: { status: "anchored" as const, anchor: { relativePath: "reports/accepted.md", startOffset: 10, endOffset: 30, line: 2, column: 1, endLine: 2, endColumn: 21, quote: "unsupported claim" }, diagnostic: "" },
      citation: { citationKey: "source-one", usageId: "usage-1", sourceId: "src_0123456789abcdef", versionId: "ev_0123456789abcdef" },
      evidence: [{ sourceId: "src_0123456789abcdef", versionId: "ev_0123456789abcdef", checksum: "c".repeat(64), availability: "full-text" as const, excerpt: "Frozen evidence excerpt", relativePath: "sources/source-one.txt", line: 4, endLine: 4, diagnostic: "" }],
      createdAt: "2026-08-14T10:00:04.000Z",
    },
    {
      findingId: "finding-unresolved",
      attemptId: attempt.attemptId,
      kind: "unresolved-citation" as const,
      severity: "medium" as const,
      uncertainty: "high" as const,
      title: "Citation cannot be resolved",
      rationale: "No exact frozen source version is available for this citation.",
      suggestedRevision: null,
      location: { status: "unanchored" as const, anchor: null, diagnostic: "Citation location was not safely anchored." },
      citation: null,
      evidence: [],
      createdAt: "2026-08-14T10:00:04.000Z",
    },
  ],
  dispositions: [],
  promotions: [],
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T10:00:05.000Z",
} as QualityReviewRecord;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("independent QA review browser contract", () => {
  it("keeps quality lifecycle actions on the project-scoped API boundary", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/quality-reviews")) return response({ reviews: [review] });
      return response({ review });
    });
    const api = new QualityApiClient({ baseUrl: "/api", fetcher: fetcher as unknown as typeof fetch });

    await api.listReviews("project 1");
    await api.startReview("project 1", { targetCheckpoint: checkpoint, reviewerInstruction: review.reviewerInstruction });
    await api.retryReview("project 1", review.reviewId);
    await api.cancelReview("project 1", review.reviewId, { reason: "network lost" });
    await api.appendDisposition("project 1", review.reviewId, "finding-unsupported", { action: "accepted-risk", rationale: "Human accepted the limitation." });
    await api.promoteFinding("project 1", review.reviewId, "finding-unsupported", { target: "comment", body: "Qualify this claim." });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/projects/project%201/quality-reviews",
      "/api/projects/project%201/quality-reviews",
      "/api/projects/project%201/quality-reviews/review-qa-1/retry",
      "/api/projects/project%201/quality-reviews/review-qa-1/cancel",
      "/api/projects/project%201/quality-reviews/review-qa-1/findings/finding-unsupported/dispositions",
      "/api/projects/project%201/quality-reviews/review-qa-1/findings/finding-unsupported/promotions",
    ]);
    expect(JSON.parse(String(calls[4]?.init?.body))).toMatchObject({ action: "accepted-risk" });
    expect(JSON.parse(String(calls[5]?.init?.body))).toMatchObject({ target: "comment" });
  });

  it("renders findings, safe evidence, attempt history, and degraded-anchor messaging", () => {
    const html = renderToStaticMarkup(createElement(QualityReviewPanel, { projectId: "project-1", initialReview: review }));

    expect(html).toContain("Claim-level QA");
    expect(html).toContain("Review completed with findings requiring disposition");
    expect(html).toContain("Attempt history (1)");
    expect(html).toContain("Claim lacks support");
    expect(html).toContain("Frozen evidence excerpt");
    expect(html).toContain("Unanchored — inspect manually");
    expect(html).toContain("Promotion unavailable without a safe report anchor");
    expect(html).toContain("Accept risk");
  });

  it("does not infer a checkpoint when the report artifact is incomplete", () => {
    const run = {
      runId: "run-qa-2",
      createdAt: "2026-08-14T10:00:00.000Z",
      endedAt: "2026-08-14T10:01:00.000Z",
      latestSynthesisAttemptId: "synthesis-qa-2",
      synthesisAttempts: [{ attemptId: "synthesis-qa-2", reportArtifactId: "report-qa-2" }],
      artifacts: [{ artifactId: "report-qa-2", kind: "report", status: "partial", relativePath: "reports/partial.md", sha256: null }],
      frozenSourceBindings: [],
      sourceProjection: null,
      proposal: null,
    } as unknown as ResearchRunRecord;

    expect(acceptedCheckpointFromRun(run)).toBeUndefined();
    const html = renderToStaticMarkup(createElement(QualityReviewPanel, { projectId: "project-1", run }));
    expect(html).toContain("complete report artifact with a frozen source graph");
    expect(html).not.toContain("Review passed");
  });
});
