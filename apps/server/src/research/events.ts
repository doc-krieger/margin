import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  makeResearchEvent,
  researchEventSchema,
  researchEventTypeSchema,
  researchRunIdSchema,
  type ResearchEvent,
  type ResearchEventType,
} from "../../../../packages/shared/src/research/contracts.js";

export { makeResearchEvent, researchEventSchema, researchEventTypeSchema };
export type { ResearchEvent, ResearchEventType };

export type ResearchEventStoreErrorCode = "INVALID_RUN_ID" | "INVALID_EVENT" | "SEQUENCE_ERROR" | "IO_ERROR";

export class ResearchEventStoreError extends Error {
  constructor(
    public readonly code: ResearchEventStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ResearchEventStoreError";
  }
}

export interface ResearchEventStore {
  append(event: ResearchEvent): Promise<void>;
  list(runId: string): Promise<ResearchEvent[]>;
}

const persistedRunIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function assertRunId(runId: string): string {
  try {
    researchRunIdSchema.parse(runId);
  } catch (error) {
    throw new ResearchEventStoreError("INVALID_RUN_ID", `Invalid research run ID: ${runId}`, { cause: error });
  }
  if (!persistedRunIdPattern.test(runId) || runId.includes("..")) {
    throw new ResearchEventStoreError("INVALID_RUN_ID", `Invalid research run ID for event persistence: ${runId}`);
  }
  return runId;
}

function eventPath(root: string, runId: string): string {
  return path.join(root, `${assertRunId(runId)}.jsonl`);
}

function parseEventLine(line: string, runId: string, lineNumber: number): ResearchEvent {
  try {
    const event = researchEventSchema.parse(JSON.parse(line));
    if (event.runId !== runId) throw new Error(`event runId ${event.runId} does not match ${runId}`);
    return event;
  } catch (error) {
    throw new ResearchEventStoreError(
      "INVALID_EVENT",
      `Invalid persisted research event ${runId} at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validateOrderedEvents(events: ResearchEvent[], runId: string): ResearchEvent[] {
  let expected = 0;
  let correlationId: string | undefined;
  for (const event of events) {
    if (event.runId !== runId) {
      throw new ResearchEventStoreError("INVALID_EVENT", `Research event run ID mismatch for ${runId}`);
    }
    if (event.sequence !== expected) {
      throw new ResearchEventStoreError("SEQUENCE_ERROR", `Research event sequence for ${runId} expected ${expected}, received ${event.sequence}`);
    }
    if (correlationId && event.correlationId !== correlationId) {
      throw new ResearchEventStoreError("INVALID_EVENT", `Research event correlation mismatch for ${runId}`);
    }
    correlationId = event.correlationId;
    expected += 1;
  }
  return events;
}

async function readPersistedEvents(root: string, runId: string): Promise<ResearchEvent[]> {
  const validatedRunId = assertRunId(runId);
  let contents: string;
  try {
    contents = await readFile(eventPath(root, validatedRunId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ResearchEventStoreError("IO_ERROR", `Unable to read research events for ${validatedRunId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (contents.length === 0) return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.trim() === "")) {
    throw new ResearchEventStoreError("INVALID_EVENT", `Blank line in persisted research events for ${validatedRunId}`);
  }
  return validateOrderedEvents(lines.map((line, index) => parseEventLine(line, validatedRunId, index + 1)), validatedRunId);
}

/** Append-only JSONL event storage with strict replay validation for reconnect and recovery. */
export class FileResearchEventStore implements ResearchEventStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async append(event: ResearchEvent): Promise<void> {
    let parsed: ResearchEvent;
    try {
      parsed = researchEventSchema.parse(event);
    } catch (error) {
      throw new ResearchEventStoreError("INVALID_EVENT", `Cannot append invalid research event: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const runId = assertRunId(parsed.runId);
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      const existing = await readPersistedEvents(this.root, runId);
      const expected = existing.length;
      if (parsed.sequence !== expected) {
        throw new ResearchEventStoreError("SEQUENCE_ERROR", `Research event sequence for ${runId} expected ${expected}, received ${parsed.sequence}`);
      }
      if (existing.length > 0 && existing.at(-1)!.correlationId !== parsed.correlationId) {
        throw new ResearchEventStoreError("INVALID_EVENT", `Research event correlation mismatch for ${runId}`);
      }
      try {
        await appendFile(eventPath(this.root, runId), `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        throw new ResearchEventStoreError("IO_ERROR", `Unable to append research event for ${runId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }).catch((error) => {
      if (error instanceof ResearchEventStoreError) throw error;
      throw new ResearchEventStoreError("IO_ERROR", `Unable to append research event for ${runId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    this.writes.set(runId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(runId) === next) this.writes.delete(runId);
    }
  }

  async list(runId: string): Promise<ResearchEvent[]> {
    return (await readPersistedEvents(this.root, runId)).map((event) => researchEventSchema.parse(JSON.parse(JSON.stringify(event))));
  }
}

export class MemoryResearchEventStore implements ResearchEventStore {
  private readonly events = new Map<string, ResearchEvent[]>();
  private readonly writes = new Map<string, Promise<void>>();

  async append(event: ResearchEvent): Promise<void> {
    let parsed: ResearchEvent;
    try {
      parsed = researchEventSchema.parse(event);
    } catch (error) {
      throw new ResearchEventStoreError("INVALID_EVENT", `Cannot append invalid research event: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const runId = assertRunId(parsed.runId);
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const next = previous.then(() => {
      const events = this.events.get(runId) ?? [];
      const expected = events.length;
      if (parsed.sequence !== expected) throw new ResearchEventStoreError("SEQUENCE_ERROR", `Research event sequence for ${runId} expected ${expected}, received ${parsed.sequence}`);
      if (events.length > 0 && events.at(-1)!.correlationId !== parsed.correlationId) throw new ResearchEventStoreError("INVALID_EVENT", `Research event correlation mismatch for ${runId}`);
      events.push(parsed);
      this.events.set(runId, events);
    });
    this.writes.set(runId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(runId) === next) this.writes.delete(runId);
    }
  }

  async list(runId: string): Promise<ResearchEvent[]> {
    const validatedRunId = assertRunId(runId);
    const events = this.events.get(validatedRunId) ?? [];
    return validateOrderedEvents(events.map((event) => researchEventSchema.parse(JSON.parse(JSON.stringify(event)))), validatedRunId);
  }
}

