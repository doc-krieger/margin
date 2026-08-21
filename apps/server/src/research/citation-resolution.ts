import { createHash } from "node:crypto";
import {
  type ResearchCitationLocation,
  type ResearchCitationUsage,
  type ResearchFrozenSourceBinding,
  type ResearchRunRecord,
} from "../../../../packages/shared/src/research/contracts.js";
import {
  type ExactSourceEvidence,
  type SafeEvidenceVersion,
  type SafeSourceRecord,
  SourceCaptureService,
} from "../sources/service.js";

export type CitationResolutionStatus =
  | "resolved"
  | "metadata-only"
  | "unavailable"
  | "missing-source"
  | "missing-version"
  | "checksum-mismatch"
  | "ambiguous"
  | "unresolved";

export interface CitationEvidencePreview {
  available: boolean;
  mediaType: string;
  checksum: string;
  byteLength: number;
  preview: string | null;
  truncated: boolean;
}

export interface CitationResolution {
  usageId: string | null;
  citationKey: string;
  location: ResearchCitationLocation | null;
  excerpt: string | null;
  status: CitationResolutionStatus;
  source: SafeSourceRecord | null;
  version: SafeEvidenceVersion | null;
  evidence: CitationEvidencePreview | null;
  diagnostic: { code: string; message: string } | null;
}

export interface CitationCheckpoint {
  runId: string;
  attemptId: string | null;
  reportArtifactId: string | null;
  reportSha256: string | null;
  sourceBindings: Array<Pick<ResearchFrozenSourceBinding, "sourceId" | "versionId" | "checksum" | "required" | "citationKey">>;
}

export interface CitationResolutionResult {
  runId: string;
  checkpoint: CitationCheckpoint;
  status: "resolved" | "partial" | "failed";
  citations: CitationResolution[];
  diagnostics: Array<{ code: string; message: string }>;
}

export class CitationResolutionError extends Error {
  constructor(
    public readonly code:
      | "RESEARCH_CITATION_ATTEMPT_NOT_FOUND"
      | "RESEARCH_CITATION_VALIDATION_NOT_FOUND"
      | "RESEARCH_CITATION_NOT_FOUND"
      | "RESEARCH_CITATION_SOURCE_SERVICE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "CitationResolutionError";
  }
}

export interface CitationResolutionOptions {
  attemptId?: string;
  usageId?: string;
  citationKey?: string;
}

const MAX_PREVIEW_BYTES = 8_192;

function previewFor(bytes: Uint8Array, mediaType: string): { preview: string | null; truncated: boolean } {
  const readable = /^(text\/|application\/(json|xml|javascript)|application\/xhtml\+xml)/i.test(mediaType);
  if (!readable) return { preview: null, truncated: false };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const normalized = mediaType.toLowerCase().includes("html")
    ? text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : text;
  const clipped = normalized.length > MAX_PREVIEW_BYTES ? normalized.slice(0, MAX_PREVIEW_BYTES) : normalized;
  return { preview: clipped, truncated: clipped.length < normalized.length };
}

function checkpointFor(run: ResearchRunRecord, attemptId: string | null): CitationCheckpoint {
  const reportArtifactId = attemptId ? run.synthesisAttempts.find((attempt) => attempt.attemptId === attemptId)?.reportArtifactId ?? null : null;
  const reportSha256 = reportArtifactId ? run.artifacts.find((artifact) => artifact.artifactId === reportArtifactId)?.sha256 ?? null : null;
  return {
    runId: run.runId,
    attemptId,
    reportArtifactId,
    reportSha256,
    sourceBindings: run.frozenSourceBindings.map(({ sourceId, versionId, checksum, required, citationKey }) => ({ sourceId, versionId, checksum, required, citationKey })),
  };
}

function sourceKey(binding: Pick<ResearchFrozenSourceBinding, "sourceId" | "versionId">): string {
  return `${binding.sourceId}:${binding.versionId}`;
}

