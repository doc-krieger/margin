import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const runEventTypeSchema = z.enum([
  "run.started",
  "pi.event",
  "pi.stderr",
  "pi.invalid",
  "diagnostic",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const runEventSchema = z.object({
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  correlationId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  type: runEventTypeSchema,
  payload: z.record(z.unknown()),
});

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = z.infer<typeof runEventTypeSchema>;

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

export function makeRunEvent(
  runId: string,
  correlationId: string,
  sequence: number,
  type: RunEventType,
  payload: Record<string, unknown>,
): RunEvent {
  return runEventSchema.parse({ runId, correlationId, sequence, timestamp: new Date().toISOString(), type, payload });
}
