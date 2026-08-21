import type {
  FinalCheckpointSummary,
  LineageEntry,
  LineagePage,
  WorkspaceRestoreSelection,
} from "@margin/shared";
import { workspaceRestoreSelectionSchema } from "@margin/shared";

/** The only browser state that survives a restart. It is navigation, never process truth. */
export interface WorkspaceSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const workspaceSelectionStorageKey = (projectId: string): string =>
  `margin:lineage:workspace-selection:${projectId}`;

export type RestoredRunKind = "research" | "revision";

export interface RestoredRun {
  kind: RestoredRunKind;
  runId: string;
  entryId: string;
  persistedStatus: string | null;
  /** An active persisted record cannot be presented as running after a restart. */
  state: "interrupted" | "terminal" | "unknown";
  reconnectRequired: boolean;
  preservedArtifactEntryIds: string[];
}

export interface WorkspaceNotice {
  code: "RUN_INTERRUPTED" | "PENDING_PROPOSAL" | "STALE_SELECTION";
  message: string;
  runId?: string;
  proposalId?: string;
}

export interface ReconstructedWorkspaceState {
  projectId: string;
  selectedEntryId: string | null;
  activePanel: string | null;
  checkpointId: string | null;
  pendingProposalId: string | null;
  proposalDecision: FinalCheckpointSummary["proposalDecision"];
  reviewAcknowledged: boolean;
  latestQaAttemptId: string | null;
  runs: RestoredRun[];
  interruptedRuns: RestoredRun[];
  preservedArtifacts: LineageEntry[];
  notices: WorkspaceNotice[];
  /** Always false for a state reconstructed after restart. A reconnect must prove liveness. */
  processRunning: false;
  /** A pending decision is displayed for explicit action; restoration never applies it. */
  decisionApplied: false;
}

const activeRunStatuses = new Set(["queued", "running", "cancelling", "checkpointing"]);
const durableMilestoneKinds = new Set<LineageEntry["kind"]>([
  "brief.confirmed",
  "source.capture",
  "source.version",
  "research.run",
  "research.report",
  "research.decision",
  "checkpoint.created",
  "checkpoint.accepted",
  "qa.attempt",
  "qa.follow-up",
  "qa.finding",
  "qa.disposition",
  "qa.promotion",
  "comment.created",
  "revision.run",
  "proposal.created",
  "proposal.decision",
  "finding.relationship",
  "checkpoint.reviewed",
]);
const artifactKinds = new Set<LineageEntry["kind"]>([
  "source.capture",
  "source.version",
  "research.report",
  "checkpoint.created",
]);

function browserStorage(): WorkspaceSelectionStorage | undefined {
  if (typeof window === "undefined" || !window.localStorage) return undefined;
  return window.localStorage;
}

function newest<T extends LineageEntry>(entries: T[]): T | undefined {
  return [...entries].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return byTime || right.entryId.localeCompare(left.entryId);
  })[0];
}

function latestRunEntries(entries: LineageEntry[]): LineageEntry[] {
  const byRun = new Map<string, LineageEntry>();
  for (const item of entries) {
    if ((item.kind !== "research.run" && item.kind !== "revision.run") || !item.runId) continue;
    const key = `${item.kind}:${item.runId}`;
    const prior = byRun.get(key);
    if (!prior || Date.parse(item.occurredAt) >= Date.parse(prior.occurredAt)) byRun.set(key, item);
  }
  return [...byRun.values()];
}

function toRestoredRun(runEntry: LineageEntry, entries: LineageEntry[]): RestoredRun {
  const kind: RestoredRunKind = runEntry.kind === "revision.run" ? "revision" : "research";
  const persistedStatus = runEntry.status;
  const interrupted = Boolean(persistedStatus && activeRunStatuses.has(persistedStatus));
  const preservedArtifactEntryIds = interrupted && runEntry.runId
    ? entries.filter((item) => item.runId === runEntry.runId && artifactKinds.has(item.kind)).map((item) => item.entryId)
    : [];
  return {
    kind,
    runId: runEntry.runId ?? runEntry.detailTarget.id,
    entryId: runEntry.entryId,
    persistedStatus,
    state: interrupted ? "interrupted" : persistedStatus ? "terminal" : "unknown",
    reconnectRequired: interrupted,
    preservedArtifactEntryIds,
  };
}

