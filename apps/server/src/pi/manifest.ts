import { z } from "zod";
import { formatCommandDiagnostics, runCommand, type CommandResult } from "../process/command.js";

export const piProfileManifestSchema = z.object({
  command: z.string().min(1).max(512),
  versionArgs: z.array(z.string().max(512)).max(32).default(["--version"]),
  runArgs: z.array(z.string().max(4096)).max(128),
  protocol: z.literal("jsonl"),
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
    // Pi's structured mode is deliberately explicit; no shell interpolation is used.
    runArgs: ["--mode", "json", "--no-session"],
    protocol: "jsonl",
    timeoutMs: Number(process.env.PI_TIMEOUT_MS ?? 120_000),
    ...overrides,
  });
}

export function parsePiProfileManifest(value: unknown): PiProfileManifest {
  return piProfileManifestSchema.parse(value);
}

export interface PiProfileDiscoveryOptions {
  manifest?: PiProfileManifest;
  runner?: { run(executable: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandResult> };
}

/** Resolve the installed executable and record actionable diagnostics without starting a model run. */
export async function discoverPiProfile(options: PiProfileDiscoveryOptions = {}): Promise<PiProfileDiscovery> {
  const manifest = parsePiProfileManifest(options.manifest ?? defaultPiProfileManifest());
  const runner = options.runner ?? { run: runCommand };
  const result = await runner.run(manifest.command, manifest.versionArgs, { timeoutMs: 10_000 });
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
