import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProposalApiClient,
  ProposalApiError,
  type ProposalReview,
} from "../../../apps/web/src/proposals/api.js";
import {
  ProposalReviewPanel,
  describeProposalFailure,
} from "../../../apps/web/src/proposals/proposal-review-panel.js";
import {
  CheckpointHistoryApiClient,
  type CheckpointHistoryEntry,
} from "../../../apps/web/src/history/api.js";
import { CheckpointHistoryPanel } from "../../../apps/web/src/history/checkpoint-history-panel.js";

const review: ProposalReview = {
  proposal: {
    proposalId: "proposal-1",
    runId: "run-1",
    status: "pending",
    checkpoint: { sha: "abc1234", ref: "refs/margin/checkpoints/run-1" },
    decision: null,
    updatedAt: "2026-08-11T12:00:00.000Z",
    cleanup: { status: "pending", diagnostics: null },
  },
  diff: {
    checkpointSha: "abc1234",
    files: [
      { path: "notes/essay.md", status: "modified" },
      { path: "notes/sources.md", status: "added" },
    ],
    patch: "diff --git a/notes/essay.md b/notes/essay.md\n@@ -1 +1 @@\n-Old claim\n+Revised claim",
  },
};

const checkpoints: CheckpointHistoryEntry[] = [
  {
    sha: "abc1234",
    ref: "refs/margin/checkpoints/run-1",
    runId: "run-1",
    createdAt: "2026-08-11T12:00:00.000Z",
    changedFiles: [{ path: "notes/essay.md", status: "modified" }],
    outcome: "kept",
  },
];

describe("proposal review browser contract", () => {
  it("uses isolated proposal endpoints for read, edit, and whole-run decisions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ProposalApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/files/notes%2Fessay.md")) {
          return new Response(JSON.stringify({ path: "notes/essay.md", content: "# Revised\n", hash: "hash-2" }), { status: 200 });
        }
        if (init?.method === "PUT") return new Response(JSON.stringify({ review }), { status: 200 });
        if (String(url).endsWith("/decision")) return new Response(JSON.stringify({ review: { ...review, proposal: { ...review.proposal, status: "kept", decision: "keep" } } }), { status: 200 });
        return new Response(JSON.stringify({ review }), { status: 200 });
      },
    });

    await client.getReview("project-1", "proposal-1");
    await client.readFile("project-1", "proposal-1", "notes/essay.md");
    await client.editFile("project-1", "proposal-1", "notes/essay.md", "# Revised\n", "hash-1");
    await client.decide("project-1", "proposal-1", "keep");

    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["/api/projects/project-1/proposals/proposal-1", "GET"],
      ["/api/projects/project-1/proposals/proposal-1/files/notes%2Fessay.md", "GET"],
      ["/api/projects/project-1/proposals/proposal-1/files/notes%2Fessay.md", "PUT"],
      ["/api/projects/project-1/proposals/proposal-1/decision", "POST"],
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ content: "# Revised\n", expectedHash: "hash-1" });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({ decision: "keep" });
  });

  it("renders every changed file, the complete patch, and explicit proposal/canonical safety copy", () => {
    const html = renderToStaticMarkup(createElement(ProposalReviewPanel, { projectId: "project-1", proposalId: "proposal-1", initialReview: review }));
    expect(html).toContain("Isolated proposal");
    expect(html).toContain("Canonical documents are unchanged");
    expect(html).toContain("notes/essay.md");
    expect(html).toContain("notes/sources.md");
    expect(html).toContain("Revised claim");
    expect(html).toContain("Keep whole run");
    expect(html).toContain("Reject whole run");
    expect(html).toContain("This decision applies to all 2 changed files");
  });

  it("turns conflicts and transport failures into actionable, correlated messages", () => {
    expect(describeProposalFailure(new ProposalApiError("PROPOSAL_CONFLICT", "Canonical document changed", 409, "corr-1"))).toContain("was not overwritten");
    expect(describeProposalFailure(new ProposalApiError("NETWORK_ERROR", "Request failed", 0))).toContain("could not reach");
    expect(describeProposalFailure(new ProposalApiError("BAD_RESPONSE", "Malformed response", 502, "corr-2"))).toContain("corr-2");
  });

  it("rejects malformed and canonical-conflict responses without inventing successful state", async () => {
    const malformed = new ProposalApiClient({ fetcher: async () => new Response("not-json", { status: 502, headers: { "x-correlation-id": "corr-bad" } }) });
    await expect(malformed.getReview("project-1", "proposal-1")).rejects.toMatchObject({ code: "BAD_RESPONSE", correlationId: "corr-bad" });

    const conflict = new ProposalApiClient({ fetcher: async () => new Response(JSON.stringify({ error: { code: "PROPOSAL_CONFLICT", message: "Canonical changed", correlationId: "corr-conflict" } }), { status: 409 }) });
    await expect(conflict.decide("project-1", "proposal-1", "keep")).rejects.toMatchObject({ code: "PROPOSAL_CONFLICT", status: 409, correlationId: "corr-conflict" });

    const offline = new ProposalApiClient({ fetcher: async () => { throw new Error("connection lost"); } });
    await expect(offline.getReview("project-1", "proposal-1")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});

describe("checkpoint recovery browser contract", () => {
  it("loads bounded history and requires an explicit confirmed restore request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CheckpointHistoryApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/restore")) return new Response(JSON.stringify({ status: "restored", checkpoint: checkpoints[0], restoredFiles: ["notes/essay.md"] }), { status: 200 });
        if (String(url).includes("/diff")) return new Response(JSON.stringify({ diff: review.diff }), { status: 200 });
        return new Response(JSON.stringify({ checkpoints, nextCursor: null }), { status: 200 });
      },
    });

    await client.list("project-1", { limit: 25 });
    await client.list("project-1", { limit: 500 });
    await client.diff("project-1", "abc1234");
    await client.restore("project-1", "abc1234", true);

    expect(calls[0].url).toBe("/api/projects/project-1/checkpoints?limit=25");
    expect(calls[1].url).toBe("/api/projects/project-1/checkpoints?limit=50");
    expect(calls[2].url).toBe("/api/projects/project-1/checkpoints/abc1234/diff");
    expect(calls[3].url).toBe("/api/projects/project-1/checkpoints/abc1234/restore");
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({ confirmed: true });
    await expect(client.restore("project-1", "abc1234", false)).rejects.toMatchObject({ code: "RESTORE_CONFIRMATION_REQUIRED" });
  });

  it("renders checkpoint outcome, changed-file inventory, and non-destructive confirmation language", () => {
    const html = renderToStaticMarkup(createElement(CheckpointHistoryPanel, { projectId: "project-1", initialCheckpoints: checkpoints }));
    expect(html).toContain("Checkpoint history");
    expect(html).toContain("Kept");
    expect(html).toContain("notes/essay.md");
    expect(html).toContain("Preview restore");
    expect(html).toContain("Restore creates a new recovery checkpoint");
    expect(html).toContain("Never rewrites checkpoint history");
  });
});
