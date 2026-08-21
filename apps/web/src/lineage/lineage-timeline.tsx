import type { LineageEntry } from "@margin/shared";

export interface LineageTimelineProps {
  entries: LineageEntry[];
  selectedEntryId?: string;
  loading?: boolean;
  hasMore?: boolean;
  onSelect?: (entry: LineageEntry) => void;
  onLoadMore?: () => void;
}

function formatOccurredAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function humanKind(kind: LineageEntry["kind"]): string {
  return kind.replace(/[._]/g, " ");
}

/** Accessible chronological navigation over immutable lineage entries. */
export function LineageTimeline({
  entries,
  selectedEntryId,
  loading = false,
  hasMore = false,
  onSelect,
  onLoadMore,
}: LineageTimelineProps) {
  return (
    <section className="lineage-timeline" data-testid="lineage-timeline" aria-labelledby="lineage-timeline-title">
      <div className="lineage-surface__heading">
        <div>
          <span className="eyebrow">Append-only record</span>
          <h3 id="lineage-timeline-title">Research lineage</h3>
        </div>
        <span className="lineage-timeline__count" aria-label={`${entries.length} lineage entries`}>{entries.length}</span>
      </div>
      {loading && entries.length === 0 ? <p className="lineage-state" role="status">Loading lineage…</p> : null}
      {!loading && entries.length === 0 ? <p className="lineage-state">No research milestones have been recorded yet.</p> : null}
      {entries.length > 0 ? (
        <ol className="lineage-timeline__list">
          {entries.map((entry) => {
            const selected = selectedEntryId === entry.entryId;
            return (
              <li key={entry.entryId} className={`lineage-timeline__item${selected ? " is-selected" : ""}`}>
                <button
                  type="button"
                  className="lineage-timeline__entry"
                  aria-pressed={selected}
                  onClick={() => onSelect?.(entry)}
                >
                  <span className="lineage-timeline__marker" aria-hidden="true" />
                  <span className="lineage-timeline__content">
                    <span className="lineage-timeline__meta">
                      <time dateTime={entry.occurredAt}>{formatOccurredAt(entry.occurredAt)}</time>
                      <span className="lineage-kind">{humanKind(entry.kind)}</span>
                      {entry.status ? <span className="status-badge">{entry.status}</span> : null}
                    </span>
                    <strong>{entry.title}</strong>
                    <span className="lineage-timeline__summary">{entry.summary}</span>
                  </span>
                  <span className="lineage-timeline__chevron" aria-hidden="true">{selected ? "−" : "+"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {hasMore ? (
        <button type="button" className="lineage-load-more" onClick={onLoadMore} disabled={loading}>
          {loading ? "Loading more…" : "Load older milestones"}
        </button>
      ) : null}
    </section>
  );
}
