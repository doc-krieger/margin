import { describe, expect, it } from "vitest";
import { openMarkdown } from "../../../apps/web/src/editor/markdown-editor.js";
import { ProjectApiClient } from "../../../apps/web/src/projects/api.js";

describe("workspace browser contract", () => {
  it("requests nested documents without moving document bodies into application storage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ProjectApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ path: "notes/one.md", content: "# One\n", hash: "hash", sizeBytes: 7, modifiedAt: new Date(0).toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.readDocument("project-id", "notes/one.md");
    expect(calls[0].url).toContain("/api/projects/project-id/documents/notes/one.md");
    expect(calls[0].url).not.toContain("/documents-body");
  });

  it("selects source fallback for unsupported Markdown without normalizing it", () => {
    const source = "# supported\n\n```js\nconst value = 1;\n```\n";
    const editor = openMarkdown(source);
    expect(editor.mode).toBe("source");
    expect(editor.getSource()).toBe(source);
  });
});
