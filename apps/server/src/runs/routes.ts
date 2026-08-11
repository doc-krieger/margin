import type { FastifyInstance } from "fastify";
import { isTerminalRunStatus, startRevisionRunInputSchema } from "../../../../packages/shared/src/runs/contracts.js";
import { CommentService } from "../comments/repository.js";
import { ProjectLifecycleService } from "../projects/service.js";
import { RevisionRunError, RevisionRunService } from "./service.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} must be an array of strings`);
  return value;
}

function eventFrame(event: { sequence: number; type: string; timestamp: string; payload: Record<string, unknown> }): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ timestamp: event.timestamp, payload: event.payload })}\n\n`;
}

function afterSequence(request: { query: unknown; headers: Record<string, unknown> }): number {
  const query = asRecord(request.query);
  const queryValue = query.after ?? query.lastEventId;
  const headerValue = request.headers["last-event-id"];
  const value = queryValue ?? headerValue ?? -1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -1) throw new TypeError("after must be an integer greater than or equal to -1");
  return parsed;
}

export function registerRunRoutes(
  app: FastifyInstance,
  service: RevisionRunService,
  projects: ProjectLifecycleService,
  comments: CommentService,
): void {
  app.get("/api/pi/profiles", async (request, reply) => reply.header("x-correlation-id", request.id).send({ profiles: service.listProfiles() }));

  app.get("/api/projects/:projectId/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProject(projectId)) throw new RevisionRunError("RUN_NOT_FOUND", `Project ${projectId} was not found`);
    return reply.header("x-correlation-id", request.id).send({ runs: await service.list(projectId) });
  });

  app.post("/api/projects/:projectId/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProject(projectId);
    if (!project) throw new RevisionRunError("RUN_NOT_FOUND", `Project ${projectId} was not found`);
    const body = asRecord(request.body);
    const selectedCommentIds = body.selectedCommentIds ?? body.commentIds;
    const parsed = startRevisionRunInputSchema.parse({
      projectId,
      repositoryRoot: project.path,
      profileId: body.profileId,
      selectedCommentIds,
      guidance: body.guidance ?? "",
      correlationId: request.id,
    });
    const selectedComments = comments.list({ projectId, state: "open" }).filter((comment) => parsed.selectedCommentIds.includes(comment.id));
    if (selectedComments.length !== parsed.selectedCommentIds.length) throw new RevisionRunError("RUN_NOT_FOUND", "One or more selected comments were not found or are not open");
    const run = await service.start({ ...parsed, comments: selectedComments });
    return reply.header("x-correlation-id", request.id).code(202).send({ runId: run.runId, run });
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return reply.header("x-correlation-id", request.id).send({ run: await service.get(runId) });
  });

  app.post("/api/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return reply.header("x-correlation-id", request.id).send({ run: await service.cancel(runId) });
  });

  app.get("/api/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const after = afterSequence(request as { query: unknown; headers: Record<string, unknown> });
    const run = await service.get(runId);
    const replay = await service.events(runId, after);
    const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-correlation-id": request.id };
    const replayHasTerminalEvent = replay.some((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
    if (isTerminalRunStatus(run.status) || replayHasTerminalEvent) return reply.headers(headers).send(replay.map(eventFrame).join(""));

    reply.hijack();
    reply.raw.writeHead(200, headers);
    for (const event of replay) reply.raw.write(eventFrame(event));
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      reply.raw.end();
    };
    const unsubscribe = service.subscribe(runId, (event) => {
      if (closed) return;
      reply.raw.write(eventFrame(event));
      if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") finish();
    });
    request.raw.once("close", finish);
    const latest = await service.get(runId);
    if (isTerminalRunStatus(latest.status)) finish();
  });
}
