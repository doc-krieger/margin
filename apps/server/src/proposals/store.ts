import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitProposalDiff } from "../git/proposal.js";

export type ProposalStatus = "pending" | "kept" | "rejected" | "conflict" | "failed";
export type ProposalDecision = "keep" | "reject";
export type ProposalCleanupStatus = "pending" | "completed" | "failed";

export interface ProposalCheckpoint {
  sha: string;
  ref: string;
  worktreePath: string;
}

export interface ProposalCleanupRecord {
  status: ProposalCleanupStatus;
  startedAt: string | null;
  endedAt: string | null;
  diagnostics: string | null;
}

export interface ProposalRecord {
  proposalId: string;
  runId: string;
  repositoryRoot: string;
  checkpoint: ProposalCheckpoint;
  status: ProposalStatus;
  decision: ProposalDecision | null;
  diff: GitProposalDiff;
  cleanup: ProposalCleanupRecord;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  errorCode: string | null;
  diagnostics: string | null;
}

export type ProposalAuditAction =
  | "created"
  | "viewed"
  | "edited"
  | "keep"
  | "kept"
  | "reject"
  | "rejected"
  | "conflict"
  | "failed"
  | "cleanup.started"
  | "cleanup.completed"
  | "cleanup.failed";

export interface ProposalAuditRecord {
  auditId: string;
  proposalId: string;
  runId: string;
  action: ProposalAuditAction;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface ProposalStore {
  save(record: ProposalRecord): Promise<void>;
  get(proposalId: string): Promise<ProposalRecord | null>;
  list(runId?: string): Promise<ProposalRecord[]>;
}

export interface ProposalAuditStore {
  append(record: ProposalAuditRecord): Promise<void>;
  list(proposalId: string): Promise<ProposalAuditRecord[]>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function recordPath(root: string, proposalId: string): string {
  if (!validId(proposalId)) throw new Error("Invalid proposal ID for persistence");
  return path.join(root, `${proposalId}.json`);
}

export class MemoryProposalStore implements ProposalStore {
  private readonly records = new Map<string, ProposalRecord>();

  async save(record: ProposalRecord): Promise<void> {
    this.records.set(record.proposalId, clone(record));
  }

  async get(proposalId: string): Promise<ProposalRecord | null> {
    const record = this.records.get(proposalId);
    return record ? clone(record) : null;
  }

  async list(runId?: string): Promise<ProposalRecord[]> {
    return [...this.records.values()]
      .filter((record) => runId === undefined || record.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }
}

/** Atomic JSON proposal records retained after the isolated worktree is removed. */
export class FileProposalStore implements ProposalStore {
  constructor(private readonly root: string) {}

  async save(record: ProposalRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const destination = recordPath(this.root, record.proposalId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    await rename(temporary, destination);
  }

  async get(proposalId: string): Promise<ProposalRecord | null> {
    try {
      return clone(JSON.parse(await readFile(recordPath(this.root, proposalId), "utf8")) as ProposalRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(runId?: string): Promise<ProposalRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ProposalRecord[] = [];
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
      const record = JSON.parse(await readFile(path.join(this.root, entry.name), "utf8")) as ProposalRecord;
      if (runId === undefined || record.runId === runId) records.push(clone(record));
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

export class MemoryProposalAuditStore implements ProposalAuditStore {
  private readonly records: ProposalAuditRecord[] = [];

  async append(record: ProposalAuditRecord): Promise<void> {
    this.records.push(clone(record));
  }

  async list(proposalId: string): Promise<ProposalAuditRecord[]> {
    return this.records.filter((record) => record.proposalId === proposalId).map(clone);
  }
}

/** Append-only JSONL audit records make every review and recovery outcome inspectable. */
export class FileProposalAuditStore implements ProposalAuditStore {
  constructor(private readonly root: string) {}

  async append(record: ProposalAuditRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(path.join(this.root, `${record.proposalId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  }

  async list(proposalId: string): Promise<ProposalAuditRecord[]> {
    try {
      const content = await readFile(path.join(this.root, `${proposalId}.jsonl`), "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProposalAuditRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
