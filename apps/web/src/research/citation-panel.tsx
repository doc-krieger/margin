import { useEffect, useState, type FormEvent } from "react";
import type { ResearchFrozenSourceBinding } from "@margin/shared";
import type {
  CitationApiClient,
  CitationRepairResult,
  CitationResolution,
  CitationResolutionStatus,
} from "./api";

export interface CitationPanelProps {
  runId?: string;
  attemptId?: string;
  resolution?: CitationResolution;
  binding?: ResearchFrozenSourceBinding;
  api?: CitationApiClient;
  loading?: boolean;
  error?: string;
  onRepair?: (result: CitationRepairResult) => void;
}

const statusCopy: Record<CitationResolutionStatus, { label: string; message: string; tone: "good" | "warning" | "danger" }> = {
  resolved: {
    label: "Exact evidence",
    message: "The frozen source version and checksum were verified for this citation.",
    tone: "good",
  },
  "metadata-only": {
    label: "metadata only",
    message: "The source and version are identified, but no evidence bytes are available. This is not a passing evidence result.",
    tone: "warning",
  },
  unavailable: {
    label: "evidence unavailable",
    message: "The exact source version exists, but evidence cannot currently be read. Do not treat this citation as supported.",
    tone: "danger",
  },
  "missing-source": {
    label: "source missing",
    message: "The frozen source record could not be found. The report meaning has not been silently repaired.",
    tone: "danger",
  },
  "missing-version": {
    label: "version missing",
    message: "The frozen evidence version could not be found. The report meaning has not been silently repaired.",
    tone: "danger",
  },
  "checksum-mismatch": {
    label: "checksum mismatch",
    message: "The available version does not match the frozen checksum. This citation is unsafe until a new checkpoint is created.",
    tone: "danger",
  },
  ambiguous: {
    label: "ambiguous",
    message: "More than one candidate could match this citation. No source was inferred.",
    tone: "warning",
  },
  unresolved: {
    label: "unresolved",
    message: "This citation has no safe exact-version resolution. No source was inferred from report text.",
    tone: "danger",
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function locationLabel(location: CitationResolution["location"]): string | null {
  if (!location) return null;
  if (typeof location === "string") return location;
  const parts = [location.relativePath, location.line, location.column].filter((value): value is number | string => value !== null && value !== undefined);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * In-context provenance diagnostics for one persisted citation usage. It never
 * guesses a source from the report body and keeps repair as a new-checkpoint action.
 */
export function CitationPanel({ runId, attemptId, resolution, binding, api, loading = false, error, onRepair }: CitationPanelProps) {
  const [sourceId, setSourceId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [reason, setReason] = useState("");
  const [repairError, setRepairError] = useState<string>();
  const [repairResult, setRepairResult] = useState<CitationRepairResult>();
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    setSourceId(resolution?.source?.sourceId ?? binding?.sourceId ?? "");
    setVersionId(resolution?.version?.versionId ?? binding?.versionId ?? "");
    setReason("");
    setRepairError(undefined);
    setRepairResult(undefined);
  }, [binding?.sourceId, binding?.versionId, resolution?.citationKey, resolution?.source?.sourceId, resolution?.version?.versionId]);

  if (!resolution) {
    return (
      <section className="citation-panel" data-testid="citation-panel" aria-labelledby="citation-panel-title">
        <div className="citation-panel__heading">
          <div>
            <p className="eyebrow">Citation support</p>
            <h3 id="citation-panel-title">Inspect a citation</h3>
          </div>
        </div>
        {loading ? <p role="status">Resolving frozen citations against the accepted checkpoint…</p> : null}
        {error ? <p className="citation-panel__diagnostic" role="alert">{error}</p> : null}
        {!loading && !error ? <p className="muted">Select a citation in the report or citation index to inspect its exact source and available evidence.</p> : null}
      </section>
    );
  }

  const status = statusCopy[resolution.status];
  const location = locationLabel(resolution.location);
  const canRepair = resolution.status !== "resolved" && Boolean(api && runId && resolution.citationKey);
  const submitRepair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!api || !runId) return;
    if (!sourceId.trim() || !versionId.trim() || !reason.trim()) {
      setRepairError("Enter the exact replacement source ID, version ID, and a reason before preparing a repair.");
      return;
    }
    setRepairError(undefined);
    setRepairResult(undefined);
    setRepairing(true);
    try {
      const result = await api.repairCitation(runId, {
        citationKey: resolution.citationKey,
        sourceId: sourceId.trim(),
        versionId: versionId.trim(),
        reason: reason.trim(),
        ...(attemptId ? { attemptId } : {}),
      });
      setRepairResult(result);
      onRepair?.(result);
    } catch (caught) {
      setRepairError(caught instanceof Error ? caught.message : "Citation repair could not be prepared.");
    } finally {
      setRepairing(false);
    }
  };

  return (
    <section className="citation-panel" data-testid="citation-panel" aria-labelledby="citation-panel-title">
      <div className="citation-panel__heading">
        <div>
          <p className="eyebrow">Citation support</p>
          <h3 id="citation-panel-title"><code>[{resolution.citationKey}]</code></h3>
        </div>
        <span className={`citation-panel__status citation-panel__status--${status.tone}`} data-testid="citation-status">{status.label}</span>
      </div>
      <p className={`citation-panel__summary citation-panel__summary--${status.tone}`} role={status.tone === "danger" ? "alert" : undefined}>{status.message}</p>

      {resolution.location || resolution.excerpt ? (
        <div className="citation-panel__claim">
          {location ? <p><strong>Report location:</strong> {location}</p> : null}
          {resolution.excerpt ? <blockquote>{resolution.excerpt}</blockquote> : null}
        </div>
      ) : null}

      <dl className="citation-panel__metadata">
        <div><dt>Source</dt><dd>{resolution.source ? resolution.source.identity : "Not resolved"}</dd></div>
        <div><dt>Source ID</dt><dd><code>{resolution.source?.sourceId ?? binding?.sourceId ?? "not available"}</code></dd></div>
        <div><dt>Evidence version</dt><dd><code>{resolution.version?.versionId ?? binding?.versionId ?? "not available"}</code></dd></div>
        <div><dt>Frozen checksum</dt><dd><code>{binding?.checksum ?? "not available"}</code></dd></div>
        {resolution.version ? <div><dt>Captured bytes</dt><dd>{formatBytes(resolution.version.byteLength)} · {resolution.version.mediaType}</dd></div> : null}
      </dl>

      {resolution.evidence?.available && resolution.evidence.preview ? (
        <div className="citation-panel__evidence">
          <h4>Available evidence preview</h4>
          <pre>{resolution.evidence.preview}</pre>
          {resolution.evidence.truncated ? <p className="muted">Preview truncated. The exact checksum remains the boundary; the full evidence is not rendered here.</p> : null}
        </div>
      ) : resolution.evidence ? (
        <p className="citation-panel__diagnostic" data-testid="citation-evidence-diagnostic">Passage-level evidence is unavailable; only the safe metadata above is available.</p>
      ) : null}

      {resolution.diagnostic ? <p className="citation-panel__diagnostic" data-testid="citation-diagnostic"><strong>{resolution.diagnostic.code}</strong>: {resolution.diagnostic.message}</p> : null}
      {error ? <p className="citation-panel__diagnostic" role="alert">{error}</p> : null}

      {canRepair ? (
        <details className="citation-panel__repair" open>
          <summary>Prepare a checkpoint repair</summary>
          <p className="muted">Repair changes citation lineage only by creating a new checkpoint. The accepted report and reviewer history stay unchanged.</p>
          <form onSubmit={submitRepair}>
            <label>Replacement source ID<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} /></label>
            <label>Replacement version ID<input value={versionId} onChange={(event) => setVersionId(event.target.value)} /></label>
            <label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Explain why this exact version is the safe replacement." /></label>
            <button type="submit" disabled={repairing}>{repairing ? "Preparing repair…" : "Prepare new checkpoint"}</button>
          </form>
          {repairError ? <p className="citation-panel__diagnostic" role="alert">{repairError}</p> : null}
          {repairResult ? <p className="citation-panel__success" role="status">{repairResult.status === "requires-new-checkpoint" ? "New checkpoint lineage prepared; the current report was not rewritten." : "The selected exact version already matches this checkpoint."}</p> : null}
        </details>
      ) : null}
      {repairResult && !canRepair ? <p className="citation-panel__success" role="status">Repair result recorded without changing the current accepted report.</p> : null}
    </section>
  );
}

export function citationStatusLabel(status: CitationResolutionStatus): string {
  return statusCopy[status].label;
}
