import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = process.platform === "win32" ? "git.exe" : "git";
const results = [];

function run(executable, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function tail(text, count = 8) {
  return text.trim().split("\n").filter(Boolean).slice(-count).join("\n");
}

async function step(name, executable, args, options = {}) {
  process.stdout.write(`[acceptance] ${name} ... `);
  const result = await run(executable, args, options);
  const passed = result.exitCode === 0;
  results.push({ name, status: passed ? "passed" : "failed", exitCode: result.exitCode });
  process.stdout.write(`${passed ? "passed" : "failed"}\n`);
  if (!passed) {
    const diagnostics = tail(result.stderr || result.stdout);
    if (diagnostics) process.stderr.write(`${diagnostics}\n`);
    throw new Error(`${name} exited with code ${result.exitCode}`);
  }
  return result;
}

async function commandPath(command) {
  const result = await run(process.platform === "win32" ? "where" : "which", [command]);
  return result.exitCode === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}

let fixtureRoot;
try {
  await step("editor typecheck", npm, ["run", "typecheck"]);
  await step("editor markdown fidelity", npm, ["test", "--", "tests/editor/markdown-editor.test.ts"]);
  await step("source capture browser contract", npm, ["run", "test:browser", "--", "tests/browser/sources/source-capture.test.ts"]);
  await step("report review and whole-proposal browser contract", npm, ["run", "test:browser", "--", "tests/browser/research/report-review.test.ts", "tests/browser/proposals/proposals.test.ts"]);
  await step("source API routes and evidence projection", npm, ["test", "--", "tests/integration/sources/source-routes.test.ts", "tests/integration/sources/evidence-projection.test.ts"]);

  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "margin-local-acceptance-"));
  await step("Git initialize fixture", git, ["init", "--initial-branch=main"], { cwd: fixtureRoot });
  await step("Git configure fixture email", git, ["config", "user.email", "margin-acceptance@example.invalid"], { cwd: fixtureRoot });
  await step("Git configure fixture name", git, ["config", "user.name", "Margin Acceptance"], { cwd: fixtureRoot });
  await writeFile(path.join(fixtureRoot, "README.md"), "# local acceptance\n", "utf8");
  await step("Git stage fixture", git, ["add", "README.md"], { cwd: fixtureRoot });
  await step("Git commit fixture", git, ["commit", "-m", "local acceptance fixture"], { cwd: fixtureRoot });
  const status = await run(git, ["status", "--porcelain"], { cwd: fixtureRoot });
  if (status.exitCode !== 0 || status.stdout.trim()) throw new Error("Git fixture did not return a clean status");
  results.push({ name: "Git clean checkpoint", status: "passed", exitCode: 0 });
  console.log("[acceptance] Git clean checkpoint ... passed");

  const piPreflight = await step("Pi RPC preflight (state and statistics only; no model or web request)", npm, ["run", "--silent", "preflight:pi"]);
  let piReport;
  try {
    piReport = JSON.parse(piPreflight.stdout);
  } catch (error) {
    throw new Error(`Pi preflight did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (piReport.status !== "available" || piReport.rpcSmoke?.status !== "available") {
    throw new Error("Pi preflight did not prove executable and RPC state/statistics availability");
  }
  results.push({
    name: "Pi RPC state/statistics smoke",
    status: "passed",
    noModelPrompt: true,
    noOutwardWebRequest: true,
    credentialsExposed: false,
  });
  console.log("[acceptance] Pi RPC state/statistics smoke ... passed (no model prompt or outward web request)");

  const zoteroPath = await commandPath("zotero");
  if (zoteroPath) {
    results.push({ name: "Zotero optional presence", status: "available", path: zoteroPath });
    console.log(`[acceptance] Zotero optional integration ... available at ${zoteroPath}`);
  } else {
    results.push({ name: "Zotero optional presence", status: "unavailable", optional: true });
    console.log("[acceptance] Zotero optional integration ... unavailable (optional; no acceptance failure)");
  }

  console.log("[acceptance] local acceptance report");
  console.log(JSON.stringify({ status: "passed", root, results }, null, 2));
} catch (error) {
  console.error(`[acceptance] failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ status: "failed", root, results }, null, 2));
  process.exitCode = 1;
} finally {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
}
