import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRootRequestSchema } from "../packages/shared/src/index.js";
import { resolveRegisteredPath, SafetyError } from "../apps/server/src/safety/paths.js";

describe("validated project path boundary", () => {
  it("accepts a registered project and relative file path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-root-"));
    await writeFile(path.join(root, "README.md"), "hello");
    expect(await resolveRegisteredPath(root, "README.md")).toBe(path.join(root, "README.md"));
  });

  it.each(["../outside.txt", "/etc/passwd", "nested\\file.md"])("rejects unsafe path %s", async (relativePath) => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-root-"));
    await expect(resolveRegisteredPath(root, relativePath)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });

  it("rejects a symlink that escapes the registered root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "margin-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "linked"));
    await expect(resolveRegisteredPath(root, "linked/secret.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });

  it("reports a missing registered root distinctly", async () => {
    await expect(resolveRegisteredPath("/definitely/missing/margin-root", "file.md")).rejects.toBeInstanceOf(SafetyError);
    await expect(resolveRegisteredPath("/definitely/missing/margin-root", "file.md")).rejects.toMatchObject({ code: "ROOT_NOT_FOUND" });
  });

  it("rejects malformed project requests before routing", () => {
    expect(projectRootRequestSchema.safeParse({ projectId: "bad id", relativePath: "notes.md" }).success).toBe(false);
    expect(projectRootRequestSchema.safeParse({ projectId: "project-1", relativePath: "../notes.md" }).success).toBe(true);
  });
});
