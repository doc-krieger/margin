import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { detectMarkdownDialect, parseMarkdown } from "../../packages/shared/src/markdown/index.js";
import {
  isSourceMarkdownEditor,
  isVisualMarkdownEditor,
  openMarkdown,
} from "../../apps/web/src/editor/markdown-editor.js";

const supportedFixture = new URL("../fixtures/markdown/supported.md", import.meta.url);
const unsupportedFixture = new URL("../fixtures/markdown/unsupported.md", import.meta.url);

function allNodes(node: { content?: Array<{ type: string; content?: Array<{ type: string; content?: unknown[] }> }> }): string[] {
  return (node.content ?? []).flatMap((child) => [child.type, ...allNodes(child)]);
}

describe("Markdown visual editor fidelity", () => {
  it("detects and represents the supported fixture with the narrow schema", async () => {
    const source = await readFile(supportedFixture, "utf8");
    const detection = detectMarkdownDialect(source);
    expect(detection).toEqual({ supported: true, features: [] });

    const editor = openMarkdown(source);
    expect(isVisualMarkdownEditor(editor)).toBe(true);
    if (!isVisualMarkdownEditor(editor)) return;

    const document = editor.getDocument();
    const types = allNodes(document);
    expect(types).toEqual(expect.arrayContaining([
      "heading",
      "paragraph",
      "blockquote",
      "bulletList",
      "orderedList",
      "table",
      "tableHeader",
      "tableCell",
    ]));

    const marks = JSON.stringify(document);
    expect(marks).toContain('"type":"strong"');
    expect(marks).toContain('"type":"em"');
    expect(marks).toContain('"type":"link"');
    expect(marks).toContain('"type":"citation"');
  });

  it("keeps canonical Markdown stable across edit, serialize, and reopen", async () => {
    const source = await readFile(supportedFixture, "utf8");
    const editor = openMarkdown(source);
    expect(isVisualMarkdownEditor(editor)).toBe(true);
    if (!isVisualMarkdownEditor(editor)) return;

    const beforeEdit = editor.serialize();
    expect(beforeEdit).toContain("| Claim | Status |");
    expect(beforeEdit).toContain("| --- | --- |");

    editor.replaceText("Draft findings", "Revised findings");
    const saved = editor.serialize();
    const reopened = openMarkdown(saved);
    expect(isVisualMarkdownEditor(reopened)).toBe(true);
    if (!isVisualMarkdownEditor(reopened)) return;

    expect(reopened.serialize()).toBe(saved);
    expect(reopened.serialize()).toContain("Revised findings");
    expect(parseMarkdown(saved)).toMatchObject({ mode: "visual", canonicalMarkdown: saved });
  });

  it("falls back to exact source for unsupported Markdown", async () => {
    const source = await readFile(unsupportedFixture, "utf8");
    const editor = openMarkdown(source);
    expect(isSourceMarkdownEditor(editor)).toBe(true);
    if (!isSourceMarkdownEditor(editor)) return;

    expect(editor.serialize()).toBe(source);
    expect(editor.getSource()).toBe(source);
    expect(editor.detection.features.map((feature) => feature.code)).toContain("fenced-code");

    editor.replaceSource(`${source}\nAdded in source mode.`);
    expect(editor.serialize()).toBe(`${source}\nAdded in source mode.`);
  });

  it.each([
    ["unmatched emphasis", "A *broken paragraph"],
    ["non-consecutive ordered list", "1. first\n3. third"],
    ["raw HTML", "A <span>raw tag</span>"],
    ["task list", "- [ ] not visual"],
  ])("falls back instead of normalizing %s", (_name, source) => {
    const editor = openMarkdown(source);
    expect(editor.mode).toBe("source");
    expect(editor.serialize()).toBe(source);
  });
});
