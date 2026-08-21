import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isActiveResearchRunStatus,
  researchBriefIdSchema,
  researchBriefSchema,
  researchRunIdSchema,
  researchRunRecordSchema,
  type ResearchBrief,
  type ResearchRunRecord,
} from "../../../../packages/shared/src/research/contracts.js";

export type ResearchStoreErrorCode = "INVALID_RUN_ID" | "INVALID_RECORD" | "IO_ERROR";

/** A persisted research record is invalid or cannot be safely reconstructed. */
export class ResearchStoreError extends Error {
  constructor(
    public readonly code: ResearchStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ResearchStoreError";
  }
}

export interface ResearchRunRecordStore {
  save(record: ResearchRunRecord): Promise<void>;
  get(runId: string): Promise<ResearchRunRecord | null>;
  list(projectId?: string): Promise<ResearchRunRecord[]>;
}

export interface ResearchBriefStore {
  save(brief: ResearchBrief): Promise<void>;
  get(projectId: string, briefId: string): Promise<ResearchBrief | null>;
  list(projectId?: string): Promise<ResearchBrief[]>;
}

/** Alias used by callers that refer to the record layer as the research store. */
export type ResearchRecordStore = ResearchRunRecordStore;

function assertBriefId(briefId: string): string {
  try {
    return researchBriefIdSchema.parse(briefId);
  } catch (error) {
    throw new ResearchStoreError("INVALID_RECORD", `Invalid research brief ID: ${briefId}`, { cause: error });
  }
}

function briefPath(root: string, briefId: string): string {
  return path.join(root, `${assertBriefId(briefId)}.json`);
}

function cloneBrief(brief: ResearchBrief): ResearchBrief {
  return researchBriefSchema.parse(JSON.parse(JSON.stringify(brief)));
}

