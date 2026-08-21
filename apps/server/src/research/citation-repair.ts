import { randomUUID } from "node:crypto";
import {
  type ResearchFrozenSourceBinding,
  type ResearchRunRecord,
} from "../../../../packages/shared/src/research/contracts.js";
import { SourceCaptureService, type SafeEvidenceVersion } from "../sources/service.js";
import { type CitationCheckpoint } from "./citation-resolution.js";

export interface CitationRepairInput {
  citationKey: string;
  sourceId: string;
  versionId: string;
  reason: string;
  attemptId?: string;
}

export interface CitationRepairLineage {
  repairId: string;
  parent: CitationCheckpoint;
  reason: string;
  createdAt: string;
  operation: "create-new-checkpoint";
}

export interface CitationRepairResult {
  status: "no-change" | "requires-new-checkpoint";
  citationKey: string;
  selectedVersion: SafeEvidenceVersion;
  parent: CitationCheckpoint;
  nextCheckpoint: {
    parentRunId: string;
    parentAttemptId: string;
    reportArtifactId: string | null;
    reportSha256: string | null;
    sourceBindings: ResearchFrozenSourceBinding[];
  };
  lineage: CitationRepairLineage | null;
}

export class CitationRepairError extends Error {
  constructor(
    public readonly code:
      | "RESEARCH_CITATION_ATTEMPT_NOT_FOUND"
      | "RESEARCH_CITATION_SOURCE_NOT_FOUND"
      | "RESEARCH_CITATION_VERSION_NOT_FOUND"
      | "RESEARCH_CITATION_SOURCE_UNAVAILABLE"
      | "RESEARCH_CITATION_REPAIR_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CitationRepairError";
  }
}

function selectedAttempt(run: ResearchRunRecord, attemptId?: string) {
  const attempt = attemptId
    ? run.synthesisAttempts.find((candidate) => candidate.attemptId === attemptId)
    : run.latestSynthesisAttemptId
      ? run.synthesisAttempts.find((candidate) => candidate.attemptId === run.latestSynthesisAttemptId)
      : run.synthesisAttempts.at(-1);
  if (!attempt) throw new CitationRepairError("RESEARCH_CITATION_ATTEMPT_NOT_FOUND", "The requested synthesis attempt is not present in the research run");
  return attempt;
}

function parentCheckpoint(run: ResearchRunRecord, attemptId: string): CitationCheckpoint {
  const attempt = run.synthesisAttempts.find((candidate) => candidate.attemptId === attemptId)!;
  const artifact = attempt.reportArtifactId ? run.artifacts.find((candidate) => candidate.artifactId === attempt.reportArtifactId) : undefined;
  return {
    runId: run.runId,
    attemptId,
    reportArtifactId: attempt.reportArtifactId,
    reportSha256: artifact?.sha256 ?? null,
    sourceBindings: run.frozenSourceBindings.map(({ sourceId, versionId, checksum, required, citationKey }) => ({ sourceId, versionId, checksum, required, citationKey })),
  };
}

function bindingForKey(run: ResearchRunRecord, citationKey: string): ResearchFrozenSourceBinding | undefined {
  return run.frozenSourceBindings.find((binding) => binding.citationKey === citationKey);
}

/**
 * Builds an explicit source repair without mutating a run, its accepted report,
 * or its frozen bindings. The caller must create the returned next checkpoint.
 */
export async function planCitationRepair(
  run: ResearchRunRecord,
  sources: SourceCaptureService,
  input: CitationRepairInput,
  now: () => string = () => new Date().toISOString(),
): Promise<CitationRepairResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.citationKey)) {
    throw new CitationRepairError("RESEARCH_CITATION_REPAIR_INVALID", "citationKey is invalid");
  }
  if (!input.reason.trim() || input.reason.length > 4_096) {
    throw new CitationRepairError("RESEARCH_CITATION_REPAIR_INVALID", "reason is required and must be at most 4096 characters");
  }
  if (!/^src_[a-f0-9]{16,64}$/.test(input.sourceId) || !/^ev_[a-f0-9]{16,64}$/.test(input.versionId)) {
    throw new CitationRepairError("RESEARCH_CITATION_REPAIR_INVALID", "sourceId and versionId must be exact source identifiers");
  }
  const attempt = selectedAttempt(run, input.attemptId);
  let exact;
  try {
    exact = await sources.getExactVersion(input.sourceId, input.versionId);
  } catch (error) {
    throw new CitationRepairError("RESEARCH_CITATION_SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "Source store is unavailable");
  }
  if (!exact) {
    const source = await sources.get(input.sourceId);
    throw new CitationRepairError(source ? "RESEARCH_CITATION_VERSION_NOT_FOUND" : "RESEARCH_CITATION_SOURCE_NOT_FOUND", source ? `Source version ${input.versionId} is not available` : `Source ${input.sourceId} is not available`);
  }

  const parent = parentCheckpoint(run, attempt.attemptId);
  const previous = bindingForKey(run, input.citationKey);
  const same = previous?.sourceId === input.sourceId && previous.versionId === input.versionId && previous.checksum === exact.version.checksum;
  const nextBindings = run.frozenSourceBindings.map((binding) => binding.citationKey === input.citationKey ? {
    ...binding,
    sourceId: input.sourceId,
    versionId: input.versionId,
    checksum: exact.version.checksum,
  } : binding);
  if (!previous) {
    nextBindings.push({ sourceId: input.sourceId, versionId: input.versionId, checksum: exact.version.checksum, required: true, citationKey: input.citationKey });
  }

  const lineage = same ? null : {
    repairId: `repair_${randomUUID().replaceAll("-", "")}`,
    parent,
    reason: input.reason,
    createdAt: now(),
    operation: "create-new-checkpoint" as const,
  };
  return {
    status: same ? "no-change" : "requires-new-checkpoint",
    citationKey: input.citationKey,
    selectedVersion: exact.version,
    parent,
    nextCheckpoint: {
      parentRunId: run.runId,
      parentAttemptId: attempt.attemptId,
      reportArtifactId: null,
      reportSha256: null,
      sourceBindings: nextBindings,
    },
    lineage,
  };
}

export const repairCitation = planCitationRepair;
