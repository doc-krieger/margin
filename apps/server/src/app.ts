import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { healthResponseSchema } from "../../../packages/shared/src/index.js";
import { ProjectLifecycleError, ProjectLifecycleService } from "./projects/service.js";
import { registerProjectRoutes } from "./projects/routes.js";

export interface BuildAppOptions {
  projectService?: ProjectLifecycleService;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, requestIdHeader: "x-correlation-id", genReqId: () => randomUUID() });
  const projectService = options.projectService ?? new ProjectLifecycleService();
  app.register(cors, { origin: true });
  app.register(sensible);
  app.get("/health", async (request, reply) => reply.header("x-correlation-id", request.id).send(healthResponseSchema.parse({ ok: true, service: "margin-api", correlationId: request.id })));
  registerProjectRoutes(app, projectService);
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error, correlationId: request.id }, "request failed");
    if (error instanceof ProjectLifecycleError) {
      const status = error.code === "PROJECT_PATH_OUTSIDE_REGISTERED_ROOT" ? 403
        : ["PROJECT_NOT_FOUND", "PROJECT_NOT_DIRECTORY"].includes(error.code) ? 404
        : ["DUPLICATE_PROJECT_IDENTITY", "GIT_INITIALIZATION_REQUIRED", "PROJECT_ALREADY_EXISTS"].includes(error.code) ? 409
        : error.code === "GIT_INITIALIZATION_FAILED" ? 502 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message, details: error.details, correlationId: request.id } });
    }
    const status = error.validation ? 400 : (error.statusCode && error.statusCode >= 400 ? error.statusCode : 500);
    return reply.status(status).send({ error: { code: error.validation ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: status === 500 ? "Internal server error" : error.message, correlationId: request.id } });
  });
  return app;
}
