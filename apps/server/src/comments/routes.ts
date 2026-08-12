import type { FastifyInstance } from "fastify";
import {
  CommentAuthorizationError,
  CommentNotFoundError,
  CommentService,
  InvalidCommentTransitionError,
  type CommentActor,
} from "./repository.js";
import { DocumentError, DocumentService } from "../documents/service.js";

interface CommentParams {
  projectId: string;
  commentId?: string;
}

interface CommentQuery {
  documentPath?: string;
  runId?: string;
  scope?: "document" | "selection" | "run";
  state?: "open" | "addressed" | "resolved";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

/** Browser-facing comment routes. The filesystem remains the source of truth for re-anchoring. */
export function registerCommentRoutes(app: FastifyInstance, comments: CommentService, documents: DocumentService): void {
  app.get("/api/projects/:projectId/comments", async (request, reply) => {
    const { projectId } = request.params as CommentParams;
    const query = request.query as CommentQuery;
    const filter = { projectId, documentPath: query.documentPath, runId: query.runId, scope: query.scope, state: query.state };
    const listed = comments.list(filter);
    const paths = query.documentPath
      ? [query.documentPath]
      : [...new Set(listed.filter((comment) => comment.scope === "selection" && comment.documentPath).map((comment) => comment.documentPath as string))];

    for (const documentPath of paths) {
      try {
        const snapshot = await documents.readDocument(projectId, documentPath);
        comments.reanchorDocument(projectId, documentPath, snapshot.content);
      } catch (error) {
        if (error instanceof DocumentError && ["DOCUMENT_NOT_FOUND", "DOCUMENT_NOT_FILE", "DOCUMENT_NOT_TEXT"].includes(error.code)) {
          // An absent canonical file is a durable removed-text condition, not permission to guess an anchor.
          comments.reanchorDocument(projectId, documentPath, "");
          continue;
        }
        throw error;
      }
    }

    return reply.header("x-correlation-id", request.id).send({ comments: comments.list(filter) });
  });

  app.post("/api/projects/:projectId/comments", async (request, reply) => {
    const { projectId } = request.params as CommentParams;
    const body = asRecord(request.body);
    const scope = body.scope;
    const comment = scope === "selection"
      ? comments.createSelectionComment({
          projectId,
          documentPath: requiredString(body.documentPath, "documentPath"),
          documentText: typeof body.documentText === "string" ? body.documentText : (await documents.readDocument(projectId, requiredString(body.documentPath, "documentPath"))).content,
          start: integer(body.start, "start"),
          end: integer(body.end, "end"),
          body: requiredString(body.body, "body"),
        })
      : scope === "document"
        ? comments.createDocumentComment({ projectId, documentPath: requiredString(body.documentPath, "documentPath"), body: requiredString(body.body, "body") })
        : scope === "run"
          ? comments.createRunGuidance({ projectId, runId: requiredString(body.runId, "runId"), documentPath: optionalString(body.documentPath), body: requiredString(body.body, "body") })
          : (() => { throw new TypeError("scope must be document, selection, or run"); })();
    return reply.header("x-correlation-id", request.id).code(201).send({ comment });
  });

  app.patch("/api/projects/:projectId/comments/:commentId", async (request, reply) => {
    const { projectId, commentId } = request.params as CommentParams;
    const id = requiredString(commentId, "commentId");
    comments.requireForProject(projectId, id);
    const body = asRecord(request.body);
    const comment = comments.updateBody(id, requiredString(body.body, "body"));
    return reply.header("x-correlation-id", request.id).send({ comment });
  });

  const transition = async (request: any, reply: any) => {
    const { projectId, commentId } = request.params as CommentParams;
    const id = requiredString(commentId, "commentId");
    comments.requireForProject(projectId, id);
    const body = asRecord(request.body);
    const state = body.state;
    if (state !== "open" && state !== "addressed" && state !== "resolved") throw new TypeError("state must be open, addressed, or resolved");
    const actor: CommentActor = body.actor === "automation" ? "automation" : "user";
    const comment = comments.transition(id, state, actor);
    return reply.header("x-correlation-id", request.id).send({ comment });
  };
  app.post("/api/projects/:projectId/comments/:commentId/state", transition);
  app.patch("/api/projects/:projectId/comments/:commentId/state", transition);
}

export { CommentAuthorizationError, CommentNotFoundError, InvalidCommentTransitionError };
