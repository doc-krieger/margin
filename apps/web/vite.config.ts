import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const sharedSource = fileURLToPath(new URL("../../packages/shared/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: "apps/web",
  resolve: { alias: { "@margin/shared": sharedSource } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
