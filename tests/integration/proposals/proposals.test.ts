import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCheckpointService } from "../../../apps/server/src/git/checkpoint.js";
import { runCommand } from "../../../apps/server/src/process/command.js";
import {
  MemoryProposalAuditStore,
  MemoryProposalStore,
  ProposalConflictError,
  ProposalService,
  type ProposalCleanup,
} from "../../../apps/server/src/proposals/index.js";

async function git(root: string, args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", root, ...args]);
  if (result.exitCode !== 0 || result.spawnError) throw new Error(`${args.join(" ")}: ${result.stderr || result.spawnError || "git failed"}`);
  return result.stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "margin-proposals-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "margin@example.test"]);
  await git(root, ["config", "user.name", "Margin Test"]);
  await writeFile(path.join(root, "README.md"), "canonical title\n", "utf8");
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "keep.md"), "keep this file\n", "utf8");
  await writeFile(path.join(root, "notes", "remove.md"), "remove this file\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  const checkpoint = await new GitCheckpointService().create({ repositoryRoot: root, runId: `run-${Date.now()}` });
  return { root, checkpoint };
}

function service() {
  return new ProposalService({
    proposalStore: new MemoryProposalStore(),
    auditStore: new MemoryProposalAuditStore(),
  });
}

async function openProposal() {
  const fixture = await repositoryFixture();
  const proposalService = service();
  const proposal = await proposalService.create({
    runId: fixture.checkpoint.runId,
    repositoryRoot: fixture.root,
    checkpoint: fixture.checkpoint,
  });
  return { ...fixture, proposalService, proposal };
}

