import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitProposalError, GitProposalService, hashContent, type GitProposalDiff, type GitProposalWorkspaceInput } from "../git/proposal.js";
import type { GitCheckpoint } from "../git/checkpoint.js";
import {
  FileProposalAuditStore,
  FileProposalStore,
  MemoryProposalAuditStore,
  MemoryProposalStore,
  type ProposalAuditRecord,
  type ProposalAuditStore,
  type ProposalCheckpoint,
  type ProposalDecision,
  type ProposalRecord,
  type ProposalStatus,
  type ProposalStore,
} from "./store.js";

export type ProposalCleanup = () => Promise<void>;
export type ProposalClock = () => Date;

export interface ProposalSource extends ProposalCheckpoint {
  cleanup?: ProposalCleanup;
}

export interface CreateProposalInput {
  runId: string;
  repositoryRoot: string;
  proposalId?: string;
  checkpoint?: ProposalSource | GitCheckpoint;
  checkpointSha?: string;
  checkpointRef?: string;
  worktreePath?: string;
  cleanup?: ProposalCleanup;
}

export interface EditProposalFileInput {
  path: string;
  content: string;
  baseHash?: string;
  expectedHash?: string;
}

export interface ProposalServiceOptions {
  proposalStore?: ProposalStore;
  /** Alias accepted for callers that use the shorter store name. */
  store?: ProposalStore;
  auditStore?: ProposalAuditStore;
  gitService?: GitProposalService;
  dataDirectory?: string;
  clock?: ProposalClock;
  onCleanup?: (record: ProposalRecord) => Promise<void>;
}

export type ProposalErrorCode =
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_ALREADY_EXISTS"
  | "PROPOSAL_INVALID_STATE"
  | "PROPOSAL_CONFLICT"
  | "PROPOSAL_INVALID_INPUT"
  | "PROPOSAL_CLEANUP_FAILED";

export class ProposalError extends Error {
  constructor(
    public readonly code: ProposalErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProposalError";
  }
}

export class ProposalNotFoundError extends ProposalError {
  constructor(proposalId: string) {
    super("PROPOSAL_NOT_FOUND", `Proposal ${proposalId} was not found`, { proposalId });
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalConflictError extends ProposalError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super("PROPOSAL_CONFLICT", message, details, options);
    this.name = "ProposalConflictError";
  }
}

export class ProposalStateError extends ProposalError {
  constructor(proposalId: string, status: ProposalStatus, action: string) {
    super("PROPOSAL_INVALID_STATE", `Proposal ${proposalId} is ${status} and cannot ${action}`, { proposalId, status, action });
    this.name = "ProposalStateError";
  }
}

