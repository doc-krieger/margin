import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommentRecord } from "../../../../packages/shared/src/comments/contracts.js";
import {
  checkpointReviewAcknowledgmentSchema,
  findingRelationshipSchema,
  lineageProjectIdSchema,
  type CheckpointReviewAcknowledgment,
  type FindingRelationship,
} from "../../../../packages/shared/src/lineage/contracts.js";
import type { QualityReviewRecord } from "../../../../packages/shared/src/quality/contracts.js";
import type { ResearchBrief, ResearchRunRecord } from "../../../../packages/shared/src/research/contracts.js";
import type { SourceRecord } from "../../../../packages/shared/src/sources/contracts.js";
import type { RevisionRunRecord } from "../../../../packages/shared/src/runs/contracts.js";
import type { CommentService } from "../comments/repository.js";
import type { ProposalRecord, ProposalService } from "../proposals/index.js";
import type { QualityReviewService } from "../quality/service.js";
import type { ResearchRunService } from "../research/service.js";
import type { SourceStore } from "../sources/store.js";
import type { RevisionRunService } from "../runs/service.js";

export interface LineageSnapshot {
  briefs: ResearchBrief[];
  researchRuns: ResearchRunRecord[];
  sources: SourceRecord[];
  qualityReviews: QualityReviewRecord[];
  /** Append-only cross-checkpoint facts owned by this boundary. */
  findingRelationships: FindingRelationship[];
  checkpointReviewAcknowledgments: CheckpointReviewAcknowledgment[];
  comments: CommentRecord[];
  revisionRuns: RevisionRunRecord[];
  proposals: ProposalRecord[];
}

export interface LineageSnapshotProvider {
  (projectId: string): Promise<Partial<LineageSnapshot> | LineageSnapshot>;
}

export interface LineageFactSnapshot {
  findingRelationships: FindingRelationship[];
  checkpointReviewAcknowledgments: CheckpointReviewAcknowledgment[];
}

export interface LineageFactStore {
  read(projectId: string): Promise<LineageFactSnapshot>;
  appendFindingRelationship(value: FindingRelationship): Promise<FindingRelationship>;
  appendCheckpointReviewAcknowledgment(value: CheckpointReviewAcknowledgment): Promise<CheckpointReviewAcknowledgment>;
}

export interface LineageStoreOptions {
  /** A provider is useful for deterministic integration fixtures and remains read-only. */
  snapshot?: LineageSnapshotProvider;
  projectPath?: (projectId: string) => string | undefined | Promise<string | undefined>;
  research?: Pick<ResearchRunService, "list" | "listBriefs">;
  sources?: (projectRoot: string) => Pick<SourceStore, "list">;
  quality?: Pick<QualityReviewService, "list">;
  comments?: Pick<CommentService, "list">;
  revisionRuns?: Pick<RevisionRunService, "list">;
  proposals?: Pick<ProposalService, "list">;
  /** Durable append-only storage for relationship and review-acknowledgement facts. */
  factStore?: LineageFactStore;
}