describe("whole-run proposal review", () => {
  it("preserves proposal ownership when creation audit persistence fails", async () => {
    const fixture = await repositoryFixture();
    let auditAttempts = 0;
    const proposalService = new ProposalService({
      proposalStore: new MemoryProposalStore(),
      auditStore: {
        append: async () => {
          auditAttempts += 1;
          if (auditAttempts === 1) throw new Error("audit unavailable");
        },
        list: async () => [],
      },
    });

    const proposal = await proposalService.create({ runId: fixture.checkpoint.runId, repositoryRoot: fixture.root, checkpoint: fixture.checkpoint });
    await expect(access(fixture.checkpoint.worktreePath)).resolves.toBeUndefined();
    expect((await proposalService.get(proposal.proposalId)).status).toBe("pending");
    await proposalService.reject(proposal.proposalId);
    await expect(access(fixture.checkpoint.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("reports a complete checkpoint-to-worktree diff and changed-file inventory", async () => {
    const { checkpoint, proposalService, proposal } = await openProposal();
    await writeFile(path.join(checkpoint.worktreePath, "README.md"), "proposal title\n", "utf8");
    await unlink(path.join(checkpoint.worktreePath, "notes", "remove.md"));
    await writeFile(path.join(checkpoint.worktreePath, "proposal.md"), "new proposal\n", "utf8");

    const refreshed = await proposalService.refresh(proposal.proposalId);

    expect(refreshed.diff.files).toEqual([
      { path: "README.md", status: "modified" },
      { path: "notes/remove.md", status: "deleted" },
      { path: "proposal.md", status: "untracked" },
    ]);
    expect(refreshed.diff.patch).toContain("README.md");
    expect(refreshed.diff.patch).toContain("notes/remove.md");
    expect(refreshed.diff.patch).toContain("proposal.md");
    await proposalService.reject(proposal.proposalId);
    await rm(checkpoint.worktreePath, { recursive: true, force: true });
  });

  it("edits the isolated proposal and keeps the entire run", async () => {
    const { root, checkpoint, proposalService, proposal } = await openProposal();
    const before = await proposalService.readFile(proposal.proposalId, "README.md");
    await proposalService.editFile(proposal.proposalId, {
      path: "README.md",
      content: `${before.content}edited by reviewer\n`,
      baseHash: before.hash,
    });
    const kept = await proposalService.keep(proposal.proposalId);

    expect(kept.status).toBe("kept");
    expect(kept.decision).toBe("keep");
    expect(kept.diff.files).toEqual([{ path: "README.md", status: "modified" }]);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("canonical title\nedited by reviewer\n");
    await expect(access(checkpoint.worktreePath)).rejects.toThrow();
    expect((await proposalService.audit(proposal.proposalId)).map((entry) => entry.action)).toEqual([
      "created",
      "edited",
      "keep",
      "kept",
      "cleanup.started",
      "cleanup.completed",
    ]);
  });

  it("rejects stale isolated edits and unsafe proposal paths", async () => {
    const { checkpoint, proposalService, proposal } = await openProposal();
    const before = await proposalService.readFile(proposal.proposalId, "README.md");
    await writeFile(path.join(checkpoint.worktreePath, "README.md"), "another reviewer edit\n", "utf8");

    await expect(proposalService.editFile(proposal.proposalId, { path: "README.md", content: "stale edit\n", baseHash: before.hash })).rejects.toBeInstanceOf(ProposalConflictError);
    await expect(proposalService.editFile(proposal.proposalId, { path: "../escape.md", content: "unsafe\n" })).rejects.toMatchObject({ code: "GIT_PROPOSAL_UNSAFE_PATH" });
    await proposalService.reject(proposal.proposalId);
  });

  it("rejects the whole run without changing canonical files", async () => {
    const { root, checkpoint, proposalService, proposal } = await openProposal();
    await writeFile(path.join(checkpoint.worktreePath, "README.md"), "discarded proposal\n", "utf8");
    const rejected = await proposalService.reject(proposal.proposalId);

    expect(rejected.status).toBe("rejected");
    expect(rejected.decision).toBe("reject");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("canonical title\n");
    await expect(access(checkpoint.worktreePath)).rejects.toThrow();
  });

  it("records a canonical concurrent-change conflict and never overwrites it", async () => {
    const { root, checkpoint, proposalService, proposal } = await openProposal();
    await writeFile(path.join(checkpoint.worktreePath, "README.md"), "proposal\n", "utf8");
    await writeFile(path.join(root, "README.md"), "concurrent canonical edit\n", "utf8");

    await expect(proposalService.keep(proposal.proposalId)).rejects.toBeInstanceOf(ProposalConflictError);
    const conflicted = await proposalService.get(proposal.proposalId);
    expect(conflicted.status).toBe("conflict");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("concurrent canonical edit\n");
    expect((await proposalService.audit(proposal.proposalId)).some((entry) => entry.action === "conflict")).toBe(true);
  });

  it("persists failed cleanup and allows a later recovery retry", async () => {
    const { checkpoint, proposalService, proposal } = await openProposal();
    let cleanupAttempts = 0;
    const cleanup: ProposalCleanup = async () => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("temporary cleanup outage");
      await rm(checkpoint.worktreePath, { recursive: true, force: true });
    };
    await proposalService.attachCleanup(proposal.proposalId, cleanup);
    const kept = await proposalService.keep(proposal.proposalId);

    expect(kept.status).toBe("kept");
    expect(kept.cleanup.status).toBe("failed");
    expect(kept.cleanup.diagnostics).toContain("temporary cleanup outage");
    const recovered = await proposalService.retryCleanup(proposal.proposalId);
    expect(recovered.cleanup.status).toBe("completed");
    expect(cleanupAttempts).toBe(2);
  });

  it("reloads decision and audit state from the file-backed stores", async () => {
    const fixture = await repositoryFixture();
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "margin-proposal-records-"));
    const first = new ProposalService({ dataDirectory });
    const created = await first.create({ runId: fixture.checkpoint.runId, repositoryRoot: fixture.root, checkpoint: fixture.checkpoint });
    const reloaded = new ProposalService({ dataDirectory });

    expect((await reloaded.get(created.proposalId)).status).toBe("pending");
    const rejected = await reloaded.reject(created.proposalId);
    expect(rejected.status).toBe("rejected");
    expect((await new ProposalService({ dataDirectory }).get(created.proposalId)).cleanup.status).toBe("completed");
    expect((await new ProposalService({ dataDirectory }).audit(created.proposalId)).map((entry) => entry.action)).toContain("rejected");
  });
});
