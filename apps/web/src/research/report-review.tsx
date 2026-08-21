import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResearchRunRecord, SourceRecord } from "@margin/shared";
import { CitationPanel } from "./citation-panel";
import {
  defaultResearchApiClient,
  type CitationApiClient,
  type CitationResolution,
  type CitationResolutionResult,
} from "./api";
import { ProposalReviewPanel } from "../proposals";
import {
  defaultProposalApiClient,
  type ProposalApiClient,
  type ProposalFile,
  type ProposalReview,
} from "../proposals/api";
import { SourceDetailPanel } from "../sources";
import { defaultSourceApiClient, type SourceApiClient } from "../sources/api";
import { QualityReviewPanel, type QualityReviewApi } from "../quality";
import type { QualityReviewRecord } from "@margin/shared";

export interface ReportReviewProps {
  projectId: string;
  run?: ResearchRunRecord;
  proposalApi?: ProposalApiClient;
  sourceApi?: SourceApiClient;
  citationApi?: CitationApiClient;
  initialReview?: ProposalReview;
  initialReport?: ProposalFile;
  initialCitationResolution?: CitationResolutionResult;
  initialSource?: SourceRecord;
  initialSourceId?: string;
  qualityApi?: QualityReviewApi;
  initialQualityReview?: QualityReviewRecord;
  onDecided?: (review: ProposalReview) => void;
}

/**
 * Report-first completion view. The report is read through the isolated proposal
 * boundary; run metadata remains the source of truth for citations and lineage.
 */
