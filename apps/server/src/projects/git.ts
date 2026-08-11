import path from "node:path";
import { lstat } from "node:fs/promises";
import { runCommand, type CommandResult } from "../process/command.js";

export interface GitInitializationRunner {
  run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
}

export type GitInitializationErrorCode = "GIT_INITIALIZATION_FAILED";

export class GitInitializationError extends Error {
  constructor(public readonly code: GitInitializationErrorCode, message: string, public readonly diagnostics?: CommandResult) {
    super(message);
    this.name = "GitInitializationError";
  }
}

/** The project lifecycle only treats a .git directory/file at the project root as initialized. */
export class GitInitializationService {
  constructor(private readonly runner: GitInitializationRunner = { run: runCommand }) {}

  async isInitialized(projectPath: string): Promise<boolean> {
    try {
      const stats = await lstat(path.join(projectPath, ".git"));
      return stats.isDirectory() || stats.isFile();
    } catch {
      return false;
    }
  }

  async initialize(projectPath: string): Promise<void> {
    const result = await this.runner.run("git", ["init"], { cwd: projectPath, timeoutMs: 30_000 });
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.spawnError || !(await this.isInitialized(projectPath))) {
      const detail = result.stderr.trim() || result.spawnError || "git init did not create a repository";
      throw new GitInitializationError("GIT_INITIALIZATION_FAILED", `Git initialization failed: ${detail}`, result);
    }
  }
}
