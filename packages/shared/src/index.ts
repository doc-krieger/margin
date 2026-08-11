import { z } from "zod";

export const correlationIdSchema = z.string().uuid();
export const projectIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
export const projectRootRequestSchema = z.object({
  projectId: projectIdSchema,
  relativePath: z.string().min(1).max(4096).refine((value) => !value.includes("\\"), "backslashes are not supported")
});

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), correlationId: correlationIdSchema })
});

export type ProjectRootRequest = z.infer<typeof projectRootRequestSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({ ok: z.literal(true), service: z.literal("margin-api"), correlationId: correlationIdSchema });
export type HealthResponse = z.infer<typeof healthResponseSchema>;
