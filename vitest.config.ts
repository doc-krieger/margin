import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSource = fileURLToPath(new URL("./packages/shared/src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@margin/shared": sharedSource } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
