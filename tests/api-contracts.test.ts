import { describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app.js";

describe("API contract", () => {
  it("returns a validated health response and preserves correlation IDs", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "00000000-0000-4000-8000-000000000001" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: "margin-api" });
    expect(response.headers["x-correlation-id"]).toBe("00000000-0000-4000-8000-000000000001");
    await app.close();
  });
});
