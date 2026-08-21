import { createHash } from "node:crypto";
import {
  checkpointReviewAcknowledgmentInputSchema,
  finalCheckpointSummarySchema,
  findingRelationshipInputSchema,
  lineageCursorSchema,
  lineageEntrySchema,
  lineagePageSchema,
  lineageSchemaVersion,
  workspaceRestoreSelectionSchema,
  type CheckpointReviewAcknowledgment,
  type CheckpointReviewAcknowledgmentInput,
  type FinalCheckpointSummary,
  type FindingRelationship,
  type FindingRelationshipInput,
  type LineageDetailTarget,
  type LineageEntry,
  type LineageEntryKind,
  type LineageListQuery,
  type LineagePage,
  type WorkspaceRestoreSelection,
} from "../../../../packages/shared/src/lineage/contracts.js";
import type { CommentRecord } from "../../../../packages/shared/src/comments/contracts.js";
import { isTerminalQualityAttemptStatus, type QualityFinding, type QualityReviewAttempt, type QualityReviewRecord } from "../../../../packages/shared/src/quality/contracts.js";
import type { ResearchBrief, ResearchRunRecord, ResearchSynthesisAttempt } from "../../../../packages/shared/src/research/contracts.js";
import type { CaptureAttempt, EvidenceVersion, SourceRecord } from "../../../../packages/shared/src/sources/contracts.js";
import type { RevisionRunRecord } from "../../../../packages/shared/src/runs/contracts.js";
import type { ProposalRecord } from "../proposals/store.js";
import { LineageStore, type LineageSnapshot } from "./store.js";

export type LineageErrorCode =
  | "LINEAGE_PROJECT_NOT_FOUND"
  | "LINEAGE_INVALID_CURSOR"
  | "LINEAGE_ENTRY_NOT_FOUND"
  | "LINEAGE_INVALID_RELATIONSHIP"
  | "LINEAGE_INVALID_REVIEW_ACKNOWLEDGMENT";

export class LineageError extends Error {
  constructor(public readonly code: LineageErrorCode, message: string) {
    super(message);
    this.name = "LineageError";
  }
}

export interface LineageListOptions extends Partial<LineageListQuery> {
  cursor?: string;
  limit?: number;
}

export interface LineageServiceOptions {
  projectPath?: (projectId: string) => string | undefined | Promise<string | undefined>;
  clock?: () => Date;
}

export interface WorkspaceReconstruction {
  projectId: string;
  page: LineagePage;
  summary: FinalCheckpointSummary;
  selection: WorkspaceRestoreSelection | null;
  interruptedRuns: Array<{
    kind: "research" | "revision";
    runId: string;
    persistedStatus: string;
    reconnectRequired: true;
    preservedArtifactEntryIds: string[];
  }>;
  pendingProposalId: string | null;
  /** No restart reconstruction is allowed to claim an executor is alive. */
  processRunning: false;
  /** Proposal decisions remain an explicit user action after restoration. */
  decisionApplied: false;
}

interface ProjectedEntry extends LineageEntry {
  sortKey: string;
}

