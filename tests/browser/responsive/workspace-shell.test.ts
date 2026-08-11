import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceCapabilities,
  visibleWorkspacePanes,
  workspacePaneOrder,
} from "../../../apps/web/src/layout/workspace-shell.js";

describe("responsive workspace browser contract", () => {
  it("limits a narrow viewport to reading and comments", () => {
    expect(getWorkspaceCapabilities(true)).toEqual({
      canRead: true,
      canComment: true,
      canEdit: false,
      canRun: false,
      canRestore: false,
    });
    expect(visibleWorkspacePanes(true)).toEqual(["documents", "editor", "comments"]);
    expect(visibleWorkspacePanes(false)).toEqual(workspacePaneOrder);
  });

  it("keeps the responsive boundary explicit in the layout contract", () => {
    const styles = readFileSync("apps/web/src/styles.css", "utf8");
    expect(styles).toContain(".workspace-shell__panes");
    expect(styles).toContain('[data-viewport="mobile"]');
    expect(styles).toContain("@media (max-width: 42rem)");
    expect(styles).toContain("overflow: auto");
  });
});
