import { useState } from "react";
import type { ResearchBrief, ResearchRunRecord } from "@margin/shared";
import { LineageWorkspace } from "../lineage";
import { acceptedCheckpointFromRun, defaultQualityApiClient } from "../quality";
import { BriefPanel } from "./brief-panel";
import { defaultResearchApiClient, type ResearchApiClient } from "./api";
import { RunProgressPanel } from "./run-progress-panel";
import { ReportReview } from "./report-review";
import type { QualityReviewApi } from "../quality";
import { sha256Text } from "../quality/api";

export interface ResearchWorkspaceProps {
  projectId: string;
  api?: ResearchApiClient;
  qualityApi?: QualityReviewApi;
}

function newInstructionId(): string {
  return `follow-up-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`;
}

/** Project-level brief-to-run surface; canonical document editing remains separate. */
export function ResearchWorkspace({ projectId, api = defaultResearchApiClient, qualityApi }: ResearchWorkspaceProps) {
  const [brief, setBrief] = useState<ResearchBrief>();
  const [run, setRun] = useState<ResearchRunRecord>();
  const [followUpQaBusy, setFollowUpQaBusy] = useState(false);

  async function startFollowUpQa() {
    const checkpoint = run ? acceptedCheckpointFromRun(run) : undefined;
    if (!checkpoint) throw new Error("Follow-up QA requires a completed run with an accepted report and frozen source graph.");
    setFollowUpQaBusy(true);
    try {
      const text = "Follow-up review: independently re-check the latest accepted report against its frozen source graph. Reassess open risks and record only evidence-backed findings.";
      const client = qualityApi ?? defaultQualityApiClient;
      await client.startReview(projectId, {
        targetCheckpoint: checkpoint,
        reviewerInstruction: { instructionId: newInstructionId(), text, sha256: await sha256Text(text), createdAt: new Date().toISOString() },
      });
    } finally {
      setFollowUpQaBusy(false);
    }
  }

  return (
    <section className="research-workspace" data-testid="research-workspace" aria-labelledby="research-workspace-title">
      <header className="research-workspace__heading">
        <div>
          <span className="eyebrow">Research studio</span>
          <h2 id="research-workspace-title">Question to cited report</h2>
        </div>
        <span className="research-workspace__boundary">Proposals stay isolated until review</span>
      </header>
      <p className="research-workspace__intro">Confirm a bounded brief, pass the Pi capability gate, and follow a reconnectable Standard run. Captured sources, notes, reports, and manifests are proposed artifacts—not canonical edits.</p>
      <div className="research-workspace__grid">
        <BriefPanel projectId={projectId} api={api} onBriefChanged={setBrief} onBriefConfirmed={setBrief} />
        <RunProgressPanel projectId={projectId} api={api} brief={brief} onRunChanged={setRun} />
      </div>
      {run ? <ReportReview projectId={projectId} run={run} qualityApi={qualityApi} /> : null}
      <LineageWorkspace
        projectId={projectId}
        onStartFollowUpQa={run ? startFollowUpQa : undefined}
        followUpQaDisabled={followUpQaBusy}
      />
    </section>
  );
}
