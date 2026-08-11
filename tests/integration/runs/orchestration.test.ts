import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeRunEvent, type CommentRecord } from "../../../packages/shared/src/index.js";
import { MemoryRunEventStore } from "../../../apps/server/src/runs/events.js";
import { MemoryRunRecordStore } from "../../../apps/server/src/runs/store.js";
import { PiProcessError, type PiRunInput } from "../../../apps/server/src/pi/adapter.js";
import { RevisionRunService, type PiProfile, type RunCommandRunner } from "../../../apps/server/src/runs/service.js";
import type { GitCheckpoint } from "../../../apps/server/src/git/checkpoint.js";
import type { CommandResult } from "../../../apps/server/src/process/command.js";

const profile: PiProfile = {
  id: "fixture",
  label: "Fixture Pi",
  status: "available",
  manifest: { command: "fixture-pi", versionArgs: [], runArgs: [], protocol: "jsonl", timeoutMs: 5_000 },
};

function comment(id: string, body: string, projectId = "project-1"): CommentRecord {
  const timestamp = new Date().toISOString();
  return {
    id,
    projectId,
    documentPath: "README.md",
    scope: "document",
    runId: null,
    body,
    state: "open",
    anchor: null,
    anchorStatus: "none",
    anchorConfidence: null,
    orphanReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    addressedAt: null,
    resolvedAt: null,
  };
}

function commandResult(stdout: string): CommandResult {
  const timestamp = new Date().toISOString();
  return { executable: "git", args: [], exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, aborted: false, startedAt: timestamp, endedAt: timestamp, durationMs: 0 };
}

function fakeCommandRunner(root: string): RunCommandRunner {
  return { run: async (_executable, args) => {
    if (args.includes("diff")) return commandResult("M\tREADME.md\nA\tproposal.md\n");
    return commandResult(args[1] === root ? "" : "?? proposal.md\n");
  } };
}

async function fakeCheckpoint(root: string, shouldCleanupFail = false): Promise<GitCheckpoint> {
  const worktreePath = await mkdtemp(path.join(tmpdir(), "margin-fixture-worktree-"));
  await writeFile(path.join(worktreePath, "README.md"), "canonical fixture\n", "utf8");
  return {
    runId: "fixture",
    repositoryRoot: root,
    checkpointSha: "a".repeat(40),
    checkpointRef: "refs/margin/checkpoints/fixture",
    worktreePath,
    cleanup: async () => {
      if (shouldCleanupFail) throw new Error("fixture cleanup failed");
      await rm(worktreePath, { recursive: true, force: true });
    },
  };
}

function baseOptions(root: string, piExecutor: RevisionRunServiceOptionsPi): ConstructorParameters<typeof RevisionRunService>[0] {
  return {
    profiles: [profile],
    eventStore: new MemoryRunEventStore(),
    recordStore: new MemoryRunRecordStore(),
    checkpointService: { create: async () => fakeCheckpoint(root, piExecutor.cleanupFailure) },
    piExecutor: piExecutor.executor,
    commandRunner: fakeCommandRunner(root),
  };
}

type RevisionRunServiceOptionsPi = {
  executor: { run: (manifest: PiProfile["manifest"], input: PiRunInput, events: MemoryRunEventStore | any) => Promise<any> };
  cleanupFailure?: boolean;
};

