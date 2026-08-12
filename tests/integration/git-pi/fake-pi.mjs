import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { request += chunk; });
process.stdin.on("end", async () => {
  const input = request.trim() ? JSON.parse(request) : {};
  if (args.includes("--invalid")) {
    process.stdout.write("not-json\n");
    return;
  }
  if (args.includes("--fail")) {
    process.stderr.write("fake Pi failure diagnostics\n");
    process.exitCode = 23;
    return;
  }
  if (args.includes("--sleep")) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  const writeIndex = args.indexOf("--write");
  if (writeIndex >= 0) {
    await writeFile(args[writeIndex + 1], "proposal\n", "utf8");
  }
  process.stdout.write(`${JSON.stringify({ type: "proposal", runId: input.runId, path: writeIndex >= 0 ? args[writeIndex + 1] : null })}\n`);
});
