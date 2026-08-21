import { smokePiRpc } from "../apps/server/src/pi/adapter.js";
import { defaultPiProfileManifest, discoverPiProfile } from "../apps/server/src/pi/manifest.js";

const expectedVersion = process.env.PI_EXPECTED_VERSION ?? "0.84.1";
const manifest = defaultPiProfileManifest();
const result = await discoverPiProfile({ manifest });
let rpcSmoke: { status: "available" | "unavailable"; state?: Record<string, unknown>; sessionStats?: Record<string, unknown>; diagnostics?: string } = { status: "unavailable" };
if (result.status === "available") {
  try {
    const smoke = await smokePiRpc(manifest);
    rpcSmoke = { status: "available", state: smoke.state, sessionStats: smoke.sessionStats };
  } catch (error) {
    rpcSmoke = { status: "unavailable", diagnostics: error instanceof Error ? error.message : String(error) };
  }
}

console.log(JSON.stringify({
  status: result.status,
  message: result.message,
  version: result.version,
  expectedVersion,
  versionMatch: result.version ? result.version.includes(expectedVersion) : false,
  manifest,
  diagnostics: result.diagnostics,
  rpcSmoke,
}, null, 2));

if (result.status === "unavailable") {
  console.error("Pi preflight unavailable. Install Pi or set PI_COMMAND to an executable path; no model run was started.");
  process.exitCode = 1;
} else if (rpcSmoke.status === "unavailable") {
  console.error("Pi executable is available but RPC state/statistics smoke failed; no model run or web request was started.");
  process.exitCode = 1;
} else if (result.version && !result.version.includes(expectedVersion)) {
  console.error(`Pi preflight warning: installed version ${result.version} differs from expected ${expectedVersion}; RPC availability was verified.`);
}
