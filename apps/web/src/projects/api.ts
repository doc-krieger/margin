import type {
  CommentRecord,
  CommentScope,
  CommentState,
  PiProfileManifest,
  RevisionRunRecord,
  RunEventType,
} from "@margin/shared";

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

export interface PiProfileView {
  id: string;
  label?: string;
  status: "available" | "unavailable";
  manifest: PiProfileManifest;
  version?: string;
  message?: string;
  diagnostics?: string;
}

export interface StartRunRequest {
  profileId: string;
  selectedCommentIds: string[];
  guidance?: string;
}

export interface RunEventEnvelope {
  runId: string;
  sequence: number;
  timestamp: string;
  type: RunEventType;
  payload: Record<string, unknown>;
}

export interface RunEventHandlers {
  onEvent: (event: RunEventEnvelope) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
  onTerminal?: () => void;
}

export interface EventSourceLike {
  readyState?: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
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
  eventSourceFactory?: (url: string) => EventSourceLike;
}

export class ProjectApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;

  constructor(options: ProjectApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    // Browsers require fetch to be invoked with Window as its receiver; keep the
    // injectable fetcher path unchanged for tests and non-browser consumers.
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url));
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

  async listPiProfiles(): Promise<PiProfileView[]> {
    const response = await this.request<{ profiles: PiProfileView[] }>("/pi/profiles");
    return response.profiles;
  }

  async listRuns(projectId: string): Promise<RevisionRunRecord[]> {
    const response = await this.request<{ runs: RevisionRunRecord[] }>(`/projects/${encodeURIComponent(projectId)}/runs`);
    return response.runs;
  }

  async startRun(projectId: string, input: StartRunRequest): Promise<{ runId: string; run: RevisionRunRecord }> {
    return this.request<{ runId: string; run: RevisionRunRecord }>(`/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST",
      body: input,
    });
  }

  async getRun(runId: string): Promise<RevisionRunRecord> {
    const response = await this.request<{ run: RevisionRunRecord }>(`/runs/${encodeURIComponent(runId)}`);
    return response.run;
  }

  async cancelRun(runId: string): Promise<RevisionRunRecord> {
    const response = await this.request<{ run: RevisionRunRecord }>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: {} });
    return response.run;
  }

  /**
   * Subscribe to replayable run events. The last sequence is sent on reconnect
   * so a dropped browser connection cannot silently skip lifecycle evidence.
   */
  subscribeRunEvents(runId: string, handlers: RunEventHandlers): () => void {
    const eventTypes: RunEventType[] = ["run.started", "pi.event", "pi.stderr", "pi.invalid", "diagnostic", "run.completed", "run.failed", "run.cancelled"];
    let lastSequence = -1;
    let source: EventSourceLike | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let reconnectAttempt = 0;

    const isTerminal = (type: RunEventType): boolean => type === "run.completed" || type === "run.failed" || type === "run.cancelled";
    const closeSource = () => {
      source?.close();
      source = undefined;
    };
    const connect = () => {
      if (closed) return;
      const after = lastSequence >= 0 ? `?after=${lastSequence}` : "?after=-1";
      source = this.eventSourceFactory(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events${after}`);
      const handleMessage = (message: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(message.data) as { timestamp?: unknown; payload?: unknown };
          const sequence = Number(message.lastEventId);
          if (!Number.isInteger(sequence) || sequence < 0 || !parsed.timestamp || !parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) return;
          const eventType = message.type as RunEventType;
          lastSequence = Math.max(lastSequence, sequence);
          reconnectAttempt = 0;
          const event: RunEventEnvelope = { runId, sequence, timestamp: String(parsed.timestamp), type: eventType, payload: parsed.payload as Record<string, unknown> };
          handlers.onEvent(event);
          if (isTerminal(eventType)) {
            handlers.onTerminal?.();
            closeSource();
            if (reconnectTimer) clearTimeout(reconnectTimer);
          }
        } catch (error) {
          handlers.onError?.(error instanceof Error ? error : new Error("Malformed run event received"));
        }
      };
      for (const eventType of eventTypes) source.addEventListener(eventType, handleMessage);
      source.onerror = () => {
        if (closed) return;
        closeSource();
        handlers.onReconnect?.();
        const delay = Math.min(2_000, 250 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeSource();
    };
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
