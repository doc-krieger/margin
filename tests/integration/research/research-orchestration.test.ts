import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "../../helpers/test-api.js";
import {
  makeResearchEvent,
  researchRunRecordSchema,
} from "../../../packages/shared/src/research/contracts.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { CommentService } from "../../../apps/server/src/comments/repository.js";
import { defaultPiProfileManifest } from "../../../apps/server/src/pi/manifest.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import {
  FileResearchEventStore,
  MemoryResearchEventStore,
} from "../../../apps/server/src/research/events.js";
import {
  FileResearchBriefStore,
  FileResearchRunRecordStore,
  MemoryResearchBriefStore,
  MemoryResearchRunRecordStore,
} from "../../../apps/server/src/research/store.js";
import { ResearchRunService, type ResearchExecutor } from "../../../apps/server/src/research/service.js";
import type { ResearchCapabilityProfile } from "../../../apps/server/src/research/capabilities.js";
import type { RegisteredProject } from "../../../apps/server/src/projects/registry.js";

const tempPaths: string[] = [];
const profile: ResearchCapabilityProfile = {
  id: "test-profile",
  label: "Deterministic test Pi",
  status: "available",
  manifest: defaultPiProfileManifest({ command: "test-pi" }),
  allowedCapabilities: ["web.search"],
  presentedTools: ["web.search"],
};

function capabilityRunner() {
  return {
    discover: async (candidate: ResearchCapabilityProfile) => ({ status: "available" as const, manifest: candidate.manifest, version: "test", message: "available" }),
    smoke: async () => ({ state: { sessionId: "session-test" }, sessionStats: { tokens: { total: 1 } } }),
  };
}

function registerProject(projects: ProjectLifecycleService, projectPath: string, projectId = "project-test"): RegisteredProject {
  const project: RegisteredProject = {
    id: projectId,
    name: "Test project",
    path: projectPath,
    manifestPath: path.join(projectPath, ".margin", "project.yaml"),
    rootPath: path.dirname(projectPath),
    gitInitialized: true,
    markdownFiles: [],
    files: [],
    openedAt: new Date().toISOString(),
  };
  projects.registry.registerProject(project);
  return project;
}

function makeService(executor: ResearchExecutor, candidate = profile) {
  return new ResearchRunService({
    profiles: [candidate],
    recordStore: new MemoryResearchRunRecordStore(),
    eventStore: new MemoryResearchEventStore(),
    briefStore: new MemoryResearchBriefStore(),
    capabilityRunner: capabilityRunner(),
    executor,
  });
}

