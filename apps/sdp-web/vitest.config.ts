import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for pure modules only (*.unit.test.ts) — e2e stays on Playwright.
export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.{ts,tsx}"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary"],
      // Coarse round-downs of current coverage so ordinary drift does not
      // trip them; move them deliberately, never automatically (no
      // autoUpdate — it rewrote this file after every local run).
      thresholds: {
        statements: 69,
        branches: 62,
        functions: 65,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
