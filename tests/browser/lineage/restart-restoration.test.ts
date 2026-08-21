import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FinalCheckpointSummary, LineageEntry, LineagePage, WorkspaceRestoreSelection } from "@margin/shared";
import { ProposalReviewPanel } from "../../../apps/web/src/proposals/proposal-review-panel.js";
import type { ProposalReview } from "../../../apps/web/src/proposals/api.js";
import { LineageWorkspace } from "../../../apps/web/src/lineage/lineage-workspace.js";
import {
  makeWorkspaceSelection,
  readWorkspaceSelection,
  reconstructWorkspaceState,
  writeWorkspaceSelection,
  type WorkspaceSelectionStorage,
} from "../../../apps/web/src/lineage/workspace-state.js";

const projectId = "project-browser-restart";
const timestamp = "2026-08-14T14:00:00.000Z";

function entry(overrides: Partial<LineageEntry>): LineageEntry {
  const target = overrides.target ?? { type: "research-run", id: "run-interrupted", label: "Interrupted run" };
  return {
    schemaVersion: 1,
    entryId: overrides.entryId ?? "entry-default",
    projectId,
    occurredAt: overrides.occurredAt ?? timestamp,
    kind: overrides.kind ?? "research.run",
    title: overrides.title ?? "Research run",
    summary: overrides.summary ?? "Durable record",
    target,
    detailTarget: overrides.detailTarget ?? target,
    status: overrides.status ?? null,
    checkpointId: overrides.checkpointId ?? null,
    runId: overrides.runId ?? null,
    proposalId: overrides.proposalId ?? null,
    attemptId: overrides.attemptId ?? null,
    sourceId: overrides.sourceId ?? null,
    versionId: overrides.versionId ?? null,
    findingId: overrides.findingId ?? null,
    commentId: overrides.commentId ?? null,
    relatedTargets: overrides.relatedTargets ?? [],
    diagnostic: overrides.diagnostic ?? null,
  };
}

function page(entries: LineageEntry[]): LineagePage {
  return {
    schemaVersion: 1,
    projectId,
    entries,
    cursor: null,
    nextCursor: null,
    hasMore: false,
    pageSize: entries.length || 1,
    freshness: { revision: "a".repeat(64), generatedAt: timestamp, status: "fresh", cursorRevision: null },
  };
}

function summary(): FinalCheckpointSummary {
  return {
    schemaVersion: 1,
    projectId,
    checkpointId: null,
    reportTarget: null,
    latestQaAttemptId: null,
    latestQaOutcome: null,
    remainingRiskCounts: { open: 1, accepted: 0 },
    sourceHealth: { total: 0, archived: 0, metadataOnly: 0, unavailable: 0, failed: 0 },
    reviewAcknowledged: false,
    proposalDecision: "pending",
    generatedAt: timestamp,
  };
}

function storage(): WorkspaceSelectionStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function pendingReview(): ProposalReview {
  return {
    proposal: {
      proposalId: "proposal-pending",
      runId: "revision-interrupted",
      status: "pending",
      checkpoint: { sha: "b".repeat(40), ref: "refs/margin/checkpoints/pending" },
      decision: null,
      updatedAt: timestamp,
      cleanup: { status: "pending", diagnostics: null },
    },
    diff: { checkpointSha: "b".repeat(40), files: [{ path: "research/report.md", status: "modified" }], patch: "diff --git" },
  };
}

describe("lineage restart restoration", () => {
  it("restores navigation while rebuilding interruption, pending decision, and artifact truth", () => {
    const entries = [
      entry({ entryId: "run-entry", runId: "run-interrupted", status: "running", occurredAt: "2026-08-14T13:59:00.000Z" }),
      entry({ entryId: "partial-report", kind: "research.report", runId: "run-interrupted", status: "partial", title: "Partial report", target: { type: "research-report", id: "partial-report" }, detailTarget: { type: "research-report", id: "partial-report" } }),
      entry({ entryId: "proposal-entry", kind: "proposal.created", proposalId: "proposal-pending", runId: "revision-interrupted", status: "pending", title: "Proposal pending", target: { type: "proposal", id: "proposal-pending" }, detailTarget: { type: "proposal", id: "proposal-pending" } }),
    ];
    const selection = makeWorkspaceSelection(projectId, { checkpointId: null, selectedEntryId: "partial-report", activePanel: "proposal", pendingProposalId: "proposal-pending" });
    const state = reconstructWorkspaceState(page(entries), summary(), selection);

    expect(state.selectedEntryId).toBe("partial-report");
    expect(state.processRunning).toBe(false);
    expect(state.decisionApplied).toBe(false);
    expect(state.interruptedRuns).toHaveLength(1);
    expect(state.pendingProposalId).toBe("proposal-pending");
    expect(state.preservedArtifacts.map((item) => item.entryId)).toEqual(["partial-report"]);
    expect(state.notices.map((notice) => notice.code)).toEqual(["RUN_INTERRUPTED", "PENDING_PROPOSAL"]);

    const markup = renderToStaticMarkup(createElement(LineageWorkspace, {
      projectId,
      initialPage: page(entries),
      initialSummary: summary(),
      selectionStorage: storage(),
    }));
    expect(markup).toContain("Workspace restored from durable records");
    expect(markup).toContain("did not assume a process was still running");
    expect(markup).toContain("partial artifact preserved");
  });

  it("round-trips only validated navigation hints and leaves a pending proposal explicit", () => {
    const selectionStorage = storage();
    const selection: WorkspaceRestoreSelection = makeWorkspaceSelection(projectId, { checkpointId: null, selectedEntryId: "entry-1", activePanel: "proposal", pendingProposalId: "proposal-pending" });
    writeWorkspaceSelection(selection, selectionStorage);
    expect(readWorkspaceSelection(projectId, selectionStorage)).toEqual(selection);
    expect(readWorkspaceSelection("another-project", selectionStorage)).toBeNull();
    expect(readWorkspaceSelection(projectId, { getItem: () => "{not-json", setItem: () => undefined })).toBeNull();

    const markup = renderToStaticMarkup(createElement(ProposalReviewPanel, {
      projectId,
      proposalId: "proposal-pending",
      initialReview: pendingReview(),
      restoredFromRestart: true,
    }));
    expect(markup).toContain("proposal-pending");
    expect(markup).toContain("restored as pending");
    expect(markup).toContain("Choose Keep or Reject explicitly");
  });
});
