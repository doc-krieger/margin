import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPiProfileManifest, discoverPiProfile } from "../apps/server/src/pi/manifest.js";
import { smokePiRpc } from "../apps/server/src/pi/adapter.js";

export interface InstalledPiAcceptanceResult {
  status: "available" | "unavailable";
  version?: string;
  streaming?: boolean;
  sessionStatsAvailable?: boolean;
}

/**
 * Release-facing boundary for the installed Pi dependency. The deterministic
 * journey owns domain behavior; this check only proves the real executable and
 * RPC framing can start, answer state, and expose session statistics.
 */
export async function runInstalledPiAcceptance(options: { required?: boolean } = {}): Promise<InstalledPiAcceptanceResult> {
  const manifest = defaultPiProfileManifest();
  const discovery = await discoverPiProfile({ manifest });
  if (discovery.status !== "available") {
    if (options.required) throw new Error(`Installed Pi is required but unavailable: ${discovery.message}`);
    return { status: "unavailable" };
  }

  const smoke = await smokePiRpc(manifest);
  const streaming = smoke.state?.isStreaming;
  if (streaming !== false) throw new Error("Installed Pi RPC smoke did not return a settled non-streaming state");
  if (!smoke.sessionStats || typeof smoke.sessionStats !== "object") throw new Error("Installed Pi RPC smoke did not return session statistics");
  return {
    status: "available",
    version: discovery.version,
    streaming: false,
    sessionStatsAvailable: true,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const required = process.argv.includes("--required") || process.env.PI_ACCEPTANCE_REQUIRED === "1";
  try {
    const result = await runInstalledPiAcceptance({ required });
    // Keep output bounded and free of subprocess diagnostics or environment values.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
