import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitCheckpointError, GitCheckpointService } from "../../../apps/server/src/git/checkpoint.js";
import { runCommand } from "../../../apps/server/src/process/command.js";
import { FileRunEventStore } from "../../../apps/server/src/runs/events.js";
import { PiProcessError, runPiProcess } from "../../../apps/server/src/pi/adapter.js";
import { discoverPiProfile, piProfileManifestSchema, type PiProfileManifest } from "../../../apps/server/src/pi/manifest.js";

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

async function git(repo: string, args: string[]) {
  const result = await runCommand("git", ["-C", repo, ...args]);
  expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function disposableRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "margin-git-pi-"));
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "margin-tests@example.invalid"]);
  await git(repo, ["config", "user.name", "Margin Tests"]);
  await writeFile(path.join(repo, "canonical.md"), "# Canonical\n\nKeep this file unchanged.\n", "utf8");
  await git(repo, ["add", "canonical.md"]);
  await git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

function fakeManifest(...args: string[]): PiProfileManifest {
  return piProfileManifestSchema.parse({
    command: process.execPath,
    versionArgs: ["-e", "process.stdout.write('fake-pi 1.0.0\\n')"],
    runArgs: [fakePi, ...args],
    protocol: "jsonl",
    timeoutMs: 5_000,
  });
}

describe("disposable Git and Pi integration", () => {
  it("creates an immutable checkpoint, edits only the detached worktree, and persists lifecycle events", async () => {
    const repo = await disposableRepo();
    const eventRoot = await mkdtemp(path.join(os.tmpdir(), "margin-events-"));
    const canonicalBefore = await readFile(path.join(repo, "canonical.md"), "utf8");
    const runId = `run-${randomUUID()}`;
    const correlationId = randomUUID();
    const checkpoint = await new GitCheckpointService().create({ repositoryRoot: repo, runId });
    const store = new FileRunEventStore(eventRoot);

    try {
      expect(checkpoint.checkpointSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await git(repo, ["rev-parse", checkpoint.checkpointRef])).toBe(checkpoint.checkpointSha);
      const result = await runPiProcess(fakeManifest("--write", "proposal.md"), {
        runId,
        correlationId,
        cwd: checkpoint.worktreePath,
        prompt: "Draft a proposal",
      }, store);

      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(checkpoint.worktreePath, "proposal.md"), "utf8")).toBe("proposal\n");
      expect(await readFile(path.join(repo, "canonical.md"), "utf8")).toBe(canonicalBefore);
      await expect(access(path.join(repo, "proposal.md"))).rejects.toMatchObject({ code: "ENOENT" });

      const events = await store.list(runId);
      expect(events.map((event) => event.type)).toEqual(["run.started", "pi.event", "run.completed"]);
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
      expect(new Set(events.map((event) => event.correlationId))).toEqual(new Set([correlationId]));
    } finally {
      await checkpoint.cleanup();
      await rm(eventRoot, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns an actionable unavailable state when the executable cannot be spawned", async () => {
    const result = await discoverPiProfile({
      manifest: fakeManifest(),
      runner: {
        run: () => runCommand("margin-command-that-does-not-exist", ["--version"]),
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("unavailable");
    expect(result.diagnostics).toContain("spawnError");
  });

  it("preserves stderr diagnostics and terminal failure events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "margin-pi-failure-"));
    const store = new FileRunEventStore(path.join(root, "events"));
    const runId = `failure-${randomUUID()}`;
    try {
      await expect(runPiProcess(fakeManifest("--fail"), {
        runId,
        correlationId: randomUUID(),
        cwd: root,
        prompt: "fail deterministically",
      }, store)).rejects.toMatchObject({ code: "PI_EXITED", diagnostics: expect.stringContaining("fake Pi failure diagnostics") });
      expect((await store.list(runId)).at(-1)?.type).toBe("run.failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures cancellation and does not wait for a long-running subprocess", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "margin-pi-cancel-"));
    const store = new FileRunEventStore(path.join(root, "events"));
    const controller = new AbortController();
    const runId = `cancel-${randomUUID()}`;
    try {
      const pending = runPiProcess(fakeManifest("--sleep"), {
        runId,
        correlationId: randomUUID(),
        cwd: root,
        prompt: "cancel deterministically",
        signal: controller.signal,
      }, store);
      setTimeout(() => controller.abort(), 40);
      await expect(pending).rejects.toMatchObject({ code: "PI_CANCELLED", diagnostics: expect.stringContaining("aborted: true") });
      expect((await store.list(runId)).at(-1)?.type).toBe("run.cancelled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a dirty canonical worktree before creating a lease", async () => {
    const repo = await disposableRepo();
    try {
      await writeFile(path.join(repo, "canonical.md"), "changed\n", "utf8");
      await expect(new GitCheckpointService().create({ repositoryRoot: repo, runId: `dirty-${randomUUID()}` })).rejects.toMatchObject<GitCheckpointError>({
        code: "GIT_DIRTY_CANONICAL",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
