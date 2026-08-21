import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  activeResearchRunStatuses,
  isActiveResearchRunStatus,
  isTerminalResearchRunStatus,
  partialArtifactReferenceSchema,
  researchBriefSchema,
  researchCapabilitySnapshotSchema,
  researchCitationValidationSchema,
  researchProposalLineageSchema,
  researchSynthesisAttemptSchema,
  researchEventSchema,
  researchRecipeDefinitions,
  researchRecipeDefinitionSchema,
  researchRunRecordSchema,
  terminalResearchRunStatuses,
} from "../../packages/shared/src/research/contracts.js";

const timestamp = "2026-08-13T12:00:00.000Z";

function brief(overrides: Record<string, unknown> = {}) {
  return researchBriefSchema.parse({
    schemaVersion: 1,
    briefId: "brief-1",
    projectId: "project-1",
    question: "Which approach best fits this project?",
    scope: "Compare the relevant primary evidence.",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function runRecord(overrides: Record<string, unknown> = {}) {
  return researchRunRecordSchema.parse({
    schemaVersion: 1,
    runId: "run-1",
    correlationId: randomUUID(),
    projectId: "project-1",
    profileId: "default",
    brief: brief(),
    recipe: "standard",
    status: "queued",
    currentStage: { stage: "planning", status: "pending" },
    requiredCapabilities: [{ id: "web-search", label: "Web search", description: "Search configured sources", required: true }],
    capabilities: null,
    session: {},
    artifacts: [],
    cancellation: {},
    diagnostics: null,
    processExit: null,
    createdAt: timestamp,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    lastEventAt: null,
    ...overrides,
  });
}

describe("research shared contracts", () => {
  it("defines validated Quick, Standard, and Deep recipes", () => {
    expect(Object.keys(researchRecipeDefinitions)).toEqual(["quick", "standard", "deep"]);
    for (const definition of Object.values(researchRecipeDefinitions)) {
      expect(researchRecipeDefinitionSchema.parse(definition)).toEqual(definition);
      expect(definition.suggestedStages.length).toBeGreaterThan(0);
    }
  });

  it("normalizes brief defaults while preserving explicit research choices", () => {
    const parsed = brief({
      exclusions: ["Do not use anonymous summaries"],
      outputMode: "research-only",
      recipe: "deep",
      sourcePreferences: { preferredKinds: ["government-report"], preferPrimarySources: true },
      dateLimits: { from: timestamp, to: null },
    });

    expect(parsed.recipe).toBe("deep");
    expect(parsed.outputMode).toBe("research-only");
    expect(parsed.exclusions).toEqual(["Do not use anonymous summaries"]);
    expect(parsed.sourcePreferences).toMatchObject({ preferredKinds: ["government-report"], permittedKinds: [], preferPrimarySources: true, languages: [] });
    expect(parsed.dateLimits).toEqual({ from: timestamp, to: null });
  });

  it.each([
    [{ question: "   " }, "question"],
    [{ schemaVersion: 2 }, "schema version"],
    [{ dateLimits: { from: "2026-08-14T00:00:00.000Z", to: timestamp } }, "date order"],
    [{ recipe: "experimental" }, "recipe"],
  ])("rejects malformed brief input (%s)", (overrides) => {
    expect(() => brief(overrides)).toThrow();
  });

  it("persists a confirmed brief and exact synthesis provenance as bounded lineage", () => {
    const checksum = "a".repeat(64);
    const confirmed = brief({
      status: "confirmed",
      audience: "Project maintainers",
      depth: "standard",
      outline: ["Decision criteria", "Evidence gaps"],
      outputPaths: { reportPath: "research/report.md", notesPath: "research/notes.md", manifestPath: "research/sources.md" },
      clarificationDecisions: [{ decisionId: "clarification-1", question: "Who is the audience?", answer: "Project maintainers", createdAt: timestamp }],
      revision: 2,
      confirmedRevision: 2,
      confirmedAt: timestamp,
    });
    const attempt = researchSynthesisAttemptSchema.parse({
      attemptId: "synthesis-1",
      parentAttemptId: null,
      status: "completed",
      input: {
        confirmedBriefRevision: confirmed.confirmedRevision,
        confirmedBriefHash: checksum,
        sourceBindings: [{ sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", checksum, citationKey: "primary-source" }],
        notesArtifactId: "notes-1",
        notesSha256: checksum,
        profileId: "default",
      },
      notesArtifactId: "notes-1",
      reportArtifactId: "report-1",
      citationValidation: {
        status: "valid",
        unresolvedKeys: [],
        ambiguousKeys: [],
        usages: [{ usageId: "usage-1", citationKey: "primary-source", sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", location: { relativePath: "research/report.md", line: 12 } }],
        diagnostics: "",
      },
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
    });
    const proposal = researchProposalLineageSchema.parse({
      proposalId: "proposal-1",
      status: "pending",
      artifactIds: ["report-1", "notes-1", "manifest-1"],
      reportArtifactId: "report-1",
      notesArtifactId: "notes-1",
      manifestArtifactId: "manifest-1",
      cleanup: { status: "pending" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const run = runRecord({
      brief: confirmed,
      frozenSourceBindings: attempt.input.sourceBindings,
      synthesisAttempts: [attempt],
      latestSynthesisAttemptId: attempt.attemptId,
      proposal,
    });

    expect(run.brief.confirmedRevision).toBe(2);
    expect(run.frozenSourceBindings[0]).toMatchObject({ versionId: "ev_1234567890abcdef", checksum, citationKey: "primary-source" });
    expect(run.synthesisAttempts[0]?.citationValidation?.usages[0]?.location).toMatchObject({ relativePath: "research/report.md", line: 12 });
    expect(run.proposal?.status).toBe("pending");
  });

  it.each([
    [{ status: "confirmed", confirmedRevision: null, confirmedAt: null }, "confirmed brief metadata"],
    [{ status: "confirmed", confirmedRevision: 2, confirmedAt: timestamp, revision: 1 }, "confirmed revision order"],
    [{ outputPaths: { reportPath: "../report.md" } }, "unsafe output path"],
  ])("rejects invalid confirmed brief lineage (%s)", (overrides) => {
    expect(() => brief(overrides)).toThrow();
  });

  it("rejects synthesis and proposal lineage that cannot be safely reviewed", () => {
    const checksum = "b".repeat(64);
    expect(() => researchSynthesisAttemptSchema.parse({
      attemptId: "synthesis-1",
      status: "completed",
      input: { confirmedBriefRevision: 1, confirmedBriefHash: checksum, sourceBindings: [], profileId: "default" },
      notesArtifactId: null,
      reportArtifactId: null,
      createdAt: timestamp,
    })).toThrow();
    expect(() => researchCitationValidationSchema.parse({
      status: "valid",
      usages: [{ usageId: "usage-1", citationKey: "missing", sourceId: "src_1234567890abcdef", versionId: "ev_1234567890abcdef", location: "../report.md" }],
    })).toThrow();
    expect(() => researchProposalLineageSchema.parse({
      proposalId: "proposal-1",
      status: "kept",
      decision: null,
      cleanup: { status: "completed" },
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();
  });

  it("rejects unsafe artifact references and oversized diagnostics", () => {
    expect(() => partialArtifactReferenceSchema.parse({
      artifactId: "artifact-1",
      kind: "report",
      status: "partial",
      relativePath: "../outside.md",
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();

    expect(() => runRecord({ diagnostics: {
      code: "FAILED",
      message: "failure",
      stderr: "x".repeat(32_001),
    } })).toThrow();
  });

  it("validates capability, run state, stage, artifact, cancellation, and process metadata together", () => {
    const sessionId = "pi-session-1";
    const record = runRecord({
      status: "partial",
      currentStage: {
        stage: "researching",
        status: "failed",
        startedAt: timestamp,
        endedAt: timestamp,
        artifactIds: ["notes-1"],
        diagnostics: "source timeout",
      },
      capabilities: {
        checkedAt: timestamp,
        executable: { id: "pi", status: "available", checkedAt: timestamp, evidence: ["pi --version"], diagnostics: null },
        rpc: { id: "pi-rpc", status: "available", checkedAt: timestamp, evidence: ["rpc smoke"], diagnostics: null },
        required: [{ id: "web-search", label: "Web search", required: true }],
        results: [{ id: "web-search", status: "unavailable", checkedAt: timestamp, evidence: ["tool not configured"], diagnostics: "missing tool" }],
        profilePolicy: "research profile",
      },
      session: { sessionId, eventCount: 2, commandCount: 1, promptCount: 1, lastEventAt: timestamp },
      artifacts: [{ artifactId: "notes-1", kind: "notes", status: "partial", relativePath: "research/notes.md", label: "Notes", bytes: 12, sha256: null, createdAt: timestamp, updatedAt: timestamp }],
      cancellation: { requested: false, requestedAt: null, reason: null, settledAt: null },
      diagnostics: { code: "PARTIAL", message: "Research stopped after partial notes", stderr: "", protocol: null, processExit: { exitCode: 0, signal: null, timedOut: false, aborted: false, exitedAt: timestamp } },
      processExit: { exitCode: 0, signal: null, timedOut: false, aborted: false, exitedAt: timestamp },
      endedAt: timestamp,
      durationMs: 42,
      lastEventAt: timestamp,
    });

    expect(record.status).toBe("partial");
    expect(record.capabilities?.results[0]?.status).toBe("unavailable");
    expect(record.session.sessionId).toBe(sessionId);
    expect(isTerminalResearchRunStatus(record.status)).toBe(true);
    expect(isActiveResearchRunStatus("cancelling")).toBe(true);
    expect(activeResearchRunStatuses).toContain("running");
    expect(terminalResearchRunStatuses).toContain("partial");
  });

  it("requires ordered, correlated, versioned event envelopes", () => {
    const correlationId = randomUUID();
    const event = researchEventSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      correlationId,
      sequence: 0,
      timestamp,
      type: "research.started",
      payload: { recipe: "standard" },
    });
    expect(event.payload).toEqual({ recipe: "standard" });
    expect(() => researchEventSchema.parse({ ...event, schemaVersion: 2 })).toThrow();
    expect(() => researchEventSchema.parse({ ...event, sequence: -1 })).toThrow();
    expect(() => researchEventSchema.parse({ ...event, type: "run.started" })).toThrow();
  });
});
