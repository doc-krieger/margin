import type { FastifyInstance } from "fastify";
import { sourceIdentityRequestSchema, type CaptureOrigin, type SourceKind } from "../../../../packages/shared/src/sources/contracts.js";
import { ProjectLifecycleService } from "../projects/service.js";
import { SourceCaptureService, type SourceCaptureInput } from "./service.js";
import { SourceProjectionError, SourceProjectionService, type SourceEvidenceSelection } from "./projection.js";
import { SourceStoreError, type SourceStore } from "./store.js";

export class SourceRouteError extends Error {
  constructor(public readonly code: "SOURCE_PROJECT_NOT_FOUND" | "SOURCE_NOT_FOUND" | "SOURCE_ATTEMPT_NOT_FOUND", message: string) {
    super(message);
    this.name = "SourceRouteError";
  }
}

export interface SourceRouteServices {
  store: SourceStore;
  capture: SourceCaptureService;
  projection: SourceProjectionService;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(message);
  return value.trim();
}

function sourceKind(value: unknown): SourceKind {
  if (value !== "url" && value !== "file") throw new TypeError("kind must be url or file");
  return value;
}

function origin(value: unknown, fallback: CaptureOrigin = "ui"): CaptureOrigin {
  if (value === undefined) return fallback;
  if (value !== "ui" && value !== "pi") throw new TypeError("origin must be ui or pi");
  return value;
}

function sourceInput(projectPath: string, body: Record<string, unknown>, fallback?: { kind: SourceKind; value: string }): SourceCaptureInput {
  const kind = sourceKind(body.kind ?? fallback?.kind);
  const value = requiredString(body.value ?? fallback?.value, "value is required");
  return {
    kind,
    value,
    ...(kind === "file" ? { baseDir: projectPath } : {}),
    origin: origin(body.origin),
    ...(typeof body.runId === "string" && body.runId.trim() ? { runId: body.runId.trim() } : {}),
  };
}

function projectSelections(value: unknown): SourceEvidenceSelection[] {
  if (!Array.isArray(value)) throw new TypeError("selections must be an array");
  if (value.length > 1000) throw new RangeError("selections must contain at most 1000 items");
  return value.map((item) => {
    const selection = record(item);
    return {
      sourceId: requiredString(selection.sourceId, "selection.sourceId is required"),
      versionId: requiredString(selection.versionId, "selection.versionId is required"),
      ...(selection.required === undefined ? {} : { required: Boolean(selection.required) }),
    };
  });
}

function ensureProject(projects: ProjectLifecycleService, projectId: string) {
  const project = projects.getProject(projectId);
  if (!project) throw new SourceRouteError("SOURCE_PROJECT_NOT_FOUND", `Project ${projectId} was not found`);
  return project;
}

