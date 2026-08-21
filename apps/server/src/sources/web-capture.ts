import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeSourceIdentity } from "./identity.js";

export interface WebCaptureLimits {
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  maxDiagnosticLength: number;
}

export const defaultWebCaptureLimits: WebCaptureLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxDiagnosticLength: 500,
};

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WebNetworkPolicy = (url: URL) => void | Promise<void>;

export interface WebCaptureOptions {
  fetchImpl?: FetchImplementation;
  networkPolicy?: WebNetworkPolicy;
  limits?: Partial<WebCaptureLimits>;
}

export interface WebCaptureResult {
  state: "archived" | "metadata-only" | "unavailable" | "failed";
  bytes?: Uint8Array;
  mediaType?: string;
  readableMediaType?: string;
  requestedUrl: string;
  finalUrl?: string;
  redirectChain: string[];
  metadata: { title?: string; language?: string; url?: string };
  diagnostic?: { code: string; message: string };
}

export class WebCaptureError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly terminalState: "metadata-only" | "unavailable" | "failed" = "failed",
  ) {
    super(message);
    this.name = "WebCaptureError";
  }
}

function boundedMessage(message: string, limit: number): string {
  return message.length <= limit ? message : `${message.slice(0, Math.max(0, limit - 1))}…`;
}

function mediaTypeFromResponse(response: Response): string | undefined {
  const value = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return value || undefined;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || octets[0] === 0 || octets[0] >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%", 1)[0];
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") ||
    value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") ||
    value.startsWith("ff");
}

