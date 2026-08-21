import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import {
  isActiveResearchRunStatus,
  isTerminalResearchRunStatus,
  makeResearchEvent,
  researchBriefSchema,
  researchCapabilityDeclarationSchema,
  researchRunIdSchema,
  researchRunRecordSchema,
  researchRecipeDefinitions,
  researchSynthesisAttemptSchema,
  researchSynthesisInputSchema,
  type ResearchBrief,
  type ResearchCapabilityDeclaration,
  type ResearchEvent,
  type ResearchEventType,
  type ResearchRunRecord,
  type ResearchSourceProjection,
  type ResearchSourceSelection,
  type ResearchStageName,
  type ResearchStageRecord,
  type ResearchArtifactKind,
  type ResearchFrozenSourceBinding,
  type ResearchProposalLineage,
  type ResearchSynthesisAttempt,
} from "../../../../packages/shared/src/research/contracts.js";
import { runPiProcess, type PiRunInput, type PiRunResult } from "../pi/adapter.js";
import { GitCheckpointService, type GitCheckpoint } from "../git/checkpoint.js";
import { ProposalService } from "../proposals/service.js";
import type { ProposalRecord } from "../proposals/store.js";
import { citationKeyForBinding, validateReportCitations } from "./citation-validation.js";
import { artifactHash, describeResearchArtifact, materializeResearchArtifact, type ResearchArtifactOutput } from "./workflow.js";
import { defaultPiProfileManifest, parsePiProfileManifest, type PiProfileManifest } from "../pi/manifest.js";
import { FileResearchEventStore, type ResearchEventStore } from "./events.js";
import {
  FileResearchBriefStore,
  FileResearchRunRecordStore,
  type ResearchBriefStore,
  type ResearchRunRecordStore,
} from "./store.js";
import {
  capabilityFailureDiagnostics,
  preflightResearchCapabilities,
  requiredCapabilitiesAvailable,
  type CapabilityDiscoveryRunner,
  type ResearchCapabilityProfile,
} from "./capabilities.js";

export interface ResearchProfile extends ResearchCapabilityProfile {
  id: string;
  manifest: PiProfileManifest;
  status: "available" | "unavailable";
}

export interface ResearchExecutorInput {
  manifest: PiProfileManifest;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  runId: string;
  correlationId: string;
  emit: (type: ResearchEventType, payload: Record<string, unknown>) => Promise<void>;
}

export interface ResearchExecutorResult {
  sessionId?: string | null;
  durationMs?: number | null;
  processExit?: ResearchRunRecord["processExit"];
  /** Structured outputs are accepted only from the executor; the service validates and hashes them before review. */
  artifacts?: ResearchArtifactOutput[];
  notes?: string;
  report?: string;
}

export interface ResearchExecutor {
  run(input: ResearchExecutorInput): Promise<ResearchExecutorResult>;
}

export interface ResearchSourceProjector {
  project(input: {
    canonicalRoot: string;
    worktreePath: string;
    selections: ResearchSourceSelection[];
    runId?: string;
  }): Promise<ResearchSourceProjection>;
}

export interface ResearchRunServiceOptions {
  profiles?: ResearchProfile[];
  recordStore?: ResearchRunRecordStore;
  eventStore?: ResearchEventStore;
  briefStore?: ResearchBriefStore;
  executor?: ResearchExecutor;
  capabilityRunner?: CapabilityDiscoveryRunner;
  sourceProjector?: ResearchSourceProjector;
  proposalService?: ProposalService;
  checkpointService?: GitCheckpointService;
  dataDirectory?: string;
  clock?: () => Date;
}

export interface StartResearchRunInput {
  projectId: string;
  repositoryRoot: string;
  briefId: string;
  profileId: string;
  requiredCapabilities?: ResearchCapabilityDeclaration[];
  sourceSelections?: ResearchSourceSelection[];
  worktreePath?: string;
  outputPaths?: { reportPath?: string | null; notesPath?: string | null; manifestPath?: string | null };
}

export type ResearchRunErrorCode =
  | "RESEARCH_RUN_NOT_FOUND"
  | "RESEARCH_BRIEF_NOT_FOUND"
  | "RESEARCH_PROFILE_NOT_FOUND"
  | "RESEARCH_RUN_ALREADY_ACTIVE"
  | "RESEARCH_RUN_NOT_CANCELLABLE"
  | "RESEARCH_CAPABILITY_UNAVAILABLE"
  | "RESEARCH_PROJECT_NOT_FOUND"
  | "RESEARCH_SYNTHESIS_UNAVAILABLE"
  | "RESEARCH_PROPOSAL_NOT_FOUND";

