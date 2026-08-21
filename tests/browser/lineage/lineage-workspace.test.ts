import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FinalCheckpointSummary, LineageEntry, LineagePage } from "@margin/shared";
import { LineageApiClient } from "../../../apps/web/src/lineage/api.js";
import { FinalCheckpointSummary as FinalCheckpointSummaryPanel } from "../../../apps/web/src/lineage/final-checkpoint-summary.js";
import { LineageWorkspace } from "../../../apps/web/src/lineage/lineage-workspace.js";

const entry: LineageEntry = {
  schemaVersion: 1,
  entryId: "entry-report-1",
  projectId: "project-1",
  occurredAt: "2026-08-14T10:00:00.000Z",
  kind: "research.report",
  title: "Cited report accepted",
  summary: "The report is ready for independent review against frozen source evidence.",
  target: { type: "research-report", id: "report-1", label: "reports/accepted.md" },
  detailTarget: { type: "research-report", id: "report-1", label: "reports/accepted.md" },
  status: "accepted",
  checkpointId: "checkpoint-1",
  runId: "run-1",
  proposalId: null,
  attemptId: null,
  sourceId: null,
  versionId: null,
  findingId: null,
  commentId: null,
  relatedTargets: [{ type: "checkpoint", id: "checkpoint-1", label: "Accepted checkpoint" }],
  diagnostic: null,
};

const page: LineagePage = {
  schemaVersion: 1,
  projectId: "project-1",
  entries: [entry],
  cursor: null,
  nextCursor: null,
  hasMore: false,
  pageSize: 50,
  freshness: { revision: "a".repeat(64), generatedAt: "2026-08-14T10:01:00.000Z", status: "fresh", cursorRevision: null },
};

const summary: FinalCheckpointSummary = {
  schemaVersion: 1,
  projectId: "project-1",
  checkpointId: "checkpoint-1",
  reportTarget: { type: "research-report", id: "report-1", label: "reports/accepted.md" },
  latestQaAttemptId: "qa-attempt-1",
  latestQaOutcome: "passed",
  remainingRiskCounts: { open: 2, accepted: 1 },
  sourceHealth: { total: 4, archived: 1, metadataOnly: 0, unavailable: 1, failed: 0 },
  reviewAcknowledged: false,
  proposalDecision: "keep",
  generatedAt: "2026-08-14T10:01:00.000Z",
};

describe("lineage workspace", () => {
  it("renders navigable milestones and truthful final checkpoint health", () => {
    const html = renderToStaticMarkup(createElement(LineageWorkspace, {
      projectId: "project-1",
      initialPage: page,
      initialSummary: summary,
      onStartFollowUpQa: vi.fn(),
    }));

    expect(html).toContain("Research lineage");
    expect(html).toContain("Cited report accepted");
    expect(html).toContain("Open risk");
    expect(html).toContain(">2<");
    expect(html).toContain("Start follow-up QA");
    expect(html).toContain("Selecting a milestone never changes its canonical record");
  });

  it("keeps detail selection accessible and identifies the immutable target", () => {
    const html = renderToStaticMarkup(createElement(LineageWorkspace, {
      projectId: "project-1",
      initialEntries: [entry],
      initialSummary: summary,
    }));

    expect(html).toContain('data-testid="lineage-entry-detail"');
    expect(html).toContain("Immutable detail");
    expect(html).toContain("research-report");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  it("uses encoded project and entry IDs at the API boundary", async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }));
    const api = new LineageApiClient({ baseUrl: "/api", fetcher: fetcher as unknown as typeof fetch });
    await api.list("project with spaces", { limit: 10 });
    await api.getEntry("project with spaces", "entry/report");

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/project%20with%20spaces/lineage?limit=10");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects/project%20with%20spaces/lineage/entries/entry%2Freport");
  });

  it("keeps follow-up QA disabled without a durable checkpoint", () => {
    const noCheckpoint = { ...summary, checkpointId: null, reportTarget: null };
    const html = renderToStaticMarkup(createElement(FinalCheckpointSummaryPanel, {
      summary: noCheckpoint,
      onStartFollowUpQa: vi.fn(),
    }));

    expect(html).toContain("No accepted checkpoint");
    expect(html).toContain("An accepted checkpoint is required before QA can start.");
    expect(html).toContain("disabled=\"\"");
  });
});
