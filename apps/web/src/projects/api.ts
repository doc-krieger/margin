import type { CommentRecord, CommentScope, CommentState } from "@margin/shared";

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

export interface CommentListFilter {
  documentPath?: string;
  runId?: string;
  scope?: CommentScope;
  state?: CommentState;
}

export interface SelectionCommentRequest {
  documentPath: string;
  documentText: string;
  start: number;
  end: number;
  body: string;
}

export interface DocumentCommentRequest {
  documentPath: string;
  body: string;
}

export interface RunGuidanceRequest {
  runId: string;
  body: string;
  documentPath?: string;
}

export type CommentActor = "user" | "automation";

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
    // Browsers require fetch to be invoked with Window as its receiver; keep the
    // injectable fetcher path unchanged for tests and non-browser consumers.
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
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

  async listComments(projectId: string, filter: CommentListFilter = {}): Promise<CommentRecord[]> {
    const params = new URLSearchParams();
    if (filter.documentPath !== undefined) params.set("documentPath", filter.documentPath);
    if (filter.runId !== undefined) params.set("runId", filter.runId);
    if (filter.scope !== undefined) params.set("scope", filter.scope);
    if (filter.state !== undefined) params.set("state", filter.state);
    const query = params.toString();
    const response = await this.request<{ comments: CommentRecord[] }>(`/projects/${encodeURIComponent(projectId)}/comments${query ? `?${query}` : ""}`);
    return response.comments;
  }

  async createSelectionComment(projectId: string, input: SelectionCommentRequest): Promise<CommentRecord> {
    const response = await this.request<{ comment: CommentRecord }>(`/projects/${encodeURIComponent(projectId)}/comments`, {
      method: "POST",
      body: { ...input, scope: "selection" },
    });
    return response.comment;
  }

  async createDocumentComment(projectId: string, input: DocumentCommentRequest): Promise<CommentRecord> {
    const response = await this.request<{ comment: CommentRecord }>(`/projects/${encodeURIComponent(projectId)}/comments`, {
      method: "POST",
      body: { ...input, scope: "document" },
    });
    return response.comment;
  }

  async createRunGuidance(projectId: string, input: RunGuidanceRequest): Promise<CommentRecord> {
    const response = await this.request<{ comment: CommentRecord }>(`/projects/${encodeURIComponent(projectId)}/comments`, {
      method: "POST",
      body: { ...input, scope: "run" },
    });
    return response.comment;
  }

  async updateComment(projectId: string, commentId: string, body: string): Promise<CommentRecord> {
    const response = await this.request<{ comment: CommentRecord }>(`/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: { body },
    });
    return response.comment;
  }

  async transitionComment(projectId: string, commentId: string, state: CommentState, actor: CommentActor = "user"): Promise<CommentRecord> {
    const response = await this.request<{ comment: CommentRecord }>(`/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}/state`, {
      method: "POST",
      body: { state, actor },
    });
    return response.comment;
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
