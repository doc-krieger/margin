import type { FastifyInstance } from "fastify";
import {
  ProjectLifecycleError,
  ProjectLifecycleService,
  type ProjectCreateInput,
  type ProjectOpenOptions,
} from "./service.js";

export function registerProjectRoutes(app: FastifyInstance, service: ProjectLifecycleService): void {
  app.get("/api/projects/roots", async (request, reply) => reply.header("x-correlation-id", request.id).send({ roots: service.listRoots() }));
  app.post("/api/projects/roots", async (request, reply) => {
    const body = asRecord(request.body);
    const rootPath = requiredString(body.path ?? body.rootPath, "A root path is required");
    const root = await service.registerRoot(rootPath);
    return reply.header("x-correlation-id", request.id).code(201).send({ root });
  });

  app.post("/api/projects/open", async (request, reply) => {
    const body = asRecord(request.body);
    const projectPath = requiredString(body.path ?? body.projectPath, "A project path is required");
    const result = await service.openProject(projectPath, toOpenOptions(body));
    return reply.header("x-correlation-id", request.id).send(result);
  });
  app.post("/api/projects", async (request, reply) => {
    const body = asRecord(request.body);
    const result = await service.createProject(toCreateInput(body));
    return reply.header("x-correlation-id", request.id).code(201).send(result);
  });
  app.get("/api/projects/:projectId", async (request, reply) => {
    const params = request.params as { projectId?: string };
    const project = params.projectId ? service.getProject(params.projectId) : undefined;
    if (!project) throw new ProjectLifecycleError("PROJECT_NOT_FOUND", "Project is not registered");
    return reply.header("x-correlation-id", request.id).send({ project });
  });
  app.get("/api/projects", async (request, reply) => reply.header("x-correlation-id", request.id).send({ projects: service.listProjects() }));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", "Request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", message);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", `${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", `${field} must be a string`);
  return value;
}

function toOpenOptions(body: Record<string, unknown>): ProjectOpenOptions {
  return {
    gitDecision: optionalString(body.gitDecision, "gitDecision") as ProjectOpenOptions["gitDecision"],
    confirmGitInitialization: optionalBoolean(body.confirmGitInitialization, "confirmGitInitialization"),
    initializeGit: optionalBoolean(body.initializeGit, "initializeGit"),
    duplicateIdentityDecision: optionalString(body.duplicateIdentityDecision, "duplicateIdentityDecision") as ProjectOpenOptions["duplicateIdentityDecision"],
    assignNewIdentity: optionalBoolean(body.assignNewIdentity, "assignNewIdentity"),
  };
}

function toCreateInput(body: Record<string, unknown>): ProjectCreateInput {
  return {
    path: optionalString(body.path, "path"),
    projectPath: optionalString(body.projectPath, "projectPath"),
    rootPath: optionalString(body.rootPath, "rootPath"),
    parentPath: optionalString(body.parentPath, "parentPath"),
    name: optionalString(body.name, "name"),
    ...toOpenOptions(body),
  };
}