function evidenceResolution(usage: ResearchCitationUsage, binding: ResearchFrozenSourceBinding, exact: ExactSourceEvidence): CitationResolution {
  const checksumMatches = exact.version.checksum === binding.checksum;
  if (!checksumMatches) {
    return {
      usageId: usage.usageId,
      citationKey: usage.citationKey,
      location: usage.location,
      excerpt: usage.excerpt,
      status: "checksum-mismatch",
      source: exact.source,
      version: exact.version,
      evidence: null,
      diagnostic: { code: "FROZEN_CHECKSUM_MISMATCH", message: `Frozen citation ${usage.citationKey} does not match the selected source version checksum` },
    };
  }

  if (exact.bytes === null) {
    const metadataOnly = exact.source.evidenceState === "metadata-only";
    return {
      usageId: usage.usageId,
      citationKey: usage.citationKey,
      location: usage.location,
      excerpt: usage.excerpt,
      status: metadataOnly ? "metadata-only" : "unavailable",
      source: exact.source,
      version: exact.version,
      evidence: {
        available: false,
        mediaType: exact.version.mediaType,
        checksum: exact.version.checksum,
        byteLength: exact.version.byteLength,
        preview: null,
        truncated: false,
      },
      diagnostic: exact.diagnostic ?? { code: "EVIDENCE_UNAVAILABLE", message: "Exact evidence is unavailable" },
    };
  }

  if (exact.source.evidenceState !== "archived") {
    return {
      usageId: usage.usageId,
      citationKey: usage.citationKey,
      location: usage.location,
      excerpt: usage.excerpt,
      status: exact.source.evidenceState === "metadata-only" ? "metadata-only" : "unavailable",
      source: exact.source,
      version: exact.version,
      evidence: { available: false, mediaType: exact.version.mediaType, checksum: exact.version.checksum, byteLength: exact.version.byteLength, preview: null, truncated: false },
      diagnostic: { code: "SOURCE_EVIDENCE_STATE", message: `Exact source is ${exact.source.evidenceState}; evidence is not treated as a passing resolution` },
    };
  }

  const { preview, truncated } = previewFor(exact.bytes, exact.version.readableMediaType ?? exact.version.mediaType);
  return {
    usageId: usage.usageId,
    citationKey: usage.citationKey,
    location: usage.location,
    excerpt: usage.excerpt,
    status: "resolved",
    source: exact.source,
    version: exact.version,
    evidence: {
      available: true,
      mediaType: exact.version.mediaType,
      checksum: exact.version.checksum,
      byteLength: exact.version.byteLength,
      preview,
      truncated,
    },
    diagnostic: preview === null ? { code: "EVIDENCE_NOT_TEXT", message: "Exact evidence is available but no safe text preview is provided for this media type" } : null,
  };
}

function unresolvedResolution(usage: Partial<ResearchCitationUsage> & { citationKey: string }, status: "ambiguous" | "unresolved", message: string, code: string): CitationResolution {
  return {
    usageId: usage.usageId ?? null,
    citationKey: usage.citationKey,
    location: usage.location ?? null,
    excerpt: usage.excerpt ?? null,
    status,
    source: null,
    version: null,
    evidence: null,
    diagnostic: { code, message },
  };
}

