import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "../../helpers/test-api.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { CommentService } from "../../../apps/server/src/comments/repository.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import type { RegisteredProject } from "../../../apps/server/src/projects/registry.js";

function registerProject(projects: ProjectLifecycleService, projectPath: string): RegisteredProject {
  const project: RegisteredProject = {
    id: "project-sources",
    name: "Sources test project",
    path: projectPath,
    manifestPath: path.join(projectPath, "margin.yaml"),
    rootPath: path.dirname(projectPath),
    gitInitialized: false,
    markdownFiles: [],
    files: [],
    openedAt: new Date().toISOString(),
  };
  projects.registry.registerProject(project);
  return project;
}

describe("source routes", () => {
  it("captures a project file through the shared service and exposes safe detail and evidence routes", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "margin-source-routes-"));
    await writeFile(path.join(projectPath, "article.txt"), "captured route evidence\n", "utf8");
    const projects = new ProjectLifecycleService();
    const project = registerProject(projects, projectPath);
    const app = buildApp({ projectService: projects, commentService: new CommentService(":memory:") });

    try {
      const captured = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/sources/capture`,
        payload: { kind: "file", value: "article.txt", origin: "ui" },
      });
      assert.equal(captured.statusCode, 200);
      const capture = captured.json().capture;
      assert.equal(capture.status, "archived");
      assert.equal(capture.source.kind, "file");
      assert.equal(capture.source.identity, "file:article.txt");
      assert.match(capture.sourceId, /^src_[a-f0-9]{32}$/);
      assert.match(capture.version.versionId, /^ev_[a-f0-9]{32}$/);

      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/sources` });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().sources.length, 1);
      assert.equal(listed.json().sources[0].attempts[0].origin, "ui");

      const detail = await app.inject({ method: "GET", url: `/api/projects/${project.id}/sources/${capture.sourceId}` });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().source.latestVersionId, capture.version.versionId);
      assert.equal(detail.json().source.versions[0].originalPath, "article.txt");

      const evidence = await app.inject({ method: "GET", url: `/api/projects/${project.id}/sources/${capture.sourceId}/evidence/${capture.version.versionId}` });
      assert.equal(evidence.statusCode, 200);
      assert.equal(evidence.headers["content-type"], "text/plain");
      assert.equal(evidence.body, "captured route evidence\n");

      const missing = await app.inject({ method: "GET", url: `/api/projects/unknown/sources` });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, "SOURCE_PROJECT_NOT_FOUND");
    } finally {
      await app.close();
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated capture intents while retaining both caller origins", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "margin-source-routes-"));
    await writeFile(path.join(projectPath, "article.txt"), "same evidence", "utf8");
    const projects = new ProjectLifecycleService();
    const project = registerProject(projects, projectPath);
    const app = buildApp({ projectService: projects, commentService: new CommentService(":memory:") });

    try {
      const first = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sources/capture`, payload: { kind: "file", value: "article.txt", origin: "ui" } });
      const second = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sources/capture`, payload: { kind: "file", value: "article.txt", origin: "pi", runId: "run-source-test" } });
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().capture.sourceId, first.json().capture.sourceId);
      assert.equal(second.json().capture.version.versionId, first.json().capture.version.versionId);

      const source = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/sources/${first.json().capture.sourceId}` })).json().source;
      assert.equal(source.versions.length, 1);
      assert.deepEqual(source.attempts.map((attempt: { origin: string }) => attempt.origin).sort(), ["pi", "ui"]);
      assert.equal(source.attempts.find((attempt: { origin: string }) => attempt.origin === "pi").runId, "run-source-test");
      assert.equal(await readFile(path.join(projectPath, "article.txt"), "utf8"), "same evidence");
    } finally {
      await app.close();
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
