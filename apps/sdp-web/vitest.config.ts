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
      // Ratchet floors: autoUpdate raises them in place whenever a local
      // coverage run beats them, and CI enforces the committed values so
      // coverage can only go up.
      thresholds: {
        statements: 58.71,
        branches: 52.44,
        functions: 55.53,
        lines: 59.3,
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