interface CursorPayload {
  after: string;
  revision: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function truncate(value: unknown, max = 8_000): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 24)}\n[truncated]`;
}

function timestamp(value: string | null | undefined, fallback: string): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function target(type: LineageDetailTarget["type"], id: string, label?: string, path?: string): LineageDetailTarget {
  return { type, id, ...(label ? { label } : {}), ...(path && !path.startsWith("/") && !path.split("/").includes("..") ? { path } : {}) };
}

function diagnostic(value: unknown, detail: LineageDetailTarget | null = null): LineageEntry["diagnostic"] {
  if (!value) return null;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const summary = truncate(typeof value === "string" ? value : record.message ?? record.diagnostics ?? JSON.stringify(value), 32_000);
  return {
    available: summary.length > 0,
    code: typeof record.code === "string" ? record.code : null,
    summary,
    detailTarget: detail,
  };
}

function entry(input: {
  projectId: string;
  kind: LineageEntryKind;
  occurredAt: string;
  id: string;
  title: string;
  summary: string;
  target: LineageDetailTarget;
  status?: string | null;
  checkpointId?: string | null;
  runId?: string | null;
  proposalId?: string | null;
  attemptId?: string | null;
  sourceId?: string | null;
  versionId?: string | null;
  findingId?: string | null;
  commentId?: string | null;
  relatedTargets?: LineageDetailTarget[];
  diagnostic?: LineageEntry["diagnostic"];
}): ProjectedEntry {
  const parsed = lineageEntrySchema.parse({
    schemaVersion: lineageSchemaVersion,
    entryId: `${input.kind}:${input.id}`,
    projectId: input.projectId,
    occurredAt: input.occurredAt,
    kind: input.kind,
    title: input.title,
    summary: truncate(input.summary),
    target: input.target,
    detailTarget: input.target,
    status: input.status ?? null,
    checkpointId: input.checkpointId ?? null,
    runId: input.runId ?? null,
    proposalId: input.proposalId ?? null,
    attemptId: input.attemptId ?? null,
    sourceId: input.sourceId ?? null,
    versionId: input.versionId ?? null,
    findingId: input.findingId ?? null,
    commentId: input.commentId ?? null,
    relatedTargets: input.relatedTargets ?? [],
    diagnostic: input.diagnostic ?? null,
  });
  return { ...parsed, sortKey: `${parsed.occurredAt}\u0000${parsed.kind}\u0000${parsed.entryId}` };
}

function briefEntries(projectId: string, briefs: ResearchBrief[], now: string): ProjectedEntry[] {
  return briefs.filter((brief) => brief.status === "confirmed" && brief.confirmedAt && brief.confirmedRevision !== null).map((brief) => entry({
    projectId,
    kind: "brief.confirmed",
    occurredAt: timestamp(brief.confirmedAt, now),
    id: `${brief.briefId}:revision:${brief.confirmedRevision}`,
    title: "Research brief confirmed",
    summary: `${brief.question} (revision ${brief.confirmedRevision})`,
    target: target("brief", brief.briefId, brief.question),
    status: "confirmed",
  }));
}

function sourceEntries(projectId: string, sources: SourceRecord[], now: string): ProjectedEntry[] {
  const result: ProjectedEntry[] = [];
  for (const source of sources) {
    for (const attempt of source.attempts) {
      const status = attempt.status;
      result.push(entry({
        projectId,
        kind: "source.capture",
        occurredAt: timestamp(attempt.completedAt ?? attempt.startedAt ?? attempt.requestedAt, now),
        id: attempt.attemptId,
        title: "Source capture",
        summary: `${source.identity} capture ${status}`,
        target: target("source-capture", attempt.attemptId, source.identity),
        status,
        sourceId: source.sourceId,
        versionId: attempt.resultingVersionId ?? attempt.reusedVersionId ?? null,
        diagnostic: diagnostic(attempt.diagnostic, target("source-capture", attempt.attemptId, source.identity)),
      }));
    }
    for (const version of source.versions) {
      result.push(entry({
        projectId,
        kind: "source.version",
        occurredAt: timestamp(version.capturedAt, source.updatedAt || now),
        id: version.versionId,
        title: "Source evidence version",
        summary: `${source.identity} · ${version.mediaType} · ${version.byteLength} bytes`,
        target: target("source-version", version.versionId, source.identity),
        status: source.evidenceState,
        sourceId: source.sourceId,
        versionId: version.versionId,
        relatedTargets: [target("source", source.sourceId, source.identity)],
      }));
    }
    if (source.attempts.length === 0 && source.versions.length === 0) {
      result.push(entry({
        projectId,
        kind: "source.capture",
        occurredAt: timestamp(source.createdAt, now),
        id: source.sourceId,
        title: "Source registered",
        summary: `${source.identity} has no captured evidence yet`,
        target: target("source", source.sourceId, source.identity),
        status: source.evidenceState,
        sourceId: source.sourceId,
      }));
    }
  }
  return result;
}

function researchEntries(projectId: string, runs: ResearchRunRecord[], now: string): ProjectedEntry[] {
  const result: ProjectedEntry[] = [];
  for (const run of runs) {
    result.push(entry({
      projectId,
      kind: "research.run",
      occurredAt: timestamp(run.createdAt, now),
      id: run.runId,
      title: "Research run",
      summary: `${run.recipe} research run is ${run.status}`,
      target: target("research-run", run.runId),
      status: run.status,
      runId: run.runId,
      diagnostic: diagnostic(run.diagnostics, target("research-run", run.runId)),
    }));
    for (const attempt of run.synthesisAttempts) {
      const report = attempt.reportArtifactId ? run.artifacts.find((artifact) => artifact.artifactId === attempt.reportArtifactId) : undefined;
      if (!report && attempt.reportArtifactId === null) continue;
      result.push(entry({
        projectId,
        kind: "research.report",
        occurredAt: timestamp(attempt.endedAt ?? attempt.createdAt, run.createdAt),
        id: attempt.reportArtifactId ?? attempt.attemptId,
        title: "Research report checkpoint prepared",
        summary: report ? `${report.label || "Report"} · ${attempt.status}` : `Report synthesis ${attempt.status}`,
        target: target("research-report", attempt.reportArtifactId ?? attempt.attemptId, report?.label, report?.relativePath),
        status: attempt.status,
        runId: run.runId,
        attemptId: attempt.attemptId,
        diagnostic: diagnostic(attempt.diagnostics, target("research-run", run.runId)),
      }));
    }
    if (run.proposal) {
      result.push(entry({
        projectId,
        kind: "research.decision",
        occurredAt: timestamp(run.proposal.decidedAt ?? run.proposal.updatedAt, run.createdAt),
        id: run.proposal.proposalId,
        title: "Research report decision",
        summary: `Research report proposal is ${run.proposal.status}${run.proposal.decision ? ` (${run.proposal.decision})` : ""}`,
        target: target("decision", run.proposal.proposalId),
        status: run.proposal.decision ?? run.proposal.status,
        runId: run.runId,
        proposalId: run.proposal.proposalId,
        diagnostic: diagnostic(run.proposal.cleanup.diagnostics, target("proposal", run.proposal.proposalId)),
      }));
    }
  }
  return result;
}

function qualityEntries(projectId: string, reviews: QualityReviewRecord[], now: string): ProjectedEntry[] {
  const result: ProjectedEntry[] = [];
  for (const review of reviews) {
    const checkpointId = review.targetCheckpoint.checkpointId;
    for (const attempt of review.attempts) {
      const followUp = attempt.parentAttemptId !== null;
      result.push(entry({
        projectId,
        kind: followUp ? "qa.follow-up" : "qa.attempt",
        occurredAt: timestamp(attempt.createdAt, review.createdAt),
        id: attempt.attemptId,
        title: followUp ? "Follow-up quality review" : "Independent quality review",
        summary: `Quality attempt is ${attempt.status}${attempt.outcome ? ` (${attempt.outcome})` : ""}`,
        target: target("qa-attempt", attempt.attemptId),
        status: attempt.outcome ?? attempt.status,
        checkpointId,
        attemptId: attempt.attemptId,
        diagnostic: diagnostic(attempt.diagnostics, target("qa-attempt", attempt.attemptId)),
      }));
    }
    for (const finding of review.findings) {
      result.push(findingEntry(projectId, review, finding, now));
    }
    for (const disposition of review.dispositions) {
      result.push(entry({
        projectId,
        kind: "qa.disposition",
        occurredAt: timestamp(disposition.createdAt, review.updatedAt),
        id: disposition.dispositionId,
        title: "Finding disposition",
        summary: `${disposition.action}: ${truncate(disposition.rationale, 1_000)}`,
        target: target("finding", disposition.findingId),
        status: disposition.action,
        checkpointId,
        findingId: disposition.findingId,
        relatedTargets: disposition.supersedesDispositionId ? [target("finding", disposition.supersedesDispositionId)] : [],
      }));
    }
    for (const promotion of review.promotions) {
      result.push(entry({
        projectId,
        kind: "qa.promotion",
        occurredAt: timestamp(promotion.createdAt, review.updatedAt),
        id: promotion.promotionId,
        title: "Finding promoted to revision input",
        summary: `Finding promoted as ${promotion.target}`,
        target: target("finding", promotion.findingId),
        status: promotion.target,
        checkpointId,
        findingId: promotion.findingId,
        relatedTargets: [target("comment", promotion.targetId)],
      }));
    }
  }
  return result;
}

function findingEntry(projectId: string, review: QualityReviewRecord, finding: QualityFinding, now: string): ProjectedEntry {
  const related = [
    ...(finding.citation?.versionId ? [target("source-version", finding.citation.versionId)] : []),
    ...finding.evidence.slice(0, 16).map((evidence) => target("source-version", evidence.versionId)),
  ];
  return entry({
    projectId,
    kind: "qa.finding",
    occurredAt: timestamp(finding.createdAt, review.updatedAt || now),
    id: finding.findingId,
    title: finding.title,
    summary: finding.rationale,
    target: target("finding", finding.findingId, finding.title),
    status: finding.severity,
    checkpointId: review.targetCheckpoint.checkpointId,
    attemptId: finding.attemptId,
    findingId: finding.findingId,
    relatedTargets: related,
    diagnostic: finding.location.status === "unanchored" ? diagnostic(finding.location.diagnostic, target("finding", finding.findingId)) : null,
  });
}

function relationshipEntries(projectId: string, snapshot: LineageSnapshot, now: string): ProjectedEntry[] {
  const findingById = new Map<string, { checkpointId: string; attemptId: string }>();
  for (const review of snapshot.qualityReviews) {
    for (const finding of review.findings) {
      findingById.set(finding.findingId, {
        checkpointId: review.targetCheckpoint.checkpointId,
        attemptId: finding.attemptId,
      });
    }
  }
  return snapshot.findingRelationships.map((relationship) => {
    const source = findingById.get(relationship.fromFindingId);
    const relatedTargets = [target("finding", relationship.fromFindingId)];
    if (relationship.toFindingId) relatedTargets.push(target("finding", relationship.toFindingId));
    if (relationship.supersedesRelationshipId) relatedTargets.push(target("finding-relationship", relationship.supersedesRelationshipId));
    return entry({
      projectId,
      kind: "finding.relationship",
      occurredAt: timestamp(relationship.createdAt, now),
      id: relationship.relationshipId,
      title: "Cross-checkpoint finding relationship",
      summary: relationship.rationale,
      target: target("finding-relationship", relationship.relationshipId),
      status: relationship.relation,
      checkpointId: source?.checkpointId ?? null,
      attemptId: source?.attemptId ?? null,
      findingId: relationship.fromFindingId,
      relatedTargets,
    });
  });
}

function reviewAcknowledgmentEntries(projectId: string, snapshot: LineageSnapshot, now: string): ProjectedEntry[] {
  return snapshot.checkpointReviewAcknowledgments.map((acknowledgment) => entry({
    projectId,
    kind: "checkpoint.reviewed",
    occurredAt: timestamp(acknowledgment.createdAt, now),
    id: acknowledgment.acknowledgmentId,
    title: "Checkpoint review acknowledged",
    summary: `Checkpoint ${acknowledgment.checkpointId} was acknowledged after QA attempt ${acknowledgment.qaAttemptId}`,
    target: target("review-ack", acknowledgment.acknowledgmentId),
    status: "acknowledged",
    checkpointId: acknowledgment.checkpointId,
    attemptId: acknowledgment.qaAttemptId,
    relatedTargets: [target("checkpoint", acknowledgment.checkpointId), target("qa-attempt", acknowledgment.qaAttemptId)],
  }));
}

function commentEntries(projectId: string, comments: CommentRecord[]): ProjectedEntry[] {
  return comments.map((comment) => entry({
    projectId,
    kind: "comment.created",
    occurredAt: comment.createdAt,
    id: comment.id,
    title: "Human feedback",
    summary: comment.body,
    target: target("comment", comment.id, comment.documentPath ?? undefined, comment.documentPath ?? undefined),
    status: comment.state,
    runId: comment.runId,
    commentId: comment.id,
  }));
}

function revisionEntries(projectId: string, runs: RevisionRunRecord[], now: string): ProjectedEntry[] {
  return runs.flatMap((run) => {
    const items: ProjectedEntry[] = [entry({
      projectId,
      kind: "revision.run",
      occurredAt: timestamp(run.createdAt, now),
      id: run.runId,
      title: "Revision run",
      summary: `Comment-driven revision run is ${run.status}`,
      target: target("revision-run", run.runId),
      status: run.status,
      runId: run.runId,
      proposalId: run.proposalId,
      checkpointId: run.checkpoint?.sha ?? null,
      diagnostic: diagnostic(run.diagnostics, target("revision-run", run.runId)),
    })];
    if (run.checkpoint) items.push(entry({
      projectId,
      kind: "checkpoint.created",
      occurredAt: timestamp(run.startedAt ?? run.createdAt, run.createdAt),
      id: run.checkpoint.sha,
      title: "Revision checkpoint",
      summary: `Isolated checkpoint ${run.checkpoint.sha.slice(0, 12)} created for revision`,
      target: target("checkpoint", run.checkpoint.sha),
      status: run.status,
      runId: run.runId,
      checkpointId: run.checkpoint.sha,
    }));
    return items;
  });
}

const activeRestartStatuses = new Set(["queued", "running", "cancelling", "checkpointing"]);

/**
 * A derived notice makes a persisted active record truthful after a process restart.
 * It is deterministic and read-only: the canonical run, proposal, and artifacts are
 * not rewritten, and a later terminal record naturally removes the notice.
 */
function workspaceRestorationEntries(projectId: string, snapshot: LineageSnapshot, now: string): ProjectedEntry[] {
  return [
    ...snapshot.researchRuns.filter((run) => activeRestartStatuses.has(run.status)).map((run) => entry({
      projectId,
      kind: "workspace.restored",
      occurredAt: timestamp(run.lastEventAt ?? run.createdAt, now),
      id: `research:${run.runId}:reconnect`,
      title: "Research run requires reconnect",
      summary: `The persisted research run ${run.runId} was ${run.status} when Margin restarted. No live process is assumed; reconnect before continuing.`,
      target: target("workspace", `research:${run.runId}:reconnect`, run.runId),
      status: "interrupted",
      runId: run.runId,
      diagnostic: diagnostic({ code: "WORKSPACE_RECONNECT_REQUIRED", message: `Research run ${run.runId} was ${run.status} at restart.` }, target("research-run", run.runId)),
    })),
    ...snapshot.revisionRuns.filter((run) => activeRestartStatuses.has(run.status)).map((run) => entry({
      projectId,
      kind: "workspace.restored",
      occurredAt: timestamp(run.createdAt, now),
      id: `revision:${run.runId}:reconnect`,
      title: "Revision run requires reconnect",
      summary: `The persisted revision run ${run.runId} was ${run.status} when Margin restarted. No live process is assumed; the isolated worktree remains untouched.`,
      target: target("workspace", `revision:${run.runId}:reconnect`, run.runId),
      status: "interrupted",
      runId: run.runId,
      proposalId: run.proposalId,
      checkpointId: run.checkpoint?.sha ?? null,
      diagnostic: diagnostic({ code: "WORKSPACE_RECONNECT_REQUIRED", message: `Revision run ${run.runId} was ${run.status} at restart.` }, target("revision-run", run.runId)),
    })),
  ];
}

function proposalEntries(projectId: string, proposals: ProposalRecord[], researchRuns: ResearchRunRecord[], revisionRuns: RevisionRunRecord[], now: string): ProjectedEntry[] {
  const runById = new Map([...researchRuns, ...revisionRuns].map((run) => [run.runId, run]));
  return proposals.flatMap((proposal) => {
    const owner = runById.get(proposal.runId);
    const checkpointId = proposal.checkpoint.sha;
    const isResearchProposal = researchRuns.some((run) => run.runId === proposal.runId);
    const result: ProjectedEntry[] = [entry({
      projectId,
      kind: "proposal.created",
      occurredAt: timestamp(proposal.createdAt, now),
      id: proposal.proposalId,
      title: isResearchProposal ? "Research report proposal" : "Isolated revision proposal",
      summary: `${proposal.diff.files.length} changed file${proposal.diff.files.length === 1 ? "" : "s"} awaiting review`,
      target: target("proposal", proposal.proposalId),
      status: proposal.status,
      runId: proposal.runId,
      proposalId: proposal.proposalId,
      checkpointId,
      relatedTargets: owner ? [target(isResearchProposal ? "research-run" : "revision-run", owner.runId)] : [],
      diagnostic: diagnostic(proposal.diagnostics, target("proposal", proposal.proposalId)),
    })];
    result.push(entry({
      projectId,
      kind: "checkpoint.created",
      occurredAt: timestamp(proposal.createdAt, now),
      id: checkpointId,
      title: "Isolated checkpoint",
      summary: `Checkpoint ${checkpointId.slice(0, 12)} created for proposal review`,
      target: target("checkpoint", checkpointId),
      status: proposal.status,
      runId: proposal.runId,
      proposalId: proposal.proposalId,
      checkpointId,
    }));
    if (proposal.decision) result.push(entry({
      projectId,
      kind: "proposal.decision",
      occurredAt: timestamp(proposal.decidedAt ?? proposal.updatedAt, proposal.createdAt),
      id: proposal.proposalId,
      title: proposal.decision === "keep" ? "Proposal kept" : "Proposal rejected",
      summary: proposal.decision === "keep" ? "The isolated changes were applied to the canonical checkpoint" : "The isolated changes were rejected; canonical content remains unchanged",
      target: target("decision", proposal.proposalId),
      status: proposal.decision,
      runId: proposal.runId,
      proposalId: proposal.proposalId,
      checkpointId,
      diagnostic: diagnostic(proposal.cleanup.diagnostics, target("proposal", proposal.proposalId)),
    }));
    if (proposal.decision === "keep") result.push(entry({
      projectId,
      kind: "checkpoint.accepted",
      occurredAt: timestamp(proposal.decidedAt ?? proposal.updatedAt, proposal.createdAt),
      id: checkpointId,
      title: "Checkpoint accepted",
      summary: `Canonical checkpoint ${checkpointId.slice(0, 12)} now contains the kept proposal`,
      target: target("checkpoint", checkpointId),
      status: "accepted",
      runId: proposal.runId,
      proposalId: proposal.proposalId,
      checkpointId,
    }));
    return result;
  });
}

function fingerprint(snapshot: LineageSnapshot): string {
  const compact = {
    briefs: snapshot.briefs.map((item) => [item.briefId, item.revision, item.updatedAt]),
    researchRuns: snapshot.researchRuns.map((item) => [item.runId, item.status, item.lastEventAt, item.endedAt ?? item.createdAt]),
    sources: snapshot.sources.map((item) => [item.sourceId, item.updatedAt, item.latestVersionId, item.lastAttemptId]),
    qualityReviews: snapshot.qualityReviews.map((item) => [item.reviewId, item.updatedAt, item.latestAttemptId, item.findings.length, item.dispositions.length]),
    comments: snapshot.comments.map((item) => [item.id, item.updatedAt, item.state]),
    revisionRuns: snapshot.revisionRuns.map((item) => [item.runId, item.status, item.proposalId, item.createdAt]),
    proposals: snapshot.proposals.map((item) => [item.proposalId, item.status, item.decision, item.updatedAt]),
    findingRelationships: snapshot.findingRelationships.map((item) => [item.relationshipId, item.createdAt, item.supersedesRelationshipId]),
    checkpointReviewAcknowledgments: snapshot.checkpointReviewAcknowledgments.map((item) => [item.acknowledgmentId, item.createdAt, item.checkpointId, item.qaAttemptId]),
  };
  return createHash("sha256").update(JSON.stringify(compact), "utf8").digest("hex");
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(lineageCursorSchema.parse(value), "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (typeof parsed.after !== "string" || typeof parsed.revision !== "string" || !/^[a-f0-9]{64}$/.test(parsed.revision)) throw new Error("invalid cursor fields");
    return { after: parsed.after, revision: parsed.revision };
  } catch (error) {
    throw new LineageError("LINEAGE_INVALID_CURSOR", `Invalid lineage cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function latestAt<T>(values: T[], at: (value: T) => string | null | undefined): T | null {
  return values.reduce<T | null>((latest, value) => {
    if (!latest) return value;
    return Date.parse(at(value) ?? "") >= Date.parse(at(latest) ?? "") ? value : latest;
  }, null);
}

