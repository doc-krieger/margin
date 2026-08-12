import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { runCommand, type CommandResult } from "../process/command.js";
import { GitCheckpointService, type GitCheckpoint } from "../git/checkpoint.js";
import { runPiProcess, PiProcessError, type PiRunInput, type PiRunResult } from "../pi/adapter.js";
import { defaultPiProfileManifest, parsePiProfileManifest, type PiProfileManifest } from "../pi/manifest.js";
import { ProposalService } from "../proposals/service.js";
import {
  isTerminalRunStatus,
  makeRunEvent,
  revisionRunRecordSchema,
  runIdSchema,
  startRevisionRunInputSchema,
  type ChangedFile,
  type RevisionRunRecord,
  type RunEvent,
  type RunStatus,
} from "../../../../packages/shared/src/runs/contracts.js";
import type { CommentRecord } from "../../../../packages/shared/src/comments/contracts.js";
import { renderInstructionPrompt, buildInstructionManifest } from "./manifest.js";
import { FileRunEventStore, type RunEventStore } from "./events.js";
import { FileRunRecordStore, type RunRecordStore } from "./store.js";

const MAX_DIAGNOSTICS = 32_000;

type RunClock = () => Date;

export interface PiProfile {
  id: string;
  label?: string;
  status: "available" | "unavailable";
  manifest: PiProfileManifest;
  version?: string;
  message?: string;
  diagnostics?: string;
}

export interface PiExecutor {
  run(manifest: PiProfileManifest, input: PiRunInput, eventStore: RunEventStore): Promise<PiRunResult>;
}

export interface CheckpointCreator {
  create(input: { repositoryRoot: string; runId: string; worktreeParent?: string }): Promise<GitCheckpoint>;
}

export interface RunCommandRunner {
  run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
}

export interface RunProposalCreator {
  createFromRun(input: {
    runId: string;
    repositoryRoot: string;
    checkpoint: { sha: string; ref: string; worktreePath: string };
    cleanup?: () => Promise<void>;
  }): Promise<{ proposalId: string }>;
}

export interface RevisionRunServiceOptions {
  profiles?: PiProfile[];
  eventStore?: RunEventStore;
  recordStore?: RunRecordStore;
  checkpointService?: CheckpointCreator;
  piExecutor?: PiExecutor;
  commandRunner?: RunCommandRunner;
  proposalService?: RunProposalCreator;
  dataDirectory?: string;
  clock?: RunClock;
}

export interface StartRevisionRunOptions {
  projectId: string;
  repositoryRoot: string;
  profileId: string;
  selectedCommentIds: string[];
  comments: CommentRecord[];
  guidance?: string;
  correlationId?: string;
  worktreeParent?: string;
}

export class RevisionRunError extends Error {
  constructor(
    public readonly code: "RUN_NOT_FOUND" | "PI_PROFILE_NOT_FOUND" | "PI_UNAVAILABLE" | "RUN_ALREADY_EXISTS" | "RUN_NOT_CANCELLABLE",
    message: string,
  ) {
    super(message);
    this.name = "RevisionRunError";
  }
}

interface ActiveRun {
  controller: AbortController;
  completion: Promise<RevisionRunRecord>;
}

function now(clock: RunClock): string {
  return clock().toISOString();
}

