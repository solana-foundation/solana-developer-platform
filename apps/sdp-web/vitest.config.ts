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
        statements: 71.05,
        branches: 64.42,
        functions: 68.04,
        lines: 71.87,
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