function finalCheckpointSummary(projectId: string, snapshot: LineageSnapshot, generatedAt: string): FinalCheckpointSummary {
  const reviews = snapshot.qualityReviews;
  const keptProposals = snapshot.proposals.filter((proposal) => proposal.decision === "keep");
  const acceptedCandidates = [
    ...reviews.map((review) => ({ checkpointId: review.targetCheckpoint.checkpointId, at: review.targetCheckpoint.acceptedAt })),
    ...keptProposals.map((proposal) => ({ checkpointId: proposal.checkpoint.sha, at: proposal.decidedAt ?? proposal.updatedAt })),
  ];
  const currentCheckpoint = latestAt(acceptedCandidates, (candidate) => candidate.at);
  const checkpointId = currentCheckpoint?.checkpointId ?? null;
  const checkpointReviews = checkpointId ? reviews.filter((review) => review.targetCheckpoint.checkpointId === checkpointId) : [];
  const checkpointReview = latestAt(checkpointReviews, (review) => review.updatedAt || review.createdAt);
  const attempts = checkpointReviews.flatMap((review) => review.attempts);
  const latestAttempt = latestAt(attempts, (attempt) => attempt.createdAt);
  const findings = checkpointReviews.flatMap((review) => review.findings);
  const findingById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const dispositions = checkpointReviews.flatMap((review) => review.dispositions);
  const latestDisposition = new Map<string, (typeof dispositions)[number]>();
  for (const disposition of dispositions) {
    const prior = latestDisposition.get(disposition.findingId);
    if (!prior || Date.parse(disposition.createdAt) >= Date.parse(prior.createdAt)) latestDisposition.set(disposition.findingId, disposition);
  }
  let open = 0;
  let acceptedRisk = 0;
  for (const findingId of findingById.keys()) {
    const disposition = latestDisposition.get(findingId);
    if (!disposition) open += 1;
    else if (disposition.action === "accepted-risk") acceptedRisk += 1;
  }

  const sourceBindings = checkpointReview?.targetCheckpoint.sourceGraph.sourceBindings ?? [];
  const sourceHealth = { total: sourceBindings.length, archived: 0, metadataOnly: 0, unavailable: 0, failed: 0 };
  for (const binding of sourceBindings) {
    const source = snapshot.sources.find((candidate) => candidate.sourceId === binding.sourceId);
    const version = source?.versions.find((candidate) => candidate.versionId === binding.versionId);
    const state = version ? source?.evidenceState : "unavailable";
    if (state === "archived") sourceHealth.archived += 1;
    else if (state === "metadata-only") sourceHealth.metadataOnly += 1;
    else if (state === "failed") sourceHealth.failed += 1;
    else sourceHealth.unavailable += 1;
  }

  const latestProposal = latestAt(
    snapshot.proposals.filter((proposal) => checkpointId === null || proposal.checkpoint.sha === checkpointId),
    (proposal) => proposal.decidedAt ?? proposal.updatedAt ?? proposal.createdAt,
  );
  const acknowledgment = checkpointId && latestAttempt
    ? snapshot.checkpointReviewAcknowledgments.some((item) => item.checkpointId === checkpointId && item.qaAttemptId === latestAttempt.attemptId)
    : false;
  const reportTarget = checkpointReview
    ? target("research-report", checkpointReview.targetCheckpoint.reportArtifactId, undefined, checkpointReview.targetCheckpoint.reportPath)
    : null;

  return finalCheckpointSummarySchema.parse({
    schemaVersion: lineageSchemaVersion,
    projectId,
    checkpointId,
    reportTarget,
    latestQaAttemptId: latestAttempt?.attemptId ?? null,
    latestQaOutcome: latestAttempt ? (latestAttempt.outcome ?? latestAttempt.status) : null,
    remainingRiskCounts: { open, accepted: acceptedRisk },
    sourceHealth,
    reviewAcknowledged: acknowledgment,
    proposalDecision: latestProposal ? (latestProposal.decision ?? "pending") : null,
    generatedAt,
  });
}

