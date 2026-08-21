import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { z } from "zod";
import { makeRunEvent, type RunEvent, type RunEventStore } from "../runs/events.js";
import { piProfileManifestSchema, piSubprocessEnv, type PiProfileManifest } from "./manifest.js";

const MAX_PROTOCOL_DIAGNOSTICS = 16_384;
const MAX_FRAME_BYTES = 1_048_576;
const rpcRecordSchema = z.record(z.unknown());
const sensitiveArgumentName = /^(?:--?)(?:api[-_]?key|token|password|passwd|secret|authorization|auth|credential|cookie)$/i;
const sensitiveInlineArgument = /^(--?(?:api[-_]?key|token|password|passwd|secret|authorization|auth|credential|cookie))=(.*)$/i;
const sensitiveDiagnosticValue = /((?:api[-_]?key|token|password|passwd|secret|authorization|auth|credential|cookie)\s*[:=]\s*)(["']?)([^\s,;}'"]+)\2/gi;
const rpcResponseSchema = z.object({
  type: z.literal("response"),
  command: z.string().min(1),
  success: z.boolean(),
  id: z.string().min(1).optional(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();

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

export interface PiRpcResponse {
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: unknown;
}

export interface PiRpcClientOptions {
  stdin: Writable;
  idFactory?: () => string;
}

interface PendingRpcCommand {
  command: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Minimal strict-JSONL RPC writer and response correlator. Frame parsing remains
 * process-owned so a malformed stdout record can terminate the associated run.
 */
export class PiRpcClient {
  private readonly pending = new Map<string, PendingRpcCommand>();
  private readonly issuedIds = new Set<string>();
  private readonly idFactory: () => string;

  constructor(private readonly stdin: Writable, options: Omit<PiRpcClientOptions, "stdin"> = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async prompt(message: string): Promise<PiRpcResponse> {
    return this.command("prompt", { message });
  }

  async abort(): Promise<PiRpcResponse> {
    return this.command("abort");
  }

  async getState(): Promise<PiRpcResponse> {
    return this.command("get_state");
  }

  async getSessionStats(): Promise<PiRpcResponse> {
    return this.command("get_session_stats");
  }

  async command(command: string, payload: Record<string, unknown> = {}): Promise<PiRpcResponse> {
    const id = this.idFactory();
    if (!id || this.issuedIds.has(id)) throw new Error(`Pi RPC command ID is not unique: ${id || "empty"}`);
    const request = JSON.stringify({ ...payload, id, type: command });
    this.issuedIds.add(id);
    if (request.includes("\n") || request.includes("\r")) throw new Error("Pi RPC command must serialize to one JSONL record");
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
      this.write(`${request}\n`).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  handleResponse(value: unknown): boolean {
    const parsed = rpcResponseSchema.safeParse(value);
    if (!parsed.success) {
      if (isRpcResponseRecord(value)) throw new Error(`Invalid Pi RPC response: ${parsed.error.message}`);
      return false;
    }
    const response = parsed.data;
    if (!response.id) throw new Error(`Pi RPC response for ${response.command} omitted correlation id`);
    const pending = this.pending.get(response.id);
    if (!pending) throw new Error(`Pi RPC response used unknown correlation id ${response.id}`);
    this.pending.delete(response.id);
    if (pending.command !== response.command) {
      pending.reject(new Error(`Pi RPC response command mismatch: expected ${pending.command}, received ${response.command}`));
      return true;
    }
    const result: PiRpcResponse = response;
    if (result.success) pending.resolve(result);
    else pending.reject(new Error(`Pi RPC ${result.command} failed: ${stringifyRpcError(result.error)}`));
    return true;
  }

  rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private async write(line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let callbackDone = false;
      let drainDone = false;
      let settled = false;
      const finish = () => {
        if (settled || !callbackDone || !drainDone) return;
        settled = true;
        resolve();
      };
      const onDrain = () => {
        drainDone = true;
        finish();
      };
      const onCallback = (error?: Error | null) => {
        callbackDone = true;
        if (error) {
          settled = true;
          this.stdin.removeListener("drain", onDrain);
          reject(error);
          return;
        }
        finish();
      };
      this.stdin.once("drain", onDrain);
      const accepted = this.stdin.write(line, onCallback);
      if (accepted) {
        drainDone = true;
        this.stdin.removeListener("drain", onDrain);
        finish();
      } else if (drainDone) {
        finish();
      }
    });
  }
}

function isRpcResponseRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).type === "response");
}

function stringifyRpcError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function bounded(value: string): string {
  return value.length <= MAX_PROTOCOL_DIAGNOSTICS ? value : `${value.slice(0, MAX_PROTOCOL_DIAGNOSTICS)}\n…[truncated]`;
}

function redactDiagnostic(value: string): string {
  return value.replace(sensitiveDiagnosticValue, "$1$2[REDACTED]");
}

function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const inline = sensitiveInlineArgument.exec(arg);
    if (inline) {
      redacted.push(`${inline[1]}=[REDACTED]`);
      continue;
    }
    if (sensitiveArgumentName.test(arg)) {
      redacted.push(arg);
      redactNext = true;
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

/** Split process stdout by LF only, accepting CRLF but never Unicode line separators. */
export class StrictJsonlFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): string[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (this.buffer.length > MAX_FRAME_BYTES && this.buffer.indexOf(0x0a) < 0) throw new Error("Pi RPC frame exceeds maximum size");
    const lines: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length > MAX_FRAME_BYTES) throw new Error("Pi RPC frame exceeds maximum size");
      const content = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      if (content.length > 0) lines.push(content.toString("utf8"));
    }
    return lines;
  }

  finish(): void {
    if (this.buffer.length > 0) throw new Error("Pi RPC process ended with an unterminated JSONL frame");
  }
}

