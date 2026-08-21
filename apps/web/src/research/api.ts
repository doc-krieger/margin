import type {
  PiProfileManifest,
  ResearchBrief,
  ResearchCapabilityDeclaration,
  ResearchCapabilitySnapshot,
  ResearchCitationLocation,
  ResearchEventType,
  ResearchFrozenSourceBinding,
  ResearchRunRecord,
  ResearchSourceSelection,
} from "@margin/shared";

export interface ResearchProfileView {
  id: string;
  label?: string;
  status: "available" | "unavailable";
  manifest: PiProfileManifest;
  version?: string;
  message?: string;
  diagnostics?: string;
}

export interface ResearchBriefInput {
  briefId?: string;
  question: string;
  scope: string;
  audience?: string;
  exclusions?: string[];
  depth?: ResearchBrief["depth"];
  outline?: string[];
  outputMode?: ResearchBrief["outputMode"];
  recipe?: ResearchBrief["recipe"];
  status?: ResearchBrief["status"];
  clarificationDecisions?: ResearchBrief["clarificationDecisions"];
  confirmedRevision?: number | null;
  confirmedAt?: string | null;
  outputPaths?: ResearchBrief["outputPaths"];
}

export interface ResearchRunStartRequest {
  briefId: string;
  profileId: string;
  requiredCapabilities?: ResearchCapabilityDeclaration[];
  sourceSelections?: ResearchSourceSelection[];
  worktreePath?: string;
}

export interface ResearchEventEnvelope {
  runId: string;
  sequence: number;
  timestamp: string;
  type: ResearchEventType;
  payload: Record<string, unknown>;
}

export interface ResearchEventSourceLike {
  readyState?: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ResearchEventHandlers {
  onEvent: (event: ResearchEventEnvelope) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
  onTerminal?: () => void;
}

export type CitationResolutionStatus =
  | "resolved"
  | "metadata-only"
  | "unavailable"
  | "missing-source"
  | "missing-version"
  | "checksum-mismatch"
  | "ambiguous"
  | "unresolved";

/** Safe source metadata returned for an exact citation; no filesystem references cross the browser boundary. */
export interface CitationSafeSource {
  sourceId: string;
  kind: string;
  identity: string;
  aliases: string[];
  effectiveMetadata: Record<string, string>;
  evidenceState: "archived" | "metadata-only" | "unavailable" | "failed";
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe immutable evidence metadata returned for a citation. */
export interface CitationSafeVersion {
  versionId: string;
  checksum: string;
  byteLength: number;
  mediaType: string;
  capturedAt: string;
  attemptId: string;
  requestedUrl?: string;
  finalUrl?: string;
  readableMediaType?: string;
}

export interface CitationEvidencePreview {
  available: boolean;
  mediaType: string;
  checksum: string;
  byteLength: number;
  preview: string | null;
  truncated: boolean;
}

export interface CitationResolution {
  usageId: string | null;
  citationKey: string;
  location: ResearchCitationLocation | null;
  excerpt: string | null;
  status: CitationResolutionStatus;
  source: CitationSafeSource | null;
  version: CitationSafeVersion | null;
  evidence: CitationEvidencePreview | null;
  diagnostic: { code: string; message: string } | null;
}

export interface CitationCheckpoint {
  runId: string;
  attemptId: string | null;
  reportArtifactId: string | null;
  reportSha256: string | null;
  sourceBindings: Array<Pick<ResearchFrozenSourceBinding, "sourceId" | "versionId" | "checksum" | "required" | "citationKey">>;
}

export interface CitationResolutionResult {
  runId: string;
  checkpoint: CitationCheckpoint;
  status: "resolved" | "partial" | "failed";
  citations: CitationResolution[];
  diagnostics: Array<{ code: string; message: string }>;
}

export interface CitationResolutionOptions {
  attemptId?: string;
  usageId?: string;
  citationKey?: string;
}

export interface CitationRepairInput {
  citationKey: string;
  sourceId: string;
  versionId: string;
  reason: string;
  attemptId?: string;
}

export interface CitationRepairLineage {
  repairId: string;
  parent: CitationCheckpoint;
  reason: string;
  createdAt: string;
  operation: "create-new-checkpoint";
}

export interface CitationRepairResult {
  status: "no-change" | "requires-new-checkpoint";
  citationKey: string;
  selectedVersion: CitationSafeVersion;
  parent: CitationCheckpoint;
  nextCheckpoint: {
    parentRunId: string;
    parentAttemptId: string;
    reportArtifactId: string | null;
    reportSha256: string | null;
    sourceBindings: ResearchFrozenSourceBinding[];
  };
  lineage: CitationRepairLineage | null;
}

export interface CitationApiClient {
  resolveCitations(runId: string, options?: CitationResolutionOptions): Promise<CitationResolutionResult>;
  repairCitation(runId: string, input: CitationRepairInput): Promise<CitationRepairResult>;
}

export interface ResearchApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  eventSourceFactory?: (url: string) => ResearchEventSourceLike;
}

export class ResearchApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ResearchApiError";
  }
}

const eventTypes: ResearchEventType[] = [
  "research.started",
  "research.capability",
  "research.stage",
  "research.artifact",
  "research.progress",
  "research.diagnostic",
  "research.completed",
  "research.failed",
  "research.cancelled",
];

const terminalEventTypes = new Set<ResearchEventType>([
  "research.completed",
  "research.failed",
  "research.cancelled",
]);

