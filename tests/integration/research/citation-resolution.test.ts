import { createHash } from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  researchRunRecordSchema,
  researchSynthesisAttemptSchema,
} from "../../../packages/shared/src/research/contracts.js";
import { makeSourceRecord, type EvidenceVersion } from "../../../packages/shared/src/sources/contracts.js";
import { ProjectLifecycleService } from "../../../apps/server/src/projects/service.js";
import { registerResearchRoutes } from "../../../apps/server/src/research/routes.js";
import { SourceCaptureService } from "../../../apps/server/src/sources/service.js";
import { MemorySourceStore } from "../../../apps/server/src/sources/store.js";
import { resolveCitationUsages } from "../../../apps/server/src/research/citation-resolution.js";
import type { ResearchRunService } from "../../../apps/server/src/research/service.js";

const timestamp = "2026-08-13T12:00:00.000Z";
const sourceId = "src_1234567890abcdef";
const versionId = "ev_1234567890abcdef";
const latestVersionId = "ev_abcdefabcdefabcd";
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function version(bytes: Uint8Array, id = versionId): EvidenceVersion {
  return {
    versionId: id,
    checksum: checksum(bytes),
    byteLength: bytes.byteLength,
    mediaType: "text/plain",
    capturedAt: timestamp,
    attemptId: "cap_1234567890abcdef",
    originalRef: "capture/source.txt",
    readableRef: "readable/source.txt",
    readableMediaType: "text/plain",
  };
}

function run(overrides: Record<string, unknown> = {}, frozenChecksum = "a".repeat(64)) {
  const attempt = researchSynthesisAttemptSchema.parse({
    attemptId: "synthesis-1",
    parentAttemptId: null,
    status: "completed",
    input: {
      confirmedBriefRevision: 1,
      confirmedBriefHash: "a".repeat(64),
      sourceBindings: [{ sourceId, versionId, checksum: frozenChecksum, citationKey: "primary-source" }],
      notesArtifactId: "notes-1",
      notesSha256: "a".repeat(64),
      profileId: "default",
    },
    notesArtifactId: "notes-1",
    reportArtifactId: "report-1",
    citationValidation: {
      status: "valid",
      unresolvedKeys: [],
      ambiguousKeys: [],
      usages: [{ usageId: "usage-1", citationKey: "primary-source", sourceId, versionId, location: { relativePath: "research/report.md", line: 8 }, excerpt: "A supported claim" }],
      diagnostics: "",
    },
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: timestamp,
  });
  return researchRunRecordSchema.parse({
    schemaVersion: 1,
    runId: "run-1",
    correlationId: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    profileId: "default",
    brief: { schemaVersion: 1, briefId: "brief-1", projectId: "project-1", question: "Question", scope: "Scope", createdAt: timestamp, updatedAt: timestamp },
    recipe: "standard",
    status: "completed",
    currentStage: { stage: "synthesizing", status: "completed", startedAt: timestamp, endedAt: timestamp, artifactIds: ["report-1"], diagnostics: "" },
    requiredCapabilities: [],
    capabilities: null,
    session: {},
    artifacts: [{ artifactId: "report-1", kind: "report", status: "complete", relativePath: "research/report.md", sha256: "b".repeat(64), createdAt: timestamp, updatedAt: timestamp }],
    frozenSourceBindings: [{ sourceId, versionId, checksum: frozenChecksum, required: true, citationKey: "primary-source" }],
    synthesisAttempts: [attempt],
    latestSynthesisAttemptId: "synthesis-1",
    cancellation: {},
    diagnostics: null,
    processExit: null,
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 1,
    lastEventAt: timestamp,
    ...overrides,
  });
}

async function sourceService(bytes: Uint8Array, state: "archived" | "metadata-only" = "archived", storedVersionId = versionId) {
  const store = new MemorySourceStore();
  const storedVersion = version(bytes, storedVersionId);
  await store.save(makeSourceRecord({
    sourceId,
    kind: "url",
    identity: "https://example.com/source",
    capturedMetadata: { title: "Example source", url: "https://example.com/source" },
    effectiveMetadata: { title: "Example source", url: "https://example.com/source" },
    evidenceState: state,
    latestVersionId: storedVersion.versionId,
    versions: [storedVersion],
  }, timestamp));
  if (state === "archived") await store.putEvidence(sourceId, storedVersion, bytes);
  return new SourceCaptureService(store, { now: () => timestamp });
}

