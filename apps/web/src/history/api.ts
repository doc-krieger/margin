import type { ProposalChangedFile, ProposalDiff } from "../proposals/api";

export type CheckpointOutcome = "pending" | "kept" | "rejected" | "conflict" | "failed" | "restored";

export interface CheckpointHistoryEntry {
  sha: string;
  ref: string;
  runId: string;
  createdAt: string;
  changedFiles: ProposalChangedFile[];
  outcome: CheckpointOutcome;
}

export interface CheckpointPage {
  checkpoints: CheckpointHistoryEntry[];
  nextCursor: string | null;
}

export interface RestoreResult {
  status: "restored";
  checkpoint: CheckpointHistoryEntry;
  restoredFiles: string[];
}

export class CheckpointHistoryApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly correlationId?: string) {
    super(message);
    this.name = "CheckpointHistoryApiError";
  }
}

export interface CheckpointHistoryApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

/** Bounded checkpoint history and safe restore boundary. */
export class CheckpointHistoryApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: CheckpointHistoryApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  list(projectId: string, options: { limit?: number; cursor?: string } = {}): Promise<CheckpointPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 50));
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request<CheckpointPage>(`${this.projectPath(projectId)}/checkpoints?${params.toString()}`);
  }

  diff(projectId: string, checkpointSha: string): Promise<ProposalDiff> {
    return this.request<{ diff: ProposalDiff }>(`${this.projectPath(projectId)}/checkpoints/${encodeURIComponent(checkpointSha)}/diff`).then((result) => result.diff);
  }

  restore(projectId: string, checkpointSha: string, confirmed: boolean): Promise<RestoreResult> {
    if (!confirmed) return Promise.reject(new CheckpointHistoryApiError("RESTORE_CONFIRMATION_REQUIRED", "Restore requires explicit confirmation", 400));
    return this.request<RestoreResult>(`${this.projectPath(projectId)}/checkpoints/${encodeURIComponent(checkpointSha)}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
  }

  private projectPath(projectId: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}`;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      throw new CheckpointHistoryApiError("NETWORK_ERROR", error instanceof Error ? error.message : "Checkpoint request failed", 0);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CheckpointHistoryApiError("BAD_RESPONSE", `Checkpoint service returned an unreadable response (${response.status})`, response.status, response.headers.get("x-correlation-id") ?? undefined);
    }
    if (!response.ok) {
      const body = asRecord(payload);
      const detail = asRecord(body.error);
      throw new CheckpointHistoryApiError(
        typeof detail.code === "string" ? detail.code : "CHECKPOINT_REQUEST_FAILED",
        typeof detail.message === "string" ? detail.message : `Checkpoint request failed (${response.status})`,
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

export const defaultCheckpointHistoryApiClient = new CheckpointHistoryApiClient();
