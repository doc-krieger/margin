import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  defaultProjectApiClient,
  ProjectApiError,
  type ProjectApiClient,
  type CommentActor,
} from "../projects/api";
import type { CommentRecord, CommentState } from "@margin/shared";

export interface TextSelection {
  start: number;
  end: number;
  quote: string;
}

type ComposerScope = "selection" | "document" | "run";
type CommentFilter = "all" | "open" | "orphaned";

export interface CommentPaneProps {
  projectId: string;
  documentPath: string;
  documentText: string;
  selection?: TextSelection;
  refreshKey?: string;
  /** Incrementing this request selects the anchored composer from the editor affordance. */
  focusSelectionRequest?: number;
  client?: ProjectApiClient;
}

/** Review comments live beside the editor so comment actions never mutate Markdown text. */
export function CommentPane({ projectId, documentPath, documentText, selection, refreshKey, focusSelectionRequest, client = defaultProjectApiClient }: CommentPaneProps) {
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [scope, setScope] = useState<ComposerScope>("document");
  const [body, setBody] = useState("");
  const [runId, setRunId] = useState("");
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editingBody, setEditingBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Loading comments…");
  const bodyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  async function loadComments(): Promise<CommentRecord[]> {
    const next = await client.listComments(projectId);
    setComments(next);
    if (selectedId && !next.some((comment) => comment.id === selectedId)) setSelectedId(undefined);
    setStatus(next.length ? `${next.length} comment${next.length === 1 ? "" : "s"} loaded` : "No comments yet");
    return next;
  }

  async function refreshComments(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setStatus("Refreshing comments…");
    try {
      await loadComments();
    } catch (reason) {
      setError(messageFor(reason));
      setStatus("Comments unavailable");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!focusSelectionRequest) return;
    setScope("selection");
    bodyInputRef.current?.focus();
  }, [focusSelectionRequest]);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setStatus("Loading comments…");
    client.listComments(projectId).then((next) => {
      if (cancelled) return;
      setComments(next);
      if (selectedId && !next.some((comment) => comment.id === selectedId)) setSelectedId(undefined);
      setStatus(next.length ? `${next.length} comment${next.length === 1 ? "" : "s"} loaded` : "No comments yet");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(messageFor(reason));
      setStatus("Comments unavailable");
    });
    return () => { cancelled = true; };
  }, [client, projectId, documentPath, refreshKey]);

  const visibleComments = useMemo(() => comments.filter((comment) => {
    const belongsToDocument = comment.scope === "run"
      ? !comment.documentPath || comment.documentPath === documentPath
      : comment.documentPath === documentPath;
    if (!belongsToDocument) return false;
    if (filter === "open") return comment.state === "open" || comment.state === "addressed";
    if (filter === "orphaned") return comment.anchorStatus === "orphaned";
    return true;
  }), [comments, documentPath, filter]);

  useEffect(() => {
    if (selectedId && !visibleComments.some((comment) => comment.id === selectedId)) setSelectedId(undefined);
  }, [selectedId, visibleComments]);

  async function submitComment(): Promise<void> {
    const trimmed = body.trim();
    setError(undefined);
    if (!trimmed) {
      setError("Write a comment before adding it.");
      return;
    }
    if (scope === "selection" && !selection) {
      setError("Select text in the Markdown editor before adding an anchored comment.");
      return;
    }
    if (scope === "run" && !runId.trim()) {
      setError("Enter a run ID so guidance can be attached to a specific run.");
      return;
    }
    setBusy(true);
    try {
      if (scope === "selection" && selection) {
        await client.createSelectionComment(projectId, { documentPath, documentText, start: selection.start, end: selection.end, body: trimmed });
      } else if (scope === "document") {
        await client.createDocumentComment(projectId, { documentPath, body: trimmed });
      } else {
        await client.createRunGuidance(projectId, { runId: runId.trim(), documentPath, body: trimmed });
      }
      setBody("");
      setStatus("Comment added");
      await loadComments();
    } catch (reason) {
      setError(messageFor(reason));
      setStatus("Unable to add comment");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(comment: CommentRecord): Promise<void> {
    const trimmed = editingBody.trim();
    if (!trimmed) {
      setError("A comment cannot be empty.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.updateComment(projectId, comment.id, trimmed);
      setEditingId(undefined);
      setEditingBody("");
      setStatus("Comment updated");
      await loadComments();
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  }

  async function changeState(comment: CommentRecord, nextState: CommentState, actor: CommentActor = "user"): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await client.transitionComment(projectId, comment.id, nextState, actor);
      setStatus(nextState === "resolved" ? "Comment resolved by user" : `Comment marked ${nextState}`);
      await loadComments();
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  }

  function moveSelection(currentId: string, direction: 1 | -1): void {
    const index = visibleComments.findIndex((comment) => comment.id === currentId);
    if (index < 0 || visibleComments.length < 2) return;
    const next = visibleComments[(index + direction + visibleComments.length) % visibleComments.length];
    setSelectedId(next.id);
    itemRefs.current[next.id]?.focus();
  }

  function onCommentKeyDown(event: KeyboardEvent<HTMLDivElement>, comment: CommentRecord): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(comment.id, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(comment.id, -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(comment.id);
    }
  }

  return (
    <aside className="comment-pane" aria-label="Comment review" data-testid="comment-pane">
      <div className="comment-pane__heading">
        <div><span className="eyebrow">Review layer</span><h2>Comments</h2></div>
        <div className="comment-pane__heading-actions">
          <span className="comment-pane__count" aria-label={`${visibleComments.length} visible comments`}>{visibleComments.length}</span>
          <button type="button" data-testid="refresh-comments" aria-label="Refresh comments" onClick={refreshComments} disabled={busy}>Refresh</button>
        </div>
      </div>
      <p className="comment-pane__description">Feedback is stored beside the file. It never becomes Markdown text.</p>

      <section className="comment-composer" aria-labelledby="comment-composer-title">
        <h3 id="comment-composer-title">Add feedback</h3>
        <div className="comment-composer__scopes" role="group" aria-label="Comment scope">
          <button type="button" data-testid="comment-scope-selection" aria-pressed={scope === "selection"} onClick={() => setScope("selection")} disabled={busy}>Selection</button>
          <button type="button" data-testid="comment-scope-document" aria-pressed={scope === "document"} onClick={() => setScope("document")} disabled={busy}>Whole document</button>
          <button type="button" data-testid="comment-scope-run" aria-pressed={scope === "run"} onClick={() => setScope("run")} disabled={busy}>Run guidance</button>
        </div>
        {scope === "selection" && <p className="comment-composer__selection" data-testid="comment-selection-status" role="status">{selection ? `Selected: “${selection.quote}”` : "Select text in the editor to anchor this comment."}</p>}
        {scope === "run" && <label>Run ID<input aria-label="Run ID" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run-42" /></label>}
        <label>Comment<textarea ref={bodyInputRef} aria-label="New comment" value={body} onChange={(event) => setBody(event.target.value)} placeholder={scope === "run" ? "Guidance for this run…" : "Leave feedback…"} rows={3} /></label>
        <button type="button" className="comment-composer__submit" data-testid="add-comment" disabled={busy} onClick={submitComment}>Add {scope === "selection" ? "selection" : scope === "run" ? "run guidance" : "document"} comment</button>
      </section>

      <div className="comment-pane__filters" role="group" aria-label="Comment filters">
        {(["all", "open", "orphaned"] as const).map((option) => <button key={option} type="button" aria-pressed={filter === option} onClick={() => setFilter(option)}>{option === "all" ? "All" : option === "open" ? "Open" : "Orphaned"}</button>)}
      </div>
      {error && <p className="comment-pane__error" role="alert">{error}</p>}
      <p className="comment-pane__status" role="status" aria-live="polite">{status}</p>
      <p className="comment-pane__automation-note" data-testid="automated-resolution-note">Only a user can resolve feedback; automated actors cannot close comments.</p>

      <div className="comment-list" role="listbox" aria-label="Review comments" aria-activedescendant={selectedId}>
        {visibleComments.length === 0 && <p className="comment-list__empty">No comments match this view.</p>}
        {visibleComments.map((comment) => <CommentCard
          key={comment.id}
          comment={comment}
          selected={comment.id === selectedId}
          editing={comment.id === editingId}
          editingBody={editingBody}
          busy={busy}
          itemRef={(element) => { itemRefs.current[comment.id] = element; }}
          onFocus={() => setSelectedId(comment.id)}
          onClick={() => setSelectedId(comment.id)}
          onKeyDown={(event) => onCommentKeyDown(event, comment)}
          onEdit={() => { setEditingId(comment.id); setEditingBody(comment.body); setSelectedId(comment.id); }}
          onEditBody={setEditingBody}
          onCancelEdit={() => { setEditingId(undefined); setEditingBody(""); }}
          onSaveEdit={() => saveEdit(comment)}
          onChangeState={(nextState) => changeState(comment, nextState)}
        />)}
      </div>
    </aside>
  );
}

interface CommentCardProps {
  comment: CommentRecord;
  selected: boolean;
  editing: boolean;
  editingBody: string;
  busy: boolean;
  itemRef: (element: HTMLDivElement | null) => void;
  onFocus: () => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onEdit: () => void;
  onEditBody: (body: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onChangeState: (state: CommentState) => void;
}

function CommentCard({ comment, selected, editing, editingBody, busy, itemRef, onFocus, onClick, onKeyDown, onEdit, onEditBody, onCancelEdit, onSaveEdit, onChangeState }: CommentCardProps) {
  const scopeLabel = comment.scope === "selection" ? "Selection" : comment.scope === "run" ? "Run guidance" : "Whole document";
  const orphanLabel = orphanReasonLabel(comment.orphanReason);
  return (
    <div
      ref={itemRef}
      id={`comment-${comment.id}`}
      className={`comment-card${selected ? " comment-card--selected" : ""}${comment.anchorStatus === "orphaned" ? " comment-card--orphaned" : ""}`}
      role="option"
      aria-selected={selected}
      aria-label={`${scopeLabel} comment, ${comment.state}${comment.anchorStatus === "orphaned" ? `, orphaned: ${orphanLabel}` : ""}`}
      data-comment-state={comment.state}
      data-anchor-status={comment.anchorStatus}
      tabIndex={0}
      data-testid={`comment-card-${comment.id}`}
      onFocus={onFocus}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="comment-card__meta"><span className="comment-card__scope">{scopeLabel}</span><span className={`comment-card__state comment-card__state--${comment.state}`}>{comment.state}</span></div>
      {comment.scope === "run" && comment.runId && <p className="comment-card__run">Run: <code>{comment.runId}</code></p>}
      {comment.anchorStatus === "orphaned" && <div className="comment-card__orphan" role="alert"><strong>Anchor needs review</strong><span>{orphanReasonLabel(comment.orphanReason)}</span></div>}
      {comment.scope === "selection" && comment.anchorStatus === "anchored" && comment.anchor && <p className="comment-card__quote">“{comment.anchor.quote}” <span>{Math.round((comment.anchorConfidence ?? 0) * 100)}% confidence</span></p>}
      {editing ? <label>Edit comment<textarea aria-label="Edit comment" value={editingBody} onChange={(event) => onEditBody(event.target.value)} rows={3} /><span><button type="button" disabled={busy} onClick={onSaveEdit}>Save edit</button><button type="button" disabled={busy} onClick={onCancelEdit}>Cancel</button></span></label> : <p className="comment-card__body">{comment.body}</p>}
      {!editing && <div className="comment-card__actions">
        <button type="button" onClick={onEdit} disabled={busy}>Edit</button>
        {comment.state === "open" && <button type="button" onClick={() => onChangeState("addressed")} disabled={busy}>Mark addressed</button>}
        {comment.state === "addressed" && <><button type="button" onClick={() => onChangeState("resolved")} disabled={busy}>Resolve as user</button><button type="button" onClick={() => onChangeState("open")} disabled={busy}>Reopen</button></>}
      </div>}
    </div>
  );
}

function orphanReasonLabel(reason: CommentRecord["orphanReason"]): string {
  if (!reason) return "The original text could not be matched.";
  return reason.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function messageFor(reason: unknown): string {
  if (reason instanceof ProjectApiError) return reason.message;
  return reason instanceof Error ? reason.message : "An unexpected comment error occurred";
}
