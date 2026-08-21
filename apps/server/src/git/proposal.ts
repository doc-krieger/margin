import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { formatCommandDiagnostics, runCommand, type CommandResult } from "../process/command.js";
import type { ChangedFile } from "../../../../packages/shared/src/runs/contracts.js";

export interface GitProposalCommandRunner {
  run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
}

export interface GitProposalWorkspaceInput {
  repositoryRoot: string;
  worktreePath: string;
  checkpointSha: string;
  checkpointRef?: string;
  /** Private worktree paths are reviewable by the executor but never applied canonically. */
  ignoredPaths?: string[];
}

export interface GitProposalFileDiff extends ChangedFile {
  oldPath?: string;
}

export interface GitProposalDiff {
  checkpointSha: string;
  files: ChangedFile[];
  patch: string;
}

export interface GitApplyResult {
  changedFiles: ChangedFile[];
}

export type GitProposalErrorCode =
  | "GIT_PROPOSAL_INVALID"
  | "GIT_PROPOSAL_NOT_FOUND"
  | "GIT_PROPOSAL_DIFF_FAILED"
  | "GIT_PROPOSAL_READ_FAILED"
  | "GIT_PROPOSAL_WRITE_FAILED"
  | "GIT_PROPOSAL_CONFLICT"
  | "GIT_PROPOSAL_APPLY_FAILED"
  | "GIT_PROPOSAL_CLEANUP_FAILED"
  | "GIT_PROPOSAL_UNSAFE_PATH"
  | "GIT_PROPOSAL_LIMIT_EXCEEDED";

export class GitProposalError extends Error {
  constructor(
    public readonly code: GitProposalErrorCode,
    message: string,
    public readonly diagnostics?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GitProposalError";
  }
}

const defaultRunner: GitProposalCommandRunner = { run: runCommand };
const shaPattern = /^[a-f0-9]{7,64}$/i;
const MAX_PROPOSAL_FILES = 10_000;
const MAX_PROPOSAL_FILE_BYTES = 10 * 1024 * 1024;

function commandFailed(result: CommandResult): boolean {
  return Boolean(result.spawnError) || result.exitCode !== 0 || result.timedOut || result.aborted;
}

function assertCommand(result: CommandResult, code: GitProposalErrorCode, message: string): string {
  if (commandFailed(result)) throw new GitProposalError(code, message, formatCommandDiagnostics(result));
  if (result.stdout.includes("[output truncated]")) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `${message}: Git output exceeded the review size limit`, formatCommandDiagnostics(result));
  return result.stdout;
}

function normalizeRelativePath(value: string): string {
  if (
    !value ||
    path.posix.isAbsolute(value) ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value.split("/").includes(".git")
  ) {
    throw new GitProposalError("GIT_PROPOSAL_UNSAFE_PATH", "Proposal paths must be relative and may not address .git");
  }
  return value;
}

function statusFromCode(code: string): ChangedFile["status"] {
  if (code.includes("?")) return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("R")) return "renamed";
  return "modified";
}

function parseNameStatusZ(stdout: string): GitProposalFileDiff[] {
  const tokens = stdout.split("\0").filter(Boolean);
  const files: GitProposalFileDiff[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++];
    const status = statusFromCode(code);
    const firstPath = tokens[index++];
    if (!firstPath) continue;
    if (status === "renamed" && (code.startsWith("R") || code.startsWith("C"))) {
      const nextPath = tokens[index++];
      if (nextPath) files.push({ path: nextPath, oldPath: firstPath, status });
      continue;
    }
    files.push({ path: firstPath, status });
  }
  return files;
}

function parsePorcelainZ(stdout: string): GitProposalFileDiff[] {
  const tokens = stdout.split("\0").filter(Boolean);
  const files: GitProposalFileDiff[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    const code = token.slice(0, 2);
    const firstPath = token.slice(3);
    if (!firstPath) continue;
    const status = statusFromCode(code);
    if (status === "renamed" && (code.startsWith("R") || code.startsWith("C"))) {
      const nextPath = tokens[index++];
      if (nextPath) files.push({ path: nextPath, oldPath: firstPath, status });
      continue;
    }
    files.push({ path: firstPath, status });
  }
  return files;
}

