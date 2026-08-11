import { realpath } from "node:fs/promises";
import path from "node:path";

export type SafetyErrorCode = "ROOT_NOT_FOUND" | "PATH_OUTSIDE_ROOT" | "PATH_PARENT_NOT_FOUND";

export class SafetyError extends Error {
  constructor(public readonly code: SafetyErrorCode, message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveRoot(registeredRoot: string): Promise<string> {
  return realpath(registeredRoot).catch(() => {
    throw new SafetyError("ROOT_NOT_FOUND", "Registered root does not exist");
  });
}

function assertRelativePath(requestedPath: string): void {
  if (!requestedPath || path.isAbsolute(requestedPath) || requestedPath.includes("\\")) {
    throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path must be relative and use POSIX separators");
  }
}

/** Resolve an existing path beneath a registered root, rejecting traversal and symlink escapes. */
export async function resolveRegisteredPath(registeredRoot: string, requestedPath: string): Promise<string> {
  const root = await resolveRoot(registeredRoot);
  assertRelativePath(requestedPath);
  const candidate = path.resolve(root, requestedPath);
  const resolved = await realpath(candidate).catch(() => {
    throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path does not resolve beneath the registered root");
  });
  if (isPathWithinRoot(root, resolved)) return resolved;
  throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path resolves outside the registered root");
}

/**
 * Resolve a path that may not exist yet. Only the final path segment may be new;
 * resolving the parent first prevents a symlinked parent from escaping the root.
 */
export async function resolveRegisteredPathForCreate(registeredRoot: string, requestedPath: string): Promise<string> {
  const root = await resolveRoot(registeredRoot);
  assertRelativePath(requestedPath);
  const candidate = path.resolve(root, requestedPath);
  const parent = await realpath(path.dirname(candidate)).catch(() => {
    throw new SafetyError("PATH_PARENT_NOT_FOUND", "Parent directory does not exist beneath the registered root");
  });
  if (!isPathWithinRoot(root, parent)) {
    throw new SafetyError("PATH_OUTSIDE_ROOT", "Requested path resolves outside the registered root");
  }
  return candidate;
}
