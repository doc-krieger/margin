import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  partialArtifactReferenceSchema,
  type PartialArtifactReference,
  type ResearchArtifactKind,
} from "../../../../packages/shared/src/research/contracts.js";

export interface ResearchArtifactOutput {
  kind: ResearchArtifactKind;
  content: string;
  relativePath?: string;
  artifactId?: string;
  label?: string;
  status?: "partial" | "complete" | "failed";
}

export class ResearchWorkflowError extends Error {
  constructor(public readonly code: "RESEARCH_OUTPUT_PATH_INVALID" | "RESEARCH_OUTPUT_PATH_COLLISION" | "RESEARCH_ARTIFACT_WRITE_FAILED", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResearchWorkflowError";
  }
}

function safeRelativePath(value: string): string {
  if (!value || path.posix.isAbsolute(value) || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new ResearchWorkflowError("RESEARCH_OUTPUT_PATH_INVALID", "Research artifact paths must be non-empty relative paths outside .git");
  }
  return value;
}

function safeArtifactId(value: string | undefined, kind: ResearchArtifactKind, content: string): string {
  const candidate = value ?? `artifact-${kind}-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(candidate)) throw new ResearchWorkflowError("RESEARCH_OUTPUT_PATH_INVALID", "Research artifact ID contains unsafe characters");
  return candidate;
}

function defaultPath(kind: ResearchArtifactKind): string {
  switch (kind) {
    case "notes": return "research/notes.md";
    case "report": return "research/report.md";
    case "source-manifest": return "research/sources.yaml";
    case "proposal": return "research/proposal.json";
    default: return `research/${kind}.txt`;
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Writes one complete artifact into the isolated worktree and returns only bounded metadata. */
export async function materializeResearchArtifact(
  worktreePath: string,
  output: ResearchArtifactOutput,
  options: { relativePath?: string; now?: string; overwrite?: boolean } = {},
): Promise<PartialArtifactReference> {
  const relativePath = safeRelativePath(output.relativePath ?? options.relativePath ?? defaultPath(output.kind));
  const artifactId = safeArtifactId(output.artifactId, output.kind, output.content);
  const destination = path.resolve(worktreePath, ...relativePath.split("/"));
  const root = path.resolve(worktreePath);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new ResearchWorkflowError("RESEARCH_OUTPUT_PATH_INVALID", "Research artifact path escapes the worktree");
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const parentStats = await lstat(current).catch(() => undefined);
    if (parentStats?.isSymbolicLink() || (parentStats && !parentStats.isDirectory())) throw new ResearchWorkflowError("RESEARCH_ARTIFACT_WRITE_FAILED", `Research artifact parent is unsafe: ${relativePath}`);
  }
  const existing = await lstat(destination).catch(() => undefined);
  if (existing && !options.overwrite) throw new ResearchWorkflowError("RESEARCH_OUTPUT_PATH_COLLISION", `Research output path already exists: ${relativePath}`);
  if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new ResearchWorkflowError("RESEARCH_ARTIFACT_WRITE_FAILED", `Research artifact destination is not a regular file: ${relativePath}`);
  const createdAt = options.now ?? new Date().toISOString();
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output.content, { encoding: "utf8", mode: 0o644, flag: "w" });
    const bytes = Buffer.byteLength(output.content, "utf8");
    return partialArtifactReferenceSchema.parse({
      artifactId,
      kind: output.kind,
      status: output.status ?? "complete",
      relativePath,
      label: output.label ?? `${output.kind} artifact`,
      bytes,
      sha256: hash(output.content),
      createdAt,
      updatedAt: createdAt,
    });
  } catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    throw new ResearchWorkflowError("RESEARCH_ARTIFACT_WRITE_FAILED", `Unable to materialize research artifact: ${relativePath}`, { cause: error });
  }
}

export function artifactHash(content: string): string {
  return hash(content);
}

/** Describes an artifact already written by the source projection boundary. */
export async function describeResearchArtifact(
  worktreePath: string,
  output: { kind: ResearchArtifactKind; relativePath: string; artifactId?: string; label?: string; status?: "partial" | "complete" | "failed" },
  now = new Date().toISOString(),
): Promise<PartialArtifactReference> {
  const relativePath = safeRelativePath(output.relativePath);
  const destination = path.resolve(worktreePath, ...relativePath.split("/"));
  const stats = await lstat(destination).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) throw new ResearchWorkflowError("RESEARCH_ARTIFACT_WRITE_FAILED", `Research artifact is not a regular file: ${relativePath}`);
  const content = await readFile(destination);
  const text = content.toString("utf8");
  return partialArtifactReferenceSchema.parse({
    artifactId: safeArtifactId(output.artifactId, output.kind, text),
    kind: output.kind,
    status: output.status ?? "complete",
    relativePath,
    label: output.label ?? `${output.kind} artifact`,
    bytes: content.byteLength,
    sha256: hash(text),
    createdAt: now,
    updatedAt: now,
  });
}

export async function readResearchArtifact(worktreePath: string, relativePath: string): Promise<string> {
  const safePath = safeRelativePath(relativePath);
  return readFile(path.resolve(worktreePath, ...safePath.split("/")), "utf8");
}
