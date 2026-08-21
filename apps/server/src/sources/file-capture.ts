import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeSourceIdentity } from "./identity.js";

export interface FileCaptureLimits {
  maxBytes: number;
  maxDiagnosticLength: number;
}

export const defaultFileCaptureLimits: FileCaptureLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxDiagnosticLength: 500,
};

export interface FileCaptureOptions {
  limits?: Partial<FileCaptureLimits>;
  /** Used by tests and local adapters; production callers should use the real filesystem. */
  openImpl?: typeof open;
  realpathImpl?: typeof realpath;
}

export interface FileCaptureResult {
  state: "archived" | "metadata-only" | "unavailable" | "failed";
  bytes?: Uint8Array;
  checksum?: string;
  byteLength: number;
  mediaType: string;
  readableMediaType?: string;
  originalPath: string;
  metadata: { title?: string; language?: string };
  diagnostic?: { code: string; message: string };
}

export class FileCaptureError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly terminalState: "metadata-only" | "unavailable" | "failed" = "failed",
  ) {
    super(message);
    this.name = "FileCaptureError";
  }
}

function boundedMessage(message: string, limit: number): string {
  return message.length <= limit ? message : `${message.slice(0, Math.max(0, limit - 1))}…`;
}

function mediaTypeFor(filePath: string): { mediaType: string; readableMediaType?: string } {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm": return { mediaType: "text/html" };
    case ".txt": return { mediaType: "text/plain", readableMediaType: "text/plain" };
    case ".md":
    case ".markdown": return { mediaType: "text/markdown", readableMediaType: "text/markdown" };
    case ".json": return { mediaType: "application/json", readableMediaType: "application/json" };
    case ".csv": return { mediaType: "text/csv", readableMediaType: "text/plain" };
    case ".pdf": return { mediaType: "application/pdf" };
    default: return { mediaType: "application/octet-stream" };
  }
}

function textMetadata(bytes: Uint8Array, mediaType: string): { title?: string; language?: string } {
  if (mediaType !== "text/html") return {};
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const language = text.match(/<html[^>]+\blang=["']([^"']+)["']/i)?.[1]?.trim();
  return { ...(title ? { title: title.slice(0, 4096) } : {}), ...(language ? { language: language.slice(0, 4096) } : {}) };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Snapshot one project-contained regular file. It rejects symlinks before and
 * after opening, bounds the stream, and hashes the exact bytes that are read.
 */
export async function captureFileSource(value: string, baseDir: string, options: FileCaptureOptions = {}, signal = new AbortController().signal): Promise<FileCaptureResult> {
  const limits = { ...defaultFileCaptureLimits, ...options.limits };
  const identity = normalizeSourceIdentity({ kind: "file", value, baseDir });
  if (signal.aborted) throw new FileCaptureError("CANCELLED", "Capture was cancelled", "failed");
  const relativePath = identity.slice("file:".length).split("/").join(path.sep);
  const root = path.resolve(baseDir);
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) throw new FileCaptureError("PATH_OUTSIDE_ROOT", "Local source must remain inside the authorized project directory", "unavailable");

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(candidate, { bigint: false });
    if (before.isSymbolicLink()) throw new FileCaptureError("SYMLINK_NOT_ALLOWED", "Local source symlinks are not allowed", "unavailable");
    if (!before.isFile()) throw new FileCaptureError("NOT_REGULAR_FILE", "Local source must be a regular file", "unavailable");
    if (before.size > limits.maxBytes) throw new FileCaptureError("FILE_TOO_LARGE", `File exceeds the ${limits.maxBytes}-byte capture limit`, "metadata-only");
    if (signal.aborted) throw new FileCaptureError("CANCELLED", "Capture was cancelled", "failed");
    const resolved = await (options.realpathImpl ?? realpath)(candidate);
    if (!isWithin(root, resolved)) throw new FileCaptureError("PATH_OUTSIDE_ROOT", "Local source must remain inside the authorized project directory", "unavailable");
    handle = await (options.openImpl ?? open)(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limits.maxBytes) throw new FileCaptureError("FILE_CHANGED", "Local source changed before capture", "unavailable");

    const chunks: Uint8Array[] = [];
    const hash = createHash("sha256");
    let total = 0;
    const chunkSize = 64 * 1024;
    for (;;) {
      if (signal.aborted) throw new FileCaptureError("CANCELLED", "Capture was cancelled", "failed");
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limits.maxBytes) throw new FileCaptureError("FILE_TOO_LARGE", `File exceeds the ${limits.maxBytes}-byte capture limit`, "metadata-only");
      const chunk = new Uint8Array(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (after.size !== opened.size) throw new FileCaptureError("FILE_CHANGED", "Local source changed during capture", "unavailable");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const type = mediaTypeFor(candidate);
    return {
      state: "archived",
      bytes,
      checksum: hash.digest("hex"),
      byteLength: total,
      ...type,
      originalPath: relativePath.split(path.sep).join("/"),
      metadata: textMetadata(bytes, type.mediaType),
    };
  } catch (error) {
    if (error instanceof FileCaptureError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileCaptureError("FILE_NOT_FOUND", "Local source file was not found", "unavailable");
    if (code === "EACCES" || code === "EPERM") throw new FileCaptureError("FILE_UNREADABLE", "Local source file could not be read", "unavailable");
    if (code === "ELOOP") throw new FileCaptureError("SYMLINK_NOT_ALLOWED", "Local source symlinks are not allowed", "unavailable");
    throw new FileCaptureError("FILE_CAPTURE_FAILED", "Local source could not be captured", "failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function diagnosticForFileError(error: unknown, maxLength = defaultFileCaptureLimits.maxDiagnosticLength): { code: string; message: string } {
  if (error instanceof FileCaptureError) return { code: error.code, message: boundedMessage(error.message, maxLength) };
  return { code: "CAPTURE_FAILED", message: boundedMessage("Local file capture failed", maxLength) };
}