/** Projects canonical immutable records into a deterministic, restart-safe timeline. */
export class LineageService {
  private readonly clock: () => Date;
  private readonly projectPath?: LineageServiceOptions["projectPath"];
  private observedProposalDecisions = 0;

  constructor(private readonly store: LineageStore, options: LineageServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.projectPath = options.projectPath;
  }

  async list(projectId: string, options: LineageListOptions = {}): Promise<LineagePage> {
    const repositoryRoot = this.projectPath ? await this.projectPath(projectId) : undefined;
    if (this.projectPath && !repositoryRoot) throw new LineageError("LINEAGE_PROJECT_NOT_FOUND", `Project ${projectId} was not found`);
    const snapshot = await this.store.snapshot(projectId);
    const now = this.clock().toISOString();
    const revision = fingerprint(snapshot);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
    const projected = this.project(projectId, snapshot, now).sort((left, right) => left.sortKey.localeCompare(right.sortKey));
    const start = cursor ? projected.findIndex((candidate) => candidate.sortKey > cursor.after) : 0;
    const offset = cursor && start < 0 ? projected.length : Math.max(0, start);
    const pageEntries = projected.slice(offset, offset + limit);
    const hasMore = offset + pageEntries.length < projected.length;
    const nextCursor = hasMore && pageEntries.length > 0 ? encodeCursor({ after: pageEntries.at(-1)!.sortKey, revision }) : null;
    return lineagePageSchema.parse({
      schemaVersion: lineageSchemaVersion,
      projectId,
      entries: pageEntries.map(({ sortKey: _sortKey, ...item }) => item),
      cursor: options.cursor ?? null,
      nextCursor,
      hasMore,
      pageSize: limit,
      freshness: {
        revision,
        generatedAt: now,
        status: cursor && cursor.revision !== revision ? "stale" : "fresh",
        cursorRevision: cursor?.revision ?? null,
      },
    });
  }

