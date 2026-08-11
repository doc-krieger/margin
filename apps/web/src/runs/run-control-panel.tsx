import { useEffect, useMemo, useRef, useState } from "react";
import type { CommentRecord, RevisionRunRecord, RunStatus } from "@margin/shared";
import {
  defaultProjectApiClient,
  ProjectApiError,
  type PiProfileView,
  type ProjectApiClient,
  type RunEventEnvelope,
} from "../projects/api";

export interface RunControlPanelProps {
  projectId: string;
  client?: ProjectApiClient;
  /** Supply comments directly for fixture-backed browser flows. */
  comments?: CommentRecord[];
  /** Reattach to the newest queued/running run when the workspace opens. */
  resumeLatest?: boolean;
}

const terminalStatuses: RunStatus[] = ["completed", "failed", "cancelled"];

/**
 * Controls a revision proposal without making the canonical editor look dirty.
 * Every changed path shown here belongs to the isolated checkpoint worktree.
 */
export function RunControlPanel({ projectId, client = defaultProjectApiClient, comments: providedComments, resumeLatest = false }: RunControlPanelProps) {
  const [profiles, setProfiles] = useState<PiProfileView[]>([]);
  const [comments, setComments] = useState<CommentRecord[]>(providedComments ?? []);
  const [selectedCommentIds, setSelectedCommentIds] = useState<string[]>([]);
  const [profileId, setProfileId] = useState("");
  const [guidance, setGuidance] = useState("");
  const [run, setRun] = useState<RevisionRunRecord>();
  const [events, setEvents] = useState<RunEventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading Pi profiles…");
  const [connectionStatus, setConnectionStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const streamCleanup = useRef<(() => void) | undefined>(undefined);

  const availableProfiles = useMemo(() => profiles.filter((profile) => profile.status === "available"), [profiles]);
  const selectedComments = useMemo(() => comments.filter((comment) => selectedCommentIds.includes(comment.id)), [comments, selectedCommentIds]);
  const isTerminal = Boolean(run && terminalStatuses.includes(run.status));
  const selectedProfile = profiles.find((profile) => profile.id === profileId);

  function messageFor(reason: unknown): string {
    if (reason instanceof ProjectApiError) return reason.message;
    return reason instanceof Error ? reason.message : "An unexpected revision-run error occurred";
  }

  function updateRunFromEvent(event: RunEventEnvelope): void {
    const nextStatus: Partial<Record<RunEventEnvelope["type"], RunStatus>> = {
      "run.started": "checkpointing",
      "run.completed": "completed",
      "run.failed": "failed",
      "run.cancelled": "cancelled",
    };
    const statusFromEvent = nextStatus[event.type];
    if (!statusFromEvent) return;
    setRun((current) => current && !terminalStatuses.includes(current.status) ? { ...current, status: statusFromEvent } : current);
  }

  function watchRun(runId: string, initialRun?: RevisionRunRecord): void {
    streamCleanup.current?.();
    setRun(initialRun);
    setEvents([]);
    setConnectionStatus("Connecting to live run events…");
    streamCleanup.current = client.subscribeRunEvents(runId, {
      onEvent: (event) => {
        updateRunFromEvent(event);
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event].sort((left, right) => left.sequence - right.sequence));
        setConnectionStatus("Live events connected");
      },
      onError: (reason) => setError(messageFor(reason)),
      onReconnect: () => setConnectionStatus("Connection lost; replaying missed events…"),
      onTerminal: () => {
        setConnectionStatus("Run finished; terminal evidence retained");
        void client.getRun(runId).then(setRun).catch((reason: unknown) => setError(messageFor(reason)));
      },
    });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setStatus("Loading Pi profiles…");
    const commentRequest = providedComments === undefined
      ? client.listComments(projectId, { state: "open" })
      : Promise.resolve(providedComments);
    Promise.all([client.listPiProfiles(), commentRequest]).then(([nextProfiles, nextComments]) => {
      if (cancelled) return;
      setProfiles(nextProfiles);
      setComments(nextComments);
      const firstAvailable = nextProfiles.find((profile) => profile.status === "available");
      setProfileId((current) => current || firstAvailable?.id || nextProfiles[0]?.id || "");
      setStatus(nextProfiles.length ? "Review the selected feedback before starting a proposal" : "Pi profiles unavailable");
      setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(messageFor(reason));
      setStatus("Revision runs unavailable");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, projectId, providedComments]);

  useEffect(() => {
    if (!resumeLatest) return;
    let cancelled = false;
    client.listRuns(projectId).then((runs) => {
      if (cancelled) return;
      const latest = [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (latest) {
        setRun(latest);
        if (!terminalStatuses.includes(latest.status)) watchRun(latest.runId, latest);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(messageFor(reason));
    });
    return () => { cancelled = true; };
  }, [client, projectId, resumeLatest]);

  useEffect(() => () => { streamCleanup.current?.(); }, []);

  function toggleComment(commentId: string): void {
    setSelectedCommentIds((current) => current.includes(commentId) ? current.filter((id) => id !== commentId) : [...current, commentId]);
  }

  async function startRun(): Promise<void> {
    setError(undefined);
    if (!profileId || !selectedProfile || selectedProfile.status !== "available") {
      setError("Choose an available Pi profile before starting a proposal.");
      return;
    }
    if (selectedCommentIds.length === 0) {
      setError("Select at least one open comment to scope this proposal.");
      return;
    }
    setBusy(true);
    setStatus("Starting isolated proposal…");
    try {
      const result = await client.startRun(projectId, { profileId, selectedCommentIds, guidance: guidance.trim() });
      setRun(result.run);
      setStatus("Proposal started in an isolated checkpoint");
      watchRun(result.runId, result.run);
    } catch (reason) {
      setError(messageFor(reason));
      setStatus("Unable to start proposal");
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(): Promise<void> {
    if (!run || isTerminal) return;
    setBusy(true);
    setError(undefined);
    setStatus("Cancelling proposal and cleaning up checkpoint…");
    try {
      const result = await client.cancelRun(run.runId);
      setRun(result);
      setStatus("Proposal cancelled; canonical files remain unchanged");
    } catch (reason) {
      setError(messageFor(reason));
      setStatus("Unable to cancel proposal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="run-panel" data-testid="run-panel" aria-labelledby="run-panel-title">
      <div className="run-panel__heading">
        <div><span className="eyebrow">Isolated proposal</span><h2 id="run-panel-title">Revision runs</h2></div>
        {run && <span className={`run-panel__status-badge run-panel__status-badge--${run.status}`} data-testid="run-status">{run.status}</span>}
      </div>
      <p className="run-panel__description">Pi works from a checkpoint worktree. Changed paths become a proposal; canonical files are never changed by this control.</p>

      {loading && <p className="run-panel__status" data-testid="run-loading" role="status">{status}</p>}
      {!loading && <>
        <div className="run-panel__setup">
          <label>Pi profile
            <select aria-label="Pi profile" data-testid="run-profile-select" value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={busy || Boolean(run && !isTerminal)}>
              {profiles.length === 0 && <option value="">No profiles discovered</option>}
              {profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.status !== "available"}>{profile.label ?? profile.id}{profile.status === "unavailable" ? " · unavailable" : ""}</option>)}
            </select>
          </label>
          <div className="run-panel__profile-state" data-testid="run-profile-state" role="status">
            {selectedProfile?.status === "unavailable" ? <><strong>Pi unavailable.</strong> {selectedProfile.message ?? "This profile cannot start a run."}{selectedProfile.diagnostics && <pre>{selectedProfile.diagnostics}</pre>}</> : availableProfiles.length === 0 ? <><strong>Pi unavailable.</strong> No executable profile is ready. Check the server preflight diagnostics.</> : selectedProfile?.message ?? "Profile ready"}
          </div>
        </div>

        <fieldset className="run-panel__comments">
          <legend>Feedback to include</legend>
          {comments.length === 0 && <p className="run-panel__empty">No open comments are available. Add feedback beside a document first.</p>}
          {comments.map((comment) => <label key={comment.id} className="run-panel__comment-option">
            <input type="checkbox" data-testid={`run-comment-option-${comment.id}`} checked={selectedCommentIds.includes(comment.id)} onChange={() => toggleComment(comment.id)} disabled={busy || Boolean(run && !isTerminal)} />
            <span><strong>{comment.documentPath ?? "Project guidance"}</strong><span>{comment.body}</span></span>
          </label>)}
        </fieldset>

        <label>Instruction review
          <textarea aria-label="Revision guidance" data-testid="run-instructions" value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional guidance for this proposal…" rows={3} disabled={busy || Boolean(run && !isTerminal)} />
        </label>
        <div className="run-panel__selected" data-testid="run-selection-summary" aria-live="polite">{selectedComments.length} comment{selectedComments.length === 1 ? "" : "s"} selected{guidance.trim() ? " · guidance added" : ""}</div>
        {error && <p className="run-panel__error" role="alert" data-testid="run-error">{error}</p>}
        <p className="run-panel__status" role="status" aria-live="polite" data-testid="run-control-status">{status}</p>
        <div className="run-panel__actions">
          <button type="button" data-testid="start-run" onClick={startRun} disabled={busy || Boolean(run && !isTerminal) || availableProfiles.length === 0}>{busy ? "Working…" : "Start proposal"}</button>
          {run && !isTerminal && <button type="button" data-testid="cancel-run" onClick={cancelRun} disabled={busy}>Cancel proposal</button>}
        </div>
      </>}

      {run && <RunTerminalSummary run={run} events={events} connectionStatus={connectionStatus} />}
    </section>
  );
}

function RunTerminalSummary({ run, events, connectionStatus }: { run: RevisionRunRecord; events: RunEventEnvelope[]; connectionStatus?: string }) {
  return <section className="run-panel__monitor" aria-labelledby="run-monitor-title" data-testid="run-monitor">
    <div className="run-panel__monitor-heading"><h3 id="run-monitor-title">Run {run.runId}</h3><span>{connectionStatus}</span></div>
    <p className="run-panel__monitor-meta">{run.status === "completed" ? "Proposal ready for review" : run.status === "failed" ? "Proposal failed" : run.status === "cancelled" ? "Proposal cancelled" : "Proposal is running"}{run.durationMs !== null ? ` · ${formatDuration(run.durationMs)}` : ""}</p>
    <p className="run-panel__safety" data-testid="canonical-safety-note"><strong>Canonical safety:</strong> this run did not apply changes to the open workspace. The paths below are isolated proposal output.</p>
    {run.changedFiles.length > 0 && <div data-testid="run-changed-files"><h4>Changed paths</h4><ul>{run.changedFiles.map((file) => <li key={`${file.status}-${file.path}`}><code>{file.path}</code> <span>{file.status}</span></li>)}</ul></div>}
    {run.changedFiles.length === 0 && terminalStatuses.includes(run.status) && <p className="run-panel__empty">No changed paths were produced in the isolated worktree.</p>}
    {run.cleanup.status !== "pending" && <p className={run.cleanup.status === "failed" ? "run-panel__cleanup run-panel__cleanup--failed" : "run-panel__cleanup"} data-testid="run-cleanup">Checkpoint cleanup: {run.cleanup.status}{run.cleanup.diagnostics ? ` · ${run.cleanup.diagnostics}` : ""}</p>}
    {(run.status === "failed" || run.status === "cancelled") && (run.errorCode || run.diagnostics) && <div className="run-panel__diagnostics" data-testid="run-diagnostics" role="alert"><h4>{run.status === "failed" ? "Actionable diagnostics" : "Cancellation details"}</h4>{run.errorCode && <p><strong>{run.errorCode}</strong></p>}{run.diagnostics && <pre>{run.diagnostics}</pre>}</div>}
    {events.length > 0 && <div className="run-panel__events" data-testid="run-events"><h4>Live lifecycle</h4><ol>{events.map((event) => <li key={event.sequence}><span>{event.type}</span><small>#{event.sequence}</small>{event.payload && <code>{compactPayload(event.payload)}</code>}</li>)}</ol></div>}
  </section>;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function compactPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

export { RunControlPanel as RevisionRunPanel };