describe("isolated revision run orchestration", () => {
  it("scopes the instruction manifest and persists checkpoint, events, changed files, and cleanup without touching canonical files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-fixture-project-"));
    const canonical = "canonical fixture\n";
    await writeFile(path.join(root, "README.md"), canonical, "utf8");
    let prompt = "";
    const executor = {
      run: async (_manifest: PiProfile["manifest"], input: PiRunInput, events: MemoryRunEventStore) => {
        prompt = input.prompt;
        await writeFile(path.join(input.cwd, "proposal.md"), "isolated proposal\n", "utf8");
        await events.append(makeRunEvent(input.runId, input.correlationId, input.eventSequenceStart ?? 0, "pi.event", { phase: "fixture-edit" }));
        return { runId: input.runId, correlationId: input.correlationId, exitCode: 0, events: [], durationMs: 1 };
      },
    };
    const service = new RevisionRunService(baseOptions(root, { executor }));

    const initial = await service.start({
      projectId: "project-1",
      repositoryRoot: root,
      profileId: "fixture",
      selectedCommentIds: ["comment-1"],
      comments: [comment("comment-1", "Update the title"), comment("comment-2", "Do not include this")],
      guidance: "Keep the proposal concise.",
      correlationId: randomUUID(),
    });
    const final = await service.waitForCompletion(initial.runId);

    expect(final.status).toBe("completed");
    expect(final.profileId).toBe("fixture");
    expect(final.checkpoint?.sha).toBe("a".repeat(40));
    expect(final.manifest?.comments.map((item) => item.id)).toEqual(["comment-1"]);
    expect(final.manifest?.guidance).toBe("Keep the proposal concise.");
    expect(final.changedFiles).toEqual([
      { path: "proposal.md", status: "untracked" },
      { path: "README.md", status: "modified" },
    ]);
    expect(final.cleanup.status).toBe("completed");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe(canonical);
    await expect(access(final.checkpoint!.worktreePath)).rejects.toThrow();

    const promptManifest = JSON.parse(prompt.split("\n").at(-1)!);
    expect(promptManifest.comments.map((item: { id: string }) => item.id)).toEqual(["comment-1"]);
    const events = await service.events(initial.runId);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(events[0].type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect((await service.events(initial.runId, 0)).every((event) => event.sequence > 0)).toBe(true);
  });

  it("fails schema-invalid selections before creating a checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-fixture-project-"));
    let checkpointCalls = 0;
    const options = baseOptions(root, { executor: { run: async () => ({ runId: "unused", correlationId: randomUUID(), exitCode: 0, events: [], durationMs: 0 }) } });
    options.checkpointService = { create: async () => { checkpointCalls += 1; return fakeCheckpoint(root); } };
    const service = new RevisionRunService(options);
    const started = await service.start({ projectId: "project-1", repositoryRoot: root, profileId: "fixture", selectedCommentIds: ["missing"], comments: [] });
    const failed = await service.waitForCompletion(started.runId);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("RUN_FAILED");
    expect(failed.diagnostics).toContain("Selected comment missing was not found");
    expect(checkpointCalls).toBe(0);
  });

  it("cancels a running Pi process, records bounded diagnostics, and cleans the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-fixture-project-"));
    const entered = new Promise<void>((resolve) => setTimeout(resolve, 0));
    const executor = {
      run: async (_manifest: PiProfile["manifest"], input: PiRunInput, events: MemoryRunEventStore) => {
        await events.append(makeRunEvent(input.runId, input.correlationId, input.eventSequenceStart ?? 0, "pi.event", { phase: "waiting" }));
        await entered;
        await new Promise<never>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new PiProcessError("PI_CANCELLED", "fixture cancelled", "fixture cancellation")), { once: true }));
        throw new Error("unreachable");
      },
    };
    const service = new RevisionRunService(baseOptions(root, { executor }));
    const started = await service.start({ projectId: "project-1", repositoryRoot: root, profileId: "fixture", selectedCommentIds: ["comment-1"], comments: [comment("comment-1", "Cancel safely")] });
    while ((await service.get(started.runId)).status !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
    const cancelled = await service.cancel(started.runId);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).toBe("PI_CANCELLED");
    expect(cancelled.diagnostics).toContain("fixture cancellation");
    expect(cancelled.cleanup.status).toBe("completed");
    expect((await service.events(started.runId)).at(-1)?.type).toBe("run.cancelled");
  });

  it("retains failure and cleanup diagnostics when an external cleanup dependency fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-fixture-project-"));
    const executor = {
      run: async () => { throw new PiProcessError("PI_PROTOCOL_ERROR", "fixture protocol error", "malformed JSONL fixture"); },
    };
    const service = new RevisionRunService(baseOptions(root, { executor, cleanupFailure: true }));
    const started = await service.start({ projectId: "project-1", repositoryRoot: root, profileId: "fixture", selectedCommentIds: ["comment-1"], comments: [comment("comment-1", "Fail visibly")] });
    const failed = await service.waitForCompletion(started.runId);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("PI_PROTOCOL_ERROR");
    expect(failed.diagnostics).toContain("malformed JSONL fixture");
    expect(failed.cleanup.status).toBe("failed");
    expect(failed.cleanup.diagnostics).toContain("fixture cleanup failed");
    expect((await service.events(started.runId)).at(-1)?.type).toBe("run.failed");
  });
});
