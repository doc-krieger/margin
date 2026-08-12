export type ProposalStatus = "pending" | "kept" | "rejected" | "conflict" | "failed";
export type ProposalDecision = "keep" | "reject";
export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ProposalChangedFile {
  path: string;
  status: ChangedFileStatus;
  oldPath?: string;
}

export interface ProposalDiff {
  checkpointSha: string;
  files: ProposalChangedFile[];
  patch: string;
}

export interface ProposalSummary {
  proposalId: string;
  runId: string;
  status: ProposalStatus;
  checkpoint: { sha: string; ref: string };
  decision: ProposalDecision | null;
  updatedAt: string;
  cleanup: { status: "pending" | "completed" | "failed"; diagnostics: string | null };
}

export interface ProposalReview {
  proposal: ProposalSummary;
  diff: ProposalDiff;
}

export interface ProposalFile {
  path: string;
  content: string;
  hash: string;
}

export class ProposalApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ProposalApiError";
  }
}

export interface ProposalApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

/** HTTP boundary for isolated proposal review. No method writes canonical documents directly. */
export class ProposalApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ProposalApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  getReview(projectId: string, proposalId: string): Promise<ProposalReview> {
    return this.request<{ review: ProposalReview }>(this.proposalPath(projectId, proposalId)).then((result) => result.review);
  }

  readFile(projectId: string, proposalId: string, filePath: string): Promise<ProposalFile> {
    return this.request<ProposalFile>(`${this.proposalPath(projectId, proposalId)}/files/${encodeURIComponent(filePath)}`);
  }

  editFile(projectId: string, proposalId: string, filePath: string, content: string, expectedHash: string): Promise<ProposalReview> {
    return this.request<{ review: ProposalReview }>(`${this.proposalPath(projectId, proposalId)}/files/${encodeURIComponent(filePath)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, expectedHash }),
    }).then((result) => result.review);
  }

  decide(projectId: string, proposalId: string, decision: ProposalDecision): Promise<ProposalReview> {
    return this.request<{ review: ProposalReview }>(`${this.proposalPath(projectId, proposalId)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }).then((result) => result.review);
  }

  private proposalPath(projectId: string, proposalId: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      throw new ProposalApiError("NETWORK_ERROR", error instanceof Error ? error.message : "Proposal request failed", 0);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProposalApiError("BAD_RESPONSE", `Proposal service returned an unreadable response (${response.status})`, response.status, response.headers.get("x-correlation-id") ?? undefined);
    }

    if (!response.ok) {
      const body = asRecord(payload);
      const detail = asRecord(body.error);
      throw new ProposalApiError(
        typeof detail.code === "string" ? detail.code : "PROPOSAL_REQUEST_FAILED",
        typeof detail.message === "string" ? detail.message : `Proposal request failed (${response.status})`,
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

export const defaultProposalApiClient = new ProposalApiClient();