  async projectPage(projectId: string, options: LineageListOptions = {}): Promise<LineagePage> {
    return this.list(projectId, options);
  }

  async get(projectId: string, entryId: string): Promise<LineageEntry> {
    const page = await this.list(projectId, { limit: 200 });
    const found = page.entries.find((item) => item.entryId === entryId);
    if (!found) throw new LineageError("LINEAGE_ENTRY_NOT_FOUND", `Lineage entry ${entryId} was not found`);
    return found;
  }

  async recordFindingRelationship(projectId: string, input: FindingRelationshipInput): Promise<FindingRelationship> {
    const candidate = findingRelationshipInputSchema.parse(input);
    const snapshot = await this.store.snapshot(projectId);
    if (!snapshot.qualityReviews.some((review) => review.findings.some((finding) => finding.findingId === candidate.fromFindingId))) {
      throw new LineageError("LINEAGE_INVALID_RELATIONSHIP", `Finding ${candidate.fromFindingId} does not belong to project ${projectId}`);
    }
    if (candidate.toFindingId && !snapshot.qualityReviews.some((review) => review.findings.some((finding) => finding.findingId === candidate.toFindingId))) {
      throw new LineageError("LINEAGE_INVALID_RELATIONSHIP", `Finding ${candidate.toFindingId} does not belong to project ${projectId}`);
    }
    if (candidate.supersedesRelationshipId && !snapshot.findingRelationships.some((item) => item.relationshipId === candidate.supersedesRelationshipId)) {
      throw new LineageError("LINEAGE_INVALID_RELATIONSHIP", `Relationship ${candidate.supersedesRelationshipId} does not exist`);
    }
    const createdAt = candidate.createdAt ?? this.clock().toISOString();
    const relationshipId = candidate.relationshipId ?? `relationship-${createHash("sha256").update(JSON.stringify({ projectId, ...candidate, createdAt }), "utf8").digest("hex").slice(0, 24)}`;
    try {
      return await this.store.appendFindingRelationship({ ...candidate, relationshipId, projectId, createdAt });
    } catch (error) {
      throw new LineageError("LINEAGE_INVALID_RELATIONSHIP", error instanceof Error ? error.message : String(error));
    }
  }

