import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@server": path.resolve(import.meta.dirname, "server"),
      "server-only": path.resolve(import.meta.dirname, "test/server-only.ts"),
    },
  },
});