function mergeFiles(diffFiles: GitProposalFileDiff[], statusFiles: GitProposalFileDiff[]): GitProposalFileDiff[] {
  const files = new Map<string, GitProposalFileDiff>();
  for (const file of [...diffFiles, ...statusFiles]) {
    const existing = files.get(file.path);
    if (!existing || existing.status === "untracked") files.set(file.path, file);
  }
  return [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function unifiedUntrackedPatch(relativePath: string, bytes: Buffer): string {
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n`;
  if (bytes.includes(0)) return `${header}Binary files /dev/null and b/${relativePath} differ\n`;
  const text = bytes.toString("utf8");
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const newline = body ? "\n" : "";
  return `${header}--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${body}${newline}${hasTrailingNewline ? "" : "\\ No newline at end of file\n"}`;
}

function isIgnoredPath(relativePath: string, ignoredPaths: string[] = []): boolean {
  return ignoredPaths.some((ignored) => relativePath === ignored || relativePath.startsWith(`${ignored}/`));
}

async function listRegularFiles(root: string, ignoredPaths: string[] = []): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "." || entry.name === ".." || entry.name === ".git") continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      normalizeRelativePath(relativePath);
      if (isIgnoredPath(relativePath, ignoredPaths)) continue;
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new GitProposalError("GIT_PROPOSAL_UNSAFE_PATH", `Proposal contains a symbolic link: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        if (result.length >= MAX_PROPOSAL_FILES) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `Proposal exceeds the ${MAX_PROPOSAL_FILES}-file review limit`);
        result.push(relativePath);
      }
    }
  }
  await walk(root, "");
  return result.sort();
}

async function trackedFiles(runner: GitProposalCommandRunner, input: GitProposalWorkspaceInput): Promise<string[]> {
  const result = await runner.run("git", ["-C", input.worktreePath, "ls-tree", "-r", "-z", "--name-only", input.checkpointSha], { timeoutMs: 15_000 });
  return assertCommand(result, "GIT_PROPOSAL_APPLY_FAILED", "Unable to enumerate checkpoint files").split("\0").filter(Boolean).map(normalizeRelativePath).filter((filePath) => !isIgnoredPath(filePath, input.ignoredPaths));
}

async function removePath(absolutePath: string): Promise<void> {
  const stats = await lstat(absolutePath).catch(() => undefined);
  if (!stats) return;
  if (stats.isSymbolicLink() || stats.isFile()) await unlink(absolutePath);
  else await rm(absolutePath, { recursive: true, force: true });
}

async function assertSafeExistingPath(root: string, relativePath: string): Promise<string> {
  normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new GitProposalError("GIT_PROPOSAL_UNSAFE_PATH", "Proposal path escapes its workspace");
  }
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stats = await lstat(current).catch(() => undefined);
    if (stats?.isSymbolicLink()) throw new GitProposalError("GIT_PROPOSAL_UNSAFE_PATH", `Proposal parent is a symbolic link: ${relativePath}`);
  }
  return absolutePath;
}

/** Git operations shared by proposal review and the run lifecycle. */
export class GitProposalService {
  constructor(private readonly runner: GitProposalCommandRunner = defaultRunner) {}