  /** Explicit alias for callers that use persistence terminology. */
  async appendFindingRelationship(projectId: string, input: FindingRelationshipInput): Promise<FindingRelationship> {
    return this.recordFindingRelationship(projectId, input);
  }

  async acknowledgeCheckpointReview(projectId: string, input: CheckpointReviewAcknowledgmentInput): Promise<CheckpointReviewAcknowledgment> {
    const candidate = checkpointReviewAcknowledgmentInputSchema.parse(input);
    const snapshot = await this.store.snapshot(projectId);
    const review = snapshot.qualityReviews.find((item) => item.targetCheckpoint.checkpointId === candidate.checkpointId && item.attempts.some((attempt) => attempt.attemptId === candidate.qaAttemptId));
    const attempt = review?.attempts.find((item) => item.attemptId === candidate.qaAttemptId);
    if (!review || !attempt || !isTerminalQualityAttemptStatus(attempt.status)) {
      throw new LineageError("LINEAGE_INVALID_REVIEW_ACKNOWLEDGMENT", `QA attempt ${candidate.qaAttemptId} is not a terminal attempt for checkpoint ${candidate.checkpointId}`);
    }
    const acknowledgmentId = candidate.acknowledgmentId ?? `review-ack-${createHash("sha256").update(JSON.stringify({ projectId, ...candidate }), "utf8").digest("hex").slice(0, 24)}`;
    const createdAt = candidate.createdAt ?? this.clock().toISOString();
    try {
      return await this.store.appendCheckpointReviewAcknowledgment({ ...candidate, acknowledgmentId, projectId, createdAt });
    } catch (error) {
      throw new LineageError("LINEAGE_INVALID_REVIEW_ACKNOWLEDGMENT", error instanceof Error ? error.message : String(error));
    }
  }