function now(clock: ProposalClock): string {
  return clock().toISOString();
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function errorDetails(error: unknown): { code: string; diagnostics: string } {
  if (error instanceof GitProposalError) return { code: error.code, diagnostics: error.diagnostics || error.message };
  const candidate = error as { code?: unknown; diagnostics?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "PROPOSAL_FAILED",
    diagnostics: typeof candidate?.diagnostics === "string" ? candidate.diagnostics : error instanceof Error ? error.stack ?? error.message : String(error),
  };
}

function sourceFromInput(input: CreateProposalInput): { source: ProposalSource; cleanup?: ProposalCleanup } {
  const checkpoint = input.checkpoint as (Partial<ProposalSource> & Partial<GitCheckpoint>) | undefined;
  const source: ProposalSource = {
    sha: input.checkpointSha ?? checkpoint?.sha ?? checkpoint?.checkpointSha ?? "",
    ref: input.checkpointRef ?? checkpoint?.ref ?? checkpoint?.checkpointRef ?? `refs/margin/checkpoints/${input.runId}`,
    worktreePath: input.worktreePath ?? checkpoint?.worktreePath ?? "",
  };
  const cleanup = input.cleanup ?? checkpoint?.cleanup;
  if (!input.runId || !validId(input.runId) || !input.repositoryRoot || !source.sha || !source.worktreePath) {
    throw new ProposalError("PROPOSAL_INVALID_INPUT", "runId, repositoryRoot, checkpoint SHA, and proposal worktree are required");
  }
  return { source, cleanup };
}

function workspace(record: ProposalRecord): GitProposalWorkspaceInput {
  return {
    repositoryRoot: record.repositoryRoot,
    worktreePath: record.checkpoint.worktreePath,
    checkpointSha: record.checkpoint.sha,
    checkpointRef: record.checkpoint.ref,
  };
}

function nextCleanup(record: ProposalRecord, status: ProposalRecord["cleanup"]["status"], timestamp: string, diagnostics: string | null): ProposalRecord["cleanup"] {
  return {
    status,
    startedAt: status === "pending" ? record.cleanup.startedAt : record.cleanup.startedAt ?? timestamp,
    endedAt: status === "pending" ? null : timestamp,
    diagnostics,
  };
}

/** Durable review state machine for an isolated Git proposal. Decisions are intentionally whole-run. */
export class ProposalService {
  private readonly proposalStore: ProposalStore;
  private readonly auditStore: ProposalAuditStore;
  private readonly git: GitProposalService;
  private readonly clock: ProposalClock;
  private onCleanup?: (record: ProposalRecord) => Promise<void>;
  private readonly cleanupHandlers = new Map<string, ProposalCleanup>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: ProposalServiceOptions = {}) {
    const dataDirectory = options.dataDirectory ?? process.env.MARGIN_PROPOSAL_DATA_DIR ?? path.join(homedir(), ".margin", "proposals");
    this.proposalStore = options.proposalStore ?? options.store ?? new FileProposalStore(path.join(dataDirectory, "records"));
    this.auditStore = options.auditStore ?? new FileProposalAuditStore(path.join(dataDirectory, "audit"));
    this.git = options.gitService ?? new GitProposalService();
    this.clock = options.clock ?? (() => new Date());
    this.onCleanup = options.onCleanup;
  }

  setCleanupObserver(observer: (record: ProposalRecord) => Promise<void>): void {
    this.onCleanup = observer;
  }

  async create(input: CreateProposalInput): Promise<ProposalRecord> {
    const { source, cleanup } = sourceFromInput(input);
    const proposalId = input.proposalId ?? randomUUID();
    if (!validId(proposalId)) throw new ProposalError("PROPOSAL_INVALID_INPUT", "proposalId contains unsafe path characters");
    if (await this.proposalStore.get(proposalId)) throw new ProposalError("PROPOSAL_ALREADY_EXISTS", `Proposal ${proposalId} already exists`, { proposalId });
    const diff = await this.git.diff({
      repositoryRoot: input.repositoryRoot,
      worktreePath: source.worktreePath,
      checkpointSha: source.sha,
      checkpointRef: source.ref,
    });
    const timestamp = now(this.clock);
    const record: ProposalRecord = {
      proposalId,
      runId: input.runId,
      repositoryRoot: input.repositoryRoot,
      checkpoint: { sha: source.sha, ref: source.ref, worktreePath: source.worktreePath },
      status: "pending",
      decision: null,
      diff,
      cleanup: { status: "pending", startedAt: null, endedAt: null, diagnostics: null },
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
      errorCode: null,
      diagnostics: null,
    };
    await this.proposalStore.save(record);
    if (cleanup) this.cleanupHandlers.set(proposalId, cleanup);
    try {
      await this.recordAudit(record, "created", { changedFiles: diff.files.length });
    } catch {
      // The durable proposal record is the checkpoint ownership boundary. Audit
      // failure must not make the run service delete a now-owned worktree.
    }
    return record;
  }

  /** Adapts the checkpoint embedded in a completed run record into a reviewable proposal. */
  async createFromRun(input: { runId: string; repositoryRoot: string; checkpoint: ProposalCheckpoint; cleanup?: ProposalCleanup; proposalId?: string }): Promise<ProposalRecord> {
    return this.create({ ...input, checkpoint: { ...input.checkpoint, cleanup: input.cleanup } });
  }

  async get(proposalId: string): Promise<ProposalRecord> {
    const record = await this.proposalStore.get(proposalId);
    if (!record) throw new ProposalNotFoundError(proposalId);
    return record;
  }

  async list(runId?: string): Promise<ProposalRecord[]> {
    return this.proposalStore.list(runId);
  }

  async refresh(proposalId: string): Promise<ProposalRecord> {
    const record = await this.get(proposalId);
    if (record.status !== "pending") return record;
    const diff = await this.git.diff(workspace(record));
    const updated: ProposalRecord = { ...record, diff, updatedAt: now(this.clock) };
    await this.proposalStore.save(updated);
    return updated;
  }

  async readFile(proposalId: string, relativePath: string): Promise<{ path: string; content: string; hash: string }> {
    const record = await this.get(proposalId);
    return this.git.readFile(workspace(record), relativePath);
  }

  async editFile(proposalId: string, input: EditProposalFileInput): Promise<ProposalRecord> {
    const record = await this.get(proposalId);
    this.assertPending(record, "edit the proposal");
    if (typeof input.content !== "string") throw new ProposalError("PROPOSAL_INVALID_INPUT", "Proposal content must be a string");
    const expectedHash = input.baseHash ?? input.expectedHash;
    if (expectedHash) {
      const current = await this.git.readFile(workspace(record), input.path);
      if (current.hash !== expectedHash) {
        throw new ProposalConflictError("The isolated proposal changed before this edit could be applied", { path: input.path, expectedHash, currentHash: current.hash });
      }
    }
    await this.git.writeFile(workspace(record), input.path, input.content);
    const diff = await this.git.diff(workspace(record));
    const updated: ProposalRecord = { ...record, diff, updatedAt: now(this.clock) };
    await this.proposalStore.save(updated);
    await this.recordAudit(updated, "edited", { path: input.path, hash: hashContent(input.content) });
    return updated;
  }

  /** Alias retained for API callers that call the operation update rather than edit. */
  async edit(proposalId: string, input: EditProposalFileInput): Promise<ProposalRecord> {
    return this.editFile(proposalId, input);
  }

  async keep(proposalId: string): Promise<ProposalRecord> {
    return this.decide(proposalId, "keep");
  }

  async reject(proposalId: string): Promise<ProposalRecord> {
    return this.decide(proposalId, "reject");
  }

  async decide(proposalId: string, decision: ProposalDecision): Promise<ProposalRecord> {
    return this.withLock(proposalId, () => this.decideUnlocked(proposalId, decision));
  }

  private async decideUnlocked(proposalId: string, decision: ProposalDecision): Promise<ProposalRecord> {
    const record = await this.get(proposalId);
    this.assertPending(record, `${decision} the proposal`);
    if (decision !== "keep" && decision !== "reject") throw new ProposalError("PROPOSAL_INVALID_INPUT", "Decision must be keep or reject");
    let current = await this.refresh(proposalId);
    await this.recordAudit(current, decision, { changedFiles: current.diff.files.length });
    if (decision === "keep") {
      try {
        const applied = await this.git.apply(workspace(current));
        const diff: GitProposalDiff = { ...current.diff, files: applied.changedFiles };
        current = { ...current, status: "kept", decision, diff, decidedAt: now(this.clock), updatedAt: now(this.clock), errorCode: null, diagnostics: null };
        await this.proposalStore.save(current);
        await this.recordAudit(current, "kept", { changedFiles: applied.changedFiles.length });
      } catch (error) {
        const details = errorDetails(error);
        const conflict = details.code === "GIT_PROPOSAL_CONFLICT";
        current = {
          ...current,
          status: conflict ? "conflict" : "failed",
          decision,
          decidedAt: now(this.clock),
          updatedAt: now(this.clock),
          errorCode: conflict ? "PROPOSAL_CONFLICT" : details.code,
          diagnostics: details.diagnostics,
        };
        await this.proposalStore.save(current);
        await this.recordAudit(current, conflict ? "conflict" : "failed", { code: current.errorCode, diagnostics: current.diagnostics });
        await this.cleanupAfterDecision(current);
        if (conflict) throw new ProposalConflictError("Canonical files changed; the proposal was not applied", { proposalId, diagnostics: details.diagnostics }, { cause: error });
        throw error;
      }
    } else {
      current = { ...current, status: "rejected", decision, decidedAt: now(this.clock), updatedAt: now(this.clock), errorCode: null, diagnostics: null };
      await this.proposalStore.save(current);
      await this.recordAudit(current, "rejected", { changedFiles: current.diff.files.length });
    }
    return this.cleanupAfterDecision(current);
  }

  async attachCleanup(proposalId: string, cleanup: ProposalCleanup): Promise<ProposalRecord> {
    const record = await this.get(proposalId);
    this.cleanupHandlers.set(proposalId, cleanup);
    return record;
  }

  async retryCleanup(proposalId: string): Promise<ProposalRecord> {
    const record = await this.get(proposalId);
    if (record.status === "pending") throw new ProposalStateError(proposalId, record.status, "retry cleanup for");
    return this.withLock(proposalId, () => this.cleanupAfterDecision(record));
  }

  async cleanup(proposalId: string): Promise<ProposalRecord> {
    return this.retryCleanup(proposalId);
  }

  async syncCleanup(proposalId: string): Promise<void> {
    const record = await this.get(proposalId);
    if (record.status !== "pending") await this.notifyCleanup(record);
  }

  async audit(proposalId: string): Promise<ProposalAuditRecord[]> {
    await this.get(proposalId);
    return this.auditStore.list(proposalId);
  }

  private assertPending(record: ProposalRecord, action: string): void {
    if (record.status !== "pending") throw new ProposalStateError(record.proposalId, record.status, action);
  }

  private async withLock<T>(proposalId: string, work: () => Promise<T>): Promise<T> {
    const current = await this.get(proposalId);
    const previous = this.locks.get(current.repositoryRoot) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(current.repositoryRoot, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(current.repositoryRoot) === queued) this.locks.delete(current.repositoryRoot);
    }
  }

  private async cleanupAfterDecision(record: ProposalRecord): Promise<ProposalRecord> {
    if (record.cleanup.status === "completed") {
      await this.notifyCleanup(record);
      return record;
    }
    const startedAt = now(this.clock);
    let current: ProposalRecord = { ...record, cleanup: nextCleanup(record, "pending", startedAt, null), updatedAt: startedAt };
    await this.proposalStore.save(current);
    await this.recordAudit(current, "cleanup.started", {});
    try {
      const cleanup = this.cleanupHandlers.get(record.proposalId) ?? (() => this.git.cleanup(workspace(record)));
      await cleanup();
      this.cleanupHandlers.delete(record.proposalId);
      current = { ...current, cleanup: nextCleanup(current, "completed", now(this.clock), null), updatedAt: now(this.clock) };
      await this.proposalStore.save(current);
      await this.recordAudit(current, "cleanup.completed", {});
    } catch (error) {
      const diagnostics = error instanceof Error ? error.stack ?? error.message : String(error);
      current = { ...current, cleanup: nextCleanup(current, "failed", now(this.clock), diagnostics), updatedAt: now(this.clock) };
      await this.proposalStore.save(current);
      await this.recordAudit(current, "cleanup.failed", { diagnostics });
    }
    await this.notifyCleanup(current);
    return current;
  }

  private async notifyCleanup(record: ProposalRecord): Promise<void> {
    try {
      await this.onCleanup?.(record);
    } catch {
      // The proposal decision and workspace cleanup are already durable. A later
      // cleanup retry replays this observer to reconcile the parent run record.
    }
  }

  private async recordAudit(record: ProposalRecord, action: ProposalAuditRecord["action"], details: Record<string, unknown>): Promise<void> {
    await this.auditStore.append({
      auditId: randomUUID(),
      proposalId: record.proposalId,
      runId: record.runId,
      action,
      timestamp: now(this.clock),
      details,
    });
  }
}

export { MemoryProposalAuditStore, MemoryProposalStore };
