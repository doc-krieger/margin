import { describe, expect, it } from "vitest";
import { ProjectApiClient } from "../../../apps/web/src/projects/api.js";

function commentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    projectId: "project-1",
    documentPath: "notes.md",
    scope: "selection",
    runId: null,
    body: "Review this",
    state: "open",
    anchor: null,
    anchorStatus: "orphaned",
    anchorConfidence: 0,
    orphanReason: "removed-text",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    addressedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe("comment review browser contract", () => {
  it("keeps selection, document, and run scopes on the comments API boundary", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ProjectApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        const method = init?.method ?? "GET";
        const body = method === "GET" ? { comments: [commentResponse()] } : { comment: commentResponse({ scope: JSON.parse(String(init?.body)).scope ?? "document" }) };
        return new Response(JSON.stringify(body), { status: method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
      },
    });

    const selection = await client.createSelectionComment("project-1", { documentPath: "notes.md", documentText: "Keep this sentence", start: 0, end: 5, body: "Review this" });
    const document = await client.createDocumentComment("project-1", { documentPath: "notes.md", body: "Review the whole document" });
    const run = await client.createRunGuidance("project-1", { runId: "run-42", body: "Preserve citations" });

    expect(selection.scope).toBe("selection");
    expect(document.scope).toBe("document");
    expect(run.scope).toBe("run");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ scope: "selection", start: 0, end: 5 });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ scope: "run", runId: "run-42" });
  });

  it("supports durable edit and user status actions while making automation explicit", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ProjectApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ comment: commentResponse({ state: "addressed", body: "Updated" }) }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await client.updateComment("project-1", "comment-1", "Updated");
    await client.transitionComment("project-1", "comment-1", "resolved", "automation");
    await client.transitionComment("project-1", "comment-1", "resolved", "user");

    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: "Updated" });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ state: "resolved", actor: "automation" });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ state: "resolved", actor: "user" });
    expect(calls[1].url).toContain("/comments/comment-1/state");
  });

  it("surfaces orphan state and reason after a reload/list operation", async () => {
    const client = new ProjectApiClient({
      fetcher: async () => new Response(JSON.stringify({ comments: [commentResponse()] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const comments = await client.listComments("project-1", { documentPath: "notes.md" });
    expect(comments[0]).toMatchObject({ anchorStatus: "orphaned", orphanReason: "removed-text" });
  });
});
