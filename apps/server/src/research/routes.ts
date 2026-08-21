import type { FastifyInstance } from "fastify";
import { researchCapabilityDeclarationSchema } from "../../../../packages/shared/src/research/contracts.js";
import { ProjectLifecycleService } from "../projects/service.js";
import { SourceCaptureService } from "../sources/service.js";
import { planCitationRepair } from "./citation-repair.js";
import { CitationResolutionError, resolveCitationUsages } from "./citation-resolution.js";
import { ResearchRunError, ResearchRunService } from "./service.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as Record<string, unknown>;
}

function eventFrame(event: { sequence: number; type: string; timestamp: string; payload: Record<string, unknown> }): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ timestamp: event.timestamp, payload: event.payload })}\n\n`;
}

function afterSequence(request: { query: unknown; headers: Record<string, unknown> }): number {
  const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  const value = query.after ?? query.lastEventId ?? request.headers["last-event-id"] ?? -1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -1) throw new TypeError("after must be an integer greater than or equal to -1");
  return parsed;
}

function requiredCapabilities(body: Record<string, unknown>) {
  const value = body.requiredCapabilities ?? body.capabilities ?? [];
  if (!Array.isArray(value)) throw new TypeError("requiredCapabilities must be an array");
  return value.map((item) => researchCapabilityDeclarationSchema.parse(item));
}

export type ResearchSourceServiceForProject = (projectRoot: string) => SourceCaptureService | undefined;

export function registerResearchRoutes(
  app: FastifyInstance,
  service: ResearchRunService,
  projects: ProjectLifecycleService,
  sourceServiceForProject?: ResearchSourceServiceForProject,
): void {
  app.get("/api/research/profiles", async (request, reply) => reply.header("x-correlation-id", request.id).send({ profiles: service.listProfiles() }));
  app.get("/api/research/profiles/:profileId/capabilities", async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const required = query.capabilities ? JSON.parse(String(query.capabilities)) : [];
    return reply.header("x-correlation-id", request.id).send({ capabilities: await service.capabilities(profileId, requiredCapabilities(record({ requiredCapabilities: required }))) });
  });

  app.get("/api/projects/:projectId/research/briefs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    ensureProject(projects, projectId);
    return reply.header("x-correlation-id", request.id).send({ briefs: await service.listBriefs(projectId) });
  });
  app.post("/api/projects/:projectId/research/briefs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    ensureProject(projects, projectId);
    return reply.header("x-correlation-id", request.id).code(201).send({ brief: await service.saveBrief(projectId, request.body) });
  });
  app.get("/api/projects/:projectId/research/briefs/:briefId", async (request, reply) => {
    const { projectId, briefId } = request.params as { projectId: string; briefId: string };
    ensureProject(projects, projectId);
    return reply.header("x-correlation-id", request.id).send({ brief: await service.getBrief(projectId, briefId) });
  });

  app.get("/api/projects/:projectId/research/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    ensureProject(projects, projectId);
    return reply.header("x-correlation-id", request.id).send({ runs: await service.list(projectId) });
  });
  app.post("/api/projects/:projectId/research/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = ensureProject(projects, projectId);
    const body = record(request.body);
    const run = await service.start({
      projectId,
      repositoryRoot: project.path,
      briefId: requiredString(body.briefId, "briefId is required"),
      profileId: requiredString(body.profileId ?? "default", "profileId is required"),
      requiredCapabilities: requiredCapabilities(body),
      sourceSelections: Array.isArray(body.sourceSelections) ? body.sourceSelections.map((item) => {
        const selection = record(item);
        return {
          sourceId: requiredString(selection.sourceId, "sourceSelections.sourceId is required"),
          versionId: requiredString(selection.versionId, "sourceSelections.versionId is required"),
          required: selection.required !== false,
        };
      }) : [],
      ...(typeof body.worktreePath === "string" && body.worktreePath.trim() ? { worktreePath: body.worktreePath.trim() } : {}),
    });
    return reply.header("x-correlation-id", request.id).code(202).send({ runId: run.runId, run });
  });

  app.get("/api/research/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return reply.header("x-correlation-id", request.id).send({ run: await service.get(runId) });
  });
  app.post("/api/research/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason : "cancelled by user";
    return reply.header("x-correlation-id", request.id).send({ run: await service.cancel(runId, reason) });
  });
  app.get("/api/research/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const after = afterSequence(request as { query: unknown; headers: Record<string, unknown> });
    const run = await service.get(runId);
    const replay = await service.events(runId, after);
    const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-correlation-id": request.id };
    const terminal = (type: string) => type === "research.completed" || type === "research.failed" || type === "research.cancelled";
    if (["cancelled", "failed", "partial", "completed"].includes(run.status) || replay.some((event) => terminal(event.type))) return reply.headers(headers).send(replay.map(eventFrame).join(""));

    reply.hijack();
    reply.raw.writeHead(200, headers);
    for (const event of replay) reply.raw.write(eventFrame(event));
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      reply.raw.end();
    };
    unsubscribe = service.subscribe(runId, (event) => {
      if (closed) return;
      reply.raw.write(eventFrame(event));
      if (terminal(event.type)) finish();
    });
    request.raw.once("close", finish);
    if (["cancelled", "failed", "partial", "completed"].includes((await service.get(runId)).status)) finish();
  });

  const citationContext = async (runId: string, expectedProjectId?: string) => {
    const run = await service.get(runId);
    if (expectedProjectId && run.projectId !== expectedProjectId) {
      throw new ResearchRunError("RESEARCH_PROJECT_NOT_FOUND", `Research run ${runId} does not belong to project ${expectedProjectId}`);
    }
    const project = ensureProject(projects, run.projectId);
    const sourceService = sourceServiceForProject?.(project.path);
    if (!sourceService) throw new CitationResolutionError("RESEARCH_CITATION_SOURCE_SERVICE_UNAVAILABLE", "Source evidence is unavailable for this project");
    return { run, sourceService };
  };

  const getCitations = async (request: { params: unknown; query: unknown }) => {
    const params = request.params as { runId: string };
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const context = await citationContext(params.runId, (request.params as { projectId?: string }).projectId);
    return resolveCitationUsages(context.run, context.sourceService, {
      ...(typeof query.attemptId === "string" ? { attemptId: query.attemptId } : {}),
      ...(typeof query.usageId === "string" ? { usageId: query.usageId } : {}),
      ...(typeof query.citationKey === "string" ? { citationKey: query.citationKey } : {}),
    });
  };

  const repairCitation = async (request: { params: unknown; body: unknown }) => {
    const params = request.params as { runId: string };
    const context = await citationContext(params.runId, (request.params as { projectId?: string }).projectId);
    const body = record(request.body);
    return planCitationRepair(context.run, context.sourceService, {
      citationKey: requiredString(body.citationKey, "citationKey is required"),
      sourceId: requiredString(body.sourceId, "sourceId is required"),
      versionId: requiredString(body.versionId, "versionId is required"),
      reason: requiredString(body.reason, "reason is required"),
      ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
    });
  };

  app.get("/api/research/runs/:runId/citations", async (request, reply) => {
    const result = await getCitations(request as { params: unknown; query: unknown });
    return reply.header("x-correlation-id", request.id).send({ resolution: result });
  });
  app.post("/api/research/runs/:runId/citations/repair", async (request, reply) => {
    const result = await repairCitation(request as { params: unknown; body: unknown });
    return reply.header("x-correlation-id", request.id).send({ repair: result });
  });
  app.get("/api/projects/:projectId/research/runs/:runId/citations", async (request, reply) => {
    const result = await getCitations(request as { params: unknown; query: unknown });
    return reply.header("x-correlation-id", request.id).send({ resolution: result });
  });
  app.post("/api/projects/:projectId/research/runs/:runId/citations/repair", async (request, reply) => {
    const result = await repairCitation(request as { params: unknown; body: unknown });
    return reply.header("x-correlation-id", request.id).send({ repair: result });
  });
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(message);
  return value;
}

function ensureProject(projects: ProjectLifecycleService, projectId: string) {
  const project = projects.getProject(projectId);
  if (!project) throw new ResearchRunError("RESEARCH_PROJECT_NOT_FOUND", `Project ${projectId} was not found`);
  return project;
}
