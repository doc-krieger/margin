import { useEffect, useMemo, useState } from "react";
import type { ResearchBrief, ResearchRecipe } from "@margin/shared";
import { defaultResearchApiClient, ResearchApiError, type ResearchApiClient, type ResearchBriefInput } from "./api";

export interface BriefPanelProps {
  projectId: string;
  api?: ResearchApiClient;
  initialBrief?: ResearchBrief;
  initialBriefs?: ResearchBrief[];
  onBriefChanged?: (brief: ResearchBrief) => void;
  onBriefConfirmed?: (brief: ResearchBrief) => void;
}

type BriefDraft = {
  briefId?: string;
  question: string;
  scope: string;
  audience: string;
  recipe: ResearchRecipe;
  outputMode: ResearchBrief["outputMode"];
};

const emptyDraft: BriefDraft = {
  question: "",
  scope: "",
  audience: "",
  recipe: "standard",
  outputMode: "research-and-report",
};

function draftFromBrief(brief: ResearchBrief): BriefDraft {
  return {
    briefId: brief.briefId,
    question: brief.question,
    scope: brief.scope,
    audience: brief.audience,
    recipe: brief.recipe,
    outputMode: brief.outputMode,
  };
}

function messageFor(reason: unknown): string {
  if (reason instanceof ResearchApiError) {
    if (reason.code === "RESEARCH_CONNECTION_FAILED") return "Research service is unavailable. Your brief is still local to this form until saved.";
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "An unexpected research brief error occurred";
}

/** Persists bounded research intent before a run can be started. */
export function BriefPanel({ projectId, api = defaultResearchApiClient, initialBrief, initialBriefs, onBriefChanged, onBriefConfirmed }: BriefPanelProps) {
  const [briefs, setBriefs] = useState<ResearchBrief[]>(initialBriefs ?? (initialBrief ? [initialBrief] : []));
  const [selectedBriefId, setSelectedBriefId] = useState(initialBrief?.briefId ?? initialBriefs?.at(-1)?.briefId);
  const [draft, setDraft] = useState<BriefDraft>(initialBrief ? draftFromBrief(initialBrief) : emptyDraft);
  const [activeBrief, setActiveBrief] = useState<ResearchBrief | undefined>(initialBrief);
  const [status, setStatus] = useState(initialBrief ? "Brief loaded" : "Start with a question and bounded scope");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialBriefs || initialBrief) return;
    let cancelled = false;
    api.listBriefs(projectId).then((loaded) => {
      if (cancelled) return;
      const latest = [...loaded].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      setBriefs(loaded);
      if (latest) {
        setSelectedBriefId(latest.briefId);
        setActiveBrief(latest);
        setDraft(draftFromBrief(latest));
        setStatus(latest.status === "confirmed" ? "Confirmed brief ready to run" : "Draft brief loaded");
        onBriefChanged?.(latest);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(messageFor(reason));
    });
    return () => { cancelled = true; };
  }, [api, initialBrief, initialBriefs, onBriefChanged, projectId]);

  const selected = useMemo(() => briefs.find((brief) => brief.briefId === selectedBriefId), [briefs, selectedBriefId]);

  function selectBrief(brief: ResearchBrief) {
    setSelectedBriefId(brief.briefId);
    setActiveBrief(brief);
    setDraft(draftFromBrief(brief));
    setError(undefined);
    setStatus(brief.status === "confirmed" ? "Confirmed brief ready to run" : "Draft brief loaded");
    onBriefChanged?.(brief);
  }

  function update<K extends keyof BriefDraft>(field: K, value: BriefDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setActiveBrief((current) => current ? { ...current, [field]: value } as ResearchBrief : current);
  }

  async function save(confirm: boolean) {
    if (!draft.question.trim() || !draft.scope.trim()) {
      setError("A research question and bounded scope are required before saving.");
      setStatus("Brief needs a question and scope");
      return;
    }
    setSaving(true);
    setError(undefined);
    setStatus(confirm ? "Saving brief before confirmation…" : "Saving draft…");
    const input: ResearchBriefInput = {
      briefId: draft.briefId,
      question: draft.question,
      scope: draft.scope,
      audience: draft.audience,
      recipe: draft.recipe,
      depth: draft.recipe,
      outputMode: draft.outputMode,
      status: "draft",
      confirmedRevision: null,
      confirmedAt: null,
    };
    try {
      const savedDraft = await api.saveBrief(projectId, input);
      let saved = savedDraft;
      if (confirm) {
        saved = await api.saveBrief(projectId, {
          ...input,
          briefId: savedDraft.briefId,
          status: "confirmed",
          confirmedRevision: savedDraft.revision + 1,
          confirmedAt: new Date().toISOString(),
        });
      }
      setBriefs((current) => [...current.filter((brief) => brief.briefId !== saved.briefId), saved]);
      setSelectedBriefId(saved.briefId);
      setActiveBrief(saved);
      setDraft(draftFromBrief(saved));
      setStatus(saved.status === "confirmed" ? "Brief confirmed and ready for Standard research" : "Draft saved durably");
      onBriefChanged?.(saved);
      if (saved.status === "confirmed") onBriefConfirmed?.(saved);
    } catch (reason) {
      setError(messageFor(reason));
      setStatus(confirm ? "Brief confirmation failed" : "Brief save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="research-brief-panel" data-testid="research-brief-panel" aria-labelledby="research-brief-title">
      <div className="research-panel__heading">
        <div>
          <span className="eyebrow">Research brief</span>
          <h2 id="research-brief-title">Bound the question before spending a run</h2>
        </div>
        {activeBrief && <span className={`research-status-badge research-status-badge--${activeBrief.status}`}>{activeBrief.status}</span>}
      </div>
      <p className="research-panel__description">The confirmed revision, clarification choices, and output intent are saved with the run. Nothing here edits canonical project files.</p>
      {briefs.length > 1 && (
        <label>Saved briefs
          <select aria-label="Saved research briefs" value={selectedBriefId ?? ""} onChange={(event) => { const brief = briefs.find((candidate) => candidate.briefId === event.target.value); if (brief) selectBrief(brief); }}>
            {briefs.map((brief) => <option key={brief.briefId} value={brief.briefId}>{brief.question.slice(0, 80)} · revision {brief.revision}</option>)}
          </select>
        </label>
      )}
      <div className="research-brief__fields">
        <label>Research question
          <textarea aria-label="Research question" value={draft.question} onChange={(event) => update("question", event.target.value)} placeholder="What should this research establish?" />
        </label>
        <label>Bounded scope
          <textarea aria-label="Bounded scope" value={draft.scope} onChange={(event) => update("scope", event.target.value)} placeholder="What is in scope, and what should be left out?" />
        </label>
        <label>Audience (optional)
          <input aria-label="Research audience" value={draft.audience} onChange={(event) => update("audience", event.target.value)} placeholder="Who will use the report?" />
        </label>
        <label>Research recipe
          <select aria-label="Research recipe" value={draft.recipe} onChange={(event) => update("recipe", event.target.value as ResearchRecipe)}>
            <option value="quick">Quick</option>
            <option value="standard">Standard</option>
            <option value="deep">Deep</option>
          </select>
        </label>
        <label>Output intent
          <select aria-label="Research output intent" value={draft.outputMode} onChange={(event) => update("outputMode", event.target.value as BriefDraft["outputMode"])}>
            <option value="research-and-report">Research plus cited report</option>
            <option value="research-only">Research notes only</option>
          </select>
        </label>
      </div>
      {activeBrief?.clarificationDecisions.length ? <div className="research-brief__decisions" aria-label="Clarification decisions">
        <strong>Clarification decisions</strong>
        <ul>{activeBrief.clarificationDecisions.map((decision) => <li key={decision.decisionId}><span>{decision.question}</span><span>{decision.answer}</span></li>)}</ul>
      </div> : null}
      {error && <p className="research-panel__error" role="alert">{error}</p>}
      <div className="research-panel__footer">
        <span className="research-panel__status" role="status" aria-live="polite">{status}</span>
        <div>
          <button type="button" className="button-secondary" disabled={saving} onClick={() => save(false)}>Save draft</button>
          <button type="button" disabled={saving} onClick={() => save(true)}>Save and confirm brief</button>
        </div>
      </div>
      {activeBrief?.status === "confirmed" && <p className="research-brief__confirmation" data-testid="brief-confirmation">Confirmed revision {activeBrief.confirmedRevision} · {activeBrief.confirmedAt ? new Date(activeBrief.confirmedAt).toLocaleString() : "time unavailable"}</p>}
      {selected && selected.briefId !== activeBrief?.briefId ? <span className="sr-only">Selected brief is ready</span> : null}
    </section>
  );
}
