import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { FileSourceStore, type SourceStore } from "./store.js";
import { SourceCaptureService, type SourceCaptureServiceOptions } from "./service.js";

export interface SourceEvidenceSelection {
  sourceId: string;
  versionId: string;
  required?: boolean;
}

export interface ProjectEvidenceInput {
  worktreePath: string;
  selections: SourceEvidenceSelection[];
  runId?: string;
}

export interface ProjectedEvidenceEntry {
  sourceId: string;
  versionId: string;
  checksum: string;
  byteLength: number;
  mediaType: string;
  required: boolean;
  relativePath: string;
}

export interface MissingEvidenceEntry {
  sourceId: string;
  versionId: string;
  required: boolean;
  code: "SOURCE_NOT_FOUND" | "VERSION_NOT_FOUND" | "EVIDENCE_UNAVAILABLE";
  message: string;
}

export interface SourceProjectionResult {
  status: "ready" | "partial";
  relativeRoot: string;
  manifestPath: string;
  entries: ProjectedEvidenceEntry[];
  missing: MissingEvidenceEntry[];
  generatedAt: string;
}

export type SourceProjectionErrorCode =
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_NOT_DIRECTORY"
  | "WORKTREE_NOT_ISOLATED"
  | "WORKTREE_UNSAFE"
  | "PROJECTION_WRITE_FAILED"
  | "PROJECTION_CHECKSUM_FAILED";

export class SourceProjectionError extends Error {
  constructor(public readonly code: SourceProjectionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SourceProjectionError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeRunId(runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
    throw new SourceProjectionError("WORKTREE_UNSAFE", "Projection run ID contains unsafe path characters");
  }
  return runId;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoSymlinkPath(root: string, relativePath: string, createFinalDirectory = false): Promise<string> {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!within(root, absolute)) throw new SourceProjectionError("WORKTREE_UNSAFE", "Projection path escapes the research worktree");
  const parts = relativePath.split("/").filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stats = await lstat(current).catch(() => undefined);
    if (!stats) {
      if (createFinalDirectory || index < parts.length - 1) await mkdir(current, { recursive: false });
      continue;
    }
    if (stats.isSymbolicLink()) throw new SourceProjectionError("WORKTREE_UNSAFE", `Projection path contains a symbolic link: ${relativePath}`);
    if (index < parts.length - 1 && !stats.isDirectory()) throw new SourceProjectionError("WORKTREE_UNSAFE", `Projection parent is not a directory: ${relativePath}`);
  }
  return absolute;
}

async function resolveIsolatedWorktree(worktreePath: string, canonicalRoot: string): Promise<string> {
  const listed = await lstat(worktreePath).catch(() => undefined);
  if (!listed) throw new SourceProjectionError("WORKTREE_NOT_FOUND", "Research worktree does not exist");
  if (listed.isSymbolicLink()) throw new SourceProjectionError("WORKTREE_UNSAFE", "Research worktree symlinks are not allowed");
  const worktree = await realpath(worktreePath).catch(() => undefined);
  if (!worktree) throw new SourceProjectionError("WORKTREE_NOT_FOUND", "Research worktree does not exist");
  const stats = await lstat(worktree);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SourceProjectionError("WORKTREE_NOT_DIRECTORY", "Research worktree must be a directory");
  const canonical = await realpath(canonicalRoot).catch(() => path.resolve(canonicalRoot));
  if (within(canonical, worktree) || within(worktree, canonical)) {
    throw new SourceProjectionError("WORKTREE_NOT_ISOLATED", "Research worktree must be separate from canonical source storage");
  }
  return worktree;
}

function entryPath(relativeRoot: string, sourceId: string, versionId: string): string {
  return `${relativeRoot}/evidence/${sourceId}/${versionId}.bin`;
}

async function materialize(
  worktree: string,
  relativePath: string,
  bytes: Uint8Array,
  expectedChecksum: string,
): Promise<void> {
  const destination = await assertNoSymlinkPath(worktree, relativePath);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink() || existing?.isDirectory()) {
    throw new SourceProjectionError("WORKTREE_UNSAFE", `Projection destination is not a regular file: ${relativePath}`);
  }
  if (existing) {
    const current = await readFile(destination);
    const checksum = createHash("sha256").update(current).digest("hex");
    if (checksum !== expectedChecksum || current.byteLength !== bytes.byteLength) {
      throw new SourceProjectionError("PROJECTION_WRITE_FAILED", `Projection destination already contains different evidence: ${relativePath}`);
    }
    return;
  }
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o444 });
    const copied = await readFile(temporary);
    const checksum = createHash("sha256").update(copied).digest("hex");
    if (checksum !== expectedChecksum || copied.byteLength !== bytes.byteLength) {
      throw new SourceProjectionError("PROJECTION_CHECKSUM_FAILED", `Projected evidence checksum did not verify: ${relativePath}`);
    }
    await rename(temporary, destination);
    await chmod(destination, 0o444);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof SourceProjectionError) throw error;
    throw new SourceProjectionError("PROJECTION_WRITE_FAILED", `Unable to materialize projected evidence: ${relativePath}`, { cause: error });
  }
}

