import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import lockfile from "proper-lockfile";
import {
  makeEmptySourceManifest,
  evidenceVersionSchema,
  sourceManifestSchema,
  sourceRecordSchema,
  type EvidenceVersion,
  type SourceManifest,
  type SourceManifestMutation,
  type SourceRecord,
} from "../../../../packages/shared/src/sources/contracts.js";

export type SourceStoreErrorCode = "INVALID_SOURCE_ID" | "INVALID_MANIFEST" | "INVALID_RECORD" | "IO_ERROR" | "LOCK_ERROR" | "EVIDENCE_CONFLICT";

export class SourceStoreError extends Error {
  constructor(public readonly code: SourceStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SourceStoreError";
  }
}

export interface SourceStore {
  get(sourceId: string): Promise<SourceRecord | null>;
  getByIdentity(identity: string): Promise<SourceRecord | null>;
  list(): Promise<SourceRecord[]>;
  save(record: SourceRecord): Promise<void>;
  transact<T>(mutation: SourceManifestMutation<T>): Promise<T>;
  putEvidence(sourceId: string, version: EvidenceVersion, bytes: Uint8Array): Promise<void>;
  readEvidence(sourceId: string, version: EvidenceVersion): Promise<Uint8Array>;
}

export interface FileSourceStoreOptions {
  manifestName?: string;
  lockStaleMs?: number;
}

function validSourceId(sourceId: string): boolean {
  return /^src_[a-f0-9]{16,64}$/.test(sourceId);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseManifest(contents: string, filePath: string): SourceManifest {
  try {
    return sourceManifestSchema.parse(parse(contents));
  } catch (error) {
    throw new SourceStoreError("INVALID_MANIFEST", `Source manifest is invalid: ${filePath}`, { cause: error });
  }
}

/**
 * YAML-backed source repository. Manifest replacement is atomic and every
 * read-modify-write transaction is protected by an inter-process lock.
 */
export class FileSourceStore implements SourceStore {
  private readonly manifestPath: string;
  private readonly lockStaleMs: number;
  private readonly evidenceRoot: string;
  private initialized?: Promise<void>;

  constructor(private readonly root: string, options: FileSourceStoreOptions = {}) {
    this.manifestPath = path.join(root, options.manifestName ?? "manifest.yaml");
    this.evidenceRoot = path.join(root, "evidence");
    this.lockStaleMs = Math.max(options.lockStaleMs ?? 30_000, 2_000);
  }

  async get(sourceId: string): Promise<SourceRecord | null> {
    assertSourceId(sourceId);
    const manifest = await this.readManifest();
    const record = manifest.sources.find((source) => source.sourceId === sourceId);
    return record ? clone(record) : null;
  }

  async getByIdentity(identity: string): Promise<SourceRecord | null> {
    const manifest = await this.readManifest();
    const record = manifest.sources.find((source) => source.identity === identity || source.aliases.includes(identity));
    return record ? clone(record) : null;
  }

  async list(): Promise<SourceRecord[]> {
    const manifest = await this.readManifest();
    return manifest.sources.map(clone);
  }

  async save(record: SourceRecord): Promise<void> {
    const parsed = parseRecord(record);
    await this.transact((manifest) => {
      const index = manifest.sources.findIndex((source) => source.sourceId === parsed.sourceId);
      if (index === -1) manifest.sources.push(parsed);
      else manifest.sources[index] = parsed;
    });
  }

  async transact<T>(mutation: SourceManifestMutation<T>): Promise<T> {
    await this.ensureInitialized();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.manifestPath, {
        stale: this.lockStaleMs,
        retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
        realpath: false,
      });
      const manifest = await this.readManifest();
      const result = await mutation(manifest);
      manifest.updatedAt = new Date().toISOString();
      const parsed = sourceManifestSchema.parse(manifest);
      await this.writeManifest(parsed);
      return result;
    } catch (error) {
      if (error instanceof SourceStoreError) throw error;
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new SourceStoreError("LOCK_ERROR", "Unable to acquire source manifest lock", { cause: error });
      }
      if (error instanceof Error && error.name === "ZodError") {
        throw new SourceStoreError("INVALID_MANIFEST", "Source transaction produced an invalid manifest", { cause: error });
      }
      throw new SourceStoreError("IO_ERROR", `Unable to update source manifest: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (release) await release();
    }
  }

  async putEvidence(sourceId: string, version: EvidenceVersion, bytes: Uint8Array): Promise<void> {
    assertSourceId(sourceId);
    let parsedVersion: EvidenceVersion;
    try {
      parsedVersion = evidenceVersionSchema.parse(version);
    } catch (error) {
      throw new SourceStoreError("INVALID_RECORD", "Evidence version does not satisfy the source contract", { cause: error });
    }
    const actualChecksum = createHash("sha256").update(bytes).digest("hex");
    if (actualChecksum !== parsedVersion.checksum || bytes.byteLength !== parsedVersion.byteLength) {
      throw new SourceStoreError("EVIDENCE_CONFLICT", "Evidence bytes do not match the declared immutable version");
    }
    await this.ensureInitialized();
    const target = this.evidencePath(sourceId, parsedVersion);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (Buffer.compare(existing, Buffer.from(bytes)) !== 0) throw new SourceStoreError("EVIDENCE_CONFLICT", `Evidence version ${parsedVersion.versionId} already contains different bytes`);
    } catch (error) {
      if (error instanceof SourceStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SourceStoreError("IO_ERROR", `Unable to read evidence ${parsedVersion.versionId}`, { cause: error });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, target);
      } catch (renameError) {
        try { await stat(target); } catch { throw new SourceStoreError("IO_ERROR", `Unable to publish evidence ${parsedVersion.versionId}`, { cause: renameError }); }
      }
    }
  }

  async readEvidence(sourceId: string, version: EvidenceVersion): Promise<Uint8Array> {
    assertSourceId(sourceId);
    const parsedVersion = evidenceVersionSchema.parse(version);
    const target = this.evidencePath(sourceId, parsedVersion);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      throw new SourceStoreError("IO_ERROR", `Unable to read evidence ${version.versionId}`, { cause: error });
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true });
      await mkdir(this.evidenceRoot, { recursive: true });
      try {
        await stat(this.manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await writeFile(this.manifestPath, stringify(makeEmptySourceManifest()), { encoding: "utf8", mode: 0o600, flag: "wx" });
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        }
      }
    })();
    return this.initialized;
  }

  private async readManifest(): Promise<SourceManifest> {
    await this.ensureInitialized();
    try {
      return parseManifest(await readFile(this.manifestPath, "utf8"), this.manifestPath);
    } catch (error) {
      if (error instanceof SourceStoreError) throw error;
      throw new SourceStoreError("IO_ERROR", `Unable to read source manifest ${this.manifestPath}`, { cause: error });
    }
  }

  private async writeManifest(manifest: SourceManifest): Promise<void> {
    const temporary = `${this.manifestPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporary, stringify(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.manifestPath);
    } catch (error) {
      throw new SourceStoreError("IO_ERROR", `Unable to atomically write source manifest ${this.manifestPath}`, { cause: error });
    } finally {
      try { await unlink(temporary); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort cleanup */ }
      }
    }
  }

  private evidencePath(sourceId: string, version: EvidenceVersion): string {
    return path.join(this.evidenceRoot, sourceId, `${version.versionId}-${version.checksum}.bin`);
  }
}