function parsePersistedBrief(contents: string, projectId: string | undefined, briefId: string): ResearchBrief {
  try {
    const parsed = cloneBrief(JSON.parse(contents) as ResearchBrief);
    if ((projectId !== undefined && parsed.projectId !== projectId) || parsed.briefId !== briefId) throw new Error("brief identity does not match request");
    return parsed;
  } catch (error) {
    throw new ResearchStoreError("INVALID_RECORD", `Invalid persisted research brief ${briefId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const persistedRunIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function assertRunId(runId: string): string {
  try {
    researchRunIdSchema.parse(runId);
  } catch (error) {
    throw new ResearchStoreError("INVALID_RUN_ID", `Invalid research run ID: ${runId}`, { cause: error });
  }
  if (!persistedRunIdPattern.test(runId) || runId.includes("..")) {
    throw new ResearchStoreError("INVALID_RUN_ID", `Invalid research run ID for record persistence: ${runId}`);
  }
  return runId;
}

function recordPath(root: string, runId: string): string {
  return path.join(root, `${assertRunId(runId)}.json`);
}

function cloneRecord(record: ResearchRunRecord): ResearchRunRecord {
  return researchRunRecordSchema.parse(JSON.parse(JSON.stringify(record)));
}

function parsePersistedRecord(contents: string, runId: string): ResearchRunRecord {
  try {
    const parsed = researchRunRecordSchema.parse(JSON.parse(contents));
    if (parsed.runId !== runId) throw new Error(`record runId ${parsed.runId} does not match file ${runId}`);
    return cloneRecord(parsed);
  } catch (error) {
    if (error instanceof ResearchStoreError) throw error;
    throw new ResearchStoreError(
      "INVALID_RECORD",
      `Invalid persisted research run record ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Atomic JSON snapshots make research lifecycle state reconnectable after service reconstruction. */
export class FileResearchRunRecordStore implements ResearchRunRecordStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async save(record: ResearchRunRecord): Promise<void> {
    let parsed: ResearchRunRecord;
    try {
      parsed = cloneRecord(record);
    } catch (error) {
      throw new ResearchStoreError(
        "INVALID_RECORD",
        `Cannot persist invalid research run record: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const runId = assertRunId(parsed.runId);
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      const target = recordPath(this.root, runId);
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }).catch((error) => {
      if (error instanceof ResearchStoreError) throw error;
      throw new ResearchStoreError("IO_ERROR", `Unable to persist research run record ${runId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    this.writes.set(runId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(runId) === next) this.writes.delete(runId);
    }
  }

  async get(runId: string): Promise<ResearchRunRecord | null> {
    const validatedRunId = assertRunId(runId);
    let contents: string;
    try {
      contents = await readFile(recordPath(this.root, validatedRunId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ResearchStoreError("IO_ERROR", `Unable to read research run record ${validatedRunId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return parsePersistedRecord(contents, validatedRunId);
  }

  async list(projectId?: string): Promise<ResearchRunRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ResearchStoreError("IO_ERROR", `Unable to list research run records: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const records: ResearchRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -5);
      const record = await this.get(runId);
      if (record && (!projectId || record.projectId === projectId)) records.push(record);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
  }
}

export class MemoryResearchRunRecordStore implements ResearchRunRecordStore {
  private readonly records = new Map<string, ResearchRunRecord>();

  async save(record: ResearchRunRecord): Promise<void> {
    const parsed = cloneRecord(record);
    assertRunId(parsed.runId);
    this.records.set(parsed.runId, parsed);
  }

  async get(runId: string): Promise<ResearchRunRecord | null> {
    const record = this.records.get(assertRunId(runId));
    return record ? cloneRecord(record) : null;
  }

  async list(projectId?: string): Promise<ResearchRunRecord[]> {
    return [...this.records.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId))
      .map(cloneRecord);
  }

  /** Useful to reconstruct only active state in a service without inventing terminal outcomes. */
  async listActive(projectId?: string): Promise<ResearchRunRecord[]> {
    return (await this.list(projectId)).filter((record) => isActiveResearchRunStatus(record.status));
  }
}

/** Atomic JSON snapshots for saved briefs. Briefs are project-scoped metadata, not report bodies. */
export class FileResearchBriefStore implements ResearchBriefStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async save(brief: ResearchBrief): Promise<void> {
    let parsed: ResearchBrief;
    try {
      parsed = cloneBrief(brief);
    } catch (error) {
      throw new ResearchStoreError("INVALID_RECORD", `Cannot persist invalid research brief: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const briefId = assertBriefId(parsed.briefId);
    const previous = this.writes.get(briefId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      const target = briefPath(this.root, briefId);
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }).catch((error) => {
      if (error instanceof ResearchStoreError) throw error;
      throw new ResearchStoreError("IO_ERROR", `Unable to persist research brief ${briefId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    this.writes.set(briefId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(briefId) === next) this.writes.delete(briefId);
    }
  }

  async get(projectId: string, briefId: string): Promise<ResearchBrief | null> {
    const validatedBriefId = assertBriefId(briefId);
    let contents: string;
    try {
      contents = await readFile(briefPath(this.root, validatedBriefId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ResearchStoreError("IO_ERROR", `Unable to read research brief ${validatedBriefId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const brief = parsePersistedBrief(contents, projectId, validatedBriefId);
    return brief.projectId === projectId ? brief : null;
  }

  async list(projectId?: string): Promise<ResearchBrief[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ResearchStoreError("IO_ERROR", `Unable to list research briefs: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const briefs: ResearchBrief[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const briefId = entry.name.slice(0, -5);
      let contents: string;
      try {
        contents = await readFile(path.join(this.root, entry.name), "utf8");
      } catch (error) {
        throw new ResearchStoreError("IO_ERROR", `Unable to read research brief ${briefId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const parsed = parsePersistedBrief(contents, undefined, briefId);
      if (!projectId || parsed.projectId === projectId) briefs.push(parsed);
    }
    return briefs.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.briefId.localeCompare(right.briefId));
  }
}

export class MemoryResearchBriefStore implements ResearchBriefStore {
  private readonly briefs = new Map<string, ResearchBrief>();

  async save(brief: ResearchBrief): Promise<void> {
    const parsed = cloneBrief(brief);
    assertBriefId(parsed.briefId);
    this.briefs.set(parsed.briefId, parsed);
  }

  async get(projectId: string, briefId: string): Promise<ResearchBrief | null> {
    const brief = this.briefs.get(assertBriefId(briefId));
    if (!brief || brief.projectId !== projectId) return null;
    return cloneBrief(brief);
  }

  async list(projectId?: string): Promise<ResearchBrief[]> {
    return [...this.briefs.values()]
      .filter((brief) => !projectId || brief.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.briefId.localeCompare(right.briefId))
      .map(cloneBrief);
  }
}

export class ResearchRunStore extends FileResearchRunRecordStore {}
