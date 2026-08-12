import { describe, expect, it } from "vitest";
import { CommentAuthorizationError, CommentNotFoundError, CommentRepository, InvalidCommentTransitionError } from "../../apps/server/src/comments/repository.js";
import { createTextAnchor, reanchorTextAnchor } from "../../apps/server/src/comments/anchors.js";

const projectId = "project-comments";

const originalDocument = [
  "# Notes",
  "",
  "Keep this sentence for review.",
  "",
  "Closing context.",
].join("\n");

function rangeOf(text: string, quote: string): [number, number] {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`fixture quote not found: ${quote}`);
  return [start, start + quote.length];
}

describe("durable text anchors", () => {
  it("recovers a selection after ordinary edits and retains confidence metadata", () => {
    const quote = "Keep this sentence for review.";
    const [start, end] = rangeOf(originalDocument, quote);
    const anchor = createTextAnchor(originalDocument, start, end);
    const editedDocument = [
      "# Notes",
      "",
      "A short editor note was inserted above the review.",
      "",
      originalDocument.split("\n").slice(2).join("\n"),
    ].join("\n");

    const result = reanchorTextAnchor(anchor, editedDocument);

    expect(result.status).toBe("anchored");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(editedDocument.slice(result.start, result.end)).toBe(quote);
    expect(result.orphanReason).toBeUndefined();
  });

  it("orphan-marks an ambiguous match instead of guessing", () => {
    const quote = "same phrase";
    const [start, end] = rangeOf(quote, quote);
    const anchor = createTextAnchor(quote, start, end, { contextLength: 0 });
    const result = reanchorTextAnchor(anchor, "same phrase\n\nUnrelated text\n\nsame phrase");

    expect(result.status).toBe("orphaned");
    expect(result.orphanReason).toBe("ambiguous-match");
    expect(result.start).toBeUndefined();
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("orphan-marks removed text as a durable visible failure", () => {
    const quote = "Keep this sentence for review.";
    const [start, end] = rangeOf(originalDocument, quote);
    const anchor = createTextAnchor(originalDocument, start, end);
    const result = reanchorTextAnchor(anchor, "# Notes\n\nThe sentence was removed.\n");

    expect(result.status).toBe("orphaned");
    expect(result.orphanReason).toBe("removed-text");
  });
});

describe("comment repository", () => {
  it("persists selection, document, and per-run guidance scopes", () => {
    const repository = new CommentRepository(":memory:");
    const quote = "Keep this sentence for review.";
    const [start, end] = rangeOf(originalDocument, quote);
    const anchored = repository.createSelectionComment({
      projectId,
      documentPath: "notes.md",
      documentText: originalDocument,
      start,
      end,
      body: "Please make this more concrete.",
    });
    const document = repository.createDocumentComment({
      projectId,
      documentPath: "notes.md",
      body: "Review the whole argument for missing evidence.",
    });
    const guidance = repository.createRunGuidance({
      projectId,
      runId: "run-42",
      body: "Prefer concise edits and preserve citations.",
    });

    expect(repository.list({ projectId }).map((comment) => comment.id)).toEqual([anchored.id, document.id, guidance.id]);
    expect(anchored.scope).toBe("selection");
    expect(anchored.anchorStatus).toBe("anchored");
    expect(document.anchorStatus).toBe("none");
    expect(guidance.scope).toBe("run");
    expect(guidance.runId).toBe("run-42");
    repository.close();
  });

  it("re-anchors persisted comments and persists orphan reason after reload", () => {
    const repository = new CommentRepository(":memory:");
    const quote = "Keep this sentence for review.";
    const [start, end] = rangeOf(originalDocument, quote);
    const created = repository.createSelectionComment({
      projectId,
      documentPath: "notes.md",
      documentText: originalDocument,
      start,
      end,
      body: "Check this sentence.",
    });

    const editedDocument = `# Notes\n\nInserted before.\n\n${originalDocument.split("\n").slice(2).join("\n")}`;
    const updated = repository.reanchorDocument(projectId, "notes.md", editedDocument);
    expect(updated).toHaveLength(1);
    expect(updated[0].anchorStatus).toBe("anchored");
    expect(updated[0].anchor?.start).toBeGreaterThan(created.anchor?.start ?? -1);

    const reloaded = new CommentRepository(repository.database);
    expect(reloaded.get(created.id)?.anchorStatus).toBe("anchored");
    reloaded.reanchorDocument(projectId, "notes.md", "# Notes\n\nThe sentence is gone.");
    const orphan = reloaded.get(created.id);
    expect(orphan?.anchorStatus).toBe("orphaned");
    expect(orphan?.orphanReason).toBe("removed-text");
    reloaded.close();
  });

  it("requires addressed before user resolution and rejects automated resolution", () => {
    const repository = new CommentRepository(":memory:");
    const comment = repository.createDocumentComment({ projectId, documentPath: "notes.md", body: "Resolve me after review." });

    expect(() => repository.transition(comment.id, "resolved", { actor: "user" })).toThrow(InvalidCommentTransitionError);
    expect(() => repository.transition(comment.id, "addressed", { actor: "automation" })).not.toThrow();
    expect(() => repository.transition(comment.id, "resolved", { actor: "automation" })).toThrow(CommentAuthorizationError);
    expect(repository.transition(comment.id, "resolved", { actor: "user" }).state).toBe("resolved");
    expect(() => repository.transition(comment.id, "open", { actor: "user" })).toThrow(InvalidCommentTransitionError);
    repository.close();
  });

  it("requires project scope when retrieving a comment for mutation", () => {
    const repository = new CommentRepository();
    const comment = repository.createDocumentComment({ projectId, documentPath: "notes.md", body: "Scoped feedback" });

    expect(repository.requireForProject(projectId, comment.id).id).toBe(comment.id);
    expect(() => repository.requireForProject("another-project", comment.id)).toThrow(CommentNotFoundError);
    expect(repository.require(comment.id).body).toBe("Scoped feedback");
    repository.close();
  });

  it("rejects malformed selection ranges before they can be persisted", () => {
    const repository = new CommentRepository(":memory:");
    expect(() => createTextAnchor("abc", 2, 2)).toThrow(RangeError);
    expect(() => createTextAnchor("abc", -1, 2)).toThrow(RangeError);
    expect(() => repository.createDocumentComment({ projectId, documentPath: "notes.md", body: "   " })).toThrow();
    repository.close();
  });
});
