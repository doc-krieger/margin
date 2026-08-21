import { useState, type FormEvent } from "react";
import type { QualityFinding, QualityFindingPromotion } from "@margin/shared";

export interface FindingCommentDialogProps {
  finding: QualityFinding;
  onClose: () => void;
  onSubmit: (target: QualityFindingPromotion["target"], body: string) => Promise<void> | void;
  busy?: boolean;
}

/** Explicit promotion boundary: reviewer output is never silently rewritten into the report. */
export function FindingCommentDialog({ finding, onClose, onSubmit, busy = false }: FindingCommentDialogProps) {
  const [target, setTarget] = useState<QualityFindingPromotion["target"]>("comment");
  const [body, setBody] = useState(finding.suggestedRevision ?? finding.rationale);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim()) {
      setError("Add a note before promoting this finding.");
      return;
    }
    setError("");
    try {
      await onSubmit(target, body.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Promotion failed. The finding history was not changed.");
    }
  }

  return (
    <div className="quality-dialog-backdrop" role="presentation">
      <section className="quality-dialog" role="dialog" aria-modal="true" aria-labelledby="finding-promotion-title" data-testid="finding-comment-dialog">
        <div className="quality-dialog__heading">
          <div>
            <span className="eyebrow">Promote finding</span>
            <h3 id="finding-promotion-title">Keep the reviewer history intact</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close promotion dialog" disabled={busy}>Close</button>
        </div>
        <p className="quality-dialog__finding"><strong>{finding.title}</strong></p>
        <p className="quality-dialog__help">This creates an editable comment or revision input. It does not rewrite the accepted report or the append-only finding.</p>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Editable destination</legend>
            <label>
              <input type="radio" name="promotion-target" value="comment" checked={target === "comment"} onChange={() => setTarget("comment")} />
              Add anchored comment
            </label>
            <label>
              <input type="radio" name="promotion-target" value="revision-input" checked={target === "revision-input"} onChange={() => setTarget("revision-input")} />
              Add revision input
            </label>
          </fieldset>
          <label className="quality-dialog__body-label">
            Reviewer note
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} aria-describedby="promotion-body-help" />
          </label>
          <p id="promotion-body-help" className="quality-dialog__help">The note remains editable through the existing human feedback workflow.</p>
          {error ? <p className="quality-status quality-status--error" role="alert">{error}</p> : null}
          <div className="quality-dialog__actions">
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="button--primary" disabled={busy || !body.trim()}>{busy ? "Promoting…" : "Promote finding"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

export const FindingPromotionDialog = FindingCommentDialog;
