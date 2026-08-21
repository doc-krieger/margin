import type {
  QualityAcceptedCheckpoint,
  QualityFindingDisposition,
  QualityFindingPromotion,
  QualityProgressEvent,
  QualityReviewRecord,
  QualityReviewerInstruction,
} from "@margin/shared";

export interface QualityEventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface QualityProgressEventLike {
  sequence: number;
  type: string;
  timestamp: string;
  message: string;
  findingId: string | null;
  claimId: string | null;
  percent: number | null;
}

export interface QualityApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  eventSourceFactory?: (url: string) => QualityEventSourceLike;
}

export interface StartQualityReviewInput {
  targetCheckpoint: QualityAcceptedCheckpoint;
  reviewerInstruction: QualityReviewerInstruction;
  profileId?: string;
}

export interface CancelQualityReviewInput {
  reason?: string;
}

export interface QualityDispositionInput {
  action: QualityFindingDisposition["action"];
  rationale: string;
  actorId?: string;
  supersedesDispositionId?: string | null;
}

export interface QualityPromotionInput {
  target: QualityFindingPromotion["target"];
  actorId?: string;
  body?: string;
}

export interface QualityReviewEventHandlers {
  onEvent?: (event: QualityProgressEventLike) => void;
  onError?: (event: Event) => void;
}

export class QualityApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "QualityApiError";
  }
}

function defaultEventSourceFactory(url: string): QualityEventSourceLike {
  return new EventSource(url);
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

/** Browser boundary for independent, replayable quality-review records. */
export class QualityApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly eventSourceFactory: (url: string) => QualityEventSourceLike;

  constructor(options: QualityApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${url}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? (body as { error?: { message?: string; code?: string } }).error : undefined;
      throw new QualityApiError(response.status, error?.message ?? `Quality request failed (${response.status})`, error?.code);
    }
    return body as T;
  }

  async listReviews(projectId: string): Promise<QualityReviewRecord[]> {
    const result = await this.request<{ reviews: QualityReviewRecord[] }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews`);
    return result.reviews;
  }

  async getReview(projectId: string, reviewId: string): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}`);
    return result.review;
  }

  async startReview(projectId: string, input: StartQualityReviewInput): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    return result.review;
  }

  async retryReview(projectId: string, reviewId: string, profileId?: string): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}/retry`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(profileId ? { profileId } : {}),
    });
    return result.review;
  }

  async cancelReview(projectId: string, reviewId: string, input: CancelQualityReviewInput = {}): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}/cancel`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    return result.review;
  }

  async appendDisposition(projectId: string, reviewId: string, findingId: string, input: QualityDispositionInput): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/dispositions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    return result.review;
  }

  async promoteFinding(projectId: string, reviewId: string, findingId: string, input: QualityPromotionInput): Promise<QualityReviewRecord> {
    const result = await this.request<{ review: QualityReviewRecord }>(`/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/promotions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    });
    return result.review;
  }

  subscribeReviewEvents(projectId: string, reviewId: string, after = -1, handlers: QualityReviewEventHandlers = {}): () => void {
    const query = after >= 0 ? `?after=${after}` : "";
    const source = this.eventSourceFactory(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/quality-reviews/${encodeURIComponent(reviewId)}/events${query}`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as QualityProgressEventLike;
        handlers.onEvent?.(parsed);
      } catch {
        // A malformed event is a degraded reconnect signal, never a successful review result.
        handlers.onError?.(new Event("malformed-quality-event"));
      }
    };
    source.onerror = (event) => handlers.onError?.(event);
    return () => source.close();
  }

  // Short aliases keep the browser surface convenient for embedded review clients.
  list = this.listReviews.bind(this);
  get = this.getReview.bind(this);
  start = this.startReview.bind(this);
  retry = this.retryReview.bind(this);
  cancel = this.cancelReview.bind(this);
  disposition = this.appendDisposition.bind(this);
  promote = this.promoteFinding.bind(this);
  subscribe = this.subscribeReviewEvents.bind(this);
}

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const defaultQualityApiClient = new QualityApiClient();

export type { QualityAcceptedCheckpoint, QualityProgressEvent };
