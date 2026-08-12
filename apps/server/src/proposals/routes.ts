import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ProjectLifecycleService } from "../projects/service.js";
import { ProposalNotFoundError, ProposalService } from "./service.js";
import type { ProposalRecord } from "./store.js";

interface ProposalParams {
  projectId: string;
  proposalId: string;
  "*"?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function decodeFilePath(params: ProposalParams): string {
  return decodeURIComponent(requiredString(params["*"], "path"));
}

function review(record: ProposalRecord) {
  return {
    proposal: {
      proposalId: record.proposalId,
      runId: record.runId,
      status: record.status,
      checkpoint: { sha: record.checkpoint.sha, ref: record.checkpoint.ref },
      decision: record.decision,
      updatedAt: record.updatedAt,
      cleanup: record.cleanup,
    },
    diff: record.diff,
  };
}

async function requireProjectProposal(
  service: ProposalService,
  projects: ProjectLifecycleService,
  projectId: string,
  proposalId: string,
): Promise<ProposalRecord> {
  const project = projects.getProject(projectId);
  if (!project) throw new ProposalNotFoundError(proposalId);
  const proposal = await service.get(proposalId);
  if (path.resolve(proposal.repositoryRoot) !== path.resolve(project.path)) throw new ProposalNotFoundError(proposalId);
  return proposal;
}

export function registerProposalRoutes(
  app: FastifyInstance,
  service: ProposalService,
  projects: ProjectLifecycleService,
): void {
  app.get("/api/projects/:projectId/proposals/:proposalId", async (request, reply) => {
    const { projectId, proposalId } = request.params as ProposalParams;
    const stored = await requireProjectProposal(service, projects, projectId, proposalId);
    const proposal = stored.status === "pending" ? await service.refresh(proposalId) : stored;
    if (proposal.status !== "pending") await service.syncCleanup(proposalId);
    return reply.header("x-correlation-id", request.id).send({ review: review(proposal) });
  });

  app.get("/api/projects/:projectId/proposals/:proposalId/files/*", async (request, reply) => {
    const params = request.params as ProposalParams;
    await requireProjectProposal(service, projects, params.projectId, params.proposalId);
    return reply.header("x-correlation-id", request.id).send(await service.readFile(params.proposalId, decodeFilePath(params)));
  });

  app.put("/api/projects/:projectId/proposals/:proposalId/files/*", async (request, reply) => {
    const params = request.params as ProposalParams;
    await requireProjectProposal(service, projects, params.projectId, params.proposalId);
    const body = asRecord(request.body);
    const proposal = await service.editFile(params.proposalId, {
      path: decodeFilePath(params),
      content: stringValue(body.content, "content"),
      expectedHash: requiredString(body.expectedHash ?? body.baseHash, "expectedHash"),
    });
    return reply.header("x-correlation-id", request.id).send({ review: review(proposal) });
  });

  app.post("/api/projects/:projectId/proposals/:proposalId/decision", async (request, reply) => {
    const { projectId, proposalId } = request.params as ProposalParams;
    await requireProjectProposal(service, projects, projectId, proposalId);
    const decision = asRecord(request.body).decision;
    if (decision !== "keep" && decision !== "reject") throw new TypeError("decision must be keep or reject");
    const proposal = await service.decide(proposalId, decision);
    return reply.header("x-correlation-id", request.id).send({ review: review(proposal) });
  });
}
