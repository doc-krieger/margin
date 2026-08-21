import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
let buffer = "";

if (args.includes("--reject-package-dir") && process.env.PI_PACKAGE_DIR) {
  process.stderr.write("PI_PACKAGE_DIR leaked into the managed Pi subprocess\n");
  process.exit(23);
}

function send(value, { crlf = false } = {}) {
  process.stdout.write(`${JSON.stringify(value)}${crlf ? "\r\n" : "\n"}`);
}

async function handle(request) {
  if (args.includes("--invalid")) {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.type === "get_state") {
    send({ type: "response", command: "get_state", success: true, id: request.id, data: { sessionId: "fake-session", isStreaming: false, messageCount: 0 } }, { crlf: args.includes("--crlf") });
    return;
  }
  if (request.type === "get_session_stats") {
    send({ type: "response", command: "get_session_stats", success: true, id: request.id, data: { sessionId: "fake-session", tokens: { total: 3 }, cost: 0 } }, { crlf: args.includes("--crlf") });
    if (args.includes("--exit-after-stats")) setImmediate(() => process.exit(0));
    return;
  }
  if (request.type === "abort") {
    send({ type: "response", command: "abort", success: true, id: request.id }, { crlf: args.includes("--crlf") });
    setImmediate(() => process.exit(0));
    return;
  }
  if (request.type !== "prompt") {
    send({ type: "response", command: request.type, success: false, id: request.id, error: "unsupported command" });
    return;
  }
  send({ type: "response", command: "prompt", success: true, id: request.id }, { crlf: args.includes("--crlf") });
  if (args.includes("--fail")) {
    process.stderr.write(args.includes("--secret-diagnostics") ? "api-key=super-secret token: another-secret\n" : "fake Pi failure diagnostics\n");
    setImmediate(() => process.exit(23));
    return;
  }
  if (args.includes("--sleep")) return;
  const writeIndex = args.indexOf("--write");
  if (writeIndex >= 0) await writeFile(args[writeIndex + 1], "proposal\n", "utf8");
  send({ type: "agent_start" }, { crlf: args.includes("--crlf") });
  send({ type: "message_end", message: { role: "assistant", content: [] } }, { crlf: args.includes("--crlf") });
  if (!args.includes("--no-agent-end")) send({ type: "agent_end" }, { crlf: args.includes("--crlf") });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line)).catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
  }
});
