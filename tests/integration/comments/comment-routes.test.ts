import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";
import { CommentService } from "../../../apps/server/src/comments/repository.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("comment HTTP boundaries", () => {
  it("does not mutate a comment through another project's route", async () => {
    const comments = new CommentService();
    const app = buildApp({ commentService: comments });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project-one/comments",
      payload: { scope: "document", documentPath: "notes.md", body: "Original" },
    });
    const commentId = created.json().comment.id as string;

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-two/comments/${commentId}`,
      payload: { body: "Cross-project edit" },
    });
    const transition = await app.inject({
      method: "POST",
      url: `/api/projects/project-two/comments/${commentId}/state`,
      payload: { state: "addressed", actor: "automation" },
    });

    expect(edit.statusCode).toBe(404);
    expect(transition.statusCode).toBe(404);
    expect(comments.require(commentId)).toMatchObject({ projectId: "project-one", body: "Original", state: "open" });
    await app.close();
    comments.close();
  });

  it("persists comments across app restarts with the default comment service", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "margin-comments-"));
    temporaryPaths.push(dataDirectory);
    const commentDatabasePath = path.join(dataDirectory, "comments.sqlite");
    const firstApp = buildApp({ commentDatabasePath });
    const created = await firstApp.inject({
      method: "POST",
      url: "/api/projects/project-persisted/comments",
      payload: { scope: "document", documentPath: "notes.md", body: "Survives restart" },
    });
    expect(created.statusCode).toBe(201);
    await firstApp.close();

    const secondApp = buildApp({ commentDatabasePath });
    const listed = await secondApp.inject({ method: "GET", url: "/api/projects/project-persisted/comments" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().comments).toEqual([
      expect.objectContaining({ projectId: "project-persisted", documentPath: "notes.md", body: "Survives restart" }),
    ]);
    await secondApp.close();
  });
});
