import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "../../helpers/test-api.js";
import { MemorySourceStore } from "../../../apps/server/src/sources/store.js";
import { SourceCaptureService } from "../../../apps/server/src/sources/service.js";
import { captureFileSource } from "../../../apps/server/src/sources/file-capture.js";
import { WebCaptureError, captureWebSource } from "../../../apps/server/src/sources/web-capture.js";

const projectRoot = process.cwd();
const htmlFixture = new TextEncoder().encode("<!doctype html><html lang=\"en\"><head><title>Fixture Article</title></head><body>Archived body</body></html>");
const textFixture = new TextEncoder().encode("A bounded plain-text article.\n");
const fixedNow = () => "2026-08-13T12:00:00.000Z";

function response(bytes: Uint8Array, mediaType = "text/html", init: ResponseInit = {}): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": mediaType, ...init.headers }, ...init });
}

function fakeFetchFor(bytes: Uint8Array, options: { redirect?: boolean } = {}) {
  let calls = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    calls += 1;
    const url = String(input);
    if (options.redirect && url.endsWith("/start")) {
      return new Response(null, { status: 302, headers: { location: "/final" } });
    }
    return response(bytes);
  };
  return { fetchImpl, calls: () => calls };
}

async function assertRejectsWithProperties(promise: Promise<unknown>, expected: Record<string, unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error !== null && typeof error === "object");
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual((error as Record<string, unknown>)[key], value);
    }
    return true;
  });
}

