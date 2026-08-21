import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ResearchBrief, ResearchRunRecord } from "@margin/shared";
import {
  ResearchApiClient,
  type ResearchEventSourceLike,
} from "../../../apps/web/src/research/api.js";
import { BriefPanel } from "../../../apps/web/src/research/brief-panel.js";
import { RunProgressPanel } from "../../../apps/web/src/research/run-progress-panel.js";
import { ResearchWorkspace } from "../../../apps/web/src/research/research-workspace.js";

const brief: ResearchBrief = {
  schemaVersion: 1,
  briefId: "brief-1",
  projectId: "project-1",
  question: "How should a small team evaluate local-first research tools?",
  scope: "Compare durable provenance and reconnectable workflows; exclude pricing.",
  audience: "Product team",
  exclusions: [],
  depth: "standard",
  outline: [],
  outputMode: "research-and-report",
  outputPaths: { reportPath: null, notesPath: null, manifestPath: null },
  sourcePreferences: { permittedKinds: [], preferredKinds: [], preferPrimarySources: true, languages: [] },
  dateLimits: null,
  recipe: "standard",
  status: "confirmed",
  clarificationDecisions: [],
  revision: 2,
  confirmedRevision: 2,
  confirmedAt: "2026-08-13T10:00:00.000Z",
  createdAt: "2026-08-13T09:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
};

const run: ResearchRunRecord = {
  schemaVersion: 1,
  runId: "run-1",
  correlationId: "00000000-0000-4000-8000-000000000001",
  projectId: "project-1",
  profileId: "default",
  brief,
  recipe: "standard",
  status: "running",
  currentStage: { stage: "researching", status: "running", startedAt: "2026-08-13T10:01:00.000Z", endedAt: null, artifactIds: [], diagnostics: null },
  stageHistory: [
    { stage: "planning", status: "completed", startedAt: "2026-08-13T10:00:00.000Z", endedAt: "2026-08-13T10:00:10.000Z", artifactIds: [], diagnostics: null },
  ],
  requiredCapabilities: [],
  sourceSelections: [],
  sourceProjection: null,
  frozenSourceBindings: [],
  capabilities: {
    checkedAt: "2026-08-13T10:00:30.000Z",
    executable: { id: "executable", status: "available", checkedAt: "2026-08-13T10:00:30.000Z", evidence: [], diagnostics: null },
    rpc: { id: "rpc", status: "available", checkedAt: "2026-08-13T10:00:30.000Z", evidence: [], diagnostics: null },
    required: [],
    results: [],
    profilePolicy: null,
  },
  session: { sessionId: "session-1", eventCount: 4, commandCount: 2, promptCount: 1, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, durationMs: null, lastEventAt: "2026-08-13T10:01:00.000Z" },
  artifacts: [],
  synthesisAttempts: [],
  latestSynthesisAttemptId: null,
  proposal: null,
  cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
  diagnostics: null,
  processExit: null,
  createdAt: "2026-08-13T10:00:00.000Z",
  startedAt: "2026-08-13T10:00:00.000Z",
  endedAt: null,
  durationMs: null,
  lastEventAt: "2026-08-13T10:01:00.000Z",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("research workspace browser contract", () => {
  it("renders a confirmed brief with revision/time and the isolated-run boundary", () => {
    const html = renderToStaticMarkup(createElement(ResearchWorkspace, { projectId: "project-1", api: new ResearchApiClient({ fetcher: async () => jsonResponse({ briefs: [] }) }) }));
    expect(html).toContain("Question to cited report");
    expect(html).toContain("Proposals stay isolated until review");

    const briefHtml = renderToStaticMarkup(createElement(BriefPanel, { projectId: "project-1", initialBrief: brief }));
    expect(briefHtml).toContain("Confirmed revision 2");
    expect(briefHtml).toContain("2026");
    expect(briefHtml).toContain("Save and confirm brief");
    expect(briefHtml).toContain("Research plus cited report");
  });

  it("shows durable progress facts, stage timeline, capability state, and bounded diagnostics", () => {
    const html = renderToStaticMarkup(createElement(RunProgressPanel, { projectId: "project-1", initialRun: run }));
    expect(html).toContain("Reconnectable Standard research");
    expect(html).toContain("Capability gate");
    expect(html).toContain("Stage timeline");
    expect(html).toContain("researching");
    expect(html).toContain("Brief revision");
    expect(html).toContain("session-1");
    expect(html).toContain("No artifacts captured yet.");
  });

  it("persists confirmation through the API without moving report content into the browser", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ResearchApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(String(init?.body));
        return jsonResponse({ brief: { ...brief, ...body, status: "confirmed", confirmedAt: "2026-08-13T10:00:00.000Z", confirmedRevision: 2 } }, 201);
      },
    });
    const saved = await client.saveBrief("project-1", { question: brief.question, scope: brief.scope, status: "confirmed", confirmedAt: brief.confirmedAt, confirmedRevision: 2 });
    expect(saved.status).toBe("confirmed");
    expect(calls[0]?.url).toBe("/api/projects/project-1/research/briefs");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ question: brief.question, scope: brief.scope, status: "confirmed" });
    expect(JSON.stringify(calls[0]?.init?.body)).not.toContain("Report body");
  });

  it("reconnects SSE from the last durable sequence and ignores duplicate events", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const sources: FakeEventSource[] = [];
    class FakeEventSource implements ResearchEventSourceLike {
      onerror: ((event: Event) => void) | null = null;
      private listeners = new Map<string, (event: MessageEvent<string>) => void>();
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
      emit(type: string, sequence: number, payload: Record<string, unknown>) { this.listeners.get(type)?.({ type, lastEventId: String(sequence), data: JSON.stringify({ timestamp: "2026-08-13T10:01:00.000Z", payload }) } as MessageEvent<string>); }
      close() { /* fixture close */ }
    }
    const client = new ResearchApiClient({ eventSourceFactory: (url) => { urls.push(url); const source = new FakeEventSource(); sources.push(source); return source; } });
    const received: number[] = [];
    const unsubscribe = client.subscribeRunEvents("run-1", { onEvent: (event) => received.push(event.sequence) }, 4);
    sources[0]?.emit("research.progress", 5, { stage: "researching" });
    sources[0]?.emit("research.progress", 5, { stage: "researching" });
    sources[0]!.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(250);
    sources[1]?.emit("research.completed", 6, { status: "completed" });
    expect(received).toEqual([5, 6]);
    expect(urls).toEqual(["/api/research/runs/run-1/events?after=4", "/api/research/runs/run-1/events?after=5"]);
    unsubscribe();
    vi.useRealTimers();
  });
});
