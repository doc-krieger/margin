import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface CommandResult {
  executable: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

function appendOutput(current: string, chunk: Buffer, maxOutputBytes: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) return next;
  const suffix = "\n[output truncated]";
  return next.slice(0, Math.max(0, maxOutputBytes - Buffer.byteLength(suffix, "utf8"))) + suffix;
}

/** Execute a subprocess without a shell, retaining bounded stdout/stderr diagnostics. */
export function runCommand(executable: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const startedAt = new Date();
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
        }, options.timeoutMs)
      : undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const endedAt = new Date();
      resolve({
        executable,
        args: [...args],
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    };

    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(null, null);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk, maxOutputBytes);
    });
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    if (options.signal) {
      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export class CommandError extends Error {
  constructor(public readonly result: CommandResult, message = `Command failed: ${result.executable} ${result.args.join(" ")}`) {
    super(message);
    this.name = "CommandError";
  }
}

export function formatCommandDiagnostics(result: CommandResult): string {
  const command = [result.executable, ...result.args].join(" ");
  const details = [
    `command: ${command}`,
    result.cwd ? `cwd: ${result.cwd}` : undefined,
    `exitCode: ${result.exitCode ?? "none"}`,
    result.signal ? `signal: ${result.signal}` : undefined,
    result.timedOut ? "timed out: true" : undefined,
    result.aborted ? "aborted: true" : undefined,
    result.spawnError ? `spawnError: ${result.spawnError}` : undefined,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return details.join("\n");
}
