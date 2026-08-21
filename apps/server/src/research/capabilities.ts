import {
  researchCapabilitySnapshotSchema,
  type ResearchCapabilityDeclaration,
  type ResearchCapabilityResult,
  type ResearchCapabilitySnapshot,
} from "../../../../packages/shared/src/research/contracts.js";
import { smokePiRpc, type PiRpcSmokeResult } from "../pi/adapter.js";
import { discoverPiProfile, parsePiProfileManifest, type PiProfileDiscovery, type PiProfileManifest } from "../pi/manifest.js";

export interface ResearchProfileCapabilityPolicy {
  /** Human-readable policy retained in the capability snapshot. */
  description?: string;
  /** Explicit capability grants. An omitted list grants no external capability. */
  allowedCapabilities?: string[];
  /** Names of tools presented to the Pi session. */
  presentedTools?: string[];
  /** Names of commands presented to the Pi session. */
  presentedCommands?: string[];
}

export interface ResearchCapabilityProfile {
  id: string;
  label?: string;
  manifest: PiProfileManifest;
  status?: "available" | "unavailable";
  version?: string;
  message?: string;
  diagnostics?: string;
  capabilityPolicy?: string | null;
  allowedCapabilities?: string[];
  presentedTools?: string[];
  presentedCommands?: string[];
}

export interface CapabilityDiscoveryRunner {
  discover(profile: ResearchCapabilityProfile): Promise<PiProfileDiscovery>;
  smoke(profile: ResearchCapabilityProfile): Promise<PiRpcSmokeResult>;
}

const MAX_DIAGNOSTICS = 32_000;

function bounded(value: string): string {
  return value.length <= MAX_DIAGNOSTICS ? value : `${value.slice(0, MAX_DIAGNOSTICS - 32)}\n[diagnostics truncated]`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorDiagnostics(error: unknown): string {
  const candidate = error as { diagnostics?: unknown };
  if (typeof candidate?.diagnostics === "string") return bounded(candidate.diagnostics);
  return bounded(errorMessage(error));
}

function profilePolicy(profile: ResearchCapabilityProfile): string | null {
  if (profile.capabilityPolicy !== undefined) return profile.capabilityPolicy;
  const policy: ResearchProfileCapabilityPolicy = {
    allowedCapabilities: profile.allowedCapabilities,
    presentedTools: profile.presentedTools,
    presentedCommands: profile.presentedCommands,
  };
  if (!policy.allowedCapabilities && !policy.presentedTools && !policy.presentedCommands) return null;
  return JSON.stringify(policy);
}

function hasEvidence(profile: ResearchCapabilityProfile, declaration: ResearchCapabilityDeclaration): string[] {
  const evidence: string[] = [];
  if (profile.presentedTools?.includes(declaration.id)) evidence.push(`presented tool: ${declaration.id}`);
  if (profile.presentedCommands?.includes(declaration.id)) evidence.push(`presented command: ${declaration.id}`);
  return evidence;
}

function result(
  id: string,
  status: ResearchCapabilityResult["status"],
  evidence: string[],
  diagnostics: string | null = null,
  checkedAt = new Date().toISOString(),
): ResearchCapabilityResult {
  return {
    id,
    status,
    checkedAt,
    evidence,
    diagnostics,
  };
}

const defaultRunner: CapabilityDiscoveryRunner = {
  discover: (profile) => discoverPiProfile({ manifest: parsePiProfileManifest(profile.manifest) }),
  smoke: (profile) => smokePiRpc(parsePiProfileManifest(profile.manifest)),
};

/**
 * Runs the two process-level checks used by research starts. The executable
 * check proves only that the configured binary can be invoked; the RPC check
 * proves that the configured protocol responds to state/statistics commands.
 */
export async function preflightResearchCapabilities(
  profileInput: ResearchCapabilityProfile,
  required: ResearchCapabilityDeclaration[] = [],
  options: { runner?: CapabilityDiscoveryRunner; now?: () => Date } = {},
): Promise<ResearchCapabilitySnapshot> {
  const profile = {
    ...profileInput,
    manifest: parsePiProfileManifest(profileInput.manifest),
  };
  const runner = options.runner ?? defaultRunner;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();

  let executable: ResearchCapabilityResult;
  if (profile.status === "unavailable") {
    executable = result("executable", "unavailable", [`${profile.manifest.command} ${profile.manifest.versionArgs.join(" ")}`], profile.message ?? profile.diagnostics ?? "Profile is unavailable by configured policy", checkedAt);
  } else try {
    const discovery: PiProfileDiscovery = await runner.discover(profile);
    executable = result(
      "executable",
      discovery.status === "available" ? "available" : "unavailable",
      [
        `${profile.manifest.command} ${profile.manifest.versionArgs.join(" ")}`,
        ...(discovery.version ? [`version: ${discovery.version}`] : []),
      ],
      discovery.status === "available" ? null : discovery.diagnostics ?? discovery.message,
      checkedAt,
    );
  } catch (error) {
    executable = result("executable", "unavailable", [`${profile.manifest.command} ${profile.manifest.versionArgs.join(" ")}`], errorDiagnostics(error), checkedAt);
  }

  let rpc: ResearchCapabilityResult;
  let smoke: PiRpcSmokeResult | undefined;
  if (executable.status !== "available") {
    rpc = result("rpc", "unknown", ["skipped because executable preflight failed"], executable.diagnostics, checkedAt);
  } else {
    try {
      smoke = await runner.smoke(profile);
      rpc = result("rpc", "available", [
        "RPC get_state",
        "RPC get_session_stats",
        ...(typeof smoke.state.sessionId === "string" ? [`session: ${smoke.state.sessionId}`] : []),
      ], null, checkedAt);
    } catch (error) {
      rpc = result("rpc", "unavailable", ["RPC get_state", "RPC get_session_stats"], errorDiagnostics(error), checkedAt);
    }
  }

  const results = required.map((declaration) => {
    const evidence = hasEvidence(profile, declaration);
    const allowed = profile.allowedCapabilities === undefined || profile.allowedCapabilities.includes(declaration.id);
    const processReady = executable.status === "available" && rpc.status === "available";
    if (processReady && allowed && evidence.length > 0) {
      return result(declaration.id, "available", evidence, null, checkedAt);
    }
    const diagnostics = !processReady
      ? "Pi executable and RPC smoke checks must both pass"
      : !allowed
        ? "Capability is not allowed by the configured profile policy"
        : "No presented tool or command evidence for this capability";
    return result(declaration.id, declaration.required ? "unavailable" : "unknown", evidence, diagnostics, checkedAt);
  });

  return researchCapabilitySnapshotSchema.parse({
    checkedAt,
    executable,
    rpc,
    required,
    results,
    profilePolicy: profilePolicy(profile),
  });
}

export function requiredCapabilitiesAvailable(snapshot: ResearchCapabilitySnapshot): boolean {
  return snapshot.required.every((declaration) => {
    const capability = snapshot.results.find((item) => item.id === declaration.id);
    return !declaration.required || capability?.status === "available";
  });
}

export function capabilityFailureDiagnostics(snapshot: ResearchCapabilitySnapshot): string {
  return snapshot.results
    .filter((item) => item.status !== "available")
    .map((item) => `${item.id}: ${item.diagnostics ?? item.status}`)
    .join("\n") || "Required research capabilities are unavailable";
}
