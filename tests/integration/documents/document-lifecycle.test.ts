import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";
import { DocumentError, DocumentService } from "../../../apps/server/src/documents/service.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "margin-documents-"));
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, "notes"), { recursive: true });
  await writeFile(path.join(projectPath, "README.md"), "# Readme\n");
  await writeFile(path.join(projectPath, "notes", "one.md"), "# One\n");
  const projects = new ProjectLifecycleService();
  await projects.registerRoot(root);
  const opened = await projects.openProject(projectPath, { gitDecision: "continue-without-git" });
  return { root, projectPath, projectId: opened.project.id, projects };
}

describe("canonical document lifecycle", () => {
  it("lists, reads, saves, and reopens the filesystem document with a stable hash", async () => {
    const context = await setup();
    const documents = new DocumentService(context.projects);
    const listed = await documents.listDocuments(context.projectId);
    expect(listed.documents.map((entry) => entry.path)).toEqual(["README.md", "notes/one.md"]);
    const before = await documents.readDocument(context.projectId, "notes/one.md");
    const saved = await documents.saveDocument(context.projectId, { path: "notes/one.md", content: "# Updated\n", baseHash: before.hash });
    expect(saved.hash).not.toBe(before.hash);
    await expect(readFile(path.join(context.projectPath, "notes/one.md"), "utf8")).resolves.toBe("# Updated\n");
    await expect(documents.readDocument(context.projectId, "notes/one.md")).resolves.toMatchObject({ content: "# Updated\n", hash: saved.hash });
  });

  it("rejects stale saves and paths outside the project", async () => {
    const context = await setup();
    const documents = new DocumentService(context.projects);
    const before = await documents.readDocument(context.projectId, "README.md");
    await writeFile(path.join(context.projectPath, "README.md"), "# External\n");
    await expect(documents.saveDocument(context.projectId, { path: "README.md", content: "# Local\n", baseHash: before.hash })).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(documents.readDocument(context.projectId, "../outside.md")).rejects.toMatchObject({ code: "DOCUMENT_PATH_INVALID" });
  });

  it("rejects malformed UTF-8 without rewriting the original bytes", async () => {
    const context = await setup();
    const invalidBytes = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
    await writeFile(path.join(context.projectPath, "notes", "binary.dat"), invalidBytes);
    const documents = new DocumentService(context.projects);

    await expect(documents.readDocument(context.projectId, "notes/binary.dat")).rejects.toMatchObject<DocumentError>({ code: "DOCUMENT_NOT_TEXT" });
    expect(await readFile(path.join(context.projectPath, "notes", "binary.dat"))).toEqual(invalidBytes);

    const app = buildApp({ projectService: context.projects, documentService: documents });
    const response = await app.inject({ method: "GET", url: `/api/projects/${context.projectId}/documents/notes/binary.dat` });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("DOCUMENT_NOT_TEXT");
    expect(await readFile(path.join(context.projectPath, "notes", "binary.dat"))).toEqual(invalidBytes);
    await app.close();
  });

  it("exposes document navigation and conflict diagnostics through the API", async () => {
    const context = await setup();
    const app = buildApp({ projectService: context.projects });
    const listed = await app.inject({ method: "GET", url: `/api/projects/${context.projectId}/documents` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().documents).toHaveLength(2);
    const read = await app.inject({ method: "GET", url: `/api/projects/${context.projectId}/documents/notes/one.md` });
    expect(read.statusCode).toBe(200);
    const snapshot = read.json();
    await writeFile(path.join(context.projectPath, "notes", "one.md"), "# External\n");
    const save = await app.inject({ method: "PUT", url: `/api/projects/${context.projectId}/documents/notes/one.md`, payload: { content: "# Local\n", baseHash: snapshot.hash } });
    expect(save.statusCode).toBe(409);
    expect(save.json().error).toMatchObject({ code: "DOCUMENT_CONFLICT", correlationId: expect.any(String) });
    await app.close();
  });
});