export function registerSourceRoutes(
  app: FastifyInstance,
  projects: ProjectLifecycleService,
  servicesForProject: (projectPath: string) => SourceRouteServices,
): void {
  app.get("/api/projects/:projectId/sources", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = ensureProject(projects, projectId);
    const services = servicesForProject(project.path);
    return reply.header("x-correlation-id", request.id).send({ sources: await services.store.list() });
  });

  app.post("/api/projects/:projectId/sources/capture", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = ensureProject(projects, projectId);
    const body = record(request.body);
    const services = servicesForProject(project.path);
    const result = await services.capture.capture(sourceInput(project.path, body));
    return reply.header("x-correlation-id", request.id).send({ capture: result });
  });

  app.get("/api/projects/:projectId/sources/:sourceId", async (request, reply) => {
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string };
    const project = ensureProject(projects, projectId);
    const source = await servicesForProject(project.path).store.get(sourceId);
    if (!source) throw new SourceRouteError("SOURCE_NOT_FOUND", `Source ${sourceId} was not found`);
    return reply.header("x-correlation-id", request.id).send({ source });
  });

  app.post("/api/projects/:projectId/sources/:sourceId/retry", async (request, reply) => {
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string };
    const project = ensureProject(projects, projectId);
    const services = servicesForProject(project.path);
    const source = await services.store.get(sourceId);
    if (!source) throw new SourceRouteError("SOURCE_NOT_FOUND", `Source ${sourceId} was not found`);
    const body = record(request.body ?? {});
    const retryValue = source.kind === "file" ? source.identity.slice("file:".length) : source.identity;
    const result = await services.capture.retry(sourceInput(project.path, body, { kind: source.kind, value: retryValue }));
    if (result.sourceId !== sourceId) throw new SourceRouteError("SOURCE_NOT_FOUND", `Source ${sourceId} was not found`);
    return reply.header("x-correlation-id", request.id).send({ capture: result });
  });

  app.post("/api/projects/:projectId/sources/:sourceId/cancel", async (request, reply) => {
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string };
    const project = ensureProject(projects, projectId);
    const services = servicesForProject(project.path);
    const body = record(request.body ?? {});
    const attemptId = requiredString(body.attemptId, "attemptId is required");
    const source = await services.store.get(sourceId);
    if (!source) throw new SourceRouteError("SOURCE_NOT_FOUND", `Source ${sourceId} was not found`);
    if (!source.attempts.some((attempt) => attempt.attemptId === attemptId)) throw new SourceRouteError("SOURCE_ATTEMPT_NOT_FOUND", `Capture attempt ${attemptId} was not found`);
    const result = await services.capture.cancel(attemptId, typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined);
    return reply.header("x-correlation-id", request.id).send({ source: result });
  });

  app.get("/api/projects/:projectId/sources/:sourceId/evidence/:versionId", async (request, reply) => {
    const { projectId, sourceId, versionId } = request.params as { projectId: string; sourceId: string; versionId: string };
    const project = ensureProject(projects, projectId);
    const store = servicesForProject(project.path).store;
    const source = await store.get(sourceId);
    if (!source) throw new SourceRouteError("SOURCE_NOT_FOUND", `Source ${sourceId} was not found`);
    const version = source.versions.find((candidate) => candidate.versionId === versionId);
    if (!version) throw new SourceRouteError("SOURCE_NOT_FOUND", `Evidence version ${versionId} was not found`);
    const bytes = await store.readEvidence(sourceId, version);
    return reply.header("x-correlation-id", request.id).type(version.mediaType).send(Buffer.from(bytes));
  });

  app.post("/api/projects/:projectId/sources/projection", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = ensureProject(projects, projectId);
    const body = record(request.body);
    const worktreePath = requiredString(body.worktreePath, "worktreePath is required");
    const result = await servicesForProject(project.path).projection.project({
      worktreePath,
      selections: projectSelections(body.selections ?? []),
      ...(typeof body.runId === "string" && body.runId.trim() ? { runId: body.runId.trim() } : {}),
    });
    return reply.header("x-correlation-id", request.id).send({ projection: result });
  });
}

export function parseSourceIdentityRequest(body: unknown) {
  return sourceIdentityRequestSchema.parse(body);
}

export function sourceErrorStatus(error: unknown): number | undefined {
  if (error instanceof SourceRouteError) return error.code === "SOURCE_PROJECT_NOT_FOUND" || error.code === "SOURCE_NOT_FOUND" || error.code === "SOURCE_ATTEMPT_NOT_FOUND" ? 404 : 400;
  if (error instanceof SourceProjectionError) {
    return ["WORKTREE_NOT_FOUND", "WORKTREE_NOT_DIRECTORY"].includes(error.code) ? 404 : ["WORKTREE_NOT_ISOLATED", "WORKTREE_UNSAFE"].includes(error.code) ? 403 : 409;
  }
  if (error instanceof SourceStoreError) return error.code === "INVALID_SOURCE_ID" ? 400 : error.code === "IO_ERROR" ? 503 : 409;
  return undefined;
}
