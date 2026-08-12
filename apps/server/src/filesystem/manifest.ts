import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectIdSchema } from "@margin/shared";

export const PROJECT_MANIFEST_FILENAME = "margin.yaml";
export const PROJECT_MANIFEST_VERSION = 1;

export interface ProjectManifest {
  id: string;
  name: string;
  version: number;
}

export type ProjectManifestErrorCode = "INVALID_MANIFEST" | "MANIFEST_SYMLINK" | "MANIFEST_WRITE_FAILED";

export class ProjectManifestError extends Error {
  constructor(public readonly code: ProjectManifestErrorCode, message: string) {
    super(message);
    this.name = "ProjectManifestError";
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new ProjectManifestError("INVALID_MANIFEST", "margin.yaml contains an invalid quoted value");
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function parseManifest(source: string, manifestPath: string): ProjectManifest {
  const values = new Map<string, string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) throw new ProjectManifestError("INVALID_MANIFEST", `Invalid margin.yaml line ${index + 1} in ${manifestPath}`);
    const key = trimmed.slice(0, separator).trim();
    values.set(key, unquote(trimmed.slice(separator + 1)));
  }

  const id = values.get("id") ?? values.get("uuid");
  if (!id || !projectIdSchema.safeParse(id).success) {
    throw new ProjectManifestError("INVALID_MANIFEST", `margin.yaml at ${manifestPath} must contain a valid id`);
  }
  const name = values.get("name");
  if (!name || name.length > 200) {
    throw new ProjectManifestError("INVALID_MANIFEST", `margin.yaml at ${manifestPath} must contain a non-empty name`);
  }
  const versionValue = values.get("version");
  const version = versionValue ? Number(versionValue) : PROJECT_MANIFEST_VERSION;
  if (!Number.isInteger(version) || version < 1) {
    throw new ProjectManifestError("INVALID_MANIFEST", `margin.yaml at ${manifestPath} has an unsupported version`);
  }
  return { id, name, version };
}

export async function readProjectManifest(projectPath: string): Promise<ProjectManifest | undefined> {
  const manifestPath = path.join(projectPath, PROJECT_MANIFEST_FILENAME);
  let stats;
  try {
    stats = await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new ProjectManifestError("MANIFEST_SYMLINK", "margin.yaml must not be a symlink");
  if (!stats.isFile()) throw new ProjectManifestError("INVALID_MANIFEST", "margin.yaml must be a regular file");
  return parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

export async function writeProjectManifest(projectPath: string, manifest: ProjectManifest): Promise<string> {
  if (!projectIdSchema.safeParse(manifest.id).success || !manifest.name.trim() || manifest.name.length > 200) {
    throw new ProjectManifestError("INVALID_MANIFEST", "Cannot write an invalid project manifest");
  }
  const manifestPath = path.join(projectPath, PROJECT_MANIFEST_FILENAME);
  const temporaryPath = `${manifestPath}.tmp-${randomUUID()}`;
  const source = [`id: ${manifest.id}`, `name: ${JSON.stringify(manifest.name)}`, `version: ${manifest.version}`, ""].join("\n");
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ProjectManifestError("MANIFEST_WRITE_FAILED", `Unable to persist ${manifestPath}: ${(error as Error).message}`);
  }
  return manifestPath;
}

export function createProjectManifest(name: string): ProjectManifest {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 200) throw new ProjectManifestError("INVALID_MANIFEST", "Project name must be between 1 and 200 characters");
  return { id: randomUUID(), name: trimmedName, version: PROJECT_MANIFEST_VERSION };
}