function pendingProposal(entries: LineageEntry[]): LineageEntry | undefined {
  const proposals = entries.filter((item) => item.kind === "proposal.created" && item.proposalId);
  const current = newest(proposals);
  if (!current || current.status !== "pending") return undefined;
  const decided = entries.some((item) => item.kind === "proposal.decision" && item.proposalId === current.proposalId);
  return decided ? undefined : current;
}

export function readWorkspaceSelection(
  projectId: string,
  storage: WorkspaceSelectionStorage | undefined = browserStorage(),
): WorkspaceRestoreSelection | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(workspaceSelectionStorageKey(projectId));
    if (!raw) return null;
    const selection = workspaceRestoreSelectionSchema.parse(JSON.parse(raw));
    return selection.projectId === projectId ? selection : null;
  } catch {
    // A corrupt or old navigation hint must never prevent canonical reconstruction.
    return null;
  }
}

export function writeWorkspaceSelection(
  selection: WorkspaceRestoreSelection,
  storage: WorkspaceSelectionStorage | undefined = browserStorage(),
): WorkspaceRestoreSelection {
  const parsed = workspaceRestoreSelectionSchema.parse(selection);
  if (storage) {
    try {
      storage.setItem(workspaceSelectionStorageKey(parsed.projectId), JSON.stringify(parsed));
    } catch {
      // Storage is an optional convenience. The current in-memory selection remains valid.
    }
  }
  return parsed;
}

export function makeWorkspaceSelection(
  projectId: string,
  values: Pick<WorkspaceRestoreSelection, "checkpointId" | "selectedEntryId" | "activePanel" | "pendingProposalId">,
  updatedAt = new Date().toISOString(),
): WorkspaceRestoreSelection {
  return workspaceRestoreSelectionSchema.parse({ projectId, ...values, updatedAt });
}

/**
 * Rebuilds the browser workspace from the durable lineage page and final summary.
 * Persisted active statuses are intentionally downgraded to `interrupted`; no
 * local hint can claim a subprocess is still alive or apply a proposal decision.
 */
export function reconstructWorkspaceState(
  page: LineagePage | undefined,
  summary: FinalCheckpointSummary | undefined,
  selection: WorkspaceRestoreSelection | null = null,
  fallbackEntries: LineageEntry[] = [],
): ReconstructedWorkspaceState {
  const entries = page?.entries ?? fallbackEntries;
  const projectId = page?.projectId ?? summary?.projectId ?? selection?.projectId ?? "";
  const runEntries = latestRunEntries(entries);
  const runs = runEntries.map((item) => toRestoredRun(item, entries));
  const interruptedRuns = runs.filter((run) => run.reconnectRequired);
  const pending = pendingProposal(entries);
  const selectedExists = Boolean(selection?.selectedEntryId && entries.some((item) => item.entryId === selection.selectedEntryId));
  const firstDurable = entries.find((item) => durableMilestoneKinds.has(item.kind));
  const selectedEntryId = selectedExists ? selection!.selectedEntryId! : firstDurable?.entryId ?? entries[0]?.entryId ?? null;
  const notices: WorkspaceNotice[] = interruptedRuns.map((run) => ({
    code: "RUN_INTERRUPTED",
    runId: run.runId,
    message: `The ${run.kind} run ${run.runId} was persisted as ${run.persistedStatus} before restart. Reconnect before starting another run; preserved artifacts remain available.`,
  }));
  if (pending?.proposalId) {
    notices.push({
      code: "PENDING_PROPOSAL",
      proposalId: pending.proposalId,
      message: `Proposal ${pending.proposalId} is still awaiting an explicit Keep or Reject decision. No decision was applied during restoration.`,
    });
  }
  if (selection?.selectedEntryId && !selectedExists) {
    notices.push({
      code: "STALE_SELECTION",
      message: "The previous selection is no longer in the current lineage page; the first available durable milestone is selected instead.",
    });
  }
  const preservedIds = new Set(interruptedRuns.flatMap((run) => run.preservedArtifactEntryIds));
  return {
    projectId,
    selectedEntryId,
    activePanel: selection?.activePanel ?? null,
    checkpointId: summary?.checkpointId ?? selection?.checkpointId ?? null,
    pendingProposalId: pending?.proposalId ?? null,
    proposalDecision: summary?.proposalDecision ?? (pending ? "pending" : null),
    reviewAcknowledged: summary?.reviewAcknowledged ?? false,
    latestQaAttemptId: summary?.latestQaAttemptId ?? null,
    runs,
    interruptedRuns,
    preservedArtifacts: entries.filter((item) => preservedIds.has(item.entryId)),
    notices,
    processRunning: false,
    decisionApplied: false,
  };
}
