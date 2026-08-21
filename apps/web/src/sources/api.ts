import type { CaptureAttemptStatus, EvidenceVersion, SourceKind, SourceRecord } from "@margin/shared";

export type SourceCaptureStatus = CaptureAttemptStatus | "cancelled";

export interface SourceCaptureRequest {
  kind: SourceKind;
  value: string;
  origin?: "ui" | "pi";
  runId?: string;
}

export interface SourceCaptureResult {
  sourceId: string;
  attemptId: string;
  status: SourceCaptureStatus;
  reused: boolean;
  source: SourceRecord;
  version?: EvidenceVersion;
  diagnostic?: { code: string; message: string };
}

export class SourceApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "SourceApiError";
  }
}

export interface SourceApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

/** Typed browser boundary for the shared source-capture service. Evidence bytes are intentionally not fetched here. */
export class SourceApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SourceApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  async listSources(projectId: string): Promise<SourceRecord[]> {
    const result = await this.request<{ sources: SourceRecord[] }>(this.projectPath(projectId));
    return result.sources;
  }

  async getSource(projectId: string, sourceId: string): Promise<SourceRecord> {
    const result = await this.request<{ source: SourceRecord }>(`${this.projectPath(projectId)}/${encodeURIComponent(sourceId)}`);
    return result.source;
  }

  async capture(projectId: string, input: SourceCaptureRequest): Promise<SourceCaptureResult> {
    const result = await this.request<{ capture: SourceCaptureResult }>(`${this.projectPath(projectId)}/capture`, {
      method: "POST",
      body: input,
    });
    return result.capture;
  }

  async retry(projectId: string, sourceId: string, input: Pick<SourceCaptureRequest, "origin" | "runId"> = {}): Promise<SourceCaptureResult> {
    const result = await this.request<{ capture: SourceCaptureResult }>(`${this.projectPath(projectId)}/${encodeURIComponent(sourceId)}/retry`, {
      method: "POST",
      body: input,
    });
    return result.capture;
  }

  async cancel(projectId: string, sourceId: string, attemptId: string, reason?: string): Promise<SourceRecord> {
    const result = await this.request<{ source: SourceRecord }>(`${this.projectPath(projectId)}/${encodeURIComponent(sourceId)}/cancel`, {
      method: "POST",
      body: { attemptId, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
    });
    return result.source;
  }

  private projectPath(projectId: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/sources`;
  }

  private async request<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? "GET",
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new SourceApiError("NETWORK_ERROR", error instanceof Error ? error.message : "Source service is unreachable", 0);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SourceApiError("BAD_RESPONSE", `Source service returned an unreadable response (${response.status})`, response.status, response.headers.get("x-correlation-id") ?? undefined);
    }
    if (!response.ok) {
      const body = asRecord(payload);
      const detail = asRecord(body.error);
      throw new SourceApiError(
        typeof detail.code === "string" ? detail.code : "SOURCE_REQUEST_FAILED",
        typeof detail.message === "string" ? detail.message : `Source request failed (${response.status})`,
        response.status,
        typeof detail.correlationId === "string" ? detail.correlationId : response.headers.get("x-correlation-id") ?? undefined,
      );
    }
    return payload as T;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function describeSourceFailure(reason: unknown): string {
  if (!(reason instanceof SourceApiError)) return reason instanceof Error ? reason.message : "Source operation failed.";
  const suffix = reason.correlationId ? ` Reference: ${reason.correlationId}.` : "";
  if (reason.code === "NETWORK_ERROR" || reason.status === 0) return "Margin could not reach the source service. Reconnect and retry; persisted capture state remains authoritative.";
  if (reason.code === "SOURCE_PROJECT_NOT_FOUND" || reason.status === 404) return `The source project is no longer available.${suffix}`;
  return `${reason.message}${suffix}`;
}

export const defaultSourceApiClient = new SourceApiClient();
