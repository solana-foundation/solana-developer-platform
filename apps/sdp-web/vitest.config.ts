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
        statements: 60.92,
        branches: 54.34,
        functions: 58.22,
        lines: 61.58,
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
