import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { formatCommandDiagnostics } from "../process/command.js";
import { makeRunEvent, type RunEvent, type RunEventStore } from "../runs/events.js";
import { piProfileManifestSchema, type PiProfileManifest } from "./manifest.js";

const piOutputSchema = z.record(z.unknown());

export interface PiRunInput {
  runId: string;
  correlationId: string;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Continue the append-only event sequence owned by the orchestrator. */
  eventSequenceStart?: number;
  /** The orchestrator owns the initial lifecycle event when false. */
  emitStarted?: boolean;
  /** The orchestrator owns the terminal lifecycle event when false. */
  emitTerminal?: boolean;
}

export interface PiRunResult {
  runId: string;
  correlationId: string;
  exitCode: number;
  events: RunEvent[];
  durationMs: number;
}

export type PiProcessErrorCode = "PI_UNAVAILABLE" | "PI_TIMEOUT" | "PI_CANCELLED" | "PI_PROTOCOL_ERROR" | "PI_EXITED";

export class PiProcessError extends Error {
  constructor(
    public readonly code: PiProcessErrorCode,
    message: string,
    public readonly diagnostics: string,
  ) {
    super(message);
    this.name = "PiProcessError";
  }
}

function linePayload(line: string): Record<string, unknown> {
  const value = JSON.parse(line) as unknown;
  return piOutputSchema.parse(value);
}

/** Run Pi through the manifest's JSONL stdin/stdout protocol and persist every lifecycle event. */
export async function runPiProcess(manifestInput: PiProfileManifest, input: PiRunInput, eventStore: RunEventStore): Promise<PiRunResult> {
  const manifest = piProfileManifestSchema.parse(manifestInput);
  const startedAt = Date.now();
  let sequence = input.eventSequenceStart ?? 0;
  let eventChain = Promise.resolve();
  const emit = (type: RunEvent["type"], payload: Record<string, unknown>) => {
    const event = makeRunEvent(input.runId, input.correlationId, sequence++, type, payload);
    eventChain = eventChain.then(() => eventStore.append(event));
  };

  if (input.emitStarted !== false) {
    emit("run.started", {
      command: manifest.command,
      args: manifest.runArgs,
      cwd: input.cwd,
      protocol: manifest.protocol,
    });
  }

  if (input.signal?.aborted) {
    if (input.emitTerminal !== false) emit("run.cancelled", { reason: "cancelled before Pi process started" });
    await eventChain;
    throw new PiProcessError("PI_CANCELLED", "Pi run cancelled before process start", "aborted: true");
  }

  const child = spawn(manifest.command, manifest.runArgs, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  let stdoutText = "";
  let stderrText = "";
  let protocolError: string | undefined;
  let timedOut = false;
  let cancelled = false;
  let terminated = false;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500).unref();
  };

  stdout.on("line", (line) => {
    if (!line.trim()) return;
    stdoutText += `${line}\n`;
    try {
      emit("pi.event", linePayload(line));
    } catch (error) {
      protocolError ??= `Pi emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`;
      emit("pi.invalid", { line, error: protocolError });
      terminate();
    }
  });
  stderr.on("line", (line) => {
    stderrText += `${line}\n`;
    emit("pi.stderr", { line });
  });
  child.stdin.on("error", (error) => {
    // A cancellation or an early protocol failure can close stdin while the
    // request is being written; the terminal event contains the real cause.
    if (!terminated) protocolError ??= `Unable to write Pi request: ${error.message}`;
  });

  let abortHandler: (() => void) | undefined;
  const timeoutMs = input.timeoutMs ?? manifest.timeoutMs;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    emit("diagnostic", { code: "PI_TIMEOUT", timeoutMs });
    terminate();
  }, timeoutMs);
  if (input.signal) {
    abortHandler = () => {
      cancelled = true;
      emit("diagnostic", { code: "PI_CANCELLED", reason: "abort signal" });
      terminate();
    };
    input.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    child.stdin.end(`${JSON.stringify({ runId: input.runId, correlationId: input.correlationId, prompt: input.prompt })}\n`);
  } catch (error) {
    protocolError = `Unable to send Pi request: ${error instanceof Error ? error.message : String(error)}`;
    terminate();
  }

  await new Promise<void>((resolve) => {
    child.once("error", (error) => {
      protocolError ??= `Pi executable could not be started: ${error.message}`;
      resolve();
    });
    child.once("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      resolve();
    });
  });
  clearTimeout(timeoutTimer);
  if (abortHandler && input.signal) input.signal.removeEventListener("abort", abortHandler);
  stdout.close();
  stderr.close();
  await eventChain;

  const diagnostics = [
    `command: ${[manifest.command, ...manifest.runArgs].join(" ")}`,
    `cwd: ${input.cwd}`,
    `exitCode: ${closeCode ?? "none"}`,
    closeSignal ? `signal: ${closeSignal}` : undefined,
    timedOut ? "timed out: true" : undefined,
    cancelled ? "aborted: true" : undefined,
    stdoutText.trim() ? `stdout:\n${stdoutText.trim()}` : undefined,
    stderrText.trim() ? `stderr:\n${stderrText.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  if (cancelled) {
    if (input.emitTerminal !== false) emit("run.cancelled", { reason: "abort signal", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_CANCELLED", "Pi run cancelled", diagnostics);
  }
  if (timedOut) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_TIMEOUT", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_TIMEOUT", `Pi run exceeded ${timeoutMs}ms`, diagnostics);
  }
  if (protocolError) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_PROTOCOL_ERROR", diagnostics, error: protocolError });
    await eventChain;
    throw new PiProcessError("PI_PROTOCOL_ERROR", protocolError, diagnostics);
  }
  if (closeCode !== 0) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_EXITED", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_EXITED", `Pi exited with code ${closeCode ?? "unknown"}`, diagnostics);
  }

  if (input.emitTerminal !== false) emit("run.completed", { exitCode: closeCode, durationMs: Date.now() - startedAt });
  await eventChain;
  return {
    runId: input.runId,
    correlationId: input.correlationId,
    exitCode: closeCode ?? 0,
    events: await eventStore.list(input.runId),
    durationMs: Date.now() - startedAt,
  };
}

/** Keep the diagnostic formatter available to callers that report preflight process failures. */
export { formatCommandDiagnostics };
