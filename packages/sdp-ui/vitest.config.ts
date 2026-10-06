import { defineConfig } from "vitest/config";

// Unit tests for the primitives (*.unit.test.tsx), mirroring sdp-web's: node by default, with
// `// @vitest-environment jsdom` on the suites that render into a DOM.
export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.{ts,tsx}"],
    environment: "node",
  },
});
