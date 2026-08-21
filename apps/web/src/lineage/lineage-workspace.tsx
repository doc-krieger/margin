import { useCallback, useEffect, useState } from "react";
import type { FinalCheckpointSummary, LineageEntry, LineagePage } from "@margin/shared";
import {
  defaultLineageApiClient,
  LineageApiError,
  type LineageApiClient,
} from "./api";
import { FinalCheckpointSummary as FinalCheckpointSummaryPanel } from "./final-checkpoint-summary";
import { LineageTimeline } from "./lineage-timeline";
import {
  makeWorkspaceSelection,
  readWorkspaceSelection,
  reconstructWorkspaceState,
  writeWorkspaceSelection,
  type WorkspaceSelectionStorage,
} from "./workspace-state";

export interface LineageWorkspaceProps {
  projectId: string;
  api?: LineageApiClient;
  initialPage?: LineagePage;
  initialEntries?: LineageEntry[];
  initialSummary?: FinalCheckpointSummary;
  onStartFollowUpQa?: () => Promise<void> | void;
  followUpQaDisabled?: boolean;
  /** Injectable storage keeps restoration deterministic in browser and SSR tests. */
  selectionStorage?: WorkspaceSelectionStorage;
}

function targetLabel(entry: LineageEntry): string {
  return entry.detailTarget.label ?? `${entry.detailTarget.type}:${entry.detailTarget.id}`;
}

