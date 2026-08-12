import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { healthResponseSchema } from "../../../packages/shared/src/index.js";
import { ProjectLifecycleError, ProjectLifecycleService } from "./projects/service.js";
import { registerProjectRoutes } from "./projects/routes.js";
import { DocumentError, DocumentService, registerDocumentRoutes } from "./documents/index.js";
import { CommentAuthorizationError, CommentNotFoundError, CommentService, InvalidCommentTransitionError, registerCommentRoutes } from "./comments/index.js";
import { RevisionRunError, RevisionRunService } from "./runs/service.js";
import { registerRunRoutes } from "./runs/routes.js";
import { ProposalError, ProposalService } from "./proposals/service.js";
import { registerProposalRoutes } from "./proposals/routes.js";

export interface BuildAppOptions {
  projectService?: ProjectLifecycleService;
  documentService?: DocumentService;
  commentService?: CommentService;
  runService?: RevisionRunService;
  proposalService?: ProposalService;
  commentDatabasePath?: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, requestIdHeader: "x-correlation-id", genReqId: () => randomUUID() });
  const projectService = options.projectService ?? new ProjectLifecycleService();
  app.register(cors, { origin: true });
  app.register(sensible);
  app.get("/health", async (request, reply) => reply.header("x-correlation-id", request.id).send(healthResponseSchema.parse({ ok: true, service: "margin-api", correlationId: request.id })));
  registerProjectRoutes(app, projectService);
  const documentService = options.documentService ?? new DocumentService(projectService);
  registerDocumentRoutes(app, documentService);
  const commentDatabasePath = options.commentDatabasePath ?? process.env.MARGIN_COMMENT_DATABASE ?? path.join(homedir(), ".margin", "comments.sqlite");
  if (!options.commentService) mkdirSync(path.dirname(commentDatabasePath), { recursive: true });
  const commentService = options.commentService ?? new CommentService(commentDatabasePath);
  if (!options.commentService) app.addHook("onClose", async () => commentService.close());
  registerCommentRoutes(app, commentService, documentService);
  if (options.runService && !options.proposalService) throw new TypeError("proposalService is required when runService is provided");
  const proposalService = options.proposalService ?? new ProposalService();
  const runService = options.runService ?? new RevisionRunService({ proposalService });
  proposalService.setCleanupObserver(async (proposal) => {
    await runService.recordProposalCleanup(proposal.runId, proposal.cleanup);
  });
  registerRunRoutes(app, runService, projectService, commentService);
  registerProposalRoutes(app, proposalService, projectService);
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error, correlationId: request.id }, "request failed");
    if (error instanceof DocumentError) {
      const status = error.code === "DOCUMENT_PROJECT_NOT_FOUND" || error.code === "DOCUMENT_NOT_FOUND" ? 404
        : error.code === "DOCUMENT_CONFLICT" ? 409
        : error.code === "DOCUMENT_NOT_FILE" || error.code === "DOCUMENT_NOT_TEXT" ? 422
        : error.code === "DOCUMENT_PATH_INVALID" ? 403 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message, details: error.details, correlationId: request.id } });
    }
    if (error instanceof ProjectLifecycleError) {
      const status = error.code === "PROJECT_PATH_OUTSIDE_REGISTERED_ROOT" ? 403
        : ["PROJECT_NOT_FOUND", "PROJECT_NOT_DIRECTORY"].includes(error.code) ? 404
        : ["DUPLICATE_PROJECT_IDENTITY", "GIT_INITIALIZATION_REQUIRED", "PROJECT_ALREADY_EXISTS"].includes(error.code) ? 409
        : error.code === "GIT_INITIALIZATION_FAILED" ? 502 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message, details: error.details, correlationId: request.id } });
    }
    if (error instanceof CommentAuthorizationError) {
      return reply.status(403).send({ error: { code: "COMMENT_RESOLUTION_UNAUTHORIZED", message: error.message, correlationId: request.id } });
    }
    if (error instanceof CommentNotFoundError) {
      return reply.status(404).send({ error: { code: "COMMENT_NOT_FOUND", message: error.message, correlationId: request.id } });
    }
    if (error instanceof InvalidCommentTransitionError) {
      return reply.status(409).send({ error: { code: "COMMENT_INVALID_STATE_TRANSITION", message: error.message, details: { from: error.from, to: error.to }, correlationId: request.id } });
    }
    if (error instanceof RevisionRunError) {
      const status = error.code === "RUN_NOT_FOUND" || error.code === "PI_PROFILE_NOT_FOUND" ? 404
        : error.code === "PI_UNAVAILABLE" ? 503
        : error.code === "RUN_NOT_CANCELLABLE" || error.code === "RUN_ALREADY_EXISTS" ? 409 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message, correlationId: request.id } });
    }
    if (error instanceof ProposalError) {
      const status = error.code === "PROPOSAL_NOT_FOUND" ? 404
        : ["PROPOSAL_ALREADY_EXISTS", "PROPOSAL_INVALID_STATE", "PROPOSAL_CONFLICT"].includes(error.code) ? 409
        : error.code === "PROPOSAL_CLEANUP_FAILED" ? 500 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message, details: error.details, correlationId: request.id } });
    }
    if (error.name === "ZodError") {
      return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: error.message, correlationId: request.id } });
    }
    const isInvalidRequest = Boolean(error.validation) || error instanceof TypeError || error instanceof RangeError || error.statusCode === 400;
    const status = isInvalidRequest ? 400 : (error.statusCode && error.statusCode >= 400 ? error.statusCode : 500);
    return reply.status(status).send({ error: { code: isInvalidRequest ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: status === 500 ? "Internal server error" : error.message, correlationId: request.id } });
  });
  return app;
}
