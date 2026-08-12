import { describe, expect, it } from "vitest";
import { ProjectApiClient, type EventSourceLike } from "../../../apps/web/src/projects/api.js";

const manifest = { command: "pi", versionArgs: ["--version"], runArgs: ["--mode", "json"], protocol: "jsonl" as const, timeoutMs: 120_000 };

function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    correlationId: "00000000-0000-4000-8000-000000000001",
    projectId: "project-1",
    repositoryRoot: "/fixtures/project",
    profileId: "default",
    status: "queued",
    createdAt: new Date(0).toISOString(),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    checkpoint: null,
    manifest: null,
    changedFiles: [],
    diagnostics: null,
    errorCode: null,
    cleanup: { status: "pending", startedAt: null, endedAt: null, diagnostics: null },
    ...overrides,
  };
}

class FakeEventSource implements EventSourceLike {
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, sequence: number, payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, lastEventId: String(sequence), data: JSON.stringify({ timestamp: new Date(0).toISOString(), payload }) } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  emitRaw(type: string, sequence: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, lastEventId: sequence, data } as MessageEvent<string>);
  }

  close(): void {
    this.closed = true;
  }
}

describe("revision run browser contract", () => {
  it("sends the selected comments and reviewed guidance to a scoped start request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ProjectApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/pi/profiles")) return new Response(JSON.stringify({ profiles: [{ id: "default", status: "available", manifest, message: "Pi ready" }] }), { status: 200 });
        if (String(url).endsWith("/projects/project-1/runs")) return new Response(JSON.stringify({ runId: "run-1", run: runRecord() }), { status: 202 });
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      },
    });

    const profiles = await client.listPiProfiles();
    const result = await client.startRun("project-1", { profileId: profiles[0].id, selectedCommentIds: ["comment-1", "comment-2"], guidance: "Keep the citation style unchanged." });

    expect(profiles[0]).toMatchObject({ id: "default", status: "available" });
    expect(result.runId).toBe("run-1");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ profileId: "default", selectedCommentIds: ["comment-1", "comment-2"], guidance: "Keep the citation style unchanged." });
  });

  it("reconnects SSE with the last durable sequence and stops after terminal evidence", async () => {
    const urls: string[] = [];
    const sources: FakeEventSource[] = [];
    const client = new ProjectApiClient({
      eventSourceFactory: (url) => {
        urls.push(url);
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
    });
    const received: number[] = [];
    const cleanup = client.subscribeRunEvents("run-1", {
      onEvent: (event) => received.push(event.sequence),
    });

    sources[0].emit("run.started", 3, { status: "checkpointing" });
    sources[0].fail();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(urls[1]).toContain("/runs/run-1/events?after=3");

    sources[1].emit("run.completed", 4, { changedFiles: [{ path: "notes.md", status: "modified" }] });
    expect(received).toEqual([3, 4]);
    expect(sources[1].closed).toBe(true);
    cleanup();
  });

  it("surfaces failed control requests and malformed SSE payloads", async () => {
    const unavailable = new ProjectApiClient({
      fetcher: async () => new Response(JSON.stringify({ error: { code: "PI_UNAVAILABLE", message: "Pi executable is unavailable" } }), { status: 503 }),
    });
    await expect(unavailable.listPiProfiles()).rejects.toMatchObject({ code: "PI_UNAVAILABLE", status: 503 });

    const source = new FakeEventSource();
    const errors: Error[] = [];
    const client = new ProjectApiClient({ eventSourceFactory: () => source });
    const cleanup = client.subscribeRunEvents("run-1", { onEvent: () => undefined, onError: (error) => errors.push(error) });
    source.emitRaw("pi.event", "7", "not-json");
    expect(errors).toHaveLength(1);
    cleanup();
  });
});
