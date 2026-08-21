import type { FinalCheckpointSummary, LineageEntry, LineagePage } from "@margin/shared";

export interface LineageApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export interface LineageListOptions {
  cursor?: string;
  limit?: number;
}

export class LineageApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "LineageApiError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; correlationId?: string };
}

/** Browser boundary for the read-only, cross-domain lineage projection. */
export class LineageApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: LineageApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`);
    const body = await response.json().catch(() => undefined) as T | ErrorBody | undefined;
    if (!response.ok) {
      const errorBody = body as ErrorBody | undefined;
      throw new LineageApiError(
        errorBody?.error?.code ?? "LINEAGE_REQUEST_FAILED",
        errorBody?.error?.message ?? `Lineage request failed (${response.status})`,
        response.status,
        errorBody?.error?.correlationId,
      );
    }
    return body as T;
  }

  list(projectId: string, options: LineageListOptions = {}): Promise<LineagePage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.request<LineagePage>(`/projects/${encodeURIComponent(projectId)}/lineage${suffix}`);
  }

  getEntry(projectId: string, entryId: string): Promise<LineageEntry> {
    return this.request<LineageEntry>(`/projects/${encodeURIComponent(projectId)}/lineage/entries/${encodeURIComponent(entryId)}`);
  }

  getFinalCheckpointSummary(projectId: string): Promise<FinalCheckpointSummary> {
    return this.request<FinalCheckpointSummary>(`/projects/${encodeURIComponent(projectId)}/lineage/final-checkpoint-summary`);
  }
}

export const defaultLineageApiClient = new LineageApiClient();
