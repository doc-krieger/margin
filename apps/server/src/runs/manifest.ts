import { revisionInstructionManifestSchema, type RevisionInstructionManifest, type SelectedComment } from "../../../../packages/shared/src/runs/contracts.js";
import type { CommentRecord } from "../../../../packages/shared/src/comments/contracts.js";

export interface BuildInstructionManifestInput {
  runId: string;
  correlationId: string;
  projectId: string;
  profileId: string;
  checkpointSha: string;
  checkpointRef: string;
  selectedCommentIds: string[];
  comments: CommentRecord[];
  guidance?: string;
  createdAt?: string;
}

function toSelectedComment(comment: CommentRecord): SelectedComment {
  return {
    id: comment.id,
    scope: comment.scope,
    documentPath: comment.documentPath,
    body: comment.body,
    anchor: comment.anchor,
  };
}

/** Selects comments by ID and rejects missing/duplicate selections before Pi sees the prompt. */
export function buildInstructionManifest(input: BuildInstructionManifestInput): RevisionInstructionManifest {
  const selectedIds = [...input.selectedCommentIds];
  if (new Set(selectedIds).size !== selectedIds.length) throw new TypeError("selectedCommentIds must not contain duplicates");
  const byId = new Map(input.comments.map((comment) => [comment.id, comment]));
  const selected: SelectedComment[] = [];
  for (const id of selectedIds) {
    const comment = byId.get(id);
    if (!comment) throw new Error(`Selected comment ${id} was not found`);
    if (comment.projectId !== input.projectId) throw new Error(`Selected comment ${id} belongs to another project`);
    selected.push(toSelectedComment(comment));
  }
  return revisionInstructionManifestSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    correlationId: input.correlationId,
    projectId: input.projectId,
    profileId: input.profileId,
    checkpoint: { sha: input.checkpointSha, ref: input.checkpointRef },
    comments: selected,
    guidance: input.guidance ?? "",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

/** Render JSON only; no canonical paths or unselected comments are interpolated into the prompt. */
export function renderInstructionPrompt(manifest: RevisionInstructionManifest): string {
  const parsed = revisionInstructionManifestSchema.parse(manifest);
  return [
    "Apply the requested review feedback in this isolated worktree.",
    "Do not modify files outside the current worktree and do not commit changes.",
    "Return one JSON object per progress event on stdout.",
    JSON.stringify(parsed),
  ].join("\n");
}
