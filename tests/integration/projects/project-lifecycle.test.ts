import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";
import { GitInitializationService } from "../../../apps/server/src/projects/git.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import { readProjectManifest } from "../../../apps/server/src/filesystem/manifest.js";
import type { CommandResult } from "../../../apps/server/src/process/command.js";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "margin-projects-"));
}

function successfulGitResult(): CommandResult {
  const now = new Date().toISOString();
  return { executable: "git", args: ["init"], cwd: undefined, exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, startedAt: now, endedAt: now, durationMs: 0 };
}

describe("project lifecycle", () => {
  it("creates a multi-file project and reopens it with the same manifest identity", async () => {
    const root = await temporaryRoot();
    const service = new ProjectLifecycleService();
    await service.registerRoot(root);

    const created = await service.createProject({ projectPath: path.join(root, "study"), name: "Study", gitDecision: "continue-without-git" });
    expect(created.project.path).toBe(path.join(root, "study"));
    expect(created.project.markdownFiles).toContain("documents/report.md");
    expect(await stat(path.join(root, "study", "margin.yaml"))).toBeTruthy();
    const firstManifest = await readProjectManifest(path.join(root, "study"));

    const reopened = await service.openProject(path.join(root, "study"), { gitDecision: "continue-without-git" });
    expect(reopened.project.id).toBe(firstManifest?.id);
    expect(reopened.project.files).toEqual(expect.arrayContaining(["margin.yaml", "documents/report.md"]));
  });

  it("requires an explicit choice before mutating or opening an existing non-Git folder", async () => {
    const root = await temporaryRoot();
    const projectPath = path.join(root, "existing");
    await mkdir(path.join(projectPath, "notes"), { recursive: true });
    await writeFile(path.join(projectPath, "notes", "one.md"), "# One\n");
    const service = new ProjectLifecycleService();
    await service.registerRoot(root);

    await expect(service.openProject(projectPath)).rejects.toMatchObject({ code: "GIT_INITIALIZATION_REQUIRED" });
    await expect(readProjectManifest(projectPath)).resolves.toBeUndefined();

    const opened = await service.openProject(projectPath, { gitDecision: "continue-without-git" });
    expect(opened.project.gitInitialized).toBe(false);
    await expect(readProjectManifest(projectPath)).resolves.toMatchObject({ name: "existing" });
  });

  it("initializes Git only after the explicit initialize decision", async () => {
    const root = await temporaryRoot();
    const projectPath = path.join(root, "git-project");
    await mkdir(projectPath);
    const fakeGit = new GitInitializationService({
      run: async (_executable, _args, options) => {
        await mkdir(path.join(options?.cwd ?? projectPath, ".git"));
        return successfulGitResult();
      },
    });
    const service = new ProjectLifecycleService({ git: fakeGit });
    await service.registerRoot(root);

    await expect(service.openProject(projectPath)).rejects.toMatchObject({ code: "GIT_INITIALIZATION_REQUIRED" });
    expect(await stat(path.join(projectPath, ".git")).catch(() => undefined)).toBeUndefined();
    const opened = await service.openProject(projectPath, { gitDecision: "initialize" });
    expect(opened.project.gitInitialized).toBe(true);
    expect((await stat(path.join(projectPath, ".git"))).isDirectory()).toBe(true);
  });

  it("rejects duplicate manifest identities unless a new identity is explicitly assigned", async () => {
    const root = await temporaryRoot();
    const firstPath = path.join(root, "first");
    const secondPath = path.join(root, "second");
    const sharedId = "11111111-1111-4111-8111-111111111111";
    await mkdir(firstPath);
    await writeFile(path.join(firstPath, "margin.yaml"), `id: ${sharedId}\nname: First\nversion: 1\n`);
    const service = new ProjectLifecycleService();
    await service.registerRoot(root);
    await service.openProject(firstPath, { gitDecision: "continue-without-git" });

    await mkdir(secondPath);
    await writeFile(path.join(secondPath, "margin.yaml"), `id: ${sharedId}\nname: Second\nversion: 1\n`);
    await expect(service.openProject(secondPath, { gitDecision: "continue-without-git" })).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_IDENTITY" });
    const reassigned = await service.openProject(secondPath, { duplicateIdentityDecision: "assign-new-id", gitDecision: "continue-without-git" });
    expect(reassigned.project.id).not.toBe(sharedId);
    expect((await readProjectManifest(secondPath))?.id).toBe(reassigned.project.id);
  });

  it("exposes root registration and containment errors through the API", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const service = new ProjectLifecycleService();
    const app = buildApp({ projectService: service });
    const rootResponse = await app.inject({ method: "POST", url: "/api/projects/roots", payload: { path: root } });
    expect(rootResponse.statusCode).toBe(201);
    const outsideResponse = await app.inject({ method: "POST", url: "/api/projects/open", payload: { path: path.join(outside, "not-registered"), gitDecision: "continue-without-git" } });
    expect(outsideResponse.statusCode).toBe(403);
    expect(outsideResponse.json()).toMatchObject({ error: { code: "PROJECT_PATH_OUTSIDE_REGISTERED_ROOT" } });
    await app.close();
  });
});