  /** Explicit alias for callers that use persistence terminology. */
  async appendCheckpointReviewAcknowledgment(projectId: string, input: CheckpointReviewAcknowledgmentInput): Promise<CheckpointReviewAcknowledgment> {
    return this.acknowledgeCheckpointReview(projectId, input);
  }

  async getFinalCheckpointSummary(projectId: string): Promise<FinalCheckpointSummary> {
    const snapshot = await this.store.snapshot(projectId);
    return finalCheckpointSummary(projectId, snapshot, this.clock().toISOString());
  }

  async finalCheckpointSummary(projectId: string): Promise<FinalCheckpointSummary> {
    return this.getFinalCheckpointSummary(projectId);
  }

  /**
   * Reconstructs restart state from the same durable projection used by the UI.
   * The optional selection is validated as navigation-only data; it cannot change
   * run status, proposal decisions, checkpoints, or review acknowledgements.
   */
  async reconstructWorkspace(projectId: string, selection: WorkspaceRestoreSelection | null = null): Promise<WorkspaceReconstruction> {
    const parsedSelection = selection === null ? null : workspaceRestoreSelectionSchema.parse(selection);
    if (parsedSelection && parsedSelection.projectId !== projectId) {
      throw new LineageError("LINEAGE_PROJECT_NOT_FOUND", `Workspace selection belongs to ${parsedSelection.projectId}, not ${projectId}`);
    }
    const page = await this.list(projectId, { limit: 200 });
    const summary = await this.getFinalCheckpointSummary(projectId);
    const interruptedEntries = page.entries.filter((item) => item.kind === "workspace.restored" && item.runId && item.status === "interrupted");
    const artifactKinds = new Set<LineageEntryKind>(["source.capture", "source.version", "research.report", "checkpoint.created"]);
    const interruptedRuns = interruptedEntries.map((item) => ({
      kind: item.diagnostic?.detailTarget?.type === "revision-run" ? "revision" as const : "research" as const,
      runId: item.runId!,
      persistedStatus: item.summary.match(/ was (queued|running|cancelling|checkpointing) when/)?.[1] ?? "unknown",
      reconnectRequired: true as const,
      preservedArtifactEntryIds: page.entries.filter((candidate) => candidate.runId === item.runId && artifactKinds.has(candidate.kind)).map((candidate) => candidate.entryId),
    }));
    const pendingProposal = [...page.entries]
      .filter((item) => item.kind === "proposal.created" && item.status === "pending" && item.proposalId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
    const pendingProposalId = pendingProposal && !page.entries.some((item) => item.kind === "proposal.decision" && item.proposalId === pendingProposal.proposalId)
      ? pendingProposal.proposalId!
      : null;
    return {
      projectId,
      page,
      summary,
      selection: parsedSelection,
      interruptedRuns,
      pendingProposalId,
      processRunning: false,
      decisionApplied: false,
    };
  }

  /** Register a non-persisting observer so proposal reconciliation and projection freshness can coexist. */
  async observeProposalDecision(_proposal: ProposalRecord): Promise<void> {
    this.observedProposalDecisions += 1;
  }

  get observedDecisionCount(): number {
    return this.observedProposalDecisions;
  }

  private project(projectId: string, snapshot: LineageSnapshot, now: string): ProjectedEntry[] {
    const projected = [
      ...briefEntries(projectId, snapshot.briefs, now),
      ...sourceEntries(projectId, snapshot.sources, now),
      ...researchEntries(projectId, snapshot.researchRuns, now),
      ...workspaceRestorationEntries(projectId, snapshot, now),
      ...qualityEntries(projectId, snapshot.qualityReviews, now),
      ...relationshipEntries(projectId, snapshot, now),
      ...reviewAcknowledgmentEntries(projectId, snapshot, now),
      ...commentEntries(projectId, snapshot.comments),
      ...revisionEntries(projectId, snapshot.revisionRuns, now),
      ...proposalEntries(projectId, snapshot.proposals, snapshot.researchRuns, snapshot.revisionRuns, now),
    ];
    // A checkpoint can be present in both a run record and its proposal record.
    // Keep one stable milestone rather than creating duplicate lineage truth.
    return [...new Map(projected.map((item) => [item.entryId, item])).values()];
  }
}

export function createLineageService(store: LineageStore, options: LineageServiceOptions = {}): LineageService {
  return new LineageService(store, options);
}
