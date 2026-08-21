import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "../../helpers/test-api.js";
import { makeSourceRecord, type EvidenceVersion, type SourceRecord } from "../../../packages/shared/src/sources/contracts.js";
import { FileSourceStore, MemorySourceStore, SourceStoreError } from "../../../apps/server/src/sources/store.js";

const sourceId = "src_0123456789abcdef0123456789abcdef";
const secondSourceId = "src_fedcba9876543210fedcba9876543210";
const timestamp = "2026-08-13T12:00:00.000Z";

function record(id = sourceId): SourceRecord {
  return makeSourceRecord({
    sourceId: id,
    kind: "url",
    identity: id === sourceId ? "https://example.com/article" : "https://example.com/other",
  }, timestamp);
}

function evidence(source: SourceRecord = record()): { version: EvidenceVersion; bytes: Buffer } {
  const bytes = Buffer.from("immutable source evidence\n", "utf8");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    version: {
      versionId: "ev_0123456789abcdef0123456789abcdef",
      checksum,
      byteLength: bytes.byteLength,
      mediaType: "text/plain",
      capturedAt: timestamp,
      attemptId: "cap_0123456789abcdef0123456789abcdef",
      originalRef: `evidence/${source.sourceId}/ev_0123456789abcdef0123456789abcdef-${checksum}.bin`,
    },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "margin-sources-"));
}

async function assertRejectsWithObject(promise: Promise<unknown>, expected: Record<string, unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error !== null && typeof error === "object");
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual((error as Record<string, unknown>)[key], value);
    }
    return true;
  });
}

describe("source manifest store", () => {
  it("writes a validated human-readable YAML manifest and reconstructs it", async () => {
    const root = await tempRoot();
    try {
      const store = new FileSourceStore(root);
      await store.save(record());

      const parsed = await store.get(sourceId);
      assert.deepEqual(parsed, record());
      assert.deepEqual(await store.getByIdentity("https://example.com/article"), record());
      assert.match(await readFile(path.join(root, "manifest.yaml"), "utf8"), /schemaVersion: 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent different-source read-modify-write transactions without lost updates", async () => {
    const root = await tempRoot();
    try {
      const first = new FileSourceStore(root);
      const second = new FileSourceStore(root);
      await Promise.all([
        first.transact(async (manifest) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          manifest.sources.push(record());
        }),
        second.transact((manifest) => {
          manifest.sources.push(record(secondSourceId));
        }),
      ]);

      const sources = await new FileSourceStore(root).list();
      assert.deepEqual(sources.map((item) => item.sourceId).sort(), [sourceId, secondSourceId].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed external manifests without overwriting them", async () => {
    const root = await tempRoot();
    try {
      const manifestPath = path.join(root, "manifest.yaml");
      await writeFile(manifestPath, "schemaVersion: 999\nsources: []\nupdatedAt: not-a-date\n", "utf8");
      const store = new FileSourceStore(root);
      await assertRejectsWithObject(store.list(), { code: "INVALID_MANIFEST" });
      assert.match(await readFile(manifestPath, "utf8"), /schemaVersion: 999/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates records before a transaction can publish", async () => {
    const store = new MemorySourceStore();
    const invalid = { ...record(), sourceId: "unsafe" } as SourceRecord;
    await assertRejectsWithObject(store.save(invalid), { code: "INVALID_RECORD" });
    await assertRejectsWithObject(new FileSourceStore(await tempRoot()).get("../escape"), { code: "INVALID_SOURCE_ID" });
  });

  it("publishes evidence by checksum and refuses divergent immutable replacement", async () => {
    const root = await tempRoot();
    try {
      const store = new FileSourceStore(root);
      const sourceRecord = record();
      await store.save(sourceRecord);
      const { version, bytes } = evidence(sourceRecord);
      await store.putEvidence(sourceId, version, bytes);
      assert.deepEqual(Buffer.from(await store.readEvidence(sourceId, version)), bytes);
      await assertRejectsWithObject(store.putEvidence(sourceId, version, Buffer.from("different")), { code: "EVIDENCE_CONFLICT" });
      assert.deepEqual(Buffer.from(await store.readEvidence(sourceId, version)), bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps memory storage transactional and returns defensive evidence copies", async () => {
    const store = new MemorySourceStore();
    await store.save(record());
    const { version, bytes } = evidence();
    await store.putEvidence(sourceId, version, bytes);
    const first = await store.readEvidence(sourceId, version);
    first[0] = 0;
    assert.deepEqual(Buffer.from(await store.readEvidence(sourceId, version)), bytes);

    await Promise.all([
      store.transact((manifest) => { manifest.sources[0].aliases.push("https://example.com/alias-a"); }),
      store.transact((manifest) => { manifest.sources[0].aliases.push("https://example.com/alias-b"); }),
    ]);
    assert.deepEqual((await store.get(sourceId))?.aliases, ["https://example.com/alias-a", "https://example.com/alias-b"]);
  });
});