const emptySnapshot = (): LineageSnapshot => ({
  briefs: [],
  researchRuns: [],
  sources: [],
  qualityReviews: [],
  comments: [],
  revisionRuns: [],
  proposals: [],
  findingRelationships: [],
  checkpointReviewAcknowledgments: [],
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeSnapshot(value: Partial<LineageSnapshot> | LineageSnapshot): LineageSnapshot {
  const base = emptySnapshot();
  return clone({
    briefs: value.briefs ?? base.briefs,
    researchRuns: value.researchRuns ?? base.researchRuns,
    sources: value.sources ?? base.sources,
    qualityReviews: value.qualityReviews ?? base.qualityReviews,
    comments: value.comments ?? base.comments,
    revisionRuns: value.revisionRuns ?? base.revisionRuns,
    proposals: value.proposals ?? base.proposals,
    findingRelationships: value.findingRelationships ?? base.findingRelationships,
    checkpointReviewAcknowledgments: value.checkpointReviewAcknowledgments ?? base.checkpointReviewAcknowledgments,
  });
}

function emptyFacts(): LineageFactSnapshot {
  return { findingRelationships: [], checkpointReviewAcknowledgments: [] };
}

/** Small atomic JSON store for facts that have no existing canonical domain owner. */
export class FileLineageFactStore implements LineageFactStore {
  constructor(private readonly root: string) {}

  private file(projectId: string): string {
    const safeProjectId = lineageProjectIdSchema.parse(projectId);
    return path.join(this.root, `${safeProjectId}.json`);
  }

  async read(projectId: string): Promise<LineageFactSnapshot> {
    try {
      const raw = JSON.parse(await readFile(this.file(projectId), "utf8")) as Record<string, unknown>;
      if (!Array.isArray(raw.findingRelationships) || !Array.isArray(raw.checkpointReviewAcknowledgments)) {
        throw new Error(`Lineage fact file for ${projectId} is malformed`);
      }
      return {
        findingRelationships: raw.findingRelationships.map((item) => findingRelationshipSchema.parse(item)),
        checkpointReviewAcknowledgments: raw.checkpointReviewAcknowledgments.map((item) => checkpointReviewAcknowledgmentSchema.parse(item)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFacts();
      throw error;
    }
  }

  private async write(projectId: string, facts: LineageFactSnapshot): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = this.file(projectId);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(facts), "utf8");
    await rename(temporary, file);
  }

  async appendFindingRelationship(value: FindingRelationship): Promise<FindingRelationship> {
    const parsed = findingRelationshipSchema.parse(value);
    const facts = await this.read(parsed.projectId);
    const existing = facts.findingRelationships.find((item) => item.relationshipId === parsed.relationshipId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return clone(existing);
      throw new Error(`Finding relationship ${parsed.relationshipId} is immutable and already exists`);
    }
    facts.findingRelationships.push(parsed);
    await this.write(parsed.projectId, facts);
    return clone(parsed);
  }

  async appendCheckpointReviewAcknowledgment(value: CheckpointReviewAcknowledgment): Promise<CheckpointReviewAcknowledgment> {
    const parsed = checkpointReviewAcknowledgmentSchema.parse(value);
    const facts = await this.read(parsed.projectId);
    const existing = facts.checkpointReviewAcknowledgments.find((item) => item.acknowledgmentId === parsed.acknowledgmentId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return clone(existing);
      throw new Error(`Checkpoint review acknowledgement ${parsed.acknowledgmentId} is immutable and already exists`);
    }
    facts.checkpointReviewAcknowledgments.push(parsed);
    await this.write(parsed.projectId, facts);
    return clone(parsed);
  }
}

/**
 * Read adapter for canonical domain stores plus the two small append-only facts
 * that cannot be reconstructed from an immutable QA record alone. It never
 * rewrites a finding, review, or proposal.
 */
export class LineageStore {
  private readonly findingRelationships = new Map<string, FindingRelationship[]>();
  private readonly checkpointReviewAcknowledgments = new Map<string, CheckpointReviewAcknowledgment[]>();

  constructor(private readonly options: LineageStoreOptions = {}) {}

  async snapshot(projectId: string): Promise<LineageSnapshot> {
    let base: LineageSnapshot;
    if (this.options.snapshot) {
      base = mergeSnapshot(await this.options.snapshot(projectId));
    } else {
      const repositoryRoot = this.options.projectPath ? await this.options.projectPath(projectId) : undefined;
      const [briefs, researchRuns, sources, qualityReviews, comments, revisionRuns, proposals] = await Promise.all([
        this.options.research?.listBriefs(projectId) ?? Promise.resolve([]),
        this.options.research?.list(projectId) ?? Promise.resolve([]),
        repositoryRoot && this.options.sources ? this.options.sources(repositoryRoot).list() : Promise.resolve([]),
        this.options.quality?.list(projectId) ?? Promise.resolve([]),
        this.options.comments ? Promise.resolve(this.options.comments.list({ projectId })) : Promise.resolve([]),
        this.options.revisionRuns?.list(projectId) ?? Promise.resolve([]),
        this.options.proposals?.list() ?? Promise.resolve([]),
      ]);

      const runIds = new Set<string>([
        ...researchRuns.map((run) => run.runId),
        ...revisionRuns.map((run) => run.runId),
      ]);
      base = mergeSnapshot({
        briefs,
        researchRuns,
        sources,
        qualityReviews,
        comments,
        revisionRuns,
        proposals: proposals.filter((proposal) => runIds.has(proposal.runId) || (repositoryRoot !== undefined && proposal.repositoryRoot === repositoryRoot)),
      });
    }

    const persistedFacts = this.options.factStore ? await this.options.factStore.read(projectId) : emptyFacts();
    return mergeSnapshot({
      ...base,
      findingRelationships: [
        ...base.findingRelationships,
        ...persistedFacts.findingRelationships,
        ...(this.findingRelationships.get(projectId) ?? []),
      ],
      checkpointReviewAcknowledgments: [
        ...base.checkpointReviewAcknowledgments,
        ...persistedFacts.checkpointReviewAcknowledgments,
        ...(this.checkpointReviewAcknowledgments.get(projectId) ?? []),
      ],
    });
  }

  async appendFindingRelationship(value: FindingRelationship): Promise<FindingRelationship> {
    const parsed = findingRelationshipSchema.parse(value);
    const existing = (await this.snapshot(parsed.projectId)).findingRelationships.find((item) => item.relationshipId === parsed.relationshipId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return clone(existing);
      throw new Error(`Finding relationship ${parsed.relationshipId} is immutable and already exists`);
    }
    if (this.options.factStore) return this.options.factStore.appendFindingRelationship(parsed);
    const values = this.findingRelationships.get(parsed.projectId) ?? [];
    values.push(clone(parsed));
    this.findingRelationships.set(parsed.projectId, values);
    return clone(parsed);
  }

  async appendCheckpointReviewAcknowledgment(value: CheckpointReviewAcknowledgment): Promise<CheckpointReviewAcknowledgment> {
    const parsed = checkpointReviewAcknowledgmentSchema.parse(value);
    const existing = (await this.snapshot(parsed.projectId)).checkpointReviewAcknowledgments.find((item) => item.acknowledgmentId === parsed.acknowledgmentId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return clone(existing);
      throw new Error(`Checkpoint review acknowledgement ${parsed.acknowledgmentId} is immutable and already exists`);
    }
    if (this.options.factStore) return this.options.factStore.appendCheckpointReviewAcknowledgment(parsed);
    const values = this.checkpointReviewAcknowledgments.get(parsed.projectId) ?? [];
    values.push(clone(parsed));
    this.checkpointReviewAcknowledgments.set(parsed.projectId, values);
    return clone(parsed);
  }

  /** Alias used by callers that describe this boundary as a project read. */
  async read(projectId: string): Promise<LineageSnapshot> {
    return this.snapshot(projectId);
  }

  /** Alias used by route and test adapters that call the operation list. */
  async list(projectId: string): Promise<LineageSnapshot> {
    return this.snapshot(projectId);
  }
}

/** In-memory read adapter for tests and embedded consumers. */
export class MemoryLineageStore extends LineageStore {
  private readonly snapshots: Map<string, LineageSnapshot>;

  constructor(initial: Partial<LineageSnapshot> | Map<string, Partial<LineageSnapshot>> = {}) {
    if (initial instanceof Map) {
      const snapshots = new Map<string, LineageSnapshot>();
      for (const [projectId, value] of initial) snapshots.set(projectId, mergeSnapshot(value));
      super({ snapshot: async (projectId) => snapshots.get(projectId) ?? {} });
      this.snapshots = snapshots;
    } else {
      const snapshot = mergeSnapshot(initial);
      super({ snapshot: async () => snapshot });
      this.snapshots = new Map();
    }
  }

  set(projectId: string, value: Partial<LineageSnapshot>): void {
    this.snapshots.set(projectId, mergeSnapshot(value));
  }
}

export type CanonicalLineageStore = LineageStore;