export class ResearchRunError extends Error {
  constructor(public readonly code: ResearchRunErrorCode, message: string) {
    super(message);
    this.name = "ResearchRunError";
  }
}

interface ActiveResearchRun {
  controller: AbortController;
  completion: Promise<ResearchRunRecord>;
}

const MAX_DIAGNOSTICS = 32_000;
const defaultCapabilityDeclarations: ResearchCapabilityDeclaration[] = [];

function bounded(value: string): string {
  return value.length <= MAX_DIAGNOSTICS ? value : `${value.slice(0, MAX_DIAGNOSTICS - 32)}\n[diagnostics truncated]`;
}

function now(clock: () => Date): string {
  return clock().toISOString();
}

function errorDetails(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; diagnostics?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "RESEARCH_EXECUTOR_FAILED",
    message: bounded(typeof candidate?.diagnostics === "string" ? candidate.diagnostics : error instanceof Error ? error.message : String(error)),
  };
}

function stage(stage: ResearchStageName, status: ResearchStageRecord["status"], timestamp: string, diagnostics: string | null = null): ResearchStageRecord {
  return { stage, status, startedAt: status === "pending" ? null : timestamp, endedAt: ["completed", "failed", "cancelled", "skipped"].includes(status) ? timestamp : null, artifactIds: [], diagnostics };
}

function initialRecord(input: StartResearchRunInput, runId: string, correlationId: string, brief: ResearchBrief, required: ResearchCapabilityDeclaration[], createdAt: string): ResearchRunRecord {
  const firstStage = researchRecipeDefinitions[brief.recipe].suggestedStages[0] as ResearchStageName;
  return researchRunRecordSchema.parse({
    schemaVersion: 1,
    runId,
    correlationId,
    projectId: input.projectId,
    profileId: input.profileId,
    brief,
    recipe: brief.recipe,
    status: "queued",
    currentStage: stage(firstStage, "pending", createdAt),
    stageHistory: [],
    requiredCapabilities: required,
    sourceSelections: input.sourceSelections ?? [],
    sourceProjection: null,
    capabilities: null,
    session: { sessionId: null, eventCount: 0, commandCount: 0, promptCount: 0, lastEventAt: null },
    artifacts: [],
    cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
    diagnostics: null,
    processExit: null,
    frozenSourceBindings: [],
    synthesisAttempts: [],
    latestSynthesisAttemptId: null,
    proposal: null,
    createdAt,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    lastEventAt: null,
  });
}

/** Coordinates bounded research lifecycle state; records are authoritative and events are replay evidence. */
export class ResearchRunService {
  private readonly profiles = new Map<string, ResearchProfile>();
  private readonly active = new Map<string, ActiveResearchRun>();
  private readonly subscribers = new Map<string, Set<(event: ResearchEvent) => void>>();
  private readonly eventWrites = new Map<string, Promise<void>>();
  private readonly recordWrites = new Map<string, Promise<void>>();
  private readonly recordStore: ResearchRunRecordStore;
  private readonly eventStore: ResearchEventStore;
  private readonly briefStore: ResearchBriefStore;
  private readonly executor: ResearchExecutor;
  private readonly capabilityRunner?: CapabilityDiscoveryRunner;
  private readonly sourceProjector?: ResearchSourceProjector;
  private readonly proposalService?: ProposalService;
  private readonly checkpointService?: GitCheckpointService;
  private readonly clock: () => Date;
  private readonly recovery: Promise<void>;