function parseRecord(line: string): Record<string, unknown> {
  return rpcRecordSchema.parse(JSON.parse(line) as unknown);
}

function stateSummary(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  return {
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    sessionName: typeof record.sessionName === "string" ? record.sessionName : undefined,
    isStreaming: typeof record.isStreaming === "boolean" ? record.isStreaming : undefined,
    messageCount: typeof record.messageCount === "number" ? record.messageCount : undefined,
  };
}

function statsSummary(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  return {
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    tokens: record.tokens && typeof record.tokens === "object" ? record.tokens : undefined,
    cost: typeof record.cost === "number" ? record.cost : undefined,
  };
}

export interface PiRpcSmokeResult {
  state: Record<string, unknown>;
  sessionStats: Record<string, unknown>;
}

/** Starts Pi RPC and exercises only state/statistics commands; it does not prompt a model or use external tools. */
export async function smokePiRpc(manifestInput: PiProfileManifest, options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<PiRpcSmokeResult> {
  const manifest = piProfileManifestSchema.parse(manifestInput);
  const child = spawn(manifest.command, manifest.runArgs, {
    cwd: options.cwd ?? process.cwd(),
    env: piSubprocessEnv(options.env),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new PiRpcClient(child.stdin);
  const decoder = new StrictJsonlFrameDecoder();
  let stderr = "";
  let protocolError: string | undefined;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  const timeoutMs = options.timeoutMs ?? Math.min(manifest.timeoutMs, 10_000);
  const terminate = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500).unref();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const line of decoder.push(chunk)) {
        const value = parseRecord(line);
        // RPC may emit lifecycle events while processing state commands; only malformed frames or uncorrelated responses fail the smoke check.
        rpc.handleResponse(value);
      }
    } catch (error) {
      protocolError ??= error instanceof Error ? error.message : String(error);
      terminate();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = bounded(redactDiagnostic(`${stderr}${chunk.toString("utf8")}`)); });
  child.stdin.on("error", (error) => { protocolError ??= redactDiagnostic(`Unable to write Pi RPC command: ${error.message}`); });
  // Register process settlement before issuing commands. A fast Pi process can
  // close between the last response and the smoke promise's finally block;
  // installing close listeners there would leave the top-level await pending.
  const processSettled = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      protocolError ??= redactDiagnostic(`Pi executable could not be started: ${error.message}`);
      rpc.rejectPending(new Error(protocolError));
      resolve();
    });
    child.once("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (code !== null && code !== 0 && !signal) {
        protocolError ??= `Pi RPC smoke exited with code ${code}`;
      }
      rpc.rejectPending(new Error("Pi RPC process exited"));
      resolve();
    });
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      terminate();
      reject(new PiProcessError("PI_TIMEOUT", `Pi RPC smoke timed out after ${timeoutMs}ms`, bounded(stderr)));
    }, timeoutMs);
    timeoutTimer.unref();
  });
  try {
    const result = await Promise.race([Promise.all([rpc.getState(), rpc.getSessionStats()]), timedOut]);
    const [state, sessionStats] = result;
    if (protocolError) throw new PiProcessError("PI_PROTOCOL_ERROR", protocolError, bounded(stderr));
    terminate();
    return { state: stateSummary(state.data), sessionStats: statsSummary(sessionStats.data) };
  } catch (error) {
    terminate();
    if (error instanceof PiProcessError) throw error;
    throw new PiProcessError("PI_PROTOCOL_ERROR", redactDiagnostic(error instanceof Error ? error.message : String(error)), bounded(stderr));
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    rpc.rejectPending(new Error("Pi RPC smoke settled"));
    await processSettled;
    if (closeCode !== null && closeCode !== 0 && !closeSignal && !protocolError) {
      protocolError = `Pi RPC smoke exited with code ${closeCode}`;
    }
  }
}

