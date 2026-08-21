import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { qualityPromotionTargetSchema, type QualityAcceptedCheckpoint, type QualityFinding, type QualityFindingPromotion, type QualityPromotionTarget } from "../../../../packages/shared/src/quality/contracts.js";
import { CommentService } from "../comments/repository.js";

export type QualityPromotionErrorCode =
  | "FINDING_NOT_ANCHORED"
  | "CHECKPOINT_CHANGED"
  | "REPORT_PATH_INVALID"
  | "COMMENTS_UNAVAILABLE";

export class QualityPromotionError extends Error {
  constructor(public readonly code: QualityPromotionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QualityPromotionError";
  }
}

export interface QualityPromotionInput {
  projectId: string;
  repositoryRoot: string;
  checkpoint: QualityAcceptedCheckpoint;
  finding: QualityFinding;
  target: QualityPromotionTarget;
  actorId: string;
  body?: string;
}

export interface QualityPromotionResult {
  promotion: QualityFindingPromotion;
  commentId?: string;
  revisionInput?: {
    id: string;
    body: string;
    reportPath: string;
    startOffset: number;
    endOffset: number;
  };
}

function safeReportPath(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new QualityPromotionError("REPORT_PATH_INVALID", "Quality finding report path is outside the project root");
  }
  return absolutePath;
}

function promotionBody(finding: QualityFinding, override?: string): string {
  if (override?.trim()) return override.trim();
  const suggested = finding.suggestedRevision ? `\n\nSuggested revision:\n${finding.suggestedRevision}` : "";
  return `[Quality review] ${finding.title}\n\n${finding.rationale}${suggested}`;
}

/** Promote a finding without editing the accepted report or the finding history. */
export async function promoteQualityFinding(
  input: QualityPromotionInput,
  comments?: CommentService,
): Promise<QualityPromotionResult> {
  if (input.finding.location.status !== "anchored" || !input.finding.location.anchor) {
    throw new QualityPromotionError("FINDING_NOT_ANCHORED", "Only safely anchored quality findings can be promoted");
  }
  const anchor = input.finding.location.anchor;
  if (anchor.relativePath !== input.checkpoint.reportPath) {
    throw new QualityPromotionError("REPORT_PATH_INVALID", "Quality finding anchor does not target the accepted report artifact");
  }
  const target = qualityPromotionTargetSchema.parse(input.target);
  const reportPath = safeReportPath(input.repositoryRoot, anchor.relativePath);
  let reportText: string;
  try {
    reportText = await readFile(reportPath, "utf8");
  } catch (error) {
    throw new QualityPromotionError("CHECKPOINT_CHANGED", "The accepted report is no longer available", { cause: error });
  }
  const reportChecksum = createHash("sha256").update(reportText, "utf8").digest("hex");
  if (reportChecksum !== input.checkpoint.reportSha256) {
    throw new QualityPromotionError("CHECKPOINT_CHANGED", "The accepted report changed after the quality checkpoint");
  }
  if (anchor.endOffset > reportText.length || reportText.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote) {
    throw new QualityPromotionError("CHECKPOINT_CHANGED", "The finding anchor no longer matches the accepted report");
  }

  const body = promotionBody(input.finding, input.body);
  let commentId: string | undefined;
  let revisionInput: QualityPromotionResult["revisionInput"];
  if (target === "comment") {
    if (!comments) throw new QualityPromotionError("COMMENTS_UNAVAILABLE", "Comment promotion is not configured");
    const comment = comments.createSelectionComment({
      projectId: input.projectId,
      documentPath: anchor.relativePath,
      documentText: reportText,
      start: anchor.startOffset,
      end: anchor.endOffset,
    body,
    });
    commentId = comment.id;
  } else {
    revisionInput = {
      id: `revision-input-${randomUUID()}`,
      body,
      reportPath: anchor.relativePath,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }

  const promotion: QualityFindingPromotion = {
    promotionId: randomUUID(),
    findingId: input.finding.findingId,
    target,
    targetId: commentId ?? revisionInput!.id,
    actorId: input.actorId,
    createdAt: new Date().toISOString(),
  };
  return { promotion, commentId, revisionInput };
}