/** Browser boundary for durable research records and replayable lifecycle events. */
export class ResearchApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly eventSourceFactory: (url: string) => ResearchEventSourceLike;

  constructor(options: ResearchApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url));
  }

  async listProfiles(): Promise<ResearchProfileView[]> {
    const response = await this.request<{ profiles: ResearchProfileView[] }>("/research/profiles");
    return response.profiles;
  }

  async checkCapabilities(profileId: string, required: ResearchCapabilityDeclaration[] = []): Promise<ResearchCapabilitySnapshot> {
    const query = encodeURIComponent(JSON.stringify(required));
    const response = await this.request<{ capabilities: ResearchCapabilitySnapshot }>(
      `/research/profiles/${encodeURIComponent(profileId)}/capabilities?capabilities=${query}`,
    );
    return response.capabilities;
  }

  async listBriefs(projectId: string): Promise<ResearchBrief[]> {
    const response = await this.request<{ briefs: ResearchBrief[] }>(`/projects/${encodeURIComponent(projectId)}/research/briefs`);
    return response.briefs;
  }

  async saveBrief(projectId: string, input: ResearchBriefInput): Promise<ResearchBrief> {
    const response = await this.request<{ brief: ResearchBrief }>(`/projects/${encodeURIComponent(projectId)}/research/briefs`, {
      method: "POST",
      body: input,
    });
    return response.brief;
  }

  async listRuns(projectId: string): Promise<ResearchRunRecord[]> {
    const response = await this.request<{ runs: ResearchRunRecord[] }>(`/projects/${encodeURIComponent(projectId)}/research/runs`);
    return response.runs;
  }

  async getRun(runId: string): Promise<ResearchRunRecord> {
    const response = await this.request<{ run: ResearchRunRecord }>(`/research/runs/${encodeURIComponent(runId)}`);
    return response.run;
  }

  async resolveCitations(runId: string, options: CitationResolutionOptions = {}): Promise<CitationResolutionResult> {
    const query = new URLSearchParams();
    if (options.attemptId) query.set("attemptId", options.attemptId);
    if (options.usageId) query.set("usageId", options.usageId);
    if (options.citationKey) query.set("citationKey", options.citationKey);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await this.request<{ resolution: CitationResolutionResult }>(
      `/research/runs/${encodeURIComponent(runId)}/citations${suffix}`,
    );
    return response.resolution;
  }

  /** Explicit alias for call sites that describe the read as a GET operation. */
  async getCitationResolution(runId: string, options: CitationResolutionOptions = {}): Promise<CitationResolutionResult> {
    return this.resolveCitations(runId, options);
  }

  async repairCitation(runId: string, input: CitationRepairInput): Promise<CitationRepairResult> {
    const response = await this.request<{ repair: CitationRepairResult }>(
      `/research/runs/${encodeURIComponent(runId)}/citations/repair`,
      { method: "POST", body: input },
    );
    return response.repair;
  }

  async startRun(projectId: string, input: ResearchRunStartRequest): Promise<{ runId: string; run: ResearchRunRecord }> {
    return this.request<{ runId: string; run: ResearchRunRecord }>(`/projects/${encodeURIComponent(projectId)}/research/runs`, {
      method: "POST",
      body: input,
    });
  }

  async cancelRun(runId: string, reason = "cancelled by user"): Promise<ResearchRunRecord> {
    const response = await this.request<{ run: ResearchRunRecord }>(`/research/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: { reason },
    });
    return response.run;
  }

  /**
   * Reconnects from the last accepted SSE sequence. The server replays all
   * durable events after that cursor, so refreshes cannot lose stage evidence.
   */
  subscribeRunEvents(runId: string, handlers: ResearchEventHandlers, after = -1): () => void {
    let lastSequence = after;
    let source: ResearchEventSourceLike | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let closed = false;

    const closeSource = () => {
      source?.close();
      source = undefined;
    };
    const connect = () => {
      if (closed) return;
      source = this.eventSourceFactory(`${this.baseUrl}/research/runs/${encodeURIComponent(runId)}/events?after=${lastSequence}`);
      const handleMessage = (message: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(message.data) as { timestamp?: unknown; payload?: unknown };
          const sequence = Number(message.lastEventId);
          const type = message.type as ResearchEventType;
          if (!eventTypes.includes(type) || !Number.isInteger(sequence) || sequence < 0 || typeof payload.timestamp !== "string" || !payload.payload || typeof payload.payload !== "object" || Array.isArray(payload.payload)) {
            return;
          }
          if (sequence <= lastSequence) return;
          lastSequence = sequence;
          reconnectAttempt = 0;
          const event: ResearchEventEnvelope = { runId, sequence, timestamp: payload.timestamp, type, payload: payload.payload as Record<string, unknown> };
          handlers.onEvent(event);
          if (terminalEventTypes.has(type)) {
            handlers.onTerminal?.();
            closeSource();
            if (reconnectTimer) clearTimeout(reconnectTimer);
          }
        } catch (error) {
          handlers.onError?.(error instanceof Error ? error : new Error("Malformed research event received"));
        }
      };
      for (const type of eventTypes) source.addEventListener(type, handleMessage);
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
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${relativePath}`, {
        method: options.method ?? "GET",
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new ResearchApiError("RESEARCH_CONNECTION_FAILED", error instanceof Error ? error.message : "Research service connection failed");
    }
    let payload: (T & { error?: { code?: string; message?: string; details?: Record<string, unknown> } }) | undefined;
    try {
      payload = await response.json() as T & { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const error = payload?.error;
      throw new ResearchApiError(error?.code ?? "RESEARCH_REQUEST_FAILED", error?.message ?? `Research request failed (${response.status})`, error?.details, response.status);
    }
    if (!payload) throw new ResearchApiError("RESEARCH_INVALID_RESPONSE", "Research service returned an empty response", undefined, response.status);
    return payload as T;
  }
}

export const defaultResearchApiClient = new ResearchApiClient();