async function brief(service: ResearchRunService, projectId: string) {
  return service.saveBrief(projectId, { question: "What matters?", scope: "A bounded test scope", recipe: "quick" });
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("research orchestration", () => {
  it("fails required capability denial before executing Pi", async () => {
    let executed = false;
    const denied: ResearchCapabilityProfile = { ...profile, presentedTools: [], allowedCapabilities: [] };
    const service = makeService({ run: async () => { executed = true; return {}; } }, denied);
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-"));
    tempPaths.push(root);
    const saved = await brief(service, "project-test");
    const run = await service.start({
      projectId: "project-test",
      repositoryRoot: root,
      briefId: saved.briefId,
      profileId: denied.id,
      requiredCapabilities: [{ id: "web.search", label: "Web search", required: true }],
    });
    expect(run.status).toBe("failed");
    expect(run.diagnostics?.code).toBe("RESEARCH_CAPABILITY_UNAVAILABLE");
    expect(executed).toBe(false);
    expect((await service.events(run.runId)).map((event) => event.type)).toContain("research.failed");
  });

  it("persists cancellation and returns the same terminal truth on repeated cancel", async () => {
    const executor: ResearchExecutor = {
      run: async ({ signal, emit }) => {
        await emit("research.progress", { sessionId: "session-test", message: "started" });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { sessionId: "session-test" };
      },
    };
    const service = makeService(executor);
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-"));
    tempPaths.push(root);
    const saved = await brief(service, "project-test");
    const started = await service.start({ projectId: "project-test", repositoryRoot: root, briefId: saved.briefId, profileId: profile.id });
    const cancelled = await service.cancel(started.runId, "stop now");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation.reason).toBe("stop now");
    expect((await service.cancel(started.runId, "second request")).runId).toBe(started.runId);
    const events = await service.events(started.runId);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events.at(-1)?.type).toBe("research.cancelled");
  });

  it("recovers active file-backed runs as process-loss failures with replayable continuity", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "margin-research-recovery-"));
    tempPaths.push(dataDirectory);
    const recordStore = new FileResearchRunRecordStore(path.join(dataDirectory, "records"));
    const eventStore = new FileResearchEventStore(path.join(dataDirectory, "events"));
    const briefStore = new FileResearchBriefStore(path.join(dataDirectory, "briefs"));
    const seed = new ResearchRunService({
      profiles: [profile],
      recordStore,
      eventStore,
      briefStore,
      capabilityRunner: capabilityRunner(),
      executor: { run: async () => ({}) },
    });
    const savedBrief = await seed.saveBrief("project-test", { question: "What survives restart?", scope: "Recovery continuity", recipe: "quick" });
    const runId = `recovery-${randomUUID()}`;
    const correlationId = randomUUID();
    const timestamp = "2026-08-13T12:00:00.000Z";
    const activeRecord = researchRunRecordSchema.parse({
      schemaVersion: 1,
      runId,
      correlationId,
      projectId: "project-test",
      profileId: profile.id,
      brief: savedBrief,
      recipe: savedBrief.recipe,
      status: "running",
      currentStage: { stage: "planning", status: "running", startedAt: timestamp, endedAt: null, artifactIds: ["notes-1"], diagnostics: null },
      stageHistory: [],
      requiredCapabilities: [],
      capabilities: null,
      session: { sessionId: "session-recovery", eventCount: 1, commandCount: 1, promptCount: 1, lastEventAt: timestamp },
      artifacts: [{ artifactId: "notes-1", kind: "notes", status: "partial", relativePath: "research/notes.md", label: "partial notes", bytes: 42, sha256: null, createdAt: timestamp, updatedAt: timestamp }],
      cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
      diagnostics: null,
      processExit: null,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      lastEventAt: timestamp,
    });
    await recordStore.save(activeRecord);
    await eventStore.append(makeResearchEvent(runId, correlationId, 0, "research.started", { status: "running" }));
    await eventStore.append(makeResearchEvent(runId, correlationId, 1, "research.artifact", { artifactId: "notes-1", status: "partial", relativePath: "research/notes.md" }));

    const recovered = new ResearchRunService({
      profiles: [profile],
      recordStore,
      eventStore,
      briefStore,
      capabilityRunner: capabilityRunner(),
      executor: { run: async () => ({}) },
    });
    await recovered.ready();

    const terminal = await recovered.get(runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.diagnostics?.code).toBe("RESEARCH_PROCESS_LOST");
    expect(terminal.artifacts.map(({ artifactId, status }) => ({ artifactId, status }))).toEqual([{ artifactId: "notes-1", status: "partial" }]);
    expect(terminal.endedAt).not.toBeNull();

    const allEvents = await recovered.events(runId);
    expect(allEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect({ type: allEvents.at(-1)?.type, sequence: allEvents.at(-1)?.sequence }).toEqual({ type: "research.failed", sequence: 2 });
    expect((await recovered.events(runId, 0)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("exposes project-scoped briefs and correlated profile and run routes", async () => {
    const executor: ResearchExecutor = { run: async () => ({ sessionId: "session-test" }) };
    const service = makeService(executor);
    const projects = new ProjectLifecycleService();
    const root = await mkdtemp(path.join(tmpdir(), "margin-research-"));
    tempPaths.push(root);
    const project = registerProject(projects, root);
    const app = buildApp({ projectService: projects, researchService: service, commentService: new CommentService(":memory:") });
    const correlationId = "00000000-0000-4000-8000-000000000042";

    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/research/briefs`, headers: { "x-correlation-id": correlationId }, payload: { question: "What matters?", scope: "A bounded test scope", recipe: "quick" } });
    expect(created.statusCode).toBe(201);
    expect(created.headers["x-correlation-id"]).toBe(correlationId);
    const briefId = created.json().brief.briefId as string;

    const profiles = await app.inject({ method: "GET", url: "/api/research/profiles" });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json().profiles[0].id).toBe(profile.id);

    const started = await app.inject({ method: "POST", url: `/api/projects/${project.id}/research/runs`, payload: { briefId, profileId: profile.id } });
    expect(started.statusCode).toBe(202);
    const runId = started.json().runId as string;
    const read = await app.inject({ method: "GET", url: `/api/research/runs/${runId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().run.runId).toBe(runId);
    await app.close();
  });
});
