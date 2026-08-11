import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  makeRunEvent,
  runEventSchema,
  runEventTypeSchema,
  type RunEvent,
  type RunEventType,
} from "../../../../packages/shared/src/runs/contracts.js";

export { makeRunEvent, runEventSchema, runEventTypeSchema };
export type { RunEvent, RunEventType };

export interface RunEventStore {
  append(event: RunEvent): Promise<void>;
  list(runId: string): Promise<RunEvent[]>;
}

function eventPath(root: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) throw new Error("Invalid run ID for event persistence");
  return path.join(root, `${runId}.jsonl`);
}

/** Durable append-only JSONL event storage used as the run lifecycle contract. */
export class FileRunEventStore implements RunEventStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async append(event: RunEvent): Promise<void> {
    const parsed = runEventSchema.parse(event);
    const previous = this.writes.get(parsed.runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      const existing = await this.list(parsed.runId);
      const last = existing.at(-1);
      if (last && parsed.sequence <= last.sequence) {
        throw new Error(`Run event sequence must increase for ${parsed.runId}`);
      }
      await appendFile(eventPath(this.root, parsed.runId), `${JSON.stringify(parsed)}\n`, "utf8");
    });
    this.writes.set(parsed.runId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(parsed.runId) === next) this.writes.delete(parsed.runId);
    }
  }

  async list(runId: string): Promise<RunEvent[]> {
    const contents = await readFile(eventPath(this.root, runId), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!contents.trim()) return [];
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return runEventSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new Error(`Invalid persisted run event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }
}

export class MemoryRunEventStore implements RunEventStore {
  private readonly events = new Map<string, RunEvent[]>();

  async append(event: RunEvent): Promise<void> {
    const parsed = runEventSchema.parse(event);
    const events = this.events.get(parsed.runId) ?? [];
    const last = events.at(-1);
    if (last && parsed.sequence <= last.sequence) throw new Error(`Run event sequence must increase for ${parsed.runId}`);
    events.push(parsed);
    this.events.set(parsed.runId, events);
  }

  async list(runId: string): Promise<RunEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }
}