  constructor(options: ResearchRunServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    const dataDirectory = options.dataDirectory ?? process.env.MARGIN_RESEARCH_DATA_DIR ?? path.join(homedir(), ".margin", "research");
    this.recordStore = options.recordStore ?? new FileResearchRunRecordStore(path.join(dataDirectory, "records"));
    this.eventStore = options.eventStore ?? new FileResearchEventStore(path.join(dataDirectory, "events"));
    this.briefStore = options.briefStore ?? new FileResearchBriefStore(path.join(dataDirectory, "briefs"));
    this.capabilityRunner = options.capabilityRunner;
    this.sourceProjector = options.sourceProjector;
    this.proposalService = options.proposalService;
    this.checkpointService = options.checkpointService ?? (this.proposalService ? new GitCheckpointService() : undefined);
    this.executor = options.executor ?? { run: (input) => this.runPi(input) };
    if (this.proposalService) {
      this.proposalService.setDecisionObserver(async (proposal) => this.recordProposalDecision(proposal));
    }
    for (const profile of options.profiles ?? [{ id: "default", label: "Pi", status: "available" as const, manifest: defaultPiProfileManifest() }]) {
      this.profiles.set(profile.id, { ...profile, manifest: parsePiProfileManifest(profile.manifest) });
    }
    this.recovery = this.recoverActiveRuns();
  }

  async ready(): Promise<void> { await this.recovery; }

  listProfiles(): ResearchProfile[] {
    return [...this.profiles.values()].map((profile) => ({ ...profile, manifest: { ...profile.manifest, runArgs: [...profile.manifest.runArgs], versionArgs: [...profile.manifest.versionArgs] } }));
  }

  getProfile(profileId: string): ResearchProfile | undefined { return this.profiles.get(profileId); }

  async saveBrief(projectId: string, input: unknown): Promise<ResearchBrief> {
    await this.ready();
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const briefId = typeof body.briefId === "string" ? body.briefId : randomUUID();
    const existing = await this.briefStore.get(projectId, briefId);
    const timestamp = now(this.clock);
    const brief = researchBriefSchema.parse({ ...body, schemaVersion: 1, briefId, projectId, revision: existing ? existing.revision + 1 : body.revision ?? 1, createdAt: existing?.createdAt ?? body.createdAt ?? timestamp, updatedAt: timestamp });
    await this.briefStore.save(brief);
    return brief;
  }

  async getBrief(projectId: string, briefId: string): Promise<ResearchBrief> {
    await this.ready();
    const brief = await this.briefStore.get(projectId, briefId);
    if (!brief) throw new ResearchRunError("RESEARCH_BRIEF_NOT_FOUND", `Research brief ${briefId} was not found`);
    return brief;
  }

  async listBriefs(projectId: string): Promise<ResearchBrief[]> { await this.ready(); return this.briefStore.list(projectId); }

  async capabilities(profileId: string, required: ResearchCapabilityDeclaration[] = defaultCapabilityDeclarations) {
    await this.ready();
    const profile = this.profiles.get(profileId);
    if (!profile) throw new ResearchRunError("RESEARCH_PROFILE_NOT_FOUND", `Research profile ${profileId} is not configured`);
    return preflightResearchCapabilities(profile, required, { runner: this.capabilityRunner, now: this.clock });
  }

  async get(runId: string): Promise<ResearchRunRecord> {
    await this.ready();
    researchRunIdSchema.parse(runId);
    const record = await this.recordStore.get(runId);
    if (!record) throw new ResearchRunError("RESEARCH_RUN_NOT_FOUND", `Research run ${runId} was not found`);
    return record;
  }

  async list(projectId?: string): Promise<ResearchRunRecord[]> { await this.ready(); return this.recordStore.list(projectId); }

  async events(runId: string, after = -1): Promise<ResearchEvent[]> {
    await this.get(runId);
    return (await this.eventStore.list(runId)).filter((event) => event.sequence > after);
  }

