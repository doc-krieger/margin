import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formatCommandDiagnostics, runCommand, type CommandResult } from "../process/command.js";

export interface GitCommandRunner {
  run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
}

export interface GitCheckpointInput {
  repositoryRoot: string;
  runId?: string;
  worktreeParent?: string;
}

export interface GitCheckpoint {
  runId: string;
  repositoryRoot: string;
  checkpointSha: string;
  checkpointRef: string;
  worktreePath: string;
  cleanup(): Promise<void>;
}

export class GitCheckpointError extends Error {
  constructor(
    public readonly code: "GIT_UNAVAILABLE" | "GIT_NOT_REPOSITORY" | "GIT_DIRTY_CANONICAL" | "GIT_CHECKPOINT_FAILED" | "GIT_WORKTREE_FAILED",
    message: string,
    public readonly diagnostics?: string,
  ) {
    super(message);
    this.name = "GitCheckpointError";
  }
}

const defaultRunner: GitCommandRunner = { run: runCommand };

function assertSuccess(result: CommandResult, code: GitCheckpointError["code"], message: string): string {
  if (result.spawnError) {
    throw new GitCheckpointError(code, `${message}: ${result.spawnError}`, formatCommandDiagnostics(result));
  }
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new GitCheckpointError(code, message, formatCommandDiagnostics(result));
  }
  return result.stdout.trim();
}

function validRunId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

/**
 * Creates a read-only checkpoint ref and a detached worktree. The canonical
 * worktree is required to be clean so no index or working-tree state is
 * modified as part of preparation.
 */
export class GitCheckpointService {
  constructor(private readonly runner: GitCommandRunner = defaultRunner) {}

  async create(input: GitCheckpointInput): Promise<GitCheckpoint> {
    const runId = input.runId ?? randomUUID();
    if (!validRunId(runId)) throw new GitCheckpointError("GIT_CHECKPOINT_FAILED", "runId contains unsafe path characters");

    const repositoryRoot = await realpath(input.repositoryRoot).catch(() => {
      throw new GitCheckpointError("GIT_NOT_REPOSITORY", "Repository root does not exist or cannot be resolved");
    });
    const git = (args: string[], timeoutMs = 15_000) => this.runner.run("git", ["-C", repositoryRoot, ...args], { timeoutMs });

    const rootResult = await git(["rev-parse", "--show-toplevel"]);
    const detectedRoot = assertSuccess(rootResult, "GIT_NOT_REPOSITORY", "Path is not a Git worktree");
    if (path.resolve(detectedRoot) !== path.resolve(repositoryRoot)) {
      throw new GitCheckpointError("GIT_NOT_REPOSITORY", "Repository root resolved to a different worktree", formatCommandDiagnostics(rootResult));
    }

    const statusResult = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const status = assertSuccess(statusResult, "GIT_CHECKPOINT_FAILED", "Unable to inspect canonical worktree");
    if (status.length > 0) {
      throw new GitCheckpointError(
        "GIT_DIRTY_CANONICAL",
        "Canonical worktree has uncommitted changes; checkpointing stopped before touching it",
        formatCommandDiagnostics(statusResult),
      );
    }

    const headResult = await git(["rev-parse", "--verify", "HEAD"]);
    const checkpointSha = assertSuccess(headResult, "GIT_CHECKPOINT_FAILED", "Unable to resolve a canonical Git checkpoint");
    const checkpointRef = `refs/margin/checkpoints/${runId}`;
    const refResult = await git(["update-ref", checkpointRef, checkpointSha]);
    assertSuccess(refResult, "GIT_CHECKPOINT_FAILED", "Unable to persist immutable checkpoint reference");

    const parent = input.worktreeParent
      ? path.resolve(input.worktreeParent)
      : await mkdtemp(path.join(os.tmpdir(), "margin-worktrees-"));
    const worktreePath = path.join(parent, `run-${runId}`);
    let worktreeCreated = false;
    try {
      const worktreeResult = await git(["worktree", "add", "--detach", worktreePath, checkpointRef], 30_000);
      assertSuccess(worktreeResult, "GIT_WORKTREE_FAILED", "Unable to create isolated Git worktree");
      worktreeCreated = true;
    } catch (error) {
      await git(["update-ref", "-d", checkpointRef]).catch(() => undefined);
      if (!input.worktreeParent) await rm(parent, { recursive: true, force: true });
      if (error instanceof GitCheckpointError) throw error;
      throw new GitCheckpointError("GIT_WORKTREE_FAILED", "Unable to create isolated Git worktree", String(error));
    }

    let cleaned = false;
    let cleanupPromise: Promise<void> | undefined;
    return {
      runId,
      repositoryRoot,
      checkpointSha,
      checkpointRef,
      worktreePath,
      cleanup: async () => {
        if (cleaned) return;
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          const failures: string[] = [];
          const cleanupGit = async (args: string[], timeoutMs = 15_000) => {
            try {
              const result = await git(args, timeoutMs);
              if (result.spawnError || result.exitCode !== 0 || result.timedOut || result.aborted) failures.push(formatCommandDiagnostics(result));
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          };
          const worktreeExists = await lstat(worktreePath).then(() => true).catch(() => false);
          if (worktreeCreated && worktreeExists) await cleanupGit(["worktree", "remove", "--force", worktreePath], 30_000);
          try {
            await rm(worktreePath, { recursive: true, force: true });
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
          await cleanupGit(["update-ref", "-d", checkpointRef]);
          await cleanupGit(["worktree", "prune"]);
          if (!input.worktreeParent) {
            try {
              await rm(parent, { recursive: true, force: true });
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (failures.length > 0) throw new GitCheckpointError("GIT_WORKTREE_FAILED", "Checkpoint cleanup completed with failures", failures.join("\n"));
          cleaned = true;
        })();
        try {
          await cleanupPromise;
        } finally {
          if (!cleaned) cleanupPromise = undefined;
        }
      },
    };
  }
}
