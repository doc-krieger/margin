import { useEffect, useMemo, useState } from "react";
import type {
  ResearchBrief,
  ResearchRunRecord,
  ResearchRunStatus,
  ResearchStageRecord,
} from "@margin/shared";
import {
  defaultResearchApiClient,
  ResearchApiError,
  type ResearchApiClient,
  type ResearchEventEnvelope,
  type ResearchProfileView,
} from "./api";

export interface RunProgressPanelProps {
  projectId: string;
  api?: ResearchApiClient;
  brief?: ResearchBrief;
  initialRun?: ResearchRunRecord;
  initialRuns?: ResearchRunRecord[];
  onRunChanged?: (run: ResearchRunRecord) => void;
}

const activeStatuses: ResearchRunStatus[] = ["queued", "running", "cancelling"];
const terminalStatuses: ResearchRunStatus[] = ["cancelled", "failed", "partial", "completed"];
const maxDisplayedEvents = 500;

function isActive(status: ResearchRunStatus): boolean {
  return activeStatuses.includes(status);
}

function isTerminal(status: ResearchRunStatus): boolean {
  return terminalStatuses.includes(status);
}

function sortRuns(runs: ResearchRunRecord[]): ResearchRunRecord[] {
  return [...runs].sort((left, right) => {
    const leftTime = left.lastEventAt ?? left.createdAt;
    const rightTime = right.lastEventAt ?? right.createdAt;
    return rightTime.localeCompare(leftTime);
  });
}

function latestStage(run: ResearchRunRecord): ResearchStageRecord[] {
  return [...run.stageHistory, run.currentStage];
}

function eventSummary(event: ResearchEventEnvelope): string {
  const payload = event.payload;
  if (event.type === "research.stage") return `${String(payload.stage ?? "stage")} · ${String(payload.status ?? "updated")}`;
  if (event.type === "research.capability") return "Capability preflight recorded";
  if (event.type === "research.artifact") return `${String(payload.kind ?? "artifact")} artifact recorded`;
  if (event.type === "research.diagnostic") return `${String(payload.code ?? "diagnostic")}: ${String(payload.message ?? "Research diagnostic")}`;
  if (event.type === "research.progress") return `${String(payload.stage ?? "Research process")} progress`;
  if (event.type === "research.completed") return `Research ${String(payload.status ?? "completed")}`;
  if (event.type === "research.failed") return `Research failed: ${String(payload.code ?? "unknown error")}`;
  if (event.type === "research.cancelled") return `Research cancelled: ${String(payload.reason ?? "cancelled")}`;
  return "Research run started";
}