/** Cross-domain research navigation surface; canonical records stay behind their own APIs. */
export function LineageWorkspace({
  projectId,
  api = defaultLineageApiClient,
  initialPage,
  initialEntries,
  initialSummary,
  onStartFollowUpQa,
  followUpQaDisabled,
  selectionStorage,
}: LineageWorkspaceProps) {
  const [entries, setEntries] = useState<LineageEntry[]>(initialPage?.entries ?? initialEntries ?? []);
  const [page, setPage] = useState<LineagePage | undefined>(initialPage);
  const [summary, setSummary] = useState<FinalCheckpointSummary | undefined>(initialSummary);
  const [selectedEntry, setSelectedEntry] = useState<LineageEntry | undefined>(() => {
    const available = initialPage?.entries ?? initialEntries ?? [];
    const restored = readWorkspaceSelection(projectId, selectionStorage);
    return available.find((item) => item.entryId === restored?.selectedEntryId) ?? available[0];
  });
  const [loading, setLoading] = useState(!initialPage && !initialEntries);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [restoreSelection, setRestoreSelection] = useState(() => readWorkspaceSelection(projectId, selectionStorage));
  const workspaceState = reconstructWorkspaceState(page, summary, restoreSelection, entries);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextPage, nextSummary] = await Promise.all([
        api.list(projectId, { limit: 50 }),
        api.getFinalCheckpointSummary(projectId),
      ]);
      setPage(nextPage);
      setEntries(nextPage.entries);
      setSummary(nextSummary);
      setRestoreSelection((current) => current ?? readWorkspaceSelection(projectId, selectionStorage));
      setSelectedEntry((current) => {
        const restoredId = restoreSelection?.selectedEntryId;
        return nextPage.entries.find((item) => item.entryId === restoredId) ?? (refresh || !current ? nextPage.entries[0] : current);
      });
    } catch (reason) {
      setError(reason instanceof LineageApiError ? reason.message : "Lineage could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [api, projectId, restoreSelection, selectionStorage]);

  useEffect(() => {
    const restoredEntry = entries.find((item) => item.entryId === workspaceState.selectedEntryId);
    if (restoredEntry && restoredEntry.entryId !== selectedEntry?.entryId) setSelectedEntry(restoredEntry);
  }, [entries, selectedEntry?.entryId, workspaceState.selectedEntryId]);

  useEffect(() => {
    if (initialPage || initialEntries) {
      setLoading(false);
      return;
    }
    void load();
  }, [initialEntries, initialPage, load]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const nextPage = await api.list(projectId, { cursor: page.nextCursor, limit: page.pageSize });
      setPage(nextPage);
      setEntries((current) => [...current, ...nextPage.entries]);
    } catch (reason) {
      setError(reason instanceof LineageApiError ? reason.message : "Older lineage entries could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore, page, projectId]);

  const selectEntry = useCallback(async (entry: LineageEntry) => {
    setSelectedEntry(entry);
    const nextSelection = makeWorkspaceSelection(projectId, {
      checkpointId: summary?.checkpointId ?? null,
      selectedEntryId: entry.entryId,
      activePanel: restoreSelection?.activePanel ?? null,
      pendingProposalId: workspaceState.pendingProposalId,
    });
    setRestoreSelection(nextSelection);
    writeWorkspaceSelection(nextSelection, selectionStorage);
    setDetailError(undefined);
    try {
      const detail = await api.getEntry(projectId, entry.entryId);
      setSelectedEntry(detail);
    } catch (reason) {
      // The page entry remains useful if a reconnect loses the optional detail request.
      setDetailError(reason instanceof LineageApiError ? reason.message : "The immutable detail could not be loaded.");
    }
  }, [api, projectId, restoreSelection?.activePanel, selectionStorage, summary?.checkpointId, workspaceState.pendingProposalId]);

  return (
    <section id="lineage-workspace" className="lineage-workspace" data-testid="lineage-workspace" aria-labelledby="lineage-workspace-title">
      <header className="lineage-workspace__heading">
        <div>
          <span className="eyebrow">Evidence trail</span>
          <h2 id="lineage-workspace-title">Lineage and final checkpoint</h2>
        </div>
        <button type="button" className="lineage-refresh" onClick={() => void load(true)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh lineage"}
        </button>
      </header>
      <p className="lineage-workspace__intro">Traverse confirmed briefs, captured sources, accepted reports, independent QA, feedback, and isolated revision decisions. Selecting a milestone never changes its canonical record.</p>
      {error ? <p className="lineage-error" role="alert">{error}</p> : null}
      {page?.freshness.status === "stale" ? (
        <p className="lineage-freshness" role="status">Lineage is temporarily stale; showing the last durable projection from {new Date(page.freshness.generatedAt).toLocaleString()}.</p>
      ) : null}
      {workspaceState.notices.length > 0 ? (
        <aside className="lineage-restoration" data-testid="lineage-restoration-notice" aria-label="Workspace restoration notices">
          <strong>Workspace restored from durable records</strong>
          <p>Navigation hints were restored, but Margin did not assume a process was still running or apply an unfinished decision.</p>
          <ul>{workspaceState.notices.map((notice) => <li key={`${notice.code}:${notice.runId ?? notice.proposalId ?? notice.message}`}>{notice.message}</li>)}</ul>
          {workspaceState.preservedArtifacts.length > 0 ? <p data-testid="preserved-artifacts">{workspaceState.preservedArtifacts.length} partial artifact{workspaceState.preservedArtifacts.length === 1 ? "" : "s"} preserved for inspection.</p> : null}
        </aside>
      ) : null}
      <div className="lineage-workspace__grid">
        <LineageTimeline
          entries={entries}
          selectedEntryId={selectedEntry?.entryId}
          loading={loading || loadingMore}
          hasMore={Boolean(page?.hasMore && page.nextCursor)}
          onSelect={(entry) => void selectEntry(entry)}
          onLoadMore={() => void loadMore()}
        />
        <div className="lineage-workspace__side">
          {selectedEntry ? (
            <article className="lineage-detail" data-testid="lineage-entry-detail" aria-labelledby="lineage-entry-detail-title">
              <span className="eyebrow">Immutable detail</span>
              <h3 id="lineage-entry-detail-title">{selectedEntry.title}</h3>
              <p>{selectedEntry.summary}</p>
              <dl className="lineage-detail__facts">
                <div><dt>Recorded</dt><dd><time dateTime={selectedEntry.occurredAt}>{new Date(selectedEntry.occurredAt).toLocaleString()}</time></dd></div>
                <div><dt>Record</dt><dd><code>{selectedEntry.entryId}</code></dd></div>
                <div><dt>Canonical target</dt><dd>{targetLabel(selectedEntry)} <code>{selectedEntry.detailTarget.type}:{selectedEntry.detailTarget.id}</code></dd></div>
                {selectedEntry.status ? <div><dt>Status</dt><dd>{selectedEntry.status}</dd></div> : null}
              </dl>
              {selectedEntry.relatedTargets.length > 0 ? (
                <div className="lineage-detail__relationships">
                  <h4>Related evidence</h4>
                  <ul>
                    {selectedEntry.relatedTargets.map((target) => <li key={`${target.type}:${target.id}`}><span>{target.label ?? target.id}</span><small>{target.type}</small></li>)}
                  </ul>
                </div>
              ) : null}
              {selectedEntry.diagnostic ? <p className="lineage-diagnostic" role={selectedEntry.diagnostic.available ? undefined : "alert"}>{selectedEntry.diagnostic.summary}</p> : null}
              {detailError ? <p className="lineage-action-note" role="status">{detailError} Showing the timeline projection.</p> : null}
            </article>
          ) : (
            <div className="lineage-detail lineage-detail--empty"><span className="eyebrow">Inspect a milestone</span><p>Select an entry to see what changed, which checkpoint it belongs to, and the canonical detail reference.</p></div>
          )}
          {summary ? <FinalCheckpointSummaryPanel summary={summary} onStartFollowUpQa={onStartFollowUpQa} followUpQaDisabled={followUpQaDisabled} /> : loading ? <div className="lineage-detail" role="status">Loading final checkpoint…</div> : null}
        </div>
      </div>
    </section>
  );
}