function bounded(value: string, max = MAX_DIAGNOSTICS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 32))}\n[diagnostics truncated]`;
}

function errorDetails(error: unknown): { code: string; diagnostics: string } {
  if (error instanceof PiProcessError) return { code: error.code, diagnostics: bounded(error.diagnostics || error.message) };
  const candidate = error as { code?: unknown; diagnostics?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "RUN_FAILED";
  const diagnostics = typeof candidate?.diagnostics === "string" ? candidate.diagnostics : error instanceof Error ? error.stack ?? error.message : String(error);
  return { code, diagnostics: bounded(diagnostics) };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof PiProcessError && error.code === "PI_CANCELLED");
}

function initialRecord(input: StartRevisionRunOptions, runId: string, correlationId: string, createdAt: string): RevisionRunRecord {
  return revisionRunRecordSchema.parse({
    runId,
    correlationId,
    projectId: input.projectId,
    repositoryRoot: input.repositoryRoot,
    profileId: input.profileId,
    status: "queued",
    createdAt,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    checkpoint: null,
    proposalId: null,
    manifest: null,
    changedFiles: [],
    diagnostics: null,
    errorCode: null,
    cleanup: { status: "pending", startedAt: null, endedAt: null, diagnostics: null },
  });
}

function parseStatusOutput(stdout: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const payload = line.slice(2).trim();
    if (!payload) continue;
    const status = code.includes("?") ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code.includes("R") ? "renamed" : "modified";
    const filePath = status === "renamed" && payload.includes(" -> ") ? payload.split(" -> ").at(-1)! : payload;
    files.set(filePath, { path: filePath, status });
  }
  return [...files.values()];
}

function parseDiffOutput(stdout: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [code, ...parts] = line.split(/\t+/);
    const payload = parts.join("\t").trim();
    if (!payload) continue;
    const status = code.startsWith("D") ? "deleted" : code.startsWith("A") ? "added" : code.startsWith("R") ? "renamed" : "modified";
    const filePath = status === "renamed" && payload.includes("\t") ? payload.split("\t").at(-1)! : payload;
    files.set(filePath, { path: filePath, status });
  }
  return [...files.values()];
}

export class RevisionRunService {
  private readonly profiles = new Map<string, PiProfile>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly subscribers = new Map<string, Set<(event: RunEvent) => void>>();
  private readonly eventStore: RunEventStore;
  private readonly executorEventStore: RunEventStore;
  private readonly recordStore: RunRecordStore;
  private readonly checkpointService: CheckpointCreator;
  private readonly piExecutor: PiExecutor;
  private readonly commandRunner: RunCommandRunner;
  private readonly proposalService: RunProposalCreator;
  private readonly clock: RunClock;

  constructor(options: RevisionRunServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    const dataDirectory = options.dataDirectory ?? process.env.MARGIN_RUN_DATA_DIR ?? path.join(homedir(), ".margin", "runs");
    this.eventStore = options.eventStore ?? new FileRunEventStore(path.join(dataDirectory, "events"));
    this.executorEventStore = {
      append: (event) => this.appendEvent(event),
      list: (runId) => this.eventStore.list(runId),
    };
    this.recordStore = options.recordStore ?? new FileRunRecordStore(path.join(dataDirectory, "records"));
    this.checkpointService = options.checkpointService ?? new GitCheckpointService();
    this.piExecutor = options.piExecutor ?? { run: runPiProcess };
    this.commandRunner = options.commandRunner ?? { run: runCommand };
    this.proposalService = options.proposalService ?? new ProposalService({ dataDirectory: path.join(dataDirectory, "proposals") });
    const configuredProfiles = options.profiles ?? [{ id: "default", label: "Pi", status: "available" as const, manifest: defaultPiProfileManifest() }];
    for (const profile of configuredProfiles) {
      const manifest = parsePiProfileManifest(profile.manifest);
      this.profiles.set(profile.id, { ...profile, manifest });
    }
  }

  listProfiles(): PiProfile[] {
    return [...this.profiles.values()].map((profile) => ({ ...profile, manifest: { ...profile.manifest, runArgs: [...profile.manifest.runArgs], versionArgs: [...profile.manifest.versionArgs] } }));
  }

  getProfile(profileId: string): PiProfile | undefined {
    return this.profiles.get(profileId);
  }

  async get(runId: string): Promise<RevisionRunRecord> {
    runIdSchema.parse(runId);
    const record = await this.recordStore.get(runId);
    if (!record) throw new RevisionRunError("RUN_NOT_FOUND", `Run ${runId} was not found`);
    return record;
  }

  async list(projectId?: string): Promise<RevisionRunRecord[]> {
    return this.recordStore.list(projectId);
  }

  async recordProposalCleanup(runId: string, cleanup: RevisionRunRecord["cleanup"]): Promise<RevisionRunRecord> {
    const record = await this.get(runId);
    return this.save({ ...record, cleanup });
  }

  async events(runId: string, after = -1): Promise<RunEvent[]> {
    const record = await this.get(runId);
    await this.ensureTerminalEvent(record);
    return (await this.eventStore.list(runId)).filter((event) => event.sequence > after);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<(event: RunEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  async start(input: StartRevisionRunOptions): Promise<RevisionRunRecord> {
    const parsed = startRevisionRunInputSchema.parse({
      projectId: input.projectId,
      repositoryRoot: input.repositoryRoot,
      profileId: input.profileId,
      selectedCommentIds: input.selectedCommentIds,
      guidance: input.guidance ?? "",
      correlationId: input.correlationId,
    });
    const profile = this.profiles.get(parsed.profileId);
    if (!profile) throw new RevisionRunError("PI_PROFILE_NOT_FOUND", `Pi profile ${parsed.profileId} is not configured`);
    const runId = randomUUID();
    const createdAt = now(this.clock);
    const record = initialRecord({ ...input, ...parsed }, runId, parsed.correlationId ?? randomUUID(), createdAt);
    await this.recordStore.save(record);
    const controller = new AbortController();
    const completion = this.execute(record, { ...input, ...parsed, correlationId: record.correlationId }, profile, controller.signal);
    this.active.set(runId, { controller, completion });
    void completion.finally(() => {
      const current = this.active.get(runId);
      if (current?.completion === completion) this.active.delete(runId);
    }).catch(() => undefined);
    return record;
  }

  async waitForCompletion(runId: string): Promise<RevisionRunRecord> {
    const current = this.active.get(runId);
    if (current) return current.completion;
    const record = await this.get(runId);
    if (isTerminalRunStatus(record.status)) return record;
    throw new Error(`Run ${runId} has no active execution`);
  }

  async cancel(runId: string): Promise<RevisionRunRecord> {
    const record = await this.get(runId);
    if (isTerminalRunStatus(record.status)) throw new RevisionRunError("RUN_NOT_CANCELLABLE", `Run ${runId} is already ${record.status}`);
    const current = this.active.get(runId);
    if (!current) throw new RevisionRunError("RUN_NOT_CANCELLABLE", `Run ${runId} is not active`);
    current.controller.abort();
    return current.completion;
  }

  private async appendEvent(event: RunEvent): Promise<void> {
    await this.eventStore.append(event);
    for (const listener of this.subscribers.get(event.runId) ?? []) listener(event);
  }

  private async emit(record: RevisionRunRecord, type: RunEvent["type"], payload: Record<string, unknown>): Promise<RunEvent> {
    const existing = await this.eventStore.list(record.runId);
    const event = makeRunEvent(record.runId, record.correlationId, (existing.at(-1)?.sequence ?? -1) + 1, type, payload);
    await this.appendEvent(event);
    return event;
  }

  private async ensureTerminalEvent(record: RevisionRunRecord): Promise<void> {
    if (!isTerminalRunStatus(record.status)) return;
    const events = await this.eventStore.list(record.runId);
    if (events.some((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled")) return;
    if (record.status === "completed") {
      await this.emit(record, "run.completed", { changedFiles: record.changedFiles, durationMs: record.durationMs, proposalId: record.proposalId });
    } else {
      await this.emit(record, record.status === "cancelled" ? "run.cancelled" : "run.failed", { code: record.errorCode, diagnostics: record.diagnostics });
    }
  }

  private async save(record: RevisionRunRecord): Promise<RevisionRunRecord> {
    const parsed = revisionRunRecordSchema.parse(record);
    await this.recordStore.save(parsed);
    return parsed;
  }

  private async assertCanonicalUntouched(repositoryRoot: string): Promise<void> {
    const status = await this.commandRunner.run("git", ["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 15_000 });
    if (status.spawnError || status.exitCode !== 0 || status.timedOut || status.aborted) throw new Error(`Unable to verify canonical worktree safety: ${status.stderr || status.spawnError || "git status failed"}`);
    if (status.stdout.trim()) throw new Error(`Canonical worktree changed during run:\n${bounded(status.stdout.trim())}`);
  }

  private async diffWorktree(checkpoint: GitCheckpoint): Promise<ChangedFile[]> {
    const diff = await this.commandRunner.run("git", ["-C", checkpoint.worktreePath, "diff", "--name-status", checkpoint.checkpointSha, "--"], { timeoutMs: 15_000 });
    if (diff.spawnError || diff.exitCode !== 0 || diff.timedOut || diff.aborted) throw new Error(`Unable to inspect worktree diff: ${diff.stderr || diff.spawnError || "git diff failed"}`);
    const status = await this.commandRunner.run("git", ["-C", checkpoint.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 15_000 });
    if (status.spawnError || status.exitCode !== 0 || status.timedOut || status.aborted) throw new Error(`Unable to inspect worktree status: ${status.stderr || status.spawnError || "git status failed"}`);
    const files = new Map<string, ChangedFile>();
    for (const file of [...parseDiffOutput(diff.stdout), ...parseStatusOutput(status.stdout)]) files.set(file.path, file);
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async execute(initial: RevisionRunRecord, input: StartRevisionRunOptions, profile: PiProfile, signal: AbortSignal): Promise<RevisionRunRecord> {
    const startedAtMs = this.clock().getTime();
    let record = initial;
    let checkpoint: GitCheckpoint | undefined;
    let checkpointTransferred = false;
    let transferredProposalId: string | null = null;
    try {
      await this.emit(record, "run.started", { status: "checkpointing", profileId: profile.id });
      record = await this.save({ ...record, status: "checkpointing", startedAt: now(this.clock) });
      if (profile.status === "unavailable") throw new RevisionRunError("PI_UNAVAILABLE", profile.message ?? `Pi profile ${profile.id} is unavailable`);
      if (signal.aborted) throw new PiProcessError("PI_CANCELLED", "Run cancelled before checkpoint creation", "aborted: true");
      // Validate selection and payload bounds before creating any Git state.
      buildInstructionManifest({
        runId: record.runId,
        correlationId: record.correlationId,
        projectId: input.projectId,
        profileId: profile.id,
        checkpointSha: "a".repeat(40),
        checkpointRef: `refs/margin/checkpoints/${record.runId}`,
        selectedCommentIds: input.selectedCommentIds,
        comments: input.comments,
        guidance: input.guidance,
      });

      checkpoint = await this.checkpointService.create({ repositoryRoot: input.repositoryRoot, runId: record.runId, worktreeParent: input.worktreeParent });
      record = await this.save({
        ...record,
        checkpoint: { sha: checkpoint.checkpointSha, ref: checkpoint.checkpointRef, worktreePath: checkpoint.worktreePath },
      });
      await this.emit(record, "diagnostic", { phase: "checkpoint", sha: checkpoint.checkpointSha, ref: checkpoint.checkpointRef, worktreePath: checkpoint.worktreePath });
      if (signal.aborted) throw new PiProcessError("PI_CANCELLED", "Run cancelled after checkpoint creation", "aborted: true");

      const manifest = buildInstructionManifest({
        runId: record.runId,
        correlationId: record.correlationId,
        projectId: input.projectId,
        profileId: profile.id,
        checkpointSha: checkpoint.checkpointSha,
        checkpointRef: checkpoint.checkpointRef,
        selectedCommentIds: input.selectedCommentIds,
        comments: input.comments,
        guidance: input.guidance,
      });
      record = await this.save({ ...record, status: "running", manifest });
      const nextSequence = ((await this.eventStore.list(record.runId)).at(-1)?.sequence ?? -1) + 1;
      await this.piExecutor.run(profile.manifest, {
        runId: record.runId,
        correlationId: record.correlationId,
        cwd: checkpoint.worktreePath,
        prompt: renderInstructionPrompt(manifest),
        signal,
        timeoutMs: profile.manifest.timeoutMs,
        eventSequenceStart: nextSequence,
        emitStarted: false,
        emitTerminal: false,
      } as PiRunInput, this.executorEventStore);
      await this.assertCanonicalUntouched(input.repositoryRoot);
      const changedFiles = await this.diffWorktree(checkpoint);
      const proposal = await this.proposalService.createFromRun({
        runId: record.runId,
        repositoryRoot: input.repositoryRoot,
        checkpoint: { sha: checkpoint.checkpointSha, ref: checkpoint.checkpointRef, worktreePath: checkpoint.worktreePath },
        cleanup: checkpoint.cleanup,
      });
      checkpointTransferred = true;
      transferredProposalId = proposal.proposalId;
      const endedAt = now(this.clock);
      record = await this.save({ ...record, status: "completed", endedAt, durationMs: Math.max(0, this.clock().getTime() - startedAtMs), changedFiles, proposalId: proposal.proposalId });
      const terminalEvents = await this.eventStore.list(record.runId);
      if (!terminalEvents.some((event) => event.type === "run.completed")) await this.emit(record, "run.completed", { changedFiles, durationMs: record.durationMs, proposalId: proposal.proposalId });
    } catch (error) {
      const details = errorDetails(error);
      const endedAt = now(this.clock);
      if (checkpointTransferred) {
        // Proposal creation durably transferred ownership of the checkpoint.
        // Preserve that successful linkage even if later run persistence or
        // terminal event emission failed; never downgrade and orphan it.
        record = await this.save({
          ...record,
          status: "completed",
          proposalId: transferredProposalId,
          endedAt,
          durationMs: Math.max(0, this.clock().getTime() - startedAtMs),
          errorCode: null,
          diagnostics: bounded([record.diagnostics, `completion persistence: ${details.diagnostics}`].filter(Boolean).join("\n")),
        });
        const terminalEvents = await this.eventStore.list(record.runId);
        if (!terminalEvents.some((event) => event.type === "run.completed")) {
          await this.emit(record, "run.completed", { changedFiles: record.changedFiles, durationMs: record.durationMs, proposalId: record.proposalId });
        }
      } else {
        const cancelled = isCancellation(error, signal);
        const status: RunStatus = cancelled ? "cancelled" : "failed";
        record = await this.save({
          ...record,
          status,
          endedAt,
          durationMs: Math.max(0, this.clock().getTime() - startedAtMs),
          errorCode: cancelled ? "PI_CANCELLED" : details.code,
          diagnostics: details.diagnostics,
        });
        const events = await this.eventStore.list(record.runId);
        const terminalType = cancelled ? "run.cancelled" : "run.failed";
        if (!events.some((event) => event.type === "run.cancelled" || event.type === "run.failed")) {
          await this.emit(record, terminalType, { code: record.errorCode, diagnostics: record.diagnostics });
        }
      }
    } finally {
      if (!checkpointTransferred) {
        const cleanupStartedAt = now(this.clock);
        record = await this.save({ ...record, cleanup: { ...record.cleanup, status: "pending", startedAt: cleanupStartedAt } });
        if (checkpoint) {
          try {
            await checkpoint.cleanup();
            record = await this.save({ ...record, cleanup: { status: "completed", startedAt: cleanupStartedAt, endedAt: now(this.clock), diagnostics: null } });
          } catch (error) {
            const diagnostics = bounded(error instanceof Error ? error.stack ?? error.message : String(error));
            record = await this.save({ ...record, cleanup: { status: "failed", startedAt: cleanupStartedAt, endedAt: now(this.clock), diagnostics }, diagnostics: bounded([record.diagnostics, `cleanup: ${diagnostics}`].filter(Boolean).join("\n")) });
          }
        } else {
          record = await this.save({ ...record, cleanup: { status: "completed", startedAt: cleanupStartedAt, endedAt: now(this.clock), diagnostics: null } });
        }
      }
    }
    return record;
  }
}
