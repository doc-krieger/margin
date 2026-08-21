import type { FastifyInstance } from "fastify";
import { isTerminalQualityAttemptStatus } from "../../../../packages/shared/src/quality/contracts.js";
import { ProjectLifecycleService } from "../projects/service.js";
import { QualityPromotionError } from "./promotion.js";
import {
  QualityReviewError,
  QualityReviewService,
  type QualityDispositionInput,
  type QualityPromotionRequest,
  type StartQualityReviewInput,
} from "./service.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function projectRoot(projects: ProjectLifecycleService, projectId: string): string {
  const project = projects.getProject(projectId);
  if (!project) throw new QualityReviewError("QUALITY_PROJECT_NOT_FOUND", `Project ${projectId} was not found`);
  return project.path;
}

function afterSequence(request: { query: unknown; headers: Record<string, unknown> }): number {
  const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  const value = query.after ?? query.lastEventId ?? request.headers["last-event-id"] ?? -1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -1) throw new TypeError("after must be an integer greater than or equal to -1");
  return parsed;
}

function eventFrame(event: { sequence: number; type: string; timestamp: string; message: string; findingId: string | null; claimId: string | null; percent: number | null }): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ timestamp: event.timestamp, message: event.message, findingId: event.findingId, claimId: event.claimId, percent: event.percent })}\n\n`;
}

function assertReviewProject(projects: ProjectLifecycleService, projectId: string, review: { projectId: string }): string {
  const root = projectRoot(projects, projectId);
  if (review.projectId !== projectId) throw new QualityReviewError("QUALITY_REVIEW_PROJECT_MISMATCH", "Quality review does not belong to this project");
  return root;
}

export function registerQualityRoutes(app: FastifyInstance, service: QualityReviewService, projects: ProjectLifecycleService): void {
  app.get("/api/projects/:projectId/quality-reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    projectRoot(projects, projectId);
    return reply.header("x-correlation-id", request.id).send({ reviews: await service.list(projectId) });
  });

  app.post("/api/projects/:projectId/quality-reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const repositoryRoot = projectRoot(projects, projectId);
    const body = asRecord(request.body);
    const parsed: StartQualityReviewInput = {
      projectId,
      repositoryRoot,
      targetCheckpoint: (body.targetCheckpoint ?? body.checkpoint) as StartQualityReviewInput["targetCheckpoint"],
      reviewerInstruction: body.reviewerInstruction as StartQualityReviewInput["reviewerInstruction"],
      profileId: optionalString(body.profileId, "profileId"),
      correlationId: request.id,
    };
    const review = await service.start(parsed);
    return reply.header("x-correlation-id", request.id).code(202).send({ reviewId: review.reviewId, review });
  });

  app.get("/api/projects/:projectId/quality-reviews/:reviewId", async (request, reply) => {
    const { projectId, reviewId } = request.params as { projectId: string; reviewId: string };
    const review = await service.get(reviewId);
    assertReviewProject(projects, projectId, review);
    return reply.header("x-correlation-id", request.id).send({ review });
  });

  app.post("/api/projects/:projectId/quality-reviews/:reviewId/retry", async (request, reply) => {
    const { projectId, reviewId } = request.params as { projectId: string; reviewId: string };
    const repositoryRoot = projectRoot(projects, projectId);
    const existing = await service.get(reviewId);
    assertReviewProject(projects, projectId, existing);
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const review = await service.retry({ reviewId, repositoryRoot, profileId: optionalString(body.profileId, "profileId"), correlationId: request.id });
    return reply.header("x-correlation-id", request.id).code(202).send({ reviewId, review });
  });

  app.post("/api/projects/:projectId/quality-reviews/:reviewId/cancel", async (request, reply) => {
    const { projectId, reviewId } = request.params as { projectId: string; reviewId: string };
    const existing = await service.get(reviewId);
    assertReviewProject(projects, projectId, existing);
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const review = await service.cancel(reviewId, optionalString(body.reason, "reason"));
    return reply.header("x-correlation-id", request.id).send({ review });
  });

  app.get("/api/projects/:projectId/quality-reviews/:reviewId/events", async (request, reply) => {
    const { projectId, reviewId } = request.params as { projectId: string; reviewId: string };
    const review = await service.get(reviewId);
    assertReviewProject(projects, projectId, review);
    const after = afterSequence(request as { query: unknown; headers: Record<string, unknown> });
    const replay = await service.events(reviewId, after);
    const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-correlation-id": request.id };
    const replayHasTerminalEvent = replay.some((event) => ["completed", "failed", "partial", "inconclusive", "cancelled"].includes(event.type));
    const attempt = review.attempts.find((candidate) => candidate.attemptId === review.latestAttemptId);
    if (isTerminalQualityAttemptStatus(attempt?.status ?? "failed") || replayHasTerminalEvent) {
      return reply.headers(headers).send(replay.map(eventFrame).join(""));
    }

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
    const unsubscribe = service.subscribe(reviewId, (event) => {
      if (closed) return;
      reply.raw.write(eventFrame(event));
      if (["completed", "failed", "partial", "inconclusive", "cancelled"].includes(event.type)) finish();
    });
    request.raw.once("close", finish);
    const latest = await service.get(reviewId);
    const latestAttempt = latest.attempts.find((candidate) => candidate.attemptId === latest.latestAttemptId);
    if (isTerminalQualityAttemptStatus(latestAttempt?.status ?? "failed")) finish();
  });

  app.post("/api/projects/:projectId/quality-reviews/:reviewId/findings/:findingId/dispositions", async (request, reply) => {
    const { projectId, reviewId, findingId } = request.params as { projectId: string; reviewId: string; findingId: string };
    const existing = await service.get(reviewId);
    assertReviewProject(projects, projectId, existing);
    const body = asRecord(request.body);
    const input: QualityDispositionInput = {
      reviewId,
      findingId,
      action: body.action as QualityDispositionInput["action"],
      rationale: body.rationale as string,
      actorId: optionalString(body.actorId, "actorId") ?? "user",
      supersedesDispositionId: optionalString(body.supersedesDispositionId, "supersedesDispositionId") ?? null,
    };
    const review = await service.appendDisposition(input);
    return reply.header("x-correlation-id", request.id).send({ review });
  });

  app.post("/api/projects/:projectId/quality-reviews/:reviewId/findings/:findingId/promotions", async (request, reply) => {
    const { projectId, reviewId, findingId } = request.params as { projectId: string; reviewId: string; findingId: string };
    const repositoryRoot = projectRoot(projects, projectId);
    const existing = await service.get(reviewId);
    assertReviewProject(projects, projectId, existing);
    const body = asRecord(request.body);
    const input: QualityPromotionRequest = {
      reviewId,
      findingId,
      repositoryRoot,
      target: body.target as QualityPromotionRequest["target"],
      actorId: optionalString(body.actorId, "actorId") ?? "user",
      body: optionalString(body.body, "body"),
    };
    const result = await service.promote(input);
    return reply.header("x-correlation-id", request.id).send({ review: result, promotion: result.promotionResult });
  });
}

