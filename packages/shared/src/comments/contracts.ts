import { z } from "zod";

export const commentScopeSchema = z.enum(["document", "selection", "run"]);
export type CommentScope = z.infer<typeof commentScopeSchema>;

export const commentStateSchema = z.enum(["open", "addressed", "resolved"]);
export type CommentState = z.infer<typeof commentStateSchema>;

export const anchorStatusSchema = z.enum(["none", "anchored", "orphaned"]);
export type AnchorStatus = z.infer<typeof anchorStatusSchema>;

export const orphanReasonSchema = z.enum([
  "ambiguous-match",
  "removed-text",
  "context-mismatch",
  "section-mismatch",
  "invalid-anchor",
]);
export type OrphanReason = z.infer<typeof orphanReasonSchema>;

export const textAnchorSchema = z.object({
  quote: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  sectionPath: z.array(z.string()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TextAnchor = z.infer<typeof textAnchorSchema>;

export const anchorResultSchema = z.object({
  status: z.enum(["anchored", "orphaned"]),
  confidence: z.number().min(0).max(1),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  sectionPath: z.array(z.string()).optional(),
  orphanReason: orphanReasonSchema.optional(),
});
export type AnchorResult = z.infer<typeof anchorResultSchema>;

export const commentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  documentPath: z.string().min(1).nullable(),
  scope: commentScopeSchema,
  runId: z.string().min(1).nullable(),
  body: z.string().min(1),
  state: commentStateSchema,
  anchor: textAnchorSchema.nullable(),
  anchorStatus: anchorStatusSchema,
  anchorConfidence: z.number().min(0).max(1).nullable(),
  orphanReason: orphanReasonSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  addressedAt: z.string().datetime({ offset: true }).nullable(),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
});
export type CommentRecord = z.infer<typeof commentSchema>;

export const createCommentInputSchema = z.object({
  projectId: z.string().min(1),
  documentPath: z.string().min(1).nullable().optional(),
  scope: commentScopeSchema,
  runId: z.string().min(1).nullable().optional(),
  body: z.string().trim().min(1),
  anchor: textAnchorSchema.nullable().optional(),
}).superRefine((input, ctx) => {
  if (input.scope === "selection" && (!input.documentPath || !input.anchor)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor"], message: "selection comments require a document path and anchor" });
  }
  if (input.scope !== "selection" && input.anchor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor"], message: "only selection comments may have an anchor" });
  }
  if (input.scope === "run" && !input.runId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runId"], message: "run comments require a runId" });
  }
  if (input.scope !== "run" && input.runId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runId"], message: "only run comments may have a runId" });
  }
});
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

export const commentStateTransitions: Record<CommentState, readonly CommentState[]> = {
  open: ["addressed"],
  addressed: ["open", "resolved"],
  resolved: [],
};

export const commentScope = {
  document: "document",
  selection: "selection",
  run: "run",
} as const satisfies Record<CommentScope, CommentScope>;
