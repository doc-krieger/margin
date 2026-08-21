import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";
import { LineageService } from "../../../apps/server/src/lineage/service.js";
import { MemoryLineageStore } from "../../../apps/server/src/lineage/store.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import { makeSourceRecord, type SourceRecord } from "../../../packages/shared/src/sources/contracts.js";
import type { CommentRecord } from "../../../packages/shared/src/comments/contracts.js";
import type { QualityReviewRecord } from "../../../packages/shared/src/quality/contracts.js";
import type { ResearchBrief, ResearchRunRecord } from "../../../packages/shared/src/research/contracts.js";
import type { RevisionRunRecord } from "../../../packages/shared/src/runs/contracts.js";
import type { ProposalRecord } from "../../../apps/server/src/proposals/store.js";

const projectId = "project-lineage";
const timestamp = "2026-08-14T12:00:00.000Z";
const sourceId = "src_aaaaaaaaaaaaaaaa";
const versionId = "ev_bbbbbbbbbbbbbbbb";
const checksum = "c".repeat(64);

function fixtures(): {
  briefs: ResearchBrief[];
  sources: SourceRecord[];
  researchRuns: ResearchRunRecord[];
  qualityReviews: QualityReviewRecord[];
  comments: CommentRecord[];
  revisionRuns: RevisionRunRecord[];
  proposals: ProposalRecord[];
} {
  const brief = {
    briefId: "brief-lineage",
    projectId,
    question: "Which evidence supports the report?",
    status: "confirmed",
    confirmedAt: timestamp,
    confirmedRevision: 1,
    revision: 1,
    updatedAt: timestamp,
  } as ResearchBrief;
  const source = makeSourceRecord({
    sourceId,
    kind: "url",
    identity: "https://example.test/source",
    evidenceState: "archived",
    latestVersionId: versionId,
    versions: [{ versionId, checksum, byteLength: 12, mediaType: "text/plain", capturedAt: timestamp, attemptId: "cap_cccccccccccccccc", originalRef: "source.txt" }],
    attempts: [{ attemptId: "cap_cccccccccccccccc", sourceId, origin: "ui", requestedIdentity: "https://example.test/source", status: "archived", requestedAt: timestamp, completedAt: timestamp, resultingVersionId: versionId }],
    lastAttemptId: "cap_cccccccccccccccc",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const researchRun = {
    runId: "research-lineage",
    recipe: "standard",
    status: "completed",
    createdAt: "2026-08-14T12:01:00.000Z",
    endedAt: "2026-08-14T12:04:00.000Z",
    lastEventAt: "2026-08-14T12:04:00.000Z",
    diagnostics: null,
    artifacts: [{ artifactId: "report-lineage", kind: "report", status: "complete", relativePath: "research/report.md", label: "Report", bytes: 12, sha256: checksum, createdAt: timestamp, updatedAt: timestamp }],
    synthesisAttempts: [{ attemptId: "synthesis-lineage", status: "completed", reportArtifactId: "report-lineage", createdAt: "2026-08-14T12:03:00.000Z", endedAt: "2026-08-14T12:03:30.000Z", diagnostics: null }],
    proposal: { proposalId: "proposal-research", status: "kept", decision: "keep", cleanup: { status: "completed", startedAt: timestamp, endedAt: timestamp, diagnostics: null }, createdAt: "2026-08-14T12:03:40.000Z", updatedAt: "2026-08-14T12:04:00.000Z", decidedAt: "2026-08-14T12:04:00.000Z" },
  } as unknown as ResearchRunRecord;
  const qualityReview = {
    reviewId: "quality-lineage",
    projectId,
    targetCheckpoint: { checkpointId: "checkpoint-lineage" },
    createdAt: "2026-08-14T12:05:00.000Z",
    updatedAt: "2026-08-14T12:08:00.000Z",
    attempts: [
      { attemptId: "qa-lineage", parentAttemptId: null, status: "completed", outcome: "findings", createdAt: "2026-08-14T12:05:30.000Z", diagnostics: null },
      { attemptId: "qa-follow-up", parentAttemptId: "qa-lineage", status: "completed", outcome: "pass", createdAt: "2026-08-14T12:09:00.000Z", diagnostics: null },
    ],
    findings: [{ findingId: "finding-lineage", attemptId: "qa-lineage", title: "Claim needs context", rationale: "The source is narrower than the claim.", severity: "medium", location: { status: "unanchored", anchor: null, diagnostic: "No safe report anchor" }, citation: { sourceId, versionId }, evidence: [] }],
    dispositions: [{ dispositionId: "disposition-lineage", findingId: "finding-lineage", action: "accepted-risk", rationale: "Keep visible for follow-up.", createdAt: "2026-08-14T12:07:00.000Z" }],
    promotions: [{ promotionId: "promotion-lineage", findingId: "finding-lineage", target: "comment", targetId: "comment-promoted", createdAt: "2026-08-14T12:07:30.000Z" }],
  } as unknown as QualityReviewRecord;
  const comment = { id: "comment-ordinary", projectId, documentPath: "research/report.md", scope: "document", runId: null, body: "Please clarify the limitation.", state: "open", createdAt: "2026-08-14T12:06:00.000Z", updatedAt: "2026-08-14T12:06:00.000Z" } as unknown as CommentRecord;
  const revisionRun = { runId: "revision-lineage", projectId, status: "completed", createdAt: "2026-08-14T12:10:00.000Z", startedAt: "2026-08-14T12:10:30.000Z", proposalId: "proposal-revision", checkpoint: { sha: "d".repeat(40) }, diagnostics: null } as unknown as RevisionRunRecord;
  const researchProposal = { proposalId: "proposal-research", runId: "research-lineage", repositoryRoot: "/fixture/project", checkpoint: { sha: "e".repeat(40), ref: "refs/margin/checkpoints/research-lineage", worktreePath: "/fixture/research-worktree" }, status: "kept", decision: "keep", diff: { files: [{ path: "research/report.md", status: "modified" }] }, cleanup: { status: "completed", startedAt: timestamp, endedAt: timestamp, diagnostics: null }, createdAt: "2026-08-14T12:03:40.000Z", updatedAt: "2026-08-14T12:04:00.000Z", decidedAt: "2026-08-14T12:04:00.000Z", errorCode: null, diagnostics: null } as unknown as ProposalRecord;
  const proposal = { proposalId: "proposal-revision", runId: "revision-lineage", repositoryRoot: "/fixture/project", checkpoint: { sha: "d".repeat(40), ref: "refs/margin/checkpoints/revision-lineage", worktreePath: "/fixture/worktree" }, status: "rejected", decision: "reject", diff: { files: [{ path: "research/report.md", status: "modified" }] }, cleanup: { status: "completed", startedAt: timestamp, endedAt: timestamp, diagnostics: null }, createdAt: "2026-08-14T12:11:00.000Z", updatedAt: "2026-08-14T12:12:00.000Z", decidedAt: "2026-08-14T12:12:00.000Z", errorCode: null, diagnostics: null } as unknown as ProposalRecord;
  return { briefs: [brief], sources: [source], researchRuns: [researchRun], qualityReviews: [qualityReview], comments: [comment], revisionRuns: [revisionRun], proposals: [researchProposal, proposal] };
}

describe("lineage projection", () => {
  it("joins canonical records into a deterministic cursor-paginated timeline", async () => {
    const service = new LineageService(new MemoryLineageStore(fixtures()), { clock: () => new Date("2026-08-14T12:20:00.000Z") });
    const first = await service.list(projectId, { limit: 4 });
    expect(first.entries).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    expect(first.freshness.status).toBe("fresh");

    const second = await service.list(projectId, { limit: 200, cursor: first.nextCursor! });
    const all = [...first.entries, ...second.entries];
    expect(new Set(all.map((item) => item.entryId)).size).toBe(all.length);
    expect(all.map((item) => item.occurredAt)).toEqual([...all.map((item) => item.occurredAt)].sort());
    expect(new Set(all.map((item) => item.kind))).toEqual(new Set([
      "brief.confirmed", "source.capture", "source.version", "research.run", "research.report", "research.decision",
      "checkpoint.created", "checkpoint.accepted", "qa.attempt", "qa.follow-up", "qa.finding", "qa.disposition",
      "qa.promotion", "comment.created", "revision.run", "proposal.created", "proposal.decision",
    ]));
    expect(all.find((item) => item.kind === "proposal.decision")?.detailTarget.type).toBe("decision");
    expect(all.find((item) => item.kind === "source.version")?.detailTarget.type).toBe("source-version");
  });

  it("exposes the projection through the default app route without duplicating domain records", async () => {
    const projects = new ProjectLifecycleService();
    projects.registry.registerProject({ id: projectId, name: "Fixture", path: "/fixture/project", rootPath: "/fixture", manifestPath: "/fixture/project/margin.yaml", gitInitialized: false, markdownFiles: [], files: [], openedAt: timestamp });
    const store = new MemoryLineageStore(fixtures());
    const app = buildApp({ projectService: projects, lineageStore: store });
    try {
      const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/lineage?limit=2` });
      expect(response.statusCode).toBe(200);
      expect(response.json().entries).toHaveLength(2);
      expect(response.json().freshness.revision).toMatch(/^[a-f0-9]{64}$/);
      const invalid = await app.inject({ method: "GET", url: `/api/projects/${projectId}/lineage?cursor=not-a-cursor` });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
