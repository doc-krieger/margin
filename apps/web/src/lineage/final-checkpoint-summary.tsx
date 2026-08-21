import { useState } from "react";
import type { FinalCheckpointSummary } from "@margin/shared";

export interface FinalCheckpointSummaryProps {
  summary: FinalCheckpointSummary;
  onStartFollowUpQa?: () => Promise<void> | void;
  followUpQaDisabled?: boolean;
}

function checkpointLabel(checkpointId: string | null): string {
  return checkpointId ? `${checkpointId.slice(0, 16)}${checkpointId.length > 16 ? "…" : ""}` : "No accepted checkpoint";
}

function decisionLabel(decision: FinalCheckpointSummary["proposalDecision"]): string {
  if (!decision) return "Not created";
  return decision === "keep" ? "Kept in canonical project" : decision === "reject" ? "Rejected; project unchanged" : "Pending review";
}

function qaLabel(outcome: string | null): string {
  if (!outcome) return "Not run";
  return outcome.replace(/[_-]/g, " ");
}

/** Truthful checkpoint health summary; all values come from the server projection. */
export function FinalCheckpointSummary({ summary, onStartFollowUpQa, followUpQaDisabled = false }: FinalCheckpointSummaryProps) {
  const [startingQa, setStartingQa] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const canStartQa = Boolean(summary.checkpointId && onStartFollowUpQa && !followUpQaDisabled);

  async function startFollowUpQa() {
    if (!onStartFollowUpQa || !canStartQa || startingQa) return;
    setStartingQa(true);
    setActionError(undefined);
    try {
      await onStartFollowUpQa();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Follow-up QA could not be started.");
    } finally {
      setStartingQa(false);
    }
  }

  return (
    <section className="final-checkpoint-summary" data-testid="final-checkpoint-summary" aria-labelledby="final-checkpoint-summary-title">
      <div className="lineage-surface__heading">
        <div>
          <span className="eyebrow">Current truth</span>
          <h3 id="final-checkpoint-summary-title">Final checkpoint</h3>
        </div>
        <span className={`status-badge ${summary.reviewAcknowledged ? "status-badge--success" : ""}`}>
          {summary.reviewAcknowledged ? "Reviewed" : "Review pending"}
        </span>
      </div>
      <p className="final-checkpoint-summary__intro">
        This is the latest durable checkpoint, not a local running-state hint. Revisions and QA remain separate append-only records.
      </p>
      <div className="final-checkpoint-summary__checkpoint">
        <span className="eyebrow">Checkpoint</span>
        <strong>{checkpointLabel(summary.checkpointId)}</strong>
        {summary.reportTarget ? <span>{summary.reportTarget.label ?? summary.reportTarget.id}</span> : <span>No accepted report is available.</span>}
      </div>
      <div className="lineage-health-grid">
        <div className="lineage-health-card">
          <span>Open risk</span>
          <strong>{summary.remainingRiskCounts.open}</strong>
          <small>findings still needing attention</small>
        </div>
        <div className="lineage-health-card">
          <span>Accepted risk</span>
          <strong>{summary.remainingRiskCounts.accepted}</strong>
          <small>findings acknowledged by review</small>
        </div>
        <div className="lineage-health-card">
          <span>Latest QA</span>
          <strong>{qaLabel(summary.latestQaOutcome)}</strong>
          <small>{summary.latestQaAttemptId ? `Attempt ${summary.latestQaAttemptId.slice(0, 12)}…` : "No QA attempt recorded"}</small>
        </div>
      </div>
      <dl className="final-checkpoint-summary__facts">
        <div><dt>Sources</dt><dd>{summary.sourceHealth.total} total · {summary.sourceHealth.unavailable} unavailable · {summary.sourceHealth.failed} failed</dd></div>
        <div><dt>Source metadata</dt><dd>{summary.sourceHealth.metadataOnly} metadata-only · {summary.sourceHealth.archived} archived</dd></div>
        <div><dt>Proposal decision</dt><dd>{decisionLabel(summary.proposalDecision)}</dd></div>
        <div><dt>Generated</dt><dd><time dateTime={summary.generatedAt}>{new Date(summary.generatedAt).toLocaleString()}</time></dd></div>
      </dl>
      <div className="final-checkpoint-summary__actions">
        <button type="button" onClick={() => void startFollowUpQa()} disabled={!canStartQa || startingQa}>
          {startingQa ? "Starting follow-up QA…" : "Start follow-up QA"}
        </button>
        {!summary.checkpointId ? <span className="lineage-action-note">An accepted checkpoint is required before QA can start.</span> : null}
        {followUpQaDisabled && summary.checkpointId ? <span className="lineage-action-note">Follow-up QA is already being started.</span> : null}
        {actionError ? <span className="lineage-error" role="alert">{actionError}</span> : null}
      </div>
    </section>
  );
}
