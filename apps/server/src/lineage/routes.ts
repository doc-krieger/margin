import type { FastifyInstance } from "fastify";
import type { CheckpointReviewAcknowledgmentInput, FindingRelationshipInput } from "../../../../packages/shared/src/lineage/contracts.js";
import { lineageListQuerySchema } from "../../../../packages/shared/src/lineage/contracts.js";
import { LineageService } from "./service.js";

interface LineageParams {
  projectId: string;
  entryId?: string;
}

type LineageBody = Record<string, unknown>;

/** Browser/API projection routes. Detail navigation remains linked to canonical feature routes. */
export function registerLineageRoutes(app: FastifyInstance, lineage: LineageService): void {
  app.get<{ Params: LineageParams; Querystring: Record<string, unknown> }>("/api/projects/:projectId/lineage", async (request, reply) => {
    const query = lineageListQuerySchema.parse(request.query ?? {});
    return reply.send(await lineage.list(request.params.projectId, query));
  });

  app.get<{ Params: LineageParams }>("/api/projects/:projectId/lineage/entries/:entryId", async (request, reply) => {
    return reply.send(await lineage.get(request.params.projectId, request.params.entryId!));
  });

  app.get<{ Params: LineageParams }>("/api/projects/:projectId/lineage/final-checkpoint-summary", async (request, reply) => {
    return reply.send(await lineage.getFinalCheckpointSummary(request.params.projectId));
  });
  app.get<{ Params: LineageParams }>("/api/projects/:projectId/lineage/final-summary", async (request, reply) => {
    return reply.send(await lineage.getFinalCheckpointSummary(request.params.projectId));
  });

  const appendRelationship = async (request: { params: LineageParams; body: LineageBody }, reply: { send: (value: unknown) => unknown }) => {
    return reply.send(await lineage.recordFindingRelationship(request.params.projectId, request.body as FindingRelationshipInput));
  };
  app.post<{ Params: LineageParams; Body: LineageBody }>("/api/projects/:projectId/lineage/finding-relationships", appendRelationship);
  app.post<{ Params: LineageParams; Body: LineageBody }>("/api/projects/:projectId/lineage/relationships", appendRelationship);

  const acknowledgeReview = async (request: { params: LineageParams; body: LineageBody }, reply: { send: (value: unknown) => unknown }) => {
    return reply.send(await lineage.acknowledgeCheckpointReview(request.params.projectId, request.body as CheckpointReviewAcknowledgmentInput));
  };
  app.post<{ Params: LineageParams; Body: LineageBody }>("/api/projects/:projectId/lineage/checkpoint-review-acknowledgments", acknowledgeReview);
  app.post<{ Params: LineageParams; Body: LineageBody }>("/api/projects/:projectId/lineage/review-acknowledgments", acknowledgeReview);
}
