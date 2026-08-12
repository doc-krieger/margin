import { defaultPiProfileManifest, discoverPiProfile } from "../apps/server/src/pi/manifest.js";

const expectedVersion = process.env.PI_EXPECTED_VERSION ?? "0.84.1";
const result = await discoverPiProfile();

console.log(JSON.stringify({
  status: result.status,
  message: result.message,
  version: result.version,
  expectedVersion,
  versionMatch: result.version ? result.version.includes(expectedVersion) : false,
  manifest: defaultPiProfileManifest(),
  diagnostics: result.diagnostics,
}, null, 2));

if (result.status === "unavailable") {
  console.error("Pi preflight unavailable. Install Pi or set PI_COMMAND to an executable path; no model run was started.");
  process.exitCode = 1;
} else if (result.version && !result.version.includes(expectedVersion)) {
  console.error(`Pi preflight warning: installed version ${result.version} differs from expected ${expectedVersion}; availability and JSONL launch contract were verified only.`);
}