function messageFor(reason: unknown): string {
  if (reason instanceof ResearchApiError) {
    if (reason.code === "RESEARCH_CAPABILITY_UNAVAILABLE") return "The selected Pi profile cannot satisfy this research run. No executor was started.";
    if (reason.code === "RESEARCH_CONNECTION_FAILED") return "Research service is unavailable. Reconnect to inspect the durable run state.";
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "An unexpected research run error occurred";
}

function capabilityReady(profile: ResearchProfileView | undefined, snapshot: ResearchRunRecord["capabilities"]): boolean {
  return Boolean(profile && profile.status === "available" && snapshot?.executable.status === "available" && snapshot.rpc.status === "available" && snapshot.results.every((result) => result.status !== "unavailable"));
}

function statusLabel(run: ResearchRunRecord | undefined, connecting: string): string {
  if (!run) return connecting;
  if (run.status === "completed") return "Report proposal ready for review";
  if (run.status === "partial") return "Run completed with degraded evidence";
  if (run.status === "failed") return "Run failed before producing a complete result";
  if (run.status === "cancelled") return "Cancellation settled";
  if (run.status === "cancelling") return "Cancellation requested…";
  return run.currentStage.status === "running" ? `Researching · ${run.currentStage.stage}` : "Research run queued";
}

/** Displays durable run state while using replayable SSE only as a reconnectable activity projection. */
export function RunProgressPanel({ projectId, api = defaultResearchApiClient, brief, initialRun, initialRuns, onRunChanged }: RunProgressPanelProps) {
  const [profiles, setProfiles] = useState<ResearchProfileView[]>([]);
  const [runs, setRuns] = useState<ResearchRunRecord[]>(initialRuns ?? (initialRun ? [initialRun] : []));
  const [run, setRun] = useState<ResearchRunRecord | undefined>(initialRun ?? sortRuns(initialRuns ?? [])[0]);
  const [selectedProfileId, setSelectedProfileId] = useState(initialRun?.profileId ?? "default");
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<ResearchRunRecord["capabilities"]>(initialRun?.capabilities ?? null);
  const [events, setEvents] = useState<ResearchEventEnvelope[]>([]);
  const [connectionState, setConnectionState] = useState("Waiting for a confirmed brief");
  const [latestActivity, setLatestActivity] = useState("No research activity captured yet");
  const [lastReconnectAt, setLastReconnectAt] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!initialRuns && !initialRun);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (initialRuns || initialRun) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.listProfiles(), api.listRuns(projectId)]).then(([loadedProfiles, loadedRuns]) => {
      if (cancelled) return;
      const orderedRuns = sortRuns(loadedRuns);
      const current = orderedRuns[0];
      setProfiles(loadedProfiles);
      setRuns(orderedRuns);
      setRun(current);
      setSelectedProfileId(current?.profileId ?? loadedProfiles.find((profile) => profile.status === "available")?.id ?? loadedProfiles[0]?.id ?? "default");
      setCapabilitySnapshot(current?.capabilities ?? null);
      setConnectionState(current ? (isActive(current.status) ? "Reconnecting to durable run…" : "Run state loaded") : "Ready for a confirmed brief");
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setError(messageFor(reason));
        setConnectionState("Unable to load research state");
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, initialRun, initialRuns, projectId]);

  useEffect(() => {
    if (profiles.length === 0) return;
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    if (!selected || selected.status !== "available" || (run && isActive(run.status))) return;
    let cancelled = false;
    setConnectionState("Checking Pi profile capabilities…");
    api.checkCapabilities(selected.id).then((snapshot) => {
      if (!cancelled) {
        setCapabilitySnapshot(snapshot);
        setConnectionState(capabilityReady(selected, snapshot) ? "Pi profile ready" : "Pi profile capability gate needs attention");
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setCapabilitySnapshot(null);
        setError(messageFor(reason));
        setConnectionState("Capability preflight failed");
      }
    });
    return () => { cancelled = true; };
  }, [api, profiles, run, selectedProfileId]);

  useEffect(() => {
    if (!run?.runId) return;
    let cancelled = false;
    setEvents([]);
    setConnectionState(isActive(run.status) ? "Connecting to durable run events…" : "Replaying durable run events…");
    const unsubscribe = api.subscribeRunEvents(run.runId, {
      onEvent: (event) => {
        if (cancelled) return;
        setEvents((current) => {
          if (current.some((candidate) => candidate.sequence === event.sequence)) return current;
          return [...current, event].sort((left, right) => left.sequence - right.sequence).slice(-maxDisplayedEvents);
        });
        setLatestActivity(eventSummary(event));
        setConnectionState("Connected to durable run events");
      },
      onError: (reason) => { if (!cancelled) setError(messageFor(reason)); },
      onReconnect: () => {
        if (!cancelled) {
          setLastReconnectAt(new Date().toISOString());
          setConnectionState("Reconnecting; replaying missed events…");
        }
      },
      onTerminal: () => { if (!cancelled) setConnectionState("Terminal event received; durable state retained"); },
    }, -1);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, run?.runId]);

  useEffect(() => {
    if (!run) return;
    onRunChanged?.(run);
  }, [onRunChanged, run]);

  const effectiveBrief = brief ?? run?.brief;
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const canStart = Boolean(effectiveBrief?.status === "confirmed" && selectedProfile?.status === "available" && capabilityReady(selectedProfile, capabilitySnapshot) && !run || (effectiveBrief?.status === "confirmed" && selectedProfile?.status === "available" && capabilityReady(selectedProfile, capabilitySnapshot) && run && isTerminal(run.status)));
  const currentAttempt = run?.synthesisAttempts.find((attempt) => attempt.attemptId === run.latestSynthesisAttemptId);
  const sourceProjection = run?.sourceProjection;
  const status = statusLabel(run, connectionState);

  async function refreshRun(runId: string) {
    try {
      const fresh = await api.getRun(runId);
      setRun(fresh);
      setRuns((current) => sortRuns([...current.filter((candidate) => candidate.runId !== fresh.runId), fresh]));
      setCapabilitySnapshot(fresh.capabilities);
    } catch (reason) {
      setError(messageFor(reason));
    }
  }

  async function start() {
    if (!effectiveBrief || effectiveBrief.status !== "confirmed" || !selectedProfile) {
      setError("Confirm a bounded brief and choose an available Pi profile before starting research.");
      return;
    }
    setStarting(true);
    setError(undefined);
    setConnectionState("Checking capability gate before allocation…");
    try {
      const snapshot = await api.checkCapabilities(selectedProfile.id);
      setCapabilitySnapshot(snapshot);
      if (!capabilityReady(selectedProfile, snapshot)) {
        setConnectionState("Capability gate blocked the run");
        setError("The selected Pi profile is not ready for Standard research. Review the bounded capability diagnostics below.");
        return;
      }
      const response = await api.startRun(projectId, { briefId: effectiveBrief.briefId, profileId: selectedProfile.id });
      setRun(response.run);
      setRuns((current) => sortRuns([...current.filter((candidate) => candidate.runId !== response.run.runId), response.run]));
      setEvents([]);
      setLatestActivity("Research run allocated");
      setConnectionState("Run allocated; waiting for lifecycle events…");
    } catch (reason) {
      setError(messageFor(reason));
      setConnectionState("Research start failed");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!run || !isActive(run.status)) return;
    setCancelling(true);
    setError(undefined);
    setConnectionState("Settling cancellation…");
    try {
      await api.cancelRun(run.runId);
      await refreshRun(run.runId);
    } catch (reason) {
      setError(messageFor(reason));
      setConnectionState("Cancellation failed");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="research-progress-panel" data-testid="research-progress-panel" aria-labelledby="research-progress-title">
      <div className="research-panel__heading">
        <div>
          <span className="eyebrow">Research run</span>
          <h2 id="research-progress-title">Reconnectable Standard research</h2>
        </div>
        {run && <span className={`research-status-badge research-status-badge--${run.status}`}>{run.status}</span>}
      </div>
      <p className="research-panel__description">Run state is read from durable records. The activity timeline reconnects from the last stored sequence after a refresh or dropped connection.</p>
      <div className="research-run__controls">
        <label>Pi profile
          <select aria-label="Research Pi profile" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)} disabled={starting || Boolean(run && isActive(run.status))}>
            {profiles.length === 0 && <option value="default">Default Pi profile</option>}
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label ?? profile.id}{profile.status === "unavailable" ? " · unavailable" : ""}</option>)}
          </select>
        </label>
        <div className="research-run__actions">
          <button type="button" disabled={!canStart || starting} onClick={start}>{starting ? "Preparing…" : "Start Standard research"}</button>
          <button type="button" className="button-secondary" disabled={!run || !isActive(run.status) || cancelling} onClick={cancel}>{cancelling ? "Cancelling…" : "Cancel run"}</button>
        </div>
      </div>
      {loading && <p className="research-panel__status" role="status">Loading saved research runs…</p>}
      {!loading && !run && <p className="research-run__empty">No research run yet. Confirm the brief above to unlock the capability-gated Standard run.</p>}
      {capabilitySnapshot && <div className="research-capability-card" data-testid="research-capability-state">
        <div className="research-panel__subheading"><strong>Capability gate</strong><span>{capabilityReady(selectedProfile, capabilitySnapshot) ? "Ready" : "Blocked or degraded"}</span></div>
        <div className="research-capability-card__facts"><span>Executable: <b>{capabilitySnapshot.executable.status}</b></span><span>RPC: <b>{capabilitySnapshot.rpc.status}</b></span><span>Checked: <time dateTime={capabilitySnapshot.checkedAt}>{new Date(capabilitySnapshot.checkedAt).toLocaleString()}</time></span></div>
        {capabilitySnapshot.results.length > 0 && <ul>{capabilitySnapshot.results.map((result) => <li key={result.id}><code>{result.id}</code><span>{result.status}</span>{result.diagnostics && <small>{result.diagnostics}</small>}</li>)}</ul>}
        {(capabilitySnapshot.executable.diagnostics || capabilitySnapshot.rpc.diagnostics) && <p className="research-panel__error">{capabilitySnapshot.executable.diagnostics ?? capabilitySnapshot.rpc.diagnostics}</p>}
      </div>}
      {run && <>
        <div className="research-run__status" role="status" aria-live="polite"><strong>{status}</strong><span>{latestActivity}</span></div>
        <div className="research-run__facts">
          <div><dt>Run ID</dt><dd><code>{run.runId}</code></dd></div>
          <div><dt>Brief revision</dt><dd>{run.brief.confirmedRevision ?? run.brief.revision}</dd></div>
          <div><dt>Last event</dt><dd>{run.lastEventAt ? <time dateTime={run.lastEventAt}>{new Date(run.lastEventAt).toLocaleString()}</time> : "Not recorded"}</dd></div>
          <div><dt>Elapsed</dt><dd>{run.durationMs === null ? "In progress" : `${Math.round(run.durationMs / 1000)}s`}</dd></div>
          <div><dt>Session</dt><dd><code>{run.session.sessionId ?? "not assigned"}</code> · {run.session.eventCount} events · {run.session.commandCount} commands</dd></div>
          <div><dt>Reconnect</dt><dd>{lastReconnectAt ? <time dateTime={lastReconnectAt}>{new Date(lastReconnectAt).toLocaleString()}</time> : "No reconnect needed"}</dd></div>
        </div>
        <div className="research-stage-timeline" aria-label="Research stage timeline">
          <h3>Stage timeline</h3>
          <ol>{latestStage(run).map((stage, index) => <li key={`${stage.stage}-${index}`} className={`research-stage research-stage--${stage.status}`}><span className="research-stage__marker" aria-hidden="true" /><div><strong>{stage.stage}</strong><span>{stage.status}</span>{stage.diagnostics && <small>{stage.diagnostics}</small>}</div></li>)}</ol>
        </div>
        <div className="research-run__evidence-grid">
          <section aria-labelledby="research-source-evidence-title"><h3 id="research-source-evidence-title">Source evidence</h3><p>{sourceProjection ? `${sourceProjection.entries.length} exact source version${sourceProjection.entries.length === 1 ? "" : "s"} frozen` : `${run.sourceSelections.length} source selection${run.sourceSelections.length === 1 ? "" : "s"} requested`}</p>{sourceProjection && <p className={sourceProjection.status === "partial" ? "research-panel__error" : "research-panel__success"}>{sourceProjection.status === "partial" ? `${sourceProjection.missing.length} source version${sourceProjection.missing.length === 1 ? "" : "s"} unavailable` : "Projection ready"}</p>}{run.frozenSourceBindings.length > 0 && <ul className="research-compact-list">{run.frozenSourceBindings.map((binding) => <li key={`${binding.sourceId}-${binding.versionId}`}><code>{binding.citationKey ?? "citation pending"}</code><span>{binding.sourceId} · {binding.versionId}</span></li>)}</ul>}</section>
          <section aria-labelledby="research-synthesis-title"><h3 id="research-synthesis-title">Synthesis lineage</h3>{currentAttempt ? <><p><strong>{currentAttempt.status}</strong> · attempt <code>{currentAttempt.attemptId}</code></p><p>Parent: {currentAttempt.parentAttemptId ? <code>{currentAttempt.parentAttemptId}</code> : "initial attempt"}</p>{currentAttempt.citationValidation && <p className={currentAttempt.citationValidation.status === "valid" ? "research-panel__success" : "research-panel__error"}>Citations: {currentAttempt.citationValidation.status} · {currentAttempt.citationValidation.usages.length} usage locations{currentAttempt.citationValidation.unresolvedKeys.length ? ` · ${currentAttempt.citationValidation.unresolvedKeys.length} unresolved` : ""}</p>}</> : <p>No synthesis attempt recorded yet.</p>}</section>
          <section aria-labelledby="research-artifacts-title"><h3 id="research-artifacts-title">Captured artifacts</h3>{run.artifacts.length > 0 ? <ul className="research-compact-list">{run.artifacts.map((artifact) => <li key={artifact.artifactId}><span>{artifact.label || artifact.kind}</span><code>{artifact.relativePath}</code></li>)}</ul> : <p>No artifacts captured yet.</p>}</section>
        </div>
        {run.cancellation.requested && <p className="research-panel__warning" data-testid="research-cancellation">Cancellation requested{run.cancellation.settledAt ? ` · settled ${new Date(run.cancellation.settledAt).toLocaleString()}` : ""}: {run.cancellation.reason}</p>}
        {run.diagnostics && <div className="research-run__diagnostics" role="alert"><strong>{run.diagnostics.code}</strong><p>{run.diagnostics.message}</p>{run.diagnostics.protocol && <pre>{run.diagnostics.protocol}</pre>}</div>}
        <div className="research-run__events"><div className="research-panel__subheading"><h3>Activity timeline</h3><span>{events.length} replayed event{events.length === 1 ? "" : "s"}</span></div>{events.length > 0 ? <ol>{events.map((event) => <li key={event.sequence}><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time><code>{event.type}</code><span>{eventSummary(event)}</span></li>)}</ol> : <p>No events received yet; the monitor will reconnect automatically.</p>}</div>
      </>}
      {error && <p className="research-panel__error" role="alert">{error}</p>}
    </section>
  );
}
