import { realpath } from "node:fs/promises";
import path from "node:path";
import { isPathWithinRoot, resolveRegisteredPathForCreate } from "../safety/paths.js";

export interface RegisteredRoot {
  path: string;
  registeredAt: string;
}

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  manifestPath: string;
  rootPath: string;
  gitInitialized: boolean;
  markdownFiles: string[];
  files: string[];
  openedAt: string;
}

export class ProjectIdentityConflictError extends Error {
  constructor(public readonly projectId: string, public readonly existingPaths: string[]) {
    super(`Project identity ${projectId} is already registered at another path`);
    this.name = "ProjectIdentityConflictError";
  }
}

/**
 * Tracks the roots the local server is allowed to inspect and the projects
 * opened during this process. The manifest remains the durable identity source.
 */
export class ProjectRegistry {
  private readonly roots = new Map<string, RegisteredRoot>();
  private readonly projectsByPath = new Map<string, RegisteredProject>();

  async registerRoot(rootPath: string): Promise<RegisteredRoot> {
    const canonicalPath = await realpath(rootPath).catch(() => undefined);
    if (!canonicalPath) throw new Error("Registered root does not exist");
    const root = { path: canonicalPath, registeredAt: new Date().toISOString() };
    this.roots.set(canonicalPath, root);
    return root;
  }

  unregisterRoot(rootPath: string): void {
    this.roots.delete(path.resolve(rootPath));
  }

  listRoots(): RegisteredRoot[] {
    return [...this.roots.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async findContainingRoot(candidatePath: string, allowMissing = false): Promise<RegisteredRoot | undefined> {
    const absoluteCandidate = path.resolve(candidatePath);
    for (const root of this.listRoots()) {
      const resolvedCandidate = allowMissing
        ? await resolveCandidateForCreate(root.path, absoluteCandidate)
        : await realpath(absoluteCandidate).catch(() => undefined);
      if (resolvedCandidate && isPathWithinRoot(root.path, resolvedCandidate)) return root;
    }
    return undefined;
  }

  registerProject(project: RegisteredProject): RegisteredProject {
    const existingAtPath = this.projectsByPath.get(project.path);
    if (existingAtPath && existingAtPath.id !== project.id) {
      throw new ProjectIdentityConflictError(project.id, [existingAtPath.path]);
    }
    const existingWithId = this.findProjectsById(project.id).filter((item) => item.path !== project.path);
    if (existingWithId.length > 0) throw new ProjectIdentityConflictError(project.id, existingWithId.map((item) => item.path));
    this.projectsByPath.set(project.path, project);
    return project;
  }

  unregisterProject(projectPath: string): void {
    this.projectsByPath.delete(path.resolve(projectPath));
  }

  listProjects(): RegisteredProject[] {
    return [...this.projectsByPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  findProjectById(projectId: string): RegisteredProject | undefined {
    return this.listProjects().find((project) => project.id === projectId);
  }

  findProjectsById(projectId: string): RegisteredProject[] {
    return this.listProjects().filter((project) => project.id === projectId);
  }

  findProjectByPath(projectPath: string): RegisteredProject | undefined {
    return this.projectsByPath.get(path.resolve(projectPath));
  }
}

async function resolveCandidateForCreate(rootPath: string, candidatePath: string): Promise<string | undefined> {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  try {
    return await realpath(candidatePath);
  } catch {
    try {
      // This deliberately permits only a new final segment. The helper also
      // resolves the parent, catching a symlinked parent outside the root.
      return await resolveRegisteredPathForCreate(rootPath, relative || ".");
    } catch {
      return undefined;
    }
  }
}