describe("citation resolution", () => {
  it("resolves the frozen version and returns safe evidence without filesystem references", async () => {
    const bytes = new TextEncoder().encode("The exact archived passage supports the claim.");
    const result = await resolveCitationUsages(run({}, checksum(bytes)), await sourceService(bytes));

    expect(result.status).toBe("resolved");
    expect(result.checkpoint).toMatchObject({ runId: "run-1", attemptId: "synthesis-1", reportArtifactId: "report-1", reportSha256: "b".repeat(64) });
    expect(result.citations[0]).toMatchObject({ status: "resolved", source: { sourceId, identity: "https://example.com/source" }, version: { versionId }, evidence: { available: true, preview: "The exact archived passage supports the claim." } });
    expect(JSON.stringify(result)).not.toContain("originalRef");
    expect(JSON.stringify(result)).not.toContain("readableRef");
  });

  it("does not fall back to latest evidence when the frozen version is missing", async () => {
    const bytes = new TextEncoder().encode("latest");
    const service = await sourceService(bytes, "archived", latestVersionId);
    const result = await resolveCitationUsages(run(), service);

    expect(result.status).toBe("failed");
    expect(result.citations[0]).toMatchObject({ status: "missing-version", version: null, evidence: null, diagnostic: { code: "FROZEN_VERSION_NOT_FOUND" } });
  });

  it("keeps metadata-only and ambiguous citations visibly non-passing", async () => {
    const metadataRun = run({}, checksum(new TextEncoder().encode("not stored")));
    const metadataAttempt = metadataRun.synthesisAttempts[0]!;
    metadataAttempt.citationValidation = { ...metadataAttempt.citationValidation!, status: "partial" };
    const metadataResult = await resolveCitationUsages(metadataRun, await sourceService(new TextEncoder().encode("not stored"), "metadata-only"));
    expect(metadataResult.status).toBe("failed");
    expect(metadataResult.citations[0]?.status).toBe("metadata-only");

    const ambiguousBytes = new TextEncoder().encode("stored");
    const ambiguousRun = run({}, checksum(ambiguousBytes));
    ambiguousRun.synthesisAttempts[0]!.citationValidation = { ...ambiguousRun.synthesisAttempts[0]!.citationValidation!, status: "partial", ambiguousKeys: ["primary-source"] };
    const ambiguousResult = await resolveCitationUsages(ambiguousRun, await sourceService(ambiguousBytes));
    expect(ambiguousResult.citations[0]).toMatchObject({ status: "ambiguous", source: null, version: null });
  });

  it("rejects a persisted usage whose key and bound version disagree", async () => {
    const malformed = run();
    malformed.synthesisAttempts[0]!.citationValidation!.usages[0]!.versionId = "ev_abcdefabcdefabcd";
    const malformedBytes = new TextEncoder().encode("stored");
    const result = await resolveCitationUsages(malformed, await sourceService(malformedBytes));
    expect(result.citations[0]).toMatchObject({ status: "unresolved", source: null, diagnostic: { code: "CITATION_USAGE_BINDING_MISMATCH" } });
  });

  it("serves a project-scoped safe resolution route", async () => {
    const bytes = new TextEncoder().encode("route evidence");
    const accepted = run({}, checksum(bytes));
    const source = await sourceService(bytes);
    const projects = new ProjectLifecycleService();
    projects.registry.registerProject({ id: "project-1", name: "Citation project", path: process.cwd(), manifestPath: path.join(process.cwd(), ".margin", "project.yaml"), rootPath: process.cwd(), gitInitialized: true, markdownFiles: [], files: [], openedAt: timestamp });
    const researchService = { get: async () => accepted } as unknown as ResearchRunService;
    const app = Fastify();
    registerResearchRoutes(app, researchService, projects, () => source);

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/research/runs/run-1/citations?usageId=usage-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json().resolution.citations[0]).toMatchObject({ status: "resolved", evidence: { preview: "route evidence" } });
    await app.close();
  });
});
