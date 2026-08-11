import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkspacePane,
  WorkspaceShell,
  nextWorkspacePane,
  renderMarkdownPreview,
  workspacePaneOrder,
} from "../../../apps/web/src/layout/workspace-shell.js";

describe("accessible workspace shell browser contract", () => {
  it("exposes stable, labelled pane landmarks and live state", () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkspaceShell,
        { projectName: "Fixture project", status: "Ready", error: "Run failed" },
        workspacePaneOrder.map((pane) =>
          createElement(
            WorkspacePane,
            { key: pane, id: pane, title: pane },
            createElement("p", null, `${pane} content`),
          ),
        ),
      ),
    );

    expect(markup).toContain('data-testid="workspace-shell"');
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(workspacePaneOrder.length);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="alert"');
    for (const pane of workspacePaneOrder) {
      expect(markup).toContain(`data-workspace-pane="${pane}"`);
      expect(markup).toContain(`workspace-pane-title-${pane}`);
    }
  });

  it("keeps pane keyboard navigation deterministic", () => {
    expect(nextWorkspacePane("documents", "previous")).toBe("history");
    expect(nextWorkspacePane("history", "next")).toBe("documents");
    expect(nextWorkspacePane("editor", "next")).toBe("comments");
    expect(nextWorkspacePane("editor", "previous")).toBe("documents");
  });

  it("renders every line of a long document for an independently scrollable reader", () => {
    const source = Array.from({ length: 1200 }, (_, index) => `line ${index}`).join("\n");
    const markup = renderToStaticMarkup(
      createElement("div", { className: "workspace__preview" }, renderMarkdownPreview(source)),
    );

    expect(markup).toContain("line 0");
    expect(markup).toContain("line 1199");
    expect((markup.match(/<p>/g) ?? []).length).toBe(1200);
  });
});
