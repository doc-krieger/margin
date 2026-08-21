import { useEffect, useMemo, useState } from "react";
import type { SourceKind, SourceRecord } from "@margin/shared";
import { defaultSourceApiClient, describeSourceFailure, type SourceApiClient } from "./api";

export interface SourceCapturePanelProps {
  projectId: string;
  api?: SourceApiClient;
  initialSources?: SourceRecord[];
  onSourceSelected?: (sourceId: string) => void;
}

/** Starts shared UI captures and keeps the source inventory reconnectable through durable records. */
export function SourceCapturePanel({ projectId, api = defaultSourceApiClient, initialSources, onSourceSelected }: SourceCapturePanelProps) {
  const [sources, setSources] = useState<SourceRecord[]>(initialSources ?? []);
  const [kind, setKind] = useState<SourceKind>("url");
  const [value, setValue] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initialSources ? `${initialSources.length} captured source${initialSources.length === 1 ? "" : "s"}` : "Loading captured sources…");
  const [error, setError] = useState<string>();

  const selectedSource = useMemo(() => sources.find((source) => source.sourceId === selectedSourceId), [selectedSourceId, sources]);
  const activeAttempt = selectedSource?.attempts.find((attempt) => attempt.attemptId === selectedSource.lastAttemptId && (attempt.status === "queued" || attempt.status === "capturing"));

  async function refresh(): Promise<void> {
    try {
      const next = await api.listSources(projectId);
      setSources(next);
      setSelectedSourceId((current) => current && next.some((source) => source.sourceId === current) ? current : next[0]?.sourceId);
      setStatus(`${next.length} captured source${next.length === 1 ? "" : "s"}`);
      setError(undefined);
    } catch (reason) {
      setError(describeSourceFailure(reason));
      setStatus("Source inventory unavailable");
    }
  }

  useEffect(() => {
    let active = true;
    if (initialSources) return () => { active = false; };
    void api.listSources(projectId).then((next) => {
      if (!active) return;
      setSources(next);
      const firstSourceId = next[0]?.sourceId;
      setSelectedSourceId(firstSourceId);
      if (firstSourceId) onSourceSelected?.(firstSourceId);
      setStatus(`${next.length} captured source${next.length === 1 ? "" : "s"}`);
    }).catch((reason) => {
      if (!active) return;
      setError(describeSourceFailure(reason));
      setStatus("Source inventory unavailable");
    });
    return () => { active = false; };
  }, [api, initialSources, onSourceSelected, projectId]);

  function selectSource(sourceId: string): void {
    setSelectedSourceId(sourceId);
    onSourceSelected?.(sourceId);
  }

  async function capture(): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(kind === "url" ? "Enter a public http(s) URL." : "Enter a relative file path inside this project.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setStatus(`Capturing ${kind === "url" ? "web source" : "local file"}…`);
    try {
      const result = await api.capture(projectId, { kind, value: trimmed, origin: "ui" });
      setSources((current) => upsertSource(current, result.source));
      selectSource(result.sourceId);
      setStatus(result.status === "reused" ? "Capture reused an immutable evidence version" : captureStatusMessage(result.status));
      setValue("");
    } catch (reason) {
      setError(describeSourceFailure(reason));
      setStatus("Capture did not settle successfully");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!selectedSource || !activeAttempt) return;
    setBusy(true);
    setError(undefined);
    try {
      const source = await api.cancel(projectId, selectedSource.sourceId, activeAttempt.attemptId, "Cancelled from source capture panel");
      setSources((current) => upsertSource(current, source));
      setStatus("Capture cancelled; no partial evidence was published");
    } catch (reason) {
      setError(describeSourceFailure(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="source-capture-panel" data-testid="source-capture-panel" aria-labelledby="source-capture-title" aria-busy={busy}>
      <div className="source-panel__heading">
        <div><span className="eyebrow">Shared provenance</span><h3 id="source-capture-title">Capture a source</h3></div>
        <span className="status-badge">{sources.length} record{sources.length === 1 ? "" : "s"}</span>
      </div>
      <p className="source-panel__description">UI and Pi requests use the same idempotent capture boundary. Evidence stays server-owned; this panel shows bounded provenance only.</p>
      <div className="source-capture-panel__form">
        <label>Source kind<select aria-label="Source kind" value={kind} onChange={(event) => setKind(event.target.value as SourceKind)} disabled={busy}><option value="url">Public URL</option><option value="file">Local file</option></select></label>
        <label>{kind === "url" ? "Public http(s) URL" : "Relative file path inside project"}<input aria-label={kind === "url" ? "Public http(s) URL" : "Relative file path inside project"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={kind === "url" ? "https://example.org/article" : "documents/notes.txt"} disabled={busy} /></label>
      </div>
      <div className="source-capture-panel__actions"><button type="button" onClick={() => void capture()} disabled={busy}>{busy ? "Capturing…" : "Capture source"}</button><button type="button" className="button-quiet" onClick={() => void refresh()} disabled={busy}>Refresh status</button>{activeAttempt && <button type="button" className="button-danger" onClick={() => void cancel()} disabled={busy}>Cancel capture</button>}</div>
      {status && <p className="source-panel__status" role="status" aria-live="polite">{status}</p>}
      {error && <p className="error-notice" role="alert">{error}</p>}
      <div className="source-inventory" aria-label="Captured sources">
        <h4>Captured sources</h4>
        {sources.length === 0 ? <p className="source-panel__empty">No source records yet. Capture a URL or a project-local file to preserve an exact evidence version.</p> : <ul>{sources.map((source) => <li key={source.sourceId}><button type="button" className={source.sourceId === selectedSourceId ? "source-list__item is-selected" : "source-list__item"} onClick={() => selectSource(source.sourceId)} aria-pressed={source.sourceId === selectedSourceId}><span><strong>{source.effectiveMetadata.title ?? sourceLabel(source)}</strong><small>{source.kind} · {source.evidenceState}</small></span><code>{source.sourceId}</code></button></li>)}</ul>}
      </div>
    </section>
  );
}

function upsertSource(sources: SourceRecord[], source: SourceRecord): SourceRecord[] {
  return [...sources.filter((item) => item.sourceId !== source.sourceId), source].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function sourceLabel(source: SourceRecord): string {
  return source.kind === "file" ? source.identity.replace(/^file:/, "") : source.identity;
}

function captureStatusMessage(status: string): string {
  if (status === "archived") return "Source archived with an immutable evidence version";
  if (status === "metadata-only") return "Metadata saved; readable evidence is unavailable";
  if (status === "unavailable") return "Source unavailable; retry when it is reachable";
  if (status === "cancelled") return "Capture cancelled; no partial evidence was published";
  return `Capture settled as ${status}`;
}