  async diff(input: GitProposalWorkspaceInput): Promise<GitProposalDiff> {
    const normalized = await this.normalizeInput(input);
    const diffResult = await this.runner.run("git", ["-C", normalized.worktreePath, "diff", "--no-ext-diff", "--binary", "--full-index", "--find-renames", normalized.checkpointSha, "--"], { timeoutMs: 30_000 });
    const nameResult = await this.runner.run("git", ["-C", normalized.worktreePath, "diff", "--name-status", "-z", "--find-renames", normalized.checkpointSha, "--"], { timeoutMs: 15_000 });
    const statusResult = await this.runner.run("git", ["-C", normalized.worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeoutMs: 15_000 });
    const patch = assertCommand(diffResult, "GIT_PROPOSAL_DIFF_FAILED", "Unable to render proposal diff");
    const diffFiles = parseNameStatusZ(assertCommand(nameResult, "GIT_PROPOSAL_DIFF_FAILED", "Unable to inventory proposal diff"));
    const statusFiles = parsePorcelainZ(assertCommand(statusResult, "GIT_PROPOSAL_DIFF_FAILED", "Unable to inventory proposal status"));
    const files = mergeFiles(diffFiles, statusFiles).filter((file) => !isIgnoredPath(file.path, normalized.ignoredPaths));
    if (files.length > MAX_PROPOSAL_FILES) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `Proposal exceeds the ${MAX_PROPOSAL_FILES}-file review limit`);
    const untrackedPatch: string[] = [];
    for (const file of files.filter((candidate) => candidate.status === "untracked")) {
      const filePath = await assertSafeExistingPath(normalized.worktreePath, file.path);
      const stats = await lstat(filePath).catch(() => undefined);
      if (!stats?.isFile()) throw new GitProposalError("GIT_PROPOSAL_DIFF_FAILED", `Proposal file is not a regular file: ${file.path}`);
      if (stats.size > MAX_PROPOSAL_FILE_BYTES) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `Proposal file exceeds the ${MAX_PROPOSAL_FILE_BYTES}-byte review limit: ${file.path}`);
      untrackedPatch.push(unifiedUntrackedPatch(file.path, await readFile(filePath)));
    }
    return {
      checkpointSha: normalized.checkpointSha,
      files: files.map(({ path: filePath, status }) => ({ path: filePath, status })),
      patch: `${patch}${untrackedPatch.join("")}`,
    };
  }

  async readFile(input: GitProposalWorkspaceInput, relativePath: string): Promise<{ path: string; content: string; hash: string }> {
    const filePath = await assertSafeExistingPath((await this.normalizeInput(input)).worktreePath, relativePath);
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
      if (stats.size > MAX_PROPOSAL_FILE_BYTES) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `Proposal file exceeds the ${MAX_PROPOSAL_FILE_BYTES}-byte read limit: ${relativePath}`);
      const content = await readFile(filePath, "utf8");
      return { path: relativePath, content, hash: hashContent(content) };
    } catch (error) {
      if (error instanceof GitProposalError) throw error;
      throw new GitProposalError("GIT_PROPOSAL_READ_FAILED", `Unable to read proposal file: ${relativePath}`, undefined, { cause: error });
    }
  }

  async writeFile(input: GitProposalWorkspaceInput, relativePath: string, content: string): Promise<{ path: string; content: string; hash: string }> {
    const workspace = (await this.normalizeInput(input)).worktreePath;
    const filePath = await assertSafeExistingPath(workspace, relativePath);
    if (Buffer.byteLength(content, "utf8") > MAX_PROPOSAL_FILE_BYTES) throw new GitProposalError("GIT_PROPOSAL_LIMIT_EXCEEDED", `Proposal file exceeds the ${MAX_PROPOSAL_FILE_BYTES}-byte write limit: ${relativePath}`);
    try {
      const parent = path.dirname(filePath);
      await mkdir(parent, { recursive: true });
      const existing = await lstat(filePath).catch(() => undefined);
      if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error("proposal path is not a regular file");
      await writeFile(filePath, content, { encoding: "utf8", mode: existing?.mode ? existing.mode & 0o777 : 0o644 });
      if (existing) await chmod(filePath, existing.mode & 0o777);
      return { path: relativePath, content, hash: hashContent(content) };
    } catch (error) {
      if (error instanceof GitProposalError) throw error;
      throw new GitProposalError("GIT_PROPOSAL_WRITE_FAILED", `Unable to edit proposal file: ${relativePath}`, undefined, { cause: error });
    }
  }

  async assertCanonicalAtCheckpoint(input: GitProposalWorkspaceInput): Promise<void> {
    const normalized = await this.normalizeInput(input);
    const head = await this.runner.run("git", ["-C", normalized.repositoryRoot, "rev-parse", "--verify", "HEAD"], { timeoutMs: 15_000 });
    const currentHead = assertCommand(head, "GIT_PROPOSAL_CONFLICT", "Unable to inspect the canonical Git revision").trim();
    const checkpointHeadResult = await this.runner.run("git", ["-C", normalized.repositoryRoot, "rev-parse", "--verify", `${normalized.checkpointSha}^{commit}`], { timeoutMs: 15_000 });
    const checkpointHead = assertCommand(checkpointHeadResult, "GIT_PROPOSAL_CONFLICT", "Unable to resolve the proposal checkpoint").trim();
    if (currentHead !== checkpointHead) {
      throw new GitProposalError("GIT_PROPOSAL_CONFLICT", "Canonical Git revision changed while the proposal was awaiting review", `expected ${checkpointHead}, found ${currentHead}`);
    }
    const status = await this.runner.run("git", ["-C", normalized.repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 15_000 });
    const output = assertCommand(status, "GIT_PROPOSAL_CONFLICT", "Unable to inspect canonical worktree safety");
    if (output.trim()) throw new GitProposalError("GIT_PROPOSAL_CONFLICT", "Canonical files changed while the proposal was awaiting review", output.trim());
  }

  async apply(input: GitProposalWorkspaceInput): Promise<GitApplyResult> {
    const normalized = await this.normalizeInput(input);
    await this.assertCanonicalAtCheckpoint(normalized);
    const sourceFiles = await listRegularFiles(normalized.worktreePath, normalized.ignoredPaths);
    const baseFiles = await trackedFiles(this.runner, normalized);
    const sourceSet = new Set(sourceFiles);
    const baseSet = new Set(baseFiles);
    try {
      for (const relativePath of baseFiles.filter((filePath) => !sourceSet.has(filePath))) {
        await removePath(await assertSafeExistingPath(normalized.repositoryRoot, relativePath));
      }
      for (const relativePath of sourceFiles) {
        const sourcePath = await assertSafeExistingPath(normalized.worktreePath, relativePath);
        const destinationPath = await assertSafeExistingPath(normalized.repositoryRoot, relativePath);
        const sourceStats = await lstat(sourcePath);
        const destinationStats = await lstat(destinationPath).catch(() => undefined);
        if (destinationStats?.isDirectory() || destinationStats?.isSymbolicLink()) await removePath(destinationPath);
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
        await chmod(destinationPath, sourceStats.mode & 0o777);
      }
    } catch (error) {
      if (error instanceof GitProposalError) throw error;
      throw new GitProposalError("GIT_PROPOSAL_APPLY_FAILED", "Unable to apply the isolated proposal", undefined, { cause: error });
    }
    const diff = await this.diff(normalized);
    return { changedFiles: diff.files };
  }

  async cleanup(input: GitProposalWorkspaceInput): Promise<void> {
    const normalized = await this.normalizeInput(input, true);
    const failures: string[] = [];
    const run = async (args: string[], timeoutMs = 30_000): Promise<void> => {
      try {
        const result = await this.runner.run("git", ["-C", normalized.repositoryRoot, ...args], { timeoutMs });
        if (commandFailed(result)) failures.push(formatCommandDiagnostics(result));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    };
    const worktreeExists = await lstat(normalized.worktreePath).then(() => true).catch(() => false);
    if (worktreeExists) await run(["worktree", "remove", "--force", normalized.worktreePath]);
    try {
      await rm(normalized.worktreePath, { recursive: true, force: true });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (normalized.checkpointRef) await run(["update-ref", "-d", normalized.checkpointRef]);
    await run(["worktree", "prune"]);
    if (failures.length > 0) throw new GitProposalError("GIT_PROPOSAL_CLEANUP_FAILED", "Proposal cleanup completed with failures", failures.join("\n"));
  }

  private async normalizeInput(input: GitProposalWorkspaceInput, allowMissingWorktree = false): Promise<GitProposalWorkspaceInput> {
    if (!input || typeof input !== "object" || !shaPattern.test(input.checkpointSha)) {
      throw new GitProposalError("GIT_PROPOSAL_INVALID", "A valid checkpoint SHA is required");
    }
    const repositoryRoot = await realpath(input.repositoryRoot).catch(() => {
      throw new GitProposalError("GIT_PROPOSAL_NOT_FOUND", "Canonical repository does not exist");
    });
    const worktreePath = allowMissingWorktree
      ? await realpath(input.worktreePath).catch(() => path.resolve(input.worktreePath))
      : await realpath(input.worktreePath).catch(() => {
        throw new GitProposalError("GIT_PROPOSAL_NOT_FOUND", "Isolated proposal worktree does not exist");
      });
    if (repositoryRoot === worktreePath || worktreePath.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new GitProposalError("GIT_PROPOSAL_INVALID", "Proposal worktree must be separate from the canonical repository");
    }
    const ignoredPaths = (input.ignoredPaths ?? []).map((value) => normalizeRelativePath(value));
    return { ...input, repositoryRoot, worktreePath, ignoredPaths };
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export { GitProposalService as ProposalGitService };
