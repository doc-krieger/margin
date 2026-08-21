import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "../../helpers/test-api.js";
import { SourceCaptureService } from "../../../apps/server/src/sources/service.js";
import { SourceProjectionError, SourceProjectionService } from "../../../apps/server/src/sources/projection.js";
import { MemorySourceStore } from "../../../apps/server/src/sources/store.js";

describe("source evidence projection", () => {
  it("projects the selected immutable version into independent worktree bytes", async () => {
    const canonicalRoot = await mkdtemp(path.join(tmpdir(), "margin-source-canonical-"));
    const worktree = await mkdtemp(path.join(tmpdir(), "margin-source-worktree-"));
    const sourceFile = path.join(canonicalRoot, "article.txt");
    const store = new MemorySourceStore();
    const capture = new SourceCaptureService(store);
    const projection = new SourceProjectionService(store, canonicalRoot);

    try {
      await writeFile(sourceFile, "version one", "utf8");
      const first = await capture.capture({ kind: "file", value: "article.txt", baseDir: canonicalRoot, origin: "ui" });
      await writeFile(sourceFile, "version two", "utf8");
      const second = await capture.capture({ kind: "file", value: "article.txt", baseDir: canonicalRoot, origin: "pi", runId: "research-run" });
      assert.notEqual(first.version?.versionId, second.version?.versionId);
      assert.ok(first.version);
      assert.ok(second.version);

      const selected = { sourceId: first.sourceId, versionId: first.version.versionId };
      const projected = await projection.project({ worktreePath: worktree, runId: "research-run", selections: [selected] });
      const repeated = await projection.project({ worktreePath: worktree, runId: "research-run", selections: [selected] });
      assert.equal(projected.status, "ready");
      assert.deepEqual(repeated.entries, projected.entries);
      assert.equal(projected.entries[0].versionId, first.version.versionId);
      assert.equal(projected.entries[0].checksum, first.version.checksum);

      const projectedPath = path.join(worktree, projected.entries[0].relativePath);
      assert.equal(await readFile(projectedPath, "utf8"), "version one");
      await chmod(projectedPath, 0o644);
      await writeFile(projectedPath, "worktree mutation", "utf8");
      assert.equal(await readFile(projectedPath, "utf8"), "worktree mutation");
      assert.equal(new TextDecoder().decode(await store.readEvidence(first.sourceId, first.version)), "version one");
      assert.equal(await readFile(sourceFile, "utf8"), "version two");

      const manifest = await readFile(path.join(worktree, projected.manifestPath), "utf8");
      assert.match(manifest, new RegExp(first.version.versionId));
      assert.doesNotMatch(manifest, new RegExp(second.version.versionId));
    } finally {
      await rm(canonicalRoot, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("returns structured partial results for missing required evidence and rejects canonical worktrees", async () => {
    const canonicalRoot = await mkdtemp(path.join(tmpdir(), "margin-source-canonical-"));
    const worktree = await mkdtemp(path.join(tmpdir(), "margin-source-worktree-"));
    const projection = new SourceProjectionService(new MemorySourceStore(), canonicalRoot);
    const sourceId = "src_0123456789abcdef0123456789abcdef";
    const versionId = "ev_0123456789abcdef0123456789abcdef";

    try {
      const required = await projection.project({ worktreePath: worktree, selections: [{ sourceId, versionId }] });
      assert.equal(required.status, "partial");
      assert.deepEqual(required.missing[0], {
        sourceId,
        versionId,
        required: true,
        code: "SOURCE_NOT_FOUND",
        message: "The requested source is not available",
      });

      const optional = await projection.project({ worktreePath: worktree, runId: "optional-missing", selections: [{ sourceId, versionId, required: false }] });
      assert.equal(optional.status, "ready");
      assert.equal(optional.missing[0].required, false);
      await assert.rejects(
        projection.project({ worktreePath: canonicalRoot, selections: [] }),
        (error: unknown) => error instanceof SourceProjectionError && error.code === "WORKTREE_NOT_ISOLATED",
      );
    } finally {
      await rm(canonicalRoot, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
