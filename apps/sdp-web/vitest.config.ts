import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for pure modules only (*.unit.test.ts) — e2e stays on Playwright.
export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.{ts,tsx}"],
    environment: "node",
    // A running dashboard requires SDP_RELEASE_CHANNEL. Pin it here so a test
    // never depends on the shell or Doppler; widest channel, as the committed
    // docs artifacts are. A test that needs another channel stubs it.
    env: { SDP_RELEASE_CHANNEL: "experimental" },
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