export class MemorySourceStore implements SourceStore {
  private manifest = makeEmptySourceManifest();
  private readonly evidence = new Map<string, Uint8Array>();
  private chain: Promise<unknown> = Promise.resolve();

  async get(sourceId: string): Promise<SourceRecord | null> {
    assertSourceId(sourceId);
    const record = this.manifest.sources.find((source) => source.sourceId === sourceId);
    return record ? clone(record) : null;
  }

  async getByIdentity(identity: string): Promise<SourceRecord | null> {
    const record = this.manifest.sources.find((source) => source.identity === identity || source.aliases.includes(identity));
    return record ? clone(record) : null;
  }

  async list(): Promise<SourceRecord[]> {
    return this.manifest.sources.map(clone);
  }

  async save(record: SourceRecord): Promise<void> {
    await this.transact((manifest) => {
      const parsed = parseRecord(record);
      const index = manifest.sources.findIndex((source) => source.sourceId === parsed.sourceId);
      if (index === -1) manifest.sources.push(parsed);
      else manifest.sources[index] = parsed;
    });
  }

  async transact<T>(mutation: SourceManifestMutation<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const result = await mutation(this.manifest);
      this.manifest = sourceManifestSchema.parse(this.manifest);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async putEvidence(sourceId: string, version: EvidenceVersion, bytes: Uint8Array): Promise<void> {
    assertSourceId(sourceId);
    const actualChecksum = createHash("sha256").update(bytes).digest("hex");
    if (actualChecksum !== version.checksum || bytes.byteLength !== version.byteLength) throw new SourceStoreError("EVIDENCE_CONFLICT", "Evidence bytes do not match the declared immutable version");
    const key = `${version.versionId}:${version.checksum}`;
    const existing = this.evidence.get(key);
    if (existing && Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) throw new SourceStoreError("EVIDENCE_CONFLICT", "Evidence version already contains different bytes");
    this.evidence.set(key, new Uint8Array(bytes));
  }

  async readEvidence(sourceId: string, version: EvidenceVersion): Promise<Uint8Array> {
    assertSourceId(sourceId);
    const bytes = this.evidence.get(`${version.versionId}:${version.checksum}`);
    if (!bytes) throw new SourceStoreError("IO_ERROR", `Evidence ${version.versionId} is unavailable`);
    return new Uint8Array(bytes);
  }
}

function parseRecord(record: SourceRecord): SourceRecord {
  try {
    return sourceRecordSchema.parse(clone(record));
  } catch (error) {
    throw new SourceStoreError("INVALID_RECORD", "Source record does not satisfy the source contract", { cause: error });
  }
}

function assertSourceId(sourceId: string): void {
  if (!validSourceId(sourceId)) throw new SourceStoreError("INVALID_SOURCE_ID", `Invalid source ID: ${sourceId}`);
}
