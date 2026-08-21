import { useEffect, useMemo, useState } from "react";
import {
  defaultProposalApiClient,
  ProposalApiError,
  type ProposalApiClient,
  type ProposalChangedFile,
  type ProposalDecision,
  type ProposalFile,
  type ProposalReview,
} from "./api";

export interface ProposalReviewPanelProps {
  projectId: string;
  proposalId: string;
  api?: ProposalApiClient;
  initialReview?: ProposalReview;
  /** Report-led review can gate Keep until citation validation is explicitly valid. */
  keepDisabled?: boolean;
  keepDisabledReason?: string;
  /** Set when this panel was mounted from a post-restart reconstruction. */
  restoredFromRestart?: boolean;
  onDecided?: (review: ProposalReview) => void;
}

/** Full-run review surface. All editable content here remains inside the isolated worktree. */
export function ProposalReviewPanel({ projectId, proposalId, api = defaultProposalApiClient, initialReview, keepDisabled = false, keepDisabledReason, restoredFromRestart = false, onDecided }: ProposalReviewPanelProps) {
  const [review, setReview] = useState<ProposalReview | undefined>(initialReview);
  const [selectedPath, setSelectedPath] = useState(initialReview?.diff.files[0]?.path ?? "");
  const [proposalFile, setProposalFile] = useState<ProposalFile>();
  const [draft, setDraft] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<ProposalDecision>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialReview) return;
    let active = true;
    setBusy("Loading proposal");
    api.getReview(projectId, proposalId)
      .then((next) => {
        if (!active) return;
        setReview(next);
        setSelectedPath(next.diff.files[0]?.path ?? "");
        setError(undefined);
      })
      .catch((reason) => active && setError(describeProposalFailure(reason)))
      .finally(() => active && setBusy(undefined));
    return () => { active = false; };
  }, [api, initialReview, projectId, proposalId]);

  const selected = useMemo(() => review?.diff.files.find((file) => file.path === selectedPath), [review, selectedPath]);
  const canEdit = review?.proposal.status === "pending" && selected?.status !== "deleted";

  async function openEditor(file: ProposalChangedFile) {
    setSelectedPath(file.path);
    setBusy(`Loading ${file.path}`);
    setError(undefined);
    try {
      const next = await api.readFile(projectId, proposalId, file.path);
      setProposalFile(next);
      setDraft(next.content);
    } catch (reason) {
      setError(describeProposalFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function saveEdit() {
    if (!proposalFile) return;
    setBusy(`Saving ${proposalFile.path}`);
    setError(undefined);
    try {
      const next = await api.editFile(projectId, proposalId, proposalFile.path, draft, proposalFile.hash);
      setReview(next);
      const refreshed = await api.readFile(projectId, proposalId, proposalFile.path);
      setProposalFile(refreshed);
      setDraft(refreshed.content);
    } catch (reason) {
      setError(describeProposalFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function decide(decision: ProposalDecision) {
    setBusy(decision === "keep" ? "Keeping whole run" : "Rejecting whole run");
    setError(undefined);
    try {
      const next = await api.decide(projectId, proposalId, decision);
      setReview(next);
      setConfirmDecision(undefined);
      setProposalFile(undefined);
      onDecided?.(next);
    } catch (reason) {
      setError(describeProposalFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  if (!review) {
    return <section className="review-panel" aria-busy={Boolean(busy)}><span className="eyebrow">Isolated proposal</span><h3>Proposal review</h3>{error ? <ErrorNotice message={error} /> : <p>{busy ?? "Proposal unavailable."}</p>}</section>;
  }

  const fileCount = review.diff.files.length;
  const pending = review.proposal.status === "pending";
  return (
    <section className="review-panel" data-testid="proposal-review" aria-busy={Boolean(busy)}>
      <div className="review-panel__heading">
        <div><span className="eyebrow">Isolated proposal</span><h3>Review run {review.proposal.runId}</h3></div>
        <StatusBadge status={review.proposal.status} />
      </div>
      <p className="boundary-notice"><strong>Canonical documents are unchanged.</strong> Edits below affect only this isolated proposal until you keep the whole run.</p>
      <div className="proposal-lineage-context" data-testid="proposal-lineage-context">
        <span><strong>Lineage checkpoint</strong> {review.proposal.checkpoint.sha.slice(0, 12)} · this isolated decision is recorded after Keep or Reject.</span>
        <a href="#lineage-workspace">Inspect research lineage</a>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      {review.proposal.cleanup.status === "failed" ? <ErrorNotice message={`Proposal cleanup failed. ${review.proposal.cleanup.diagnostics ?? "The isolated worktree remains available for recovery."}`} /> : null}

      <div className="proposal-layout">
        <aside className="proposal-files" aria-label="Changed files">
          <h4>{fileCount} changed {fileCount === 1 ? "file" : "files"}</h4>
          <ul>{review.diff.files.map((file) => <li key={`${file.status}:${file.path}`}><button type="button" className={selectedPath === file.path ? "is-selected" : ""} onClick={() => { setSelectedPath(file.path); setProposalFile(undefined); }}><span>{file.path}</span><small>{file.status}</small></button></li>)}</ul>
        </aside>
        <div className="proposal-diff">
          <div className="proposal-diff__heading"><h4>Complete checkpoint diff</h4><code>{review.diff.checkpointSha.slice(0, 12)}</code></div>
          <pre tabIndex={0} aria-label="Complete proposed diff"><code>{review.diff.patch || "No textual diff."}</code></pre>
          {selected && canEdit ? <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={() => void openEditor(selected)}>Edit {selected.path} in proposal</button> : null}
        </div>
      </div>

      {proposalFile ? <div className="proposal-editor"><div className="proposal-editor__heading"><div><span className="eyebrow">Proposal file, not canonical</span><h4>{proposalFile.path}</h4></div><button type="button" className="button-quiet" onClick={() => setProposalFile(undefined)}>Close editor</button></div><textarea aria-label={`Edit isolated proposal file ${proposalFile.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={16} spellCheck={false} /><div className="proposal-editor__actions"><span>{draft === proposalFile.content ? "No unsaved proposal edits" : "Unsaved proposal edit"}</span><button type="button" disabled={Boolean(busy) || draft === proposalFile.content} onClick={() => void saveEdit()}>Save to isolated proposal</button></div></div> : null}

      <div className="decision-panel">
        <div><span className="eyebrow">Whole-run decision</span><h4>This decision applies to all {fileCount} changed {fileCount === 1 ? "file" : "files"}.</h4><p>Partial acceptance is intentionally unavailable.</p>{pending && restoredFromRestart ? <p data-testid="proposal-pending-restored" role="status">This proposal was restored as pending. Choose Keep or Reject explicitly; restart did not apply a decision.</p> : null}</div>
        {pending ? <div className="decision-panel__actions"><button type="button" disabled={Boolean(busy) || keepDisabled} title={keepDisabled ? keepDisabledReason : undefined} onClick={() => setConfirmDecision("keep")}>Keep whole run</button><button type="button" className="button-danger" disabled={Boolean(busy)} onClick={() => setConfirmDecision("reject")}>Reject whole run</button></div> : <p className="decision-outcome">Decision persisted: <strong>{review.proposal.status}</strong>.</p>}
        {pending && keepDisabledReason ? <p className="decision-panel__constraint" role="status">{keepDisabledReason}</p> : null}
      </div>

      {confirmDecision ? <div className="confirmation-panel" role="alertdialog" aria-labelledby="proposal-confirm-title"><h4 id="proposal-confirm-title">Confirm {confirmDecision === "keep" ? "keeping" : "rejection"} of the whole run</h4><p>{confirmDecision === "keep" ? "Margin will apply every proposed change only if canonical files still match the checkpoint. A conflict leaves canonical files untouched." : "Margin will discard the entire isolated proposal. Canonical files remain unchanged."}</p><div><button type="button" disabled={Boolean(busy)} onClick={() => void decide(confirmDecision)}>Confirm {confirmDecision === "keep" ? "keep whole run" : "reject whole run"}</button><button type="button" className="button-quiet" disabled={Boolean(busy)} onClick={() => setConfirmDecision(undefined)}>Cancel</button></div></div> : null}
      {busy ? <p className="operation-status" role="status">{busy}…</p> : null}
    </section>
  );
}

export function describeProposalFailure(reason: unknown): string {
  if (!(reason instanceof ProposalApiError)) return reason instanceof Error ? reason.message : "Proposal operation failed.";
  const suffix = reason.correlationId ? ` Reference: ${reason.correlationId}.` : "";
  if (reason.code === "PROPOSAL_CONFLICT" || reason.status === 409) return `Canonical content changed after this proposal started. It was not overwritten; refresh the proposal before deciding.${suffix}`;
  if (reason.code === "NETWORK_ERROR" || reason.status === 0) return "Margin could not reach the proposal service. The proposal remains isolated; reconnect and retry.";
  if (reason.code === "PROPOSAL_INVALID_STATE") return `This proposal was already decided. Refresh to inspect the persisted outcome.${suffix}`;
  return `${reason.message}${suffix}`;
}

function StatusBadge({ status }: { status: ProposalReview["proposal"]["status"] }) {
  const label = status === "pending" ? "Awaiting decision" : status[0].toUpperCase() + status.slice(1);
  return <span className={`status-badge status-badge--${status}`}>{label}</span>;
}

function ErrorNotice({ message }: { message: string }) {
  return <p className="error-notice" role="alert">{message}</p>;
}
