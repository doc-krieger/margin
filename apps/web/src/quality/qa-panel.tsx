import { useCallback, useEffect, useMemo, useState } from "react";
import type { QualityAcceptedCheckpoint, QualityFinding, QualityReviewRecord, ResearchRunRecord } from "@margin/shared";
import { FindingCommentDialog } from "./finding-comment-dialog";
import {
  defaultQualityApiClient,
  sha256Text,
  type QualityApiClient,
  type QualityDispositionInput,
  type QualityPromotionInput,
} from "./api";

export interface QualityReviewApi {
  listReviews(projectId: string): Promise<QualityReviewRecord[]>;
  getReview(projectId: string, reviewId: string): Promise<QualityReviewRecord>;
  startReview(projectId: string, input: Parameters<QualityApiClient["startReview"]>[1]): Promise<QualityReviewRecord>;
  retryReview(projectId: string, reviewId: string, profileId?: string): Promise<QualityReviewRecord>;
  cancelReview(projectId: string, reviewId: string, input?: { reason?: string }): Promise<QualityReviewRecord>;
  appendDisposition(projectId: string, reviewId: string, findingId: string, input: QualityDispositionInput): Promise<QualityReviewRecord>;
  promoteFinding(projectId: string, reviewId: string, findingId: string, input: QualityPromotionInput): Promise<QualityReviewRecord>;
  subscribeReviewEvents(projectId: string, reviewId: string, after: number, handlers: { onEvent?: (event: { sequence: number; type: string; message: string; percent: number | null }) => void; onError?: (event: Event) => void }): () => void;
}

export interface QualityReviewPanelProps {
  projectId: string;
  run?: ResearchRunRecord;
  api?: QualityReviewApi;
  initialReview?: QualityReviewRecord;
  initialReviews?: QualityReviewRecord[];
  acceptedCheckpoint?: QualityAcceptedCheckpoint;
  reviewerInstruction?: string;
  profileId?: string;
}

const degradedStatuses = new Set(["failed", "cancelled", "partial", "inconclusive"]);
const activeStatuses = new Set(["queued", "running", "cancelling"]);

function latestAttempt(review?: QualityReviewRecord) {
  return review?.attempts.find((attempt) => attempt.attemptId === review.latestAttemptId) ?? review?.attempts[review.attempts.length - 1];
}

function findingDisposition(review: QualityReviewRecord, findingId: string) {
  const dispositions = review.dispositions.filter((item) => item.findingId === findingId);
  return dispositions[dispositions.length - 1];
}

