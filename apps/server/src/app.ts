import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { healthResponseSchema } from "../../../packages/shared/src/index.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, requestIdHeader: "x-correlation-id", genReqId: () => randomUUID() });
  app.register(cors, { origin: true });
  app.register(sensible);
  app.get("/health", async (request, reply) => reply.header("x-correlation-id", request.id).send(healthResponseSchema.parse({ ok: true, service: "margin-api", correlationId: request.id })));
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error, correlationId: request.id }, "request failed");
    const status = error.validation ? 400 : (error.statusCode && error.statusCode >= 400 ? error.statusCode : 500);
    return reply.status(status).send({ error: { code: error.validation ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: status === 500 ? "Internal server error" : error.message, correlationId: request.id } });
  });
  return app;
}
