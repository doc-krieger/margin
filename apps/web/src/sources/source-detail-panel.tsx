import { useEffect, useMemo, useState } from "react";
import type { CaptureAttempt, SourceRecord } from "@margin/shared";
import { defaultSourceApiClient, describeSourceFailure, type SourceApiClient } from "./api";

export interface SourceDetailPanelProps {
  projectId: string;
  sourceId?: string;
  /** Optional exact version selected from a research citation binding. */
  focusVersionId?: string;
  api?: SourceApiClient;
  initialSource?: SourceRecord;
  onSourceUpdated?: (source: SourceRecord) => void;
}

/** Displays durable source provenance without exposing canonical file paths or evidence bytes. */
export function SourceDetailPanel({ projectId, sourceId, focusVersionId, api = defaultSourceApiClient, initialSource, onSourceUpdated }: SourceDetailPanelProps) {
  const [source, setSource] = useState<SourceRecord | undefined>(initialSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  const activeAttempt = useMemo(() => source?.attempts.find((attempt) => attempt.attemptId === source.lastAttemptId && (attempt.status === "queued" || attempt.status === "capturing")), [source]);

  useEffect(() => {
    if (!sourceId) {
      setSource(undefined);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const next = await api.getSource(projectId, sourceId);
        if (!active) return;
        setSource(next);
        onSourceUpdated?.(next);
        setError(undefined);
      } catch (reason) {
        if (active) setError(describeSourceFailure(reason));
      }
    };
    if (!initialSource || initialSource.sourceId !== sourceId) void load();
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, initialSource, onSourceUpdated, projectId, sourceId]);

  async function retry(): Promise<void> {
    if (!source) return;
    setBusy(true);
    setError(undefined);
    setStatus("Retrying capture…");
    try {
      const result = await api.retry(projectId, source.sourceId, { origin: "ui" });
      setSource(result.source);
      onSourceUpdated?.(result.source);
      setStatus(result.status === "reused" ? "Retry reused the existing immutable version" : `Retry settled as ${result.status}`);
    } catch (reason) {
      setError(describeSourceFailure(reason));
      setStatus("Retry failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!source || !activeAttempt) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.cancel(projectId, source.sourceId, activeAttempt.attemptId, "Cancelled from source detail");
      setSource(next);
      onSourceUpdated?.(next);
      setStatus("Capture cancelled; canonical source storage is unchanged");
    } catch (reason) {
      setError(describeSourceFailure(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!source) {
    return <section className="source-detail-panel" data-testid="source-detail-panel" aria-labelledby="source-detail-title"><span className="eyebrow">Source detail</span><h3 id="source-detail-title">Choose a captured source</h3><p className="source-panel__empty">Select a source record to inspect its state, attempts, and exact evidence versions.</p></section>;
  }

  const selectedVersion = focusVersionId ? source.versions.find((version) => version.versionId === focusVersionId) : undefined;
  const latest = selectedVersion ?? (source.latestVersionId ? source.versions.find((version) => version.versionId === source.latestVersionId) : undefined);
  return (
    <section className="source-detail-panel" data-testid="source-detail-panel" aria-labelledby="source-detail-title" aria-busy={busy}>
      <div className="source-panel__heading"><div><span className="eyebrow">Source detail</span><h3 id="source-detail-title">{source.effectiveMetadata.title ?? safeSourceLabel(source)}</h3></div><span className={`status-badge status-badge--${source.evidenceState}`}>{source.evidenceState}</span></div>
      <p className="boundary-notice"><strong>Evidence boundary:</strong> exact bytes remain in canonical source storage. Research worktrees receive verified copies, never writable links.</p>
      <dl className="source-detail__facts">
        <div><dt>Kind</dt><dd>{source.kind === "url" ? "Public URL" : "Project-local file"}</dd></div>
        <div><dt>Identity</dt><dd><code>{safeSourceLabel(source)}</code></dd></div>
        <div><dt>Source ID</dt><dd><code>{source.sourceId}</code></dd></div>
        <div><dt>Captured metadata</dt><dd>{metadataSummary(source)}</dd></div>
        <div><dt>Updated</dt><dd><time dateTime={source.updatedAt}>{formatDate(source.updatedAt)}</time></dd></div>
      </dl>
      {latest ? <section className="source-version" aria-labelledby="latest-evidence-title"><div className="source-version__heading"><h4 id="latest-evidence-title">{selectedVersion ? "Selected immutable evidence" : "Latest immutable evidence"}</h4><span>{latest.mediaType}</span></div><p><strong>Version:</strong> <code>{latest.versionId}</code></p><p><strong>SHA-256:</strong> <code className="source-checksum">{latest.checksum}</code></p><p><strong>Size:</strong> {formatBytes(latest.byteLength)} · captured {formatDate(latest.capturedAt)}</p>{latest.finalUrl && <p><strong>Final URL:</strong> <code>{latest.finalUrl}</code></p>}</section> : <p className="source-panel__empty">No complete evidence version is published for this source.</p>}
      {source.versions.length > 0 && <section className="source-history" aria-labelledby="source-versions-title"><h4 id="source-versions-title">Evidence history</h4><ul>{[...source.versions].reverse().map((version) => <li key={version.versionId}><code>{version.versionId}</code><span>{version.checksum.slice(0, 16)}… · {formatBytes(version.byteLength)}</span><small>{version.versionId === focusVersionId ? "selected for citation" : version.versionId === source.latestVersionId ? "latest" : "immutable prior version"}</small></li>)}</ul></section>}
      <section className="source-attempts" aria-labelledby="source-attempts-title"><div className="source-version__heading"><h4 id="source-attempts-title">Capture attempts</h4><span>{source.attempts.length}</span></div><ol>{[...source.attempts].reverse().slice(0, 20).map((attempt) => <li key={attempt.attemptId}><span><code>{attempt.attemptId}</code><small>{attempt.origin} · {attempt.status}</small></span>{attempt.diagnostic && <p role="alert">{attempt.diagnostic.code}: {attempt.diagnostic.message}</p>}{attempt.completedAt && <time dateTime={attempt.completedAt}>{formatDate(attempt.completedAt)}</time>}</li>)}</ol></section>
      {status && <p className="operation-status" role="status">{status}</p>}
      {error && <p className="error-notice" role="alert">{error}</p>}
      <div className="source-detail__actions"><button type="button" onClick={() => void retry()} disabled={busy || Boolean(activeAttempt)}>Retry capture</button>{activeAttempt && <button type="button" className="button-danger" onClick={() => void cancel()} disabled={busy}>Cancel capture</button>}</div>
    </section>
  );
}

function safeSourceLabel(source: SourceRecord): string {
  return source.kind === "file" ? source.identity.replace(/^file:/, "") : source.identity;
}

function metadataSummary(source: SourceRecord): string {
  const fields = [source.effectiveMetadata.author, source.effectiveMetadata.issued, source.effectiveMetadata.publisher].filter(Boolean);
  return fields.length > 0 ? fields.join(" · ") : "No additional CSL metadata";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
