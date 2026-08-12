import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

function testFilesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return testFilesIn(entryPath);
    return entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const args = rawArgs.flatMap((arg) => {
  if (arg.startsWith("-")) return [arg];
  try {
    return statSync(arg).isDirectory() ? testFilesIn(arg) : [arg];
  } catch {
    return [arg];
  }
});
const child = spawn("vitest", ["run", ...args], { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
