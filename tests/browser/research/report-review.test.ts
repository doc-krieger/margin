import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResearchRunRecord } from "@margin/shared";
import { ProposalApiClient, type ProposalReview } from "../../../apps/web/src/proposals/api.js";
import { ResearchApiClient, type CitationResolutionResult } from "../../../apps/web/src/research/api.js";
import { ReportReview, renderMarkdownReport } from "../../../apps/web/src/research/report-review.js";

const review: ProposalReview = {
  proposal: {
    proposalId: "proposal-report-1",
    runId: "run-report-1",
    status: "pending",
    checkpoint: { sha: "abc1234", ref: "refs/margin/checkpoints/run-report-1" },
    decision: null,
    updatedAt: "2026-08-13T10:05:00.000Z",
    cleanup: { status: "pending", diagnostics: null },
  },
  diff: {
    checkpointSha: "abc1234",
    files: [
      { path: "research/report.md", status: "added" },
      { path: "research/notes.md", status: "added" },
      { path: "research/source-manifest.json", status: "added" },
    ],
    patch: "+# Report\n+Evidence-backed finding [primary-source].",
  },
};

const completedRun: ResearchRunRecord = {
  schemaVersion: 1,
  runId: "run-report-1",
  correlationId: "00000000-0000-4000-8000-000000000002",
  projectId: "project-1",
  profileId: "default",
  brief: {
    schemaVersion: 1,
    briefId: "brief-report-1",
    projectId: "project-1",
    question: "What makes a research report trustworthy?",
    scope: "Compare durable provenance and citation practices.",
    audience: "Product team",
    exclusions: [],
    depth: "standard",
    outline: ["Finding", "Limitations"],
    outputMode: "research-and-report",
    outputPaths: { reportPath: null, notesPath: null, manifestPath: null },
    sourcePreferences: { permittedKinds: [], preferredKinds: [], preferPrimarySources: true, languages: [] },
    dateLimits: null,
    recipe: "standard",
    status: "confirmed",
    clarificationDecisions: [],
    revision: 1,
    confirmedRevision: 1,
    confirmedAt: "2026-08-13T10:00:00.000Z",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
  },
  recipe: "standard",
  status: "completed",
  currentStage: { stage: "finalizing", status: "completed", startedAt: "2026-08-13T10:04:00.000Z", endedAt: "2026-08-13T10:05:00.000Z", artifactIds: ["report-1"], diagnostics: null },
  stageHistory: [],
  requiredCapabilities: [],
  sourceSelections: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", required: true }],
  sourceProjection: null,
  frozenSourceBindings: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", checksum: "a".repeat(64), required: true, citationKey: "primary-source" }],
  capabilities: null,
  session: { sessionId: "session-report-1", eventCount: 9, commandCount: 3, promptCount: 1, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, durationMs: 5000, lastEventAt: "2026-08-13T10:05:00.000Z" },
  artifacts: [{ artifactId: "report-1", kind: "report", status: "complete", relativePath: "research/report.md", label: "Trustworthy research report", bytes: 96, sha256: "b".repeat(64), createdAt: "2026-08-13T10:04:00.000Z", updatedAt: "2026-08-13T10:05:00.000Z" }],
  synthesisAttempts: [{
    attemptId: "attempt-report-1", parentAttemptId: null, status: "completed",
    input: { confirmedBriefRevision: 1, confirmedBriefHash: "c".repeat(64), sourceBindings: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", checksum: "a".repeat(64), required: true, citationKey: "primary-source" }], notesArtifactId: null, notesSha256: null, profileId: "default", priorAttemptId: null },
    notesArtifactId: null, reportArtifactId: "report-1",
    citationValidation: { status: "valid", unresolvedKeys: [], ambiguousKeys: [], diagnostics: "All citation keys resolve to frozen versions.", usages: [{ usageId: "usage-1", citationKey: "primary-source", sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", location: { relativePath: "research/report.md", line: 2, column: null, endLine: null, endColumn: null }, excerpt: "durable provenance" }] },
    diagnostics: null, createdAt: "2026-08-13T10:03:00.000Z", startedAt: "2026-08-13T10:03:01.000Z", endedAt: "2026-08-13T10:05:00.000Z",
  }],
  latestSynthesisAttemptId: "attempt-report-1",
  proposal: { ...review.proposal, proposalId: "proposal-report-1", createdAt: "2026-08-13T10:05:00.000Z", decidedAt: null, artifactIds: ["report-1"], reportArtifactId: "report-1", notesArtifactId: null, manifestArtifactId: null },
  cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
  diagnostics: null,
  processExit: { exitCode: 0, signal: null, timedOut: false, aborted: false, exitedAt: "2026-08-13T10:05:00.000Z" },
  createdAt: "2026-08-13T10:00:00.000Z", startedAt: "2026-08-13T10:00:00.000Z", endedAt: "2026-08-13T10:05:00.000Z", durationMs: 300000, lastEventAt: "2026-08-13T10:05:00.000Z",
};

const resolvedCitation: CitationResolutionResult = {
  runId: completedRun.runId,
  checkpoint: { runId: completedRun.runId, attemptId: "attempt-report-1", reportArtifactId: "report-1", reportSha256: "b".repeat(64), sourceBindings: completedRun.frozenSourceBindings },
  status: "resolved",
  citations: [{
    usageId: "usage-1",
    citationKey: "primary-source",
    location: { relativePath: "research/report.md", line: 2, column: null, endLine: null, endColumn: null },
    excerpt: "durable provenance",
    status: "resolved",
    source: {
      sourceId: "src_1234567890abcdef",
      kind: "web",
      identity: "https://example.test/primary",
      aliases: [],
      effectiveMetadata: { title: "Primary source" },
      evidenceState: "archived",
      latestVersionId: "ev_1234567890abcdef",
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
    },
    version: {
      versionId: "ev_1234567890abcdef",
      checksum: "a".repeat(64),
      byteLength: 24,
      mediaType: "text/plain",
      capturedAt: "2026-08-13T10:00:00.000Z",
      attemptId: "cap_1234567890abcdef",
    },
    evidence: { available: true, mediaType: "text/plain", checksum: "a".repeat(64), byteLength: 24, preview: "Durable provenance is inspectable.", truncated: false },
    diagnostic: null,
  }],
  diagnostics: [],
};

const unresolvedCitation: CitationResolutionResult = {
  ...resolvedCitation,
  status: "failed",
  citations: [{
    ...resolvedCitation.citations[0],
    status: "unresolved",
    source: null,
    version: null,
    evidence: null,
    diagnostic: { code: "UNRESOLVED_CITATION", message: "No frozen source binding is recorded for this citation" },
  }],
  diagnostics: [{ code: "UNRESOLVED_CITATION", message: "No frozen source binding is recorded for this citation" }],
};

describe("report-led provenance review", () => {
  it("renders the isolated report, citation usage index, frozen versions, and whole-proposal boundary", () => {
    const html = renderToStaticMarkup(createElement(ReportReview, {
      projectId: "project-1", run: completedRun, initialReview: review,
      initialReport: { path: "research/report.md", content: "# Trustworthy report\n\nEvidence-backed finding [primary-source].", hash: "hash-report" },
    }));
    expect(html).toContain("Cited report proposal");
    expect(html).toContain("Trustworthy report");
    expect(html).toContain("Citation validation");
    expect(html).toContain("1 citation usage location indexed");
    expect(html).toContain("primary-source");
    expect(html).toContain("ev_1234567890abcdef");
    expect(html).toContain("Keep whole run");
    expect(html).toContain("Keep or Reject applies to the whole proposal");
  });

  it("gates Keep and preserves degraded citation diagnostics", () => {
    const partialRun = { ...completedRun, status: "partial" as const, synthesisAttempts: [{ ...completedRun.synthesisAttempts[0], status: "partial" as const, citationValidation: { ...completedRun.synthesisAttempts[0].citationValidation!, status: "partial" as const, unresolvedKeys: ["missing-key"] } }] };
    const html = renderToStaticMarkup(createElement(ReportReview, {
      projectId: "project-1", run: partialRun, initialReview: review,
      initialReport: { path: "research/report.md", content: "# Partial\n\nUnresolved [missing-key].", hash: "hash-report" },
    }));
    expect(html).toContain("Unresolved keys");
    expect(html).toContain("Keep is available only when every citation key resolves");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Reject whole run");
  });

  it("opens an in-context exact evidence panel and makes persisted citations interactive", () => {
    const html = renderToStaticMarkup(createElement(ReportReview, {
      projectId: "project-1", run: completedRun, initialReview: review,
      initialCitationResolution: resolvedCitation,
      initialReport: { path: "research/report.md", content: "# Safe\n\nEvidence-backed finding [primary-source].", hash: "hash-report" },
    }));
    expect(html).toContain('class="report-preview__citation"');
    expect(html).toContain("Citation support");
    expect(html).toContain("Exact evidence");
    expect(html).toContain("https://example.test/primary");
    expect(html).toContain("Durable provenance is inspectable.");
    expect(html).toContain("a".repeat(64));
  });

  it("shows unresolved diagnostics and an explicit new-checkpoint repair boundary", () => {
    const html = renderToStaticMarkup(createElement(ReportReview, {
      projectId: "project-1", run: completedRun, initialReview: review,
      initialCitationResolution: unresolvedCitation,
      initialReport: { path: "research/report.md", content: "Unresolved [primary-source].", hash: "hash-report" },
    }));
    expect(html).toContain("No source was inferred");
    expect(html).toContain("Prepare a checkpoint repair");
    expect(html).toContain("The accepted report and reviewer history stay unchanged");
    expect(html).toContain("Replacement source ID");
  });

  it("renders Markdown as text rather than executable HTML", () => {
    const html = renderToStaticMarkup(createElement("div", null, renderMarkdownReport("# Safe\n\n<script>alert('xss')</script>")));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("calls citation resolution and repair through exact server boundaries", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new ResearchApiClient({ fetcher: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      const body = String(url).includes("/repair") ? { repair: { ...unresolvedCitation, status: "no-change", citationKey: "primary-source", selectedVersion: resolvedCitation.citations[0].version, parent: resolvedCitation.checkpoint, nextCheckpoint: { parentRunId: "run-report-1", parentAttemptId: "attempt-report-1", reportArtifactId: null, reportSha256: null, sourceBindings: completedRun.frozenSourceBindings }, lineage: null } } : { resolution: resolvedCitation };
      return new Response(JSON.stringify(body), { status: 200 });
    } });
    await client.resolveCitations("run-report-1", { attemptId: "attempt-report-1" });
    await client.repairCitation("run-report-1", { citationKey: "primary-source", sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", reason: "Use the persisted exact version." });
    expect(calls).toEqual([
      { url: "/api/research/runs/run-report-1/citations?attemptId=attempt-report-1", method: "GET" },
      { url: "/api/research/runs/run-report-1/citations/repair", method: "POST" },
    ]);
  });

  it("loads report bodies through the isolated proposal file endpoint", async () => {
    const calls: string[] = [];
    const client = new ProposalApiClient({ fetcher: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ path: "research/report.md", content: "# report", hash: "hash" }), { status: 200 });
    } });
    await client.readFile("project-1", "proposal-report-1", "research/report.md");
    expect(calls).toEqual(["/api/projects/project-1/proposals/proposal-report-1/files/research%2Freport.md"]);
  });
});
