export interface ProjectRoot {
  path: string;
  registeredAt: string;
}

export interface ProjectView {
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

export interface ProjectResult {
  project: ProjectView;
}

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

export interface ProjectApiErrorPayload {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export class ProjectApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}

export interface ProjectApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export class ProjectApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ProjectApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async listRoots(): Promise<ProjectRoot[]> {
    const response = await this.request<{ roots: ProjectRoot[] }>("/projects/roots");
    return response.roots;
  }

  async registerRoot(path: string): Promise<ProjectRoot> {
    const response = await this.request<{ root: ProjectRoot }>("/projects/roots", { method: "POST", body: { path } });
    return response.root;
  }

  async listProjects(): Promise<ProjectView[]> {
    const response = await this.request<{ projects: ProjectView[] }>("/projects");
    return response.projects;
  }

  async openProject(path: string, options: { gitDecision?: string; duplicateIdentityDecision?: string } = {}): Promise<ProjectView> {
    const response = await this.request<ProjectResult>("/projects/open", { method: "POST", body: { path, ...options } });
    return response.project;
  }

  async createProject(input: { path?: string; rootPath?: string; parentPath?: string; name?: string; gitDecision?: string }): Promise<ProjectView> {
    const response = await this.request<ProjectResult>("/projects", { method: "POST", body: input });
    return response.project;
  }

  async listDocuments(projectId: string): Promise<DocumentList> {
    return this.request<DocumentList>(`/projects/${encodeURIComponent(projectId)}/documents`);
  }

  async readDocument(projectId: string, documentPath: string): Promise<DocumentSnapshot> {
    return this.request<DocumentSnapshot>(`/projects/${encodeURIComponent(projectId)}/documents/${encodeDocumentPath(documentPath)}`);
  }

  async saveDocument(projectId: string, documentPath: string, content: string, baseHash: string): Promise<DocumentSnapshot> {
    return this.request<DocumentSnapshot>(`/projects/${encodeURIComponent(projectId)}/documents/${encodeDocumentPath(documentPath)}`, {
      method: "PUT",
      body: { path: documentPath, content, baseHash },
    });
  }

  private async request<T>(relativePath: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${relativePath}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json() as T & ProjectApiErrorPayload;
    if (!response.ok) {
      const error = payload.error;
      throw new ProjectApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? `Project request failed (${response.status})`, error?.details, response.status);
    }
    return payload as T;
  }
}

function encodeDocumentPath(documentPath: string): string {
  return documentPath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export const defaultProjectApiClient = new ProjectApiClient();
