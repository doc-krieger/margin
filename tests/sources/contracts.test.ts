import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  captureAttemptSchema,
  evidenceVersionSchema,
  makeEmptySourceManifest,
  makeSourceRecord,
  sourceManifestSchema,
  sourceRecordSchema,
} from "../../packages/shared/src/sources/contracts.js";
import { SourceIdentityError, sourceIdentity } from "../../apps/server/src/sources/identity.js";

describe("source contracts", () => {
  it("creates a versioned empty manifest and a safe unavailable source record", () => {
    const manifest = makeEmptySourceManifest("2026-08-13T12:00:00.000Z");
    const record = makeSourceRecord({
      sourceId: "src_0123456789abcdef0123456789abcdef",
      kind: "url",
      identity: "https://example.com/article",
    }, "2026-08-13T12:00:00.000Z");

    expect(sourceManifestSchema.parse(manifest)).toEqual(manifest);
    expect(record).toMatchObject({
      schemaVersion: 1,
      evidenceState: "unavailable",
      latestVersionId: null,
      attempts: [],
      versions: [],
    });
  });

  it("requires archived records to point at immutable evidence", () => {
    const base = makeSourceRecord({
      sourceId: "src_0123456789abcdef0123456789abcdef",
      kind: "url",
      identity: "https://example.com/article",
    });
    expect(() => sourceRecordSchema.parse({ ...base, evidenceState: "archived" })).toThrow();
    expect(() => evidenceVersionSchema.parse({
      versionId: "ev_0123456789abcdef0123456789abcdef",
      checksum: "not-a-checksum",
      byteLength: 1,
      mediaType: "text/plain",
      capturedAt: new Date().toISOString(),
      attemptId: "cap_0123456789abcdef0123456789abcdef",
      originalRef: "evidence/src_0123456789abcdef0123456789abcdef/ev_0123456789abcdef0123456789abcdef.bin",
    })).toThrow();
  });

  it("bounds attempts and rejects cross-source attempt references", () => {
    const valid = makeSourceRecord({
      sourceId: "src_0123456789abcdef0123456789abcdef",
      kind: "file",
      identity: "file:notes/article.txt",
      attempts: [{
        attemptId: "cap_0123456789abcdef0123456789abcdef",
        sourceId: "src_0123456789abcdef0123456789abcdef",
        origin: "ui",
        requestedIdentity: "file:notes/article.txt",
        status: "failed",
        requestedAt: new Date().toISOString(),
        redirectChain: [],
      }],
    });
    const invalid = { ...valid, attempts: [{ ...valid.attempts[0], sourceId: "src_fedcba9876543210fedcba9876543210" }] };
    expect(() => sourceRecordSchema.parse(invalid)).toThrow();
    expect(() => captureAttemptSchema.parse({
      attemptId: "cap_0123456789abcdef0123456789abcdef",
      sourceId: "src_0123456789abcdef0123456789abcdef",
      origin: "ui",
      requestedIdentity: "x".repeat(8193),
      status: "queued",
      requestedAt: new Date().toISOString(),
      redirectChain: [],
    })).toThrow();
  });

  it("normalizes safe URL identities and derives stable IDs", () => {
    const first = sourceIdentity("url", "HTTPS://Example.COM:443/article?utm_source=feed&b=2#section");
    const second = sourceIdentity("url", "https://example.com/article?b=2");
    expect(first.identity).toBe(second.identity);
    expect(first.sourceId).toBe(second.sourceId);
    expect(first.identity).toBe("https://example.com/article?b=2");
  });

  it("rejects URL credentials, non-public schemes, and files outside the project", () => {
    expect(() => sourceIdentity("url", "https://user:password@example.com/private")).toThrow(SourceIdentityError);
    expect(() => sourceIdentity("url", "file:///tmp/secret.txt")).toThrow(SourceIdentityError);
    expect(() => sourceIdentity("file", "../secret.txt", "/tmp/project")).toThrow(SourceIdentityError);
    expect(() => sourceIdentity("file", "file:///tmp/secret.txt", "/tmp/project")).toThrow(SourceIdentityError);
  });

  it("uses content-addressable checksum expectations", () => {
    const bytes = Buffer.from("source evidence\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    expect(checksum).toHaveLength(64);
    expect(checksum).toMatch(/^[a-f0-9]+$/);
  });
});
