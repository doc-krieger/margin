import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createProjectManifest,
  findProjectManifestPaths,
  PROJECT_MANIFEST_FILENAME,
  readProjectManifest,
  scanProjectFolder,
  writeProjectManifest,
  type ProjectManifest,
  type ProjectScan,
} from "../filesystem/index.js";
import { resolveRegisteredPathForCreate } from "../safety/paths.js";
import { GitInitializationService } from "./git.js";
import { ProjectIdentityConflictError, ProjectRegistry, type RegisteredProject, type RegisteredRoot } from "./registry.js";

export type GitDecision = "initialize" | "continue-without-git";
export type DuplicateIdentityDecision = "assign-new-id";

export interface ProjectOpenOptions {
  gitDecision?: GitDecision | "skip" | "without-git";
  confirmGitInitialization?: boolean;
  initializeGit?: boolean;
  duplicateIdentityDecision?: DuplicateIdentityDecision;
  assignNewIdentity?: boolean;
}

export interface ProjectCreateInput extends ProjectOpenOptions {
  path?: string;
  projectPath?: string;
  rootPath?: string;
  parentPath?: string;
  name?: string;
}

export interface ProjectOpenResult {
  project: RegisteredProject;
  decision?: { type: "git-initialization" | "duplicate-identity"; required: boolean; options: string[] };
}

export type ProjectLifecycleErrorCode =
  | "PROJECT_PATH_REQUIRED"
  | "PROJECT_PATH_OUTSIDE_REGISTERED_ROOT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_DIRECTORY"
  | "PROJECT_ALREADY_EXISTS"
  | "INVALID_PROJECT_MANIFEST"
  | "DUPLICATE_PROJECT_IDENTITY"
  | "GIT_INITIALIZATION_REQUIRED"
  | "GIT_INITIALIZATION_FAILED";

export class ProjectLifecycleError extends Error {
  constructor(
    public readonly code: ProjectLifecycleErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProjectLifecycleError";
  }
}

export interface ProjectLifecycleServiceOptions {
  registry?: ProjectRegistry;
  git?: GitInitializationService;
}

export class ProjectLifecycleService {
  readonly registry: ProjectRegistry;
  private readonly git: GitInitializationService;

  constructor(options: ProjectLifecycleServiceOptions = {}) {
    this.registry = options.registry ?? new ProjectRegistry();
    this.git = options.git ?? new GitInitializationService();
  }

  async registerRoot(rootPath: string): Promise<RegisteredRoot> {
    return this.registry.registerRoot(rootPath);
  }

  listRoots(): RegisteredRoot[] {
    return this.registry.listRoots();
  }

  listProjects(): RegisteredProject[] {
    return this.registry.listProjects();
  }

  getProject(projectId: string): RegisteredProject | undefined {
    return this.registry.findProjectById(projectId);
  }

  async openProject(projectPath: string, options: ProjectOpenOptions = {}): Promise<ProjectOpenResult> {
    if (!projectPath?.trim()) throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", "A project path is required");
    const resolved = await this.resolveProjectPath(projectPath, false);
    let stats;
    try {
      stats = await lstat(resolved.projectPath);
    } catch {
      throw new ProjectLifecycleError("PROJECT_NOT_FOUND", "Project folder does not exist");
    }
    if (!stats.isDirectory()) throw new ProjectLifecycleError("PROJECT_NOT_DIRECTORY", "Project path is not a directory");

    let manifest: ProjectManifest | undefined;
    try {
      manifest = await readProjectManifest(resolved.projectPath);
    } catch (error) {
      throw new ProjectLifecycleError("INVALID_PROJECT_MANIFEST", (error as Error).message, undefined, { cause: error });
    }
    const identityDecision = normalizeIdentityDecision(options);
    if (manifest) {
      const duplicates = await this.findDuplicateManifestPaths(manifest.id, resolved.projectPath);
      if (duplicates.length > 0 && identityDecision !== "assign-new-id") {
        throw new ProjectLifecycleError(
          "DUPLICATE_PROJECT_IDENTITY",
          `Project identity ${manifest.id} is also present at another path`,
          { projectId: manifest.id, existingPaths: duplicates, options: ["assign-new-id"] },
        );
      }
      if (duplicates.length > 0) {
        manifest = { ...manifest, id: cryptoRandomUuid() };
        await writeProjectManifest(resolved.projectPath, manifest);
      }
    } else {
      manifest = createProjectManifest(path.basename(resolved.projectPath));
    }

    const gitInitialized = await this.git.isInitialized(resolved.projectPath);
    const gitDecision = normalizeGitDecision(options);
    if (!gitInitialized && !gitDecision) {
      throw new ProjectLifecycleError(
        "GIT_INITIALIZATION_REQUIRED",
        "This folder is not a Git repository. Choose whether Margin may initialize Git or continue without it.",
        { projectPath: resolved.projectPath, options: ["initialize", "continue-without-git"] },
      );
    }
    if (!gitInitialized && gitDecision === "initialize") {
      try {
        await this.git.initialize(resolved.projectPath);
      } catch (error) {
        throw new ProjectLifecycleError("GIT_INITIALIZATION_FAILED", (error as Error).message, undefined, { cause: error });
      }
    }

    if (!(await readProjectManifest(resolved.projectPath))) await writeProjectManifest(resolved.projectPath, manifest);
    const scan = await scanProjectFolder(resolved.projectPath);
    const project = this.toRegisteredProject(manifest, resolved.projectPath, resolved.root, scan);
    try {
      this.registry.registerProject(project);
    } catch (error) {
      if (error instanceof ProjectIdentityConflictError) {
        throw new ProjectLifecycleError("DUPLICATE_PROJECT_IDENTITY", error.message, { projectId: error.projectId, existingPaths: error.existingPaths, options: ["assign-new-id"] }, { cause: error });
      }
      throw error;
    }
    return { project };
  }