describe("SourceCaptureService", () => {
  it("joins concurrent UI and Pi intents into one immutable archive", async () => {
    const store = new MemorySourceStore();
    let release!: () => void;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = new SourceCaptureService(store, {
      now: fixedNow,
      networkPolicy: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        fetchStarted();
        await gate;
        return response(htmlFixture);
      },
    });

    const firstPromise = service.capture({ kind: "url", value: "https://example.com/article?utm_source=test", origin: "ui" });
    await started;
    const secondPromise = service.capture({ kind: "url", value: "HTTPS://EXAMPLE.COM:443/article", origin: "pi", runId: "run-source-capture" });
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(calls, 1);
    assert.equal(first.status, "archived");
    assert.equal(second.status, "reused");
    assert.equal(second.sourceId, first.sourceId);
    assert.equal(second.version?.versionId, first.version?.versionId);
    assert.equal(first.source.versions.length, 1);
    assert.equal(first.source.attempts.length, 2);

    const source = await service.get(first.sourceId);
    assert.equal(source?.attempts.length, 2);
    assert.deepEqual(source?.attempts.map((attempt) => attempt.origin).sort(), ["pi", "ui"]);
    assert.deepEqual(source?.attempts.map((attempt) => attempt.status).sort(), ["archived", "reused"]);
    assert.equal(source?.evidenceState, "archived");
  });

  it("reuses unchanged bytes and appends a new exact version when bytes change", async () => {
    const store = new MemorySourceStore();
    let bytes = textFixture;
    const service = new SourceCaptureService(store, {
      now: fixedNow,
      networkPolicy: async () => undefined,
      fetchImpl: async () => response(bytes, "text/plain"),
    });

    const first = await service.capture({ kind: "url", value: "https://example.com/changing", origin: "ui" });
    const reused = await service.retry({ kind: "url", value: "https://example.com/changing", origin: "pi" });
    bytes = new TextEncoder().encode("A changed article snapshot.\n");
    const changed = await service.retry({ kind: "url", value: "https://example.com/changing", origin: "ui" });

    assert.equal(reused.status, "reused");
    assert.equal(reused.version?.versionId, first.version?.versionId);
    assert.equal(changed.status, "archived");
    assert.notEqual(changed.version?.versionId, first.version?.versionId);
    const source = await service.get(first.sourceId);
    assert.equal(source?.versions.length, 2);
    assert.deepEqual(await store.readEvidence(first.sourceId, first.version!), textFixture);
    assert.deepEqual(await store.readEvidence(first.sourceId, changed.version!), bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), changed.version?.checksum);
  });

  it("records redirects and aliases without archiving partial or oversized responses", async () => {
    const store = new MemorySourceStore();
    const fake = fakeFetchFor(htmlFixture, { redirect: true });
    const service = new SourceCaptureService(store, {
      now: fixedNow,
      networkPolicy: async () => undefined,
      fetchImpl: fake.fetchImpl,
      webLimits: { maxBytes: 4096 },
    });

    const captured = await service.capture({ kind: "url", value: "https://example.com/start", origin: "ui" });
    assert.equal(captured.status, "archived");
    assert.equal(fake.calls(), 2);
    assert.ok(captured.source.aliases.includes("https://example.com/final"));
    assert.deepEqual(captured.source.attempts[0]?.redirectChain, ["https://example.com/start", "https://example.com/final"]);
    assert.equal(captured.version?.finalUrl, "https://example.com/final");

    const oversized = new SourceCaptureService(new MemorySourceStore(), {
      now: fixedNow,
      networkPolicy: async () => undefined,
      fetchImpl: async () => response(new Uint8Array(20), "text/plain"),
      webLimits: { maxBytes: 10 },
    });
    const result = await oversized.capture({ kind: "url", value: "https://example.com/oversized", origin: "pi" });
    assert.equal(result.status, "metadata-only");
    assert.equal(result.diagnostic?.code, "BODY_TOO_LARGE");
    assert.equal(result.source.latestVersionId, null);
    assert.equal(result.source.versions.length, 0);
  });

  it("snapshots contained regular files and rejects traversal", async () => {
    const store = new MemorySourceStore();
    const service = new SourceCaptureService(store, { now: fixedNow });
    const file = await service.capture({ kind: "file", value: "tests/fixtures/sources/article.html", baseDir: projectRoot, origin: "ui" });

    assert.equal(file.status, "archived");
    assert.equal(file.version?.originalPath, "tests/fixtures/sources/article.html");
    assert.equal(file.source.effectiveMetadata.title, "Fixture Article");
    assert.deepEqual(Buffer.from(await store.readEvidence(file.sourceId, file.version!)), await readFile(path.join(projectRoot, "tests/fixtures/sources/article.html")));

    await assert.rejects(captureFileSource("../outside.txt", projectRoot), /Local source must remain inside the authorized project directory/);
    const missing = await service.capture({ kind: "file", value: "tests/fixtures/sources/missing.txt", baseDir: projectRoot, origin: "pi" });
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.diagnostic?.code, "FILE_NOT_FOUND");
    assert.equal(missing.source.latestVersionId, null);
  });

  it("settles owner cancellation without publishing bytes, then supports retry", async () => {
    const store = new MemorySourceStore();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let retryAllowed = false;
    const service = new SourceCaptureService(store, {
      now: fixedNow,
      networkPolicy: async () => undefined,
      fetchImpl: async (_input, init) => {
        if (retryAllowed) return response(htmlFixture);
        fetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = service.capture({ kind: "url", value: "https://example.com/cancel", origin: "ui", signal: controller.signal });
    await started;
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.source.latestVersionId, null);
    assert.equal(cancelled.source.versions.length, 0);

    retryAllowed = true;
    const retry = await service.retry({
      kind: "url",
      value: "https://example.com/cancel",
      origin: "pi",
      signal: undefined,
    });
    assert.equal(retry.status, "archived");
  });
});

describe("captureWebSource", () => {
  it("rechecks each redirect with the supplied network policy", async () => {
    const checked: string[] = [];
    await assertRejectsWithProperties(captureWebSource("https://example.com/start", {
      networkPolicy: async (url) => {
        checked.push(url.toString());
        if (url.pathname === "/private") throw new WebCaptureError("PRIVATE_TARGET", "Private redirect rejected", "unavailable");
      },
      fetchImpl: async (input) => String(input).endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/private" } })
        : response(htmlFixture),
    }), { code: "PRIVATE_TARGET", terminalState: "unavailable" });
    assert.deepEqual(checked, ["https://example.com/start", "https://example.com/private"]);
  });
});
