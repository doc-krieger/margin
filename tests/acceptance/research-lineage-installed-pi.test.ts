import { describe, expect, it } from "vitest";
import { runInstalledPiAcceptance } from "../../scripts/acceptance-research-lineage-pi.js";

describe("installed Pi acceptance boundary", () => {
  it("settles a real Pi RPC session and reports bounded capability evidence", async () => {
    const result = await runInstalledPiAcceptance({ required: process.env.PI_ACCEPTANCE_REQUIRED === "1" });
    if (result.status === "unavailable") {
      // Local and deterministic acceptance remains useful on machines without
      // Pi; release validation opts into a hard requirement with the env flag.
      expect(result).toEqual({ status: "unavailable" });
      return;
    }
    expect(result.status).toBe("available");
    expect(result.streaming).toBe(false);
    expect(result.sessionStatsAvailable).toBe(true);
    expect(result.version).toBeTruthy();
  });
});