/** Resolves only persisted citation usages; it never guesses a source from report text. */
export async function resolveCitationUsages(
  run: ResearchRunRecord,
  sources: SourceCaptureService,
  options: CitationResolutionOptions = {},
): Promise<CitationResolutionResult> {
  const attempt = options.attemptId
    ? run.synthesisAttempts.find((candidate) => candidate.attemptId === options.attemptId)
    : run.latestSynthesisAttemptId
      ? run.synthesisAttempts.find((candidate) => candidate.attemptId === run.latestSynthesisAttemptId)
      : run.synthesisAttempts.at(-1);
  if (!attempt) throw new CitationResolutionError("RESEARCH_CITATION_ATTEMPT_NOT_FOUND", "The requested synthesis attempt is not present in the research run");
  if (!attempt.citationValidation) throw new CitationResolutionError("RESEARCH_CITATION_VALIDATION_NOT_FOUND", "The synthesis attempt has no persisted citation validation");

  const usages = attempt.citationValidation.usages.filter((usage) =>
    (!options.usageId || usage.usageId === options.usageId) && (!options.citationKey || usage.citationKey === options.citationKey),
  );
  const requestedKeys = options.citationKey ? [options.citationKey] : [];
  if (options.usageId && usages.length === 0) throw new CitationResolutionError("RESEARCH_CITATION_NOT_FOUND", `Citation usage ${options.usageId} is not present in the selected attempt`);
  if (options.citationKey && usages.length === 0 && !attempt.citationValidation.unresolvedKeys.includes(options.citationKey) && !attempt.citationValidation.ambiguousKeys.includes(options.citationKey)) {
    throw new CitationResolutionError("RESEARCH_CITATION_NOT_FOUND", `Citation key ${options.citationKey} is not present in the selected attempt`);
  }

  const byKey = new Map(run.frozenSourceBindings.map((binding) => [binding.citationKey ?? `${binding.sourceId}:${binding.versionId}`, binding]));
  const citations: CitationResolution[] = [];
  for (const usage of usages) {
    if (attempt.citationValidation.ambiguousKeys.includes(usage.citationKey)) {
      citations.push(unresolvedResolution(usage, "ambiguous", "This citation has multiple possible source bindings and was not auto-resolved", "AMBIGUOUS_CITATION"));
      continue;
    }
    const binding = byKey.get(usage.citationKey) ?? run.frozenSourceBindings.find((candidate) => sourceKey(candidate) === sourceKey(usage));
    if (!binding) {
      citations.push(unresolvedResolution(usage, "unresolved", "No frozen source binding is recorded for this citation", "UNRESOLVED_CITATION"));
      continue;
    }
    if (usage.sourceId !== binding.sourceId || usage.versionId !== binding.versionId) {
      citations.push({
        usageId: usage.usageId,
        citationKey: usage.citationKey,
        location: usage.location,
        excerpt: usage.excerpt,
        status: "unresolved",
        source: null,
        version: null,
        evidence: null,
        diagnostic: { code: "CITATION_USAGE_BINDING_MISMATCH", message: "Persisted citation usage does not match its frozen source binding" },
      });
      continue;
    }
    let exact: ExactSourceEvidence | null;
    try {
      exact = await sources.readExactVersion(binding.sourceId, binding.versionId);
    } catch (error) {
      citations.push({
        usageId: usage.usageId,
        citationKey: usage.citationKey,
        location: usage.location,
        excerpt: usage.excerpt,
        status: "unavailable",
        source: null,
        version: null,
        evidence: null,
        diagnostic: { code: "SOURCE_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : "Source store is unavailable" },
      });
      continue;
    }
    if (!exact) {
      const source = await sources.get(binding.sourceId);
      citations.push({
        usageId: usage.usageId,
        citationKey: usage.citationKey,
        location: usage.location,
        excerpt: usage.excerpt,
        status: source ? "missing-version" : "missing-source",
        source: source ? (await sources.getExactVersion(binding.sourceId, binding.versionId))?.source ?? null : null,
        version: null,
        evidence: null,
        diagnostic: { code: source ? "FROZEN_VERSION_NOT_FOUND" : "FROZEN_SOURCE_NOT_FOUND", message: source ? `Frozen source version ${binding.versionId} is unavailable` : `Frozen source ${binding.sourceId} is unavailable` },
      });
      continue;
    }
    citations.push(evidenceResolution(usage, binding, exact));
  }

  for (const key of [...attempt.citationValidation.unresolvedKeys, ...attempt.citationValidation.ambiguousKeys, ...requestedKeys]) {
    if (citations.some((citation) => citation.citationKey === key)) continue;
    citations.push(unresolvedResolution({ citationKey: key }, attempt.citationValidation.ambiguousKeys.includes(key) ? "ambiguous" : "unresolved", attempt.citationValidation.ambiguousKeys.includes(key) ? "This citation has multiple possible source bindings and was not auto-resolved" : "This citation has no persisted source usage", attempt.citationValidation.ambiguousKeys.includes(key) ? "AMBIGUOUS_CITATION" : "UNRESOLVED_CITATION"));
  }

  const diagnostics = citations.filter((citation) => citation.diagnostic && citation.status !== "resolved").map((citation) => citation.diagnostic!);
  if (attempt.citationValidation.status !== "valid" && attempt.citationValidation.diagnostics) {
    diagnostics.push({ code: "CITATION_VALIDATION", message: attempt.citationValidation.diagnostics });
  }
  const everyResolved = citations.length === 0 || citations.every((citation) => citation.status === "resolved");
  const status = attempt.citationValidation.status === "valid" && everyResolved
    ? "resolved"
    : citations.some((citation) => citation.status === "resolved")
      ? "partial"
      : "failed";
  return { runId: run.runId, checkpoint: checkpointFor(run, attempt.attemptId), status, citations, diagnostics };
}

export const resolveCitations = resolveCitationUsages;
export const citationChecksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
