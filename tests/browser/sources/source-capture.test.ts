import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@margin/shared";
import { SourceApiClient, SourceApiError } from "../../../apps/web/src/sources/api.js";
import { SourceCapturePanel } from "../../../apps/web/src/sources/source-capture-panel.js";
import { SourceDetailPanel } from "../../../apps/web/src/sources/source-detail-panel.js";

const source: SourceRecord = {
  schemaVersion: 1,
  sourceId: "src_1234567890abcdef1234567890abcdef",
  kind: "url",
  identity: "https://example.org/article",
  aliases: ["https://example.org/article?utm_source=test"],
  capturedMetadata: { title: "Fixture Article", language: "en" },
  effectiveMetadata: { title: "Fixture Article", language: "en" },
  metadataEdits: [],
  evidenceState: "archived",
  latestVersionId: "ev_1234567890abcdef1234567890abcdef",
  versions: [{
    versionId: "ev_1234567890abcdef1234567890abcdef",
    checksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    byteLength: 1024,
    mediaType: "text/html",
    capturedAt: "2026-08-13T12:00:00.000Z",
    attemptId: "cap_1234567890abcdef1234567890abcdef",
    finalUrl: "https://example.org/article",
    originalRef: "evidence/src_1234567890abcdef1234567890abcdef/ev_1234567890abcdef1234567890abcdef-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
    readableMediaType: "text/plain",
  }],
  attempts: [{
    attemptId: "cap_1234567890abcdef1234567890abcdef",
    sourceId: "src_1234567890abcdef1234567890abcdef",
    origin: "ui",
    requestedIdentity: "https://example.org/article",
    status: "archived",
    requestedAt: "2026-08-13T12:00:00.000Z",
    startedAt: "2026-08-13T12:00:00.000Z",
    completedAt: "2026-08-13T12:00:01.000Z",
    redirectChain: [],
    resultingVersionId: "ev_1234567890abcdef1234567890abcdef",
  }],
  lastAttemptId: "cap_1234567890abcdef1234567890abcdef",
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T12:00:01.000Z",
};

describe("source capture browser contract", () => {
  it("uses shared capture, list, detail, retry, and cancellation endpoints without fetching evidence bytes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SourceApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        const path = String(url);
        if (path.endsWith("/capture")) return new Response(JSON.stringify({ capture: { sourceId: source.sourceId, attemptId: source.attempts[0].attemptId, status: "archived", reused: false, source, version: source.versions[0] } }), { status: 200 });
        if (path.endsWith("/retry")) return new Response(JSON.stringify({ capture: { sourceId: source.sourceId, attemptId: source.attempts[0].attemptId, status: "reused", reused: true, source, version: source.versions[0] } }), { status: 200 });
        if (path.endsWith("/cancel")) return new Response(JSON.stringify({ source }), { status: 200 });
        if (path.endsWith(`/${source.sourceId}`)) return new Response(JSON.stringify({ source }), { status: 200 });
        return new Response(JSON.stringify({ sources: [source] }), { status: 200 });
      },
    });

    await client.listSources("project-1");
    await client.getSource("project-1", source.sourceId);
    await client.capture("project-1", { kind: "url", value: "https://example.org/article", origin: "ui" });
    await client.retry("project-1", source.sourceId, { origin: "ui" });
    await client.cancel("project-1", source.sourceId, source.attempts[0].attemptId, "test cancellation");

    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["/api/projects/project-1/sources", "GET"],
      ["/api/projects/project-1/sources/src_1234567890abcdef1234567890abcdef", "GET"],
      ["/api/projects/project-1/sources/capture", "POST"],
      ["/api/projects/project-1/sources/src_1234567890abcdef1234567890abcdef/retry", "POST"],
      ["/api/projects/project-1/sources/src_1234567890abcdef1234567890abcdef/cancel", "POST"],
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ kind: "url", value: "https://example.org/article", origin: "ui" });
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({ attemptId: source.attempts[0].attemptId, reason: "test cancellation" });
    expect(calls.some((call) => call.url.includes("/evidence/"))).toBe(false);
  });

  it("renders durable capture controls and bounded source detail while explicitly protecting evidence", () => {
    const captureMarkup = renderToStaticMarkup(createElement(SourceCapturePanel, { projectId: "project-1", initialSources: [source] }));
    const detailMarkup = renderToStaticMarkup(createElement(SourceDetailPanel, { projectId: "project-1", sourceId: source.sourceId, initialSource: source }));
    expect(captureMarkup).toContain("Capture a source");
    expect(captureMarkup).toContain("UI and Pi requests use the same idempotent capture boundary");
    expect(captureMarkup).toContain(source.sourceId);
    expect(detailMarkup).toContain("Latest immutable evidence");
    expect(detailMarkup).toContain("SHA-256");
    expect(detailMarkup).toContain("Evidence boundary");
    expect(detailMarkup).not.toContain("originalPath");
    expect(detailMarkup).not.toContain("evidence/src_");
  });

  it("keeps reconnect and malformed transport failures actionable", async () => {
    const malformed = new SourceApiClient({ fetcher: async () => new Response("not-json", { status: 502, headers: { "x-correlation-id": "corr-source" } }) });
    await expect(malformed.listSources("project-1")).rejects.toMatchObject({ code: "BAD_RESPONSE", correlationId: "corr-source" });
    const offline = new SourceApiClient({ fetcher: async () => { throw new Error("connection lost"); } });
    await expect(offline.getSource("project-1", source.sourceId)).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(new SourceApiError("SOURCE_UNAVAILABLE", "try again", 503).message).toBe("try again");
  });
});
