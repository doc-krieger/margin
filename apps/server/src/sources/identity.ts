import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceIdentityRequestSchema, type SourceIdentityRequest, type SourceKind } from "../../../../packages/shared/src/sources/contracts.js";

export class SourceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceIdentityError";
  }
}

function normalizeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new SourceIdentityError(`Invalid source URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SourceIdentityError("Only public http and https URLs can be source identities");
  }
  if (parsed.username || parsed.password) throw new SourceIdentityError("URL credentials are not allowed in source identities");
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || key.toLowerCase() === "fbclid" || key.toLowerCase() === "gclid") parsed.searchParams.delete(key);
  }
  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

function normalizeFile(value: string, baseDir?: string): string {
  if (!baseDir) throw new SourceIdentityError("A project base directory is required for local file identities");
  const resolvedBase = path.resolve(baseDir);
  let inputPath = value;
  if (value.startsWith("file:")) {
    try {
      inputPath = fileURLToPath(new URL(value));
    } catch (error) {
      throw new SourceIdentityError(`Invalid file URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const resolvedPath = path.resolve(resolvedBase, inputPath);
  const relativePath = path.relative(resolvedBase, resolvedPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new SourceIdentityError("Local source must remain inside the authorized project directory");
  }
  return `file:${relativePath.split(path.sep).join("/")}`;
}

export function normalizeSourceIdentity(request: SourceIdentityRequest): string {
  const parsed = sourceIdentityRequestSchema.parse(request);
  return parsed.kind === "url" ? normalizeUrl(parsed.value) : normalizeFile(parsed.value, parsed.baseDir);
}

export function sourceIdForIdentity(kind: SourceKind, identity: string): string {
  if (!isSourceIdentity(identity) || (kind === "url" && !identity.startsWith("http")) || (kind === "file" && !identity.startsWith("file:"))) {
    throw new SourceIdentityError("Source ID requires a canonical source identity");
  }
  return `src_${createHash("sha256").update(`${kind}\0${identity}`).digest("hex").slice(0, 32)}`;
}

export function sourceIdentity(kind: SourceKind, value: string, baseDir?: string): { kind: SourceKind; identity: string; sourceId: string } {
  const identity = normalizeSourceIdentity({ kind, value, baseDir });
  return { kind, identity, sourceId: sourceIdForIdentity(kind, identity) };
}

export function isSourceIdentity(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("file:");
}
