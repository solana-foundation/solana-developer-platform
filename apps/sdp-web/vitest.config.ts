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
      thresholds: {
        statements: 68.57,
        branches: 61.26,
        functions: 65.76,
        lines: 69.45,
        autoUpdate: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