  async createProject(inputOrPath: ProjectCreateInput | string, pathOptions: ProjectOpenOptions & { name?: string } = {}): Promise<ProjectOpenResult> {
    const input: ProjectCreateInput = typeof inputOrPath === "string" ? { ...pathOptions, projectPath: inputOrPath } : inputOrPath;
    const projectName = input.name?.trim();
    const requestedPath = input.projectPath ?? input.path ?? (input.parentPath && projectName ? path.join(input.parentPath, projectName) : undefined) ?? (input.rootPath && projectName ? path.join(input.rootPath, projectName) : undefined);
    if (!requestedPath) throw new ProjectLifecycleError("PROJECT_PATH_REQUIRED", "A project path or rootPath plus name is required");
    const resolved = await this.resolveProjectPath(requestedPath, true);
    try {
      await lstat(resolved.projectPath);
      throw new ProjectLifecycleError("PROJECT_ALREADY_EXISTS", "A folder already exists at the requested project path", { projectPath: resolved.projectPath });
    } catch (error) {
      if (error instanceof ProjectLifecycleError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const manifest = createProjectManifest(projectName || path.basename(resolved.projectPath));
    await mkdir(resolved.projectPath, { recursive: false });
    await mkdir(path.join(resolved.projectPath, "documents"), { recursive: true });
    await mkdir(path.join(resolved.projectPath, "research"), { recursive: true });
    await mkdir(path.join(resolved.projectPath, "sources"), { recursive: true });
    await writeFile(path.join(resolved.projectPath, "documents", "report.md"), `# ${manifest.name}\n\n`, { encoding: "utf8", flag: "wx" });
    await writeProjectManifest(resolved.projectPath, manifest);

    const gitDecision = normalizeGitDecision(input) ?? "initialize";
    return this.openProject(resolved.projectPath, { ...input, gitDecision });
  }

  private async resolveProjectPath(requestedPath: string, allowMissing: boolean): Promise<{ projectPath: string; root: RegisteredRoot }> {
    const root = await this.registry.findContainingRoot(requestedPath, allowMissing);
    if (!root) throw new ProjectLifecycleError("PROJECT_PATH_OUTSIDE_REGISTERED_ROOT", "Project path is outside every registered root");
    const absolutePath = path.resolve(requestedPath);
    if (!allowMissing) {
      const projectPath = await realpath(absolutePath).catch(() => undefined);
      if (!projectPath) throw new ProjectLifecycleError("PROJECT_NOT_FOUND", "Project folder does not exist");
      return { projectPath, root };
    }
    const relativePath = path.relative(root.path, absolutePath) || ".";
    const projectPath = await resolveRegisteredPathForCreate(root.path, relativePath).catch((error) => {
      throw new ProjectLifecycleError("PROJECT_PATH_OUTSIDE_REGISTERED_ROOT", (error as Error).message, undefined, { cause: error });
    });
    return { projectPath, root };
  }

  private async findDuplicateManifestPaths(projectId: string, projectPath: string): Promise<string[]> {
    const matches = new Set<string>(this.registry.findProjectsById(projectId).filter((project) => project.path !== projectPath).map((project) => project.path));
    for (const root of this.registry.listRoots()) {
      const manifestPaths = await findProjectManifestPaths(root.path);
      for (const manifestPath of manifestPaths) {
        const candidatePath = path.dirname(manifestPath);
        if (candidatePath === projectPath) continue;
        const candidate = await readProjectManifest(candidatePath);
        if (candidate?.id === projectId) matches.add(candidatePath);
      }
    }
    return [...matches].sort();
  }

  private toRegisteredProject(manifest: ProjectManifest, projectPath: string, root: RegisteredRoot, scan: ProjectScan): RegisteredProject {
    return {
      id: manifest.id,
      name: manifest.name,
      path: projectPath,
      manifestPath: path.join(projectPath, PROJECT_MANIFEST_FILENAME),
      rootPath: root.path,
      gitInitialized: scan.hasGit,
      markdownFiles: scan.markdownFiles,
      files: scan.files.map((file) => file.relativePath),
      openedAt: new Date().toISOString(),
    };
  }
}

function normalizeGitDecision(options: ProjectOpenOptions): GitDecision | undefined {
  if (options.gitDecision === "initialize") return "initialize";
  if (options.gitDecision === "skip" || options.gitDecision === "without-git" || options.gitDecision === "continue-without-git") return "continue-without-git";
  if (options.confirmGitInitialization === true || options.initializeGit === true) return "initialize";
  if (options.confirmGitInitialization === false || options.initializeGit === false) return "continue-without-git";
  return undefined;
}

function normalizeIdentityDecision(options: ProjectOpenOptions): DuplicateIdentityDecision | undefined {
  return options.duplicateIdentityDecision ?? (options.assignNewIdentity ? "assign-new-id" : undefined);
}

function cryptoRandomUuid(): string {
  // Kept in a function so identity generation is easy to replace in tests.
  return globalThis.crypto?.randomUUID?.() ?? requireRandomUuid();
}

function requireRandomUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0;
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
