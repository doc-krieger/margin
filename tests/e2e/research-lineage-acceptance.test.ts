import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.js";
import { CommentService } from "../../apps/server/src/comments/repository.js";
import { defaultPiProfileManifest } from "../../apps/server/src/pi/manifest.js";
import { ProposalService, MemoryProposalAuditStore, MemoryProposalStore } from "../../apps/server/src/proposals/index.js";
import { ProjectLifecycleService } from "../../apps/server/src/projects/service.js";
import { ResearchRunService, type ResearchExecutor } from "../../apps/server/src/research/index.js";
import { RevisionRunService, type PiExecutor } from "../../apps/server/src/runs/service.js";
import { SourceServiceRegistry } from "../../apps/server/src/sources/projection.js";
import { QualityReviewService, type QualityExecutor } from "../../apps/server/src/quality/index.js";
import { MemoryQualityReviewStore } from "../../apps/server/src/quality/store.js";
import { runCommand } from "../../apps/server/src/process/command.js";
import type { QualityAcceptedCheckpoint } from "@margin/shared";

const temporaryRoots: string[] = [];

async function git(root: string, args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", root, ...args]);
  if (result.exitCode !== 0 || result.spawnError) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.spawnError || "unknown error"}`);
  }
  return result.stdout.trim();
}

async function request<T>(app: Awaited<ReturnType<typeof buildApp>>, method: "GET" | "POST", url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, payload });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} returned ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a terminal acceptance record");
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function makeFixture(): Promise<{ root: string; projectPath: string; projectId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "margin-lineage-acceptance-"));
  temporaryRoots.push(root);
  const projectPath = path.join(root, "research-project");
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, "source.md"), "# Evidence\n\nMargin preserves exact source versions for review.\n", "utf8");
  await git(projectPath, ["init"]);
  await git(projectPath, ["config", "user.email", "acceptance@margin.test"]);
  await git(projectPath, ["config", "user.name", "Margin Acceptance"]);

  const projects = new ProjectLifecycleService();
  await projects.registerRoot(root);
  const opened = await projects.openProject(projectPath, { gitDecision: "continue-without-git" });
  await git(projectPath, ["add", "-A"]);
  await git(projectPath, ["commit", "-m", "fixture baseline"]);
  return { root, projectPath, projectId: opened.project.id };
}

afterEach(async () => {
  while (temporaryRoots.length > 0) await rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("research lineage complete journey", () => {
  it("proves source capture, cited report review, isolated revision, restart reconstruction, and final truth", async () => {
    const fixture = await makeFixture();
    const projects = new ProjectLifecycleService();
    await projects.registerRoot(fixture.root);
    const opened = await projects.openProject(fixture.projectPath, { gitDecision: "continue-without-git" });
    expect(opened.project.id).toBe(fixture.projectId);

    const sourceRegistry = new SourceServiceRegistry();
    const comments = new CommentService(path.join(fixture.root, "comments.sqlite"));
    const proposals = new ProposalService({
      store: new MemoryProposalStore(),
      auditStore: new MemoryProposalAuditStore(),
    });
    const profile = { id: "deterministic", label: "Deterministic acceptance executor", status: "available" as const, manifest: defaultPiProfileManifest() };
    const researchExecutor: ResearchExecutor = {
      async run(input) {
        const source = selectedSource!;
        const citationKey = `src-${source.sourceId.slice(4)}-ev-${source.versionId.slice(3)}`;
        await input.emit("research.progress", { sessionId: "deterministic-research", message: "Fixture evidence reviewed" });
        return {
          sessionId: "deterministic-research",
          durationMs: 1,
          report: `# Decision memo\n\nThe evidence is durable [@${citationKey}].\n`,
          notes: "The deterministic executor inspected the frozen source projection.",
        };
      },
    };
    const sourceProjector = {
      project: ({ canonicalRoot, worktreePath, selections, runId }: { canonicalRoot: string; worktreePath: string; selections: Array<{ sourceId: string; versionId: string; required: boolean }>; runId?: string }) =>
        sourceRegistry.forProject(canonicalRoot).projection.project({ worktreePath, selections, runId }),
    };
    const research = new ResearchRunService({
      profiles: [profile],
      executor: researchExecutor,
      sourceProjector,
      proposalService: proposals,
      dataDirectory: path.join(fixture.root, "research-data"),
    });

    let qualityAttempt = 0;
    const qualityExecutor: QualityExecutor = {
      async run(input) {
        qualityAttempt += 1;
        await input.emit("claim-reviewed", { message: `Reviewed checkpoint attempt ${qualityAttempt}`, percent: 75 });
        if (qualityAttempt > 1) return { sessionId: `quality-${qualityAttempt}`, claimsReviewed: 1, outcome: "pass" as const, durationMs: 1 };
        const quote = "# Decision memo";
        return {
          sessionId: "quality-1",
          claimsReviewed: 1,
          outcome: "findings" as const,
          durationMs: 1,
          findings: [{
            findingId: "finding-unsupported-claim",
            kind: "unsupported-claim",
            severity: "medium",
            uncertainty: "low",
            title: "Add a qualifier to the conclusion",
            rationale: "The conclusion should make the bounded evidence scope explicit.",
            suggestedRevision: "Add a sentence describing the evidence boundary.",
            location: { status: "anchored", anchor: { relativePath: input.checkpoint.reportPath, startOffset: 0, endOffset: quote.length, line: 1, column: 1, endLine: 1, endColumn: quote.length + 1, quote }, diagnostic: "" },
            citation: { citationKey: input.checkpoint.sourceGraph.sourceBindings[0]!.citationKeys[0]!, usageId: null, sourceId: input.checkpoint.sourceGraph.sourceBindings[0]!.sourceId, versionId: input.checkpoint.sourceGraph.sourceBindings[0]!.versionId },
            evidence: [{ sourceId: input.checkpoint.sourceGraph.sourceBindings[0]!.sourceId, versionId: input.checkpoint.sourceGraph.sourceBindings[0]!.versionId, checksum: input.checkpoint.sourceGraph.sourceBindings[0]!.evidenceChecksum!, availability: "full-text", excerpt: "Margin preserves exact source versions for review.", relativePath: "source.md", line: 3, endLine: 3, diagnostic: "" }],
          }],
        };
      },
    };
    const quality = new QualityReviewService({
      store: new MemoryQualityReviewStore(),
      comments,
      profiles: [profile],
      executor: qualityExecutor,
    });
    const piExecutor: PiExecutor = {
      async run(_manifest, input) {
        const reportPath = path.join(input.cwd, "reports", "accepted.md");
        const report = await readFile(reportPath, "utf8");
        await writeFile(reportPath, `${report}\n\n## Revision note\n\nFeedback was incorporated in an isolated proposal.\n`, "utf8");
        return { runId: input.runId, correlationId: input.correlationId, exitCode: 0, events: [], durationMs: 1 };
      },
    };
    const revision = new RevisionRunService({
      profiles: [profile],
      piExecutor,
      proposalService: proposals,
      dataDirectory: path.join(fixture.root, "revision-data"),
    });
    const app = buildApp({
      projectService: projects,
      sourceRegistry,
      commentService: comments,
      proposalService: proposals,
      researchService: research,
      qualityService: quality,
      runService: revision,
      qualityReviewRoot: path.join(fixture.root, "quality-data"),
      lineageFactRoot: path.join(fixture.root, "lineage-facts"),
    });

    let selectedSource: { sourceId: string; versionId: string } | undefined;
    try {
      const captured = await request<{ capture: { sourceId: string; version?: { versionId: string; checksum: string }; status: string } }>(app, "POST", `/api/projects/${fixture.projectId}/sources/capture`, { kind: "file", value: "source.md" });
      expect(captured.capture.status).toBe("archived");
      expect(captured.capture.version?.versionId).toMatch(/^ev_[a-f0-9]{16,64}$/);
      selectedSource = { sourceId: captured.capture.sourceId, versionId: captured.capture.version!.versionId };
      // Source capture is durable project state. Commit that immutable evidence
      // boundary before the research checkpoint asserts canonical cleanliness.
      await git(fixture.projectPath, ["add", "sources"]);
      await git(fixture.projectPath, ["commit", "-m", "archive source evidence"]);

      const brief = await request<{ brief: { briefId: string; status: string } }>(app, "POST", `/api/projects/${fixture.projectId}/research/briefs`, {
        briefId: "brief-lineage-journey",
        question: "How does Margin preserve research evidence through revision?",
        scope: "Trace one cited report from source capture to final checkpoint.",
        audience: "Reviewers",
        recipe: "quick",
        depth: "quick",
        outputMode: "research-and-report",
        outputPaths: { reportPath: "reports/accepted.md", notesPath: "research/notes.md", manifestPath: "research/sources.yaml" },
        status: "confirmed",
        confirmedRevision: 1,
        confirmedAt: timestamp(),
      });
      expect(brief.brief.status).toBe("confirmed");

      const started = await request<{ run: { runId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/research/runs`, {
        briefId: brief.brief.briefId,
        profileId: profile.id,
        sourceSelections: [{ sourceId: selectedSource.sourceId, versionId: selectedSource.versionId, required: true }],
      });
      const researchRun = await eventually(() => research.get(started.run.runId), (record) => ["completed", "failed", "partial", "cancelled"].includes(record.status));
      expect(researchRun.status).toBe("completed");
      expect(researchRun.frozenSourceBindings).toHaveLength(1);
      expect(researchRun.synthesisAttempts.at(-1)?.citationValidation?.status).toBe("valid");
      expect(researchRun.proposal?.status).toBe("pending");
      const proposalId = researchRun.proposal!.proposalId;

      const kept = await request<{ review: { proposal: { status: string; decision: string } } }>(app, "POST", `/api/projects/${fixture.projectId}/proposals/${proposalId}/decision`, { decision: "keep" });
      expect(kept.review.proposal.status).toBe("kept");
      expect(kept.review.proposal.decision).toBe("keep");
      expect(await readFile(path.join(fixture.projectPath, "reports", "accepted.md"), "utf8")).toContain("Decision memo");
      // A kept research proposal becomes the accepted report checkpoint. Commit
      // that checkpoint before another isolated run asserts canonical cleanliness.
      await git(fixture.projectPath, ["add", "reports", "research"]);
      await git(fixture.projectPath, ["commit", "-m", "accept cited research checkpoint"]);

      const reportText = await readFile(path.join(fixture.projectPath, "reports", "accepted.md"), "utf8");
      const reportArtifact = researchRun.artifacts.find((artifact) => artifact.kind === "report")!;
      const binding = researchRun.frozenSourceBindings[0]!;
      const checkpoint: QualityAcceptedCheckpoint = {
        checkpointId: `checkpoint-${researchRun.runId}`,
        reportArtifactId: reportArtifact.artifactId,
        reportPath: reportArtifact.relativePath,
        reportSha256: sha256(reportText),
        sourceGraph: {
          graphId: `source-graph-${researchRun.runId}`,
          sourceBindings: [{ sourceId: binding.sourceId, versionId: binding.versionId, checksum: binding.checksum, required: binding.required, citationKeys: [binding.citationKey!], evidenceAvailability: "full-text", evidenceChecksum: binding.checksum }],
          graphChecksum: null,
          capturedAt: timestamp(),
        },
        citationValidationHash: sha256(JSON.stringify(researchRun.synthesisAttempts.at(-1)?.citationValidation)),
        acceptedAt: timestamp(),
        acceptedBy: "acceptance-reviewer",
      };

      const instructionText = "Check claim support and preserve exact source/version lineage.";
      const firstReview = await request<{ review: { reviewId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/quality-reviews`, {
        targetCheckpoint: checkpoint,
        reviewerInstruction: { instructionId: "instruction-lineage", text: instructionText, sha256: sha256(instructionText), createdAt: timestamp() },
        profileId: profile.id,
      });
      const firstQuality = await quality.wait(firstReview.review.reviewId);
      expect(firstQuality.status).toBe("completed");
      expect(firstQuality.findings).toHaveLength(1);
      const findingId = firstQuality.findings[0]!.findingId;

      const promoted = await request<{ promotion: { commentId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/quality-reviews/${firstReview.review.reviewId}/findings/${findingId}/promotions`, {
        repositoryRoot: fixture.projectPath,
        target: "comment",
        actorId: "acceptance-reviewer",
        body: "Please carry this bounded-evidence qualification into the revision.",
      });
      expect(promoted.promotion.commentId).toBeTruthy();
      const disposition = await request<{ review: { dispositions: Array<{ action: string }> } }>(app, "POST", `/api/projects/${fixture.projectId}/quality-reviews/${firstReview.review.reviewId}/findings/${findingId}/dispositions`, {
        action: "false-positive",
        rationale: "The follow-up revision will make the evidence boundary explicit.",
        actorId: "acceptance-reviewer",
      });
      expect(disposition.review.dispositions.at(-1)?.action).toBe("false-positive");

      const commentsPage = await request<{ comments: Array<{ id: string }> }>(app, "GET", `/api/projects/${fixture.projectId}/comments`);
      expect(commentsPage.comments.some((comment) => comment.id === promoted.promotion.commentId)).toBe(true);
      const revisionStarted = await request<{ run: { runId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/runs`, {
        profileId: profile.id,
        selectedCommentIds: [promoted.promotion.commentId],
        comments: commentsPage.comments,
        guidance: "Incorporate the selected review feedback without changing unrelated files.",
      });
      const revisionRun = await revision.waitForCompletion(revisionStarted.run.runId);
      expect(revisionRun.status).toBe("completed");
      expect(revisionRun.changedFiles.some((file) => file.path === "reports/accepted.md")).toBe(true);
      const revisionProposalId = revisionRun.proposalId!;
      const revisionDecision = await request<{ review: { proposal: { status: string; decision: string } } }>(app, "POST", `/api/projects/${fixture.projectId}/proposals/${revisionProposalId}/decision`, { decision: "keep" });
      expect(revisionDecision.review.proposal.status).toBe("kept");
      expect(await readFile(path.join(fixture.projectPath, "reports", "accepted.md"), "utf8")).toContain("Revision note");
      await git(fixture.projectPath, ["add", "reports"]);
      await git(fixture.projectPath, ["commit", "-m", "accept revised research checkpoint"]);

      const retry = await request<{ review: { reviewId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/quality-reviews/${firstReview.review.reviewId}/retry`, { profileId: profile.id });
      expect(retry.review.reviewId).toBe(firstReview.review.reviewId);
      const followUpQuality = await quality.wait(firstReview.review.reviewId);
      expect(followUpQuality.attempts).toHaveLength(2);
      expect(followUpQuality.attempts[1]!.comparison?.unchangedCheckpoint).toBe(true);
      expect(followUpQuality.attempts[1]!.outcome).toBe("pass");
      expect(followUpQuality.findings[0]!.title).toBe("Add a qualifier to the conclusion");

      // The revised report is a new accepted checkpoint. A new immutable QA
      // review is required; retrying the old review remains bound to its old
      // checkpoint and is retained above as comparison evidence.
      const revisedReport = await readFile(path.join(fixture.projectPath, "reports", "accepted.md"), "utf8");
      const revisedCheckpoint: QualityAcceptedCheckpoint = {
        ...checkpoint,
        checkpointId: revisionRun.checkpoint!.sha,
        reportArtifactId: `report-revised-${revisionRun.runId}`,
        reportSha256: sha256(revisedReport),
        acceptedAt: timestamp(),
      };
      const finalReview = await request<{ review: { reviewId: string } }>(app, "POST", `/api/projects/${fixture.projectId}/quality-reviews`, {
        targetCheckpoint: revisedCheckpoint,
        reviewerInstruction: { instructionId: "instruction-final-lineage", text: instructionText, sha256: sha256(instructionText), createdAt: timestamp() },
        profileId: profile.id,
      });
      const finalQuality = await quality.wait(finalReview.review.reviewId);
      expect(finalQuality.attempts[0]!.outcome).toBe("pass");
      expect(finalQuality.findings).toHaveLength(0);
      const finalAttemptId = finalQuality.attempts[0]!.attemptId;
      const acknowledgment = await request<{ acknowledgmentId: string }>(app, "POST", `/api/projects/${fixture.projectId}/lineage/checkpoint-review-acknowledgments`, {
        checkpointId: revisedCheckpoint.checkpointId,
        qaAttemptId: finalAttemptId,
        actorId: "acceptance-reviewer",
      });
      expect(acknowledgment.acknowledgmentId).toMatch(/^review-ack-/);

      const lineage = await request<{ entries: Array<{ kind: string; target: unknown; detailTarget: unknown }> }>(app, "GET", `/api/projects/${fixture.projectId}/lineage?limit=100`);
      const kinds = new Set(lineage.entries.map((entry) => entry.kind));
      expect(kinds.has("research.run")).toBe(true);
      expect(kinds.has("source.capture")).toBe(true);
      expect(kinds.has("qa.attempt")).toBe(true);
      expect(kinds.has("revision.run")).toBe(true);
      expect(kinds.has("proposal.decision")).toBe(true);
      expect(lineage.entries.every((entry) => entry.target !== undefined && entry.detailTarget !== undefined)).toBe(true);

      const finalSummary = await request<{ schemaVersion: number; projectId: string; checkpointId: string | null; reportTarget: { path?: string } | null; latestQaOutcome: string | null; remainingRiskCounts: { open: number; accepted: number }; reviewAcknowledged: boolean; proposalDecision: string | null; generatedAt: string }>(app, "GET", `/api/projects/${fixture.projectId}/lineage/final-checkpoint-summary`);
      expect(finalSummary.checkpointId).toBe(revisedCheckpoint.checkpointId);
      expect(finalSummary.reportTarget?.path).toBe("reports/accepted.md");
      expect(finalSummary.latestQaOutcome).toBe("pass");
      expect(finalSummary.remainingRiskCounts.open).toBe(0);
      expect(finalSummary.reviewAcknowledged).toBe(true);
      expect(finalSummary.proposalDecision).toBe("keep");

      // Reconstruct the same read-only projections from the durable stores. No local
      // UI state or in-flight executor is consulted after this simulated restart.
      await app.close();
      const restoredApp = buildApp({
        projectService: projects,
        sourceRegistry,
        commentService: comments,
        proposalService: proposals,
        researchService: research,
        qualityService: quality,
        runService: revision,
        qualityReviewRoot: path.join(fixture.root, "quality-data"),
        lineageFactRoot: path.join(fixture.root, "lineage-facts"),
      });
      const restoredSummary = await request<typeof finalSummary>(restoredApp, "GET", `/api/projects/${fixture.projectId}/lineage/final-summary`);
      const { generatedAt: _restoredGeneratedAt, ...restoredDurableSummary } = restoredSummary;
      const { generatedAt: _firstGeneratedAt, ...firstDurableSummary } = finalSummary;
      expect(restoredDurableSummary).toEqual(firstDurableSummary);
      const restoredLineage = await request<{ entries: Array<{ kind: string }> }>(restoredApp, "GET", `/api/projects/${fixture.projectId}/lineage?limit=100`);
      expect(restoredLineage.entries.length).toBe(lineage.entries.length);
      await restoredApp.close();
    } finally {
      if (app.server.listening) await app.close();
      comments.close();
    }
  });
});

let selectedSource: { sourceId: string; versionId: string } | undefined;
