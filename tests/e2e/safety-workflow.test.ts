import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.js";
import { GitCheckpointService } from "../../apps/server/src/git/checkpoint.js";
import { MemoryProposalAuditStore, MemoryProposalStore, ProposalService } from "../../apps/server/src/proposals/index.js";
import { runCommand } from "../../apps/server/src/process/command.js";
import { piProfileManifestSchema } from "../../apps/server/src/pi/manifest.js";
import { ProjectLifecycleService } from "../../apps/server/src/projects/service.js";
import { RevisionRunService, type PiProfile } from "../../apps/server/src/runs/service.js";

const fakePi = fileURLToPath(new URL("../integration/git-pi/fake-pi.mjs", import.meta.url));

type InjectResponse = { statusCode: number; body: string; headers: Record<string, string | string[] | undefined> };

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", repositoryRoot, ...args]);
  if (result.exitCode !== 0 || result.spawnError) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.spawnError || "unknown git error"}`);
  }
  return result.stdout.trim();
}

async function request(app: ReturnType<typeof buildApp>, method: string, url: string, payload?: unknown): Promise<{ response: InjectResponse; body: any }> {
  const response = await app.inject({ method, url, payload }) as unknown as InjectResponse;
  let body: any = undefined;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = response.body;
  }
  return { response, body };
}

async function repositoryFixture(): Promise<string> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "margin-e2e-repository-"));
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.email", "margin-e2e@example.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Margin E2E"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "# Canonical\n\nEdited paragraph.\n", "utf8");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["commit", "-m", "fixture"]);
  return repositoryRoot;
}

function fakeManifest(...args: string[]) {
  return piProfileManifestSchema.parse({
    command: process.execPath,
    versionArgs: ["-e", "process.stdout.write('fake-pi 1.0.0\\n')"],
    runArgs: [fakePi, ...args],
    protocol: "jsonl",
    timeoutMs: 5_000,
  });
}

function fixtureProfiles(): PiProfile[] {
  return [
    { id: "fixture", label: "Deterministic fixture Pi", status: "available", manifest: fakeManifest("--write", "proposal.md") },
    { id: "failure", label: "Deterministic failing Pi", status: "available", manifest: fakeManifest("--fail") },
  ];
}

describe("end-to-end safety workflow", () => {
  it("covers open, edit, comment, run, diff, keep, reject, restore, and failure paths", async () => {
    const repositoryRoot = await repositoryFixture();
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "margin-e2e-data-"));
    const projects = new ProjectLifecycleService();
    const runs = new RevisionRunService({ profiles: fixtureProfiles(), dataDirectory });
    const app = buildApp({ projectService: projects, runService: runs });
    let keptCheckpoint: Awaited<ReturnType<GitCheckpointService["create"]>> | undefined;
    let rejectedCheckpoint: Awaited<ReturnType<GitCheckpointService["create"]>> | undefined;

    try {
      await app.ready();

      const rootRegistration = await request(app, "POST", "/api/projects/roots", { path: path.dirname(repositoryRoot) });
      expect(rootRegistration.response.statusCode).toBe(201);

      const opened = await request(app, "POST", "/api/projects/open", { path: repositoryRoot });
      expect(opened.response.statusCode).toBe(200);
      const projectId = opened.body.project.id as string;
      const projectPath = opened.body.project.path as string;
      expect(projectPath).toBe(repositoryRoot);

      // Opening a repository without a manifest creates the local project manifest; make it part of the clean baseline.
      await git(repositoryRoot, ["add", "margin.yaml"]);
      await git(repositoryRoot, ["commit", "-m", "register project manifest"]);

      const openedDocument = await request(app, "GET", `/api/projects/${projectId}/documents/README.md`);
      expect(openedDocument.response.statusCode).toBe(200);
      expect(openedDocument.body.content).toContain("Edited paragraph.");
      const originalHash = openedDocument.body.hash as string;
      const editedContent = "# Canonical\n\nEdited paragraph with a reviewed note.\n";

      const savedDocument = await request(app, "PUT", `/api/projects/${projectId}/document`, {
        path: "README.md",
        content: editedContent,
        baseHash: originalHash,
      });
      expect(savedDocument.response.statusCode).toBe(200);
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(editedContent);

      const staleSave = await request(app, "PUT", `/api/projects/${projectId}/document`, {
        path: "README.md",
        content: "stale overwrite\n",
        baseHash: originalHash,
      });
      expect(staleSave.response.statusCode).toBe(409);
      expect(staleSave.body.error.code).toBe("DOCUMENT_CONFLICT");
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(editedContent);

      const commentStart = editedContent.indexOf("reviewed note");
      const createdComment = await request(app, "POST", `/api/projects/${projectId}/comments`, {
        scope: "selection",
        documentPath: "README.md",
        documentText: editedContent,
        start: commentStart,
        end: commentStart + "reviewed note".length,
        body: "Please retain this reviewer note in the proposal context.",
      });
      expect(createdComment.response.statusCode).toBe(201);
      const commentId = createdComment.body.comment.id as string;
      expect(createdComment.body.comment.anchorStatus).toBe("anchored");

      // A run cannot checkpoint a dirty canonical worktree and must fail without mutating it.
      const dirtyRunStart = await request(app, "POST", `/api/projects/${projectId}/runs`, {
        profileId: "fixture",
        selectedCommentIds: [commentId],
        guidance: "Create a review proposal.",
      });
      expect(dirtyRunStart.response.statusCode).toBe(202);
      const dirtyRun = await runs.waitForCompletion(dirtyRunStart.body.runId);
      expect(dirtyRun.status).toBe("failed");
      expect(dirtyRun.errorCode).toBe("GIT_DIRTY_CANONICAL");
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(editedContent);

      await git(repositoryRoot, ["add", "README.md"]);
      await git(repositoryRoot, ["commit", "-m", "save reviewed edit"]);

      const successfulRunStart = await request(app, "POST", `/api/projects/${projectId}/runs`, {
        profileId: "fixture",
        selectedCommentIds: [commentId],
        guidance: "Create a review proposal.",
      });
      expect(successfulRunStart.response.statusCode).toBe(202);
      const successfulRun = await runs.waitForCompletion(successfulRunStart.body.runId);
      expect(successfulRun.status).toBe("completed");
      expect(successfulRun.changedFiles).toEqual([{ path: "proposal.md", status: "untracked" }]);
      expect(successfulRun.cleanup.status).toBe("completed");
      await expect(access(path.join(repositoryRoot, "proposal.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(editedContent);

      const runRecord = await request(app, "GET", `/api/runs/${successfulRun.runId}`);
      expect(runRecord.response.statusCode).toBe(200);
      expect(runRecord.body.run.status).toBe("completed");
      const events = await request(app, "GET", `/api/runs/${successfulRun.runId}/events?after=-1`);
      expect(events.response.statusCode).toBe(200);
      expect(events.response.headers["content-type"]).toContain("text/event-stream");
      expect(events.response.body).toContain("run.completed");

      const invalidEventsQuery = await request(app, "GET", `/api/runs/${successfulRun.runId}/events?after=invalid`);
      expect(invalidEventsQuery.response.statusCode).toBe(400);
      expect(invalidEventsQuery.body.error.code).toBe("INVALID_REQUEST");

      const failingRunStart = await request(app, "POST", `/api/projects/${projectId}/runs`, {
        profileId: "failure",
        selectedCommentIds: [commentId],
        guidance: "Fail deterministically for diagnostics coverage",
      });
      expect(failingRunStart.response.statusCode).toBe(202);
      const failingRun = await runs.waitForCompletion(failingRunStart.body.runId);
      expect(failingRun.status).toBe("failed");
      expect(failingRun.errorCode).toBe("PI_EXITED");
      expect(failingRun.diagnostics).toContain("fake Pi failure diagnostics");
      expect(failingRun.cleanup.status).toBe("completed");

      // Review a real detached checkpoint: diff first, edit the proposal, then keep the whole run.
      keptCheckpoint = await new GitCheckpointService().create({ repositoryRoot, runId: `keep-${Date.now()}` });
      const proposalService = new ProposalService({
        proposalStore: new MemoryProposalStore(),
        auditStore: new MemoryProposalAuditStore(),
      });
      const keptProposal = await proposalService.create({
        runId: keptCheckpoint.runId,
        repositoryRoot,
        checkpoint: keptCheckpoint,
      });
      await writeFile(path.join(keptCheckpoint.worktreePath, "README.md"), `${editedContent}Kept by reviewer.\n`, "utf8");
      await writeFile(path.join(keptCheckpoint.worktreePath, "proposal.md"), "proposal body\n", "utf8");
      const diff = await proposalService.refresh(keptProposal.proposalId);
      expect(diff.diff.files).toEqual([
        { path: "README.md", status: "modified" },
        { path: "proposal.md", status: "untracked" },
      ]);
      expect(diff.diff.patch).toContain("proposal.md");
      const proposalDocument = await proposalService.readFile(keptProposal.proposalId, "README.md");
      await proposalService.editFile(keptProposal.proposalId, {
        path: "README.md",
        content: `${proposalDocument.content}Final reviewer edit.\n`,
        baseHash: proposalDocument.hash,
      });
      const kept = await proposalService.keep(keptProposal.proposalId);
      expect(kept.status).toBe("kept");
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(`${editedContent}Kept by reviewer.\nFinal reviewer edit.\n`);
      expect(await readFile(path.join(repositoryRoot, "proposal.md"), "utf8")).toBe("proposal body\n");
      await expect(access(keptCheckpoint.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      keptCheckpoint = undefined;
      await git(repositoryRoot, ["add", "."]);
      await git(repositoryRoot, ["commit", "-m", "keep reviewed proposal"]);

      // Rejecting a second proposal restores the canonical content by leaving it untouched and cleaning the worktree.
      rejectedCheckpoint = await new GitCheckpointService().create({ repositoryRoot, runId: `reject-${Date.now()}` });
      const rejectedProposal = await proposalService.create({
        runId: rejectedCheckpoint.runId,
        repositoryRoot,
        checkpoint: rejectedCheckpoint,
      });
      await writeFile(path.join(rejectedCheckpoint.worktreePath, "README.md"), "discarded proposal\n", "utf8");
      await writeFile(path.join(rejectedCheckpoint.worktreePath, "discarded.md"), "must not reach canonical\n", "utf8");
      const rejected = await proposalService.reject(rejectedProposal.proposalId);
      expect(rejected.status).toBe("rejected");
      expect(await readFile(path.join(repositoryRoot, "README.md"), "utf8")).toBe(`${editedContent}Kept by reviewer.\nFinal reviewer edit.\n`);
      await expect(access(path.join(repositoryRoot, "discarded.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(rejectedCheckpoint.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      rejectedCheckpoint = undefined;
    } finally {
      await keptCheckpoint?.cleanup().catch(() => undefined);
      await rejectedCheckpoint?.cleanup().catch(() => undefined);
      await app.close().catch(() => undefined);
      await rm(dataDirectory, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});
