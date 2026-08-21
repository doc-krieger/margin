import { describe, expect, it } from "vitest";
import { LineageService } from "../../../apps/server/src/lineage/service.js";
import { MemoryLineageStore } from "../../../apps/server/src/lineage/store.js";
import type { ProposalRecord } from "../../../apps/server/src/proposals/store.js";
import type { ResearchRunRecord } from "../../../packages/shared/src/research/contracts.js";
import type { RevisionRunRecord } from "../../../packages/shared/src/runs/contracts.js";

const projectId = "project-restart";
const createdAt = "2026-08-14T13:00:00.000Z";

function pendingProposal(): ProposalRecord {
  return {
    proposalId: "proposal-pending",
    runId: "revision-interrupted",
    repositoryRoot: "/fixture/project",
    checkpoint: {
      sha: "a".repeat(40),
      ref: "refs/margin/checkpoints/revision-interrupted",
      worktreePath: "/fixture/worktree",
    },
    status: "pending",
    decision: null,
    diff: { files: [{ path: "research/report.md", status: "modified" }], patch: "diff --git" },
    cleanup: { status: "pending", startedAt: null, endedAt: null, diagnostics: null },
    createdAt: "2026-08-14T13:02:00.000Z",
    updatedAt: "2026-08-14T13:02:00.000Z",
    decidedAt: null,
    errorCode: null,
    diagnostics: null,
  };
}

function activeRuns(): { researchRuns: ResearchRunRecord[]; revisionRuns: RevisionRunRecord[] } {
  const researchRun = {
    runId: "research-interrupted",
    recipe: "standard",
    status: "running",
    createdAt,
    endedAt: null,
    lastEventAt: "2026-08-14T13:01:00.000Z",
    diagnostics: null,
    artifacts: [{ artifactId: "partial-report", kind: "report", status: "partial", relativePath: "research/report.md", label: "Partial report", bytes: 10, sha256: "b".repeat(64), createdAt, updatedAt: createdAt }],
    synthesisAttempts: [{ attemptId: "synthesis-partial", status: "running", reportArtifactId: "partial-report", createdAt: "2026-08-14T13:01:00.000Z", endedAt: null, diagnostics: null }],
    proposal: null,
  } as unknown as ResearchRunRecord;
  const revisionRun = {
    runId: "revision-interrupted",
    projectId,
    status: "running",
    createdAt: "2026-08-14T13:01:30.000Z",
    startedAt: "2026-08-14T13:01:40.000Z",
    endedAt: null,
    checkpoint: { sha: "c".repeat(40), ref: "refs/margin/checkpoints/revision-interrupted", worktreePath: "/fixture/worktree" },
    proposalId: "proposal-pending",
    diagnostics: null,
  } as unknown as RevisionRunRecord;
  return { researchRuns: [researchRun], revisionRuns: [revisionRun] };
}

describe("lineage restart reconstruction", () => {
  it("marks persisted active work interrupted without mutating records or applying pending decisions", async () => {
    const runs = activeRuns();
    const store = new MemoryLineageStore({ ...runs, proposals: [pendingProposal()] });
    const service = new LineageService(store, { clock: () => new Date("2026-08-14T13:05:00.000Z") });
    const result = await service.reconstructWorkspace(projectId, {
      projectId,
      checkpointId: null,
      selectedEntryId: "missing-entry",
      activePanel: "proposal",
      pendingProposalId: "proposal-pending",
      updatedAt: "2026-08-14T13:04:00.000Z",
    });

    expect(result.processRunning).toBe(false);
    expect(result.decisionApplied).toBe(false);
    expect(result.pendingProposalId).toBe("proposal-pending");
    expect(result.interruptedRuns).toHaveLength(2);
    expect(result.interruptedRuns.map((run) => run.kind)).toEqual(expect.arrayContaining(["research", "revision"]));
    expect(result.interruptedRuns.find((run) => run.runId === "research-interrupted")?.preservedArtifactEntryIds).toContain("research.report:partial-report");
    expect(result.interruptedRuns.find((run) => run.runId === "revision-interrupted")?.preservedArtifactEntryIds).toContain(`checkpoint.created:${"c".repeat(40)}`);
    expect(result.page.entries.filter((entry) => entry.kind === "workspace.restored")).toHaveLength(2);
    expect(result.page.entries.find((entry) => entry.kind === "workspace.restored" && entry.runId === "research-interrupted")?.diagnostic?.code).toBe("WORKSPACE_RECONNECT_REQUIRED");

    const snapshot = await store.snapshot(projectId);
    expect(snapshot.researchRuns[0]?.status).toBe("running");
    expect(snapshot.revisionRuns[0]?.status).toBe("running");
    expect(snapshot.proposals[0]?.decision).toBeNull();
  });

  it("does not emit interruption notices for terminal runs", async () => {
    const store = new MemoryLineageStore({
      researchRuns: [{ runId: "research-done", recipe: "standard", status: "completed", createdAt, endedAt: createdAt, lastEventAt: createdAt, diagnostics: null, artifacts: [], synthesisAttempts: [], proposal: null } as unknown as ResearchRunRecord],
      revisionRuns: [{ runId: "revision-done", projectId, status: "completed", createdAt, startedAt: createdAt, endedAt: createdAt, checkpoint: null, proposalId: null, diagnostics: null } as unknown as RevisionRunRecord],
    });
    const service = new LineageService(store, { clock: () => new Date("2026-08-14T13:05:00.000Z") });
    const result = await service.reconstructWorkspace(projectId);

    expect(result.interruptedRuns).toEqual([]);
    expect(result.page.entries.some((entry) => entry.kind === "workspace.restored")).toBe(false);
    expect(result.processRunning).toBe(false);
  });
});
