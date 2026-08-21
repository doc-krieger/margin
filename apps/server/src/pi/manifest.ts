import { z } from "zod";
import { formatCommandDiagnostics, runCommand, type CommandResult } from "../process/command.js";

export const piProfileManifestSchema = z.object({
  command: z.string().min(1).max(512),
  versionArgs: z.array(z.string().max(512)).max(32).default(["--version"]),
  runArgs: z.array(z.string().max(4096)).max(128),
  protocol: z.literal("rpc"),
  timeoutMs: z.number().int().min(1000).max(15 * 60 * 1000).default(120_000),
});

export type PiProfileManifest = z.infer<typeof piProfileManifestSchema>;

export interface PiProfileDiscovery {
  status: "available" | "unavailable";
  manifest: PiProfileManifest;
  version?: string;
  message: string;
  diagnostics?: string;
}

export function defaultPiProfileManifest(overrides: Partial<PiProfileManifest> = {}): PiProfileManifest {
  return piProfileManifestSchema.parse({
    command: process.env.PI_COMMAND ?? "pi",
    versionArgs: ["--version"],
    // Pi RPC is the supported structured process-integration surface; no shell interpolation is used.
    runArgs: ["--mode", "rpc", "--no-session"],
    protocol: "rpc",
    timeoutMs: Number(process.env.PI_TIMEOUT_MS ?? 120_000),
    ...overrides,
  });
}

export function parsePiProfileManifest(value: unknown): PiProfileManifest {
  return piProfileManifestSchema.parse(value);
}

/**
 * Keep GSD's private Pi package selector from leaking into Margin-managed Pi
 * processes. A configured manifest command remains the explicit integration
 * boundary; inheriting PI_PACKAGE_DIR can silently redirect that command to
 * GSD's bundled agent package instead.
 */
export function piSubprocessEnv(source: NodeJS.ProcessEnv | undefined = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.PI_PACKAGE_DIR;
  return env;
}

export interface PiProfileDiscoveryOptions {
  manifest?: PiProfileManifest;
  env?: NodeJS.ProcessEnv;
  runner?: { run(executable: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> };
}

/** Resolve the installed executable and record actionable diagnostics without starting a model run. */
export async function discoverPiProfile(options: PiProfileDiscoveryOptions = {}): Promise<PiProfileDiscovery> {
  const manifest = parsePiProfileManifest(options.manifest ?? defaultPiProfileManifest());
  const runner = options.runner ?? { run: runCommand };
  const result = await runner.run(manifest.command, manifest.versionArgs, { env: piSubprocessEnv(options.env), timeoutMs: 10_000 });
  if (result.spawnError || result.exitCode !== 0 || result.timedOut || result.aborted) {
    return {
      status: "unavailable",
      manifest,
      message: `Pi executable is unavailable: ${manifest.command}`,
      diagnostics: formatCommandDiagnostics(result),
    };
  }
  const version = result.stdout.trim().split(/\r?\n/, 1)[0] || "unknown";
  return {
    status: "available",
    manifest,
    version,
    message: `Pi executable is available (${version})`,
    diagnostics: result.stderr.trim() || undefined,
  };
}
