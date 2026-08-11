import { realpath } from "node:fs/promises";
import path from "node:path";

export class SafetyError extends Error {
  constructor(public readonly code: "ROOT_NOT_FOUND" | "PATH_OUTSIDE_ROOT", message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/** Resolve an existing path beneath a registered root, rejecting traversal and symlink escapes. */
export async function resolveRegisteredPath(registeredRoot: string, requestedPath: string): Promise<string> {
  const root = await realpath(registeredRoot).catch(() => { throw new SafetyError("ROOT_NOT_FOUND", "Registered root does not exist"); });
  if (path.isAbsolute(requestedPath) || requestedPath.includes("\\")) {
    throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path must be relative and use POSIX separators");
  }
  const candidate = path.resolve(root, requestedPath);
  const resolved = await realpath(candidate).catch(() => { throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path does not resolve beneath the registered root"); });
  const relative = path.relative(root, resolved);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) return resolved;
  throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path resolves outside the registered root");
}
