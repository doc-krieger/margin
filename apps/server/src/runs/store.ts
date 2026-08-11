import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { revisionRunRecordSchema, type RevisionRunRecord } from "../../../../packages/shared/src/runs/contracts.js";

export interface RunRecordStore {
  save(record: RevisionRunRecord): Promise<void>;
  get(runId: string): Promise<RevisionRunRecord | null>;
  list(projectId?: string): Promise<RevisionRunRecord[]>;
}

function recordPath(root: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid run ID for record persistence");
  return path.join(root, `${runId}.json`);
}

function copyRecord(record: RevisionRunRecord): RevisionRunRecord {
  return revisionRunRecordSchema.parse(JSON.parse(JSON.stringify(record)));
}

/** Atomic JSON snapshots make lifecycle state reconnectable independently of the event stream. */
export class FileRunRecordStore implements RunRecordStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async save(record: RevisionRunRecord): Promise<void> {
    const parsed = copyRecord(record);
    const previous = this.writes.get(parsed.runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      const target = recordPath(this.root, parsed.runId);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    });
    this.writes.set(parsed.runId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(parsed.runId) === next) this.writes.delete(parsed.runId);
    }
  }

  async get(runId: string): Promise<RevisionRunRecord | null> {
    const contents = await readFile(recordPath(this.root, runId), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return contents === null ? null : copyRecord(JSON.parse(contents) as RevisionRunRecord);
  }

  async list(projectId?: string): Promise<RevisionRunRecord[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records: RevisionRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.get(entry.name.slice(0, -5));
      if (record && (!projectId || record.projectId === projectId)) records.push(record);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

export class MemoryRunRecordStore implements RunRecordStore {
  private readonly records = new Map<string, RevisionRunRecord>();

  async save(record: RevisionRunRecord): Promise<void> {
    this.records.set(record.runId, copyRecord(record));
  }

  async get(runId: string): Promise<RevisionRunRecord | null> {
    const record = this.records.get(runId);
    return record ? copyRecord(record) : null;
  }

  async list(projectId?: string): Promise<RevisionRunRecord[]> {
    return [...this.records.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copyRecord);
  }
}
