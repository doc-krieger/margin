import { describe, expect, it } from "vitest";
import {
  researchRunRecordSchema,
  researchSynthesisAttemptSchema,
} from "../../../packages/shared/src/research/contracts.js";
import { makeSourceRecord, type EvidenceVersion } from "../../../packages/shared/src/sources/contracts.js";
import { planCitationRepair } from "../../../apps/server/src/research/citation-repair.js";
import { SourceCaptureService } from "../../../apps/server/src/sources/service.js";
import { MemorySourceStore } from "../../../apps/server/src/sources/store.js";

const timestamp = "2026-08-13T12:00:00.000Z";
const sourceId = "src_1234567890abcdef";
const firstVersionId = "ev_1234567890abcdef";
const secondVersionId = "ev_abcdefabcdefabcd";
const firstChecksum = "a".repeat(64);
const secondChecksum = "b".repeat(64);

function evidence(versionId: string, checksum: string): EvidenceVersion {
  return {
    versionId,
    checksum,
    byteLength: 10,
    mediaType: "text/plain",
    capturedAt: timestamp,
    attemptId: "cap_1234567890abcdef",
    originalRef: `capture/${versionId}.txt`,
    readableRef: `readable/${versionId}.txt`,
    readableMediaType: "text/plain",
  };
}

function run() {
  const attempt = researchSynthesisAttemptSchema.parse({
    attemptId: "synthesis-1",
    parentAttemptId: null,
    status: "completed",
    input: {
      confirmedBriefRevision: 1,
      confirmedBriefHash: firstChecksum,
      sourceBindings: [{ sourceId, versionId: firstVersionId, checksum: firstChecksum, citationKey: "primary-source" }],
      notesArtifactId: "notes-1",
      notesSha256: firstChecksum,
      profileId: "default",
    },
    notesArtifactId: "notes-1",
    reportArtifactId: "report-1",
    citationValidation: {
      status: "valid",
      unresolvedKeys: [],
      ambiguousKeys: [],
      usages: [{ usageId: "usage-1", citationKey: "primary-source", sourceId, versionId: firstVersionId, location: { relativePath: "research/report.md", line: 8 } }],
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
    artifacts: [{ artifactId: "report-1", kind: "report", status: "complete", relativePath: "research/report.md", sha256: "c".repeat(64), createdAt: timestamp, updatedAt: timestamp }],
    frozenSourceBindings: [{ sourceId, versionId: firstVersionId, checksum: firstChecksum, required: true, citationKey: "primary-source" }],
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
  });
}

async function sourceService() {
  const store = new MemorySourceStore();
  const first = evidence(firstVersionId, firstChecksum);
  const second = evidence(secondVersionId, secondChecksum);
  await store.save(makeSourceRecord({
    sourceId,
    kind: "url",
    identity: "https://example.com/source",
    evidenceState: "archived",
    latestVersionId: secondVersionId,
    versions: [first, second],
  }, timestamp));
  return new SourceCaptureService(store, { now: () => timestamp });
}

describe("citation repair", () => {
  it("returns a new-checkpoint lineage plan and leaves the accepted run unchanged", async () => {
    const accepted = run();
    const result = await planCitationRepair(accepted, await sourceService(), {
      citationKey: "primary-source",
      sourceId,
      versionId: secondVersionId,
      reason: "Replace the stale capture with the explicitly selected archived version",
    }, () => timestamp);

    expect(result.status).toBe("requires-new-checkpoint");
    expect(result.lineage).toMatchObject({ operation: "create-new-checkpoint", reason: "Replace the stale capture with the explicitly selected archived version", createdAt: timestamp, parent: { runId: "run-1", attemptId: "synthesis-1", reportSha256: "c".repeat(64) } });
    expect(result.nextCheckpoint).toMatchObject({ parentRunId: "run-1", parentAttemptId: "synthesis-1", reportArtifactId: null, reportSha256: null });
    expect(result.nextCheckpoint.sourceBindings[0]).toMatchObject({ sourceId, versionId: secondVersionId, checksum: secondChecksum, citationKey: "primary-source" });
    expect(accepted.frozenSourceBindings[0]).toMatchObject({ versionId: firstVersionId, checksum: firstChecksum });
  });

  it("reports no-change for the already accepted exact version", async () => {
    const result = await planCitationRepair(run(), await sourceService(), {
      citationKey: "primary-source",
      sourceId,
      versionId: firstVersionId,
      reason: "Confirm the existing exact version",
    });
    expect(result.status).toBe("no-change");
    expect(result.lineage).toBeNull();
  });

  it("rejects a repair target that is not present in the source manifest", async () => {
    await expect(planCitationRepair(run(), await sourceService(), {
      citationKey: "primary-source",
      sourceId,
      versionId: "ev_deadbeefdeadbeef",
      reason: "Do not silently invent a source version",
    })).rejects.toMatchObject({ code: "RESEARCH_CITATION_VERSION_NOT_FOUND" });
  });
});