export function ReportReview({
  projectId,
  run,
  proposalApi = defaultProposalApiClient,
  sourceApi = defaultSourceApiClient,
  citationApi = defaultResearchApiClient,
  initialReview,
  initialReport,
  initialCitationResolution,
  initialSource,
  initialSourceId,
  qualityApi,
  initialQualityReview,
  onDecided,
}: ReportReviewProps) {
  const [review, setReview] = useState<ProposalReview | undefined>(initialReview);
  const [report, setReport] = useState<ProposalFile | undefined>(initialReport);
  const firstInitialCitation = initialCitationResolution?.citations[0];
  const [selectedSourceId, setSelectedSourceId] = useState(initialSourceId ?? firstInitialCitation?.source?.sourceId);
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>(firstInitialCitation?.version?.versionId);
  const [selectedCitationKey, setSelectedCitationKey] = useState<string | undefined>(firstInitialCitation?.citationKey);
  const [selectedCitationUsageId, setSelectedCitationUsageId] = useState<string | undefined>(firstInitialCitation?.usageId ?? undefined);
  const [citationResolution, setCitationResolution] = useState<CitationResolutionResult | undefined>(initialCitationResolution);
  const [citationBusy, setCitationBusy] = useState(false);
  const [citationError, setCitationError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const attempt = useMemo(() => {
    if (!run) return undefined;
    return run.synthesisAttempts.find((candidate) => candidate.attemptId === run.latestSynthesisAttemptId)
      ?? run.synthesisAttempts.at(-1);
  }, [run]);
  const reportArtifact = useMemo(() => {
    if (!run) return undefined;
    const artifactId = attempt?.reportArtifactId;
    return (artifactId ? run.artifacts.find((artifact) => artifact.artifactId === artifactId) : undefined)
      ?? run.artifacts.find((artifact) => artifact.kind === "report");
  }, [attempt, run]);
  const proposalId = run?.proposal?.proposalId ?? initialReview?.proposal.proposalId;
  const validation = attempt?.citationValidation;
  const sourceBindingByKey = useMemo(
    () => new Map((run?.frozenSourceBindings ?? []).filter((binding) => binding.citationKey).map((binding) => [binding.citationKey as string, binding])),
    [run],
  );
  const selectedBinding = selectedSourceId && selectedVersionId
    ? { sourceId: selectedSourceId, versionId: selectedVersionId }
    : undefined;
  const keepDisabled = validation?.status !== "valid";
  const keepDisabledReason = validation
    ? "Keep is available only when every citation key resolves to one frozen source version."
    : "Keep is disabled until citation validation is recorded for this report.";
  const citationKeys = useMemo(() => new Set([
    ...(validation?.usages.map((usage) => usage.citationKey) ?? []),
    ...(validation?.unresolvedKeys ?? []),
    ...(validation?.ambiguousKeys ?? []),
    ...(citationResolution?.citations.map((citation) => citation.citationKey) ?? []),
  ]), [citationResolution, validation]);
  const selectedCitation = useMemo<CitationResolution | undefined>(() => {
    if (!citationResolution) return undefined;
    return citationResolution.citations.find((citation) =>
      (selectedCitationUsageId ? citation.usageId === selectedCitationUsageId : false)
      || (selectedCitationKey ? citation.citationKey === selectedCitationKey : false),
    );
  }, [citationResolution, selectedCitationKey, selectedCitationUsageId]);
  const selectedCitationBinding = selectedCitationKey ? sourceBindingByKey.get(selectedCitationKey) : undefined;

  useEffect(() => {
    if (initialReview) {
      setReview(initialReview);
      return;
    }
    if (!proposalId) {
      setReview(undefined);
      return;
    }
    let active = true;
    setBusy("Loading isolated proposal");
    setError(undefined);
    proposalApi.getReview(projectId, proposalId)
      .then((next) => { if (active) setReview(next); })
      .catch((reason) => { if (active) setError(describeReportFailure(reason)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [initialReview, proposalApi, projectId, proposalId]);

  useEffect(() => {
    if (initialReport) {
      setReport(initialReport);
      return;
    }
    if (!proposalId || !reportArtifact?.relativePath) {
      setReport(undefined);
      return;
    }
    let active = true;
    setBusy(`Loading ${reportArtifact.relativePath}`);
    setError(undefined);
    proposalApi.readFile(projectId, proposalId, reportArtifact.relativePath)
      .then((next) => { if (active) setReport(next); })
      .catch((reason) => { if (active) setError(describeReportFailure(reason)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [initialReport, proposalApi, projectId, proposalId, reportArtifact?.relativePath]);

  useEffect(() => {
    if (initialCitationResolution) {
      setCitationResolution(initialCitationResolution);
      return;
    }
    if (!run || !attempt?.attemptId) {
      setCitationResolution(undefined);
      setCitationError(undefined);
      return;
    }
    let active = true;
    setCitationBusy(true);
    setCitationError(undefined);
    citationApi.resolveCitations(run.runId, { attemptId: attempt.attemptId })
      .then((next) => { if (active) setCitationResolution(next); })
      .catch((reason) => { if (active) setCitationError(describeReportFailure(reason)); })
      .finally(() => { if (active) setCitationBusy(false); });
    return () => { active = false; };
  }, [attempt?.attemptId, citationApi, initialCitationResolution, run?.runId]);

  useEffect(() => {
    const first = citationResolution?.citations[0];
    if (!first || selectedCitationKey) return;
    setSelectedCitationKey(first.citationKey);
    setSelectedCitationUsageId(first.usageId ?? undefined);
    setSelectedSourceId(first.source?.sourceId ?? sourceBindingByKey.get(first.citationKey)?.sourceId);
    setSelectedVersionId(first.version?.versionId ?? sourceBindingByKey.get(first.citationKey)?.versionId);
  }, [citationResolution, selectedCitationKey, sourceBindingByKey]);

  function selectCitation(citationKey: string, sourceId: string, versionId: string, usageId?: string): void {
    setSelectedCitationKey(citationKey);
    setSelectedCitationUsageId(usageId);
    const resolved = citationResolution?.citations.find((citation) => citation.usageId === usageId || citation.citationKey === citationKey);
    const binding = sourceBindingByKey.get(citationKey);
    setSelectedSourceId(resolved?.source?.sourceId ?? sourceId ?? binding?.sourceId);
    setSelectedVersionId(resolved?.version?.versionId ?? versionId ?? binding?.versionId);
  }

  const terminalWithoutProposal = run && ["partial", "failed", "cancelled"].includes(run.status) && !run.proposal;
  if (!run || terminalWithoutProposal || (!proposalId && !initialReview)) {
    return (
      <section className="report-review" data-testid="report-review" aria-labelledby="report-review-title">
        <span className="eyebrow">Report review</span>
        <h2 id="report-review-title">Cited report proposal</h2>
        <p className="report-review__empty">
          {run?.status === "partial"
            ? "This run preserved sources and notes, but no acceptable report proposal is available. Keep is disabled."
            : run?.status === "cancelled"
              ? "Cancellation settled with preserved research evidence; incomplete report output cannot be accepted."
              : run?.status === "failed"
                ? "Synthesis did not produce a report proposal. Inspect the run diagnostics or retry synthesis when available."
                : "A completed synthesis proposal will appear here after the research run settles."}
        </p>
      </section>
    );
  }

  const reportTitle = reportArtifact?.label || reportArtifact?.relativePath || "Report artifact";
  return (
    <section className="report-review" data-testid="report-review" aria-labelledby="report-review-title" aria-busy={Boolean(busy)}>
      <div className="report-review__heading">
        <div>
          <span className="eyebrow">Completion landing view</span>
          <h2 id="report-review-title">Cited report proposal</h2>
          <p className="report-review__lineage">Run <code>{run.runId}</code> · synthesis <code>{attempt?.attemptId ?? "not recorded"}</code></p>
        </div>
        {run.proposal && <span className={`status-badge status-badge--${run.proposal.status}`}>{run.proposal.status === "pending" ? "Awaiting decision" : run.proposal.status}</span>}
      </div>
      <p className="boundary-notice"><strong>Review before canonical changes.</strong> This report, notes, and source manifest remain in one isolated proposal. Keep or Reject applies to the whole proposal; archived evidence is not copied into Git.</p>
      {error && <p className="error-notice" role="alert">{error}</p>}
      {busy && <p className="operation-status" role="status">{busy}…</p>}

      <div className="report-review__layout">
        <article className="report-preview" aria-labelledby="report-preview-title">
          <div className="report-preview__heading">
            <div><span className="eyebrow">Markdown report</span><h3 id="report-preview-title">{reportTitle}</h3></div>
            {reportArtifact?.sha256 && <code title="Proposal artifact SHA-256">{reportArtifact.sha256.slice(0, 12)}…</code>}
          </div>
          {report ? <div className="report-preview__body">{renderMarkdownReport(report.content, {
            citationKeys,
            onCitation: (citationKey) => {
              const binding = sourceBindingByKey.get(citationKey);
              selectCitation(citationKey, binding?.sourceId ?? "", binding?.versionId ?? "");
            },
          })}</div> : <p className="report-review__empty">Loading the isolated report body…</p>}
        </article>

        <aside className="report-provenance" aria-label="Report provenance">
          <section className="report-review__card" aria-labelledby="citation-validation-title">
            <div className="report-review__card-heading"><h3 id="citation-validation-title">Citation validation</h3><span className={`status-badge status-badge--${validation?.status ?? "pending"}`}>{validation?.status ?? "pending"}</span></div>
            <p>{validation ? `${validation.usages.length} citation usage location${validation.usages.length === 1 ? "" : "s"} indexed.` : "Citation diagnostics are not available yet."}</p>
            {validation?.diagnostics && <p className="report-review__diagnostic">{validation.diagnostics}</p>}
            {validation?.unresolvedKeys.length ? <p className="report-review__error"><strong>Unresolved keys:</strong> {validation.unresolvedKeys.join(", ")}</p> : null}
            {validation?.ambiguousKeys.length ? <p className="report-review__error"><strong>Ambiguous keys:</strong> {validation.ambiguousKeys.join(", ")}</p> : null}
          </section>

          <section className="report-review__card" aria-labelledby="citation-usage-title">
            <h3 id="citation-usage-title">Citation usage index</h3>
            {validation?.usages.length ? <ol className="citation-usage-list">{validation.usages.map((usage) => {
              const binding = sourceBindingByKey.get(usage.citationKey);
              const location = formatCitationLocation(usage.location);
              const resolved = citationResolution?.citations.find((citation) => citation.usageId === usage.usageId);
              return <li key={usage.usageId}><button type="button" className="citation-usage-list__button" onClick={() => selectCitation(usage.citationKey, usage.sourceId, usage.versionId, usage.usageId)}><strong>[{usage.citationKey}]</strong><span>{location}</span><small>{resolved ? `${resolved.status} · ${resolved.source?.sourceId ?? usage.sourceId}` : binding ? `${binding.sourceId} · ${binding.versionId}` : `${usage.sourceId} · ${usage.versionId}`}</small></button>{usage.excerpt && <q>{usage.excerpt}</q>}</li>;
            })}</ol> : <p className="report-review__empty">No citation usage locations recorded.</p>}
          </section>

          <section className="report-review__card" aria-labelledby="frozen-sources-title">
            <h3 id="frozen-sources-title">Frozen source versions</h3>
            {run.frozenSourceBindings.length ? <ul className="frozen-source-list">{run.frozenSourceBindings.map((binding) => <li key={`${binding.sourceId}-${binding.versionId}`}><button type="button" onClick={() => binding.citationKey ? selectCitation(binding.citationKey, binding.sourceId, binding.versionId) : (setSelectedSourceId(binding.sourceId), setSelectedVersionId(binding.versionId))}><strong>{binding.citationKey ? `[${binding.citationKey}]` : "Source"}</strong><span><code>{binding.sourceId}</code><code>{binding.versionId}</code></span></button></li>)}</ul> : <p className="report-review__empty">No exact source bindings were recorded.</p>}
          </section>
          <CitationPanel
            runId={run.runId}
            attemptId={attempt?.attemptId}
            resolution={selectedCitation}
            binding={selectedCitationBinding}
            api={citationApi}
            loading={citationBusy}
            error={citationError}
          />
        </aside>
      </div>

      {selectedSourceId && <div className="report-review__source-detail"><SourceDetailPanel projectId={projectId} sourceId={selectedSourceId} focusVersionId={selectedVersionId} api={sourceApi} initialSource={initialSource} /></div>}
      {run.proposal && <div className="report-review__decision"><ProposalReviewPanel projectId={projectId} proposalId={run.proposal.proposalId} api={proposalApi} initialReview={review} keepDisabled={keepDisabled} keepDisabledReason={keepDisabledReason} onDecided={onDecided} /></div>}
      <div className="report-review__quality"><QualityReviewPanel projectId={projectId} run={run} api={qualityApi} initialReview={initialQualityReview} /></div>
      {selectedBinding && <span className="sr-only">Selected citation source {selectedBinding.sourceId} version {selectedBinding.versionId}</span>}
    </section>
  );
}

export interface MarkdownReportRenderOptions {
  citationKeys?: ReadonlySet<string>;
  onCitation?: (citationKey: string) => void;
}

export function renderMarkdownReport(source: string, options: MarkdownReportRenderOptions = {}): ReactNode[] {
  const lines = source.split(/\r?\n/);
  const output: ReactNode[] = [];
  let codeLines: string[] = [];
  let codeStart = 0;
  let inCode = false;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        output.push(<pre key={`code-${codeStart}`}><code>{codeLines.join("\n")}</code></pre>);
        codeLines = [];
      } else {
        codeStart = index;
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      output.push(renderHeading(level, renderReportInline(heading[2], options, `heading-${index}`), `heading-${index}`));
      return;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      output.push(<p className="report-preview__bullet" key={`bullet-${index}`}>• {renderReportInline(bullet[1], options, `bullet-${index}`)}</p>);
      return;
    }
    if (line.trim()) output.push(<p key={`paragraph-${index}`}>{renderReportInline(line, options, `paragraph-${index}`)}</p>);
  });
  if (inCode && codeLines.length) output.push(<pre key={`code-${codeStart}`}><code>{codeLines.join("\n")}</code></pre>);
  return output;
}

function renderHeading(level: number, text: ReactNode, key: string): ReactNode {
  switch (level) {
    case 1: return <h1 key={key}>{text}</h1>;
    case 2: return <h2 key={key}>{text}</h2>;
    case 3: return <h3 key={key}>{text}</h3>;
    case 4: return <h4 key={key}>{text}</h4>;
    case 5: return <h5 key={key}>{text}</h5>;
    default: return <h6 key={key}>{text}</h6>;
  }
}

function renderReportInline(text: string, options: MarkdownReportRenderOptions, keyPrefix: string): ReactNode[] {
  if (!options.onCitation || !options.citationKeys?.size) return [text];
  const output: ReactNode[] = [];
  const pattern = /\[([a-zA-Z0-9][a-zA-Z0-9._:-]*)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    const citationKey = match[1];
    if (!options.citationKeys.has(citationKey)) continue;
    if (match.index > cursor) output.push(text.slice(cursor, match.index));
    output.push(<button key={`${keyPrefix}-citation-${index}`} type="button" className="report-preview__citation" onClick={() => options.onCitation?.(citationKey)} aria-label={`Inspect citation ${citationKey}`}>[{citationKey}]</button>);
    cursor = match.index + match[0].length;
    index += 1;
  }
  if (cursor === 0) return [text];
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function formatCitationLocation(location: string | { relativePath: string; line: number | null; column: number | null; endLine: number | null; endColumn: number | null }): string {
  if (typeof location === "string") return location;
  const line = location.line ? `:${location.line}` : "";
  return `${location.relativePath}${line}`;
}

function describeReportFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The isolated report could not be loaded.";
}

export { sourceBindingByCitationKey };
function sourceBindingByCitationKey(run: ResearchRunRecord, citationKey: string) {
  return run.frozenSourceBindings.find((binding) => binding.citationKey === citationKey);
}