/** Default policy is intentionally conservative: public DNS targets only. */
export async function assertPublicWebUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebCaptureError("UNSAFE_SCHEME", "Only http and https URLs are allowed", "unavailable");
  if (url.username || url.password) throw new WebCaptureError("URL_CREDENTIALS", "URL credentials are not allowed", "unavailable");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new WebCaptureError("PRIVATE_TARGET", "Private network targets are not allowed", "unavailable");
  }
  const literalType = isIP(hostname);
  if (literalType === 4 && isPrivateIpv4(hostname)) throw new WebCaptureError("PRIVATE_TARGET", "Private network targets are not allowed", "unavailable");
  if (literalType === 6 && isPrivateIpv6(hostname)) throw new WebCaptureError("PRIVATE_TARGET", "Private network targets are not allowed", "unavailable");
  if (!literalType) {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new WebCaptureError("DNS_FAILED", `Unable to resolve public source host: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
    }
    if (addresses.length === 0 || addresses.some(({ address, family }) => family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address))) {
      throw new WebCaptureError("PRIVATE_TARGET", "Private network targets are not allowed", "unavailable");
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number, transportSignal: AbortSignal, callerSignal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new WebCaptureError("EMPTY_BODY", "Response did not provide a body", "failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (callerSignal.aborted) throw new WebCaptureError("CANCELLED", "Capture was cancelled", "failed");
      if (transportSignal.aborted) throw new WebCaptureError("TIMEOUT", "Web capture timed out", "unavailable");
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) throw new WebCaptureError("BODY_TOO_LARGE", `Response exceeds the ${maxBytes}-byte capture limit`, "metadata-only");
      chunks.push(item.value);
    }
  } catch (error) {
    if (callerSignal.aborted) throw new WebCaptureError("CANCELLED", "Capture was cancelled", "failed");
    if (transportSignal.aborted) throw new WebCaptureError("TIMEOUT", "Web capture timed out", "unavailable");
    throw error;
  } finally {
    try { await reader.cancel(); } catch { /* the response is already terminal */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function htmlMetadata(bytes: Uint8Array): { title?: string; language?: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const language = text.match(/<html[^>]+\blang=["']([^"']+)["']/i)?.[1]?.trim();
  return { ...(title ? { title: title.slice(0, 4096) } : {}), ...(language ? { language: language.slice(0, 4096) } : {}) };
}

/**
 * Bounded, credential-free HTTP capture. The network policy is injectable so
 * tests can use a local fixture without weakening the production default.
 */
export async function captureWebSource(inputUrl: string, options: WebCaptureOptions = {}, signal = new AbortController().signal): Promise<WebCaptureResult> {
  const limits = { ...defaultWebCaptureLimits, ...options.limits };
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialUrl = normalizeSourceIdentity({ kind: "url", value: inputUrl });
  let current = new URL(initialUrl);
  const redirectChain: string[] = [initialUrl];
  const policy = options.networkPolicy ?? assertPublicWebUrl;

  for (let redirectCount = 0; redirectCount <= limits.maxRedirects; redirectCount += 1) {
    if (signal.aborted) throw new WebCaptureError("CANCELLED", "Capture was cancelled", "failed");
    await policy(current);
    const timeout = new AbortController();
    const onAbort = () => timeout.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(new Error("capture timeout")), limits.timeoutMs);
    try {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html, text/plain, text/markdown, application/json, application/pdf;q=0.8" },
        signal: timeout.signal,
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new WebCaptureError("REDIRECT_WITHOUT_LOCATION", "Redirect response did not include a location", "failed");
        if (redirectCount === limits.maxRedirects) throw new WebCaptureError("REDIRECT_LIMIT", "Web source exceeded the redirect limit", "unavailable");
        let next: URL;
        try { next = new URL(location, current); } catch { throw new WebCaptureError("INVALID_REDIRECT", "Web source returned an invalid redirect", "failed"); }
        const normalized = normalizeSourceIdentity({ kind: "url", value: next.toString() });
        redirectChain.push(normalized);
        current = new URL(normalized);
        continue;
      }

      const finalUrl = normalizeSourceIdentity({ kind: "url", value: current.toString() });
      if (!response.ok) {
        throw new WebCaptureError("HTTP_ERROR", `Web source returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? "metadata-only" : "unavailable");
      }
      const mediaType = mediaTypeFromResponse(response);
      if (!mediaType) {
        throw new WebCaptureError("MISSING_MEDIA_TYPE", "Web source did not declare a supported media type", "metadata-only");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > limits.maxBytes) {
        throw new WebCaptureError("BODY_TOO_LARGE", `Response exceeds the ${limits.maxBytes}-byte capture limit`, "metadata-only");
      }
      const bytes = await readBoundedBody(response, limits.maxBytes, timeout.signal, signal);
      const metadata = mediaType === "text/html" ? htmlMetadata(bytes) : {};
      const supported = mediaType === "text/html" || mediaType === "text/plain" || mediaType === "text/markdown" || mediaType === "application/json" || mediaType === "application/pdf";
      if (!supported) throw new WebCaptureError("UNSUPPORTED_MEDIA_TYPE", `Media type ${mediaType} is not supported for evidence capture`, "metadata-only");
      return {
        state: "archived",
        bytes,
        mediaType,
        ...(mediaType === "text/plain" || mediaType === "text/markdown" || mediaType === "application/json" ? { readableMediaType: mediaType } : {}),
        requestedUrl: initialUrl,
        finalUrl,
        redirectChain,
        metadata: { ...metadata, url: finalUrl },
      };
    } catch (error) {
      if (error instanceof WebCaptureError) throw error;
      if (signal.aborted) throw new WebCaptureError("CANCELLED", "Capture was cancelled", "failed");
      if (timeout.signal.aborted) throw new WebCaptureError("TIMEOUT", "Web capture timed out", "unavailable");
      throw new WebCaptureError("NETWORK_ERROR", "Unable to fetch public source", "unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw new WebCaptureError("REDIRECT_LIMIT", "Web source exceeded the redirect limit", "unavailable");
}

export function diagnosticForWebError(error: unknown, maxLength = defaultWebCaptureLimits.maxDiagnosticLength): { code: string; message: string } {
  if (error instanceof WebCaptureError) return { code: error.code, message: boundedMessage(error.message, maxLength) };
  return { code: "CAPTURE_FAILED", message: boundedMessage("Web capture failed", maxLength) };
}