/**
 * Runs a bounded Margin operation over Pi RPC. Pi RPC itself remains available
 * after an agent turn, so successful one-shot revision runs settle at agent_end
 * and deliberately terminate the child only after that terminal event.
 */
export async function runPiProcess(manifestInput: PiProfileManifest, input: PiRunInput, eventStore: RunEventStore): Promise<PiRunResult> {
  const manifest = piProfileManifestSchema.parse(manifestInput);
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? manifest.timeoutMs;
  let sequence = input.eventSequenceStart ?? 0;
  let eventChain = Promise.resolve();
  const emit = (type: RunEvent["type"], payload: Record<string, unknown>) => {
    const event = makeRunEvent(input.runId, input.correlationId, sequence++, type, payload);
    eventChain = eventChain.then(() => eventStore.append(event));
  };

  if (input.emitStarted !== false) {
    emit("run.started", { command: manifest.command, args: redactArgs(manifest.runArgs), cwd: input.cwd, protocol: manifest.protocol });
  }
  if (input.signal?.aborted) {
    if (input.emitTerminal !== false) emit("run.cancelled", { reason: "cancelled before Pi process started" });
    await eventChain;
    throw new PiProcessError("PI_CANCELLED", "Pi run cancelled before process start", "aborted: true");
  }

  const child = spawn(manifest.command, manifest.runArgs, { cwd: input.cwd, env: piSubprocessEnv(input.env), shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new PiRpcClient(child.stdin);
  const decoder = new StrictJsonlFrameDecoder();
  let stderrText = "";
  let protocolError: string | undefined;
  let timedOut = false;
  let cancelled = false;
  let expectedShutdown = false;
  let agentEnded = false;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let cancelTimer: NodeJS.Timeout | undefined;

  const terminate = () => {
    if (expectedShutdown) return;
    expectedShutdown = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500).unref();
  };
  const failProtocol = (message: string) => {
    protocolError ??= redactDiagnostic(message);
    terminate();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const line of decoder.push(chunk)) {
        const value = parseRecord(line);
        if (rpc.handleResponse(value)) continue;
        emit("pi.event", value);
        if (value.type === "agent_end") {
          agentEnded = true;
          terminate();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("pi.invalid", { error: bounded(redactDiagnostic(message)) });
      failProtocol(`Pi emitted invalid RPC JSONL: ${message}`);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrText = bounded(`${stderrText}${text}`);
    for (const line of text.split(/\r?\n/)) if (line) emit("pi.stderr", { line: bounded(redactDiagnostic(line)) });
  });
  child.stdin.on("error", (error) => {
    if (!expectedShutdown) failProtocol(`Unable to write Pi RPC command: ${error.message}`);
  });
  const processSettled = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      protocolError ??= redactDiagnostic(`Pi executable could not be started: ${error.message}`);
      rpc.rejectPending(new Error(protocolError));
      resolve();
    });
    child.once("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      rpc.rejectPending(new Error("Pi RPC process exited"));
      resolve();
    });
  });

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    emit("diagnostic", { code: "PI_TIMEOUT", timeoutMs });
    terminate();
  }, timeoutMs);
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    emit("diagnostic", { code: "PI_CANCELLED", reason: "abort signal" });
    rpc.abort().catch(() => undefined);
    cancelTimer = setTimeout(terminate, 250);
  };
  if (input.signal) input.signal.addEventListener("abort", cancel, { once: true });

  try {
    const state = await rpc.getState();
    emit("pi.event", { type: "pi.rpc_state", ...stateSummary(state.data) });
    const stats = await rpc.getSessionStats();
    emit("pi.event", { type: "pi.rpc_session_stats", ...statsSummary(stats.data) });
    await rpc.prompt(input.prompt);
  } catch (error) {
    failProtocol(`Pi RPC command failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await processSettled;
  clearTimeout(timeoutTimer);
  if (cancelTimer) clearTimeout(cancelTimer);
  if (input.signal) input.signal.removeEventListener("abort", cancel);
  try {
    decoder.finish();
  } catch (error) {
    protocolError ??= error instanceof Error ? error.message : String(error);
  }
  rpc.rejectPending(new Error("Pi RPC process exited"));
  await eventChain;

  const diagnostics = [
    `command: ${[manifest.command, ...redactArgs(manifest.runArgs)].join(" ")}`,
    `cwd: ${input.cwd}`,
    `exitCode: ${closeCode ?? "none"}`,
    closeSignal ? `signal: ${closeSignal}` : undefined,
    timedOut ? "timed out: true" : undefined,
    cancelled ? "aborted: true" : undefined,
    agentEnded ? "agentEnded: true" : undefined,
    protocolError ? `protocolError: ${protocolError}` : undefined,
    stderrText.trim() ? `stderr:\n${redactDiagnostic(stderrText.trim())}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  if (cancelled) {
    if (input.emitTerminal !== false) emit("run.cancelled", { reason: "abort signal", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_CANCELLED", "Pi run cancelled", diagnostics);
  }
  if (timedOut) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_TIMEOUT", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_TIMEOUT", `Pi run timed out after ${timeoutMs}ms`, diagnostics);
  }
  if (protocolError) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_PROTOCOL_ERROR", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_PROTOCOL_ERROR", protocolError, diagnostics);
  }
  if (!agentEnded || (!expectedShutdown && closeCode !== 0)) {
    if (input.emitTerminal !== false) emit("run.failed", { code: "PI_EXITED", diagnostics });
    await eventChain;
    throw new PiProcessError("PI_EXITED", `Pi exited before completing an agent turn (code ${closeCode ?? "unknown"})`, diagnostics);
  }

  if (input.emitTerminal !== false) emit("run.completed", { exitCode: closeCode ?? 0, durationMs: Date.now() - startedAt });
  await eventChain;
  return {
    runId: input.runId,
    correlationId: input.correlationId,
    exitCode: closeCode ?? 0,
    events: await eventStore.list(input.runId),
    durationMs: Date.now() - startedAt,
  };
}
