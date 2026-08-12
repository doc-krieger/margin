import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathWithinRoot } from "../safety/paths.js";

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  extension: string;
}

export interface ProjectScan {
  rootPath: string;
  files: ScannedFile[];
  directories: string[];
  markdownFiles: string[];
  hasGit: boolean;
  hasManifest: boolean;
}

export interface ProjectScanOptions {
  maxFiles?: number;
  maxDepth?: number;
}

export type FileSystemScanErrorCode = "SCAN_ROOT_NOT_FOUND" | "SCAN_ROOT_NOT_DIRECTORY" | "SCAN_SYMLINK_ESCAPE" | "SCAN_LIMIT_EXCEEDED";

export class FileSystemScanError extends Error {
  constructor(public readonly code: FileSystemScanErrorCode, message: string) {
    super(message);
    this.name = "FileSystemScanError";
  }
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function posixRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Walk a project without following symlinks. Markdown files remain ordinary
 * filesystem entries; this scanner only reports metadata for navigation.
 */
export async function scanProjectFolder(projectRoot: string, options: ProjectScanOptions = {}): Promise<ProjectScan> {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxDepth = options.maxDepth ?? 32;
  const rootPath = await realpath(projectRoot).catch(() => {
    throw new FileSystemScanError("SCAN_ROOT_NOT_FOUND", "Project folder does not exist");
  });
  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new FileSystemScanError("SCAN_ROOT_NOT_DIRECTORY", "Project path is not a directory");
  }

  const files: ScannedFile[] = [];
  const directories: string[] = [];

  async function walk(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new FileSystemScanError("SCAN_LIMIT_EXCEEDED", `Project folder exceeds the ${maxDepth}-level scan limit`);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "." || entry.name === "..") continue;
      if (relativeDirectory === "" && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = posixRelativePath(path.join(relativeDirectory, entry.name));
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        const target = await realpath(absolutePath).catch(() => undefined);
        if (target && !isPathWithinRoot(rootPath, target)) {
          throw new FileSystemScanError("SCAN_SYMLINK_ESCAPE", `Symlink escapes the project folder: ${relativePath}`);
        }
        // Internal symlinks are intentionally omitted to avoid duplicate or
        // surprising write targets in the document navigator.
        continue;
      }
      if (stats.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        directories.push(relativePath);
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stats.isFile()) continue;
      if (files.length >= maxFiles) throw new FileSystemScanError("SCAN_LIMIT_EXCEEDED", `Project folder exceeds the ${maxFiles}-file scan limit`);
      files.push({
        relativePath,
        absolutePath,
        sizeBytes: stats.size,
        extension: path.extname(entry.name).toLowerCase(),
      });
    }
  }

  await walk(rootPath, "", 0);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  directories.sort((a, b) => a.localeCompare(b));
  return {
    rootPath,
    files,
    directories,
    markdownFiles: files.filter((file) => [".md", ".markdown", ".mdown"].includes(file.extension)).map((file) => file.relativePath),
    hasGit: files.some(() => false) || await hasDirectoryEntry(rootPath, ".git"),
    hasManifest: files.some((file) => file.relativePath === "margin.yaml"),
  };
}

async function hasDirectoryEntry(rootPath: string, name: string): Promise<boolean> {
  try {
    const stats = await lstat(path.join(rootPath, name));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/** Find identity manifests below registered roots without following symlinks. */
export async function findProjectManifestPaths(projectRoot: string): Promise<string[]> {
  const scan = await scanProjectFolder(projectRoot);
  return scan.files.filter((file) => path.basename(file.relativePath) === "margin.yaml").map((file) => file.absolutePath);
}