  subscribe(runId: string, listener: (event: ResearchEvent) => void): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<(event: ResearchEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.subscribers.delete(runId); };
  }

  async start(input: StartResearchRunInput): Promise<ResearchRunRecord> {
    await this.ready();
    if (this.active.has(input.projectId) || (await this.recordStore.list(input.projectId)).some((record) => isActiveResearchRunStatus(record.status))) {
      throw new ResearchRunError("RESEARCH_RUN_ALREADY_ACTIVE", `Project ${input.projectId} already has an active research run`);
    }
    const profile = this.profiles.get(input.profileId);
    if (!profile) throw new ResearchRunError("RESEARCH_PROFILE_NOT_FOUND", `Research profile ${input.profileId} is not configured`);
    const brief = await this.getBrief(input.projectId, input.briefId);
    const required = (input.requiredCapabilities ?? defaultCapabilityDeclarations).map((item) => researchCapabilityDeclarationSchema.parse(item));
    const sourceSelections = (input.sourceSelections ?? []).map((item) => ({ sourceId: item.sourceId, versionId: item.versionId, required: item.required !== false }));

    // Capability preflight is intentionally before run allocation. A terminal
    // diagnostic snapshot is retained for existing clients, but no queued or
    // running record is ever persisted and the executor is never invoked.
    const capabilities = await this.capabilities(profile.id, required);
    const runId = randomUUID();
    if (!requiredCapabilitiesAvailable(capabilities)) {
      const timestamp = now(this.clock);
      let denied = initialRecord({ ...input, sourceSelections }, runId, randomUUID(), brief, required, timestamp);
      denied = await this.save({ ...denied, status: "failed", capabilities, currentStage: stage(denied.currentStage.stage, "failed", timestamp, capabilityFailureDiagnostics(capabilities)), diagnostics: { code: "RESEARCH_CAPABILITY_UNAVAILABLE", message: capabilityFailureDiagnostics(capabilities), stderr: "", protocol: null, processExit: null }, endedAt: timestamp, durationMs: 0 });
      await this.emit(denied, "research.capability", { capabilities });
      return this.fail(denied, "RESEARCH_CAPABILITY_UNAVAILABLE", capabilityFailureDiagnostics(capabilities));
    }

    let record = initialRecord({ ...input, sourceSelections }, runId, randomUUID(), brief, required, now(this.clock));
    await this.save(record);
    await this.emit(record, "research.started", { status: record.status, profileId: profile.id, recipe: record.recipe });
    const startedAt = now(this.clock);
    record = await this.save({ ...record, capabilities, status: "running", startedAt, currentStage: stage(record.currentStage.stage, "running", startedAt) });
    await this.emit(record, "research.capability", { capabilities });
    const controller = new AbortController();
    const completion = this.execute(record, input, profile, controller.signal);
    this.active.set(input.projectId, { controller, completion });
    void completion.finally(() => { if (this.active.get(input.projectId)?.completion === completion) this.active.delete(input.projectId); }).catch(() => undefined);
    return record;
  }

  async cancel(runId: string, reason = "cancelled by user"): Promise<ResearchRunRecord> {
    const record = await this.get(runId);
    if (isTerminalResearchRunStatus(record.status)) return record;
    const active = this.active.get(record.projectId);
    if (!active) return this.fail(record, "RESEARCH_RUN_NOT_CANCELLABLE", "Research process is no longer active");
    const timestamp = now(this.clock);
    const cancelling = await this.save({ ...record, status: "cancelling", cancellation: { requested: true, requestedAt: timestamp, reason, settledAt: null } });
    await this.emit(cancelling, "research.diagnostic", { code: "RESEARCH_CANCEL_REQUESTED", reason });
    active.controller.abort();
    return active.completion;
  }

  private async execute(initial: ResearchRunRecord, input: StartResearchRunInput, profile: ResearchProfile, signal: AbortSignal): Promise<ResearchRunRecord> {
    let record = initial;
    let checkpoint: GitCheckpoint | undefined;
    let proposalCreated = false;
    try {
      const wantsProposal = record.brief.outputMode === "research-and-report" && Boolean(this.proposalService && this.checkpointService);
      if (wantsProposal) {
        checkpoint = await this.checkpointService!.create({ repositoryRoot: input.repositoryRoot, runId: record.runId });
      }
      const worktreePath = checkpoint?.worktreePath ?? input.worktreePath;
      const outputPaths = { ...record.brief.outputPaths, ...(input.outputPaths ?? {}) };
      const moveStage = async (stageName: ResearchStageName, status: ResearchStageRecord["status"], diagnostics: string | null = null) => {
        const timestamp = now(this.clock);
        const history = record.currentStage.stage === stageName ? record.stageHistory : [...record.stageHistory, record.currentStage];
        record = await this.save({ ...record, currentStage: stage(stageName, status, timestamp, diagnostics), stageHistory: history });
        await this.emit(record, "research.stage", { stage: stageName, status, diagnostics });
      };
      const appendArtifact = async (artifact: ResearchRunRecord["artifacts"][number]) => {
        record = await this.save({ ...record, artifacts: [...record.artifacts.filter((candidate) => candidate.artifactId !== artifact.artifactId), artifact] });
        await this.emit(record, "research.artifact", { artifactId: artifact.artifactId, kind: artifact.kind, status: artifact.status, relativePath: artifact.relativePath, sha256: artifact.sha256 });
      };

      await moveStage("planning", "completed");
      if (record.sourceSelections.length > 0) {
        if (!this.sourceProjector || !worktreePath) {
          return this.partial(record, "RESEARCH_SOURCE_PROJECTION_UNAVAILABLE", "Exact source evidence was requested but no isolated research worktree projector was supplied");
        }
        await moveStage("researching", "running");
        const projection = await this.sourceProjector.project({ canonicalRoot: input.repositoryRoot, worktreePath, selections: record.sourceSelections, runId: record.runId });
        const frozenSourceBindings: ResearchFrozenSourceBinding[] = projection.entries.map((entry) => ({ sourceId: entry.sourceId, versionId: entry.versionId, checksum: entry.checksum, required: entry.required, citationKey: citationKeyForBinding({ sourceId: entry.sourceId, versionId: entry.versionId, citationKey: null }) }));
        record = await this.save({ ...record, sourceProjection: projection, frozenSourceBindings });
        const sourceArtifact = await describeResearchArtifact(worktreePath, { kind: "source-reference", relativePath: projection.manifestPath, artifactId: `source-reference-${record.runId}`, label: "Exact source projection" });
        await appendArtifact(sourceArtifact);
        if (projection.status === "partial" && projection.missing.some((item) => item.required)) {
          return this.partial(record, "RESEARCH_SOURCE_EVIDENCE_MISSING", "One or more required exact source evidence versions could not be projected");
        }
      }

      const persistedBeforeExecutor = await this.recordStore.get(record.runId);
      record = persistedBeforeExecutor ?? record;
      // Cancellation may arrive while planning/source projection is still being
      // persisted, before an executor has a chance to subscribe to the signal.
      // Settle it here instead of invoking a non-cooperative executor with an
      // already-aborted signal (which can otherwise wait forever).
      if (signal.aborted || record.cancellation.requested) return this.cancelled(record);

      const result = await this.executor.run({ manifest: profile.manifest, cwd: worktreePath ?? input.repositoryRoot, prompt: this.prompt(record.brief), signal, runId: record.runId, correlationId: record.correlationId, emit: async (type, payload) => {
        const timestamp = now(this.clock);
        const persisted = (await this.recordStore.get(record.runId)) ?? record;
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : persisted.session.sessionId;
        record = await this.save({ ...persisted, session: { ...persisted.session, sessionId, eventCount: persisted.session.eventCount + 1, lastEventAt: timestamp }, lastEventAt: timestamp });
        await this.emit(record, type, payload);
      } });
      record = (await this.recordStore.get(record.runId)) ?? record;
      record = await this.save({ ...record, session: { ...record.session, sessionId: result.sessionId ?? record.session.sessionId, durationMs: result.durationMs ?? record.session.durationMs }, processExit: result.processExit ?? record.processExit });
      if (signal.aborted || record.cancellation.requested) return this.cancelled(record);

      const outputs = [...(result.artifacts ?? [])];
      if (result.notes !== undefined && !outputs.some((output) => output.kind === "notes")) outputs.push({ kind: "notes", content: result.notes });
      if (result.report !== undefined && !outputs.some((output) => output.kind === "report")) outputs.push({ kind: "report", content: result.report });
      await moveStage("synthesizing", "running");
      const notesOutput = outputs.find((output) => output.kind === "notes");
      const reportOutput = outputs.find((output) => output.kind === "report");
      let notesArtifact: ResearchRunRecord["artifacts"][number] | null = null;
      let reportArtifact: ResearchRunRecord["artifacts"][number] | null = null;
      if (worktreePath && notesOutput) {
        notesArtifact = await materializeResearchArtifact(worktreePath, { ...notesOutput, relativePath: notesOutput.relativePath ?? outputPaths.notesPath ?? undefined }, { now: now(this.clock) });
        await appendArtifact(notesArtifact);
      }
      const frozenSourceBindings = record.frozenSourceBindings;
      const briefHash = createHash("sha256").update(JSON.stringify(record.brief), "utf8").digest("hex");
      const attemptId = `synthesis-${record.runId}-${record.synthesisAttempts.length + 1}`;
      const attemptInput = researchSynthesisInputSchema.parse({ confirmedBriefRevision: record.brief.confirmedRevision ?? record.brief.revision, confirmedBriefHash: briefHash, sourceBindings: frozenSourceBindings, notesArtifactId: notesArtifact?.artifactId ?? null, notesSha256: notesArtifact?.sha256 ?? null, profileId: profile.id, priorAttemptId: record.latestSynthesisAttemptId });
      let attempt: ResearchSynthesisAttempt = researchSynthesisAttemptSchema.parse({ attemptId, parentAttemptId: record.latestSynthesisAttemptId, status: "running", input: attemptInput, notesArtifactId: notesArtifact?.artifactId ?? null, reportArtifactId: null, citationValidation: null, diagnostics: null, createdAt: now(this.clock), startedAt: now(this.clock), endedAt: null });
      record = await this.save({ ...record, synthesisAttempts: [...record.synthesisAttempts, attempt], latestSynthesisAttemptId: attemptId });
      await this.emit(record, "research.progress", { stage: "synthesizing", attemptId, sourceCount: frozenSourceBindings.length });
      if (!notesArtifact) {
        attempt = researchSynthesisAttemptSchema.parse({ ...attempt, status: "partial", diagnostics: "Synthesis did not produce complete notes", endedAt: now(this.clock) });
        record = await this.save({ ...record, synthesisAttempts: record.synthesisAttempts.map((candidate) => candidate.attemptId === attemptId ? attempt : candidate) });
        return this.partial(record, "RESEARCH_NOTES_MISSING", "Synthesis did not produce complete notes");
      }
      if (worktreePath && reportOutput) {
        reportArtifact = await materializeResearchArtifact(worktreePath, { ...reportOutput, relativePath: reportOutput.relativePath ?? outputPaths.reportPath ?? undefined }, { now: now(this.clock) });
        await appendArtifact(reportArtifact);
      }
      if (!reportArtifact && record.brief.outputMode === "research-and-report") {
        attempt = researchSynthesisAttemptSchema.parse({ ...attempt, status: "partial", diagnostics: "Synthesis did not produce a report", endedAt: now(this.clock) });
        record = await this.save({ ...record, synthesisAttempts: record.synthesisAttempts.map((candidate) => candidate.attemptId === attemptId ? attempt : candidate) });
        return this.partial(record, "RESEARCH_REPORT_MISSING", "Synthesis did not produce a report");
      }
      const citationValidation = reportArtifact && worktreePath ? validateReportCitations(await readFile(path.resolve(worktreePath, ...reportArtifact.relativePath.split("/")), "utf8"), reportArtifact.relativePath, frozenSourceBindings) : null;
      if (citationValidation && citationValidation.status !== "valid") {
        attempt = researchSynthesisAttemptSchema.parse({ ...attempt, status: citationValidation.status === "partial" ? "partial" : "failed", reportArtifactId: reportArtifact?.artifactId ?? null, citationValidation, diagnostics: citationValidation.diagnostics, endedAt: now(this.clock) });
        record = await this.save({ ...record, synthesisAttempts: record.synthesisAttempts.map((candidate) => candidate.attemptId === attemptId ? attempt : candidate) });
        await this.emit(record, "research.diagnostic", { code: "RESEARCH_CITATION_INVALID", message: citationValidation.diagnostics, attemptId });
        return this.partial(record, "RESEARCH_CITATION_INVALID", citationValidation.diagnostics);
      }
      attempt = researchSynthesisAttemptSchema.parse({ ...attempt, status: "completed", reportArtifactId: reportArtifact?.artifactId ?? null, citationValidation, endedAt: now(this.clock) });
      record = await this.save({ ...record, synthesisAttempts: record.synthesisAttempts.map((candidate) => candidate.attemptId === attemptId ? attempt : candidate) });
      if (wantsProposal && checkpoint && this.proposalService) {
        const manifestPath = outputPaths.manifestPath ?? "research/sources.yaml";
        const manifestArtifact = await materializeResearchArtifact(checkpoint.worktreePath, { kind: "source-manifest", content: stringify({ schemaVersion: 1, generatedAt: now(this.clock), bindings: frozenSourceBindings, projection: record.sourceProjection }), relativePath: manifestPath, label: "Human-readable source manifest" }, { now: now(this.clock) });
        await appendArtifact(manifestArtifact);
        const proposal = await this.proposalService.createFromRun({
          runId: record.runId,
          repositoryRoot: input.repositoryRoot,
          checkpoint: { sha: checkpoint.checkpointSha, ref: checkpoint.checkpointRef, worktreePath: checkpoint.worktreePath },
          cleanup: checkpoint.cleanup,
          ignoredPaths: record.sourceProjection ? [record.sourceProjection.relativeRoot] : [],
          metadata: { researchRunId: record.runId, synthesisAttemptId: attemptId },
        });
        proposalCreated = true;
        record = await this.save({ ...record, proposal: { proposalId: proposal.proposalId, status: "pending", decision: null, artifactIds: [notesArtifact.artifactId, reportArtifact?.artifactId, manifestArtifact.artifactId].filter((value): value is string => Boolean(value)), reportArtifactId: reportArtifact?.artifactId ?? null, notesArtifactId: notesArtifact.artifactId, manifestArtifactId: manifestArtifact.artifactId, cleanup: { ...proposal.cleanup }, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, decidedAt: null } });
        await this.emit(record, "research.artifact", { kind: "proposal", proposalId: proposal.proposalId, status: proposal.status });
      }
      await moveStage("reviewing", "completed");
      const endedAt = now(this.clock);
      record = await this.save({ ...record, status: "completed", currentStage: stage(record.currentStage.stage, "completed", endedAt), endedAt, durationMs: Math.max(0, this.clock().getTime() - new Date(record.startedAt ?? record.createdAt).getTime()) });
      await this.emit(record, "research.completed", { durationMs: record.durationMs, proposalId: record.proposal?.proposalId ?? null });
    } catch (error) {
      if (checkpoint && !proposalCreated) await checkpoint.cleanup().catch(() => undefined);
      record = (await this.recordStore.get(record.runId)) ?? record;
      const details = errorDetails(error);
      const endedAt = now(this.clock);
      const cancelled = signal.aborted || details.code === "PI_CANCELLED";
      record = await this.save({ ...record, status: cancelled ? "cancelled" : "failed", currentStage: stage(record.currentStage.stage, cancelled ? "cancelled" : "failed", endedAt, details.message), endedAt, durationMs: Math.max(0, this.clock().getTime() - new Date(record.startedAt ?? record.createdAt).getTime()), cancellation: cancelled ? { ...record.cancellation, requested: true, requestedAt: record.cancellation.requestedAt ?? endedAt, reason: record.cancellation.reason ?? "cancelled by user", settledAt: endedAt } : record.cancellation, diagnostics: { code: cancelled ? "RESEARCH_CANCELLED" : details.code, message: details.message, stderr: "", protocol: null, processExit: record.processExit } });
      await this.emit(record, cancelled ? "research.cancelled" : "research.failed", { code: record.diagnostics?.code, message: record.diagnostics?.message });
    }
    return record;
  }

  private async cancelled(record: ResearchRunRecord): Promise<ResearchRunRecord> {
    const endedAt = now(this.clock);
    record = await this.save({
      ...record,
      status: "cancelled",
      currentStage: stage(record.currentStage.stage, "cancelled", endedAt),
      endedAt,
      durationMs: Math.max(0, this.clock().getTime() - new Date(record.startedAt ?? record.createdAt).getTime()),
      cancellation: {
        ...record.cancellation,
        requested: true,
        requestedAt: record.cancellation.requestedAt ?? endedAt,
        reason: record.cancellation.reason ?? "cancelled by user",
        settledAt: endedAt,
      },
    });
    await this.emit(record, "research.cancelled", { reason: record.cancellation.reason });
    return record;
  }

  private async partial(record: ResearchRunRecord, code: string, message: string): Promise<ResearchRunRecord> {
    const endedAt = now(this.clock);
    const partial = await this.save({ ...record, status: "partial", endedAt, durationMs: Math.max(0, this.clock().getTime() - new Date(record.startedAt ?? record.createdAt).getTime()), currentStage: stage(record.currentStage.stage, "completed", endedAt, message), diagnostics: { code, message, stderr: "", protocol: null, processExit: record.processExit } });
    await this.emit(partial, "research.diagnostic", { code, message });
    await this.emit(partial, "research.completed", { status: "partial", reason: code });
    return partial;
  }

  private async fail(record: ResearchRunRecord, code: string, message: string): Promise<ResearchRunRecord> {
    const endedAt = now(this.clock);
    const failed = await this.save({ ...record, status: "failed", endedAt, durationMs: 0, currentStage: stage(record.currentStage.stage, "failed", endedAt, message), diagnostics: { code, message, stderr: "", protocol: null, processExit: null } });
    await this.emit(failed, "research.failed", { code, message });
    return failed;
  }

  private async recoverActiveRuns(): Promise<void> {
    const records = await this.recordStore.list();
    for (const record of records.filter((candidate) => isActiveResearchRunStatus(candidate.status))) {
      await this.fail(record, "RESEARCH_PROCESS_LOST", "Research process was not present after service reconstruction");
    }
  }

  /** Reconciles proposal lifecycle without allowing proposal state to rewrite execution history. */
  private async recordProposalDecision(proposal: ProposalRecord): Promise<void> {
    const record = await this.recordStore.get(proposal.runId);
    if (!record?.proposal) return;
    const status = proposal.status as ResearchProposalLineage["status"];
    const reconciled = await this.save({
      ...record,
      proposal: {
        ...record.proposal,
        status,
        decision: proposal.decision,
        updatedAt: proposal.updatedAt,
        decidedAt: proposal.decidedAt,
        cleanup: {
          status: proposal.cleanup.status,
          startedAt: proposal.cleanup.startedAt,
          endedAt: proposal.cleanup.endedAt,
          diagnostics: proposal.cleanup.diagnostics,
        },
      },
    });
    await this.emit(reconciled, "research.artifact", { kind: "proposal", status: proposal.status, proposalId: proposal.proposalId, cleanup: proposal.cleanup.status });
  }

  private async save(record: ResearchRunRecord): Promise<ResearchRunRecord> {
    const parsed = researchRunRecordSchema.parse(record);
    const previous = this.recordWrites.get(parsed.runId) ?? Promise.resolve();
    let saved: ResearchRunRecord = parsed;
    const next = previous.then(async () => {
      await this.recordStore.save(parsed);
      saved = parsed;
    });
    this.recordWrites.set(parsed.runId, next);
    try {
      await next;
      return saved;
    } finally {
      if (this.recordWrites.get(parsed.runId) === next) this.recordWrites.delete(parsed.runId);
    }
  }

  private async emit(record: ResearchRunRecord, type: ResearchEventType, payload: Record<string, unknown>): Promise<ResearchEvent> {
    let created: ResearchEvent | undefined;
    const previous = this.eventWrites.get(record.runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const existing = await this.eventStore.list(record.runId);
      created = makeResearchEvent(record.runId, record.correlationId, (existing.at(-1)?.sequence ?? -1) + 1, type, payload);
      await this.eventStore.append(created);
      for (const listener of this.subscribers.get(record.runId) ?? []) listener(created);
    });
    this.eventWrites.set(record.runId, next);
    try {
      await next;
      return created!;
    } finally {
      if (this.eventWrites.get(record.runId) === next) this.eventWrites.delete(record.runId);
    }
  }

  private prompt(brief: ResearchBrief): string {
    return [
      `Research recipe: ${brief.recipe}`,
      `Question: ${brief.question}`,
      `Scope: ${brief.scope}`,
      brief.exclusions.length ? `Exclusions: ${brief.exclusions.join("; ")}` : "",
      "Produce bounded research foundation notes. Do not claim sources or web access unless a presented capability provides evidence.",
    ].filter(Boolean).join("\n");
  }

  private async runPi(input: ResearchExecutorInput): Promise<ResearchExecutorResult> {
    const started = Date.now();
    const events: import("../runs/events.js").RunEvent[] = [];
    const bridge = {
      append: async (event: import("../runs/events.js").RunEvent) => {
        events.push(event);
        const mapped: ResearchEventType = event.type === "pi.stderr" || event.type === "pi.invalid" || event.type === "diagnostic" ? "research.diagnostic" : event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.started" ? "research.progress" : event.type === "pi.event" ? "research.progress" : "research.progress";
        await input.emit(mapped, event.payload);
      },
      list: async () => events,
    };
    const result = await runPiProcess(input.manifest, { runId: input.runId, correlationId: input.correlationId, cwd: input.cwd, prompt: input.prompt, signal: input.signal, emitStarted: false, emitTerminal: false }, bridge);
    return { durationMs: result.durationMs, processExit: { exitCode: result.exitCode, signal: null, timedOut: false, aborted: false, exitedAt: new Date().toISOString() }, sessionId: null };
  }
}