async function writeProjectionManifest(worktree: string, relativePath: string, result: SourceProjectionResult): Promise<void> {
  const target = await assertNoSymlinkPath(worktree, relativePath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const document = {
    schemaVersion: 1,
    generatedAt: result.generatedAt,
    relativeRoot: result.relativeRoot,
    entries: result.entries,
    missing: result.missing,
  };
  try {
    await writeFile(temporary, stringify(document), { encoding: "utf8", flag: "wx", mode: 0o444 });
    await rename(temporary, target);
    await chmod(target, 0o444);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof SourceProjectionError) throw error;
    throw new SourceProjectionError("PROJECTION_WRITE_FAILED", "Unable to write the research source projection manifest", { cause: error });
  }
}

/** Materializes exact immutable source versions into independent research-worktree bytes. */
export class SourceProjectionService {
  constructor(private readonly store: SourceStore, private readonly canonicalRoot: string) {}

  async project(input: ProjectEvidenceInput): Promise<SourceProjectionResult> {
    const worktree = await resolveIsolatedWorktree(input.worktreePath, this.canonicalRoot);
    const runId = safeRunId(input.runId);
    const relativeRoot = runId ? `research/sources/${runId}` : "research/sources";
    const manifestPath = `${relativeRoot}/manifest.yaml`;
    const generatedAt = new Date().toISOString();
    const entries: ProjectedEvidenceEntry[] = [];
    const missing: MissingEvidenceEntry[] = [];
    const seen = new Set<string>();

    for (const selection of input.selections) {
      if (seen.has(`${selection.sourceId}:${selection.versionId}`)) continue;
      seen.add(`${selection.sourceId}:${selection.versionId}`);
      const required = selection.required !== false;
      const source = await this.store.get(selection.sourceId);
      if (!source) {
        missing.push({ sourceId: selection.sourceId, versionId: selection.versionId, required, code: "SOURCE_NOT_FOUND", message: "The requested source is not available" });
        continue;
      }
      const version = source.versions.find((candidate) => candidate.versionId === selection.versionId);
      if (!version) {
        missing.push({ sourceId: selection.sourceId, versionId: selection.versionId, required, code: "VERSION_NOT_FOUND", message: "The requested evidence version is not available" });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await this.store.readEvidence(source.sourceId, version);
      } catch {
        missing.push({ sourceId: selection.sourceId, versionId: selection.versionId, required, code: "EVIDENCE_UNAVAILABLE", message: "The requested evidence bytes are unavailable" });
        continue;
      }
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== version.checksum || bytes.byteLength !== version.byteLength) {
        missing.push({ sourceId: selection.sourceId, versionId: selection.versionId, required, code: "EVIDENCE_UNAVAILABLE", message: "The requested evidence failed checksum verification" });
        continue;
      }
      const relativePath = entryPath(relativeRoot, source.sourceId, version.versionId);
      await materialize(worktree, relativePath, bytes, version.checksum);
      entries.push({ sourceId: source.sourceId, versionId: version.versionId, checksum: version.checksum, byteLength: version.byteLength, mediaType: version.mediaType, required, relativePath });
    }

    const result: SourceProjectionResult = { status: missing.some((item) => item.required) ? "partial" : "ready", relativeRoot, manifestPath, entries, missing, generatedAt };
    await writeProjectionManifest(worktree, manifestPath, result);
    return clone(result);
  }
}

export interface ProjectSourceServices {
  store: SourceStore;
  capture: SourceCaptureService;
  projection: SourceProjectionService;
}

/** Caches one shared capture/store boundary per registered project. */
export interface SourceServiceRegistryOptions {
  captureOptions?: SourceCaptureServiceOptions;
}

export class SourceServiceRegistry {
  private readonly services = new Map<string, ProjectSourceServices>();

  constructor(private readonly options: SourceServiceRegistryOptions = {}) {}

  forProject(projectRoot: string): ProjectSourceServices {
    const root = path.resolve(projectRoot);
    const existing = this.services.get(root);
    if (existing) return existing;
    const store = new FileSourceStore(path.join(root, "sources"));
    const capture = new SourceCaptureService(store, this.options.captureOptions);
    const projection = new SourceProjectionService(store, root);
    const services = { store, capture, projection };
    this.services.set(root, services);
    return services;
  }
}

