import type { FastifyInstance } from "fastify";
import { DocumentError, DocumentService, type DocumentSaveInput } from "./service.js";

export function registerDocumentRoutes(app: FastifyInstance, service: DocumentService): void {
  app.get("/api/projects/:projectId/documents", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return reply.header("x-correlation-id", request.id).send(await service.listDocuments(projectId));
  });

  app.get("/api/projects/:projectId/documents/*", async (request, reply) => {
    const { projectId } = request.params as { projectId: string; "*": string };
    return reply.header("x-correlation-id", request.id).send(await service.readDocument(projectId, decodePath(request.params as Record<string, unknown>)));
  });

  app.get("/api/projects/:projectId/document", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as { path?: string; relativePath?: string };
    return reply.header("x-correlation-id", request.id).send(await service.readDocument(projectId, query.path ?? query.relativePath ?? ""));
  });

  const save = async (request: any, reply: any) => {
    const { projectId } = request.params as { projectId: string };
    const body = asRecord(request.body);
    const input: DocumentSaveInput = {
      path: decodePath(request.params as Record<string, unknown>) || asOptionalString(body.path ?? body.relativePath),
      relativePath: asOptionalString(body.relativePath),
      content: body.content,
      baseHash: asOptionalString(body.baseHash ?? body.expectedHash),
      expectedHash: asOptionalString(body.expectedHash),
    };
    return reply.header("x-correlation-id", request.id).send(await service.saveDocument(projectId, input));
  };
  app.put("/api/projects/:projectId/documents/*", save);
  app.post("/api/projects/:projectId/documents/*", save);
  app.put("/api/projects/:projectId/document", save);
  app.post("/api/projects/:projectId/document", save);
}

function decodePath(params: Record<string, unknown>): string {
  const value = params["*"] ?? params.relativePath;
  return typeof value === "string" ? decodeURIComponent(value) : "";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export { DocumentError };