function newId(prefix: string): string {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`;
}

/**
 * Converts the research run's frozen report/source projection into the QA checkpoint
 * contract. Missing projection evidence remains explicit instead of becoming a latest-source lookup.
 */
export function acceptedCheckpointFromRun(run: ResearchRunRecord, acceptedBy = "user"): QualityAcceptedCheckpoint | undefined {
  const synthesis = run.synthesisAttempts.find((attempt) => attempt.attemptId === run.latestSynthesisAttemptId) ?? run.synthesisAttempts[run.synthesisAttempts.length - 1];
  const reportArtifactId = synthesis?.reportArtifactId ?? run.proposal?.reportArtifactId;
  const reportArtifact = reportArtifactId ? run.artifacts.find((artifact) => artifact.artifactId === reportArtifactId) : undefined;
  if (!reportArtifact || reportArtifact.kind !== "report" || reportArtifact.status !== "complete" || !reportArtifact.sha256) return undefined;

  const projectionEntries = new Map((run.sourceProjection?.entries ?? []).map((entry) => [`${entry.sourceId}:${entry.versionId}`, entry]));
  const missing = new Set((run.sourceProjection?.missing ?? []).map((entry) => `${entry.sourceId}:${entry.versionId}`));
  const sourceBindings = run.frozenSourceBindings.map((binding) => {
    const entry = projectionEntries.get(`${binding.sourceId}:${binding.versionId}`);
    const unavailable = missing.has(`${binding.sourceId}:${binding.versionId}`);
    return {
      sourceId: binding.sourceId,
      versionId: binding.versionId,
      checksum: binding.checksum,
      required: binding.required,
      citationKeys: binding.citationKey ? [binding.citationKey] : [],
      evidenceAvailability: unavailable ? "unavailable" as const : entry ? "full-text" as const : "metadata-only" as const,
      evidenceChecksum: entry?.checksum ?? null,
    };
  });

  return {
    checkpointId: run.runId,
    reportArtifactId: reportArtifact.artifactId,
    reportPath: reportArtifact.relativePath,
    reportSha256: reportArtifact.sha256,
    sourceGraph: {
      graphId: `${run.runId}-sources`,
      sourceBindings,
      graphChecksum: null,
      capturedAt: run.endedAt ?? run.createdAt,
    },
    citationValidationHash: null,
    acceptedAt: run.endedAt ?? run.createdAt,
    acceptedBy,
  };
}

function formatStatus(review: QualityReviewRecord): string {
  const attempt = latestAttempt(review);
  if (!attempt) return "No reviewer attempt has run yet.";
  if (attempt.status === "completed" && attempt.outcome === "pass") return "Review passed: no findings were produced.";
  if (attempt.status === "completed" && attempt.outcome === "findings") return "Review completed with findings requiring disposition.";
  if (degradedStatuses.has(attempt.status)) return `Review ${attempt.status}: this is not a pass.`;
  return `Reviewer ${attempt.status}; terminal outcome has not been established.`;
}

function statusClass(review: QualityReviewRecord): string {
  const attempt = latestAttempt(review);
  if (attempt && degradedStatuses.has(attempt.status)) return "quality-status quality-status--error";
  if (attempt?.status === "completed" && attempt.outcome === "pass") return "quality-status quality-status--success";
  return "quality-status";
}

function checkpointLabel(checkpoint: QualityAcceptedCheckpoint): string {
  return `${checkpoint.reportPath} · ${checkpoint.reportSha256.slice(0, 12)}…`;
}

/** Independent QA review surface with reconnectable progress and append-only actions. */
export function QualityReviewPanel({
  projectId,
  run,
  api = defaultQualityApiClient,
  initialReview,
  initialReviews,
  acceptedCheckpoint,
  reviewerInstruction: reviewerInstructionProp,
  profileId,
}: QualityReviewPanelProps) {
  const checkpoint = acceptedCheckpoint ?? (run ? acceptedCheckpointFromRun(run) : undefined);
  const [review, setReview] = useState<QualityReviewRecord | undefined>(initialReview);
  const [reviews, setReviews] = useState<QualityReviewRecord[]>(initialReviews ?? (initialReview ? [initialReview] : []));
  const [instruction, setInstruction] = useState(reviewerInstructionProp ?? "Independently inspect the accepted report and frozen source graph. Identify unsupported, contradictory, overstated, and unresolved-citation claims. Cite only evidence available in this immutable checkpoint; report uncertainty and leave unsafe claims unanchored.");
  const [loading, setLoading] = useState(!initialReview && !initialReviews);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [eventMessage, setEventMessage] = useState("");
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [promotionFinding, setPromotionFinding] = useState<QualityFinding>();

  const refresh = useCallback(async (reviewId: string) => {
    const next = await api.getReview(projectId, reviewId);
    setReview(next);
    setReviews((current) => [next, ...current.filter((item) => item.reviewId !== next.reviewId)]);
    return next;
  }, [api, projectId]);

  useEffect(() => {
    if (initialReview || initialReviews) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.listReviews(projectId).then((loaded) => {
      if (cancelled) return;
      setReviews(loaded);
      const matching = checkpoint ? loaded.find((item) => item.targetCheckpoint.reportArtifactId === checkpoint.reportArtifactId && item.targetCheckpoint.reportSha256 === checkpoint.reportSha256) : loaded[0];
      setReview(matching);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Quality reviews could not be loaded.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, checkpoint, initialReview, initialReviews, projectId]);

  useEffect(() => {
    const attempt = latestAttempt(review);
    if (!review || !attempt || !activeStatuses.has(attempt.status)) return;
    setEventMessage(`Reconnecting to reviewer attempt ${attempt.attemptId}.`);
    return api.subscribeReviewEvents(projectId, review.reviewId, attempt.progress.at(-1)?.sequence ?? -1, {
      onEvent: (event) => {
        setEventMessage(event.message || `Reviewer progress: ${event.type}`);
        void refresh(review.reviewId).catch((cause) => setError(cause instanceof Error ? cause.message : "Review progress could not be refreshed."));
      },
      onError: () => setEventMessage("Live progress is unavailable; the persisted attempt state remains authoritative."),
    });
  }, [api, projectId, refresh, review]);

  async function runAction(action: () => Promise<QualityReviewRecord>) {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      setReview(next);
      setReviews((current) => [next, ...current.filter((item) => item.reviewId !== next.reviewId)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The quality action failed; no review history was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!checkpoint) {
      setError("A complete report artifact and frozen source graph are required before an independent review can start.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const text = instruction.trim();
      const next = await api.startReview(projectId, {
        targetCheckpoint: checkpoint,
        reviewerInstruction: { instructionId: newId("instruction"), text, sha256: await sha256Text(text), createdAt: new Date().toISOString() },
        ...(profileId ? { profileId } : {}),
      });
      setReview(next);
      setReviews((current) => [next, ...current.filter((item) => item.reviewId !== next.reviewId)]);
      setEventMessage("Independent reviewer queued against the immutable checkpoint.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The independent review could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function disposition(finding: QualityFinding, action: QualityDispositionInput["action"]) {
    if (!review) return;
    const text = rationale[finding.findingId]?.trim();
    if (!text) {
      setError("Add a rationale before appending a disposition.");
      return;
    }
    await runAction(() => api.appendDisposition(projectId, review.reviewId, finding.findingId, { action, rationale: text, actorId: "user", supersedesDispositionId: findingDisposition(review, finding.findingId)?.dispositionId ?? null }));
  }

  async function promote(finding: QualityFinding, target: QualityPromotionInput["target"], body: string) {
    if (!review) return;
    await runAction(() => api.promoteFinding(projectId, review.reviewId, finding.findingId, { target, body, actorId: "user" }));
    setPromotionFinding(undefined);
  }

  const attempt = latestAttempt(review);
  const canRetry = Boolean(review && attempt && degradedStatuses.has(attempt.status));
  const canCancel = Boolean(review && attempt && activeStatuses.has(attempt.status));
  const findings = review?.findings ?? [];

  return (
    <section className="quality-panel" data-testid="quality-review-panel" aria-labelledby="quality-review-title">
      <div className="quality-panel__heading">
        <div>
          <span className="eyebrow">Independent quality review</span>
          <h2 id="quality-review-title">Claim-level QA</h2>
        </div>
        {checkpoint ? <span className="quality-panel__checkpoint" title={checkpoint.reportSha256}>Frozen: {checkpointLabel(checkpoint)}</span> : null}
      </div>
      <p className="quality-panel__intro">Run an independent Pi review against an immutable accepted checkpoint. Findings, dispositions, retries, and promotions remain append-only and never rewrite the report.</p>

      {loading ? <p className="quality-status" role="status">Loading prior quality attempts…</p> : null}
      {error ? <p className="quality-status quality-status--error" role="alert">{error}</p> : null}
      {eventMessage ? <p className="quality-status" role="status">{eventMessage}</p> : null}

      {!review ? (
        <div className="quality-start" data-testid="quality-start">
          <label>
            Reviewer instruction
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={5} />
          </label>
          {!checkpoint ? <p className="quality-status quality-status--error">Quality review is unavailable until this run has a complete report artifact with a frozen source graph.</p> : null}
          <button type="button" className="button--primary" onClick={() => void start()} disabled={busy || !instruction.trim() || !checkpoint}>{busy ? "Starting…" : "Start independent review"}</button>
        </div>
      ) : (
        <>
          <div className="quality-review-summary">
            <p className={statusClass(review)} role="status">{formatStatus(review)}</p>
            <dl className="quality-statistics">
              <div><dt>Attempts</dt><dd>{review.attempts.length}</dd></div>
              <div><dt>Findings</dt><dd>{findings.length}</dd></div>
              <div><dt>Anchored</dt><dd>{attempt?.statistics.anchoredFindings ?? 0}</dd></div>
              <div><dt>Unresolved citations</dt><dd>{attempt?.statistics.unresolvedCitations ?? 0}</dd></div>
            </dl>
            <div className="quality-actions">
              {canRetry ? <button type="button" onClick={() => void runAction(() => api.retryReview(projectId, review.reviewId, profileId))} disabled={busy}>Retry immutable review</button> : null}
              {canCancel ? <button type="button" onClick={() => void runAction(() => api.cancelReview(projectId, review.reviewId, { reason: "Cancelled from QA panel" }))} disabled={busy}>Cancel attempt</button> : null}
            </div>
          </div>

          <details className="quality-attempt-history" open>
            <summary>Attempt history ({review.attempts.length})</summary>
            <ol>
              {review.attempts.map((item) => <li key={item.attemptId}><strong>{item.attemptId}</strong> · {item.status}{item.outcome ? ` · outcome: ${item.outcome}` : ""} · {item.progress.length} progress events</li>)}
            </ol>
          </details>

          <div className="quality-findings" aria-live="polite">
            <h3>Findings</h3>
            {findings.length === 0 ? <p>No claim-linked findings have been persisted for this review attempt.</p> : findings.map((finding) => {
              const dispositionValue = findingDisposition(review, finding.findingId);
              const location = finding.location.status === "anchored" && finding.location.anchor ? `${finding.location.anchor.relativePath}:${finding.location.anchor.line ?? finding.location.anchor.startOffset}` : "Unanchored — inspect manually";
              return (
                <article className={`quality-finding quality-finding--${finding.severity}`} key={finding.findingId} data-testid="quality-finding">
                  <div className="quality-finding__heading"><span className="quality-finding__kind">{finding.kind}</span><span>{finding.severity} severity · {finding.uncertainty} uncertainty</span></div>
                  <h4>{finding.title}</h4>
                  <p>{finding.rationale}</p>
                  <p className={finding.location.status === "anchored" ? "quality-location" : "quality-location quality-location--warning"}><strong>Report location:</strong> {location}</p>
                  {finding.citation ? <p className="quality-location"><strong>Citation:</strong> {finding.citation.citationKey}</p> : null}
                  {finding.evidence.length ? <details><summary>Evidence ({finding.evidence.length})</summary>{finding.evidence.map((evidence, index) => <p key={`${finding.findingId}-evidence-${index}`}><strong>{evidence.availability}</strong> · {evidence.sourceId} / {evidence.versionId}{evidence.excerpt ? ` · ${evidence.excerpt}` : evidence.diagnostic ? ` · ${evidence.diagnostic}` : ""}</p>)}</details> : <p className="quality-location quality-location--warning">No safe passage-level evidence was available.</p>}
                  {dispositionValue ? <p className="quality-disposition" role="status">Disposition: {dispositionValue.action} — {dispositionValue.rationale}</p> : null}
                  <label className="quality-rationale">Disposition rationale<input value={rationale[finding.findingId] ?? ""} onChange={(event) => setRationale((current) => ({ ...current, [finding.findingId]: event.target.value }))} placeholder="Explain the human decision" /></label>
                  <div className="quality-finding__actions">
                    <button type="button" onClick={() => void disposition(finding, "accepted-risk")} disabled={busy}>Accept risk</button>
                    <button type="button" onClick={() => void disposition(finding, "false-positive")} disabled={busy}>Mark false positive</button>
                    {finding.location.status === "anchored" ? <button type="button" onClick={() => setPromotionFinding(finding)} disabled={busy}>Promote to comment or revision input</button> : <span className="quality-action-note">Promotion unavailable without a safe report anchor.</span>}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {reviews.length > 1 ? <details className="quality-prior-reviews"><summary>Prior review checkpoints ({reviews.length - 1})</summary><ul>{reviews.filter((item) => item.reviewId !== review?.reviewId).map((item) => <li key={item.reviewId}>{item.reviewId} · {item.status} · {item.targetCheckpoint.reportPath}</li>)}</ul></details> : null}
      {promotionFinding ? <FindingCommentDialog finding={promotionFinding} busy={busy} onClose={() => setPromotionFinding(undefined)} onSubmit={(target, body) => promote(promotionFinding, target, body)} /> : null}
    </section>
  );
}

export const QaPanel = QualityReviewPanel;
export const QAReviewPanel = QualityReviewPanel;
