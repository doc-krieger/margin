import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_MANIFEST_FILENAME, scanProjectFolder, type ScannedFile } from "../filesystem/index.js";
import { resolveRegisteredPath } from "../safety/paths.js";
import { ProjectLifecycleService } from "../projects/service.js";

export interface DocumentEntry {
  path: string;
  name: string;
  kind: "file";
  extension: string;
  sizeBytes: number;
}

export interface DocumentTreeNode {
  path: string;
  name: string;
  kind: "directory" | "file";
  children?: DocumentTreeNode[];
}

export interface DocumentList {
  documents: DocumentEntry[];
  tree: DocumentTreeNode[];
}

export interface DocumentSnapshot {
  path: string;
  content: string;
  hash: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface DocumentSaveInput {
  path?: string;
  relativePath?: string;
  content: string;
  baseHash?: string;
  expectedHash?: string;
}

export type DocumentErrorCode =
  | "DOCUMENT_PROJECT_NOT_FOUND"
  | "DOCUMENT_PATH_REQUIRED"
  | "DOCUMENT_PATH_INVALID"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_NOT_FILE"
  | "DOCUMENT_NOT_TEXT"
  | "DOCUMENT_CONFLICT"
  | "DOCUMENT_WRITE_FAILED";

export class DocumentError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DocumentError";
  }
}

/** Filesystem-canonical document access with optimistic concurrency protection. */
export class DocumentService {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly projects: ProjectLifecycleService) {}

  async listDocuments(projectId: string): Promise<DocumentList> {
    const project = this.projects.getProject(projectId);
    if (!project) throw new DocumentError("DOCUMENT_PROJECT_NOT_FOUND", "Project is not registered");
    const scan = await scanProjectFolder(project.path);
    const documents = scan.files
      .filter((file) => path.posix.basename(file.relativePath) !== PROJECT_MANIFEST_FILENAME)
      .map(toDocumentEntry)
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return { documents, tree: makeTree(documents) };
  }

  async readDocument(projectId: string, requestedPath: string): Promise<DocumentSnapshot> {
    const filePath = await this.resolveDocument(projectId, requestedPath);
    return this.readSnapshot(requestedPath, filePath);
  }

  async saveDocument(projectId: string, input: DocumentSaveInput): Promise<DocumentSnapshot> {
    if (typeof input.content !== "string") {
      throw new DocumentError("DOCUMENT_WRITE_FAILED", "Document content must be a string");
    }
    const requestedPath = input.path ?? input.relativePath;
    const filePath = await this.resolveDocument(projectId, requestedPath);
    const expectedHash = input.baseHash ?? input.expectedHash;
    if (!expectedHash) throw new DocumentError("DOCUMENT_CONFLICT", "A baseHash is required before saving a document");
    const key = `${projectId}:${filePath}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.readSnapshot(requestedPath as string, filePath);
      if (current.hash !== expectedHash) {
        throw new DocumentError(
          "DOCUMENT_CONFLICT",
          "The document changed on disk before it could be saved",
          { path: requestedPath, baseHash: expectedHash, currentHash: current.hash, modifiedAt: current.modifiedAt },
        );
      }
      const stats = await lstat(filePath).catch((error) => {
        throw new DocumentError("DOCUMENT_NOT_FOUND", "Document no longer exists", undefined, { cause: error });
      });
      const temporaryPath = path.join(path.dirname(filePath), `.margin-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, input.content, { encoding: "utf8", mode: stats.mode & 0o777 });
        await chmod(temporaryPath, stats.mode & 0o777);
        await rename(temporaryPath, filePath);
      } catch (error) {
        await import("node:fs/promises").then(({ unlink }) => unlink(temporaryPath).catch(() => undefined));
        throw new DocumentError("DOCUMENT_WRITE_FAILED", "Unable to save the document", undefined, { cause: error });
      }
      return this.readSnapshot(requestedPath as string, filePath);
    });
    this.writes.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(key) === operation) this.writes.delete(key);
    }
  }

  private async resolveDocument(projectId: string, requestedPath: string | undefined): Promise<string> {
    const project = this.projects.getProject(projectId);
    if (!project) throw new DocumentError("DOCUMENT_PROJECT_NOT_FOUND", "Project is not registered");
    if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new DocumentError("DOCUMENT_PATH_REQUIRED", "A document path is required");
    if (path.posix.isAbsolute(requestedPath) || path.isAbsolute(requestedPath) || requestedPath.includes("\\") || requestedPath.split("/").some((part) => part === "..")) {
      throw new DocumentError("DOCUMENT_PATH_INVALID", "Document path must be relative and remain inside the project");
    }
    let filePath: string;
    try {
      filePath = await resolveRegisteredPath(project.path, requestedPath);
    } catch (error) {
      throw new DocumentError("DOCUMENT_PATH_INVALID", "Document path does not resolve inside the project", undefined, { cause: error });
    }
    const stats = await lstat(filePath).catch(() => undefined);
    if (!stats) throw new DocumentError("DOCUMENT_NOT_FOUND", "Document does not exist", { path: requestedPath });
    if (stats.isSymbolicLink() || !stats.isFile()) throw new DocumentError("DOCUMENT_NOT_FILE", "Document path is not a regular file", { path: requestedPath });
    if (stats.size > 10 * 1024 * 1024) throw new DocumentError("DOCUMENT_NOT_TEXT", "Documents larger than 10 MiB are not editable", { path: requestedPath });
    return filePath;
  }

  private async readSnapshot(requestedPath: string, filePath: string): Promise<DocumentSnapshot> {
    try {
      const [content, stats] = await Promise.all([readFile(filePath, "utf8"), lstat(filePath)]);
      return { path: requestedPath, content, hash: hashContent(content), sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE") {
        throw new DocumentError("DOCUMENT_NOT_TEXT", "Document is not valid UTF-8 text", undefined, { cause: error });
      }
      throw new DocumentError("DOCUMENT_NOT_FOUND", "Unable to read document", undefined, { cause: error });
    }
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function toDocumentEntry(file: ScannedFile): DocumentEntry {
  return { path: file.relativePath, name: path.posix.basename(file.relativePath), kind: "file", extension: file.extension, sizeBytes: file.sizeBytes };
}

function makeTree(documents: DocumentEntry[]): DocumentTreeNode[] {
  const roots: DocumentTreeNode[] = [];
  for (const document of documents) {
    const parts = document.path.split("/");
    let siblings = roots;
    let builtPath = "";
    parts.forEach((part, index) => {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      const existing = siblings.find((node) => node.name === part);
      if (index === parts.length - 1) {
        if (!existing) siblings.push(document);
        return;
      }
      const directory = existing ?? { path: builtPath, name: part, kind: "directory" as const, children: [] };
      if (!existing) siblings.push(directory);
      siblings = directory.children ?? (directory.children = []);
    });
  }
  return roots;
}
