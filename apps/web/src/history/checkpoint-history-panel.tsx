import { useEffect, useState } from "react";
import type { ProposalDiff } from "../proposals/api";
import {
  CheckpointHistoryApiError,
  defaultCheckpointHistoryApiClient,
  type CheckpointHistoryApiClient,
  type CheckpointHistoryEntry,
} from "./api";

export interface CheckpointHistoryPanelProps {
  projectId: string;
  api?: CheckpointHistoryApiClient;
  initialCheckpoints?: CheckpointHistoryEntry[];
}

/** Recovery UI that previews a checkpoint before creating a new, auditable restore checkpoint. */
export function CheckpointHistoryPanel({ projectId, api = defaultCheckpointHistoryApiClient, initialCheckpoints }: CheckpointHistoryPanelProps) {
  const [checkpoints, setCheckpoints] = useState(initialCheckpoints ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<CheckpointHistoryEntry>();
  const [diff, setDiff] = useState<ProposalDiff>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialCheckpoints) return;
    let active = true;
    setBusy("Loading checkpoint history");
    api.list(projectId)
      .then((page) => { if (active) { setCheckpoints(page.checkpoints); setNextCursor(page.nextCursor); setError(undefined); } })
      .catch((reason) => active && setError(describeHistoryFailure(reason)))
      .finally(() => active && setBusy(undefined));
    return () => { active = false; };
  }, [api, initialCheckpoints, projectId]);

  async function preview(checkpoint: CheckpointHistoryEntry) {
    setSelected(checkpoint);
    setConfirming(false);
    setMessage(undefined);
    setError(undefined);
    setBusy(`Loading diff for ${checkpoint.sha.slice(0, 12)}`);
    try {
      setDiff(await api.diff(projectId, checkpoint.sha));
    } catch (reason) {
      setDiff(undefined);
      setError(describeHistoryFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function loadOlder() {
    if (!nextCursor) return;
    setBusy("Loading older checkpoints");
    try {
      const page = await api.list(projectId, { cursor: nextCursor });
      setCheckpoints((current) => [...current, ...page.checkpoints]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(describeHistoryFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function restore() {
    if (!selected || !confirming) return;
    setBusy(`Restoring ${selected.sha.slice(0, 12)}`);
    setError(undefined);
    try {
      const result = await api.restore(projectId, selected.sha, true);
      setMessage(`Restored ${result.restoredFiles.length} ${result.restoredFiles.length === 1 ? "file" : "files"}. Recovery checkpoint ${result.checkpoint.sha.slice(0, 12)} was recorded.`);
      setConfirming(false);
      setSelected(undefined);
      setDiff(undefined);
      setCheckpoints((current) => [result.checkpoint, ...current.filter((item) => item.sha !== result.checkpoint.sha)]);
    } catch (reason) {
      setError(describeHistoryFailure(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="history-panel" data-testid="checkpoint-history" aria-busy={Boolean(busy)}>
      <div className="history-panel__heading"><div><span className="eyebrow">Recovery</span><h3>Checkpoint history</h3></div><span className="history-count">{checkpoints.length} loaded</span></div>
      <p className="boundary-notice"><strong>Restore creates a new recovery checkpoint.</strong> Never rewrites checkpoint history. Restore requires confirmation after a diff preview.</p>
      {error ? <p className="error-notice" role="alert">{error}</p> : null}
      {message ? <p className="success-notice" role="status">{message}</p> : null}
      {busy ? <p className="operation-status" role="status">{busy}…</p> : null}

      {checkpoints.length ? <ol className="checkpoint-list">{checkpoints.map((checkpoint) => <li key={checkpoint.sha}><div className="checkpoint-card"><div><div className="checkpoint-card__meta"><code>{checkpoint.sha.slice(0, 12)}</code><span className={`status-badge status-badge--${checkpoint.outcome}`}>{labelOutcome(checkpoint.outcome)}</span></div><strong>Run {checkpoint.runId}</strong><time dateTime={checkpoint.createdAt}>{formatTimestamp(checkpoint.createdAt)}</time></div><ul aria-label={`Files changed at ${checkpoint.sha}`}>{checkpoint.changedFiles.map((file) => <li key={`${file.status}:${file.path}`}><span>{file.path}</span><small>{file.status}</small></li>)}</ul><button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={() => void preview(checkpoint)}>Preview restore</button></div></li>)}</ol> : !busy ? <p>No checkpoints have been recorded for this project.</p> : null}
      {nextCursor ? <button type="button" className="button-quiet" disabled={Boolean(busy)} onClick={() => void loadOlder()}>Load older checkpoints</button> : null}

      {selected ? <div className="restore-panel"><div className="restore-panel__heading"><div><span className="eyebrow">Restore preview</span><h4>{selected.sha.slice(0, 12)} from run {selected.runId}</h4></div><button type="button" className="button-quiet" onClick={() => { setSelected(undefined); setDiff(undefined); setConfirming(false); }}>Close preview</button></div>{diff ? <><p>{diff.files.length} {diff.files.length === 1 ? "file differs" : "files differ"} from the selected checkpoint.</p><pre tabIndex={0} aria-label="Checkpoint restore diff"><code>{diff.patch || "No textual diff."}</code></pre><button type="button" className="button-danger" disabled={Boolean(busy)} onClick={() => setConfirming(true)}>Continue to restore confirmation</button></> : busy ? null : <p>Diff preview unavailable.</p>}</div> : null}

      {selected && confirming ? <div className="confirmation-panel" role="alertdialog" aria-labelledby="restore-confirm-title"><h4 id="restore-confirm-title">Confirm restore from {selected.sha.slice(0, 12)}</h4><p>This writes the selected document state as a new canonical change and records a recovery checkpoint first. Existing history remains intact.</p><div><button type="button" className="button-danger" disabled={Boolean(busy)} onClick={() => void restore()}>Confirm safe restore</button><button type="button" className="button-quiet" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>Cancel</button></div></div> : null}
    </section>
  );
}

export function describeHistoryFailure(reason: unknown): string {
  if (!(reason instanceof CheckpointHistoryApiError)) return reason instanceof Error ? reason.message : "Checkpoint operation failed.";
  const suffix = reason.correlationId ? ` Reference: ${reason.correlationId}.` : "";
  if (reason.code === "RESTORE_CONFLICT" || reason.status === 409) return `Restore stopped because canonical documents changed. Nothing was overwritten.${suffix}`;
  if (reason.code === "NETWORK_ERROR" || reason.status === 0) return "Margin could not reach checkpoint history. No restore was attempted; reconnect and retry.";
  return `${reason.message}${suffix}`;
}

function labelOutcome(outcome: CheckpointHistoryEntry["outcome"]): string {
  return outcome[0].toUpperCase() + outcome.slice(1);
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}
