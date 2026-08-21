import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  makeResearchEvent,
  researchRunRecordSchema,
  type ResearchEvent,
  type ResearchRunRecord,
} from "../../../packages/shared/src/research/contracts.js";
import {
  FileResearchEventStore,
  MemoryResearchEventStore,
  ResearchEventStoreError,
} from "../../../apps/server/src/research/events.js";
import {
  FileResearchRunRecordStore,
  MemoryResearchRunRecordStore,
} from "../../../apps/server/src/research/store.js";

const timestamp = "2026-08-13T12:00:00.000Z";
const correlationId = randomUUID();

function record(overrides: Partial<ResearchRunRecord> = {}): ResearchRunRecord {
  return researchRunRecordSchema.parse({
    schemaVersion: 1,
    runId: "run-1",
    correlationId,
    projectId: "project-1",
    profileId: "fixture",
    brief: {
      schemaVersion: 1,
      briefId: "brief-1",
      projectId: "project-1",
      question: "What should we investigate?",
      scope: "The bounded fixture scope.",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    recipe: "standard",
    status: "running",
    currentStage: { stage: "researching", status: "running", startedAt: timestamp },
    stageHistory: [{ stage: "planning", status: "completed", startedAt: timestamp, endedAt: timestamp }],
    requiredCapabilities: [{ id: "web-search", label: "Web search", description: "Configured search", required: true }],
    capabilities: null,
    session: { sessionId: "session-1", eventCount: 1, lastEventAt: timestamp },
    artifacts: [],
    cancellation: { requested: false },
    diagnostics: null,
    processExit: null,
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    lastEventAt: timestamp,
    ...overrides,
  });
}

function event(sequence: number, type: ResearchEvent["type"] = "research.progress"): ResearchEvent {
  return {
    ...makeResearchEvent("run-1", correlationId, sequence, type, { sequence }),
    timestamp,
  };
}

describe("file-backed research persistence", () => {
  it("atomically persists records and reconstructs them with a fresh store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-records-"));
    try {
      const firstStore = new FileResearchRunRecordStore(root);
      const initial = record();
      await firstStore.save(initial);
      const running = record({ status: "partial", endedAt: timestamp, durationMs: 123, diagnostics: { code: "PARTIAL", message: "notes retained" } });
      const completed = record({ status: "completed", endedAt: timestamp, durationMs: 456 });
      await Promise.all([firstStore.save(running), firstStore.save(completed)]);

      const secondStore = new FileResearchRunRecordStore(root);
      const recovered = await secondStore.get("run-1");
      expect(recovered).toMatchObject({ runId: "run-1", status: "completed", durationMs: 456 });
      expect(await secondStore.list("project-1")).toHaveLength(1);
      expect(await secondStore.list("other-project")).toEqual([]);

      recovered!.session.eventCount = 999;
      expect((await secondStore.get("run-1"))!.session.eventCount).toBe(1);
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(await readFile(path.join(root, "run-1.json"))).status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconstructs frozen source, synthesis, citation, and proposal lineage without aliasing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-records-"));
    try {
      const checksum = "c".repeat(64);
      const stored = record({
        frozenSourceBindings: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", checksum, required: true, citationKey: "primary-source" }],
        synthesisAttempts: [{
          attemptId: "synthesis-1",
          parentAttemptId: null,
          status: "completed",
          input: {
            confirmedBriefRevision: 1,
            confirmedBriefHash: checksum,
            sourceBindings: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", checksum, required: true, citationKey: "primary-source" }],
            notesArtifactId: "notes-1",
            notesSha256: checksum,
            profileId: "fixture",
            priorAttemptId: null,
          },
          notesArtifactId: "notes-1",
          reportArtifactId: "report-1",
          citationValidation: {
            status: "valid",
            unresolvedKeys: [],
            ambiguousKeys: [],
            usages: [{ usageId: "usage-1", citationKey: "primary-source", sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", location: { relativePath: "research/report.md", line: 4 } }],
            diagnostics: "",
          },
          diagnostics: null,
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
        }],
        latestSynthesisAttemptId: "synthesis-1",
        proposal: {
          proposalId: "proposal-1",
          status: "pending",
          decision: null,
          artifactIds: ["report-1", "notes-1", "manifest-1"],
          reportArtifactId: "report-1",
          notesArtifactId: "notes-1",
          manifestArtifactId: "manifest-1",
          cleanup: { status: "pending", startedAt: null, endedAt: null, diagnostics: null },
          createdAt: timestamp,
          updatedAt: timestamp,
          decidedAt: null,
        },
      });
      const firstStore = new FileResearchRunRecordStore(root);
      await firstStore.save(stored);
      const secondStore = new FileResearchRunRecordStore(root);
      const recovered = await secondStore.get("run-1");

      expect(recovered?.frozenSourceBindings).toEqual(stored.frozenSourceBindings);
      expect(recovered?.synthesisAttempts[0]?.citationValidation?.usages[0]).toMatchObject({
        citationKey: "primary-source",
        versionId: "ev_1234567890abcdef",
        location: { relativePath: "research/report.md", line: 4 },
      });
      expect(recovered?.proposal).toMatchObject({ status: "pending", artifactIds: ["report-1", "notes-1", "manifest-1"] });

      recovered!.frozenSourceBindings[0]!.checksum = "d".repeat(64);
      recovered!.synthesisAttempts[0]!.input.sourceBindings[0]!.checksum = "d".repeat(64);
      expect((await secondStore.get("run-1"))?.frozenSourceBindings[0]?.checksum).toBe(checksum);
      expect((await secondStore.get("run-1"))?.synthesisAttempts[0]?.input.sourceBindings[0]?.checksum).toBe(checksum);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for absent records and rejects malformed or truncated snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-records-"));
    try {
      const store = new FileResearchRunRecordStore(root);
      expect(await store.get("missing-run")).toBeNull();
      await writeFile(path.join(root, "broken.json"), "{\"runId\":\"broken");
      await expect(store.get("broken")).rejects.toMatchObject({ name: "ResearchStoreError", code: "INVALID_RECORD" });
      await writeFile(path.join(root, "wrong.json"), JSON.stringify(record({ runId: "different" })));
      await expect(store.get("wrong")).rejects.toMatchObject({ name: "ResearchStoreError", code: "INVALID_RECORD" });
      await expect(store.get("../escape")).rejects.toMatchObject({ name: "ResearchStoreError", code: "INVALID_RUN_ID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps memory records isolated from caller mutation and filters by project", async () => {
    const store = new MemoryResearchRunRecordStore();
    const stored = record();
    await store.save(stored);
    stored.status = "failed";
    expect((await store.get("run-1"))!.status).toBe("running");
    expect(await store.list("project-1")).toHaveLength(1);
    expect(await store.list("project-2")).toEqual([]);
  });
});

describe("ordered research event persistence", () => {
  it("serializes concurrent appends and replays ordered events after reconstruction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-events-"));
    try {
      const firstStore = new FileResearchEventStore(root);
      await firstStore.append(event(0, "research.started"));
      await Promise.all([firstStore.append(event(1)), firstStore.append(event(2)), firstStore.append(event(3, "research.completed"))]);

      const secondStore = new FileResearchEventStore(root);
      const events = await secondStore.list("run-1");
      expect(events.map((item) => item.sequence)).toEqual([0, 1, 2, 3]);
      expect(events.at(-1)?.type).toBe("research.completed");
      expect(await secondStore.list("missing-run")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects gaps, duplicates, correlation changes, malformed lines, and blank lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-events-"));
    try {
      const store = new FileResearchEventStore(root);
      await expect(store.append(event(1))).rejects.toMatchObject({ code: "SEQUENCE_ERROR" });
      await store.append(event(0, "research.started"));
      await expect(store.append(event(0))).rejects.toMatchObject({ code: "SEQUENCE_ERROR" });
      await expect(store.append({ ...event(1), correlationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_EVENT" });
      await expect(store.append(event(2))).rejects.toMatchObject({ code: "SEQUENCE_ERROR" });

      await writeFile(path.join(root, "broken.jsonl"), "{\"schemaVersion\":1\n");
      await expect(store.list("broken")).rejects.toMatchObject({ name: "ResearchEventStoreError", code: "INVALID_EVENT" });
      await writeFile(path.join(root, "blank.jsonl"), `${JSON.stringify(event(0))}\n\n`);
      await expect(store.list("blank")).rejects.toMatchObject({ name: "ResearchEventStoreError", code: "INVALID_EVENT" });
      await expect(store.list("../escape")).rejects.toMatchObject({ name: "ResearchEventStoreError", code: "INVALID_RUN_ID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the same sequence and correlation contract in memory", async () => {
    const store = new MemoryResearchEventStore();
    await store.append(event(0, "research.started"));
    await expect(store.append(event(2))).rejects.toBeInstanceOf(ResearchEventStoreError);
    await expect(store.append({ ...event(1), correlationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_EVENT" });
    await store.append(event(1, "research.completed"));
    expect((await store.list("run-1")).map((item) => item.sequence)).toEqual([0, 1]);
  });
});

